// 手工答案直通：把一份现成答案写进指定关卡，触发评测，轮询结果，通过就进题库。
// 用法：node scripts/write-answer.mjs <gameIdentifier> <homeworkId> <答案文件> [课程 identifier]
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { remember, subjectKey } from '../server/engine/solver/index.mjs';

const [gid, homeworkRaw, answerFile] = process.argv.slice(2);
if (!gid || !homeworkRaw || !answerFile) {
  console.error('用法：node scripts/write-answer.mjs <gameIdentifier> <homeworkId> <答案文件>');
  process.exit(2);
}
const homeworkId = Number(homeworkRaw);
const answer = readFileSync(answerFile, 'utf8');

const db = new DatabaseSync(config.dbFile);
const row = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
const session = JSON.parse(openSealed(row.upstream_cookie));
db.close();

const up = createEduCoderUpstream();
const task = await up.task(session, row.login, gid, homeworkId);
const file = task.files[0];
const original = file.content;
console.log(`关卡：${task.challenge.subject}  ${file.path}（原 ${file.content.length}B → 新 ${answer.length}B）`);
console.log(`评测前 evaluate_count=${task.game.evaluate_count} status=${task.game.status}`);

const saved = await up.saveFile(session, row.login, {
  myshixunIdentifier: task.myshixun.identifier,
  myshixunId: task.myshixun.id,
  gameId: task.game.id,
  gameUid: gid,
  path: file.path,
  content: answer,
  encoding: 'plain',
  homeworkId,
  challengeId: task.challenge.id,
  userId: session.uid,
  commitId: task.myshixun.commitId,
});
console.log('保存 ->', saved.commitID);

await up.build(session, row.login, {
  gameUid: gid,
  gameId: task.game.id,
  homeworkId,
  challengeId: task.challenge.id,
  shixunEnvironmentId: task.challenge.shixunEnvironmentId,
  commitId: saved.commitID,
});
console.log('已触发评测，等待结果…');

for (let i = 0; i < 40; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 2500));
  const verdict = await up.verdict(session, row.login, gid, homeworkId);
  console.log(`  第 ${i + 1} 次：status=${verdict.status} finished=${verdict.finished} 分数=${verdict.final_score} 评测次数=${verdict.evaluate_count}`);
  if (verdict.finished) {
    console.log('✅ 通过');
    // 用「提交前的模板」算键，和流水线的口径保持一致
    const template = {
      kind: 'code',
      subject: task.challenge.subject,
      description: task.challenge.description,
      files: [{ path: file.path, content: original }],
    };
    remember(subjectKey(template), template, { files: [{ path: file.path, content: answer }] }, 'manual');
    console.log('已写入题库');
    process.exit(0);
  }
  if (!verdict.running && verdict.evaluate_count > 0 && i > 0) {
    const after = await up.task(session, row.login, gid, homeworkId);
    for (const [index, test] of (after.testSets ?? []).entries()) {
      console.log(`  测试集 ${index + 1} 期望=${JSON.stringify(test.output)}`);
      console.log(`  测试集 ${index + 1} 实际=${JSON.stringify(test.actual_output)}`);
    }
    console.log('编译输出：', String(after.compileOutput ?? '').slice(0, 800));
    console.log('❌ 未通过');
    process.exit(1);
  }
}
console.log('评测没给结果，去网页看这一关。');
