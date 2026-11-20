// 应用入口：状态、路由（页面切换）、渲染与事件。
import { ApiRequestError, BrowserApi } from './api.js';
import { renderAdmin, renderAdminJobDetail } from './admin.js';
import {
  activeJobs, attentionCount, currentServiceJobs, jobFinished, jobProgress, jobTitle, pendingJob,
  renderJobs, renderServiceDetail, serviceLabels, serviceStatus,
} from './jobs.js';
import { count, escapeHtml as e, icon } from './ui.js';
import { renderSupportWorkspace, renderSupportDetail, renderGuidelines } from './support.js';

const root = document.querySelector('#app');
if (!root) throw new Error('Missing application root');

const api = new BrowserApi();

const state = {
  user: null,
  page: 'courses',
  courses: [],
  jobs: [],
  selected: [],
  cardRequired: false,
  demoMode: false,
  questionBank: null,
  todaySummary: null,
  bankLoading: false,
  loading: false,
  signingIn: false,
  creating: false,
  notice: '',
  loginError: '',
  search: '',
  modal: '',
  modalAction: null,
  progressHistoryOpen: false,
  admin: { overview: {}, users: [], jobs: [], audit: [], cards: [], loading: false, error: false, jobsView: 'current', jobsKind: 'service' },
  // 反馈工单：用户端与后台共用一份列表状态，靠 admin 标记区分接口
  support: { items: [], nextCursor: null, filter: 'all', loading: false, error: '', submitting: false, detail: null },
};

let generation = 0;
let jobsRevision = 0;
let coursesRevision = 0;
let adminRevision = 0;
let modalRevision = 0;
let pollTimer;
let courseDialog = null;

const isAdmin = () => state.user?.role === 'admin' || Boolean(state.user?.permissions?.includes('admin'));
// 服务是否可用：未开通或被停用都拦在客户端，服务端同样会拒
const canUse = () => state.user?.service_access !== false && state.user?.status !== 'disabled';

// ---------- 登录页 ----------
function brand() {
  return `<div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span><div><strong>LabPilot</strong><small>实验领航</small></div></div>`;
}

function avatar() {
  return state.user?.avatarUrl
    ? `<img class="avatar" src="${e(state.user.avatarUrl)}" alt="个人头像" data-avatar>`
    : `<span class="avatar">${e((state.user?.name ?? '同').slice(0, 1))}</span>`;
}

function renderLogin() {
  const cardLabel = state.cardRequired ? '必填' : '选填';
  const cardHelp = state.cardRequired ? '使用有效卡密开通服务，具体规则请联系服务人员。' : '卡密规则尚未开放，当前可暂不填写。';
  return `<main class="login">
    <section class="login-visual">
      ${brand()}
      <div class="login-copy">
        <span class="welcome-label">让学习的安排，轻松一点。</span>
        <h1>选好课程，<br>剩下交给爸爸。</h1>
        <p>登录你的头歌账号，选择需要完成的课程。<br>每一步进度，回来就能看见。</p>
        <div class="login-illustration" aria-hidden="true">
          <div class="illustration-line"><span class="illustration-icon">✓</span><div><b>选择课程</b><i></i></div><em>你来决定</em></div>
          <div class="illustration-connector"></div>
          <div class="illustration-line"><span class="illustration-icon live">◌</span><div><b>我们接手</b><i></i></div><em>安心等待</em></div>
          <div class="illustration-connector"></div>
          <div class="illustration-line"><span class="illustration-icon">✓</span><div><b>查看完成进度</b><i></i></div><em>随时可查</em></div>
        </div>
      </div>
      <p class="login-foot">你的头歌账号，就是这里的账号。</p>
    </section>
    <section class="login-form-area">
      <form id="login-form">
        <span class="badge waiting">无需额外注册</span>
        <h2>欢迎回来</h2>
        <p class="subtext">用头歌账号登录，开始安排你的课程。</p>
        <label for="login">头歌账号</label>
        <input id="login" name="login" autocomplete="username" placeholder="手机号 / 邮箱 / 学号" required maxlength="120">
        <label for="password">头歌密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="输入头歌密码" required maxlength="512">
        <label for="card-code">卡密 <span data-card-requirement>${cardLabel}</span></label>
        <input id="card-code" name="access_code" type="password" autocomplete="off" placeholder="${state.cardRequired ? '输入你的服务卡密' : '如有卡密，请在这里填写'}" maxlength="256" ${state.cardRequired ? 'required' : ''}>
        <p class="field-help" data-card-help>${cardHelp}</p>
        ${state.demoMode ? '<div class="service-notice">演示模式：当前连接的是内置夹具平台（UPSTREAM=mock），<strong>任意账号密码都能登录</strong>，任务只在本地模拟，不会碰真实头歌。要用真实账号，把 .env 里的 <code>UPSTREAM</code> 改成 <code>educoder</code> 后重启服务。</div>' : ''}
        ${state.loginError ? `<div class="form-feedback" role="alert">${e(state.loginError)}</div>` : ''}
        <button class="button primary full" type="submit" ${state.signingIn ? 'disabled' : ''}>${state.signingIn ? '正在登录…' : '登录并进入'}</button>
        <p class="login-help">登录仅用于读取你自己的课堂和完成服务。密码不在本站保存，只保存加密后的头歌会话。</p>
      </form>
    </section>
  </main>`;
}

// ---------- 外壳 ----------
function navItem(page, label, name) {
  return `<button class="nav-item ${state.page === page ? 'active' : ''}" data-nav="${page}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span></button>`;
}

const ADMIN_PAGES = {
  'admin-overview': '服务概览',
  'admin-users': '用户管理',
  'admin-operations': '任务运营',
  'admin-support': '反馈工单',
  'admin-cards': '服务卡密',
  'admin-audit': '操作审计',
};

const isSupportPage = () => state.page === 'support' || state.page === 'admin-support';

