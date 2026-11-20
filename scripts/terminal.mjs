// 头歌终端客户端：拿容器参数 → 连 WS（带 Origin/Cookie）→ 执行命令 → 可选触发评测。
//
// 协议（逆向自浏览器实测）：
//   1. GET /api/myshixuns/{myshixun}/start.json?shixun_environment_id=&tab_type=4&game_id=&homework_common_id=&zzud=
//      → { host, port, username, password, myshixun_id, webssh_url, ssh_address, link_url, remaining_time }
//   2. 连 wss://webssh.educoder.net/ws，握手必须带 Origin: https://www.educoder.net 和会话 Cookie
//   3. 首帧 {"tp":"init","data":{...容器参数..., secret, width, height, rows, columns}}
//   4. 发输入 {"tp":"client","data":"<原文，不带 base64>"}；服务端回的是裸 base64 串
//
// 用法：
//   node scripts/terminal.mjs <course> <homeworkId> <gameId> "<命令>" [--eval]
//   命令里的 \n 会被拆成多行依次发送。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { connect as wsConnect } from '../server/terminal/ws.mjs';

const argv = process.argv.slice(2);
const evalAfter = argv.includes('--eval');
const positional = argv.filter(arg => !arg.startsWith('--'));
const [course, homeworkRaw, gameId, ...commandParts] = positional;
let command = commandParts.join(' ') || 'echo hello_from_dad';
// @文件：从文件读命令，避免 PowerShell 把引号吃掉
if (command.startsWith('@')) {
  const { readFileSync } = await import('node:fs');
  command = readFileSync(command.slice(1).trim(), 'utf8').replace(/\r\n/g, '\n').trim();
}
command = command.replace(/\\n/g, '\n');

if (!course || !homeworkRaw || !gameId) {
  console.error('用法：node scripts/terminal.mjs <course> <homeworkId> <gameId> "<命令>" [--eval]');
  process.exit(2);
}

const db = new DatabaseSync(config.dbFile);
const row = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
const session = JSON.parse(openSealed(row.upstream_cookie));
db.close();

const base = config.educoder.base.replace(/\/$/, '');
const md5hex = (buf) => createHash('md5').update(buf).digest('hex');

function headers(method = 'GET') {
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
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers(method), ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const zzud = session.zzud ?? '';
const taskJson = await api(`/tasks/${encodeURIComponent(gameId)}.json?homework_common_id=${homeworkRaw}&zzud=${zzud}`);
const task = taskJson.challenge ? taskJson : taskJson.data;
if (!task?.challenge) {
  console.log('拿不到关卡信息：', JSON.stringify(taskJson).slice(0, 300));
  process.exit(1);
}
const myshixun = task.myshixun?.identifier ?? '';
const gameNumericId = task.game?.id;
const envId = task.code_editor?.shixun_environment_id ?? task.shixun_environments?.[0]?.shixun_environment_id;
console.log(`关卡「${task.challenge.subject}」 myshixun=${myshixun} game=${gameNumericId} env=${envId}`);

const started = await api(`/myshixuns/${encodeURIComponent(myshixun)}/start.json?shixun_environment_id=${envId}&tab_type=4&game_id=${gameNumericId}&homework_common_id=${homeworkRaw}&zzud=${zzud}`);
const info = started.data ?? started;
if (!info?.host || !info?.port) {
  console.log('没拿到容器地址：', JSON.stringify(started).slice(0, 300));
  process.exit(1);
}
console.log(`容器 ${info.host}:${info.port} 剩余 ${Math.round((info.remaining_time ?? 0) / 1000)}s`);

const wsUrl = info.link_url ?? 'wss://webssh.educoder.net/ws';
const ws = await wsConnect(wsUrl, {
  headers: {
    Origin: 'https://www.educoder.net',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Cookie: `autologin_trustie=${session.trustie ?? ''}; _educoder_session=${session.cookie}`,
  },
});

const MARK = '__TG_DONE_9527__';
const chunks = [];
const clean = (text) => text
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\r/g, '');
let sent = false;
let marked = 0;

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

