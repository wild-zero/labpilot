// SQLite 存储层（node:sqlite，零依赖）。所有表 + 常用访问函数都在这里。
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';
import { newId } from './crypto.mjs';

export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  password_hash TEXT,
  service_access INTEGER NOT NULL DEFAULT 1,
  upstream_cookie TEXT,
  upstream_uid  TEXT,
  upstream_seen INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL DEFAULT '',
  reusable   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active',
  used_by    TEXT,
  used_at    TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  mode        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  request     TEXT NOT NULL,
  phase       TEXT NOT NULL DEFAULT '',
  progress    TEXT NOT NULL DEFAULT '{}',
  result      TEXT NOT NULL DEFAULT '{}',
  error_code  TEXT,
  error_message TEXT,
  idempotency_key TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  actor_name TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at DESC);

CREATE TABLE IF NOT EXISTS bank (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_key TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'choice',
  answer      TEXT NOT NULL,
  source_job  TEXT,
  verified    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 做题失败的记录：同一个键连续失败到阈值就不再花评测次数，直接转人工
CREATE TABLE IF NOT EXISTS failures (
  subject_key TEXT PRIMARY KEY,
  subject     TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  updated_at  TEXT NOT NULL
);

-- 反馈工单：用户在这里提问题，服务人员在同一个对话里回复
CREATE TABLE IF NOT EXISTS tickets (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject          TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'other',
  status           TEXT NOT NULL DEFAULT 'open',
  last_author_role TEXT NOT NULL DEFAULT 'user',
  message_count    INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id       TEXT,
  author_name     TEXT NOT NULL DEFAULT '',
  author_role     TEXT NOT NULL DEFAULT 'user',
  body            TEXT NOT NULL,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, created_at);
`);

export const nowISO = () => new Date().toISOString();

const parse = (value, fallback) => {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

// ---------- users ----------
export const users = {
  byLogin(login) {
    return db.prepare('SELECT * FROM users WHERE login = ?').get(String(login ?? '').trim());
  },
  byId(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  all() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },
  create({ login, name, role = 'user', passwordHash = null, serviceAccess = 1 }) {
    const id = newId();
    const ts = nowISO();
    db.prepare(`INSERT INTO users (id, login, name, role, status, password_hash, service_access, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, login, name || login, role, passwordHash, serviceAccess ? 1 : 0, ts, ts);
    return this.byId(id);
  },
  setStatus(id, status) {
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, nowISO(), id);
  },
  setServiceAccess(id, value) {
    db.prepare('UPDATE users SET service_access = ?, updated_at = ? WHERE id = ?').run(value ? 1 : 0, nowISO(), id);
  },
  setPassword(id, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, nowISO(), id);
  },
  setName(id, name) {
    db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(name, nowISO(), id);
  },
  setRole(id, role) {
    db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowISO(), id);
  },
  setUpstream(id, { cookie, uid }) {
    db.prepare('UPDATE users SET upstream_cookie = ?, upstream_uid = ?, upstream_seen = ?, updated_at = ? WHERE id = ?')
      .run(cookie ?? null, uid ?? null, Date.now(), nowISO(), id);
  },
  upstream(id) {
    const row = this.byId(id);
    if (!row) return null;
    return { cookie: row.upstream_cookie, uid: row.upstream_uid, seenAt: row.upstream_seen };
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  },
};

// ---------- sessions ----------
export const sessions = {
  create({ userId, expiresAt, ip, ua }) {
    const id = newId();
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, nowISO(), expiresAt, ip ?? null, ua ?? null);
    return id;
  },
  resolve(sessionId) {
    const row = db.prepare(`SELECT s.id, s.user_id, s.expires_at FROM sessions s WHERE s.id = ?`).get(sessionId);
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.destroy(sessionId);
      return null;
    }
    return row;
  },
  destroy(sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  },
  destroyForUser(userId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  },
};

