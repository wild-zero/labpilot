// /api/auth/*
import { config } from '../config.mjs';
import { audit } from '../db.mjs';
import { clearCookie, currentUser, login as doLogin, logout as doLogout, sessionCookie, viewUser } from '../auth.mjs';
import { data, errors, raw, readJSON } from '../http.mjs';

export const authRoutes = [
  {
    method: 'GET',
    path: '/api/auth/config',
    async handler() {
      return {
        access_card_required: config.accessCardRequired,
        upstream: config.upstream,
        solver: config.solver.provider,
      };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    async handler(ctx) {
      const body = await readJSON(ctx.req);
      const { user, sessionId } = await doLogin({
        login: body.login,
        password: body.password,
        accessCode: body.access_code,
      }, ctx.req);
      return data(viewUser(user), { 'Set-Cookie': sessionCookie(sessionId) });
    },
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    async handler(ctx) {
      const user = currentUser(ctx.req);
      if (!user) throw errors.unauthenticated();
      return viewUser(user);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    async handler(ctx) {
      const user = currentUser(ctx.req);
      doLogout(ctx.req);
      if (user) audit.write({ actorId: user.id, actorName: user.name, action: 'auth.logout', target: user.id });
      return data({ ok: true }, { 'Set-Cookie': clearCookie() });
    },
  },
  {
    method: 'GET',
    path: '/api/avatar',
    async handler(ctx) {
      const user = currentUser(ctx.req);
      if (!user) throw errors.unauthenticated();
      const initial = (user.name || user.login || '同').slice(0, 1).replace(/[<>&"']/g, '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<rect width="96" height="96" rx="48" fill="#e8eefc"/>
<text x="48" y="62" font-size="40" font-family="system-ui,-apple-system,'PingFang SC',sans-serif" fill="#3061d0" text-anchor="middle">${initial}</text>
</svg>`;
      return raw(svg, 'image/svg+xml; charset=utf-8');
    },
  },
];
