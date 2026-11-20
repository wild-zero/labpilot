// 把某一关的成品答案（已通过状态）立刻收进题库，不用等下一次跑课。
//
// 用法：node scripts/bank-level.mjs <登录名> <课程关键词> <作业关键词> <关卡关键词>
//   node scripts/bank-level.mjs 13800000000 数据采集 爬虫实战 网页数据分析
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { remember, looseKey, rememberQuestion } from '../server/engine/solver/index.mjs';

const [login, courseKeyword, homeworkKeyword, levelKeyword] = process.argv.slice(2);
if (!login || !courseKeyword || !homeworkKeyword || !levelKeyword) {
  console.log('用法：node scripts/bank-level.mjs <登录名> <课程关键词> <作业关键词> <关卡关键词>');
  process.exit(1);
}

const db = new DatabaseSync(config.dbFile);
const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
if (!user) { console.log('找不到账号', login); process.exit(1); }
const session = JSON.parse(openSealed(user.upstream_cookie));
db.close();

const up = createEduCoderUpstream();
const courses = await up.courses(session);
const course = courses.find(item => String(item.name).includes(courseKeyword));
if (!course) { console.log('找不到课程', courseKeyword); process.exit(1); }
const homeworks = await up.homeworks(session, user.login, course.identifier);
const homework = homeworks.find(item => String(item.name).includes(homeworkKeyword));
if (!homework) { console.log('找不到作业', homeworkKeyword); process.exit(1); }

const entry = await up.enter(session, user.login, course.identifier, homework.id);
let cursor = entry.gameIdentifier;
const seen = new Set();
for (let i = 0; i < 30; i += 1) {
  const t = await up.task(session, user.login, cursor, homework.id);
  seen.add(String(cursor));
  if (!t.prevGame || seen.has(String(t.prevGame))) break;
  cursor = t.prevGame;
}
let target = null;
for (let i = 0; i < 30 && cursor; i += 1) {
  const t = await up.task(session, user.login, cursor, homework.id);
  if (String(t.challenge.subject).includes(levelKeyword)) { target = t; break; }
  if (!t.nextGame) break;
  cursor = t.nextGame;
}
if (!target) { console.log('找不到关卡', levelKeyword); process.exit(1); }

console.log(`关卡：${target.challenge.subject}  状态=${target.game.status} 分数=${target.game.final_score ?? 0} kind=${target.challenge.kind}`);

if (target.game.status !== 2) {
  console.log('这一关还没通过，先做掉再入库');
  process.exit(2);
}

if (target.challenge.kind === 'code' && (target.files ?? []).length) {
  const template = { kind: 'code', subject: target.challenge.subject, description: target.challenge.description, files: [] };
  remember(looseKey(template), template, { files: target.files.map(f => ({ path: f.path, content: f.content })) }, 'manual-bank');
  console.log(`✅ 已入库（代码题，${target.files.length} 个文件）`);
} else if ((target.questions ?? []).length) {
  const recorded = (target.chooseTestCases?.test_sets ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position));
  const answers = recorded.map(item => String(item.actual_output ?? '').trim()).filter(Boolean);
  if (answers.length !== target.questions.length) { console.log('作答记录不完整，无法入库'); process.exit(3); }
  for (const question of target.questions) {
    const value = recorded.find(item => Number(item.position) === Number(question.position))?.actual_output;
    if (value) rememberQuestion(question, String(value), 'manual-bank');
  }
  const template = { kind: 'choice', subject: target.challenge.subject, description: target.challenge.description, questions: target.questions };
  remember(looseKey(template), template, { answers }, 'manual-bank');
  console.log(`✅ 已入库（客观题，${answers.length} 题）`);
} else {
  console.log('这一关没有可入库的内容（终端题/绘图题）');
}

const check = new DatabaseSync(config.dbFile);
console.log('题库总量：', check.prepare('SELECT COUNT(*) AS n FROM bank').get().n);
check.close();
