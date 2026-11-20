// 清理 mock 时期留下的用户与任务（保留管理员）。库已有备份。
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2] ?? 'data/labpilot.sqlite');
db.exec('PRAGMA foreign_keys = ON;');

const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const removed = db.prepare("DELETE FROM users WHERE role != 'admin'").run().changes;
db.exec('DELETE FROM jobs WHERE owner_id NOT IN (SELECT id FROM users);');
db.exec('DELETE FROM sessions;');
db.exec('DELETE FROM bank;');
db.exec('VACUUM;');

console.log(`users: ${before} -> ${db.prepare('SELECT COUNT(*) AS n FROM users').get().n}（移除 ${removed}）`);
for (const row of db.prepare('SELECT login, role, status FROM users').all()) {
  console.log(`  kept: ${row.login} (${row.role}, ${row.status})`);
}
console.log('jobs left:', db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n);
console.log('bank left:', db.prepare('SELECT COUNT(*) AS n FROM bank').get().n);
db.close();
