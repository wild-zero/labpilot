// 任务展示层：状态映射、进度计算、列表与详情渲染。
import { count, dateTime, escapeHtml as e, record } from './ui.js';

export const pendingJob = (job) => ['queued', 'running', 'waiting', 'processing'].includes(job.status);
export const serviceJob = (job) => job.request?.mode !== 'collect_verified';

/** 任务本身已经结束（不再推进），但里面可能有几份要人工跟进 */
export const jobFinished = (job) => !pendingJob(job);

/** 这次安排里需要人工跟进的作业数 */
export function attentionCount(job) {
  const rows = Array.isArray(job.result?.homeworks) ? job.result.homeworks : [];
  return rows.filter(row => ['failed', 'support'].includes(String(row.status))).length;
}

const terminal = new Set(['succeeded', 'failed', 'canceled', 'uncertain', 'interrupted', 'completed', 'support', 'submitted', 'awaiting_review', 'graded']);

function targetOf(job, index) {
  const request = job.request ?? {};
  if (!request.scope) return `record:${index}`;
  return JSON.stringify([request.mode, request.scope, request.course ?? '', request.homework_id ?? 0, request.game ?? '', request.exercise_id ?? 0]);
}

export function partitionServiceJobs(jobs) {
  const ordered = jobs
    .filter(serviceJob)
    .map((job, index) => ({ job, index, target: targetOf(job, index) }))
    .sort((a, b) => {
      const diff = Date.parse(b.job.created_at) - Date.parse(a.job.created_at);
      return (Number.isFinite(diff) ? diff : 0) || a.index - b.index;
    });
  const live = new Set(ordered.filter(item => pendingJob(item.job)).map(item => item.target));
  const current = [];
  const history = [];
  const seen = new Set();
  for (const { job, target } of ordered) {
    if (terminal.has(job.status) && (live.has(target) || seen.has(target))) history.push(job);
    else current.push(job);
    seen.add(target);
  }
  return { current, history };
}

export const currentServiceJobs = (jobs) => partitionServiceJobs(jobs).current;
export const activeJobs = (jobs) => jobs.filter(job => serviceJob(job) && pendingJob(job));

export function serviceStatus(job) {
  const result = record(job.result);
  const publicStatus = result.service_status ?? record(job.progress).service_status;
  if (job.request?.scope === 'exercise') {
    if (job.status === 'queued') return 'waiting';
    if (job.status === 'running') return 'processing';
    if (result.submitted === true) {
      if (result.score_known === true) return 'graded';
      return publicStatus === 'submitted' ? 'submitted' : 'awaiting_review';
    }
    if (job.status === 'canceled') return 'stopped';
    if (['submitted', 'awaiting_review', 'graded'].includes(String(publicStatus))) return publicStatus;
    return 'support';
  }
  if (['waiting', 'processing', 'support', 'completed', 'stopped'].includes(String(publicStatus))) return publicStatus;
  if (job.status === 'queued') return 'waiting';
  if (job.status === 'running') return 'processing';
  if (job.status === 'canceled') return 'stopped';
  if (job.status === 'succeeded') return publicStatus === 'support' ? 'support' : 'completed';
  return 'support';
}

export const serviceLabels = {
  waiting: '等待安排',
  processing: '正在处理',
  support: '已结束 · 需跟进',
  completed: '已完成',
  stopped: '已停止',
  submitted: '已交卷',
  awaiting_review: '待公布成绩',
  graded: '成绩已公布',
};

export function jobTitle(job, courses = []) {
  const request = job.request ?? {};
  const result = record(job.result);
  if (request.scope === 'all') return '全部课程的未完成作业';
  const course = courses.find(item => item.identifier === request.course);
  const resultTitle = typeof result.title === 'string' ? result.title : '';
  if (request.scope === 'exercise') return resultTitle || '在线考试';
  if (request.scope === 'course') return course?.name ?? '课程作业';
  return resultTitle || (course ? `${course.name}的作业` : '作业完成服务');
}

export function jobProgress(job) {
  const data = { ...record(job.result), ...record(job.progress) };
  const homeworks = count(data.total_homeworks);
  const questions = count(data.total_questions);
  const exercise = job.request?.scope === 'exercise';
  const total = exercise ? questions : homeworks || count(data.total_levels);
  const done = Math.min(total, exercise
    ? count(data.completed_questions)
    : homeworks ? count(data.completed_homeworks) : count(data.completed_levels));
  const status = serviceStatus(job);
  return {
    completed: done,
    total,
    unit: exercise ? '道题' : homeworks ? '份作业' : '关',
    percent: total ? Math.round(done / total * 100) : ['completed', 'graded', 'submitted', 'awaiting_review'].includes(status) ? 100 : 0,
  };
}