// ---------- cards ----------
export const cards = {
  byHash(codeHash) {
    return db.prepare('SELECT * FROM cards WHERE code_hash = ?').get(codeHash);
  },
  list() {
    return db.prepare('SELECT id, label, reusable, status, used_by, used_at, created_by, created_at FROM cards ORDER BY created_at DESC').all();
  },
  create({ codeHash, label, createdBy, reusable = 0 }) {
    const id = newId();
    db.prepare('INSERT INTO cards (id, code_hash, label, reusable, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, codeHash, label || '服务卡密', reusable ? 1 : 0, 'active', createdBy ?? null, nowISO());
    return id;
  },
  consume(id, userId) {
    db.prepare('UPDATE cards SET used_by = ?, used_at = ?, status = CASE WHEN reusable = 1 THEN status ELSE \'used\' END WHERE id = ?')
      .run(userId, nowISO(), id);
  },
  revoke(id) {
    db.prepare("UPDATE cards SET status = 'revoked' WHERE id = ?").run(id);
  },
};

// ---------- jobs ----------
const jobRow = (row) => (row ? {
  ...row,
  request: parse(row.request, {}),
  progress: parse(row.progress, {}),
  result: parse(row.result, {}),
  cancel_requested: Boolean(row.cancel_requested),
} : null);

export const jobs = {
  byId(id) {
    return jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  },
  byIdForOwner(id, ownerId) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ?').get(id, ownerId);
    return jobRow(row);
  },
  listForOwner(ownerId) {
    return db.prepare('SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200').all(ownerId).map(jobRow);
  },
  listAll() {
    return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 400').all().map(jobRow);
  },
  findByIdempotency(ownerId, key) {
    if (!key) return null;
    return jobRow(db.prepare('SELECT * FROM jobs WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, key));
  },
  create({ ownerId, mode, scope, request, idempotencyKey }) {
    const id = newId();
    const ts = nowISO();
    db.prepare(`INSERT INTO jobs (id, owner_id, status, mode, scope, request, phase, progress, result, idempotency_key, created_at, updated_at)
                VALUES (?, ?, 'queued', ?, ?, ?, 'queued', '{}', '{}', ?, ?, ?)`)
      .run(id, ownerId, mode, scope, JSON.stringify(request), idempotencyKey ?? null, ts, ts);
    return this.byId(id);
  },
  update(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${key} = ?`);
      values.push(value && typeof value === 'object' ? JSON.stringify(value) : value);
    }
    sets.push('updated_at = ?');
    values.push(nowISO(), id);
    db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.byId(id);
  },
  claimNext() {
    const row = db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
    if (!row) return null;
    const claimed = db.prepare("UPDATE jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowISO(), nowISO(), row.id);
    if (claimed.changes !== 1) return null;
    return this.byId(row.id);
  },
  requestCancel(id) {
    db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(nowISO(), id);
  },
  cancelRequested(id) {
    const row = db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(id);
    return Boolean(row?.cancel_requested);
  },
  resetStale() {
    // 进程重启后把卡在 running 的任务标为 interrupted
    const ts = nowISO();
    return db.prepare(`UPDATE jobs SET status = 'interrupted', phase = 'interrupted', error_code = 'service_restarted',
                       error_message = '服务重启中断了任务，需要核对已完成结果', finished_at = ?, updated_at = ?
                       WHERE status IN ('running', 'waiting', 'processing')`).run(ts, ts).changes;
  },
  stats() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    return Object.fromEntries(rows.map(row => [row.status, row.n]));
  },
  /** 中断/失败/已停止的任务重新排队（沿用同一行，保留历史） */
  requeue(id) {
    db.prepare(`UPDATE jobs SET status = 'queued', phase = 'queued', error_code = NULL, error_message = NULL,
                cancel_requested = 0, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`)
      .run(nowISO(), id);
    return this.byId(id);
  },
};

const PENDING_STATUSES = ['queued', 'running', 'waiting', 'processing'];

/** 任务能做什么操作：跑着的不能重跑；中断/失败/已停止的可以恢复，其它可以再排一次 */
export const jobActions = (job) => {
  if (!job) return { can_retry: false, can_recover: false };
  const pending = PENDING_STATUSES.includes(job.status);
  return {
    can_retry: !pending,
    can_recover: !pending && ['interrupted', 'failed', 'canceled'].includes(job.status),
  };
};

// ---------- audit ----------
export const audit = {
  write({ actorId = null, actorName = '', action, target = null, detail = null }) {
    db.prepare('INSERT INTO audit (actor_id, actor_name, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actorId, actorName, action, target, detail ? JSON.stringify(detail) : null, nowISO());
  },
  list(limit = 200) {
    return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
      ...row,
      detail: parse(row.detail, null),
    }));
  },
};

// ---------- bank（已验证题库） ----------
export const bank = {
  lookup(subjectKey) {
    const row = db.prepare('SELECT * FROM bank WHERE subject_key = ? AND verified = 1').get(subjectKey);
    return row ? { ...row, answer: parse(row.answer, row.answer) } : null;
  },
  save({ subjectKey, subject, kind, answer, sourceJob }) {
    const ts = nowISO();
    db.prepare(`INSERT INTO bank (subject_key, subject, kind, answer, source_job, verified, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(subject_key) DO UPDATE SET answer = excluded.answer, kind = excluded.kind,
                  source_job = excluded.source_job, verified = 1, updated_at = excluded.updated_at`)
      .run(subjectKey, subject ?? '', kind ?? 'choice', JSON.stringify(answer), sourceJob ?? null, ts, ts);
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM bank').get().n;
  },
  // 题库里的答案被评测否掉时删掉它，免得下次又被同一个错答案带偏
  clear(subjectKey) {
    db.prepare('DELETE FROM bank WHERE subject_key = ?').run(subjectKey);
  },
};

export function closeDb() {
  try { db.close(); } catch { /* already closed */ }
}

// ---------- failures（避免反复烧评测次数） ----------
export const failures = {
  get(subjectKey) {
    return db.prepare('SELECT * FROM failures WHERE subject_key = ?').get(subjectKey);
  },
  bump(subjectKey, subject, reason) {
    db.prepare(`INSERT INTO failures (subject_key, subject, attempts, last_reason, updated_at)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(subject_key) DO UPDATE SET attempts = attempts + 1,
                  last_reason = excluded.last_reason, updated_at = excluded.updated_at`)
      .run(subjectKey, String(subject ?? '').slice(0, 300), reason ?? null, nowISO());
    return this.get(subjectKey);
  },
  clear(subjectKey) {
    db.prepare('DELETE FROM failures WHERE subject_key = ?').run(subjectKey);
  },
  list() {
    return db.prepare('SELECT * FROM failures ORDER BY updated_at DESC').all();
  },
};

// ---------- tickets（反馈工单） ----------
export const TICKET_CATEGORIES = ['task', 'account', 'data', 'suggestion', 'other'];
export const TICKET_STATUSES = ['open', 'processing', 'resolved', 'closed'];

const encodeCursor = (row) => Buffer.from(`${row.updated_at}|${row.id}`, 'utf8').toString('base64url');
const decodeCursor = (cursor) => {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const [updatedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return updatedAt && id ? { updatedAt, id } : null;
  } catch { return null; }
};

const ticketShape = (row, user = null) => (row ? {
  ...row,
  message_count: Number(row.message_count ?? 0),
  user: user ?? undefined,
} : null);

export const tickets = {
  byId(id) {
    const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    return ticketShape(row);
  },
  byIdForOwner(id, ownerId) {
    const row = db.prepare('SELECT * FROM tickets WHERE id = ? AND owner_id = ?').get(id, ownerId);
    return ticketShape(row);
  },
  /** 列表：owner 为空表示管理端（可带用户信息），支持状态筛选 + 游标分页（游标 = updated_at|id 的 base64url） */
  list({ ownerId = null, status = null, limit = 20, cursor = null, withUser = false } = {}) {
    const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const where = [];
    const values = [];
    if (ownerId) { where.push('t.owner_id = ?'); values.push(ownerId); }
    if (status && TICKET_STATUSES.includes(status)) { where.push('t.status = ?'); values.push(status); }
    const point = decodeCursor(cursor);
    if (point) { where.push('(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))'); values.push(point.updatedAt, point.updatedAt, point.id); }
    const sql = `SELECT t.*, u.name AS user_name, u.login AS user_login
                 FROM tickets t LEFT JOIN users u ON u.id = t.owner_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...values, size + 1);
    const page = rows.slice(0, size);
    return {
      items: page.map(row => ticketShape(row, withUser ? { id: row.owner_id, name: row.user_name ?? '', login: row.user_login ?? '' } : null)),
      nextCursor: rows.length > size ? encodeCursor(page[page.length - 1]) : null,
    };
  },
  create({ ownerId, subject, category, body, authorId, authorName, authorRole = 'user', idempotencyKey = null }) {
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM tickets WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, idempotencyKey);
      if (existing) return ticketShape(existing);
    }
    const id = newId();
    const ts = nowISO();
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO tickets (id, owner_id, subject, category, status, last_author_role, message_count, idempotency_key, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'open', 'user', 1, ?, ?, ?)`)
        .run(id, ownerId, subject, category, idempotencyKey, ts, ts);
      db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_id, author_name, author_role, body, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(newId(), id, authorId ?? ownerId, authorName ?? '', authorRole, body, ts);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.byId(id);
  },
  messages(ticketId) {
    return db.prepare('SELECT id, ticket_id, author_id, author_name, author_role, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC, id ASC').all(ticketId);
  },
  addMessage({ ticketId, authorId, authorName, authorRole, body, idempotencyKey = null }) {
    if (idempotencyKey) {
      const dup = db.prepare('SELECT id FROM ticket_messages WHERE ticket_id = ? AND idempotency_key = ?').get(ticketId, idempotencyKey);
      if (dup) return this.byId(ticketId);
    }
    const ts = nowISO();
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_id, author_name, author_role, body, idempotency_key, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId(), ticketId, authorId ?? null, authorName ?? '', authorRole, body, idempotencyKey, ts);
      // 服务人员回复 → 处理中；用户补充 → 回到待回复
      const nextStatus = authorRole === 'admin' ? 'processing' : 'open';
      db.prepare(`UPDATE tickets SET message_count = message_count + 1, last_author_role = ?, status = CASE WHEN status = 'closed' THEN status ELSE ? END,
                  updated_at = ? WHERE id = ?`).run(authorRole, nextStatus, ts, ticketId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.byId(ticketId);
  },
  setStatus(id, status) {
    db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, nowISO(), id);
    return this.byId(id);
  },
  counts() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all();
    return Object.fromEntries(rows.map(row => [row.status, row.n]));
  },
};
