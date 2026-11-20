// 运行时配置：环境变量优先，其次 .env，最后内置默认值。
// 默认走 mock 上游，确保 clone 下来即可跑通全流程。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const env = (key, fallback = '') => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};
const int = (key, fallback) => {
  const value = Number.parseInt(env(key, ''), 10);
  return Number.isFinite(value) ? value : fallback;
};
const bool = (key, fallback) => {
  const value = env(key, '').toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

const dataDir = resolve(ROOT, env('DATA_DIR', 'data'));
mkdirSync(dataDir, { recursive: true });

// 开发默认密钥：每次启动随机。生产必须显式配置，否则重启即掉线。
const sessionSecret = env('SESSION_SECRET') || randomBytes(32).toString('hex');
const encryptionKey = env('ENCRYPTION_KEY') || sessionSecret;

export const config = {
  root: ROOT,
  dataDir,
  webDir: resolve(ROOT, 'web'),
  dbFile: resolve(dataDir, 'labpilot.sqlite'),

  host: env('HOST', '127.0.0.1'),
  port: int('PORT', 8080),
  publicOrigin: env('PUBLIC_ORIGIN', ''),

  sessionSecret,
  encryptionKey,
  sessionTtlMs: int('SESSION_TTL_HOURS', 24 * 14) * 3600_000,

  // 上游：mock = 内置夹具；educoder = 真实头歌 API
  upstream: env('UPSTREAM', 'mock') === 'educoder' ? 'educoder' : 'mock',
  educoder: {
    base: env('EDUCODER_BASE', 'https://data.educoder.net/api'),
    web: env('EDUCODER_WEB', 'https://www.educoder.net'),
    // 平台客户端签名常量：取自 www.educoder.net 的 umi bundle（模块 527951，双 base64 编码）。
    // 平台换版本时需要重新提取：node scripts/extract-aksk.mjs
    ak: env('EDUCODER_AK', 'e9dd5b4322f9f7d83d009de9bfa100c3'),
    sk: env('EDUCODER_SK', '2e3da06ae26ba9f76a5d8d355746f2fe'),
    timeoutMs: int('EDUCODER_TIMEOUT_MS', 30_000),
    maxRetries: int('EDUCODER_MAX_RETRIES', 2),
  },

  // 求解器
  solver: {
    provider: env('SOLVER', 'mock') === 'openai' ? 'openai' : 'mock',
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    apiKey: env('OPENAI_API_KEY'),
    // 有些中转站只能通过本机代理访问（系统代理只对浏览器/.NET 生效，Node 不走）
    proxy: env('OPENAI_PROXY', ''),
    // 有些端点（含本机这个中转站）带 response_format 的长请求会 504，可直接关掉
    strictJson: bool('SOLVER_STRICT_JSON', true),
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    timeoutMs: int('SOLVER_TIMEOUT_MS', 120_000),
    temperature: Number(env('SOLVER_TEMPERATURE', '0.2')),
  },

  accessCardRequired: bool('ACCESS_CARD_REQUIRED', false),
  // 客观题是否自动逐题翻转补分（默认关：优先人工，避免烧提交次数）
  choiceFlip: bool('CHOICE_FLIP', false),
  allowSignup: bool('ALLOW_SIGNUP', false),
  adminLogin: env('ADMIN_LOGIN', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', 'admin12345'),

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 2),
    pollMs: int('WORKER_POLL_MS', 400),
  },

  limits: {
    maxCourses: int('LIMIT_MAX_COURSES', 50),
    maxHomeworks: int('LIMIT_MAX_HOMEWORKS', 200),
    maxLevels: int('LIMIT_MAX_LEVELS', 500),
    attempts: int('LIMIT_ATTEMPTS', 3),
    jobTimeMs: int('LIMIT_JOB_MINUTES', 30) * 60_000,
    bankCollectTimeMs: int('LIMIT_COLLECT_MINUTES', 3) * 60_000,
    collectReadBudget: int('LIMIT_COLLECT_READS', 200),
  },

  rateLimit: {
    loginWindowMs: int('RATE_LOGIN_WINDOW_SEC', 300) * 1000,
    loginMax: int('RATE_LOGIN_MAX', 10),
  },
};

export const isMock = () => config.upstream === 'mock';
