// 任务流水线：把 job.request 变成一个阶段序列，逐个关卡推进。
//
// 阶段命名刻意与前端展示对齐：
//   starting → preflight → loading → collecting → bank_lookup → generating
//   → saving → selftesting → submitting → evaluating → polling → verifying
//   → repairing → completed
//
// 铁律：任何「不确定」都不许标成功。判不出来就转 support，交给人工。
import { config } from '../config.mjs';
import { failures } from '../db.mjs';
import { openTerminal } from '../terminal/runner.mjs';
import { lookupTask, remember, solveWithModel, subjectKey, looseKey, lookupQuestion, rememberQuestion } from './solver/index.mjs';
import { bank } from '../db.mjs';
import { solveJupyter } from '../jupyter/solve.mjs';
import { environmentRecipe, runEnvironmentLevel, runPrecondition } from './env-level.mjs';

export class Canceled extends Error {
  constructor() { super('任务已停止'); this.code = 'CANCELED'; }
}
export class TimedOut extends Error {
  constructor() { super('整批执行达到时间上限'); this.code = 'TIME_LIMIT'; }
}
export class Support extends Error {
  constructor(code, message) { super(message); this.code = code; this.support = true; }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------- 关卡清单遍历 ----------
// 平台没有「给我第 N 关」的接口，只能 prev_game 回卷 + next_game 前进。
async function listChallenges(up, ctx, courseIdentifier, homeworkId) {
  const entry = await up.enter(ctx.cookie, ctx.login, courseIdentifier, homeworkId);
  let cursor = entry.gameIdentifier;
  const seen = new Set();

  // 回卷
  let guard = 0;
  while (cursor && guard < config.limits.maxLevels) {
    const task = await up.task(ctx.cookie, ctx.login, cursor, homeworkId);
    seen.add(String(cursor));
    if (!task.prevGame || seen.has(String(task.prevGame))) break;
    cursor = task.prevGame;
    guard += 1;
    ctx.tick();
  }

  // 前进
  const ordered = [];
  guard = 0;
  while (cursor && guard < config.limits.maxLevels) {
    ctx.tick();
    const task = await up.task(ctx.cookie, ctx.login, cursor, homeworkId);
    ordered.push(task);
    if (!task.nextGame || seen.has(`f:${task.nextGame}`)) break;
    seen.add(`f:${task.nextGame}`);
    cursor = task.nextGame;
    guard += 1;
  }
  return ordered;
}

// ---------- 单关卡求解 ----------
function toSolverTask(task, feedback) {
  const files = (task.files ?? []).map(file => ({ path: file.path, content: file.content }));
  return {
    kind: task.challenge.kind,
    subject: task.challenge.subject,
    description: task.challenge.description,
    files,
    optionCount: task.challenge.kind === 'choice' ? (task.challenge.optionCount ?? 1) : undefined,
    options: task.challenge.options,
    questions: Array.isArray(task.questions) ? task.questions : undefined,
    testSets: Array.isArray(task.testSets) ? task.testSets : undefined,
    feedback,
    __answer: task.challenge.__answer,
  };
}

async function answerChoice(up, ctx, task, answer) {
  await up.choose(ctx.cookie, ctx.login, {
    gameUid: task.game.identifier,
    gameId: task.game.id,
    answer: answer.answers,
    challengeId: task.challenge.id,
    subjectId: task.challenge.secKey,
    homeworkId: ctx.homeworkId,
  });
}

async function answerCode(up, ctx, task, answer) {
  let commitId = task.myshixun.commitId;
  const encodingOf = (path) => (task.files ?? []).find(file => file.path === path)?.encoding ?? 'base64';
  for (const file of answer.files) {
    ctx.phase('saving');
    const saved = await up.saveFile(ctx.cookie, ctx.login, {
      myshixunIdentifier: task.myshixun.identifier,
      myshixunId: task.myshixun.id ?? task.game.myshixunId,
      gameId: task.game.id,
      gameUid: task.game.identifier,
      path: file.path,
      content: file.content,
      encoding: file.encoding ?? 'plain',
      homeworkId: ctx.homeworkId,
      challengeId: task.challenge.id,
      userId: ctx.userId,
      commitId,
    });
    if (saved?.commitID != null) commitId = saved.commitID;
    ctx.tick();
  }
  ctx.phase('selftesting');
  await up.build(ctx.cookie, ctx.login, {
    gameUid: task.game.identifier,
    gameId: task.game.id,
    homeworkId: ctx.homeworkId,
    challengeId: task.challenge.id,
    shixunEnvironmentId: task.challenge.shixunEnvironmentId,
    commitId,
    first: 0,
  });
  ctx.markSubmission(task, commitId);
  return commitId;
}

// 客观题的判定：平台只回总分，status===2 表示这关过了。
// baselineScore 是上一次的分数——只有分数变了（或状态变了）才算这一轮有了结果，
// 否则会立刻读到上一轮的旧分数，翻转法就永远判不出效果。
async function waitChoice(up, ctx, task, timeoutMs = 40_000, baselineScore = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    ctx.tick();
    last = await up.task(ctx.cookie, ctx.login, task.game.identifier, ctx.homeworkId);
    const score = last?.game?.final_score ?? 0;
    if (last?.game?.status === 2) return { finished: true, score: score || 100, task: last };
    if (score > 0 && (baselineScore === null || score !== baselineScore)) {
      return { finished: false, score, task: last };
    }
    await sleep(2500);
  }
  return { finished: last?.game?.status === 2, score: last?.game?.final_score ?? 0, task: last };
}

