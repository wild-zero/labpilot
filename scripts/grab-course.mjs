// 抓取某账号某门课的全部题目与答案（含已截止）；只有「该关已通过」的答案才算正确答案
//
// 用法：node scripts/grab-course.mjs <登录名> <课程关键词>
//   node scripts/grab-course.mjs 13800000000 数据科学与大数据技术导论
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { remember, looseKey } from '../server/engine/solver/index.mjs';

const login = process.argv[2];
const keyword = process.argv[3];
if (!login || !keyword) {
  console.log('用法：node scripts/grab-course.mjs <登录名> <课程关键词>');
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
if (!course) {
  console.log('找不到课程，现有：');
  for (const item of courses) console.log('  ·', item.name, item.identifier);
  process.exit(1);
}
console.log(`课程：${course.name}  ${course.identifier}`);

const homeworks = await up.homeworks(session, user.login, course.identifier);
console.log(`作业 ${homeworks.length} 份`);

const lines = [`# ${course.name}  题目与正确答案`, '', `> 抓取时间：${new Date().toLocaleString('zh-CN')}`, '> 只有「该关已通过」的答案才标为正确答案；未通过的只记原作答，仅供参照。', ''];
let questionTotal = 0;
let verifiedQuestions = 0;
let banked = 0;

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
  } catch (error) {
    lines.push(`## ${String(homework.name).trim()}`, '', `（打不开：${error.message}）`, '');
    continue;
  }

  lines.push(`## ${String(homework.name).trim()}${homework.expired ? '（已截止）' : ''}`, '');

  for (const task of chain) {
    const subject = String(task.challenge.subject ?? '');
    const passed = task.game.status === 2;
    const questions = task.questions ?? [];
    const recorded = (task.chooseTestCases?.test_sets ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position));

    lines.push(`### 第${task.challenge.position}关 ${subject}  ${passed ? `✅ 已通过 ${task.game.final_score ?? ''}` : '❌ 未通过'}`);

    if (!questions.length) {
      lines.push('', (task.files ?? []).length ? '（代码题，见仓库文件）' : '（无题目数据）', '');
      continue;
    }

    for (const question of questions) {
      questionTotal += 1;
      const answer = recorded.find(item => Number(item.position) === Number(question.position))?.actual_output;
      const label = passed && answer
        ? `**正确答案：${answer}**`
        : (answer ? `原作答：${answer}（未通过，仅供参考）` : '（无作答记录）');
      if (passed && answer) verifiedQuestions += 1;
      lines.push(`${question.position}. ${String(question.subject ?? '').replace(/\s+/g, ' ')}`);
      for (const option of question.options ?? []) lines.push(`   - ${option.key}. ${String(option.text).replace(/\s+/g, ' ')}`);
      lines.push(`   ${label}`, '');
    }

    if (passed) {
      const answers = recorded.map(item => String(item.actual_output ?? '').trim()).filter(Boolean);
      if (answers.length === questions.length) {
        const template = { kind: 'choice', subject, description: task.challenge.description, questions };
        remember(looseKey(template), template, { answers }, 'harvest-verified');
        banked += 1;
      }
    }
  }
  lines.push('');
}

mkdirSync('data', { recursive: true });
const file = `data/${keyword}-题目与答案.md`;
writeFileSync(file, lines.join('\n'), 'utf8');
const check = new DatabaseSync(config.dbFile);
console.log(`题目 ${questionTotal} 道，其中正确答案 ${verifiedQuestions} 道`);
console.log(`入库 ${banked} 关；题库共 ${check.prepare('SELECT COUNT(*) AS n FROM bank').get().n} 条`);
check.close();
console.log('输出：', file);