function renderShell() {
  const admin = state.page.startsWith('admin-') && isAdmin();
  const nav = admin
    ? `${navItem('admin-overview', '服务概览', 'overview')}${navItem('admin-users', '用户管理', 'users')}${navItem('admin-operations', '任务运营', 'progress')}${navItem('admin-support', '反馈工单', 'support')}${navItem('admin-cards', '服务卡密', 'audit')}${navItem('admin-audit', '操作审计', 'audit')}`
    : `${navItem('courses', '我的课程', 'courses')}${navItem('progress', '完成进度', 'progress')}${navItem('support', '问题反馈', 'support')}`;
  const breadcrumb = admin ? ADMIN_PAGES[state.page] : state.page === 'courses' ? '我的课程' : state.page === 'support' ? '问题反馈' : '完成进度';
  return `<div class="app-shell">
    <aside class="sidebar">
      ${brand()}
      <div class="nav-label">${admin ? '服务管理' : '我的学习'}</div>
      <nav aria-label="${admin ? '管理员导航' : '主要导航'}">${nav}</nav>
      <div class="sidebar-bottom">
        ${isAdmin() ? `<button class="nav-item" data-nav="${admin ? 'courses' : 'admin-overview'}">${icon(admin ? 'courses' : 'overview')}<span>${admin ? '返回用户端' : '管理后台'}</span></button>` : ''}
        <div class="sidebar-note">${admin ? '异常由服务人员处理，<br>用户端只展示完成进度。' : '你负责安心，<br>我们负责把事情做好。'}</div>
        <div class="profile">${avatar()}<div><strong>${e(state.user?.name || '同学')}</strong><small>${admin ? '管理员' : '平台账号已连接'}</small></div>
          <button class="icon-button" data-action="logout" aria-label="退出登录" title="退出登录">${icon('logout')}</button>
        </div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="mobile-brand">${brand()}</div>
        <span class="breadcrumb">${admin ? '管理后台' : '个人中心'}<span>/</span>${breadcrumb}</span>
        <div class="topbar-right">
          <span class="connection"><i></i> ${state.demoMode ? '演示模式' : admin ? '管理会话' : '平台已连接'}</span>
          <button class="icon-button mobile-logout" data-action="logout" aria-label="退出登录">${icon('logout')}</button>
        </div>
      </header>
      <div class="mobile-nav">${admin
        ? `${navItem('admin-overview', '概览', 'overview')}${navItem('admin-users', '用户', 'users')}${navItem('admin-operations', '任务', 'progress')}${navItem('admin-support', '工单', 'support')}${navItem('admin-cards', '卡密', 'audit')}${navItem('admin-audit', '审计', 'audit')}${navItem('courses', '用户端', 'courses')}`
        : `${navItem('courses', '我的课程', 'courses')}${navItem('progress', '完成进度', 'progress')}${navItem('support', '问题反馈', 'support')}${isAdmin() ? navItem('admin-overview', '管理后台', 'overview') : ''}`}</div>
      <div class="workspace">
        ${state.notice ? `<div class="service-notice" role="status">${e(state.notice)}</div>` : ''}
        ${isSupportPage()
          ? renderSupportPage(state.page === 'admin-support')
          : admin
            ? renderAdmin(state.page.replace('admin-', ''), state.admin)
            : state.page === 'courses' ? renderCourses() : renderProgress()}
      </div>
      <footer class="page-footer">LabPilot · 把课程作业交给流水线</footer>
    </main>
  </div>`;
}

// ---------- 运营数据卡（题库 / 今日完成） ----------
function renderMetaCards() {
  const bank = state.questionBank;
  const today = state.todaySummary;
  const bankCard = `<section class="side-card question-bank-card" aria-label="题库概况">
      <div class="bank-card-heading">
        <h3>题库概况</h3>
        <button class="text-button" data-action="bank-refresh" ${state.bankLoading ? 'disabled' : ''}>${state.bankLoading ? '读取中…' : '刷新'}</button>
      </div>
      <div class="bank-metrics">
        <div><strong>${bank ? bank.total : '—'}</strong><span>已验证题目</span></div>
        <div><strong>${bank ? bank.hits_today : '—'}</strong><span>今日命中</span></div>
      </div>
      <p class="bank-note">${bank
    ? `代码 ${bank.code} 条 · 选择 ${bank.choice} 条 · 今日新增 ${bank.added_today} 条；命中一次就省一次模型调用。`
    : '题库数据暂未读取。'}</p>
    </section>`;

  const todayCard = `<section class="side-card today-service-card" aria-label="今日完成">
      <div class="bank-card-heading"><h3>今日完成</h3></div>
      <div class="today-lines">
        <div><span>通过关卡</span><b>${today ? today.levels_passed_today : '—'}</b></div>
        <div><span>完成作业</span><b>${today ? today.homeworks_completed_today : '—'}</b></div>
        <div><span>运行任务</span><b>${today ? today.jobs_today : '—'}</b></div>
      </div>
    </section>`;

  return bankCard + todayCard;
}

// ---------- 我的课程 ----------
// 侧栏进度卡：任务结束后不要再显示「服务处理中」，要把欠账说清楚
function railHeading(latest, completed) {
  if (!latest) return completed ? '安排已完成' : '一切准备就绪';
  if (!jobFinished(latest)) return serviceLabels[serviceStatus(latest)] ?? '正在处理';
  const attention = attentionCount(latest);
  if (attention) return `已结束 · ${attention} 份需跟进`;
  return '安排已完成';
}

function railNote(latest) {
  if (!latest) return '关闭页面也没关系，进度会为你保留。';
  if (!jobFinished(latest)) {
    return serviceStatus(latest) === 'support'
      ? '放心，服务人员正在处理，无需重复提交。'
      : '处理过程中无需守候，进度会自动更新。';
  }
  const attention = attentionCount(latest);
  if (attention) return `这次安排已经结束，${attention} 份判分没通过需要人工跟进，其余已完成。`;
  return '这次安排已经结束，结果都核验过了。';
}

function courseService(identifier) {
  const matching = currentServiceJobs(state.jobs).filter(job => job.request?.scope !== 'exercise' && (job.request?.scope === 'all' || job.request?.course === identifier));
  return matching.find(pendingJob) ?? matching[0];
}

const coursePending = (identifier) => {
  const latest = courseService(identifier);
  // 只有还在排队/处理中的才算「已安排」；跑完了即使有欠账也要允许重新安排（那是重试入口）
  return Boolean(latest && pendingJob(latest));
};

const allServicePending = () => activeJobs(state.jobs).some(job => job.request?.scope !== 'exercise');

/** 这门课上一次跑完、但有作业需要人工跟进时给出提示（不影响重新安排） */
function courseAttention(identifier) {
  const latest = courseService(identifier);
  if (!latest || pendingJob(latest)) return 0;
  return attentionCount(latest);
}

