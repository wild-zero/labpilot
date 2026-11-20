// 终端会话：给流水线用的封装（启动容器 → 连 WS → 跑命令 → 触发评测）。
import { createHash } from 'node:crypto';
import { config } from '../config.mjs';
import { errors } from '../http.mjs';
import { connect as wsConnect } from './ws.mjs';

const md5hex = (buf) => createHash('md5').update(buf).digest('hex');

function makeClient(session) {
  const base = config.educoder.base.replace(/\/$/, '');
  const headers = (method = 'GET') => {
    const ts = Date.now();
    const raw = `method=${method}&ak=${config.educoder.ak}&sk=${config.educoder.sk}&time=${ts}`;
    return {
      Accept: 'application/json',
      'X-EDU-Type': 'pc',
      'X-EDU-Timestamp': String(ts),
      'X-EDU-Signature': md5hex(Buffer.from(raw, 'utf8').toString('base64')),
      'Pc-Authorization': session.cookie,
      Cookie: `autologin_trustie=${session.trustie ?? ''}; _educoder_session=${session.cookie}`,
    };
  };
  return async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers(method), ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
}

const clean = (text) => String(text)
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\r/g, '');

/**
 * 打开一个终端会话。
 * @returns {Promise<{ run:(command:string, waitMs?:number)=>Promise<string>, close:()=>void, info:object }>}
 */
export async function openTerminal({ session, gameUid, homeworkId }) {
  const api = makeClient(session);
  const zzud = session.zzud ?? '';

  const taskJson = await api(`/tasks/${encodeURIComponent(gameUid)}.json?homework_common_id=${homeworkId}&zzud=${zzud}`);
  const task = taskJson.challenge ? taskJson : taskJson.data;
  if (!task?.challenge) throw errors.upstream('终端题读取关卡失败', 'UPSTREAM_TASK_EMPTY');

  const myshixun = task.myshixun?.identifier ?? '';
  const envId = task.code_editor?.shixun_environment_id ?? task.shixun_environments?.[0]?.shixun_environment_id;
  const started = await api(`/myshixuns/${encodeURIComponent(myshixun)}/start.json?shixun_environment_id=${envId}&tab_type=4&game_id=${task.game?.id}&homework_common_id=${homeworkId}&zzud=${zzud}`);
  const info = started.data ?? started;
  if (!info?.host || !info?.port) throw errors.upstream('容器没有启动成功，稍后重试', 'TERMINAL_NOT_READY');

  const wsUrl = info.link_url ?? 'wss://webssh.educoder.net/ws';
  const ws = await wsConnect(wsUrl, {
    headers: {
      Origin: 'https://www.educoder.net',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Cookie: `autologin_trustie=${session.trustie ?? ''}; _educoder_session=${session.cookie}`,
    },
  });

  const chunks = [];
  let ready = false;
  ws.onMessage((data) => {
    let text = data;
    if (!data.trim().startsWith('{')) {
      try { text = Buffer.from(data, 'base64').toString('utf8'); } catch { /* keep */ }
    }
    chunks.push(text);
    if (!ready && clean(chunks.join('')).includes('#')) ready = true;
  });

  ws.onOpen(() => {
    ws.send(JSON.stringify({
      tp: 'init',
      data: {
        host: info.host,
        port: String(info.port),
        link_url: wsUrl,
        username: info.username ?? 'root',
        password: info.password ?? '',
        secret: info.password ?? '',
        myshixun_id: info.myshixun_id,
        webssh_url: info.webssh_url,
        ssh_address: info.ssh_address,
        remaining_time: info.remaining_time ?? 60000,
        width: 842,
        height: 763,
        rows: 42,
        columns: 87,
      },
    }));
  });

  // 等提示符
  const deadline = Date.now() + 20_000;
  while (!ready && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));

  let markerSeq = 0;

  return {
    info,
    task,
    async run(command, waitMs = 8000) {
      const before = chunks.length;
      ws.send(JSON.stringify({ tp: 'client', data: `${command}\r` }));
      await new Promise(r => setTimeout(r, waitMs));
      return clean(chunks.slice(before).join(''));
    },
    /**
     * 跑一条命令并等它真的结束：末尾追加一个随机哨兵，等哨兵出现（或超时）才返回。
     * 比固定 sleep 可靠——`schematool`、`start-dfs.sh`、`hive -e` 的耗时差异太大。
     */
    async runUntil(command, { timeoutMs = 90_000, settleMs = 600 } = {}) {
      const marker = `__TG_MARK_${Date.now().toString(36)}_${(markerSeq += 1)}__`;
      const before = chunks.length;
      ws.send(JSON.stringify({ tp: 'client', data: `${command}; printf '\\n%s\\n' ${marker}\r` }));
      const started = Date.now();
      let output = '';
      while (Date.now() - started < timeoutMs) {
        await new Promise(r => setTimeout(r, 250));
        output = clean(chunks.slice(before).join(''));
        if (output.includes(marker)) break;
      }
      const done = output.includes(marker);
      await new Promise(r => setTimeout(r, settleMs));
      output = clean(chunks.slice(before).join('')).replace(new RegExp(`\\s*${marker}\\s*`, 'g'), '\n');
      return { output: output.trim(), done };
    },
    /** 顺序执行多行命令；单行超时只记录，不中断整份配方（靠配方末尾的 verify 判定成败） */
    async runAll(lines, { perLineTimeoutMs = 90_000, maxTimeouts = 2 } = {}) {
      const trace = [];
      let timeouts = 0;
      for (const line of lines) {
        const text = String(line ?? '').trim();
        if (!text) continue;
        const result = await this.runUntil(text, { timeoutMs: perLineTimeoutMs });
        trace.push({ command: text, done: result.done, output: result.output.slice(-800) });
        if (!result.done) {
          timeouts += 1;
          if (timeouts >= maxTimeouts) break;
        }
      }
      return trace;
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
    /** 触发评测并等结果 */
    async evaluate() {
      try {
        await api(`/tasks/${encodeURIComponent(gameUid)}/game_build.json?zzud=${zzud}`, {
          method: 'POST',
          body: {
            sec_key: '', resubmit: '', first: 0, content_modified: 0,
            shixun_environment_id: envId, tab_type: 1,
            extras: { challenge_id: task.challenge.id, homework_common_id: Number(homeworkId), commitID: task.myshixun?.commit_id ?? null },
          },
        });
      } catch { /* -2 评测中也会走到这里，照样去轮询 */ }
      for (let i = 0; i < 20; i += 1) {
        await new Promise(r => setTimeout(r, 3000));
        const now = await api(`/tasks/${encodeURIComponent(gameUid)}.json?homework_common_id=${homeworkId}&zzud=${zzud}`);
        const t = now.challenge ? now : now.data;
        if (t?.game?.status === 2) return { finished: true, score: t.game.final_score, tests: t.test_sets ?? [] };
        const tests = t?.test_sets ?? [];
        if (i > 1 && tests.some(test => test && test.result === false)) {
          return { finished: false, tests };
        }
      }
      return { finished: false, tests: [] };
    },
  };
}
