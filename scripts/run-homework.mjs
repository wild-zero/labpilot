// 用真实任务流水线跑一份作业：建任务 → 轮询 → 打印每关结果。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.mjs';
import { signSession } from '../server/crypto.mjs';

const base = 'http://127.0.0.1:8080';
const COURSE = process.argv[2] ?? 'N6TCSXHG';
const HOMEWORK = Number(process.argv[3] ?? 4219193);

const db = new DatabaseSync(config.dbFile);
const user = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
const id = randomUUID();
const expiresAt = Date.now() + 3600_000;
db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
  .run(id, user.id, new Date().toISOString(), expiresAt, '127.0.0.1', 'runner');
db.close();
const cookie = `lp_session=${signSession(id, expiresAt)}`;

const call = async (path, options = {}) => {
  const response = await fetch(base + path, {
    ...options,
    headers: { Cookie: cookie, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const created = await call('/api/jobs', {
  method: 'POST',
  body: JSON.stringify({ scope: 'homework', course: COURSE, homework_id: HOMEWORK, mode: 'submit', idempotency_key: randomUUID() }),
});
if (created.status !== 200) {
  console.log('建任务失败：', created.status, JSON.stringify(created.body));
  process.exit(1);
}
const jobId = created.body.data.id;
console.log(`任务 ${jobId} 已创建`);

let last = '';
const deadline = Date.now() + 15 * 60_000;
let job = null;
while (Date.now() < deadline) {
  const res = await call('/api/jobs');
  job = (res.body.data?.jobs ?? []).find(item => item.id === jobId);
  if (!job) break;
  const line = `${job.status}/${job.phase} ${JSON.stringify(job.progress ?? {})}`;
  if (line !== last) { console.log('  ' + line); last = line; }
  if (!['queued', 'running'].includes(job.status)) break;
  await new Promise(r => setTimeout(r, 3000));
}

console.log(`\n最终：${job?.status}  phase=${job?.phase}`);
if (job?.error_code) console.log(`原因：${job.error_code} ${job.error_message ?? ''}`);
for (const row of job?.result?.homeworks ?? []) {
  const levels = row.levels ?? [];
  const passed = levels.filter(level => level.status === 'passed' || level.status === 'skipped').length;
  console.log(`  · ${row.title} => ${row.status}${levels.length ? ` (${passed}/${levels.length} 关)` : ''}`);
  for (const level of levels) {
    console.log(`      - ${level.title}  ${level.status}${level.source ? ' [' + level.source + ']' : ''}${level.attempts ? ' 试' + level.attempts + '次' : ''}`);
  }
}
