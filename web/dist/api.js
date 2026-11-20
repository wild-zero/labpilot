// 后端 API 客户端。统一信封 {data, error, requestId}。
export class ApiRequestError extends Error {
  constructor(message, status, code, requestId) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  get isSessionExpired() {
    if (this.code === 'AUTH_FAILED') return false;
    return this.status === 401 || this.code === 'UNAUTHENTICATED' || this.code === 'UPSTREAM_AUTH_EXPIRED';
  }
}

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = (value, fallback = '') => (value == null ? fallback : String(value));
const number = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function normalizeUser(raw) {
  const item = asRecord(raw);
  const source = Object.keys(asRecord(item.user)).length ? asRecord(item.user) : item;
  const login = text(source.login || source.username);
  return {
    login,
    name: text(source.name || login, login || '同学'),
    id: number(source.id || source.user_id),
    role: source.role === 'admin' ? 'admin' : 'user',
    permissions: Array.isArray(source.permissions) ? source.permissions.filter(v => typeof v === 'string') : [],
    service_access: source.service_access,
    status: text(source.status) || undefined,
    avatarUrl: source.avatarUrl === '/api/avatar' ? '/api/avatar' : undefined,
  };
}

function normalizeCourse(raw) {
  const item = asRecord(raw);
  return {
    identifier: text(item.identifier),
    name: text(item.name, '未命名课堂'),
    homeworkCount: number(item.homeworkCount),
    membersCount: number(item.membersCount),
    ended: Boolean(item.ended),
  };
}

function normalizeHomework(raw) {
  const item = asRecord(raw);
  return {
    id: number(item.id) ?? 0,
    name: text(item.name, '未命名任务'),
    status: text(item.status),
    challengeCount: number(item.challengeCount),
    finishedChallengeCount: number(item.finishedChallengeCount),
    requiredChallengeCount: number(item.requiredChallengeCount),
    finishedRequiredChallengeCount: number(item.finishedRequiredChallengeCount),
    requiredProgressKnown: item.requiredProgressKnown === true,
    deadline: text(item.deadline) || undefined,
  };
}

function normalizeExercise(raw) {
  const item = asRecord(raw);
  return {
    id: number(item.id) ?? 0,
    name: text(item.name, '未命名考试'),
    status: text(item.status, '待开始'),
    submitted: Boolean(item.submitted),
    scoreKnown: Boolean(item.scoreKnown),
    score: item.score,
    maxScore: item.maxScore,
    totalQuestions: number(item.totalQuestions),
    deadline: text(item.deadline) || undefined,
    available: item.available === true,
    actionRequired: item.actionRequired === undefined ? undefined : Boolean(item.actionRequired),
    reasonCode: text(item.reasonCode) || undefined,
  };
}