async function waitVerdict(up, ctx, task, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    ctx.tick();
    last = await up.verdict(ctx.cookie, ctx.login, task.game.identifier, ctx.homeworkId);
    if (last.finished) return last;
    if (!last.running && last.evaluate_count > 0) return last;
    await sleep(600);
  }
  return last ?? { finished: false, running: true };
}

// 已经通过的关卡：把它的成品答案收进题库（代码题读文件、客观题读平台记录的作答）
function harvestPassed(task) {
  try {
    const subject = String(task.challenge.subject ?? '');
    if (task.challenge.kind === 'code') {
      if (!(task.files ?? []).length) return;
      const template = { kind: 'code', subject, description: task.challenge.description, files: [] };
      remember(looseKey(template), template, { files: task.files.map(file => ({ path: file.path, content: file.content })) }, 'harvest-inline');
      return;
    }
    if (task.challenge.kind === 'choice') {
      const tests = task.chooseTestCases?.test_sets;
      if (!Array.isArray(tests) || !tests.length) return;
      const answers = [...tests]
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(test => String(test.actual_output ?? '').trim())
        .filter(Boolean);
      if (answers.length !== (task.questions ?? []).length) return;
      const template = { kind: 'choice', subject, description: task.challenge.description, questions: task.questions };
      remember(looseKey(template), template, { answers }, 'harvest-inline');
    }
  } catch {
    // 收割失败不影响主流程
  }
}

// 题库答案能不能直接用于这一关
function answerFitsTask(task, answer) {
  if (!answer) return false;
  if (task.challenge.kind === 'choice') {
    const questions = task.questions ?? [];
    const answers = answer.answers;
    if (!Array.isArray(answers) || answers.length !== questions.length) return false;
    for (let index = 0; index < questions.length; index += 1) {
      const letters = new Set((questions[index].options ?? []).map(option => option.key));
      const picked = String(answers[index] ?? '').split('');
      if (!picked.length) return false;
      if (!picked.every(letter => letters.has(letter))) return false;
    }
    return true;
  }
  if (task.challenge.kind === 'code') {
    const files = answer.files;
    if (!Array.isArray(files) || !files.length) return false;
    const known = new Set((task.files ?? []).map(file => file.path));
    return files.every(file => known.has(file.path));
  }
  if (task.challenge.kind === 'terminal') {
    return Array.isArray(answer.commands) && answer.commands.length > 0;
  }
  return true;
}

// 已完成的作业：把每一关的成品答案收进题库，受 ctx.harvestBudget 限制
async function harvestCompletedHomework(up, ctx, course, homework) {
  const entry = await up.enter(ctx.cookie, ctx.login, course.identifier, homework.id);
  let cursor = entry.gameIdentifier;
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const task = await up.task(ctx.cookie, ctx.login, cursor, homework.id);
    seen.add(String(cursor));
    if (!task.prevGame || seen.has(String(task.prevGame))) break;
    cursor = task.prevGame;
  }
  let harvested = 0;
  for (let i = 0; i < 40 && cursor && ctx.harvestBudget > 0; i += 1) {
    ctx.tick();
    const task = await up.task(ctx.cookie, ctx.login, cursor, homework.id);
    if (task.game.status === 2) {
      harvestPassed(task);
      ctx.harvestBudget -= 1;
      harvested += 1;
    }
    if (!task.nextGame) break;
    cursor = task.nextGame;
  }
  return harvested;
}

