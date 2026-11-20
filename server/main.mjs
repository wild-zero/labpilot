// LabPilot · 实验自动化平台 —— 服务入口。
// 静态站点 + JSON API，单进程；任务由内嵌 worker 执行。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from './config.mjs';
import { ensureAdmin } from './auth.mjs';
import { ApiError, errors, requestId, sendData, sendError, sendJSON } from './http.mjs';
import { authRoutes } from './routes/auth.mjs';
import { courseRoutes } from './routes/courses.mjs';
import { jobRoutes } from './routes/jobs.mjs';
import { adminRoutes } from './routes/admin.mjs';
import { metaRoutes } from './routes/meta.mjs';
import { ticketRoutes } from './routes/tickets.mjs';
import { startWorker, stopWorker } from './engine/queue.mjs';
import { upstream } from './upstream/index.mjs';

const ROUTES = [...authRoutes, ...courseRoutes, ...jobRoutes, ...adminRoutes, ...metaRoutes, ...ticketRoutes];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'Strict-Transport-Security': 'max-age=31536000',
};

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.path && route.path === pathname) return { route, params: [] };
    if (route.pattern) {
      const match = route.pattern.exec(pathname);
      if (match) return { route, params: match.slice(1) };
    }
  }
  return null;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(join(config.webDir, normalize(rel).replace(/^([/\\])+/, '')));
  if (!target.startsWith(resolve(config.webDir) + sep) && target !== resolve(config.webDir)) {
    sendJSON(res, 403, { data: null, error: { code: 'FORBIDDEN', message: '路径不合法' } });
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA 回退
    const fallback = join(config.webDir, 'index.html');
    if (existsSync(fallback) && !extname(pathname)) {
      writeStatic(res, fallback, req);
      return;
    }
    sendJSON(res, 404, { data: null, error: { code: 'NOT_FOUND', message: '资源不存在' } });
    return;
  }
  writeStatic(res, target, req);
}

function writeStatic(res, file, req) {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const size = statSync(file).size;
  const headers = {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=60',
    ...SECURITY_HEADERS,
    'X-App-Version': VERSION,
    'X-Request-Id': req.__requestId ?? '',
  };
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

const VERSION = '0.1.0';

const server = createServer(async (req, res) => {
  const id = requestId();
  req.__requestId = id;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...SECURITY_HEADERS, 'X-Request-Id': id, Allow: 'GET, POST, OPTIONS' });
    res.end();
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    res.setHeader('X-Request-Id', id);
    serveStatic(req, res, url.pathname);
    return;
  }

  const hit = matchRoute(req.method ?? 'GET', url.pathname);
  if (!hit) {
    sendError(res, errors.notFound('接口不存在。'), id);
    return;
  }

  try {
    const result = await hit.route.handler({ req, res, url, requestId: id }, hit.params);
    if (result && result.__kind === 'raw') {
      res.writeHead(200, {
        'Content-Type': result.contentType,
        ...SECURITY_HEADERS,
        'X-App-Version': VERSION,
        'X-Request-Id': id,
        ...result.headers,
      });
      res.end(result.body);
      return;
    }
    if (result && result.__kind === 'data') {
      sendJSON(res, 200, { data: result.value, error: null, requestId: id }, {
        ...SECURITY_HEADERS,
        'X-App-Version': VERSION,
        'X-Request-Id': id,
        ...result.headers,
      });
      return;
    }
    sendJSON(res, 200, { data: result ?? null, error: null, requestId: id }, {
      ...SECURITY_HEADERS,
      'X-App-Version': VERSION,
      'X-Request-Id': id,
    });
  } catch (error) {
    sendError(res, error instanceof ApiError ? error : error, id);
  }
});

const up = upstream();
globalThis.__labpilot_upstream = up.name;

ensureAdmin();
startWorker();

server.listen(config.port, config.host, () => {
  console.log(`LabPilot · 服务已启动  http://${config.host}:${config.port}`);
  console.log(`  上游: ${up.name}   求解器: ${config.solver.provider}   数据库: ${config.dbFile}`);
  if (config.upstream === 'educoder' && (!config.educoder.ak || !config.educoder.sk)) {
    console.warn('  ⚠ 未配置 EDUCODER_AK / EDUCODER_SK，真实上游调用会失败；先跑 node scripts/extract-aksk.mjs');
  }
});

const shutdown = () => {
  stopWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
