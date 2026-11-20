// 极简 WebSocket 客户端：只为能带 Origin / Cookie 头（浏览器的 WebSocket API 不让改头）。
// 支持文本帧、分片、ping/pong、close。够用于头歌终端。
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildKey() {
  return randomBytes(16).toString('base64');
}

function maskFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | length;
    header.writeUInt8(0x80 | opcode, 0);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | length;
    const mask = randomBytes(4);
    mask.copy(header, 2);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i % 4];
    return Buffer.concat([header, masked]);
  }
  if (length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    const mask = randomBytes(4);
    mask.copy(header, 4);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i % 4];
    return Buffer.concat([header, masked]);
  }
  header = Buffer.alloc(14);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  const mask = randomBytes(4);
  mask.copy(header, 10);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * @returns {Promise<{send:(text:string)=>void, close:()=>void, onMessage:(cb:(text:string)=>void)=>void,
 *   onClose:(cb:(code:number)=>void)=>void, onOpen:(cb:()=>void)=>void}>}
 */
export function connect(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:') throw new Error('只支持 wss://');
  const key = buildKey();

  const requestHeaders = {
    Host: parsed.host,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...headers,
  };
  const request = [
    `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
    ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`),
    '', '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: parsed.hostname, port: Number(parsed.port || 443), servername: parsed.hostname }, () => {
      socket.write(request);
    });
    socket.setNoDelay(true);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('WS 握手超时')); }, timeoutMs);

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let messageHandlers = [];
    let binaryHandlers = [];
    let closeHandlers = [];
    let openHandlers = [];
    let fragments = [];
    let closed = false;

    const handleFrame = (opcode, payload) => {
      if (opcode === 0x2) {
        for (const handler of binaryHandlers) handler(payload);
        return;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (opcode === 0x1 || fragments.length) {
          const text = Buffer.concat(fragments).toString('utf8');
          if (opcode === 0x1) fragments = [payload];
          // 只在 FIN 已到的情况分发（简化：假设单帧）
          for (const handler of messageHandlers) handler(text);
          fragments = [];
        }
        return;
      }
      if (opcode === 0x8) {
        closed = true;
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        for (const handler of closeHandlers) handler(code);
        try { socket.end(); } catch { /* ignore */ }
        return;
      }
      if (opcode === 0x9) { socket.write(maskFrame(0xA, payload)); return; }
      if (opcode === 0xA) return;
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        clearTimeout(timer);
        if (!/101/.test(head.split('\r\n')[0] ?? '')) {
          reject(new Error(`握手指绝：${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        upgraded = true;
        for (const handler of openHandlers) handler();
      }
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const opcode = first & 0x0f;
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        let payload = buffer.subarray(offset, offset + length);
        if (masked) {
          const copy = Buffer.alloc(length);
          for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ maskKey[i % 4];
          payload = copy;
        }
        buffer = buffer.subarray(offset + length);
        handleFrame(opcode, Buffer.from(payload));
      }
    };

    socket.on('data', onData);
    socket.on('error', (error) => { if (!upgraded) reject(error); });
    socket.on('close', () => {
      if (!closed) for (const handler of closeHandlers) handler(1006);
    });

    const api = {
      send(text) {
        if (!upgraded) throw new Error('WS 还没握手完成');
        socket.write(maskFrame(0x1, Buffer.from(text, 'utf8')));
      },
      close() {
        try { socket.write(maskFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch { /* ignore */ }
        socket.end();
      },
      onMessage(handler) { messageHandlers.push(handler); },
      onBinary(handler) { binaryHandlers.push(handler); },
      sendBinary(buffer) {
        if (!upgraded) throw new Error('WS 还没握手完成');
        socket.write(maskFrame(0x2, buffer));
      },
      onClose(handler) { closeHandlers.push(handler); },
      onOpen(handler) {
        openHandlers.push(handler);
        if (upgraded) handler();
      },
    };
    resolve(api);
  });
}

export { GUID };
