// 调试 Jupyter 图文作业：列文件、看 notebook、提交作品
//
// 用法：node scripts/jupyter.mjs <登录名> <gid> <homework_id> [ls|cat <文件名>|solve|submit]
//   solve 默认会提交作品；加 --no-submit 只填代码不提交，加 --run 会先执行再提交
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { openJupyter } from '../server/jupyter/client.mjs';
import { solveJupyter } from '../server/jupyter/solve.mjs';

const [login, gameUid, homeworkRaw, action = 'ls', target] = process.argv.slice(2);
if (!login || !gameUid || !homeworkRaw) {
  console.log('用法：node scripts/jupyter.mjs <登录名> <gid> <homework_id> [ls|cat <文件名>|submit]');
  process.exit(1);
}
const homeworkId = Number(homeworkRaw);

const db = new DatabaseSync(config.dbFile);
const user = db.prepare('SELECT * FROM users WHERE login = ? OR name = ?').get(login, login);
if (!user) { console.log('找不到账号', login); process.exit(1); }
const session = JSON.parse(openSealed(user.upstream_cookie));
db.close();

console.log(`账号 ${user.name ?? user.login}  任务 ${gameUid}  作业 ${homeworkId}`);
const client = await openJupyter({ session, gameUid, homeworkId });
console.log('容器地址：', client.target.url.replace(/\/\/[^.]+\./, '//jupyter-ctn-….'), ' 剩余', Math.round((client.target.remainingTime ?? 0) / 60000), '分钟');

if (action === 'ls') {
  const items = await client.list();
  console.log('文件列表：');
  for (const item of items) console.log(`  ${item.type === 'directory' ? '📁' : '📄'} ${item.name}  (${item.path})`);
} else if (action === 'cat') {
  const notebook = await client.readNotebook(target ?? '');
  const cells = notebook?.cells ?? [];
  console.log(`cell 数量：${cells.length}`);
  for (const [index, cell] of cells.entries()) {
    const raw = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
    const head = raw.split('\n')[0].slice(0, 70);
    console.log(`  [${index}] ${cell.cell_type}  ${head}`);
  }
} else if (action === 'solve') {
  const result = await solveJupyter({ session, gameUid, homeworkId, run: process.argv.includes('--run'), submit: !process.argv.includes('--no-submit') });
  console.log('结果：', JSON.stringify(result).slice(0, 300));
} else if (action === 'submit') {
  const result = await client.submit();
  console.log('提交结果：', JSON.stringify(result).slice(0, 200));
}
