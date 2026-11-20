// 全量抓取一个账号所有课程的题目与答案（客观题题干+答案、代码题文件内容）
//
// 用法：node scripts/crawl-account.mjs <登录名>
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { remember, looseKey, rememberQuestion } from '../server/engine/solver/index.mjs';

const login = process.argv[2];
if (!login) { console.log('用法：node scripts/crawl-account.mjs <登录名>'); process.exit(1); }

const db = new DatabaseSync(config.dbFile);
const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
if (!user) { console.log('找不到账号', login); process.exit(1); }
const session = JSON.parse(openSealed(user.upstream_cookie));
db.close();

const up = createEduCoderUpstream();
const courses = await up.courses(session);
const lines = [`# ${user.name ?? login} · 全课程题目与答案`, '', `> 抓取时间：${new Date().toLocaleString('zh-CN')}`, ''];
const stats = { choice: 0, code: 0, terminal: 0, levels: 0, passed: 0 };

for (const course of courses) {
  let homeworks = [];
  try { homeworks = await up.homeworks(session, user.login, course.identifier); } catch { continue; }
  if (!homeworks.length) continue;
  lines.push(`# ${course.name}`, '');
  console.log(`\n== ${course.name}（${homeworks.length} 份作业）`);

  for (const homework of homeworks) {
    if (!homework.shixunIdentifier) continue;
    let chain = [];
    try {
      const entry = await up.enter(session, user.login, course.identifier, homework.id);
      let cursor = entry.gameIdentifier;
      const seen = new Set();
      for (let i = 0; i < 40; i += 1) {
        const task = await up.task(session, user.login, cursor, homework.id);
        seen.add(String(cursor));
        if (!task.prevGame || seen.has(String(task.prevGame))) break;
        cursor = task.prevGame;
      }
      for (let i = 0; i < 40 && cursor; i += 1) {
        const task = await up.task(session, user.login, cursor, homework.id);
        chain.push(task);
        if (!task.nextGame) break;
        cursor = task.nextGame;
      }
    } catch { continue; }

    lines.push(`## ${String(homework.name).trim()}${homework.expired ? '（已截止）' : ''}`, '');

    for (const task of chain) {
      stats.levels += 1;
      const passed = task.game.status === 2;
      if (passed) stats.passed += 1;
      const kind = task.challenge.kind;
      const subject = String(task.challenge.subject ?? '');
      lines.push(`### 第${task.challenge.position}关 ${subject}  ${passed ? '✅' : '❌'} ${task.game.final_score ?? ''}`);

      if (kind === 'code' && (task.files ?? []).length) {
        stats.code += 1;
        for (const file of task.files) {
          lines.push('', `\`\`\`${file.path.split('.').pop() || 'txt'}  (${file.path})`, String(file.content ?? ''), '```');
        }
        if (passed) {
          const template = { kind: 'code', subject, description: task.challenge.description, files: [] };
          remember(looseKey(template), template, { files: task.files.map(file => ({ path: file.path, content: file.content })) }, 'crawl');
        }
        lines.push('');
        continue;
      }

      if ((task.questions ?? []).length) {
        const recorded = (task.chooseTestCases?.test_sets ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position));
        for (const question of task.questions) {
          stats.choice += 1;
          const answer = recorded.find(item => Number(item.position) === Number(question.position))?.actual_output;
          lines.push(`${question.position}. ${String(question.subject ?? '').replace(/\s+/g, ' ')}`);
          for (const option of question.options ?? []) lines.push(`   - ${option.key}. ${String(option.text).replace(/\s+/g, ' ')}`);
          lines.push(`   **${passed && answer ? '正确答案' : '原作答'}：${answer ?? '（无）'}**`, '');
          if (passed && answer) rememberQuestion(question, String(answer), 'crawl');
        }
        if (passed) {
          const answers = recorded.map(item => String(item.actual_output ?? '').trim()).filter(Boolean);
          if (answers.length === task.questions.length) {
            const template = { kind: 'choice', subject, description: task.challenge.description, questions: task.questions };
            remember(looseKey(template), template, { answers }, 'crawl');
          }
        }
        continue;
      }

      stats.terminal += 1;
      lines.push('（终端操作题，无题目数据）', '');
    }
    lines.push('');
  }
}

mkdirSync('data', { recursive: true });
const file = `data/${user.name ?? login}-全课程题目与答案.md`;
writeFileSync(file, lines.join('\n'), 'utf8');
const check = new DatabaseSync(config.dbFile);
console.log(`\n关卡 ${stats.levels}（已通过 ${stats.passed}），客观题 ${stats.choice} 道，代码题 ${stats.code} 关，终端题 ${stats.terminal} 关`);
console.log('题库总量：', check.prepare('SELECT COUNT(*) AS n FROM bank').get().n,
  '| 逐题条目：', check.prepare("SELECT COUNT(*) AS n FROM bank WHERE kind = 'question'").get().n);
check.close();
console.log('输出：', file);
