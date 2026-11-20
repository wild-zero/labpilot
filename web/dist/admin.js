// 管理后台渲染。
import { count, dateTime, escapeHtml as e, record } from './ui.js';
import { jobProgress, jobTitle, serviceLabels, serviceStatus } from './jobs.js';

const STATUS = {
  queued: '等待安排', running: '执行中', succeeded: '已完成', failed: '需要处理', uncertain: '待核验',
  interrupted: '已中断', canceled: '已停止', active: '正常', disabled: '已暂停',
};
const PHASE = {
  starting: '准备执行', preflight: '核对关卡清单', loading: '读取课程与作业', collecting: '采集关卡',
  bank_lookup: '查询题库答案', generating: '生成答案', saving: '保存代码', selftesting: '执行自测',
  submitting: '提交答案', evaluating: '等待评测', polling: '读取评测结果', verifying: '核验完成状态',
  repairing: '根据反馈修复', completed: '执行结束', failed: '执行结束，等待处理', preparing: '准备执行',
};

const badge = (status) => `<span class="badge ${status === 'failed' || status === 'interrupted' ? 'support' : status === 'succeeded' ? 'completed' : 'processing'}">${STATUS[status] ?? status}</span>`;

function overviewView(data) {
  const stats = record(data.by_status);
  return `<div class="page-heading"><div><h1>服务概览</h1><p>任务、用户与上游的当前状态。</p></div><button class="button" data-action="admin-refresh">刷新</button></div>
  <div class="content-grid">
    <section class="panel">
      <h2>运行指标</h2>
      <ul class="completion-list">
        <li><span class="completion-icon done">✓</span><div><strong>用户 ${count(data.users)}</strong><p>已连接头歌账号的账号数</p></div></li>
        <li><span class="completion-icon ${count(data.active) ? '' : 'done'}">${count(data.active) ? '·' : '✓'}</span><div><strong>执行中 ${count(data.active)}</strong><p>排队与处理中的任务</p></div></li>
        <li><span class="completion-icon ${count(data.attention) ? '' : 'done'}">${count(data.attention) ? '!' : '✓'}</span><div><strong>需要跟进 ${count(data.attention)}</strong><p>失败、中断或转人工的任务</p></div></li>
        <li><span class="completion-icon done">✓</span><div><strong>题库 ${count(data.bank)}</strong><p>已验证题目答案</p></div></li>
        <li><span class="completion-icon done">✓</span><div><strong>可用卡密 ${count(data.cards)}</strong><p>未使用、未停用的服务凭证</p></div></li>
      </ul>
    </section>
    <aside class="status-rail">
      <section class="panel">
        <h3>状态分布</h3>
        <ol>${Object.entries(stats).map(([key, value]) => `<li><b>${STATUS[key] ?? key}</b><p>${count(value)} 个任务</p></li>`).join('') || '<li><b>暂无数据</b><p>还没有任何任务。</p></li>'}</ol>
      </section>
      <section class="panel reassurance"><h3>上游</h3><p class="muted">${e(data.upstream ?? '')}</p></section>
    </aside>
  </div>`;
}

function usersView(users) {
  return `<div class="page-heading"><div><h1>用户管理</h1><p>暂停服务不会更改用户的头歌账号。</p></div><button class="button" data-action="admin-refresh">刷新</button></div>
  <section class="panel">
    <div class="completion-list">${users.map(user => `<li>
      <span class="completion-icon ${user.status === 'active' ? 'done' : ''}">${user.status === 'active' ? '✓' : '·'}</span>
      <div><strong>${e(user.name || user.login)}</strong>
        <p>${e(user.login)} · ${user.role === 'admin' ? '管理员' : '用户'} · ${STATUS[user.status] ?? user.status}${user.service_access === false ? ' · 服务未开通' : ''}</p>
      </div>
      ${user.role === 'admin' ? '<span class="badge completed">管理账号</span>' : `<button class="text-button" data-user-status="${e(user.id)}" data-next-status="${user.status === 'active' ? 'disabled' : 'active'}">${user.status === 'active' ? '暂停服务' : '恢复服务'}</button>`}
    </li>`).join('') || '<li><div><strong>还没有用户</strong><p>第一个登录的用户会出现在这里。</p></div></li>'}</div>
  </section>`;
}

