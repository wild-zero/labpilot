// 环境题分支：不写代码文件，直接在容器里把环境做出来，再触发测评。
//
// 为什么需要它：头歌有一类关卡的判分脚本自己在容器里执行 `/opt/hive/bin/hive ...`、
// `hadoop fs ...`，你在编辑器里交什么文件都不影响判分结果。这类题只能「做环境」。
//
// 流程：挑配方 → 在容器里按序执行 setup → verify 自检 → 触发 game_build → 判分
//       → 不过就跑 repair 再判一次 → 仍不过就转 support（绝不标成功）
import { config } from '../config.mjs';
import { failures } from '../db.mjs';
import { openTerminal } from '../terminal/runner.mjs';
import { pickRecipe } from './recipes/index.mjs';
import { remember } from './solver/index.mjs';

const trimTrace = (trace) => trace
  .map(item => `$ ${item.command}\n${String(item.output ?? '').split('\n').slice(-6).join('\n')}`)
  .join('\n')
  .slice(-1500);

/** 这道关卡是不是「环境题」：配方命中 + 文件形态对得上，避免把普通代码关误判进来 */
export function environmentRecipe(task) {
  if (task?.game?.status === 2) return null;
  const files = task?.files ?? [];
  // 判分脚本 / 提示文件被当成可改文件，基本可以断定不是让学生写代码的关卡
  const scriptLike = files.length > 0 && files.every(file => /(^|\/)(test\.sh|hint\.txt)$/i.test(file.path) || /\.sh$/i.test(file.path));
  // 反过来：有 .java/.py/.c/.cpp 这类真实代码文件时，一律按代码题处理（HDFS-JAVA接口之XXX 这类关卡就是代码题，
  // 只是题干里也提到了 hadoop fs 而已——不能让配方把它们抢走）
  if (files.length > 0 && !scriptLike) return null;
  const recipe = pickRecipe(task);
  if (!recipe) return null;
  if (!scriptLike) {
    // 连文件都没有（纯终端关卡）时，必须题干强命中才走环境分支
    const subject = String(task?.challenge?.subject ?? '');
    const hitSubject = (recipe.match?.subject_any ?? []).some(word => subject.toLowerCase().includes(String(word).toLowerCase()));
    if (!hitSubject) return null;
  }
  return recipe;
}

export async function runEnvironmentLevel(up, ctx, task, level, recipe) {
  level.source = 'recipe';
  level.recipe = recipe.id;
  ctx.phase('terminal');

  const results = [];
  let terminal = null;
  const open = async () => openTerminal({
    session: ctx.cookie,
    gameUid: task.game.identifier,
    homeworkId: ctx.homeworkId,
  });

  try {
    terminal = await open();
    ctx.tick();
    // 单行超时不代表整份配方作废（start-dfs.sh 第一次跑常常超过两分钟），继续往下走，最后靠 verify 判定
    results.push(...await terminal.runAll(recipe.setup ?? [], { perLineTimeoutMs: 180_000 }));
    level.setup_trace = trimTrace(results);

    if (recipe.verify) {
      ctx.phase('verifying');
      const checked = await terminal.runUntil(recipe.verify.command, { timeoutMs: 120_000 });
      const ok = checked.done && checked.output.toLowerCase().includes(String(recipe.verify.expect ?? '').toLowerCase());
      level.verify_output = checked.output.slice(-400);
      if (!ok) {
        level.status = 'support';
        level.reason_code = 'env_verify_failed';
        level.message = `环境自检没过（${recipe.verify.command}）：${checked.output.slice(-200)}`;
        return level;
      }
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      ctx.tick();
      ctx.phase('evaluating');
      const verdict = await terminal.evaluate();
      level.attempts = attempt;
      if (verdict.finished) {
        level.status = 'passed';
        level.score = verdict.score ?? null;
        // 把成功的命令序列入库：同一道环境题下次直接复放，不用再问模型
        remember(`${recipe.id}:${task.challenge.subject}`, { kind: 'terminal', subject: task.challenge.subject, description: recipe.id }, { commands: recipe.setup }, ctx.jobId);
        failures.clear(`${recipe.id}:${task.challenge.subject}`);
        return level;
      }
      const detail = (verdict.tests ?? [])
        .map(test => `期望：${String(test?.output ?? '').slice(0, 120)} 实际：${String(test?.actual_output ?? '').slice(0, 200)}`)
        .join('\n');
      level.last_verdict = detail.slice(0, 600);
      if (attempt === 1 && recipe.repair?.length) {
        ctx.phase('repairing');
        results.push(...await terminal.runAll(recipe.repair, { perLineTimeoutMs: 120_000 }));
        continue;
      }
      level.status = 'support';
      level.reason_code = 'env_evaluate_failed';
      level.message = (detail || '环境已就绪但判分未通过').slice(0, 400);
      failures.bump(`${recipe.id}:${task.challenge.subject}`, task.challenge.subject, level.message);
      return level;
    }

    level.status = 'support';
    level.reason_code = 'env_evaluate_failed';
    level.message = '环境执行完毕但判分始终没有结果';
    return level;
  } finally {
    try { terminal?.close(); } catch { /* ignore */ }
  }
}

/**
 * 代码题的前置环境：HDFS-JAVA接口之XXX 这类关卡本身是代码题，但判分程序要连 HDFS，
 * 容器里 Hadoop 没起就一定判负。每个作业只做一次，失败不致命（下游会照常尝试并给出反馈）。
 */
export async function runPrecondition(ctx, task) {
  if (ctx.preconditionDone) return null;
  const recipe = pickRecipe(task, { precondition: true });
  if (!recipe) return null;
  ctx.preconditionDone = true;
  ctx.phase('preparing');
  const terminal = await openTerminal({
    session: ctx.cookie,
    gameUid: task.game.identifier,
    homeworkId: ctx.homeworkId,
  });
  try {
    const trace = await terminal.runAll(recipe.setup ?? [], { perLineTimeoutMs: 120_000 });
    ctx.preconditionRecipe = recipe.id;
    return { recipe: recipe.id, trace: trimTrace(trace) };
  } catch (error) {
    return { recipe: recipe.id, error: error.message };
  } finally {
    try { terminal.close(); } catch { /* ignore */ }
  }
}