export class BrowserApi {
  async request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const requestId = response.headers.get('X-Request-Id') ?? undefined;
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiRequestError('服务返回了无效响应，请稍后重试', response.status, 'INVALID_RESPONSE', requestId);
    }
    const root = asRecord(payload);
    if (root.error) {
      throw new ApiRequestError(text(root.error.message, '请求失败'), response.status, text(root.error.code) || undefined, text(root.requestId) || requestId);
    }
    if (!response.ok) {
      throw new ApiRequestError('请求失败，请稍后重试', response.status, 'INTERNAL_ERROR', requestId);
    }
    return root.data;
  }

  async login(login, password, cardCode) {
    return normalizeUser(await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login: login.trim(), password, ...(cardCode?.trim() ? { access_code: cardCode.trim() } : {}) }),
    }));
  }

  async me() { return normalizeUser(await this.request('/api/auth/me')); }
  async authConfig() { return this.request('/api/auth/config'); }
  async logout() { return this.request('/api/auth/logout', { method: 'POST' }); }

  async courses() {
    const payload = asRecord(await this.request('/api/courses'));
    const rows = Array.isArray(payload.courses) ? payload.courses : [];
    return rows.map(normalizeCourse).filter(course => course.identifier);
  }

  async homeworks(identifier) {
    const payload = asRecord(await this.request(`/api/courses/${encodeURIComponent(identifier)}/homeworks`));
    const rows = Array.isArray(payload.homeworks) ? payload.homeworks : [];
    return rows.map(normalizeHomework).filter(homework => homework.id > 0);
  }

  async exercises(identifier) {
    const payload = asRecord(await this.request(`/api/courses/${encodeURIComponent(identifier)}/exercises`));
    const rows = Array.isArray(payload.items) ? payload.items : [];
    return { items: rows.map(normalizeExercise).filter(exercise => exercise.id > 0) };
  }

  async questionBankSummary() { return this.request('/api/question-bank/summary'); }
  async todaySummary() { return this.request('/api/service/today-summary'); }

  async jobs() {
    const payload = asRecord(await this.request('/api/jobs'));
    return { jobs: Array.isArray(payload.jobs) ? payload.jobs : [] };
  }

  async job(id) { return this.request(`/api/jobs/${encodeURIComponent(id)}`); }

  async createJob(request) {
    return this.request('/api/jobs', { method: 'POST', body: JSON.stringify(request) });
  }

  async cancelJob(id) {
    return this.request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  async adminOverview() { return this.request('/api/admin/overview'); }
  async adminUsers() {
    const payload = asRecord(await this.request('/api/admin/users'));
    return Array.isArray(payload.users) ? payload.users : [];
  }
  async adminJobs() {
    const payload = asRecord(await this.request('/api/admin/jobs'));
    return Array.isArray(payload.jobs) ? payload.jobs : [];
  }
  async adminAudit() {
    const payload = asRecord(await this.request('/api/admin/audit'));
    return Array.isArray(payload.audit) ? payload.audit : [];
  }
  async adminCards() {
    const payload = asRecord(await this.request('/api/admin/cards'));
    return Array.isArray(payload.items) ? payload.items : [];
  }
  async adminUserStatus(id, status) {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  }
  async adminCancelJob(id) {
    return this.request(`/api/admin/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }
  async adminCreateCard(label) {
    return this.request('/api/admin/cards', { method: 'POST', body: JSON.stringify({ label, reusable: false }) });
  }
  async adminRevokeCard(id) {
    return this.request(`/api/admin/cards/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  }

  // ---- 反馈工单 ----
  ticketQuery(options = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.status) query.set('status', options.status);
    return query.size ? `?${query}` : '';
  }
  async tickets(options = {}) { return this.request(`/api/tickets${this.ticketQuery(options)}`); }
  async ticket(id) { return this.request(`/api/tickets/${encodeURIComponent(id)}`); }
  async createTicket(input) {
    return this.request('/api/tickets', { method: 'POST', body: JSON.stringify(input) });
  }
  async replyTicket(id, input) {
    return this.request(`/api/tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) });
  }
  async setTicketStatus(id, status) {
    return this.request(`/api/tickets/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  }
  async adminTickets(options = {}) { return this.request(`/api/admin/tickets${this.ticketQuery(options)}`); }
  async adminTicket(id) { return this.request(`/api/admin/tickets/${encodeURIComponent(id)}`); }
  async adminReplyTicket(id, input) {
    return this.request(`/api/admin/tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) });
  }
  async adminSetTicketStatus(id, status) {
    return this.request(`/api/admin/tickets/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  }

  // ---- 任务恢复 / 重跑 ----
  async recoverJob(id) { return this.request(`/api/jobs/${encodeURIComponent(id)}/recover`, { method: 'POST' }); }
  async retryJob(id) { return this.request(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }); }
  async adminRecoverJob(id) { return this.request(`/api/admin/jobs/${encodeURIComponent(id)}/recover`, { method: 'POST' }); }
  async adminRetryJob(id) { return this.request(`/api/admin/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }); }
}
