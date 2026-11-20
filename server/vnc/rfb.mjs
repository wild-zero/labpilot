// 最小 RFB（VNC）客户端：连 websockify → 握手 → 要一帧画面
import zlib from 'node:zlib';
import { createCipheriv } from 'node:crypto';
import { connect } from '../terminal/ws.mjs';

const enc = (s) => Buffer.from(s, 'utf8');

/** 把像素缓冲转成 PNG（32bpp BGRA/RGBA → RGB） */
export function toPng(pixels, width, height, { bgra = true } = {}) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = bgra ? pixels[index + 2] : pixels[index];
      const g = pixels[index + 1];
      const b = bgra ? pixels[index] : pixels[index + 2];
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([enc(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/**
 * 连上 VNC 并完成握手。
 * @returns {Promise<{width:number,height:number,frame:()=>Promise<Buffer>,pointer:(x:number,y:number,buttons:number)=>void,key:(keysym:number,down:boolean)=>void,close:()=>void}>}
 */
export async function openVnc(url, { password = '', headers = {} } = {}) {
  const socket = await connect(url, { headers, timeoutMs: 20_000 });
  await new Promise((resolve) => {
    let opened = false;
    socket.onOpen(() => { opened = true; resolve(); });
    setTimeout(() => { if (!opened) resolve(); }, 8000);
  });

  let buffer = Buffer.alloc(0);
  const waiters = [];
  const push = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (waiters.length) {
      const waiter = waiters[0];
      if (buffer.length < waiter.need) return;
      const slice = buffer.subarray(0, waiter.need);
      buffer = buffer.subarray(waiter.need);
      waiters.shift();
      waiter.resolve(slice);
    }
  };
  socket.onBinary(push);

  const read = (need) => new Promise((resolve) => {
    if (buffer.length >= need) {
      const slice = buffer.subarray(0, need);
      buffer = buffer.subarray(need);
      resolve(slice);
      return;
    }
    waiters.push({ need, resolve });
  });
  const send = (buf) => socket.sendBinary(buf);

  // 1. 版本握手
  const version = await read(12);
  if (!version.toString('latin1').startsWith('RFB ')) throw new Error('不是 RFB 服务');
  send(enc('RFB 003.008\n'));

  // 2. 安全类型
  const count = (await read(1))[0];
  const types = count ? [...(await read(count))] : [];
  if (!count) {
    const reasonLength = (await read(4)).readUInt32BE(0);
    const reason = await read(reasonLength);
    throw new Error(`VNC 拒绝连接：${reason.toString('utf8')}`);
  }
  if (types.includes(1)) {
    send(Buffer.from([1]));                     // None
  } else if (types.includes(2)) {
    send(Buffer.from([2]));                     // VNC 密码
    const challenge = await read(16);
    send(vncAuth(challenge, password));
  } else {
    throw new Error(`不支持的安全类型：${types.join(',')}`);
  }

  // 3. SecurityResult（None 也可能返回）
  const resultType = await read(4);
  if (resultType.readUInt32BE(0) !== 0) {
    const reasonLength = (await read(4)).readUInt32BE(0);
    const reason = await read(reasonLength);
    throw new Error(`VNC 认证失败：${reason.toString('utf8')}`);
  }

  // 4. ServerInit
  const serverInit = await read(24);            // 宽2 + 高2 + 像素格式16 + 名称长度4
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  const bpp = serverInit[4];
  const nameLength = serverInit.readUInt32BE(20);
  if (nameLength) await read(nameLength);

  // 4.5 明确像素格式：32bpp / 24 深度 / 小端 / 真彩（不指定的话服务器可能发别的格式）
  const pixelFormat = Buffer.alloc(20);
  pixelFormat.writeUInt8(0, 0);
  pixelFormat.writeUInt8(32, 4);   // bits-per-pixel
  pixelFormat.writeUInt8(24, 5);   // depth
  pixelFormat.writeUInt8(0, 6);    // big-endian
  pixelFormat.writeUInt8(1, 7);    // true colour
  pixelFormat.writeUInt16BE(255, 8);
  pixelFormat.writeUInt16BE(255, 10);
  pixelFormat.writeUInt16BE(255, 12);
  pixelFormat.writeUInt8(16, 14);
  pixelFormat.writeUInt8(8, 15);
  pixelFormat.writeUInt8(0, 16);
  send(pixelFormat);

  // 5. 只要 Raw 编码
  const setEncodings = Buffer.alloc(8);
  setEncodings.writeUInt8(2, 0);
  setEncodings.writeUInt16BE(1, 2);
  setEncodings.writeInt32BE(0, 4);
  send(setEncodings);

  socket.send = send;

  return {
    width,
    height,
    bpp,
    async frame(timeoutMs = 60_000) {
      const request = Buffer.alloc(10);
      request.writeUInt8(3, 0);
      request.writeUInt8(0, 1);
      request.writeUInt16BE(0, 2);
      request.writeUInt16BE(0, 4);
      request.writeUInt16BE(width, 6);
      request.writeUInt16BE(height, 8);
      send(request);

      const pixels = Buffer.alloc(width * height * 4);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const header = await read(4);
        const type = header[0];
        if (type === 1) {                          // SetColourMapEntries
          const head = await read(4);
          const count = head.readUInt16BE(2);
          if (count) await read(count * 6);
          continue;
        }
        if (type === 2) continue;                  // Bell
        if (type === 3) {                          // ServerCutText
          const length = (await read(4)).readUInt32BE(0);
          if (length) await read(length);
          continue;
        }
        if (type !== 0) continue;                  // 其它消息忽略
        const rects = header.readUInt16BE(2);
        for (let i = 0; i < rects; i += 1) {
          const rect = await read(12);
          const x = rect.readUInt16BE(0);
          const y = rect.readUInt16BE(2);
          const w = rect.readUInt16BE(4);
          const h = rect.readUInt16BE(6);
          const encoding = rect.readInt32BE(8);
          if (encoding !== 0) { await read(w * h * 4); continue; }
          const data = await read(w * h * 4);
          for (let row = 0; row < h; row += 1) {
            data.copy(pixels, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
          }
        }
        return { pixels, width, height, bpp };
      }
      throw new Error('等待画面超时');
    },
    pointer(x, y, buttons = 0) {
      const message = Buffer.alloc(6);
      message.writeUInt8(5, 0);
      message.writeUInt8(buttons, 1);
      message.writeUInt16BE(x, 2);
      message.writeUInt16BE(y, 4);
      send(message);
    },
    key(keysym, down) {
      const message = Buffer.alloc(8);
      message.writeUInt8(4, 0);
      message.writeUInt8(down ? 1 : 0, 1);
      message.writeUInt32BE(keysym, 4);
      send(message);
    },
    close() { socket.close(); },
  };
}

function vncAuth(challenge, password) {
  const key = Buffer.alloc(8);
  const raw = Buffer.from(password.padEnd(8, '\0').slice(0, 8), 'latin1');
  // VNC 的 DES 密钥要按位反转（RFB 规范里明确要求）
  for (let i = 0; i < 8; i += 1) {
    let value = raw[i];
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    key[i] = reversed;
  }
  const cipher = createCipheriv('des-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}
