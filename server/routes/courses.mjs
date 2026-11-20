// /api/courses/*
// 管理员没有绑定头歌账号：返回空列表而不是 401，避免管理会话被上游状态踢掉。
import { requireUser, upstreamCookie } from '../auth.mjs';
import { users } from '../db.mjs';
import { errors } from '../http.mjs';
import { upstream } from '../upstream/index.mjs';

const up = () => upstream();

const hasUpstream = (user) => Boolean(users.upstream(user.id)?.cookie);

function requireUpstream(user) {
  try {
    return upstreamCookie(user);
  } catch (error) {
    if (user.role === 'admin') return null;
    throw error;
  }
}

const emptyCourseView = (user) => user.role === 'admin';

export const courseRoutes = [
  {
    method: 'GET',
    path: '/api/courses',
    async handler(ctx) {
      const user = requireUser(ctx.req);
      const cookie = requireUpstream(user);
      if (!cookie && emptyCourseView(user)) return { courses: [] };
      const courses = await up().courses(cookie, user.login);
      return { courses };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/courses\/([^/]+)\/homeworks$/,
    async handler(ctx, [identifier]) {
      const user = requireUser(ctx.req);
      const cookie = requireUpstream(user);
      if (!cookie && emptyCourseView(user)) return { homeworks: [] };
      const homeworks = await up().homeworks(cookie, user.login, decodeURIComponent(identifier));
      return { homeworks };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/courses\/([^/]+)\/exercises$/,
    async handler(ctx, [identifier]) {
      const user = requireUser(ctx.req);
      const cookie = requireUpstream(user);
      if (!cookie && emptyCourseView(user)) return { items: [], courseIdentifier: decodeURIComponent(identifier) };
      const courseIdentifier = decodeURIComponent(identifier);
      const items = await up().exercises(cookie, user.login, courseIdentifier);
      return { items, courseIdentifier };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/courses\/([^/]+)\/homeworks\/(\d+)\/enter$/,
    async handler(ctx, [identifier, homeworkId]) {
      const user = requireUser(ctx.req);
      const cookie = requireUpstream(user);
      if (!cookie) throw errors.upstreamAuth('管理员账号没有绑定头歌会话');
      return up().enter(cookie, user.login, decodeURIComponent(identifier), Number(homeworkId));
    },
  },
];

export { hasUpstream };