function operationsView(jobs, view, kind) {
  const filtered = jobs.filter(job => kind === 'all' || (job.request?.mode === 'collect_verified') === (kind === 'collection'));
  const pending = new Set(filtered.filter(job => ['queued', 'running'].includes(job.status)).map(job => job.id));
  void pending;
  const rows = view === 'history' ? filtered.filter(job => !['queued', 'running'].includes(job.status)) : filtered.filter(job => ['queued', 'running'].includes(job.status));
  return `<div class="page-heading"><div><h1>任务运营</h1><p>异常由服务人员处理，用户端只展示完成进度。</p></div><button class="button" data-action="admin-refresh">刷新</button></div>
  <div class="selection-bar">
    <div class="detail-tabs">
      <button class="detail-tab ${view === 'current' ? 'selected' : ''}" data-admin-jobs-view="current">当前</button>
      <button class="detail-tab ${view === 'history' ? 'selected' : ''}" data-admin-jobs-view="history">历史</button>
    </div>
    <span>${rows.length} 个任务</span>
    <div class="detail-tabs">
      <button class="detail-tab ${kind === 'service' ? 'selected' : ''}" data-admin-jobs-kind="service">服务任务</button>
      <button class="detail-tab ${kind === 'collection' ? 'selected' : ''}" data-admin-jobs-kind="collection">题库采集</button>
      <button class="detail-tab ${kind === 'all' ? 'selected' : ''}" data-admin-jobs-kind="all">全部</button>
    </div>
  </div>
  <div class="service-jobs">${rows.map(job => `<article class="service-job service-job-compact ${serviceStatus(job)}">
    <div class="job-heading">
      <span class="job-symbol" aria-hidden="true">${job.status === 'succeeded' ? '✓' : job.status === 'failed' ? '!' : '◌'}</span>
      <div><h3>${e(job.request?.mode === 'collect_verified' ? '题库采集' : jobTitle(job, []))}</h3>
      <p class="meta">${e(dateTime(job.created_at))} · ${e(job.owner_id?.slice(0, 8) ?? '')} · ${PHASE[job.phase] ?? job.phase ?? ''}</p></div>
      ${badge(job.status)}
    </div>
    <div class="job-footer">
      <div class="job-progress"><span>${jobProgress(job).completed} / ${jobProgress(job).total || '—'} ${jobProgress(job).unit}</span></div>
      <button class="text-button" data-admin-job-detail="${e(job.id)}">查看详情</button>
    </div>
  </article>`).join('') || `<div class="empty"><h3>${view === 'current' ? '当前没有进行中的任务' : '没有历史记录'}</h3><p>${view === 'current' ? '切到「历史」可以查看已完成的安排。' : '当前筛选条件下没有记录。'}</p></div>`}</div>`;
}

function cardsView(cards) {
  return `<div class="page-heading"><div><h1>服务卡密</h1><p>一次性凭证；明文只在创建时显示一次。</p></div><button class="button primary" data-action="create-card">新建卡密</button></div>
  <section class="panel"><div class="completion-list">${cards.map(card => `<li>
    <span class="completion-icon ${card.status === 'active' ? 'done' : ''}">${card.status === 'active' ? '✓' : '·'}</span>
    <div><strong>${e(card.label)}</strong><p>${card.status === 'active' ? '可用' : card.status === 'used' ? '已使用' : '已停用'} · 创建于 ${e(dateTime(card.created_at))}${card.used_at ? ` · 使用于 ${e(dateTime(card.used_at))}` : ''}</p></div>
    ${card.status === 'active' ? `<button class="text-button" data-revoke-card="${e(card.id)}">停用</button>` : ''}
  </li>`).join('') || '<li><div><strong>还没有卡密</strong><p>点「新建卡密」生成一张一次性凭证。</p></div></li>'}</div></section>`;
}

function auditView(events) {
  return `<div class="page-heading"><div><h1>操作审计</h1><p>登录、任务与管理操作都会留痕。</p></div><button class="button" data-action="admin-refresh">刷新</button></div>
  <section class="panel"><div class="completion-list">${events.map(event => `<li>
    <span class="completion-icon done">·</span>
    <div><strong>${e(event.action)}</strong><p>${e(event.actor_name || '系统')} · ${e(dateTime(event.created_at))}${event.target ? ` · ${e(String(event.target).slice(0, 8))}` : ''}</p></div>
  </li>`).join('') || '<li><div><strong>暂无记录</strong><p>还没有可审计的操作。</p></div></li>'}</div></section>`;
}

export function renderAdmin(page, state) {
  if (state.loading) return '<div class="loading" role="status"><span class="spinner"></span>正在读取管理数据…</div>';
  if (state.error) return '<div class="service-notice">管理数据暂未读取完成，请刷新重试。</div>';
  if (page === 'overview') return overviewView(record(state.overview));
  if (page === 'users') return usersView(state.users ?? []);
  if (page === 'operations') return operationsView(state.jobs ?? [], state.jobsView ?? 'current', state.jobsKind ?? 'service');
  if (page === 'cards') return cardsView(state.cards ?? []);
  if (page === 'audit') return auditView(state.audit ?? []);
  return '';
}

export function renderAdminJobDetail(job) {
  const result = record(job.result);
  const rows = Array.isArray(result.homeworks) ? result.homeworks.map(record) : [];
  return `<h2>${e(jobTitle(job, []))}</h2>
    <p class="subtext">${e(dateTime(job.created_at))} · ${PHASE[job.phase] ?? job.phase ?? ''} · ${STATUS[job.status] ?? job.status}</p>
    <div class="detail-note">${job.error_code ? `原因码：${e(job.error_code)} — ${e(job.error_message ?? '')}` : '没有异常原因码。'}</div>
    ${rows.length ? `<ol class="completion-list">${rows.map((row, index) => {
    const done = ['completed', 'skipped', 'passed'].includes(String(row.status));
    return `<li><span class="completion-icon ${done ? 'done' : ''}">${done ? '✓' : index + 1}</span><div><strong>${e(row.title || `作业 ${index + 1}`)}</strong><p>${e(row.status)}${row.reason_code ? ` · ${e(row.reason_code)}` : ''}</p></div></li>`;
  }).join('')}</ol>` : '<p class="muted">没有详细进度记录。</p>'}
    <div class="modal-actions">${['queued', 'running'].includes(job.status) ? `<button class="button" data-admin-cancel="${e(job.id)}">停止任务</button>` : ''}<button class="button" data-action="close-modal">关闭</button></div>`;
}

export { serviceLabels, serviceStatus };