const label = (status, historical) => {
  if (!historical) return serviceLabels[status] ?? '处理中';
  if (status === 'submitted' || status === 'awaiting_review') return '当次已交卷';
  if (status === 'graded') return '当次已评分';
  return status === 'completed' ? '当次已完成' : status === 'stopped' ? '当次已停止' : '当次未完成';
};

function progressText(job) {
  const progress = jobProgress(job);
  const status = serviceStatus(job);
  if (job.request?.scope === 'exercise' && ['submitted', 'awaiting_review', 'graded'].includes(status)) {
    return `已交卷${progress.total ? ` · 共 ${progress.total} 道题` : ''}`;
  }
  if (progress.total) return `${progress.completed} / ${progress.total} ${progress.unit}`;
  return status === 'completed' ? '已完成' : '进度待更新';
}

export function renderServiceJob(job, courses = [], historical = false) {
  const status = serviceStatus(job);
  const progress = jobProgress(job);
  const finished = jobFinished(job);
  const attention = attentionCount(job);
  const submitted = job.request?.scope === 'exercise' && ['submitted', 'awaiting_review', 'graded'].includes(status);

  // 任务已经结束但有几份要人工跟进：别说成「进行中」
  const badgeText = finished && attention
    ? `已结束 · ${attention} 份需跟进`
    : label(status, historical);
  const symbol = !finished ? '◌' : attention ? '!' : '✓';

  return `<article class="service-job service-job-compact ${historical ? 'stopped' : status}${historical ? ' service-job-history' : ''}">
    <div class="job-heading">
      <span class="job-symbol" aria-hidden="true">${symbol}</span>
      <div><h3>${e(jobTitle(job, courses))}</h3><p class="meta">${e(dateTime(job.created_at))} ${historical ? '当次安排' : '安排'}${finished ? ` · ${e(dateTime(job.finished_at))} 结束` : ''}</p></div>
      <span class="badge ${historical ? 'stopped' : attention ? 'support' : status}">${badgeText}</span>
    </div>
    <div class="job-footer">
      <div class="job-progress">
        ${submitted ? '' : `<div class="progress-track" aria-hidden="true"><span style="width:${progress.percent}%"></span></div>`}
        <span>${historical ? '当次进度 · ' : ''}${progressText(job)}${finished && attention ? ` · ${attention} 份转人工` : ''}</span>
      </div>
      <button class="text-button" data-job-detail="${e(job.id)}"${historical ? ' data-job-history="true"' : ''}>${historical ? '查看记录' : '查看详情'}</button>
    </div>
  </article>`;
}

export function renderJobs(jobs, courses = [], historyOpen = false) {
  const { current, history } = partitionServiceJobs(jobs);
  if (!current.length && !history.length) {
    return '<div class="empty"><span class="empty-circle">✓</span><h3>每一份安排，都会在这里记录</h3><p>先选择课程，接下来的事情交给我们。</p></div>';
  }
  const running = current.filter(job => !jobFinished(job)).length;
  const done = current.filter(job => jobFinished(job) && attentionCount(job) === 0).length;
  const attention = current.filter(job => jobFinished(job) && attentionCount(job) > 0).length;
  return `<section class="service-progress-list" aria-label="完成进度">
    <div class="service-progress-summary">
      <h2>当前安排 <span class="count">${current.length}</span></h2>
      <p>${running ? `<span>处理中 <b>${running}</b></span>` : ''}${done ? `<span>已完成 <b>${done}</b></span>` : ''}${attention ? `<span>已结束·需跟进 <b>${attention}</b></span>` : ''}</p>
    </div>
    <div class="service-jobs" data-service-current>${current.map(job => renderServiceJob(job, courses)).join('')}</div>
    ${history.length ? `<details class="service-history" data-service-history${historyOpen ? ' open' : ''}>
      <summary><span>历史记录 <span class="count">${history.length}</span></span><span class="service-history-hint">查看之前的安排</span></summary>
      <p class="service-history-note">以下仅记录之前的安排，最新完成情况请以上方当前安排为准。</p>
      <div class="service-jobs" data-service-history-list>${history.map(job => renderServiceJob(job, courses, true)).join('')}</div>
    </details>` : ''}
  </section>`;
}

