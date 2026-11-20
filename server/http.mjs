// HTTP 杂项：统一 JSON 信封、错误类型、请求体解析、Cookie。
import { randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errors = {
  auth: (message = '账号或密码不正确，请检查后重新登录。') => new ApiError(401, 'AUTH_FAILED', message),
  unauthenticated: (message = '登录已过期，请重新登录。') => new ApiError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = '当前账号未获授权。') => new ApiError(403, 'FORBIDDEN', message),
  notFound: (message = '资源不存在。') => new ApiError(404, 'NOT_FOUND', message),
  invalid: (message = '请求参数不正确。') => new ApiError(400, 'INVALID_REQUEST', message),
  cardRequired: () => new ApiError(402, 'CARD_REQUIRED', '请填写你的卡密。'),
  cardInvalid: () => new ApiError(402, 'CARD_INVALID', '卡密暂未验证通过，请联系服务人员。'),
  suspended: () => new ApiError(403, 'USER_SUSPENDED', '账号服务暂不可用，请联系服务人员。'),
  rateLimited: () => new ApiError(429, 'RATE_LIMITED', '登录有点频繁，请稍后再试。'),
  conflict: (message = '该目标已有正在处理的安排。') => new ApiError(409, 'CONFLICT', message),
  upstream: (message = '上游平台暂未响应，请稍后重试。', code = 'UPSTREAM_FAILED') => new ApiError(502, code, message),
  upstreamAuth: (message = '头歌登录状态已失效，请重新登录。') => new ApiError(401, 'UPSTREAM_AUTH_EXPIRED', message),
};

export const sendJSON = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
};

export const sendData = (res, data, requestId) => sendJSON(res, 200, { data, error: null, requestId });

export const sendError = (res, error, requestId) => {
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof ApiError ? error.message : '服务内部错误，请稍后重试。';
  if (status >= 500 && !(error instanceof ApiError)) console.error('[error]', error);
  sendJSON(res, status, { data: null, error: { code, message }, requestId });
};

export async function readJSON(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw errors.invalid('请求体过大。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw errors.invalid('请求体不是合法 JSON。');
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export const requestId = () => randomBytes(16).toString('hex');

// 路由返回协议：普通值 -> 200 {data}；data() -> 带响应头；raw() -> 原始字节
export const data = (value, headers = {}) => ({ __kind: 'data', value, headers });
export const raw = (body, contentType = 'text/plain; charset=utf-8', headers = {}) => ({ __kind: 'raw', body, contentType, headers });

export const clientIp = (req) => (
  req.headers['cf-connecting-ip']
  || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket?.remoteAddress
  || ''
);

// 极简内存限流：key -> 时间戳队列
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter(ts => now - ts < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
