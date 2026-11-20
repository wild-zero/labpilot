// /api/admin/*
import { audit, bank, cards, jobActions, jobs, tickets, TICKET_STATUSES, users } from '../db.mjs';
import { requireAdmin, viewUser } from '../auth.mjs';
import { cardHash, generateCardCode } from '../crypto.mjs';
import { errors, readJSON } from '../http.mjs';

const withActions = (job) => (job ? { ...job, ...jobActions(job) } : job);
const ticketDetail = (id) => {
  const ticket = tickets.byId(id);
  if (!ticket) throw errors.notFound('反馈记录不存在。');
  const owner = users.byId(ticket.owner_id);
  return {
    ticket: { ...ticket, user: { id: ticket.owner_id, name: owner?.name || owner?.login || '', login: owner?.login ?? '' } },
    messages: tickets.messages(id),
  };
};

export const adminRoutes = [
  {
    method: 'GET',
    path: '/api/admin/overview',
    async handler(ctx) {
      requireAdmin(ctx.req);
      const stats = jobs.stats();
      const all = jobs.listAll();
      const active = all.filter(job => ['queued', 'running', 'waiting', 'processing'].includes(job.status));
      const attention = all.filter(job => ['failed', 'uncertain', 'interrupted'].includes(job.status) || job.result?.service_status === 'support');
      return {
        users: users.count(),
        jobs: all.length,
        active: active.length,
        attention: attention.length,
        completed: stats.succeeded ?? 0,
        bank: bank.count(),
        cards: cards.list().filter(card => card.status === 'active').length,
        tickets: tickets.counts(),
        tickets_open: (tickets.counts().open ?? 0) + (tickets.counts().processing ?? 0),
        by_status: stats,
        upstream: globalThis.__labpilot_upstream ?? 'unknown',
      };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/users',
    async handler(ctx) {
      requireAdmin(ctx.req);
      return { users: users.all().map(row => ({ ...viewUser(row), created_at: row.created_at })) };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/jobs',
    async handler(ctx) {
      requireAdmin(ctx.req);
      return { jobs: jobs.listAll().map(withActions) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/jobs\/([^/]+)\/retry$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      const job = jobs.byId(id);
      if (!job) throw errors.notFound('任务不存在。');
      const request = job.request ?? {};
      const created = jobs.create({
        ownerId: job.owner_id,
        mode: request.mode ?? job.mode,
        scope: request.scope ?? job.scope,
        request,
        idempotencyKey: `admin-retry:${job.id}:${Date.now()}`,
      });
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.job.retry', target: created.id, detail: { from: job.id } });
      return withActions(created);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/jobs\/([^/]+)\/recover$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      const job = jobs.byId(id);
      if (!job) throw errors.notFound('任务不存在。');
      if (!jobActions(job).can_recover) throw errors.invalid('这个任务当前不需要恢复。');
      const requeued = jobs.requeue(id);
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.job.recover', target: id });
      return withActions(requeued);
    },
  },
  {
    method: 'GET',
    path: '/api/admin/tickets',
    async handler(ctx) {
      requireAdmin(ctx.req);
      const status = ctx.url.searchParams.get('status');
      const page = tickets.list({
        status: TICKET_STATUSES.includes(status) ? status : null,
        limit: Number(ctx.url.searchParams.get('limit') ?? 20),
        cursor: ctx.url.searchParams.get('cursor'),
        withUser: true,
      });
      return { items: page.items, next_cursor: page.nextCursor };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/admin\/tickets\/([^/]+)$/,
    async handler(ctx, [id]) {
      requireAdmin(ctx.req);
      return ticketDetail(id);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/tickets\/([^/]+)\/messages$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      const ticket = tickets.byId(id);
      if (!ticket) throw errors.notFound('反馈记录不存在。');
      const payload = await readJSON(ctx.req);
      const text = String(payload.body ?? '').trim().slice(0, 5000);
      if (text.length < 2) throw errors.invalid('回复内容太短了。');
      tickets.addMessage({
        ticketId: id,
        authorId: admin.id,
        authorName: admin.name,
        authorRole: 'admin',
        body: text,
        idempotencyKey: typeof payload.idempotency_key === 'string' ? payload.idempotency_key.slice(0, 120) : null,
      });
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.ticket.reply', target: id });
      return ticketDetail(id);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/tickets\/([^/]+)\/status$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      const ticket = tickets.byId(id);
      if (!ticket) throw errors.notFound('反馈记录不存在。');
      const payload = await readJSON(ctx.req);
      if (!TICKET_STATUSES.includes(payload.status)) throw errors.invalid('工单状态不正确。');
      tickets.setStatus(id, payload.status);
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.ticket.status', target: id, detail: { status: payload.status } });
      return ticketDetail(id);
    },
  },
  {
    method: 'GET',
    path: '/api/admin/audit',
    async handler(ctx) {
      requireAdmin(ctx.req);
      return { audit: audit.list(200) };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/cards',
    async handler(ctx) {
      requireAdmin(ctx.req);
      return { items: cards.list() };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/users\/([^/]+)\/status$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      const body = await readJSON(ctx.req);
      const status = body.status === 'active' ? 'active' : 'disabled';
      const target = users.byId(id);
      if (!target) throw errors.notFound('用户不存在。');
      users.setStatus(id, status);
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.user.status', target: id, detail: { status } });
      return viewUser(users.byId(id));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/jobs\/([^/]+)\/cancel$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      const job = jobs.byId(id);
      if (!job) throw errors.notFound('任务不存在。');
      jobs.requestCancel(id);
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.job.cancel', target: id });
      return jobs.byId(id);
    },
  },
  {
    method: 'POST',
    path: '/api/admin/cards',
    async handler(ctx) {
      const admin = requireAdmin(ctx.req);
      const body = await readJSON(ctx.req);
      const code = generateCardCode();
      const id = cards.create({
        codeHash: cardHash(code),
        label: typeof body.label === 'string' ? body.label.slice(0, 80) : '服务卡密',
        createdBy: admin.id,
        reusable: body.reusable ? 1 : 0,
      });
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.card.create', target: id, detail: { label: body.label ?? '' } });
      // 明文只返回这一次
      return { id, access_code: code };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/cards\/([^/]+)\/revoke$/,
    async handler(ctx, [id]) {
      const admin = requireAdmin(ctx.req);
      cards.revoke(id);
      audit.write({ actorId: admin.id, actorName: admin.name, action: 'admin.card.revoke', target: id });
      return { ok: true };
    },
  },
];
