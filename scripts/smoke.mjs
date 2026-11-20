// 端到端冒烟测试：登录 → 课程 → 建任务 → 轮询到完成 → 管理后台读数。
// 用法：node scripts/smoke.mjs [baseUrl]
const base = process.argv[2] ?? 'http://127.0.0.1:8080';

let cookie = '';

async function call(path, { method = 'GET', body, as } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const jar = as ?? cookie;
  if (jar) headers.Cookie = jar;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const next = setCookie.map(line => line.split(';')[0]).join('; ');
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, cookie: next || jar };
}

const log = (...args) => console.log(...args);
const fail = (message) => { console.error('FAIL', message); process.exitCode = 1; };

// 0. 配置
const config = await call('/api/auth/config');
log('config ->', config.payload.data);

// 1. 普通用户登录
const login = await call('/api/auth/login', {
  method: 'POST',
  body: { login: 'demo_student@example.com', password: 'demo-pass-123' },
});
if (login.status !== 200) fail(`登录失败 ${login.status} ${JSON.stringify(login.payload)}`);
cookie = login.cookie;
log('login ->', login.payload.data?.name, 'role=' + login.payload.data?.role);

// 2. 课程
const courses = await call('/api/courses');
const list = courses.payload.data?.courses ?? [];
log('courses ->', list.map(course => course.name).join(' / '));
if (!list.length) fail('没有课程');

// 3. 作业与考试
const first = list[0];
const homeworks = await call(`/api/courses/${encodeURIComponent(first.identifier)}/homeworks`);
log('homeworks ->', (homeworks.payload.data?.homeworks ?? []).map(item => `${item.name}(${item.finishedRequiredChallengeCount}/${item.requiredChallengeCount})`).join(' / '));
const exercises = await call(`/api/courses/${encodeURIComponent(first.identifier)}/exercises`);
log('exercises ->', (exercises.payload.data?.items ?? []).map(item => `${item.name}${item.available ? '' : '(不可安排)'}`).join(' / '));

// 4. 一键完成
const created = await call('/api/jobs', { method: 'POST', body: { scope: 'all', mode: 'submit', idempotency_key: crypto.randomUUID() } });
if (created.status !== 200) fail(`建任务失败 ${created.status} ${JSON.stringify(created.payload)}`);
const jobId = created.payload.data?.id;
log('job ->', jobId, created.payload.data?.status);

// 5. 幂等
const again = await call('/api/jobs', { method: 'POST', body: { scope: 'all', mode: 'submit', idempotency_key: crypto.randomUUID() } });
log('duplicate guard ->', again.payload.data?.id === jobId ? 'same job returned' : `new job ${again.payload.data?.id}`);

// 6. 轮询
let job = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const res = await call('/api/jobs');
  job = (res.payload.data?.jobs ?? []).find(item => item.id === jobId);
  if (!job) break;
  log(`  [${job.status}/${job.phase}]`, JSON.stringify(job.progress ?? {}));
  if (!['queued', 'running'].includes(job.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1200));
}

log('final ->', job?.status, 'service_status=' + (job?.result?.service_status ?? '-'));
for (const row of job?.result?.homeworks ?? []) {
  log('  ·', row.title, '=>', row.status, row.levels?.length ? `(${row.levels.filter(l => l.status === 'passed' || l.status === 'skipped').length}/${row.levels.length} 关)` : '');
}
if (job?.status !== 'succeeded') fail(`任务未成功：${job?.error_code ?? ''} ${job?.error_message ?? ''}`);

// 7. 题库
const bank = await call('/api/jobs', { method: 'POST', body: { scope: 'all', mode: 'collect_verified', idempotency_key: crypto.randomUUID() } });
log('collect job ->', bank.payload.data?.id ?? bank.payload.error?.code);

// 8. 考试安排
const exam = (exercises.payload.data?.items ?? []).find(item => item.available && !item.submitted);
if (exam) {
  const job = await call('/api/jobs', {
    method: 'POST',
    body: { scope: 'exercise', course: first.identifier, exercise_id: exam.id, mode: 'submit', idempotency_key: crypto.randomUUID() },
  });
  log('exam job ->', job.payload.data?.status ?? job.payload.error?.code);
}

// 9. 管理后台
const adminLogin = await call('/api/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin12345' } });
if (adminLogin.status !== 200) fail(`管理员登录失败 ${adminLogin.status}`);
const adminCookie = adminLogin.cookie;
const overview = await call('/api/admin/overview', { as: adminCookie });
log('admin overview ->', JSON.stringify(overview.payload.data));
const card = await call('/api/admin/cards', { method: 'POST', body: { label: '冒烟测试', reusable: false }, as: adminCookie });
log('admin card ->', card.payload.data?.access_code);
const audit = await call('/api/admin/audit', { as: adminCookie });
log('audit ->', (audit.payload.data?.audit ?? []).slice(0, 5).map(item => item.action).join(', '));

// 10. 未授权
const anonymous = await call('/api/jobs', { as: 'none' });
log('anonymous /api/jobs ->', anonymous.status, anonymous.payload.error?.code);
if (anonymous.status !== 401) fail('未登录应当 401');

console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