function renderCourses() {
  const visible = state.courses.filter(course => !state.search || course.name.toLowerCase().includes(state.search.toLowerCase()));
  const current = currentServiceJobs(state.jobs);
  const latest = activeJobs(state.jobs)[0]
    ?? current.find(job => serviceStatus(job) === 'support')
    ?? current.find(job => ['completed', 'submitted', 'awaiting_review', 'graded'].includes(serviceStatus(job)));
  const completed = current.filter(job => serviceStatus(job) === 'completed').length;
  const examSubmitted = latest?.request?.scope === 'exercise' && ['submitted', 'awaiting_review', 'graded'].includes(serviceStatus(latest));
  const usable = canUse();

  return `<div class="page-heading">
      <div><h1>今天，也轻松一点。</h1><p>${e(state.user?.name || '同学')}，选好课程，我们来完成。</p></div>
      <button class="button" data-action="refresh" ${state.loading ? 'disabled' : ''}>${icon('refresh')}刷新课程</button>
    </div>
    ${!usable ? '<div class="service-notice">你的服务暂未开通，请联系服务人员。已有完成进度仍可查看。</div>' : ''}
    <section class="service-banner">
      <div><span class="banner-label">把未完成的，交给我们。</span><h2>一次安排，不必守着页面。</h2><p>完成所有课程的未完成必做作业，已完成和选做内容会自动跳过。</p></div>
      <button class="button primary" data-action="start-all" ${state.loading || state.creating || !state.courses.length || !usable || allServicePending() ? 'disabled' : ''}>一键完成全部未完成作业 ${icon('arrow')}</button>
    </section>
    <div class="content-grid">
      <section>
        <div class="section-heading">
          <div><h2>我的课程 <span class="count">${state.courses.length}</span></h2><p class="muted">选择课程，安排其中尚未完成的作业。</p></div>
          <label class="search-box"><span class="sr-only">搜索课程</span><input data-search placeholder="搜索课程" value="${e(state.search)}"></label>
        </div>
        ${state.loading
    ? '<div class="loading" role="status"><span class="spinner"></span>正在同步你的课程…</div>'
    : visible.length
      ? `<div class="courses">${visible.map((course, index) => `<article class="course ${state.selected.includes(course.identifier) ? 'selected' : ''}">
          <label class="course-select"><input type="checkbox" data-select-course="${e(course.identifier)}" ${state.selected.includes(course.identifier) ? 'checked' : ''} ${coursePending(course.identifier) || state.creating || !usable ? 'disabled' : ''}><span class="sr-only">选择${e(course.name)}</span></label>
          <span class="book book-${index % 3}" aria-hidden="true"><i></i></span>
          <h3>${e(course.name)}</h3>
          <p>${course.homeworkCount === undefined ? '课程作业' : `${count(course.homeworkCount)} 份作业`}</p>
          <div class="course-footer">
            <span class="badge ${coursePending(course.identifier) ? 'processing' : courseAttention(course.identifier) ? 'support' : 'waiting'}">${coursePending(course.identifier) ? '服务已安排' : courseAttention(course.identifier) ? `${courseAttention(course.identifier)} 份需跟进` : '可安排'}</span>
            <button class="text-button" data-course-detail="${e(course.identifier)}">查看作业 ${icon('arrow')}</button>
          </div>
        </article>`).join('')}</div>`
      : `<div class="panel empty"><h3>${state.search ? '没有找到这门课程' : '还没有课程'}</h3><p>${state.search ? '试试其他课程名称。' : '加入头歌课堂后，刷新这里即可同步。'}</p></div>`}
        <div class="selection-bar">
          <label class="select-all"><input type="checkbox" data-action="select-all" ${state.selected.length > 0 && state.selected.length === state.courses.filter(course => !coursePending(course.identifier)).length ? 'checked' : ''} ${state.creating || !usable ? 'disabled' : ''}> 全选可安排课程</label>
          <span>已选 ${state.selected.length} 门课程</span>
          <button class="button primary" data-action="start-selected" ${!state.selected.length || state.creating || !usable ? 'disabled' : ''}>${state.creating ? '正在安排…' : '完成所选课程'}</button>
        </div>
      </section>
      <aside class="status-rail">
        <section class="current-service">
          <div class="rail-label"><i></i> 我的完成进度</div>
          <h2>${railHeading(latest, completed)}</h2>
          <p>${latest ? e(jobTitle(latest, state.courses)) : '选好课程后，我们会在这里跟进。'}</p>
          ${latest && examSubmitted
    ? `<p class="rail-exam-status">已交卷${jobProgress(latest).total ? ` · 共 ${jobProgress(latest).total} 道题` : ''}</p>`
    : latest
      ? `<div class="large-progress"><strong>${jobProgress(latest).completed}</strong><span>/ ${jobProgress(latest).total || '—'} ${jobProgress(latest).unit}</span></div><div class="rail-track"><span style="width:${jobProgress(latest).percent}%"></span></div>`
      : '<div class="ready-mark" aria-hidden="true">✓</div>'}
          <p class="rail-note">${railNote(latest)}</p>
          <button data-nav="progress">查看全部进度 ${icon('arrow')}</button>
        </section>
        <section class="panel reassurance">
          <h3>只需要三步</h3>
          <ol>
            <li><b>选择课程</b><p>按需要选择，或一键安排全部。</p></li>
            <li><b>交给我们</b><p>处理过程中无需守候。</p></li>
            <li><b>查看进度</b><p>完成后，结果清楚可见。</p></li>
          </ol>
        </section>
        ${renderMetaCards()}
      </aside>
    </div>`;
}

function renderProgress() {
  return `<div class="page-heading"><div><h1>完成进度</h1><p>查看正在处理和已完成的课程。</p></div>
    <button class="button" data-action="jobs-refresh">${icon('refresh')}刷新进度</button></div>
    ${renderJobs(state.jobs, state.courses, state.progressHistoryOpen)}`;
}

