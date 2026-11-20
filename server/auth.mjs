// 认证与会话：头歌账号登录 → 本地用户 → 签名 Cookie 会话。
import { config } from './config.mjs';
import { audit, cards, sessions, users } from './db.mjs';
import { cardHash, hashPassword, open as openSealed, readSessionCookie, seal, signSession, verifyPassword } from './crypto.mjs';
import { clientIp, errors, parseCookies, rateLimit } from './http.mjs';
import { upstream } from './upstream/index.mjs';

export const SESSION_COOKIE = 'lp_session';

export function ensureAdmin() {
  const existing = users.byLogin(config.adminLogin);
  if (existing) {
    if (existing.role !== 'admin') users.setRole(existing.id, 'admin');
    // .env 里的 ADMIN_PASSWORD 是唯一来源：改了密码重启即生效
    if (!existing.password_hash || !verifyPassword(config.adminPassword, existing.password_hash)) {
      users.setPassword(existing.id, hashPassword(config.adminPassword));
      audit.write({ actorId: existing.id, actorName: existing.name, action: 'admin.password.sync', target: existing.id });
    }
    return users.byId(existing.id);
  }
  const created = users.create({
    login: config.adminLogin,
    name: '管理员',
    role: 'admin',
    passwordHash: hashPassword(config.adminPassword),
    serviceAccess: 1,
  });
  audit.write({ actorId: created.id, actorName: created.name, action: 'admin.bootstrap', target: created.id });
  return created;
}

/** 前端可见的用户对象，字段与前端 normalizeUser 对齐 */
export function viewUser(row) {
  return {
    login: row.login,
    name: row.name || row.login,
    id: row.id,
    role: row.role === 'admin' ? 'admin' : 'user',
    permissions: row.role === 'admin' ? ['admin'] : [],
    service_access: Boolean(row.service_access),
    status: row.status,
    avatarUrl: row.upstream_uid ? '/api/avatar' : undefined,
  };
}

function checkCard(code, userId) {
  const hash = cardHash(code);
  const card = cards.byHash(hash);
  if (!card) throw errors.cardInvalid();
  if (card.status === 'revoked') throw errors.cardInvalid();
  if (card.status === 'used' && card.used_by !== userId) throw errors.cardInvalid();
  if (!card.reusable && card.used_by && card.used_by !== userId) throw errors.cardInvalid();
  return card;
}

/**
 * 登录：先用头歌账号换取上游会话，再落本地用户。
 * 管理员账号走本地口令，不打上游。
 */
export async function login({ login, password, accessCode }, req) {
  const account = String(login ?? '').trim();
  if (!account || !password) throw errors.invalid('请输入头歌账号和密码。');

  const ip = clientIp(req ?? {});
  if (!rateLimit(`login:${ip}:${account}`, config.rateLimit.loginMax, config.rateLimit.loginWindowMs)) {
    throw errors.rateLimited();
  }

  // 管理员：本地口令
  const existing = users.byLogin(account);
  if (existing?.role === 'admin' && existing.password_hash && verifyPassword(String(password), existing.password_hash)) {
    if (existing.status !== 'active') throw errors.suspended();
    const sessionId = startSession(existing, req);
    audit.write({ actorId: existing.id, actorName: existing.name, action: 'auth.login', target: existing.id, detail: { role: 'admin' } });
    return { user: existing, sessionId };
  }

  // 卡密校验（可在登录前拦截，避免白跑一次上游登录）
  let card = null;
  if (accessCode) {
    card = checkCard(accessCode, existing?.id);
  } else if (config.accessCardRequired) {
    throw errors.cardRequired();
  }

  const up = upstream();
  let result;
  try {
    result = await up.login(account, String(password));
  } catch (error) {
    if (error?.code) throw error;
    throw errors.auth();
  }

  let user = existing;
  if (!user) {
    user = users.create({ login: account, name: result.user?.name || account, role: 'user' });
  }
  if (user.status !== 'active') throw errors.suspended();

  users.setUpstream(user.id, {
    cookie: seal(JSON.stringify({
      cookie: result.cookie,
      trustie: result.trustie ?? '',
      zzud: result.zzud ?? '',
      uid: result.uid ?? result.user?.id ?? '',
    })),
    uid: result.uid ?? result.user?.id ?? null,
  });
  if (result.user?.name && result.user.name !== user.name) {
    users.setName(user.id, result.user.name);
  }
  if (card && card.used_by !== user.id) cards.consume(card.id, user.id);

  const fresh = users.byId(user.id);
  const sessionId = startSession(fresh, req);
  audit.write({ actorId: fresh.id, actorName: fresh.name, action: 'auth.login', target: fresh.id, detail: { card: Boolean(card) } });
  return { user: fresh, sessionId };
}

function startSession(user, req) {
  const expiresAt = Date.now() + config.sessionTtlMs;
  const id = sessions.create({
    userId: user.id,
    expiresAt,
    ip: clientIp(req ?? {}),
    ua: req?.headers?.['user-agent'] ?? null,
  });
  return id;
}

export function sessionCookie(sessionId) {
  const row = sessions.resolve(sessionId);
  const expiresAt = row?.expires_at ?? Date.now() + config.sessionTtlMs;
  const value = signSession(sessionId, expiresAt);
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.publicOrigin.startsWith('https') ? '; Secure' : ''}`;
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const signed = readSessionCookie(cookies[SESSION_COOKIE]);
  if (!signed) return null;
  const session = sessions.resolve(signed.sessionId);
  if (!session) return null;
  const user = users.byId(session.user_id);
  if (!user || user.status === 'disabled') return null;
  return user;
}

export function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw errors.unauthenticated();
  return user;
}

export function requireAdmin(req) {
  const user = requireUser(req);
  if (user.role !== 'admin') throw errors.forbidden();
  return user;
}

export function logout(req) {
  const cookies = parseCookies(req.headers.cookie);
  const signed = readSessionCookie(cookies[SESSION_COOKIE]);
  if (signed) sessions.destroy(signed.sessionId);
  return { ok: true };
}

/** 取用上游会话（已解封）。返回 { cookie, trustie, zzud, uid }；兼容旧的纯字符串存储。 */
export function upstreamCookie(user) {
  const stored = users.upstream(user.id);
  const raw = openSealed(stored?.cookie);
  if (!raw) throw errors.upstreamAuth();
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.cookie) return parsed;
    } catch { /* fallthrough */ }
  }
  return { cookie: raw, trustie: '', zzud: '', uid: stored?.uid ?? '' };
}