async function solveLevel(up, ctx, task) {
  const level = { title: task.challenge.subject || `关卡 ${task.challenge.position ?? ''}`, status: 'processing', source: null, attempts: 0 };
  if (task.game.status === 2) {
    level.status = 'skipped';
    level.source = 'platform';
    // 已经做完的关卡也把答案收进题库：代码题读文件、客观题读平台记录的上次作答
    harvestPassed(task);
    return level;
  }

  // 绘图题（StarUML 画流程图/数据流图这类）：文件里只有一个空占位 .gitkeep，
  // 真正的答案是在平台的图形编辑器里画出来的，写文件毫无意义，直接标人工。
  const files = task.files ?? [];
  const onlyPlaceholder = files.length > 0
    && files.every(file => /\.gitkeep$/i.test(file.path) || !String(file.content ?? '').trim());
  const looksDiagram = /绘制|画图|StarUML|流程图|数据流图|UML|用例图|类图|ER图/i.test(String(task.challenge.subject ?? ''));
  if (task.challenge.kind === 'code' && (onlyPlaceholder || (looksDiagram && files.length <= 1))) {
    level.status = 'support';
    level.source = 'skipped';
    level.reason_code = 'diagram_manual';
    level.message = '绘图题（需要在平台的图形编辑器里画图），代码提交无法完成，需人工';
    return level;
  }

  // 环境题（判分脚本自己在容器里跑 /opt/hive/bin/hive、hadoop fs 这类）：写文件没用，
  // 必须按配方把容器环境做出来再触发测评。
  const recipe = environmentRecipe(task);
  if (recipe) {
    return runEnvironmentLevel(up, ctx, task, level, recipe);
  }

  // 代码题的前置环境：HDFS-JAVA接口之XXX 这类关卡是代码题，但判分要连 HDFS，容器里 Hadoop 没起就必判负。
  // 每个作业只做一次。
  try {
    const pre = await runPrecondition(ctx, task);
    if (pre?.recipe) level.precondition = pre.recipe;
  } catch { /* 前置失败不致命，继续按代码题走 */ }

  // 需要交互式终端的题（vi/vim 这类）走 webssh：让模型给命令 → 在容器里执行 → 触发评测
  const description = String(task.challenge.description ?? '');
  const terminalTask = /vi\s*\/\s*vim|vim\s*编辑器|vi\s*编辑器|在右侧.?命令行下完成/.test(description) && task.files.length <= 1;
  if (terminalTask) {
    return runTerminalLevel(up, ctx, task, level);
  }

  // 命令行操作题（右侧终端里敲命令）没有可提交的文件，直接转人工，别空耗评测次数
  if (task.challenge.kind === 'terminal') {
    level.status = 'support';
    level.source = 'skipped';
    level.reason_code = 'unsupported_terminal';
    level.message = '这关是在终端里用命令操作（平台检查终端状态），没有可提交的代码文件，需要人工完成';
    return level;
  }


  // 题库的键固定用「原始模板」算：题目描述 + 选项 + 挖空文件的初始内容。
  // 用被改过之后的文件算键会导致每修一次就变一次，永远命中不了。
  const template = toSolverTask(task);
  const key = subjectKey(template);

  // 之前反复失败过的题：默认只给它「一次」新机会，避免每轮空耗评测。
  // 但如果题库里有答案（可能本身是错的），要把完整次数留给「题库失败→大模型重写」这条退路。
  const known = failures.get(key);
  const bankHit = lookupTask(template);
  const attemptBudget = bankHit
    ? config.limits.attempts
    : (known && known.attempts >= config.limits.attempts ? 1 : config.limits.attempts);
  if (known) {
    level.retried = true;
    level.note = `之前失败过 ${known.attempts} 次，本轮只试 ${attemptBudget} 次`;
  }

  ctx.phase('bank_lookup');
  let hit = bankHit;
  // 题库答案必须先校验形状：数量对不上、或出现本关没有的选项字母，说明命中的是另一道同名题。
  // 不校验的话会拿 11 个答案去答 6 道题，错位后全军覆没（这就是「题库有了还是错」的真凶）。
  if (hit && !answerFitsTask(task, hit.answer)) {
    bank.clear(looseKey(template));
    bank.clear(subjectKey(template));
    hit = null;
  }
  let answer = hit?.answer ?? null;
  let from = hit ? 'bank' : null;
  if (hit) level.source = 'bank';

  let feedback = '';
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    ctx.tick();
    level.attempts = attempt;
    if (attempt > 1) ctx.phase('repairing');

    if (!answer) {
      ctx.phase('generating');
      try {
        if (task.challenge.kind === 'choice' && (task.questions ?? []).length) {
          // 逐题答题：先查「单题题库」，只把没见过的题交给模型，省 token 也能跨关卡复用
          const questions = task.questions;
          const known = questions.map(question => lookupQuestion(question));
          const missing = questions.filter((_, index) => !known[index]);
          if (missing.length && missing.length < questions.length) {
            level.note = `题库命中 ${questions.length - missing.length}/${questions.length} 题，其余交给模型`;
          }
          if (missing.length) {
            const solved = await solveWithModel({ ...toSolverTask(task, feedback), questions: missing });
            from = solved.from;
            level.source = from;
            let cursor = 0;
            for (let index = 0; index < questions.length; index += 1) {
              if (!known[index]) { known[index] = solved.answer.answers?.[cursor] ?? null; cursor += 1; }
            }
          } else {
            from = 'bank';
            level.source = 'bank';
          }
          answer = { answers: known };
        } else {
          const solved = await solveWithModel(toSolverTask(task, feedback));
          answer = solved.answer;
          from = solved.from;
          level.source = from;
        }
      } catch (error) {
        throw new Support(error.code ?? 'model_generation_failed', error.message);
      }
    }

    if (task.challenge.kind === 'choice') {
      ctx.phase('submitting');
      try {
        await answerChoice(up, ctx, task, answer);
      } catch (error) {
        // 平台提示「题目有更新」：手头的题干（或题库答案）是旧快照，刷新重做
        if (String(error?.message ?? '').includes('题目有更新')) {
          bank.clear(key);
          bank.clear(looseKey(template));
          task = await up.task(ctx.cookie, ctx.login, task.game.identifier, ctx.homeworkId);
          answer = null;
          from = null;
          level.note = '平台提示题目有更新，已刷新题目重做';
          continue;
        }
        throw error;
      }
      ctx.phase('evaluating');
      // 客观题：平台只给总分、不给逐题结果，所以按分数收敛
      const first = await waitChoice(up, ctx, task);
      if (first.finished) {
        level.status = 'passed';
        level.score = first.score;
        if (from !== 'bank') remember(key, template, answer, ctx.jobId);
        // 逐题入库：一道题一个键，别的关卡/别的课程遇到同一题直接命中
        (task.questions ?? []).forEach((question, index) => {
          const value = answer?.answers?.[index];
          if (value) rememberQuestion(question, value, ctx.jobId);
        });
        failures.clear(key);
        return level;
      }

      const total = (task.questions ?? []).length;
      // 没满分先让模型重做几轮（多选题尤其需要）：把上一轮分数告诉它，让它重审选项
      let bestAnswers = [...answer.answers];
      let bestScore = first.score;
      for (let round = 2; round <= Math.min(2, attemptBudget); round += 1) {
        ctx.tick();
        ctx.phase('repairing');
        const retry = await solveWithModel(toSolverTask(task, `上一轮提交得分 ${bestScore}（未满分）。请重新逐题审视：多选题要把所有正确选项都选上，不要把多选题当成单选。`)).catch(() => null);
        if (!retry?.answer?.answers?.length) break;
        try {
          await answerChoice(up, ctx, task, retry.answer);
        } catch (error) {
          if (String(error?.message ?? '').includes('题目有更新')) {
            task = await up.task(ctx.cookie, ctx.login, task.game.identifier, ctx.homeworkId);
            continue;
          }
          break;
        }
        const result = await waitChoice(up, ctx, task, 25_000, bestScore);
        if (result.finished) {
          level.status = 'passed';
          level.score = result.score;
          level.source = retry.from ?? 'openai';
          remember(key, template, retry.answer, ctx.jobId);
          failures.clear(key);
          return level;
        }
        if (result.score > bestScore) {
          bestScore = result.score;
          bestAnswers = [...retry.answer.answers];
        }
        level.note = `第 ${round} 轮模型重答得分 ${result.score}`;
      }
      const answerForFlip = { answers: bestAnswers };
      // 客观题默认不自动翻转补分：优先人工确认，避免连发提交被判重复、白烧次数
      if (!config.choiceFlip) {
        level.status = 'support';
        level.reason_code = 'choice_manual';
        level.message = `客观题得分 ${bestScore}，需人工确认（自动补差未启用，可用 CHOICE_FLIP=true 打开）`;
        return level;
      }
      // 评测次数已经很多还不过：说明平台不再重新判分（或已到提交上限），再补差只是白烧
      const attemptsUsed = Number(task.game?.evaluate_count ?? 0);
      if (attemptsUsed >= 30) {
        level.status = 'support';
        level.reason_code = 'choice_platform_locked';
        level.message = `客观题已提交 ${attemptsUsed} 次仍停在 ${bestScore} 分，平台可能已不再重新判分，建议人工`;
        return level;
      }
      if (total && bestScore > 0) {
        // 逐题补差：把某一题换成它其余的候选选项再提交，分数跳满就说明改对了。
        // 注意不能只做 A↔B 的翻转——四选一的题里换到 C/D 才是正解。
        const answers = [...answerForFlip.answers];
        const lettersOf = (index) => {
          const options = (task.questions?.[index]?.options ?? []).map(option => option.key);
          return options.length ? options : ['A', 'B', 'C', 'D'];
        };
        let baseline = bestScore;
        // 补差整体限时 5 分钟：题量大的客观题（20 题 × 4 选项）否则能跑十几分钟
        const repairDeadline = Date.now() + 3 * 60_000;
        let budgetLeft = total > 12 ? 12 : 40; // 多错几题时也要能扫完；上限防止极端情况跑太久
        let improved = 0;
        for (let index = 0; index < total && budgetLeft > 0 && Date.now() < repairDeadline; index += 1) {
          const previous = answers[index];
          let raised = false;
          for (const candidate of lettersOf(index)) {
            if (budgetLeft <= 0 || Date.now() >= repairDeadline) break;
            if (candidate === answers[index]) continue;
            answers[index] = candidate;
            budgetLeft -= 1;
            ctx.tick();
            ctx.phase('repairing');
            await answerChoice(up, ctx, task, { answers });
            const attempt = await waitChoice(up, ctx, task, 8_000, baseline);
            if (attempt.finished) {
              level.status = 'passed';
              level.source = 'flip';
              level.score = attempt.score;
              remember(key, template, { answers }, ctx.jobId);
              failures.clear(key);
              return level;
            }
            if (attempt.score > baseline) {
              // 分数涨了 = 这一题原来选错了，保留新选法继续扫下一题
              baseline = attempt.score;
              improved += 1;
              raised = true;
              break;
            }
            if (attempt.score < baseline) {
              // 分数掉了 = 原来那题是对的，改回去
              answers[index] = previous;
              continue;
            }
          }
          if (!raised) answers[index] = previous;
        }
        if (improved) level.note = `补差修正了 ${improved} 题，当前 ${baseline} 分`;
      }
      level.status = 'failed';
      level.reason_code = 'choice_not_full';
      level.message = `客观题得分 ${bestScore}，模型重答与逐题补差后仍未满分`;
      failures.bump(key, template.subject, level.message);
      return level;
    }

    {
      try {
        await answerCode(up, ctx, task, answer);
      } catch (error) {
        // 平台不让改这个文件（不是学员代码文件）——多半是题型判断错了，别把整个任务带崩
        if (String(error?.message ?? '').includes('非学员代码文件')) {
          level.status = 'support';
          level.source = 'skipped';
          level.reason_code = 'not_student_file';
          level.message = '平台拒绝修改该文件（非学员代码文件），可能是题型判断有误，转人工';
          return level;
        }
        throw error;
      }
    }

    ctx.phase('evaluating');
    const verdict = await waitVerdict(up, ctx, task);
    ctx.phase('polling');

    if (verdict.finished) {
      level.status = 'passed';
      level.score = verdict.final_score ?? verdict.accuracy ?? null;
      // 评测认了才入库；题库命中的不重复写
      if (from !== 'bank') remember(key, template, answer, ctx.jobId);
      failures.clear(key);
      return level;
    }

    // 题库给的答案没通过：把这题从题库里删掉，后面让大模型重写，
    // 大模型一旦做对，remember 会把正确答案按同一个键写回去（覆盖旧的错答案）。
    if (from === 'bank') {
      bank.clear(key);
      bank.clear(looseKey(template));
      level.bankDropped = true;
      level.note = '题库答案未通过，已从题库移除，改用大模型重做';
    }

    ctx.phase('verifying');
    // 把「期望输出 vs 实际输出」摘出来，比丢一整坨 JSON 更容易让模型改对
    const diffs = (verdict.testSets ?? [])
      .filter(test => test && test.result !== true)
      .map((test, index) => `用例 ${index + 1}\n期望输出：${JSON.stringify(test.output ?? '')}\n实际输出：${JSON.stringify(test.actual_output ?? '')}`);
    feedback = [verdict.compile_output, ...diffs].filter(Boolean).join('\n').slice(0, 4000);

    const refreshed = await up.task(ctx.cookie, ctx.login, task.game.identifier, ctx.homeworkId);
    task = refreshed;
    if (task.game.status === 2) {
      level.status = 'passed';
      if (from !== 'bank') remember(key, template, answer, ctx.jobId);
      return level;
    }
    answer = null;
    from = null;
  }

  level.status = 'failed';
  level.reason_code = 'attempts_exhausted';
  // 记一笔失败，下次同题不再空耗评测次数
  const record = failures.bump(key, template.subject, feedback.split('\n')[0] || 'attempts_exhausted');
  level.message = `已试 ${record.attempts}/${config.limits.attempts} 次批次上限，转人工`;
  return level;
}

