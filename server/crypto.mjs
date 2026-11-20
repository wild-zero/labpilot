// 口令哈希、上游凭据加密、签名 Cookie。
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, randomUUID, scryptSync, timingSafeEqual,
} from 'node:crypto';
import { config } from './config.mjs';

const SCRYPT_N = 16384;

export const newId = () => randomUUID();

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(n)) return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  const actual = scryptSync(password, salt, expected.length, { N: n, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const md5 = (value) => createHash('md5').update(value).digest();
export const base64 = (value) => Buffer.from(value).toString('base64');

// ---- 上游凭据：AES-256-GCM，密钥由 ENCRYPTION_KEY 派生 ----
const keyOf = () => createHash('sha256').update(String(config.encryptionKey)).digest();

export function seal(plaintext) {
  if (plaintext == null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed) {
  if (!sealed) return null;
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---- 会话 Cookie：HMAC 签名，值为 <sessionId>.<exp>.<sig> ----
export function signSession(sessionId, expiresAt) {
  const payload = `${sessionId}.${expiresAt}`;
  const sig = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSessionCookie(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, exp, sig] = parts;
  const expected = createHmac('sha256', config.sessionSecret).update(`${sessionId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { sessionId, expiresAt };
}

// ---- 卡密：只存哈希，明文仅创建时返回一次 ----
export const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCardCode() {
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let s = '';
    for (let i = 0; i < 4; i += 1) {
      s += CARD_ALPHABET[randomBytes(1)[0] % CARD_ALPHABET.length];
    }
    groups.push(s);
  }
  return `TG-${groups.join('-')}`;
}

export const normalizeCardCode = (code) => String(code ?? '').replace(/[\s-]/g, '').toUpperCase();
export const cardHash = (code) => sha256(`card:${normalizeCardCode(code)}`);
