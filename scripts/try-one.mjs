// 单关卡试跑：把一个关卡从头走到尾（读题 → 求解 → 保存 → 评测 → 判分），用来验证写路径。
// 默认「干跑」：只读取题目和当前文件，把将要提交的内容打印出来，不动你的账号。
// 加 --yes 才会真的保存并触发评测。
//
// 用法：
//   node scripts/try-one.mjs                          # 干跑，最近登录的账号，自动挑第一个待完成关卡
//   node scripts/try-one.mjs 操作系统                  # 指定课程名片段
//   node scripts/try-one.mjs 操作系统 --yes            # 真的交这一关
//   node scripts/try-one.mjs 操作系统 --index 2        # 挑第 2 个待完成关卡
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { solver } from '../server/engine/solver/index.mjs';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const roundtrip = args.includes('--roundtrip');
const attemptsFlag = args.indexOf('--attempts');
const maxAttempts = Math.max(1, Number(attemptsFlag >= 0 ? args[attemptsFlag + 1] : 0) || config.limits.attempts);
const indexFlag = args.indexOf('--index');
const wanted = Number(indexFlag >= 0 ? args[indexFlag + 1] : 1) || 1;
const nameFilter = args.find(arg => !arg.startsWith('--') && !/^\d+$/.test(arg)) ?? '';

const db = new DatabaseSync(config.dbFile);
const row = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
if (!row) {
  console.error('库里没有带会话的用户，先在页面上用真实账号登录一次。');
  process.exit(1);
}
const session = JSON.parse(openSealed(row.upstream_cookie) ?? 'null');
if (!session?.cookie) {
  console.error('会话已失效，重新登录一次。');
  process.exit(1);
}
db.close();

const up = createEduCoderUpstream();
const login = row.login;

const courses = await up.courses(session);
let course = (nameFilter && courses.find(item => String(item.name).includes(nameFilter))) || null;
let forcedHomework = null;

// 支持用「作业名片段」定位：课程名里没有就去各课程的作业里找
if (!course && nameFilter) {
  for (const candidate of courses) {
    const list = await up.homeworks(session, login, candidate.identifier);
    const hit = list.find(homework => String(homework.name).includes(nameFilter));
    if (hit) { course = candidate; forcedHomework = hit; break; }
  }
}
if (!course) course = courses[0];
console.log(`课程：${course.name} (${course.identifier})`);

const homeworks = await up.homeworks(session, login, course.identifier);
const live = homeworks.filter(homework => !homework.expired && homework.shixunIdentifier);
console.log(`作业：${homeworks.length} 份，其中未截止 ${live.length} 份`);
for (const homework of live.slice(0, 8)) {
  console.log(`  · ${homework.name}  关=${homework.finishedRequiredChallengeCount}/${homework.requiredChallengeCount ?? '?'}`);
}
if (!live.length) {
  console.log('\n这门课没有未截止的作业，换一门：node scripts/try-one.mjs 课程名片段');
  process.exit(0);
}

let picked = forcedHomework ?? null;
if (!picked) {
  for (const homework of live) {
    const remaining = (homework.requiredChallengeCount ?? 0) - (homework.finishedRequiredChallengeCount ?? 0);
    if (homework.requiredProgressKnown && remaining <= 0) continue;
    picked = homework;
    break;
  }
}
if (!picked) {
  console.log('\n未截止的作业都已经完成了。');
  process.exit(0);
}

console.log(`\n选中作业：${picked.name} (homework_id=${picked.id}, shixun=${picked.shixunIdentifier})`);
const entry = await up.enter(session, login, course.identifier, picked.id);
console.log(`入口关卡：${entry.gameIdentifier}`);

// 回卷到第一关
let cursor = entry.gameIdentifier;
const seen = new Set();
for (let guard = 0; guard < 50; guard += 1) {
  const task = await up.task(session, login, cursor, picked.id);
  seen.add(String(cursor));
  if (!task.prevGame || seen.has(String(task.prevGame))) break;
  cursor = task.prevGame;
}

// 再从头走到尾，缓存每关的标识
const queue = [];
const visited = new Set();
for (let guard = 0; cursor && guard < 50; guard += 1) {
  const task = await up.task(session, login, cursor, picked.id);
  queue.push({ gid: cursor, task });
  if (!task.nextGame || visited.has(String(task.nextGame))) break;
  visited.add(String(task.nextGame));
  cursor = task.nextGame;
}
console.log(`关卡链：${queue.map(({ task }) => `${task.challenge.position ?? '?'}:${task.game.status === 2 ? '✓' : '·'}`).join(' → ')}`);

const unfinished = queue.filter(item => item.task.game.status !== 2);
const target = unfinished[Math.min(wanted, unfinished.length) - 1];
if (!target) {
  console.log('\n这条链上没有未完成的关卡。');
  process.exit(0);
}

const task = target.task;
console.log(`\n目标关卡：第 ${task.challenge.position ?? '?'} 关「${task.challenge.subject}」 kind=${task.challenge.kind} status=${task.game.status}`);
console.log(`题干（前 160 字）：${String(task.challenge.description ?? '').replace(/\s+/g, ' ').slice(0, 160)}…`);
for (const file of task.files) {
  console.log(`\n--- ${file.path}（${file.content.length} 字节）---`);
  console.log(file.content.slice(0, 800));
}

const solverTask = {
  kind: task.challenge.kind,
  subject: task.challenge.subject,
  description: task.challenge.description,
  files: task.files,
  options: task.challenge.options,
  optionCount: 1,
  testSets: task.testSets ?? undefined,
  __answer: task.challenge.__answer,
};

console.log(`\n求解器：${config.solver.provider}`);