// ---------- 终端题（vi/vim 之类，走 webssh 真敲命令） ----------
async function runTerminalLevel(up, ctx, task, level) {
  const template = toSolverTask(task);
  template.kind = 'terminal';           // 让模型输出命令列表而不是文件内容
  const key = subjectKey(template);

  ctx.phase('bank_lookup');
  const hit = lookupTask(template);
  let commands = Array.isArray(hit?.answer?.commands) ? hit.answer.commands : null;
  let from = hit ? 'bank' : null;
  level.source = from;

  if (!commands) {
    ctx.phase('generating');
    try {
      const solved = await solveWithModel(template);
      commands = Array.isArray(solved.answer?.commands) ? solved.answer.commands : null;
      from = solved.from;
      level.source = from;
    } catch (error) {
      throw new Support(error.code ?? 'model_generation_failed', error.message);
    }
    if (!commands?.length) {
      level.status = 'support';
      level.reason_code = 'terminal_plan_missing';
      level.message = '模型没有给出可执行的终端命令';
      return level;
    }
  }

  ctx.phase('terminal');
  const terminal = await openTerminal({ session: ctx.cookie, gameUid: task.game.identifier, homeworkId: ctx.homeworkId });
  try {
    for (const line of commands) {
      ctx.tick();
      await terminal.run(String(line), 6000);
    }
    ctx.phase('evaluating');
    const verdict = await terminal.evaluate();
    if (verdict.finished) {
      level.status = 'passed';
      level.score = verdict.score ?? null;
      if (from !== 'bank') remember(key, template, { commands }, ctx.jobId);
      failures.clear(key);
      return level;
    }
    const detail = (verdict.tests ?? []).map(test => `期望：${test?.output ?? ''} 实际：${test?.actual_output ?? ''}`).join('\n');
    level.status = 'failed';
    level.reason_code = 'terminal_verification_failed';
    level.message = detail.slice(0, 300) || '终端执行完但判分没通过';
    const record = failures.bump(key, template.subject, level.message);
    if (record.attempts >= config.limits.attempts) level.reason_code = 'attempts_exhausted';
    return level;
  } finally {
    terminal.close();
  }
}

