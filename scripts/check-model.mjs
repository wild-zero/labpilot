// 检查模型配置是否可用：先验密钥，再拿一道真实题目试一次求解（只读，不提交）。
//
// 用法：
//   node scripts/check-model.mjs            # 用 .env 里的配置
//   node scripts/check-model.mjs 操作系统    # 顺便用该课程的第一道未完成题试解
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { solver } from '../server/engine/solver/index.mjs';

const mask = (value) => {
  if (!value) return '(空)';
  const text = String(value);
  return text.length <= 10 ? `${text.slice(0, 2)}***` : `${text.slice(0, 6)}…${text.slice(-4)}`;
};

// 让 undici 的连接收尾再退出，避免 Windows 上 libuv 断言噪音
const die = async (code = 1) => { await new Promise(r => setTimeout(r, 80)); process.exit(code); };

console.log('provider :', config.solver.provider);
console.log('base_url :', config.solver.baseUrl);
console.log('model    :', config.solver.model);
console.log('api_key  :', mask(config.solver.apiKey));
console.log('upstream :', config.upstream);
console.log('');

if (config.solver.provider !== 'openai') {
  console.log('当前 SOLVER 不是 openai，把 .env 里的 SOLVER 改成 openai 再跑。');
}

// 1. 先用一句最小请求验密钥/地址/模型名
console.log('—— 第 1 步：连通性与鉴权 ——');
if (!config.solver.apiKey) {
  console.log('✗ OPENAI_API_KEY 是空的。');
  await die(1);
}
try {
  const response = await fetch(`${config.solver.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.solver.apiKey}` },
    body: JSON.stringify({
      model: config.solver.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.log(`✗ HTTP ${response.status}  ${text.slice(0, 300)}`);
    if (response.status === 401 || response.status === 403) console.log('  → Key 无效或没权限。');
    if (response.status === 404) console.log('  → 地址或模型名不对：BASE_URL 一般要以 /v1 结尾，MODEL 要在该平台存在。');
    if (response.status === 429) console.log('  → 限流或余额不足。');
    await die(1);
  }
  const body = JSON.parse(text);
  console.log('✓ 鉴权通过，模型回复：', JSON.stringify(body?.choices?.[0]?.message?.content ?? '').slice(0, 80));
} catch (error) {
  const cause = error.cause?.code ?? error.cause?.message ?? '';
  console.log('✗ 连不上：', error.message, cause ? `（${cause}）` : '');
  console.log('  → 常见原因：BASE_URL 写错、没有代理却填了 api.openai.com、或本地网络不通。');
  await die(1);
}

// 2. 拿真题目试解一次
const nameFilter = process.argv[2] ?? '';
const db = new DatabaseSync(config.dbFile);
const row = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
if (!row) {
  console.log('\n（库里还没有登录过的头歌账号，跳过真实题目试解）');
  await die(0);
}
const session = JSON.parse(openSealed(row.upstream_cookie));
db.close();

console.log('\n—— 第 2 步：拿真实题目试解（只读，不提交）——');
const up = createEduCoderUpstream();
const courses = await up.courses(session);
const course = (nameFilter && courses.find(item => String(item.name).includes(nameFilter))) || courses[0];
const homeworks = await up.homeworks(session, row.login, course.identifier);
const live = homeworks.filter(homework => !homework.expired && homework.shixunIdentifier);
const homework = live.find(item => !item.requiredProgressKnown || (item.requiredChallengeCount ?? 0) > (item.finishedRequiredChallengeCount ?? 0));
if (!homework) {
  console.log('没有未截止且未完成的作业，跳过。');
  await die(0);
}
const entry = await up.enter(session, row.login, course.identifier, homework.id);
let cursor = entry.gameIdentifier;
const seen = new Set();
for (let guard = 0; guard < 50; guard += 1) {
  const task = await up.task(session, cursor, homework.id);
  seen.add(String(cursor));
  if (!task.prevGame || seen.has(String(task.prevGame))) break;
  cursor = task.prevGame;
}
let target = null;
for (let guard = 0; cursor && guard < 50; guard += 1) {
  const task = await up.task(session, cursor, homework.id);
  if (task.game.status !== 2) { target = task; break; }
  if (!task.nextGame) break;
  cursor = task.nextGame;
}
if (!target) {
  console.log('这门课没有待完成的关卡，跳过。');
  await die(0);
}

console.log(`题目：${course.name} / ${homework.name} / 第 ${target.challenge.position ?? '?'} 关「${target.challenge.subject}」`);
const started = Date.now();
try {
  const answer = await solver().solve({
    kind: target.challenge.kind,
    subject: target.challenge.subject,
    description: target.challenge.description,
    files: target.files,
    options: target.challenge.options,
    optionCount: 1,
  });
  console.log(`✓ 求解成功（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  if (target.challenge.kind === 'choice') {
    console.log('  答案：', JSON.stringify(answer.answers));
  } else {
    for (const file of answer.files ?? []) {
      console.log(`  --- ${file.path} ---`);
      console.log(file.content.split('\n').slice(0, 20).map(line => '  ' + line).join('\n'));
      if (file.content.split('\n').length > 20) console.log('  …');
    }
  }
  console.log('\n模型可用。下一步：node scripts/try-one.mjs <课程名> 看完整干跑，确认后加 --yes 真交一关。');
} catch (error) {
  console.log(`✗ 求解失败：${error.code ?? ''} ${error.message}`);
  await die(1);
}
