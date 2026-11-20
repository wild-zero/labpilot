// 走 HTTP 代理的 POST 请求（零依赖：net → CONNECT → tls → 手写 HTTP/1.1）
// 为什么需要它：本机系统代理开着（127.0.0.1:7897），PowerShell/.NET 自动走代理，Node 的 fetch 不走，
// 于是同一个接口 .NET 能通、Node 直接 ECONNRESET。
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

function connectProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('代理连接超时')); }, timeoutMs);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', onData);
        clearTimeout(timer);
        const status = Number(buffer.slice(0, buffer.indexOf('\r\n')).split(' ')[1]);
        if (status !== 200) { socket.destroy(); reject(new Error(`代理拒绝 CONNECT：HTTP ${status}`)); return; }
        resolve(socket);
      };
      socket.on('data', onData);
    });
  });
}

/** 通过代理发一个 HTTPS 请求，返回 { status, text } */
export async function postJsonViaProxy(proxyUrl, url, { headers = {}, body, timeoutMs = 120_000 } = {}) {
  const target = new URL(url);
  const port = Number(target.port) || 443;
  const rawSocket = await connectProxy(proxyUrl, target.hostname, port, timeoutMs);

  const secure = await new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: rawSocket, servername: target.hostname }, () => resolve(socket));
    socket.once('error', reject);
  });

  const payload = Buffer.from(body ?? '', 'utf8');
  const lines = [
    `POST ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.hostname}`,
    'Connection: close',
    `Content-Length: ${payload.length}`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    '',
    '',
  ];
  secure.write(lines.join('\r\n'));
  secure.write(payload);

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { secure.destroy(); reject(new Error('请求超时')); }, timeoutMs);
    secure.on('data', chunk => chunks.push(chunk));
    secure.once('error', (error) => { clearTimeout(timer); reject(error); });
    secure.once('end', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split >= 0 ? text.slice(0, split) : text;
      const status = Number(head.split(' ')[1]) || 0;
      let payloadText = split >= 0 ? text.slice(split + 4) : '';
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        payloadText = payloadText.replace(/^[0-9a-fA-F]+\r\n/m, '').replace(/\r\n0\r\n\r\n$/, '');
      }
      resolve({ status, text: payloadText });
    });
  });
}