async function runHomework(up, ctx, courseIdentifier, homework) {
  ctx.homeworkId = homework.id;
  const row = { title: homework.name, status: 'processing', levels: [] };
  ctx.phase('loading');
  let tasks = [];
  try {
    tasks = await listChallenges(up, ctx, courseIdentifier, homework.id);
  } catch (error) {
    // Jupyter 图文作业没有 shixun 关卡（/tasks/{gid}.json 会 404），单独走 Jupyter 链路
    const notFound = error?.code === 'UPSTREAM_NOT_FOUND' || /不存在|已被删除/.test(String(error?.message ?? ''));
    if (!notFound) throw error;
    tasks = [];
  }

  if (!tasks.length) {
    const gameUid = homework.myshixunIdentifier ?? homework.shixunIdentifier;
    if (gameUid) {
      ctx.phase('generating');
      try {
        const done = await solveJupyter({ session: ctx.cookie, gameUid, homeworkId: homework.id, ctx });
        row.levels.push({
          title: `Jupyter：${done.notebook}`,
          status: 'passed',
          source: 'openai',
          attempts: 1,
          note: `补全 ${done.filled} 个 cell 并提交`,
        });
        row.status = 'completed';
        row.reason_code = 'jupyter_submitted';
        return row;
      } catch (error) {
        row.levels.push({
          title: 'Jupyter 实验',
          status: 'support',
          source: 'openai',
          attempts: 1,
          message: String(error?.message ?? error).slice(0, 160),
        });
        row.status = 'support';
        row.reason_code = error?.code ?? 'jupyter_failed';
        return row;
      }
    }
  }

  ctx.phase('collecting');
  if (!tasks.length) {
    row.status = 'skipped';
    row.reason_code = 'no_required_levels';
    return row;
  }

  // 平台的关卡链是「过一关才解锁下一关」：一开始读到的链可能只有前两关，
  // 通关后后面的关卡才出现，所以要分几轮扫，直到没有新关卡为止。
  const seenGids = new Set();
  for (let round = 0; round < 4; round += 1) {
    const tasks = round === 0 ? await listChallenges(up, ctx, courseIdentifier, homework.id) : await listChallenges(up, ctx, courseIdentifier, homework.id);
    const fresh = tasks.filter(task => !seenGids.has(String(task.game.identifier)));
    if (!fresh.length) break;
    for (const task of fresh) {
      seenGids.add(String(task.game.identifier));
      ctx.tick();
      const level = await solveLevel(up, ctx, task);
      row.levels.push(level);
      ctx.row(row);
      if (level.status === 'failed') {
        row.status = 'failed';
        row.reason_code = level.reason_code;
        return row;
      }
      if (level.status === 'support') {
        // 这关跳过（之前试太多次），但整份作业继续往下做
        row.status = 'support';
        row.reason_code = level.reason_code;
      }
    }
  }
  row.status = row.status === 'support' ? 'support' : 'completed';
  return row;
}