export function renderServiceDetail(job, courses = [], historical = false) {
  const result = record(job.result);
  const rows = Array.isArray(result.homeworks) ? result.homeworks.map(record) : [];
  const status = serviceStatus(job);
  const exercise = job.request?.scope === 'exercise';
  const note = exercise
    ? historical ? '历史记录：以下为当次考试安排和交卷状态，最新结果请查看当前安排。'
      : status === 'graded' ? `考试成绩已公布。${result.score_known === true ? `成绩 ${e(result.score)}` : ''}`
        : status === 'awaiting_review' || status === 'submitted' ? '已交卷，成绩以头歌公布为准。'
          : status === 'support' ? '考试事项由服务人员跟进，无需重复安排。'
            : '服务人员会处理整场考试，完成后显示交卷状态。'
    : historical ? '历史记录：以下为当次安排的进度，不代表当前仍在处理。'
      : jobFinished(job)
        ? (attentionCount(job)
          ? `这次安排已经结束（${e(dateTime(job.finished_at))}），其中 ${attentionCount(job)} 份判分没通过，需要人工跟进，其余已完成。`
          : `这次安排已经结束（${e(dateTime(job.finished_at))}），结果都已核验通过。`)
        : status === 'support' ? '放心，服务人员正在处理，无需重复提交。'
          : status === 'completed' ? '本次服务已经完成，结果已核验。'
            : status === 'stopped' ? '本次服务已停止，已完成的结果会保留。'
              : '我们会按顺序完成未完成的内容。你可以随时回来查看。';

  const list = rows.length ? `<ol class="completion-list">${rows.map((row, index) => {
    const done = ['passed', 'skipped', 'completed', 'succeeded'].includes(String(row.status));
    const text = historical ? (done ? '当次已完成' : '当次未完成')
      : row.status === 'deadline_passed' ? '已截止，未提交'
        : done ? '已完成'
          : row.status === 'support' ? '需要跟进（有关卡未通过）'
            : row.status === 'processing' ? '正在处理'
              : row.status === 'failed' ? `需要跟进${row.reason_code ? ` · ${row.reason_code}` : ''}`
                : '待完成';
    const levels = Array.isArray(row.levels) ? row.levels : [];
    const levelRows = levels.map(level => {
      const source = level.source === 'bank' ? '题库'
        : level.source === 'platform' ? '平台已通过'
          : level.source ? '模型' : '';
      const mark = level.status === 'passed' ? '✓' : level.status === 'skipped' ? '·' : '×';
      return `<p class="muted">　${mark} ${e(level.title ?? '关卡')}${source ? ` · ${source}` : ''}${level.attempts > 1 ? ` · 试${level.attempts}次` : ''}</p>`;
    }).join('');
    return `<li><span class="completion-icon ${done ? 'done' : ''}">${done ? '✓' : index + 1}</span><div><strong>${e(row.title || `作业 ${index + 1}`)}</strong><p>${e(text)}</p>${levelRows}</div></li>`;
  }).join('')}</ol>` : `<p class="muted">${historical ? '当次未记录详细进度。' : '详细完成进度会在处理后更新。'}</p>`;

  const action = !historical && pendingJob(job) ? `<button class="button" data-cancel-job="${e(job.id)}">停止本次安排</button>` : '';
  // 中断/失败/已停止的任务给出恢复或重跑入口（服务端会二次校验 can_retry / can_recover）
  const recover = job.can_recover ? `<button class="button" data-recover-job="${e(job.id)}">恢复这次任务</button>` : '';
  const retry = !job.can_recover && job.can_retry && !historical && !pendingJob(job)
    ? `<button class="button" data-retry-job="${e(job.id)}">重新安排一次</button>` : '';

  return `<h2>${e(jobTitle(job, courses))}</h2>
    <p class="subtext">${e(dateTime(job.created_at))} ${historical ? '当次安排' : '创建'}</p>
    <span class="badge ${historical ? 'stopped' : status}">${label(status, historical)}</span>
    <div class="detail-note">${note}</div>
    ${list}
    ${job.error_message ? `<p class="subtext">处理说明：${e(job.error_message)}</p>` : ''}
    <div class="modal-actions">${action}${recover}${retry}<button class="button" data-action="close-modal">关闭</button></div>`;
}
