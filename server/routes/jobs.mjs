// /api/jobs/*
import { config } from '../config.mjs';
import { audit, jobActions, jobs } from '../db.mjs';
import { requireUser } from '../auth.mjs';
import { errors, readJSON } from '../http.mjs';

const MODES = new Set(['submit', 'selftest', 'generate_only', 'collect_verified']);
const SCOPES = new Set(['all', 'course', 'homework', 'current', 'exercise']);

/** 前端要这两个布尔值来决定按钮能不能点 */
const withActions = (job) => (job ? { ...job, ...jobActions(job) } : job);

function validate(body) {
  const mode = MODES.has(body.mode) ? body.mode : 'submit';
  const scope = SCOPES.has(body.scope) ? body.scope : 'course';
  const request = { mode, scope };

  if (scope !== 'all') {
    if (typeof body.course !== 'string' || !body.course.trim()) throw errors.invalid('请选择课程。');
    request.course = body.course.trim();
  }
  if (scope === 'homework' || scope === 'current') {
    const id = Number(body.homework_id);
    if (!Number.isSafeInteger(id) || id < 1) throw errors.invalid('作业标识不正确。');
    request.homework_id = id;
  }
  if (scope === 'current') {
    if (typeof body.game !== 'string' || !body.game.trim()) throw errors.invalid('关卡标识不正确。');
    request.game = body.game.trim();
  }
  if (scope === 'exercise') {
    const id = Number(body.exercise_id);
    if (!Number.isSafeInteger(id) || id < 1) throw errors.invalid('考试标识不正确。');
    request.exercise_id = id;
  }
  return request;
}

const targetOf = (request) => JSON.stringify([
  request.mode, request.scope,
  request.scope === 'all' ? '' : request.course ?? '',
  request.scope === 'homework' || request.scope === 'current' ? request.homework_id ?? 0 : 0,
  request.scope === 'current' ? request.game ?? '' : '',
  request.scope === 'exercise' ? request.exercise_id ?? 0 : 0,
]);

const isPending = (status) => ['queued', 'running', 'waiting', 'processing'].includes(status);

export const jobRoutes = [
  {
    method: 'GET',
    path: '/api/jobs',
    async handler(ctx) {
      const user = requireUser(ctx.req);
      return { jobs: jobs.listForOwner(user.id).map(withActions) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/jobs\/([^/]+)$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const job = jobs.byIdForOwner(id, user.id);
      if (!job) throw errors.notFound('任务不存在。');
      return withActions(job);
    },
  },
  {
    method: 'POST',
    path: '/api/jobs',
    async handler(ctx) {
      const user = requireUser(ctx.req);
      if (!user.service_access) throw errors.forbidden('你的服务暂未开通，请联系服务人员。');
      const body = await readJSON(ctx.req);
      const request = validate(body);
      const key = typeof body.idempotency_key === 'string' ? body.idempotency_key.slice(0, 120) : null;

      if (key) {
        const existing = jobs.findByIdempotency(user.id, key);
        if (existing) return existing;
      }

      // 同一目标只保留一个当前安排，避免重复排队
      const target = targetOf(request);
      const duplicate = jobs.listForOwner(user.id).find(job => isPending(job.status) && targetOf(job.request) === target);
      if (duplicate) return duplicate;

      const created = jobs.create({
        ownerId: user.id,
        mode: request.mode,
        scope: request.scope,
        request,
        idempotencyKey: key,
      });
      audit.write({
        actorId: user.id, actorName: user.name,
        action: 'job.create', target: created.id,
        detail: { mode: request.mode, scope: request.scope, course: request.course ?? null },
      });
      return withActions(created);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/jobs\/([^/]+)\/cancel$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const job = jobs.byIdForOwner(id, user.id);
      if (!job) throw errors.notFound('任务不存在。');
      jobs.requestCancel(job.id);
      audit.write({ actorId: user.id, actorName: user.name, action: 'job.cancel', target: job.id });
      return withActions(jobs.byId(job.id));
    },
  },
  {
    // 中断/失败/已停止 → 原样重新排队（同一行，保留历史明细）
    method: 'POST',
    pattern: /^\/api\/jobs\/([^/]+)\/recover$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const job = jobs.byIdForOwner(id, user.id);
      if (!job) throw errors.notFound('任务不存在。');
      if (!jobActions(job).can_recover) throw errors.invalid('这个任务当前不需要恢复。');
      const pending = jobs.listForOwner(user.id).find(item => isPending(item.status) && targetOf(item.request) === targetOf(job.request));
      if (pending) return withActions(pending);
      const requeued = jobs.requeue(job.id);
      audit.write({ actorId: user.id, actorName: user.name, action: 'job.recover', target: job.id });
      return withActions(requeued);
    },
  },
  {
    // 重新安排一次：按原 request 新建一个任务，不覆盖历史
    method: 'POST',
    pattern: /^\/api\/jobs\/([^/]+)\/retry$/,
    async handler(ctx, [id]) {
      const user = requireUser(ctx.req);
      const job = jobs.byIdForOwner(id, user.id);
      if (!job) throw errors.notFound('任务不存在。');
      if (!user.service_access) throw errors.forbidden('你的服务暂未开通，请联系服务人员。');
      const pending = jobs.listForOwner(user.id).find(item => isPending(item.status) && targetOf(item.request) === targetOf(job.request));
      if (pending) return withActions(pending);
      const request = job.request ?? {};
      const created = jobs.create({
        ownerId: user.id,
        mode: request.mode ?? job.mode,
        scope: request.scope ?? job.scope,
        request,
        idempotencyKey: `retry:${job.id}:${Date.now()}`,
      });
      audit.write({ actorId: user.id, actorName: user.name, action: 'job.retry', target: created.id, detail: { from: job.id } });
      return withActions(created);
    },
  },
];

export const jobLimits = { ...config.limits };