// --roundtrip：把读到的内容原样写回去再读一遍，验证写通道（不改答案、不触发评测）
if (roundtrip) {
  console.log('\n== 写回测试：内容原样保存，不触发评测 ==');
  let commitId = task.myshixun.commitId;
  for (const file of task.files) {
    const saved = await up.saveFile(session, login, {
      myshixunIdentifier: task.myshixun.identifier,
      myshixunId: task.myshixun.id,
      gameId: task.game.id,
      gameUid: target.gid,
      path: file.path,
      content: file.content,
      encoding: 'plain',
      homeworkId: picked.id,
      challengeId: task.challenge.id,
      userId: session.uid,
      commitId,
    });
    console.log(`  写入 ${file.path}（${file.content.length} 字节，编码 ${file.encoding}）-> commitID=${saved.commitID}`);
    console.log(`  响应：${JSON.stringify(saved.payload).slice(0, 300)}`);
    if (saved.commitID != null) commitId = saved.commitID;
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  const after = await up.task(session, login, target.gid, picked.id);
  const original = task.files[0];
  const now = after.files[0];
  console.log(`  读回：${now.content.length} 字节，编码 ${now.encoding}`);
  console.log(now.content === original.content ? '  ✅ 内容一致，写通道可用' : `  ❌ 内容不一致\n--- 原来 ---\n${original.content}\n--- 现在 ---\n${now.content}`);
  process.exit(now.content === original.content ? 0 : 1);
}

let answer;
try {
  answer = await solver().solve(solverTask);
} catch (error) {
  console.log(`\n求解失败：${error.code ?? ''} ${error.message}`);
  console.log('\n这一步就是「配置模型」要解决的。配好 .env 里的 SOLVER / OPENAI_* 再跑。');
  process.exit(0);
}

console.log('\n生成结果：');
if (solverTask.kind === 'choice') {
  console.log('  answers =', JSON.stringify(answer.answers));
} else {
  for (const file of answer.files ?? []) {
    console.log(`  --- ${file.path} ---`);
    console.log(file.content.slice(0, 800));
  }
}

if (!yes) {
  console.log('\n（干跑结束，什么都没提交）确认要真交这一关就加 --yes：');
  console.log(`  node scripts/try-one.mjs ${nameFilter || course.name.slice(0, 4)} --yes`);
  process.exit(0);
}

console.log(`\n开始提交（最多 ${maxAttempts} 次尝试）…`);
let feedback = '';
let current = task;
let answerNow = answer;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  if (attempt > 1) {
    console.log(`\n—— 第 ${attempt} 次尝试，按上一轮反馈重做 ——`);
    current = await up.task(session, login, target.gid, picked.id);
    try {
      answerNow = await solver().solve({ ...solverTask, files: current.files, testSets: current.testSets, feedback });
    } catch (error) {
      console.log(`  求解失败：${error.code ?? ''} ${error.message}`);
      break;
    }
    for (const file of answerNow.files ?? []) {
      console.log(`  --- ${file.path} ---`);
      console.log(file.content.split('\n').slice(0, 25).map(line => '  ' + line).join('\n'));
    }
  }

  let commitId = current.myshixun.commitId;
  if (solverTask.kind === 'code') {
    for (const file of answerNow.files ?? []) {
      const saved = await up.saveFile(session, login, {
        myshixunIdentifier: current.myshixun.identifier,
        myshixunId: current.myshixun.id,
        gameId: current.game.id,
        gameUid: target.gid,
        path: file.path,
        content: file.content,
        encoding: 'plain',
        homeworkId: picked.id,
        challengeId: current.challenge.id,
        userId: session.uid,
        commitId,
      });
      console.log(`  保存 ${file.path} -> commitID=${saved.commitID}`);
      if (saved.commitID != null) commitId = saved.commitID;
    }
    const built = await up.build(session, login, {
      gameUid: target.gid,
      gameId: current.game.id,
      homeworkId: picked.id,
      challengeId: current.challenge.id,
      shixunEnvironmentId: current.challenge.shixunEnvironmentId,
      commitId,
    });
    console.log(`  触发评测 -> ${JSON.stringify(built)}`);
  } else {
    await up.choose(session, login, {
      gameUid: target.gid,
      gameId: current.game.id,
      answer: answerNow.answers,
      challengeId: current.challenge.id,
      subjectId: current.challenge.secKey,
    });
    console.log('  已提交选择题答案');
  }

  let verdict = null;
  for (let poll = 0; poll < 40; poll += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    verdict = await up.verdict(session, login, target.gid, picked.id);
    console.log(`  第 ${poll + 1} 次读取：status=${verdict.status} finished=${verdict.finished} 分数=${verdict.final_score} 正确率=${verdict.accuracy} 评测次数=${verdict.evaluate_count}`);
    if (verdict.finished) break;
    if (!verdict.running && verdict.evaluate_count > 0 && poll > 0) break;
  }

  if (verdict?.finished) {
    console.log('\n✅ 这一关通过了');
    process.exit(0);
  }

  const tests = await up.task(session, login, target.gid, picked.id).catch(() => null);
  const diffs = (tests?.testSets ?? [])
    .filter(test => test && test.result !== true)
    .map((test, i) => `用例 ${i + 1}\n期望输出：${JSON.stringify(test.output ?? '')}\n实际输出：${JSON.stringify(test.actual_output ?? '')}`);
  feedback = [verdict?.compile_output, ...diffs].filter(Boolean).join('\n').slice(0, 4000);
  console.log('  评测差异：');
  console.log(feedback.split('\n').map(line => '    ' + line).join('\n') || '    （没拿到具体差异）');
}

console.log(`\n❌ 试了 ${maxAttempts} 次仍未通过。去看头歌里这一关的实际输出，或把上面的差异贴给我调提示词。`);
