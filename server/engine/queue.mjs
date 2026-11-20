// 任务队列：单进程内 worker 池，从 SQLite 抢 queued 任务执行。
// 单机部署够用；要横向扩就把 claimNext 换成 SELECT ... FOR UPDATE SKIP LOCKED。
import { config } from '../config.mjs';
import { jobs, users } from '../db.mjs';
import { open } from '../crypto.mjs';
import { upstream } from '../upstream/index.mjs';
import { Canceled, TimedOut, Support, runJob } from './pipeline.mjs';

let running = 0;
let timer = null;
let stopped = false;

const PHASE_LABELS = new Set([
  'starting', 'preflight', 'loading', 'loading_resources', 'collecting', 'bank_lookup', 'bank_saved',
  'generating', 'validating', 'saving', 'selftesting', 'submitting', 'evaluating', 'polling',
  'verifying', 'repairing', 'completed',
]);

function normalisePhase(phase) {
  return PHASE_LABELS.has(phase) ? phase : 'preparing';
}

export function startWorker() {
  stopped = false;
  const stale = jobs.resetStale();
  if (stale) console.warn(`[worker] 标记 ${stale} 个中断任务为 interrupted`);
  const loop = async () => {
    if (stopped) return;
    try {
      while (running < config.worker.concurrency) {
        const job = jobs.claimNext();
        if (!job) break;
        running += 1;
        void execute(job).finally(() => { running -= 1; });
      }
    } catch (error) {
      console.error('[worker] 调度失败', error);
    }
    timer = setTimeout(loop, config.worker.pollMs);
    timer.unref?.();
  };
  void loop();
}

export function stopWorker() {
  stopped = true;
  if (timer) clearTimeout(timer);
}

async function execute(job) {
  const user = users.byId(job.owner_id);
  if (!user) {
    jobs.update(job.id, { status: 'failed', error_code: 'owner_missing', error_message: '任务所属账号不存在', finished_at: new Date().toISOString() });
    return;
  }
  const raw = open(user.upstream_cookie);
  if (!raw) {
    jobs.update(job.id, {
      status: 'failed',
      error_code: 'UPSTREAM_AUTH_EXPIRED',
      error_message: '头歌登录状态已失效，请重新登录。',
      finished_at: new Date().toISOString(),
    });
    return;
  }
  // 存的是 { cookie, trustie, zzud, uid } 的 JSON；兼容旧的纯 cookie 字符串
  let cookie = raw;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.cookie) cookie = parsed;
    } catch { /* 保持原样 */ }
  }

  let submission = null;
  const ctx = {
    request: job.request,
    userId: user.id,
    login: user.login,
    cookie,
    upstream: upstream(),
    cancelled: () => jobs.cancelRequested(job.id),
    onPhase(phase) {
      const current = jobs.byId(job.id);
      if (!current || ['canceled', 'failed', 'succeeded'].includes(current.status)) return;
      jobs.update(job.id, { phase: normalisePhase(phase) });
    },
    onRow(rows) {
      jobs.update(job.id, {
        result: { ...(jobs.byId(job.id)?.result ?? {}), homeworks: rows },
      });
    },
    onProgress(progress) {
      const current = jobs.byId(job.id);
      jobs.update(job.id, { progress: { ...(current?.progress ?? {}), ...progress } });
    },
    onSubmission(payload) {
      submission = payload;
    },
  };

  try {
    const outcome = await runJob(job, ctx);
    const finishedAt = new Date().toISOString();
    const current = jobs.byId(job.id);
    jobs.update(job.id, {
      status: outcome.status,
      phase: outcome.status === 'succeeded' ? 'completed' : 'failed',
      result: { ...(current?.result ?? {}), ...(outcome.result ?? {}) },
      progress: { ...(current?.progress ?? {}), ...(outcome.progress ?? {}) },
      finished_at: finishedAt,
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (error instanceof Canceled) {
      jobs.update(job.id, { status: 'canceled', phase: 'canceled', error_code: 'canceled', error_message: '管理员或用户已停止执行', finished_at: finishedAt });
      return;
    }
    if (error instanceof TimedOut) {
      jobs.update(job.id, { status: 'failed', phase: 'failed', error_code: 'time_limit', error_message: '整批执行达到时间上限，尚未开始此作业', finished_at: finishedAt });
      return;
    }
    if (error instanceof Support || error?.support) {
      jobs.update(job.id, {
        status: 'succeeded',
        phase: 'completed',
        result: { ...(jobs.byId(job.id)?.result ?? {}), service_status: 'support', reason_code: error.code, message: error.message },
        error_code: error.code,
        error_message: error.message,
        finished_at: finishedAt,
      });
      return;
    }
    const code = error?.code ?? 'execution_failed';
    const message = error?.message ?? '执行未完成，需要检查原始响应';
    if (code === 'UPSTREAM_AUTH_EXPIRED') {
      users.setUpstream(user.id, { cookie: null, uid: user.upstream_uid });
    }
    // 任务级异常时，把还停在「处理中」的作业行标成失败，别让进度页一直显示正在处理
    const current = jobs.byId(job.id);
    const previous = current?.result ?? {};
    const rows = Array.isArray(previous.homeworks)
      ? previous.homeworks.map(row => (row.status === 'processing'
        ? { ...row, status: 'failed', reason_code: code }
        : row))
      : previous.homeworks;
    jobs.update(job.id, {
      status: 'failed',
      phase: 'failed',
      result: {
        ...previous,
        ...(rows ? { homeworks: rows } : {}),
        service_status: 'support',
        error_code: code,
        error_message: message,
      },
      error_code: code,
      error_message: message,
      finished_at: finishedAt,
    });
    console.error(`[worker] 任务 ${job.id} 失败`, code, message);
  } finally {
    void submission;
  }
}

export function queueStats() {
  return { running, concurrency: config.worker.concurrency };
}