// ---------- 主入口 ----------
export async function runJob(job, ctxBase) {
  const request = job.request;
  const ctx = {
    harvestBudget: 400,
    jobId: job.id,
    userId: ctxBase.userId,
    login: ctxBase.login,
    cookie: ctxBase.cookie,
    homeworkId: null,
    ...ctxBase,
  };

  const startedAt = Date.now();
  const deadline = startedAt + (request.mode === 'collect_verified'
    ? config.limits.bankCollectTimeMs
    : config.limits.jobTimeMs);

  let reads = 0;
  const rowList = [];

  ctx.tick = () => {
    reads += 1;
    if (ctxBase.cancelled?.()) throw new Canceled();
    if (Date.now() > deadline) throw new TimedOut();
  };
  ctx.phase = (phase, extra = {}) => ctxBase.onPhase(phase, extra);
  ctx.row = (row) => {
    const index = rowList.indexOf(row);
    if (index < 0) rowList.push(row);
    ctxBase.onRow(rowList);
  };
  ctx.markSubmission = (task, commitId) => ctxBase.onSubmission({ gameId: task.challenge.id, commitId });

  ctx.phase('starting');

  if (request.mode === 'collect_verified') return runCollect(upstreamOf(ctx), ctx);
  if (request.scope === 'exercise') return runExercise(upstreamOf(ctx), ctx);

  const up = upstreamOf(ctx);
  ctx.phase('preflight');

  const courses = await resolveCourses(up, ctx);
  if (!courses.length) {
    return { status: 'completed', result: { title: '没有需要安排的课程', homeworks: [], total_homeworks: 0, completed_homeworks: 0 }, progress: {} };
  }

  const rows = [];
  let completed = 0;
  let totalLevels = 0;
  let completedLevels = 0;
  let needsAttention = false;

  for (const course of courses) {
    ctx.tick();
    const allHomeworks = await up.homeworks(ctx.cookie, ctx.login, course.identifier);
    // scope 收窄：homework/current 只做指定那一份，别把整门课的作业都跑了
    const homeworks = request.scope === 'homework' || request.scope === 'current'
      ? allHomeworks.filter(homework => homework.id === Number(request.homework_id))
      : allHomeworks;
    for (const homework of homeworks) {
      ctx.tick();
      const remaining = (homework.requiredChallengeCount ?? homework.challengeCount ?? 0)
        - (homework.finishedRequiredChallengeCount ?? homework.finishedChallengeCount ?? 0);
      // 已截止的作业不碰：真去提交只会拿到平台拒绝
      if (homework.expired) {
        rows.push({ title: `${course.name} · ${homework.name}`, status: 'deadline_passed', reason_code: 'deadline_passed', levels: [] });
        continue;
      }
      if (homework.requiredProgressKnown && remaining <= 0) {
        // 已完成的作业算作已完成，不是「跳过」——用户看到的是 3/3 而不是 0/3
        // 顺便把里面每一关的成品答案收进题库（有预算上限，避免整门课跑太久）
        if (ctx.harvestBudget > 0) {
          await harvestCompletedHomework(up, ctx, course, homework).catch(() => 0);
        }
        rows.push({ title: `${course.name} · ${homework.name}`, status: 'skipped', reason_code: 'already_completed', levels: [] });
        completed += 1;
        ctxBase.onProgress({ total_homeworks: rows.length, completed_homeworks: completed, total_levels: totalLevels, completed_levels: completedLevels });
        continue;
      }
      try {
        const row = await runHomework(up, ctx, course.identifier, homework);
        row.title = request.scope === 'all' ? `${course.name} · ${homework.name}` : homework.name;
        rows.push(row);
        if (row.status === 'completed') completed += 1;
        if (row.status === 'failed' || row.status === 'support') needsAttention = true;
        totalLevels += row.levels.length;
        completedLevels += row.levels.filter(level => level.status === 'passed' || level.status === 'skipped').length;
        ctxBase.onProgress({ total_homeworks: rows.length, completed_homeworks: completed, total_levels: totalLevels, completed_levels: completedLevels });
        // 单份作业失败不再中断整门课：记下来继续做下一份，最后统一报「需要跟进」
      } catch (error) {
        if (error instanceof Canceled || error instanceof TimedOut) throw error;
        if (error?.support) {
          rows.push({ title: `${course.name} · ${homework.name}`, status: 'support', reason_code: error.code, message: error.message, levels: [] });
          needsAttention = true;
          continue;
        }
        // 认证失效要整单停；其它上游异常只影响这一份作业，别把整门课带崩
        if (error?.code === 'UPSTREAM_AUTH_EXPIRED' || error?.code === 'UNAUTHENTICATED') throw error;
        rows.push({
          title: `${course.name} · ${homework.name}`,
          status: 'support',
          reason_code: error?.code ?? 'upstream_error',
          message: String(error?.message ?? '上游异常').slice(0, 200),
          levels: [],
        });
        needsAttention = true;
        continue;
      }
    }
  }

  ctx.phase('completed');
  const allDone = rows.every(row => ['completed', 'skipped', 'deadline_passed'].includes(row.status));
  // 有作业失败/转人工时，任务本身仍然算「跑完了」（succeeded），只是 service_status = support，
  // 前端会显示「服务处理中」，失败的那几份在明细里能点开看。
  return {
    status: needsAttention ? 'succeeded' : 'succeeded',
    result: {
      homeworks: rows,
      total_homeworks: rows.length,
      completed_homeworks: completed,
      service_status: allDone ? 'completed' : 'support',
      reads,
    },
    progress: { total_homeworks: rows.length, completed_homeworks: completed, total_levels: totalLevels, completed_levels: completedLevels },
  };
}

