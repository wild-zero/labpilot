// 用 Edge/Chrome 的 CDP 做 UI 走查：登录 → 课程 → 安排任务 → 进度 → 管理后台，逐页截图。
// 用法：node scripts/inspect-ui.mjs [baseUrl] [outDir]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080';
const OUT = resolve(process.argv[3] ?? 'shots');
const PORT = 9333;
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const bin = CANDIDATES.find(existsSync);
if (!bin) {
  console.error('找不到 Edge/Chrome，跳过 UI 走查');
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });

const profile = resolve('.tmp-profile');
const child = spawn(bin, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('CDP 未就绪');
}

await wsUrl();
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pageTarget = targets.find(t => t.type === 'page')
  ?? await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json();

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });

let seq = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve: ok, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else ok(message.result);
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((ok, reject) => {
    pending.set(id, { resolve: ok, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result?.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('saved', file);
}

async function waitFor(selector, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found) return true;
    await sleep(200);
  }
  throw new Error(`等待元素超时: ${selector}`);
}

async function waitJobSettled(timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pendingCount = await evaluate(`document.querySelectorAll('.service-job .badge.processing, .service-job .badge.waiting').length`);
    if (!pendingCount) return true;
    await sleep(600);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await shot('01-login');

// 登录（mock 上游接受任意 ≥4 位密码）
await evaluate(`(() => {
  const form = document.querySelector('#login-form');
  form.login.value = 'demo_student@example.com';
  form.password.value = 'demo-pass-123';
  form.requestSubmit();
  return true;
})()`);
await waitFor('[data-action="start-all"]');
await sleep(900);
await shot('02-courses');

// 安排一键完成
await evaluate(`document.querySelector('[data-action="start-all"]').click()`);
await waitFor('[data-action="modal-confirm"]');
await shot('03-confirm');
await evaluate(`document.querySelector('[data-action="modal-confirm"]').click()`);
await sleep(2000);
await shot('04-progress');
await waitJobSettled();
await sleep(1200);
await shot('04b-progress-done');

// 任务详情
await evaluate(`(() => { const b = document.querySelector('[data-job-detail]'); if (b) b.click(); return Boolean(b); })()`);
await sleep(700);
await shot('05-job-detail');
await evaluate(`(() => { const b = document.querySelector('[data-action="close-modal"]'); if (b) b.click(); return true; })()`);
await sleep(300);

// 课程详情（实验 / 考试）
await evaluate(`document.querySelector('[data-nav="courses"]').click()`);
await sleep(700);
await evaluate(`(() => { const b = document.querySelector('[data-course-detail]'); if (b) b.click(); return Boolean(b); })()`);
await sleep(1400);
await shot('06-course-detail');
await evaluate(`(() => { const b = document.querySelector('[data-detail-tab="exercise"]'); if (b) b.click(); return true; })()`);
await sleep(1400);
await shot('07-exams');
await evaluate(`(() => { const b = document.querySelector('[data-action="close-modal"]'); if (b) b.click(); return true; })()`);
await sleep(300);

// 管理后台
await evaluate(`document.querySelector('[data-action="logout"]').click()`);
await sleep(1500);
await evaluate(`(() => {
  const form = document.querySelector('#login-form');
  form.login.value = 'admin';
  form.password.value = 'admin12345';
  form.requestSubmit();
  return true;
})()`);
await sleep(2200);
await evaluate(`document.querySelector('[data-nav="admin-overview"]').click()`);
await sleep(1800);
await shot('08-admin-overview');
await evaluate(`document.querySelector('[data-nav="admin-operations"]').click()`);
await sleep(1800);
await shot('09-admin-operations');
await evaluate(`document.querySelector('[data-nav="admin-users"]').click()`);
await sleep(1200);
await shot('10-admin-users');
await evaluate(`document.querySelector('[data-nav="admin-cards"]').click()`);
await sleep(1200);
await shot('11-admin-cards');
await evaluate(`document.querySelector('[data-nav="admin-audit"]').click()`);
await sleep(1200);
await shot('12-admin-audit');

socket.close();
child.kill();
process.exit(0);
