// 题库收割：把「已经全部完成」的账号里每一关的成品代码读出来，灌进题库。
//
// 用法：
//   node scripts/harvest.mjs                # 收割该账号所有课程
//   node scripts/harvest.mjs N6TCSXHG       # 只收某一门课
//
// 只能收「代码题」（有文件、status=2）——终端题的答案在容器状态里、客观题不知道选了哪项，都收不了。
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { remember, looseKey } from '../server/engine/solver/index.mjs';

const only = process.argv[2] ?? '';
const db = new DatabaseSync(config.dbFile);
const row = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
const session = JSON.parse(openSealed(row.upstream_cookie));
const before = db.prepare('SELECT COUNT(*) AS n FROM bank').get().n;
db.close();
console.log(`收割账号 ${row.login}，题库当前 ${before} 条`);

const up = createEduCoderUpstream();
const courses = await up.courses(session);
const picked = (only ? courses.filter(course => course.identifier === only) : courses).slice(0, 10);

let scanned = 0;
let saved = 0;
let skipped = 0;

for (const course of picked) {
  let homeworks = [];
  try {
    homeworks = await up.homeworks(session, row.login, course.identifier);
  } catch { continue; }
  console.log(`\n== ${course.name}（${homeworks.length} 份作业）`);

  for (const homework of homeworks) {
    if (!homework.shixunIdentifier) continue;
    let chain = [];
    try {
      const entry = await up.enter(session, row.login, course.identifier, homework.id);
      let cursor = entry.gameIdentifier;
      const seen = new Set();
      for (let i = 0; i < 30; i += 1) {
        const task = await up.task(session, row.login, cursor, homework.id);
        seen.add(String(cursor));
        if (!task.prevGame || seen.has(String(task.prevGame))) break;
        cursor = task.prevGame;
      }
      for (let i = 0; i < 30 && cursor; i += 1) {
        const task = await up.task(session, row.login, cursor, homework.id);
        chain.push(task);
        if (!task.nextGame) break;
        cursor = task.nextGame;
      }
    } catch { continue; }

    for (const task of chain) {
      scanned += 1;
      if (task.game.status !== 2) continue;                 // 没过的不收
      // 客观题：平台记录了上次提交的选项，已通过的说明那组答案是对的
      if (task.challenge.kind === 'choice') {
        const tests = task.chooseTestCases?.test_sets;
        if (!Array.isArray(tests) || !tests.length) continue;
        const answers = [...tests]
          .sort((a, b) => Number(a.position) - Number(b.position))
          .map(test => String(test.actual_output ?? '').trim())
          .filter(Boolean);
        if (answers.length !== (task.questions ?? []).length) continue;
        const template = {
          kind: 'choice',
          subject: task.challenge.subject,
          description: task.challenge.description,
          questions: task.questions,
        };
        remember(looseKey(template), template, { answers }, 'harvest');
        saved += 1;
        continue;
      }
      if (task.challenge.kind !== 'code') continue;
      if (!(task.files ?? []).length) continue;
      const files = task.files.map(file => ({ path: file.path, content: file.content }));
      const template = {
        kind: 'code',
        subject: task.challenge.subject,
        description: task.challenge.description,
        files: [],
      };
      remember(looseKey(template), template, { files }, 'harvest');
      saved += 1;
    }
  }
  console.log(`   已收 ${saved} 条，扫描 ${scanned} 关`);
}

const after = new DatabaseSync(config.dbFile);
console.log(`\n扫描 ${scanned} 关，入库 ${saved} 条，题库 ${before} → ${after.prepare('SELECT COUNT(*) AS n FROM bank').get().n} 条`);
after.close();