function upstreamOf(ctx) {
  return ctx.upstream;
}

async function resolveCourses(up, ctx) {
  const request = ctx.request;
  if (request.scope === 'all') {
    const all = await up.courses(ctx.cookie);
    return all.slice(0, config.limits.maxCourses);
  }
  const all = await up.courses(ctx.cookie);
  const one = all.find(course => course.identifier === request.course);
  if (!one) throw new Support('course_identity_invalid', '课程标识不完整，暂停执行');
  return [one];
}

// ---------- 在线考试 ----------
async function runExercise(up, ctx) {
  const request = ctx.request;
  ctx.phase('preflight');
  const exercises = await up.exercises(ctx.cookie, ctx.login, request.course);
  const exercise = exercises.find(item => item.id === Number(request.exercise_id));
  if (!exercise) throw new Support('identity_mismatch', '考试或题目身份不一致');
  if (exercise.submitted) {
    return {
      status: 'succeeded',
      result: { title: exercise.name, submitted: true, score_known: exercise.scoreKnown, score: exercise.score, service_status: exercise.scoreKnown ? 'graded' : 'awaiting_review' },
      progress: { total_questions: exercise.totalQuestions, completed_questions: exercise.totalQuestions },
    };
  }
  if (!exercise.available || exercise.actionRequired) {
    throw new Support(exercise.reasonCode ?? 'action_required', '考试入场事项需要在头歌处理');
  }

  ctx.phase('submitting');
  const submitted = await up.submitExercise(ctx.cookie, ctx.login, {
    courseIdentifier: request.course,
    exerciseId: exercise.id,
  });
  ctx.phase('verifying');
  if (!submitted?.submitted) throw new Support('submitted_state_unconfirmed', '交卷状态尚未确认');

  return {
    status: 'succeeded',
    result: {
      title: exercise.name,
      submitted: true,
      score_known: false,
      total_questions: submitted.totalQuestions ?? exercise.totalQuestions,
      service_status: 'awaiting_review',
    },
    progress: { total_questions: submitted.totalQuestions ?? exercise.totalQuestions, completed_questions: submitted.totalQuestions ?? exercise.totalQuestions },
  };
}

