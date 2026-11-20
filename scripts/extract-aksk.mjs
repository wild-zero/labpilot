// 从 www.educoder.net 的 web bundle 里提取平台客户端的签名常量（AK / SK）。
//
// 平台把两个常量做成双 base64 编码放在 umi bundle 的模块里：
//   527951:function(s,l,e){ e.d(l,{Bn:..., hw:()=>r, mi:()=>t});
//     const t="<双 base64 的 AK>", r="<双 base64 的 SK>", n="..." }
// 前端用 getKey = v => atob(atob(v)) 解出来，再拼进 X-EDU-Signature。
//
// 用法：node scripts/extract-aksk.mjs
import { writeFileSync } from 'node:fs';

const HOME = 'https://www.educoder.net/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const decodeKey = (value) => Buffer.from(Buffer.from(value, 'base64').toString('utf8'), 'base64').toString('utf8');

async function bundleUrls() {
  const html = await (await fetch(HOME, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) {
    const url = match[1].startsWith('http') ? match[1] : new URL(match[1], HOME).href;
    urls.add(url);
  }
  return [...urls];
}

// 流式读取，找到常量就立刻停，不必等整包下完（CDN 对大文件很慢）
async function scan(url, budgetBytes = 6 * 1024 * 1024) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  let text = '';
  let read = 0;
  try {
    while (read < budgetBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += Buffer.from(value).toString('utf8');
      const found = extract(text);
      if (found) return found;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return extract(text);
}

function extract(text) {
  const marker = text.indexOf('mi:function(){return');
  if (marker < 0) return null;
  // 导出表 `e.d(l,{Bn:...,hw:...,mi:...})` 就在 marker 前面；从那里开始截窗口，
  // 否则从 marker 起截会漏掉 hw，只拿到 mi。
  const blockStart = text.lastIndexOf('e.d(l,{', marker);
  const from = blockStart >= 0 && marker - blockStart < 600 ? blockStart : marker;
  const tail = text.slice(from, from + 1400);

  const vars = {};
  for (const match of tail.matchAll(/(mi|hw):function\(\)\{return (\w+)\}/g)) vars[match[1]] = match[2];
  if (!vars.mi || !vars.hw) return null;

  const consts = new Map();
  for (const match of tail.matchAll(/([A-Za-z_$][\w$]*)="([A-Za-z0-9+/=]{24,})"/g)) consts.set(match[1], match[2]);

  const akRaw = consts.get(vars.mi);
  const skRaw = consts.get(vars.hw);
  if (!akRaw || !skRaw) return null;
  return { ak: decodeKey(akRaw), sk: decodeKey(skRaw), akRaw, skRaw };
}

const urls = await bundleUrls();
console.log('候选 bundle：');
for (const url of urls) console.log('  -', url);

let result = null;
for (const url of urls) {
  process.stdout.write(`扫描 ${url} ... `);
  try {
    result = await scan(url);
  } catch (error) {
    console.log('失败：', error.message);
    await sleep(400);
    continue;
  }
  console.log(result ? '命中' : '未命中');
  if (result) break;
}

if (!result) {
  console.error('没有在 bundle 里找到签名常量。平台可能换了打包结构，需要手动定位。');
  process.exit(1);
}

console.log('\nAK =', result.ak);
console.log('SK =', result.sk);

writeFileSync('.aksk.json', JSON.stringify({ ak: result.ak, sk: result.sk, source: 'www.educoder.net umi bundle', at: new Date().toISOString() }, null, 2));
console.log('\n已写入 .aksk.json；把这两行加进 .env：');
console.log(`EDUCODER_AK=${result.ak}`);
console.log(`EDUCODER_SK=${result.sk}`);

// 顺手验一下签名是否被平台接受：错误账号应返回 status:-3（账号密码错），而不是 -102（签名被拒）
const { createHash } = await import('node:crypto');
const ts = Date.now();
const raw = `method=POST&ak=${result.ak}&sk=${result.sk}&time=${ts}`;
const signature = createHash('md5').update(Buffer.from(raw, 'utf8').toString('base64')).digest('hex');
const probe = await fetch('https://data.educoder.net/api/accounts/login.json', {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-EDU-Type': 'pc',
    'X-EDU-Timestamp': String(ts),
    'X-EDU-Signature': signature,
    'Pc-Authorization': 'null',
    Origin: 'https://www.educoder.net',
    Referer: 'https://www.educoder.net/login',
  },
  body: JSON.stringify({ login: 'probe_not_exist_user@example.com', password: 'wrong-password', autologin: true, tl: null, source: null }),
}).catch(() => null);
if (probe) {
  const payload = await probe.json().catch(() => ({}));
  console.log('\n签名自检：HTTP', probe.status, 'status =', payload.status, payload.status === -3 ? '（签名有效）' : payload.status === -102 ? '（签名被拒）' : '');
}
