// Jupyter（图文作业）客户端：启动容器 → 读写 notebook → 提交作品
import { createHash } from 'node:crypto';
import { config } from '../config.mjs';

function sign(method, time) {
  const raw = `method=${method}&ak=${config.educoder.ak}&sk=${config.educoder.sk}&time=${time}`;
  return createHash('md5').update(Buffer.from(raw, 'utf8').toString('base64')).digest('hex');
}

function headers(session, method = 'GET') {
  const ts = Date.now();
  return {
    Accept: 'application/json',
    'X-EDU-Type': 'pc',
    'X-EDU-Timestamp': String(ts),
    'X-EDU-Signature': sign(method, ts),
    'Pc-Authorization': session.cookie,
    Cookie: `autologin_trustie=${session.trustie ?? ''}; _educoder_session=${session.cookie}`,
  };
}

async function api(session, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.educoder.base.replace(/\/$/, '')}${path}`, {
    method,
    headers: { ...headers(session, method), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!response.ok || (json && typeof json.status === 'number' && json.status < 0)) {
    const message = json?.message ?? text.slice(0, 200);
    throw Object.assign(new Error(`头歌接口失败：${message}`), { code: 'JUPYTER_UPSTREAM' });
  }
  return json;
}

/** 启动（或取回）Jupyter 容器，返回访问地址和 token */
export async function startJupyter({ session, gameUid, homeworkId }) {
  // start.json 要的是「学生的 myshixun 标识」，而作业页给的多半是 shixun 标识，
  // 先用 jupyter.json 把 myshixun_identifier 换出来
  let myshixun = gameUid;
  const info = await api(session, `/tasks/${encodeURIComponent(gameUid)}/jupyter.json?identifier=${encodeURIComponent(gameUid)}&homework_id=${homeworkId}&zzud=${session.zzud ?? ''}`).catch(() => null);
  if (info?.myshixun_identifier) myshixun = String(info.myshixun_identifier);

  const started = await api(session, `/myshixuns/${encodeURIComponent(myshixun)}/start.json?identifier=${encodeURIComponent(myshixun)}&homework_common_id=${homeworkId}&zzud=${session.zzud ?? ''}`);
  const requestId = started?.data?.requestId;
  if (!requestId) throw Object.assign(new Error('启动容器没有返回 requestId'), { code: 'JUPYTER_NOT_READY' });

  for (let i = 0; i < 20; i += 1) {
    const record = await api(session, `/myshixuns/wuying_record.json?requestId=${encodeURIComponent(requestId)}&zzud=${session.zzud ?? ''}`);
    const info = record?.data?.data;
    if (info?.url) {
      return { url: info.url.replace(/\?.*$/, ''), token: info.password ?? '', containerId: info.containerId, remainingTime: info.remainingTime };
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw Object.assign(new Error('容器启动超时（拿不到 Jupyter 地址）'), { code: 'JUPYTER_NOT_READY' });
}

/** 用 token 调 Jupyter 的 REST 接口 */
async function jupyterRequest(target, path, options = {}) {
  const url = `${target.url}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(target.token)}`;
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `token ${target.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) throw Object.assign(new Error(`Jupyter ${path} 失败：HTTP ${response.status} ${text.slice(0, 120)}`), { code: 'JUPYTER_HTTP' });
  try { return JSON.parse(text); } catch { return text; }
}

export async function openJupyter({ session, gameUid, homeworkId }) {
  const target = await startJupyter({ session, gameUid, homeworkId });

  return {
    target,
    async list(dir = '') {
      const items = await jupyterRequest(target, `/api/contents/${encodeURIComponent(dir)}`);
      return (items?.content ?? []).map(item => ({ name: item.name, path: item.path, type: item.type }));
    },
    async readNotebook(path) {
      const file = await jupyterRequest(target, `/api/contents/${encodeURIComponent(path)}`);
      return file?.content ?? null;
    },
    async writeNotebook(path, notebook) {
      return jupyterRequest(target, `/api/contents/${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: { type: 'notebook', format: 'json', content: notebook },
      });
    },
    /** 提交作品：告诉平台「我做完了，来判」 */
    async submit() {
      return api(session, `/homework_commons/${homeworkId}/student_works.json?zzud=${session.zzud ?? ''}`, {
        method: 'POST',
        body: { myshixun_identifier: gameUid },
      });
    },
  };
}

/** 创建（或复用）一个 Python kernel */
export async function startKernel(target) {
  const response = await fetch(`${target.url}/api/kernels?token=${encodeURIComponent(target.token)}`, {
    method: 'POST',
    headers: { Authorization: `token ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'python3' }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) throw Object.assign(new Error(`创建 kernel 失败：HTTP ${response.status} ${text.slice(0, 120)}`), { code: 'JUPYTER_KERNEL' });
  const json = JSON.parse(text);
  return { id: json.id, name: json.name ?? 'python3' };
}

/** 在 kernel 里执行一段代码，返回输出和是否成功 */
export async function executeCode(target, kernelId, code, { timeoutMs = 120_000 } = {}) {
  const { connect } = await import('../terminal/ws.mjs');
  const wsUrl = target.url.replace(/^https:/, 'wss:') + `/api/kernels/${kernelId}/channels?token=${encodeURIComponent(target.token)}`;
  const socket = await connect(wsUrl, { headers: { Authorization: `token ${target.token}` }, timeoutMs: 20_000 });
  // 等握手完成再发消息（connect 返回时握手可能还没结束）
  await new Promise((resolve) => {
    let opened = false;
    socket.onOpen(() => { opened = true; resolve(); });
    setTimeout(() => { if (!opened) resolve(); }, 8000);
  });

  const outputs = [];
  let done = false;
  let failed = false;
  const finished = new Promise((resolve) => {
    socket.onMessage((raw) => {
      let message = null;
      try { message = JSON.parse(raw); } catch { return; }
      const type = message?.header?.msg_type;
      if (type === 'stream') outputs.push(String(message.content?.text ?? ''));
      if (type === 'error') { failed = true; outputs.push(`ERROR: ${message.content?.evalue ?? ''}`); }
      if (type === 'execute_reply') {
        if (message.content?.status === 'error') failed = true;
        done = true;
        resolve();
      }
    });
    socket.onClose(() => { if (!done) resolve(); });
  });

  socket.send(JSON.stringify({
    header: { msg_id: `exec-${Date.now()}`, username: 'tg', session: `tg-${Date.now()}`, msg_type: 'execute_request', version: '5.3' },
    parent_header: {}, metadata: {}, content: { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false },
    channel: 'shell',
  }));

  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
  socket.close();
  return { ok: !failed, output: outputs.join('').slice(0, 2000) };
}