// ---------- 课程详情弹窗 ----------
function exerciseStatus(exercise) {
  if (exercise.submitted) {
    return exercise.scoreKnown ? { label: '成绩已公布', tone: 'completed' } : { label: '已交卷 · 待公布成绩', tone: 'processing' };
  }
  const code = String(exercise.reasonCode ?? '').toLowerCase();
  if (!exercise.available || exercise.actionRequired === true || ['locked', 'proctoring_required', 'not_started', 'deadline_passed', 'expired', 'action_required'].includes(code)) {
    return { label: '需在头歌处理', tone: 'waiting' };
  }
  return { label: '待完成', tone: 'processing' };
}

function exerciseReason(exercise) {
  if (exercise.submitted) {
    return exercise.scoreKnown && exercise.score !== undefined ? `成绩 ${exercise.score}${exercise.maxScore !== undefined ? ` / ${exercise.maxScore}` : ''}` : '已交卷，成绩公布后可查看';
  }
  switch (String(exercise.reasonCode ?? '').toLowerCase()) {
    case 'locked': return '考试被锁定，请先在头歌完成解锁流程。';
    case 'proctoring_required': return '考试需要监考或浏览器确认，请在头歌进入。';
    case 'not_started': return '考试尚未开始，请按头歌开放时间进入。';
    case 'deadline_passed':
    case 'expired': return '考试已截止，请在头歌查看处理入口。';
    case 'action_required': return '入场事项需要在头歌确认，请先在头歌处理。';
    default: return exercise.available && exercise.actionRequired !== true ? '确认后由服务人员完成整场考试。' : '当前不可安排，请在头歌查看处理入口。';
  }
}

function renderCourseDetail(course, homeworks, exercises, tab) {
  const homeworkBody = `<p class="subtext">${homeworks.length} 份作业，只安排必做关卡，已完成的会自动跳过。</p>
    <ul class="completion-list">${homeworks.map(homework => {
    const done = Boolean(homework.requiredProgressKnown && homework.requiredChallengeCount && (homework.finishedRequiredChallengeCount ?? 0) >= homework.requiredChallengeCount);
    return `<li><span class="completion-icon ${done ? 'done' : ''}">${done ? '✓' : '·'}</span><div>
      <strong>${e(homework.name)}</strong>
      <p>${homework.requiredProgressKnown ? `${done ? '已完成' : '待完成'} · ${count(homework.finishedRequiredChallengeCount)} / ${count(homework.requiredChallengeCount)} 必做关卡` : '安排时核验必做进度'}</p>
    </div></li>`;
  }).join('') || '<li>这门课程暂无需要安排的必做作业。</li>'}</ul>`;

  const examBody = exercises === null
    ? '<div class="loading"><span class="spinner"></span>正在同步在线考试…</div>'
    : exercises.length
      ? `<p class="subtext">在线考试单独安排，不包含在一键完成课程作业中；已交卷的考试不会重复安排。</p>
        <ul class="completion-list">${exercises.map(exercise => {
    const status = exerciseStatus(exercise);
    return `<li><span class="completion-icon ${status.tone === 'completed' ? 'done' : ''}">${status.tone === 'completed' ? '✓' : '·'}</span>
      <div class="exercise-row">
        <strong>${e(exercise.name)}</strong>
        <p>${status.label}${exercise.totalQuestions ? ` · ${count(exercise.totalQuestions)} 道题` : ''}${exercise.deadline ? ` · 截止 ${e(exercise.deadline)}` : ''}</p>
        <p>${e(exerciseReason(exercise))}</p>
        <div class="exercise-actions">
          ${exercise.submitted || !exercise.available || exercise.actionRequired === true ? '' : `<button class="button primary compact" data-exam-submit="${exercise.id}">安排完成考试</button>`}
        </div>
      </div></li>`;
  }).join('')}</ul>`
      : '<div class="empty"><h3>暂无在线考试</h3><p>这门课程当前没有可查看的在线考试。</p></div>';

  return `<h2 id="modal-title">${e(course.name)}</h2>
    <div class="detail-tabs" role="tablist">
      <button class="detail-tab ${tab === 'homework' ? 'selected' : ''}" data-detail-tab="homework" role="tab" aria-selected="${tab === 'homework'}">课程实验</button>
      <button class="detail-tab ${tab === 'exercise' ? 'selected' : ''}" data-detail-tab="exercise" role="tab" aria-selected="${tab === 'exercise'}">在线考试</button>
    </div>
    ${tab === 'homework' ? homeworkBody : examBody}
    <div class="modal-actions"><button class="button" data-action="close-modal">关闭</button></div>`;
}

// ---------- 渲染循环 ----------
// ---------- 问题反馈（工单） ----------
function renderSupportPage(admin) {
  const support = state.support;
  const view = {
    items: support.items,
    nextCursor: support.nextCursor,
    filter: support.filter,
    loading: support.loading,
    error: support.error,
    submitting: support.submitting,
  };
  const extra = admin
    ? ''
    : `<div class="support-footnote"><button type="button" class="link-button" data-action="guidelines">使用与数据说明</button></div>`;
  return `${renderSupportWorkspace(view, admin)}${extra}`;
}

async function loadSupport({ append = false } = {}) {
  const admin = state.page === 'admin-support';
  const session = generation;
  state.support.loading = true;
  state.support.error = '';
  if (!append) { state.support.items = []; state.support.nextCursor = null; }
  render();
  try {
    const options = {
      limit: 20,
      status: state.support.filter === 'all' ? undefined : state.support.filter,
      cursor: append ? state.support.nextCursor ?? undefined : undefined,
    };
    const result = admin ? await api.adminTickets(options) : await api.tickets(options);
    if (session !== generation) return;
    const items = Array.isArray(result?.items) ? result.items : [];
    state.support.items = append ? [...state.support.items, ...items] : items;
    state.support.nextCursor = typeof result?.next_cursor === 'string' && result.next_cursor ? result.next_cursor : null;
  } catch (error) {
    if (session !== generation || handleError(error)) return;
    state.support.error = '反馈记录暂时读取不到，请稍后刷新。';
  } finally {
    state.support.loading = false;
    if (session === generation) render();
  }
}

async function openSupport(id) {
  const admin = state.page === 'admin-support';
  try {
    const detail = admin ? await api.adminTicket(id) : await api.ticket(id);
    state.support.detail = detail;
    showModal(renderSupportDetail(detail, admin, false));
  } catch (error) {
    if (handleError(error)) return;
    state.notice = '这条反馈暂时打不开，请稍后刷新。';
    render();
  }
}

