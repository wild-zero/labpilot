// 用 Edge headless + CDP 截图验证新页面（工单相关），启动方式与 inspect-ui.mjs 保持一致
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { signSession } from '../server/crypto.mjs';

const BASE = 'http://127.0.0.1:8080';
const PORT = 9334;
const OUT = 'shots';
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const bin = CANDIDATES.find(existsSync);
if (!bin) { console.log('没有浏览器，跳过'); process.exit(0); }
mkdirSync(OUT, { recursive: true });

const child = spawn(bin, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve('.tmp-profile-support')}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let socket;
let seq = 0;
const pending = new Map();

async function boot() {
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page') ?? await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { ok, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(JSON.stringify(message.error)));
      else ok(message.result);
    }
  };
}

const send = (method, params = {}) => new Promise((ok, fail) => {
  const id = ++seq;
  pending.set(id, { ok, fail });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value;
};

async function waitFor(selector, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (hit) return true;
    await sleep(250);
  }
  return false;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('saved', `${OUT}/${name}.png`);
}

try {
  await boot();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1425, height: 936, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1500);
  const login = await evaluate(`(async () => {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'admin12345' }) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, role: body?.data?.user?.role ?? null };
  })()`);
  console.log('登录：', JSON.stringify(login));

  await send('Page.navigate', { url: `${BASE}/?v=0.2.0` });
  await sleep(1800);
  await shot('70-admin-shell');

  await waitFor('[data-nav="admin-overview"]');
  const toAdmin = await evaluate(`(() => { const b = document.querySelector('[data-nav="admin-overview"]'); if (!b) return 'no-nav'; b.click(); return 'clicked'; })()`);
  console.log('进入管理后台：', toAdmin);
  await sleep(900);
  await waitFor('[data-nav="admin-support"]');
  await shot('70b-admin-overview');

  const clicked = await evaluate(`(() => { const b = document.querySelector('[data-nav="admin-support"]'); if (!b) return 'no-nav'; b.click(); return 'clicked'; })()`);
  console.log('进入反馈工单：', clicked);
  await waitFor('.support-workspace');
  await sleep(600);
  await shot('71-admin-support');
  console.log('列表状态：', JSON.stringify(await evaluate(`(() => ({
    heading: document.querySelector('.support-workspace h1')?.textContent?.trim() ?? null,
    rows: document.querySelectorAll('.support-table tbody tr').length,
    empty: document.querySelector('.support-empty')?.textContent?.trim() ?? null,
  }))()`)));

  const opened = await evaluate(`(() => { const b = document.querySelector('[data-support-open]'); if (!b) return 'no-ticket'; b.click(); return 'opened'; })()`);
  console.log('打开工单：', opened);
  await waitFor('.support-detail');
  await sleep(600);
  await shot('72-admin-ticket-detail');
  console.log('详情状态：', JSON.stringify(await evaluate(`(() => ({
    modal: Boolean(document.querySelector('.support-detail')),
    messages: document.querySelectorAll('.support-bubble').length,
    reply: Boolean(document.querySelector('#support-reply-form')),
  }))()`)));

  await evaluate(`(async () => { await fetch('/api/auth/logout', { method: 'POST' }); return true; })()`);
  await sleep(400);

  // 用真实用户（有头歌会话的账号）签一个本地会话，验证用户端「问题反馈」页
  const db = new DatabaseSync(config.dbFile);
  const account = db.prepare("SELECT * FROM users WHERE role = 'user' AND upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1").get();
  const sid = randomUUID();
  const expiresAt = Date.now() + 3600_000;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid, account.id, new Date().toISOString(), expiresAt, '127.0.0.1', 'shot-script');
  db.close();
  const signed = signSession(sid, expiresAt);
  await send('Network.enable');
  await send('Network.setCookie', { name: 'lp_session', value: signed, domain: '127.0.0.1', path: '/', httpOnly: true });
  console.log('用户会话：', account.login);

  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1800);
  await shot('73-user-courses');
  await waitFor('[data-nav="support"]');
  const toSupport = await evaluate(`(() => { const b = document.querySelector('[data-nav="support"]'); if (!b) return 'no-nav'; b.click(); return 'clicked'; })()`);
  console.log('用户端进入问题反馈：', toSupport);
  await waitFor('.support-workspace');
  await sleep(600);
  await shot('74-user-support');
  console.log('用户端状态：', JSON.stringify(await evaluate(`(() => ({
    heading: document.querySelector('.support-workspace h1')?.textContent?.trim() ?? null,
    hasForm: Boolean(document.querySelector('#support-create-form')),
    rows: document.querySelectorAll('.support-table tbody tr').length,
  }))()`)));
} catch (error) {
  console.error('FAIL', error.message);
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  process.exit(0);
}