// ---------- 题库采集（只读） ----------
async function runCollect(up, ctx) {
  const summary = { scanned: 0, saved: 0, skipped: 0, failed: 0, limit_reached: false, stop_reason: '', reads: 0 };
  ctx.phase('preflight');
  const courses = await up.courses(ctx.cookie);
  const picked = courses.slice(0, config.limits.maxCourses);

  try {
    for (const course of picked) {
      const homeworks = await up.homeworks(ctx.cookie, ctx.login, course.identifier);
      for (const homework of homeworks.slice(0, config.limits.maxHomeworks)) {
        ctx.homeworkId = homework.id;
        let tasks;
        try {
          tasks = await listChallenges(up, ctx, course.identifier, homework.id);
        } catch (error) {
          if (error instanceof Canceled || error instanceof TimedOut) throw error;
          summary.failed += 1;
          continue;
        }
        for (const task of tasks) {
          ctx.tick();
          summary.reads += 1;
          summary.scanned += 1;
          if (summary.reads >= config.limits.collectReadBudget) {
            summary.limit_reached = true;
            summary.stop_reason = 'read_budget_limit';
            break;
          }
          const solverTask = toSolverTask(task);
          if (task.challenge.kind === 'choice' && task.challenge.__answer) {
            remember(solverTask, { answers: task.challenge.__answer.map(String) }, ctx.jobId);
            summary.saved += 1;
          } else if (task.game.status === 2) {
            summary.skipped += 1;
          }
          ctx.onProgress?.({ total_homeworks: 0, completed_homeworks: 0, scanned: summary.scanned, saved: summary.saved });
        }
        if (summary.limit_reached) break;
      }
      if (summary.limit_reached) break;
    }
  } catch (error) {
    if (error instanceof TimedOut) {
      summary.limit_reached = true;
      summary.stop_reason = 'time_limit';
    } else {
      throw error;
    }
  }

  ctx.phase('completed');
  return {
    status: 'succeeded',
    result: { collection: { ...summary, scan_complete: !summary.limit_reached } },
    progress: {},
  };
}