ws.onMessage((data) => {
  let text = data;
  if (!data.trim().startsWith('{')) {
    try { text = Buffer.from(data, 'base64').toString('utf8'); } catch { /* keep */ }
  }
  chunks.push(text);
  const sofar = clean(chunks.join(''));

  if (!sent && sofar.includes('#')) {
    sent = true;
    console.log('已连接终端，开始执行：');
    for (const line of command.split('\n')) {
      if (line.trim()) console.log('  $', line);
    }
    ws.send(JSON.stringify({ tp: 'client', data: `${command.replace(/\n/g, '\r')}\r` }));
    // 不靠哨兵判断结束：终端换行会把回显打断，哨兵不可靠。给固定时间跑完再收工。
    const waitMs = Math.max(6000, Math.min(45_000, command.length * 30));
    setTimeout(() => {
      if (marked) return;
      marked = 1;
      console.log('\n=== 终端输出 ===');
      console.log(clean(chunks.join('')));
      ws.close();
      setTimeout(async () => {
        if (!evalAfter) process.exit(0);
        console.log('\n=== 触发评测 ===');
        try {
          const built = await api(`/tasks/${encodeURIComponent(gameId)}/game_build.json?zzud=${zzud}`, {
            method: 'POST',
            body: {
              sec_key: '', resubmit: '', first: 0, content_modified: 0,
              shixun_environment_id: envId, tab_type: 1,
              extras: { challenge_id: task.challenge.id, homework_common_id: Number(homeworkRaw), commitID: task.myshixun?.commit_id ?? null },
            },
          });
          console.log('build →', JSON.stringify(built).slice(0, 200));
        } catch (error) {
          console.log('build 失败：', error.message);
        }
        for (let i = 0; i < 20; i += 1) {
          await new Promise(r => setTimeout(r, 3000));
          const now = await api(`/tasks/${encodeURIComponent(gameId)}.json?homework_common_id=${homeworkRaw}&zzud=${zzud}`);
          const t = now.challenge ? now : now.data;
          const status = t?.game?.status;
          const tests = t?.test_sets ?? [];
          console.log(`  第 ${i + 1} 次：status=${status} 期望=${JSON.stringify(tests[0]?.output ?? '')} 实际=${JSON.stringify(String(tests[0]?.actual_output ?? '').slice(0, 120))}`);
          if (status === 2) { console.log('✅ 通过'); break; }
          if (i > 1 && tests[0]?.result === false) break;
        }
        process.exit(0);
      }, 400);
    }, waitMs);
  }

  // 标记会出现两次：一次是命令回显，一次是真正执行结果
  const count = sofar.split(MARK).length - 1;
  if (false && count >= 2 && marked === 0) {
    marked = 1;
    console.log('\n=== 终端输出 ===');
    console.log(sofar);
    ws.close();
    setTimeout(async () => {
      if (!evalAfter) process.exit(0);
      console.log('\n=== 触发评测 ===');
      const built = await api(`/tasks/${encodeURIComponent(gameId)}/game_build.json?zzud=${zzud}`, {
        method: 'POST',
        body: {
          sec_key: '', resubmit: '', first: 0, content_modified: 0,
          shixun_environment_id: envId, tab_type: 1,
          extras: { challenge_id: task.challenge.id, homework_common_id: Number(homeworkRaw), commitID: task.myshixun?.commit_id ?? null },
        },
      });
      console.log('build →', JSON.stringify(built).slice(0, 200));
      for (let i = 0; i < 20; i += 1) {
        await new Promise(r => setTimeout(r, 3000));
        const now = await api(`/tasks/${encodeURIComponent(gameId)}.json?homework_common_id=${homeworkRaw}&zzud=${zzud}`);
        const t = now.challenge ? now : now.data;
        const status = t?.game?.status;
        const tests = t?.test_sets ?? [];
        console.log(`  第 ${i + 1} 次：status=${status} 期望=${JSON.stringify(tests[0]?.output ?? '')} 实际=${JSON.stringify((tests[0]?.actual_output ?? '').slice(0, 120))}`);
        if (status === 2) { console.log('✅ 通过'); break; }
        if (i > 1 && tests[0]?.result === false) break;
      }
      process.exit(0);
    }, 400);
  }
});

ws.onClose((code) => {
  if (!marked) {
    console.log('WS 关闭 code =', code);
    console.log(clean(chunks.join('')));
    process.exit(0);
  }
});

setTimeout(() => {
  console.log('\n超时。已收到：');
  console.log(clean(chunks.join('')));
  process.exit(0);
}, 40_000);
