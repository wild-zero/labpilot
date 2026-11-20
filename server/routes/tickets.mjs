// /api/tickets/* —— 用户侧反馈工单。
//
// 用户侧反馈工单接口：
//   GET  /api/tickets?limit&cursor&status        -> { items, next_cursor }
//   POST /api/tickets { subject, category, body, idempotency_key } -> ticket detail
//   GET  /api/tickets/{id}                       -> { ticket, messages }
//   POST /api/tickets/{id}/messages { body, idempotency_key }
//   POST /api/tickets/{id}/status { status }     -> 用户只能关闭/重开自己的工单
import { audit, tickets, users, TICKET_CATEGORIES, TICKET_STATUSES } from '../db.mjs';
import { requireUser } from '../auth.mjs';
import { errors, readJSON } from '../http.mjs';

const subject = (value) => String(value ?? '').trim().slice(0, 100);
const bodyText = (value) => String(value ?? '').trim().slice(0, 5000);
const category = (value) => (TICKET_CATEGORIES.includes(value) ? value : 'other');

async function detailOf(ticketId) {
  const ticket = tickets.byId(ticketId);
  if (!ticket) throw errors.notFound('反馈记录不存在。');
  const owner = users.byId(ticket.owner_id);
  return {
    ticket: {
      ...ticket,
      user: { id: ticket.owner_id, name: owner?.name || owner?.login || '', login: owner?.login ?? '' },
    },
    messages: tickets.messages(ticketId),
  };
}

export const ticketRoutes = [
  {
    method: 'GET',
    path: '/api/tickets',
    async handler(ctx) {
      const user = requireUser(ctx.req);
      const status = ctx.url.searchParams.get('status');
      const page = tickets.list({
        ownerId: user.id,
        status: TICKET_STATUSES.includes(status) ? status : null,
        limit: Number(ctx.url.searchParams.get('limit') ?? 20),
        cursor: ctx.url.searchParams.get('cursor'),
      });
      return { items: page.items, next_cursor: page.nextCursor };
    },
  },
  {
    method: 'POST',
    path: '/api/tickets',
    async handler(ctx) {
      const user = requireUser(ctx.req);
      const body = await readJSON(ctx.req);
      const title = subject(body.subject);
      const text = bodyText(body.body);
      if (title.length < 2) throw errors.invalid('请填写问题标题（至少 2 个字）。');
      if (text.length < 5) throw errors.invalid('请把问题说明写清楚一些（至少 5 个字）。');
      const created = tickets.create({
        ownerId: user.id,
        subject: title,
        category: category(body.category),
        body: text,
        authorId: user.id,
        authorName: user.name,
        idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key.slice(0, 120) : null,
      });
      audit.write({ actorId: user.id, actorName: user.name, action: 'ticket.create', target: created.id, detail: { category: created.category } });
      return detailOf(created.id);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tickets\/([^/]+)$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const ticket = tickets.byIdForOwner(id, user.id);
      if (!ticket) throw errors.notFound('反馈记录不存在。');
      return detailOf(id);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/tickets\/([^/]+)\/messages$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const ticket = tickets.byIdForOwner(id, user.id);
      if (!ticket) throw errors.notFound('反馈记录不存在。');
      if (ticket.status === 'closed') throw errors.invalid('这条反馈已关闭，请先重新打开再补充说明。');
      const payload = await readJSON(ctx.req);
      const text = bodyText(payload.body);
      if (text.length < 2) throw errors.invalid('补充内容太短了。');
      tickets.addMessage({
        ticketId: id,
        authorId: user.id,
        authorName: user.name,
        authorRole: 'user',
        body: text,
        idempotencyKey: typeof payload.idempotency_key === 'string' ? payload.idempotency_key.slice(0, 120) : null,
      });
      audit.write({ actorId: user.id, actorName: user.name, action: 'ticket.reply', target: id });
      return detailOf(id);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/tickets\/([^/]+)\/status$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const ticket = tickets.byIdForOwner(id, user.id);
      if (!ticket) throw errors.notFound('反馈记录不存在。');
      const payload = await readJSON(ctx.req);
      // 用户只能关闭或重新打开；处理中/已解决由服务人员决定
      if (!['closed', 'open'].includes(payload.status)) throw errors.invalid('只能关闭或重新打开反馈。');
      tickets.setStatus(id, payload.status);
      audit.write({ actorId: user.id, actorName: user.name, action: 'ticket.status', target: id, detail: { status: payload.status } });
      return detailOf(id);
    },
  },
];
