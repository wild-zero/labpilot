// 把某账号某门课的客观题，按「一题一条」写进题库（只收已通过关卡的答案）
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { rememberQuestion, questionKey } from '../server/engine/solver/index.mjs';

const login = process.argv[2];
const keyword = process.argv[3];
if (!login || !keyword) {
  console.log('用法：node scripts/harvest-questions.mjs <登录名> <课程关键词>');
  process.exit(1);
}

const db = new DatabaseSync(config.dbFile);
const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
if (!user) { console.log('找不到账号', login); process.exit(1); }
const session = JSON.parse(openSealed(user.upstream_cookie));
db.close();

const up = createEduCoderUpstream();
const courses = await up.courses(session);
const course = courses.find(item => String(item.name).includes(keyword));
if (!course) { console.log('找不到课程'); process.exit(1); }
console.log(`课程：${course.name}  ${course.identifier}`);

const homeworks = await up.homeworks(session, user.login, course.identifier);
console.log(`作业 ${homeworks.length} 份`);

let levels = 0;
let stored = 0;
let skippedLevels = 0;

for (const homework of homeworks) {
  let chain = [];
  try {
    const entry = await up.enter(session, user.login, course.identifier, homework.id);
    let cursor = entry.gameIdentifier;
    const seen = new Set();
    for (let i = 0; i < 30; i += 1) {
      const task = await up.task(session, user.login, cursor, homework.id);
      seen.add(String(cursor));
      if (!task.prevGame || seen.has(String(task.prevGame))) break;
      cursor = task.prevGame;
    }
    for (let i = 0; i < 30 && cursor; i += 1) {
      const task = await up.task(session, user.login, cursor, homework.id);
      chain.push(task);
      if (!task.nextGame) break;
      cursor = task.nextGame;
    }
  } catch { continue; }

  for (const task of chain) {
    const questions = task.questions ?? [];
    if (!questions.length) continue;
    if (task.game.status !== 2) { skippedLevels += 1; continue; }
    const recorded = (task.chooseTestCases?.test_sets ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position));
    if (recorded.length !== questions.length) { skippedLevels += 1; continue; }
    levels += 1;
    for (const question of questions) {
      const answer = recorded.find(item => Number(item.position) === Number(question.position))?.actual_output;
      if (!answer) continue;
      rememberQuestion(question, String(answer), 'harvest-verified');
      stored += 1;
    }
  }
}

const check = new DatabaseSync(config.dbFile);
console.log(`已通过关卡 ${levels} 个，写入逐题答案 ${stored} 条（跳过 ${skippedLevels} 个未通过/无记录关卡）`);
console.log('逐题条目总数：', check.prepare("SELECT COUNT(*) AS n FROM bank WHERE kind = 'question'").get().n);
console.log('题库总量：', check.prepare('SELECT COUNT(*) AS n FROM bank').get().n);
check.close();
