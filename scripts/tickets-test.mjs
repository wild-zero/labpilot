// 工单 + 任务 retry/recover 的端到端契约测试（不需要真实上游）
//   node scripts/tickets-test.mjs
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.mjs';
import { signSession } from '../server/crypto.mjs';

const base = 'http://127.0.0.1:8080';

const db = new DatabaseSync(config.dbFile);
const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
const user = db.prepare("SELECT * FROM users WHERE role = 'user' AND status = 'active' LIMIT 1").get();
if (!admin || !user) { console.error('缺少测试账号'); process.exit(1); }

function sessionCookie(row) {
  const id = randomUUID();
  const expiresAt = Date.now() + 3600_000;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, row.id, new Date().toISOString(), expiresAt, '127.0.0.1', 'tickets-test');
  return `lp_session=${signSession(id, expiresAt)}`;
}

const asUser = sessionCookie(user);
const asAdmin = sessionCookie(admin);
db.close();

const call = async (cookie, path, { method = 'GET', body } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ' → ' + detail}`);
  if (!ok) failures += 1;
};

console.log(`测试账号：用户 ${user.login} / 管理员 ${admin.login}\n`);

const runKey = `test-${Date.now()}`;
const created = await call(asUser, '/api/tickets', {
  method: 'POST',
  body: { subject: '作业一直失败', category: 'task', body: '大数据开发技术Ⅰ的 HDFS 作业一直转人工，麻烦看一下。', idempotency_key: runKey },
});
check('创建工单 200', created.status === 200, JSON.stringify(created.body).slice(0, 200));
const ticketId = created.body?.data?.ticket?.id;
check('返回工单 id 与首条消息', Boolean(ticketId) && created.body?.data?.messages?.length === 1);
check('初始状态 open', created.body?.data?.ticket?.status === 'open');

const dup = await call(asUser, '/api/tickets', {
  method: 'POST',
  body: { subject: '作业一直失败', category: 'task', body: '重复提交应命中幂等', idempotency_key: runKey },
});
check('幂等键复用同一条工单', dup.body?.data?.ticket?.id === ticketId, JSON.stringify(dup.body).slice(0, 120));

const listUser = await call(asUser, '/api/tickets');
check('用户列表能看到自己的工单', (listUser.body?.data?.items ?? []).some(item => item.id === ticketId));
check('用户列表不含他人姓名', (listUser.body?.data?.items ?? []).every(item => !item.user));

const listAdmin = await call(asAdmin, '/api/admin/tickets');
const adminRow = (listAdmin.body?.data?.items ?? []).find(item => item.id === ticketId);
check('管理端列表能按用户维度看到工单', Boolean(adminRow) && Boolean(adminRow.user?.login), JSON.stringify(adminRow ?? {}).slice(0, 160));

const reply = await call(asAdmin, `/api/admin/tickets/${ticketId}/messages`, { method: 'POST', body: { body: '已经定位到 HDFS 环境没起来，正在补配方。' } });
check('管理端回复 200', reply.status === 200, JSON.stringify(reply.body).slice(0, 160));
check('回复后状态变 processing', reply.body?.data?.ticket?.status === 'processing', reply.body?.data?.ticket?.status);
check('消息数 2 条', (reply.body?.data?.messages ?? []).length === 2);

const userReply = await call(asUser, `/api/tickets/${ticketId}/messages`, { method: 'POST', body: { body: '好的，等你们消息。' } });
check('用户补充后回到 open', userReply.body?.data?.ticket?.status === 'open', userReply.body?.data?.ticket?.status);

const resolve = await call(asAdmin, `/api/admin/tickets/${ticketId}/status`, { method: 'POST', body: { status: 'resolved' } });
check('管理端标记已解决', resolve.body?.data?.ticket?.status === 'resolved');

const closed = await call(asUser, `/api/tickets/${ticketId}/status`, { method: 'POST', body: { status: 'closed' } });
check('用户关闭工单', closed.body?.data?.ticket?.status === 'closed');

const blocked = await call(asUser, `/api/tickets/${ticketId}/messages`, { method: 'POST', body: { body: '关闭后不应该还能补充' } });
check('关闭后拒绝补充', blocked.status !== 200, JSON.stringify(blocked.body).slice(0, 120));

const forbidden = await call(asUser, `/api/admin/tickets/${ticketId}/status`, { method: 'POST', body: { status: 'resolved' } });
check('普通用户调管理端接口被拒', forbidden.status === 401 || forbidden.status === 403, String(forbidden.status));

const unauth = await fetch(`${base}/api/tickets`);
check('未登录访问 401', unauth.status === 401, String(unauth.status));

// 任务 retry/recover 的字段与拒绝逻辑
const jobsList = await call(asUser, '/api/jobs');
const sample = (jobsList.body?.data?.jobs ?? [])[0];
check('任务列表带 can_retry/can_recover', sample ? typeof sample.can_retry === 'boolean' && typeof sample.can_recover === 'boolean' : true, JSON.stringify(sample ?? {}).slice(0, 120));

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