async function submitSupport(form) {
  if (state.support.submitting) return;
  const data = new FormData(form);
  const subject = String(data.get('subject') ?? '').trim();
  const body = String(data.get('body') ?? '').trim();
  const category = String(data.get('category') ?? 'other');
  state.support.submitting = true;
  render();
  try {
    await api.createTicket({ subject, category, body, idempotency_key: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
    state.support.filter = 'all';
    state.notice = '反馈已提交，服务人员回复后会在这里显示。';
    await loadSupport();
  } catch (error) {
    if (handleError(error)) return;
    state.support.submitting = false;
    state.support.error = '提交没有成功，请稍后再试。';
    render();
  }
}

async function replySupport(form) {
  if (state.support.submitting) return;
  const id = form.dataset.supportId;
  const body = String(new FormData(form).get('body') ?? '').trim();
  const admin = state.page === 'admin-support';
  state.support.submitting = true;
  render();
  try {
    const detail = admin ? await api.adminReplyTicket(id, { body }) : await api.replyTicket(id, { body });
    state.support.detail = detail;
    state.support.submitting = false;
    if (!state.modal) showModal(renderSupportDetail(detail, admin, false));
    else { state.modal = renderSupportDetail(detail, admin, false); render(); }
    void loadSupport();
  } catch (error) {
    if (handleError(error)) return;
    state.support.submitting = false;
    state.notice = '回复没有发出去，请稍后重试。';
    render();
  }
}

async function updateSupportStatus(id, status) {
  const admin = state.page === 'admin-support';
  state.support.submitting = true;
  render();
  try {
    const detail = admin ? await api.adminSetTicketStatus(id, status) : await api.setTicketStatus(id, status);
    state.support.detail = detail;
    state.support.submitting = false;
    state.modal = renderSupportDetail(detail, admin, false);
    render();
    void loadSupport();
  } catch (error) {
    if (handleError(error)) return;
    state.support.submitting = false;
    state.notice = '状态没有改成功，请稍后重试。';
    render();
  }
}

function render() {
  root.innerHTML = `${state.user ? renderShell() : renderLogin()}${state.modal
    ? `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
        <button class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon('close')}</button>
        <div class="modal-content">${state.modal}</div>
      </section></div>` : ''}`;
  bindEvents();
  document.querySelectorAll('[data-card-requirement]').forEach(node => { node.textContent = state.cardRequired ? '必填' : '选填'; });
}

function showModal(content, action = null) {
  modalRevision += 1;
  state.modal = content;
  state.modalAction = action;
  render();
  document.querySelector('[data-action="close-modal"]')?.focus();
}

function closeModal() {
  state.modal = '';
  state.modalAction = null;
  modalRevision += 1;
  courseDialog = null;
  render();
}

function resetSession(message = '') {
  generation += 1;
  jobsRevision += 1;
  coursesRevision += 1;
  adminRevision += 1;
  stopPoll();
  courseDialog = null;
  Object.assign(state, {
    user: null, page: 'courses', courses: [], jobs: [], selected: [], loading: false,
    signingIn: false, creating: false, notice: '', loginError: message, modal: '', modalAction: null,
    search: '', progressHistoryOpen: false,
    support: { items: [], nextCursor: null, filter: 'all', loading: false, error: '', submitting: false, detail: null },
  });
  render();
}

function handleError(error) {
  if (error instanceof ApiRequestError && error.isSessionExpired) {
    resetSession('登录已过期，请重新登录。你的任务进度会保留。');
    return true;
  }
  return false;
}

// ---------- 轮询 ----------
function stopPoll() {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

function scheduleJobs() {
  stopPoll();
  if (!state.user) return;
  const pending = activeJobs(state.jobs).length > 0;
  pollTimer = setTimeout(() => { pollTimer = undefined; void loadJobs(); }, pending ? 3000 : 15000);
  pollTimer?.unref?.();
}

async function loadJobs() {
  if (!state.user) return;
  const revision = ++jobsRevision;
  const session = generation;
  try {
    const result = await api.jobs();
    if (session !== generation || revision !== jobsRevision) return;
    state.jobs = result.jobs;
    state.selected = state.selected.filter(id => !coursePending(id));
    if (!state.modal) render();
  } catch (error) {
    if (session !== generation || revision !== jobsRevision) return;
    if (handleError(error)) return;
  }
  scheduleJobs();
}

async function loadCourses() {
  const revision = ++coursesRevision;
  const session = generation;
  state.loading = true;
  render();
  try {
    const courses = await api.courses();
    if (session !== generation || revision !== coursesRevision) return;
    state.courses = courses;
    state.selected = state.selected.filter(id => courses.some(course => course.identifier === id));
    state.notice = '';
  } catch (error) {
    if (session !== generation || revision !== coursesRevision) return;
    if (handleError(error)) return;
    state.notice = '课程暂未同步完成，服务人员会协助处理。请稍后回来查看。';
  }
  state.loading = false;
  render();
}

async function loadMeta() {
  if (!state.user) return;
  state.bankLoading = true;
  render();
  try {
    const [bank, today] = await Promise.all([api.questionBankSummary(), api.todaySummary()]);
    state.questionBank = bank;
    state.todaySummary = today;
  } catch { /* 拿不到就不显示数字 */ }
  state.bankLoading = false;
  render();
}

async function loadAdmin() {
  if (!isAdmin()) return;
  const session = generation;
  const revision = ++adminRevision;
  state.admin.loading = true;
  state.admin.error = false;
  render();
  try {
    const [overview, users, jobs, audit, cards] = await Promise.all([
      api.adminOverview(), api.adminUsers(), api.adminJobs(), api.adminAudit(), api.adminCards(),
    ]);
    if (session !== generation || revision !== adminRevision) return;
    Object.assign(state.admin, { overview, users, jobs, audit, cards, loading: false, error: false });
    render();
  } catch (error) {
    if (session !== generation || revision !== adminRevision) return;
    if (handleError(error)) return;
    if (error instanceof ApiRequestError && error.status === 403) {
      state.page = 'courses';
      state.notice = '当前账号未获管理授权。';
    }
    state.admin.loading = false;
    state.admin.error = true;
    render();
  }
}

// ---------- 动作 ----------
async function login(event) {
  event.preventDefault();
  if (state.signingIn) return;
  const form = event.currentTarget;
  const value = (name) => form.elements.namedItem(name).value;
  const account = value('login').trim();
  const password = value('password');
  const card = value('access_code').trim();
  if (!account || !password) {
    state.loginError = '请输入头歌账号和密码。';
    render();
    return;
  }
  form.reset();
  const session = ++generation;
  state.signingIn = true;
  state.loginError = '';
  render();
  try {
    const user = await api.login(account, password, card);
    if (session !== generation) return;
    state.user = user;
    state.signingIn = false;
    render();
    void loadJobs();
    void loadCourses();
    void loadMeta();
  } catch (error) {
    if (session !== generation) return;
    const code = error instanceof ApiRequestError ? error.code : '';
    const messages = {
      AUTH_FAILED: '账号或密码不正确，请检查后重新登录。',
      CARD_REQUIRED: '请填写你的卡密。',
      CARD_INVALID: '卡密暂未验证通过，请联系服务人员。',
      USER_SUSPENDED: '账号服务暂不可用，请联系服务人员。',
      RATE_LIMITED: '登录有点频繁，请稍后再试。',
    };
    state.signingIn = false;
    state.loginError = messages[code ?? ''] ?? '登录暂未完成，请稍后再试或联系服务人员。';
    render();
  }
}

async function logout() {
  resetSession();
  try { await api.logout(); } catch { /* 本地会话已清空 */ }
}

function confirmStart(all) {
  if (state.creating || !canUse() || (all && allServicePending())) return;
  const selected = [...state.selected].filter(id => !coursePending(id));
  if (!all && !selected.length) return;
  const names = all
    ? state.courses.map(course => course.name)
    : state.courses.filter(course => selected.includes(course.identifier)).map(course => course.name);
  showModal(`<h2 id="modal-title">${all ? '完成全部未完成作业？' : '把这些课程交给我们？'}</h2>
    <p class="subtext">只安排必做关卡，已完成和选做内容会自动跳过。</p>
    <ul class="confirm-courses">${names.map(name => `<li>${icon('check')}${e(name)}</li>`).join('')}</ul>
    <div class="detail-note">处理期间无需守候。完成进度随时可查，遇到问题会由服务人员跟进。</div>
    <div class="modal-actions"><button class="button" data-action="close-modal">再看看</button><button class="button primary" data-action="modal-confirm">确认安排</button></div>`,
  () => startService(all, selected));
}

async function startService(all, selected) {
  if (state.creating || !canUse()) return;
  selected = selected.filter(id => !coursePending(id));
  if (all ? allServicePending() : !selected.length) { closeModal(); return; }

  jobsRevision += 1;
  stopPoll();
  const session = generation;
  state.modal = '';
  state.modalAction = null;
  state.creating = true;
  render();

  const requests = all
    ? [{ scope: 'all', mode: 'submit' }]
    : selected.map(course => ({ scope: 'course', course, mode: 'submit' }));
  const responses = await Promise.allSettled(requests.map(request => api.createJob({ ...request, idempotency_key: crypto.randomUUID() })));
  if (session !== generation) return;

  let accepted = 0;
  let expired = false;
  for (const response of responses) {
    if (response.status === 'fulfilled') {
      accepted += 1;
      state.jobs = [response.value, ...state.jobs.filter(job => job.id !== response.value.id)];
    } else if (response.reason instanceof ApiRequestError && response.reason.isSessionExpired) {
      expired = true;
    }
  }
  if (expired) { resetSession('登录已过期，请重新登录后查看进度。'); return; }
  state.creating = false;
  state.selected = [];
  state.notice = accepted === responses.length
    ? '已收到你的安排，接下来交给我们。完成进度会自动更新。'
    : '你的安排正在核对，请先查看完成进度，无需重复提交。';
  state.page = 'progress';
  render();
  void loadJobs();
}

async function courseDetail(identifier) {
  const course = state.courses.find(item => item.identifier === identifier);
  if (!course) return;
  courseDialog = { course, homeworks: [], exercises: null, tab: 'homework' };
  showModal(`<h2 id="modal-title">${e(course.name)}</h2>
    <div class="detail-tabs"><button class="detail-tab selected" data-detail-tab="homework">课程实验</button><button class="detail-tab" data-detail-tab="exercise">在线考试</button></div>
    <div class="loading"><span class="spinner"></span>正在同步作业…</div>`);
  const revision = modalRevision;
  const session = generation;
  try {
    const homeworks = await api.homeworks(identifier);
    if (session !== generation || revision !== modalRevision) return;
    courseDialog = { course, homeworks, exercises: null, tab: 'homework' };
    state.modal = renderCourseDetail(course, homeworks, null, 'homework');
    render();
  } catch (error) {
    if (session !== generation || revision !== modalRevision) return;
    if (handleError(error)) return;
    state.modal = `<h2 id="modal-title">${e(course.name)}</h2><p class="subtext">作业正在同步，服务人员会协助处理，请稍后查看。</p>
      <div class="modal-actions"><button class="button" data-action="close-modal">关闭</button></div>`;
    render();
  }
}

async function courseExercises(course) {
  const revision = ++modalRevision;
  const session = generation;
  if (!courseDialog || courseDialog.course.identifier !== course.identifier) return;
  courseDialog.tab = 'exercise';
  state.modal = renderCourseDetail(course, [], null, 'exercise');
  render();
  try {
    const result = await api.exercises(course.identifier);
    if (session !== generation || revision !== modalRevision) return;
    if (courseDialog) courseDialog.exercises = result.items;
    state.modal = renderCourseDetail(course, [], result.items, 'exercise');
    render();
  } catch (error) {
    if (session !== generation || revision !== modalRevision) return;
    if (handleError(error)) return;
    state.modal = `<h2 id="modal-title">${e(course.name)}</h2><p class="subtext">在线考试暂未同步完成，服务人员会协助处理。</p>
      <div class="modal-actions"><button class="button" data-action="close-modal">关闭</button></div>`;
    render();
  }
}

function confirmExercise(course, exercise) {
  if (state.creating || !canUse() || exercise.submitted || !exercise.available || exercise.actionRequired === true) return;
  const existing = () => currentServiceJobs(state.jobs).some(job => job.request?.scope === 'exercise'
    && job.request?.course === course.identifier
    && job.request?.exercise_id === exercise.id
    && (pendingJob(job) || serviceStatus(job) === 'support' || ['submitted', 'awaiting_review', 'graded'].includes(serviceStatus(job))));
  if (existing()) { closeModal(); state.page = 'progress'; render(); return; }

  showModal(`<h2 id="modal-title">安排这场考试？</h2><p class="subtext">${e(exercise.name)}</p>
    <div class="detail-note">本次仅安排这场考试，完成后会提交答案并核对交卷状态。需要在头歌处理的入场事项会单独提示。</div>
    <div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认安排</button></div>`,
  async () => {
    if (state.creating || !canUse() || existing()) { closeModal(); return; }
    const session = generation;
    state.creating = true;
    closeModal();
    try {
      const response = await api.createJob({ scope: 'exercise', course: course.identifier, exercise_id: exercise.id, mode: 'submit', idempotency_key: crypto.randomUUID() });
      if (session !== generation) return;
      state.jobs = [response, ...state.jobs.filter(job => job.id !== response.id)];
      state.page = 'progress';
      state.notice = '考试已安排，完成进度会自动更新。';
    } catch (error) {
      if (session !== generation || handleError(error)) return;
      state.notice = '考试安排正在核对，请查看完成进度，无需重复提交。';
    }
    if (session === generation) {
      state.creating = false;
      render();
      void loadJobs();
    }
  });
}

function navigate(page) {
  const allowed = ['courses', 'progress', 'support', 'admin-overview', 'admin-users', 'admin-operations', 'admin-support', 'admin-audit', 'admin-cards'];
  if (!allowed.includes(page)) return;
  if (page.startsWith('admin-') && !isAdmin()) return;
  state.page = page;
  state.notice = '';
  render();
  if (page.startsWith('admin-')) {
    if (page === 'admin-support') void loadSupport();
    else void loadAdmin();
  } else if (page === 'support') void loadSupport();
  else if (page === 'progress') void loadJobs();
}

async function adminAction(action) {
  const session = generation;
  closeModal();
  try {
    await action();
    if (session === generation) await loadAdmin();
  } catch (error) {
    if (session !== generation || handleError(error)) return;
    state.notice = '管理操作暂未完成，请刷新数据确认状态。';
    render();
  }
}

function newCard() {
  if (!isAdmin()) return;
  showModal(`<h2 id="modal-title">新建服务卡密</h2><p class="subtext">当前仅创建一次性服务凭证，不设置价格或套餐。</p>
    <label class="card-label" for="card-label">备注</label>
    <input class="card-field" id="card-label" maxlength="80" placeholder="例如：课程服务，张同学">
    <div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">创建卡密</button></div>`,
  async () => {
    const label = document.querySelector('#card-label')?.value.trim() || '服务卡密';
    const session = generation;
    try {
      const result = await api.adminCreateCard(label);
      if (session !== generation || !isAdmin()) return;
      const code = typeof result?.access_code === 'string' ? result.access_code : '';
      showModal(`<h2 id="modal-title">${code ? '卡密已创建' : '卡密已登记'}</h2>
        <p class="subtext">${code ? '明文只显示这一次。关闭前请妥善交付给用户。' : '请刷新列表查看记录。'}</p>
        ${code ? `<pre class="new-card-code">${e(code)}</pre>` : ''}
        <div class="modal-actions"><button class="button primary" data-action="close-modal">已妥善保存</button></div>`);
      void loadAdmin();
    } catch (error) {
      if (session !== generation || handleError(error)) return;
      closeModal();
      state.notice = '卡密创建状态待确认，请先刷新列表，避免重复创建。';
      render();
    }
  });
}

// ---------- 事件绑定 ----------
function bindEvents() {
  document.querySelector('#login-form')?.addEventListener('submit', (event) => { void login(event); });
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.nav)));

  document.querySelectorAll('[data-select-course]').forEach(input => input.addEventListener('change', () => {
    const id = input.dataset.selectCourse;
    state.selected = input.checked ? [...new Set([...state.selected, id])] : state.selected.filter(value => value !== id);
    render();
  }));

  const search = document.querySelector('[data-search]');
  search?.addEventListener('input', (event) => {
    const position = event.currentTarget.selectionStart;
    state.search = event.currentTarget.value;
    render();
    const next = document.querySelector('[data-search]');
    next?.focus();
    if (position !== null) next?.setSelectionRange(position, position);
  });

  document.querySelectorAll('[data-course-detail]').forEach(button => button.addEventListener('click', () => { void courseDetail(button.dataset.courseDetail); }));

  document.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => {
    if (!courseDialog) return;
    if (button.dataset.detailTab === 'exercise') void courseExercises(courseDialog.course);
    else void courseDetail(courseDialog.course.identifier);
  }));

  document.querySelectorAll('[data-exam-submit]').forEach(button => button.addEventListener('click', () => {
    const id = Number(button.dataset.examSubmit);
    const exercise = courseDialog?.exercises?.find(item => item.id === id);
    if (courseDialog && exercise) confirmExercise(courseDialog.course, exercise);
  }));

  document.querySelectorAll('[data-job-detail]').forEach(button => button.addEventListener('click', () => {
    const job = state.jobs.find(item => item.id === button.dataset.jobDetail);
    if (job) showModal(`<div id="modal-title">${renderServiceDetail(job, state.courses, button.dataset.jobHistory === 'true')}</div>`);
  }));

  document.querySelectorAll('[data-cancel-job]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.cancelJob;
    showModal(`<h2 id="modal-title">停止这次安排？</h2><p class="subtext">已完成的结果会保留，后续处理会停止。</p>
      <div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认停止</button></div>`,
    async () => {
      closeModal();
      try {
        await api.cancelJob(id);
        state.notice = '已请求停止，正在收尾。';
      } catch (error) {
        if (handleError(error)) return;
        state.notice = '停止请求暂未完成，请稍后刷新确认。';
      }
      render();
      void loadJobs();
    });
  }));

  document.querySelector('[data-service-history]')?.addEventListener('toggle', (event) => {
    state.progressHistoryOpen = event.currentTarget.open;
  });

  document.querySelectorAll('[data-admin-jobs-view]').forEach(button => button.addEventListener('click', () => {
    if (!isAdmin()) return;
    state.admin.jobsView = button.dataset.adminJobsView === 'history' ? 'history' : 'current';
    render();
  }));

  document.querySelectorAll('[data-admin-jobs-kind]').forEach(button => button.addEventListener('click', () => {
    if (!isAdmin()) return;
    const kind = button.dataset.adminJobsKind;
    state.admin.jobsKind = ['collection', 'all'].includes(kind) ? kind : 'service';
    render();
  }));

  document.querySelectorAll('[data-admin-job-detail]').forEach(button => button.addEventListener('click', () => {
    if (!isAdmin()) return;
    const job = state.admin.jobs.find(item => item.id === button.dataset.adminJobDetail);
    if (job) showModal(`<div id="modal-title">${renderAdminJobDetail(job)}</div>`);
  }));

  document.querySelectorAll('[data-user-status]').forEach(button => button.addEventListener('click', () => {
    if (!isAdmin()) return;
    const id = button.dataset.userStatus;
    const status = button.dataset.nextStatus === 'active' ? 'active' : 'disabled';
    showModal(`<h2 id="modal-title">${status === 'active' ? '恢复' : '暂停'}该用户的服务？</h2>
      <p class="subtext">此操作会记录到管理审计。不会更改用户的头歌账号。</p>
      <div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认${status === 'active' ? '恢复' : '暂停'}</button></div>`,
    async () => { await adminAction(() => api.adminUserStatus(id, status)); });
  }));

  document.querySelectorAll('[data-admin-cancel]').forEach(button => button.addEventListener('click', () => {
    if (!isAdmin()) return;
    const id = button.dataset.adminCancel;
    showModal('<h2 id="modal-title">停止该任务？</h2><p class="subtext">会保留已完成的结果，停止后续处理。此操作会记录到管理审计。</p><div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认停止</button></div>',
      async () => { await adminAction(() => api.adminCancelJob(id)); });
  }));

  document.querySelectorAll('[data-revoke-card]').forEach(button => button.addEventListener('click', () => {
    if (!isAdmin()) return;
    const id = button.dataset.revokeCard;
    showModal('<h2 id="modal-title">停用这张卡密？</h2><p class="subtext">停用后将不能用于开通新的服务。此操作会记录到审计。</p><div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认停用</button></div>',
      async () => { await adminAction(() => api.adminRevokeCard(id)); });
  }));

  document.querySelectorAll('[data-action]').forEach(element => element.addEventListener(element instanceof HTMLInputElement ? 'change' : 'click', () => {
    switch (element.dataset.action) {
      case 'logout': void logout(); break;
      case 'refresh': void loadCourses(); break;
      case 'jobs-refresh': void loadJobs(); break;
      case 'admin-refresh': void loadAdmin(); break;
      case 'create-card': newCard(); break;
      case 'bank-refresh': void loadMeta(); break;
      case 'start-all': confirmStart(true); break;
      case 'start-selected': confirmStart(false); break;
      case 'select-all':
        state.selected = element.checked ? state.courses.filter(course => !coursePending(course.identifier)).map(course => course.identifier) : [];
        render();
        break;
      case 'close-modal': closeModal(); break;
      case 'modal-confirm': {
        const action = state.modalAction;
        state.modalAction = null;
        if (action) void action();
        break;
      }
      default: break;
    }
  }));

  document.querySelector('[data-avatar]')?.addEventListener('error', () => {
    if (state.user) { state.user.avatarUrl = undefined; render(); }
  });

  // ---------- 反馈工单 ----------
  document.querySelector('#support-create-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitSupport(event.currentTarget);
  });
  document.querySelector('#support-reply-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void replySupport(event.currentTarget);
  });
  document.querySelectorAll('[data-support-open]').forEach(button => button.addEventListener('click', () => { void openSupport(button.dataset.supportOpen); }));
  document.querySelectorAll('[data-support-filter]').forEach(button => button.addEventListener('click', () => {
    state.support.filter = button.dataset.supportFilter;
    void loadSupport();
  }));
  document.querySelector('[data-support-refresh]')?.addEventListener('click', () => { void loadSupport(); });
  document.querySelector('[data-support-more]')?.addEventListener('click', () => { void loadSupport({ append: true }); });
  document.querySelectorAll('[data-support-status]').forEach(button => button.addEventListener('click', () => {
    void updateSupportStatus(button.dataset.supportId, button.dataset.supportStatus);
  }));
  document.querySelector('[data-support-detail-refresh]')?.addEventListener('click', (event) => {
    void openSupport(event.currentTarget.dataset.supportDetailRefresh);
  });
  document.querySelectorAll('[data-action="guidelines"]').forEach(button => button.addEventListener('click', () => {
    showModal(renderGuidelines());
  }));

  // 任务恢复 / 重跑
  document.querySelectorAll('[data-recover-job]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.recoverJob;
    showModal(`<h2 id="modal-title">恢复这次任务？</h2><p class="subtext">中断的任务会重新排队，已完成的关卡不会重复提交。</p>
      <div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认恢复</button></div>`,
    async () => {
      closeModal();
      try {
        await api.recoverJob(id);
        state.notice = '任务已重新排队。';
      } catch (error) {
        if (handleError(error)) return;
        state.notice = '恢复没有成功，请稍后刷新确认。';
      }
      render();
      void loadJobs();
    });
  }));

  document.querySelectorAll('[data-retry-job]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.retryJob;
    showModal(`<h2 id="modal-title">重新安排一次？</h2><p class="subtext">会按原来的范围新建一个任务，历史记录保留。</p>
      <div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="modal-confirm">确认安排</button></div>`,
    async () => {
      closeModal();
      try {
        await api.retryJob(id);
        state.notice = '已重新安排，正在排队。';
      } catch (error) {
        if (handleError(error)) return;
        state.notice = '重新安排没有成功，请稍后刷新确认。';
      }
      render();
      void loadJobs();
    });
  }));
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal) closeModal();
  if (event.key === 'Tab' && state.modal) {
    const items = [...document.querySelectorAll('.modal button, .modal input, .modal a[href]')].filter(item => !item.disabled);
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

async function restore() {
  const session = generation;
  try {
    const user = await api.me();
    if (session !== generation) return;
    state.user = user;
    render();
    void loadJobs();
    void loadCourses();
    void loadMeta();
  } catch { /* 保留登录表单 */ }
}

render();
void api.authConfig().then((config) => {
  state.cardRequired = Boolean(config?.access_card_required);
  state.demoMode = config?.upstream === 'mock';
  if (!state.user && !state.signingIn) render();
}).catch(() => {});
void restore();

