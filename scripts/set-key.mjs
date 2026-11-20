// 换解题模型的 key（保留其余配置）
import { readFileSync, writeFileSync } from 'node:fs';

const file = '.env';
const key = process.argv[2];
if (!key || !key.startsWith('sk-')) {
  console.log('用法：node scripts/set-key.mjs sk-xxxx');
  process.exit(1);
}
let text = readFileSync(file, 'utf8');
if (/^OPENAI_API_KEY=.*$/m.test(text)) {
  text = text.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${key}`);
} else {
  text += `\nOPENAI_API_KEY=${key}\n`;
}
writeFileSync(file, text);
const masked = key.slice(0, 8) + '…' + key.slice(-4);
console.log('已更新 OPENAI_API_KEY =', masked);
console.log(text.split('\n').filter(line => /^(SOLVER|OPENAI_)/.test(line)).map(line => line.replace(/(sk-[A-Za-z0-9]{6})[A-Za-z0-9]+/, '$1…')).join('\n'));
