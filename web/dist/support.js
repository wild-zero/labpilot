// 反馈工单界面：提交表单 / 记录列表 / 对话详情。纯渲染函数，状态与请求都在 app.js 里。
import { dateTime, escapeHtml as e, icon } from './ui.js';

export const supportCategories = {
  task: '课程与任务',
  account: '账号使用',
  data: '数据与隐私',
  suggestion: '意见建议',
  other: '其他问题',
};

export const supportStatuses = {
  open: '待回复',
  processing: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};

export const supportPrivacyHint = '请勿填写密码、Cookie 或密钥；工单只用于跟进问题，不进入题库。';

const known = (value) => Object.prototype.hasOwnProperty.call(supportStatuses, value);
const categoryLabel = (value) => supportCategories[value] ?? '其他问题';
const withBreaks = (value) => e(value).replace(/\r\n?|\n/g, '<br>');

function statusPill(status) {
  return `<span class="support-pill support-pill-${known(status) ? e(status) : 'unknown'}">${e(supportStatuses[status] ?? '状态待确认')}</span>`;
}

function composeForm(busy) {
  const options = Object.entries(supportCategories)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');
  return `<section class="support-card support-compose" aria-labelledby="support-create-title">
    <header class="support-card-head"><h2 id="support-create-title">提交问题</h2><span class="support-muted">服务人员会在同一条记录里回复</span></header>
    <form id="support-create-form" class="support-form">
      <div class="support-form-row">
        <label class="support-field"><span>问题标题</span><input name="subject" required maxlength="100" placeholder="用一句话描述你遇到的问题" ${busy ? 'disabled' : ''}></label>
        <label class="support-field"><span>问题分类</span><select name="category" ${busy ? 'disabled' : ''}>${options}</select></label>
      </div>
      <label class="support-field"><span>详细说明</span><textarea name="body" required maxlength="5000" rows="5" placeholder="写明课程、作业名称、遇到的情况，以及希望我们协助的事项。" ${busy ? 'disabled' : ''}></textarea></label>
      <div class="support-form-foot"><p class="support-hint">${e(supportPrivacyHint)}</p>
        <button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在提交…' : '提交反馈'}</button></div>
    </form>
  </section>`;
}

export function renderSupportWorkspace(state, admin) {
  const filter = state.filter ?? 'all';
  const tabs = ['all', 'open', 'processing', 'resolved', 'closed'];
  const rows = (state.items ?? []).map((item) => `<tr>
    ${admin ? `<td class="support-user"><strong>${e(item.user?.name || '用户姓名未提供')}</strong></td>` : ''}
    <td class="support-subject"><button type="button" class="link-button" data-support-open="${e(item.id)}">${e(item.subject)}</button>
      <small>${e(categoryLabel(item.category))} · ${e(item.message_count)} 条记录${item.last_author_role === 'admin' ? ' · 服务人员已回复' : ''}</small></td>
    <td>${statusPill(item.status)}</td>
    <td class="support-time"><time datetime="${e(item.updated_at)}">${e(dateTime(item.updated_at))}</time></td>
    <td><button type="button" class="link-button" data-support-open="${e(item.id)}" aria-label="查看反馈：${e(item.subject)}">查看 ${icon('arrow')}</button></td>
  </tr>`).join('');

  const emptyText = state.loading ? '正在读取反馈记录…'
    : filter === 'all' ? '还没有反馈记录。遇到问题时，可以在这里联系我们。'
      : '这个状态下暂时没有反馈记录。';

  return `<div class="support-workspace ${admin ? 'support-workspace-admin' : ''}">
    <header class="support-page-head">
      <div><p class="support-kicker">${admin ? 'SUPPORT DESK' : 'WE ARE HERE'}</p>
        <h1>${admin ? '反馈工单' : '问题反馈'}</h1>
        <p class="support-subtitle">${admin ? '查看用户反馈，回复处理进展，及时跟进每一个问题。' : '遇到问题留个消息。你可以在这里查看回复并继续补充情况。'}</p></div>
      <div class="support-head-actions"><button type="button" class="button" data-support-refresh ${state.loading ? 'disabled' : ''}>${icon('refresh')}刷新记录</button></div>
    </header>
    ${state.error ? `<p class="support-error" role="alert">${e(state.error)}</p>` : ''}
    ${admin ? '' : composeForm(Boolean(state.submitting))}
    <section class="support-card support-list" aria-label="${admin ? '用户反馈记录' : '我的反馈记录'}">
      <header class="support-card-head"><h2>${admin ? '所有反馈' : '我的反馈'}</h2>
        <div class="support-tabs" role="group" aria-label="按状态筛选">${tabs.map(value => `<button type="button" data-support-filter="${value}" class="${filter === value ? 'is-active' : ''}" aria-pressed="${filter === value}">${value === 'all' ? '全部' : supportStatuses[value]}</button>`).join('')}</div>
      </header>
      <div class="support-table-wrap"><table class="support-table">
        <thead><tr>${admin ? '<th>用户</th>' : ''}<th>反馈内容</th><th>状态</th><th>更新时间</th><th><span class="support-sr">操作</span></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="${admin ? 5 : 4}" class="support-empty">${e(emptyText)}</td></tr>`}</tbody>
      </table></div>
      ${state.nextCursor ? `<div class="support-pager"><button type="button" class="button" data-support-more="${e(state.nextCursor)}" ${state.loading ? 'disabled' : ''}>${state.loading ? '正在读取…' : '加载更多'}</button></div>` : ''}
    </section>
  </div>`;
}

export function renderSupportDetail(detail, admin, busy = false) {
  const record = detail.ticket;
  const canDecide = known(record.status);
  const actions = admin
    ? Object.keys(supportStatuses)
    : record.status === 'closed' || record.status === 'resolved' ? ['open', 'closed'] : ['closed'];

  const bubbles = (detail.messages ?? []).map((message) => {
    const fromAdmin = message.author_role === 'admin';
    const who = fromAdmin ? '服务人员' : admin ? (record.user?.name || '用户') : '我';
    return `<article class="support-bubble ${fromAdmin ? 'support-bubble-admin' : 'support-bubble-user'}">
      <header><strong>${e(who)}</strong><time datetime="${e(message.created_at)}">${e(dateTime(message.created_at))}</time></header>
      <div class="support-bubble-body">${withBreaks(message.body)}</div>
    </article>`;
  }).join('');

  const canReply = canDecide && record.status !== 'closed';
  return `<section class="support-detail" data-support-detail="${e(record.id)}" aria-busy="${busy}">
    <div class="support-detail-head">
      <div><h3 id="modal-title">${e(record.subject)}</h3>
        <p class="support-meta">${statusPill(record.status)}<span>${e(categoryLabel(record.category))}</span>${admin ? `<span>${e(record.user?.name || '用户姓名未提供')}</span>` : ''}<span>创建于 ${e(dateTime(record.created_at))}</span></p></div>
      <button type="button" class="icon-button" data-support-detail-refresh="${e(record.id)}" aria-label="刷新反馈详情" title="刷新反馈详情" ${busy ? 'disabled' : ''}>${icon('refresh')}</button>
    </div>
    <div class="support-actions" role="group" aria-label="工单处理">${canDecide
      ? actions.filter(status => status !== record.status).map(status => `<button class="button" type="button" data-support-status="${status}" data-support-id="${e(record.id)}" ${busy ? 'disabled' : ''}>${admin ? `标记为${supportStatuses[status]}` : status === 'open' ? '重新打开' : '关闭反馈'}</button>`).join('')
      : '<p class="support-muted">当前状态暂未确认，请刷新后重试。</p>'}</div>
    <div class="support-conversation" aria-label="反馈对话">${bubbles || '<p class="support-empty">暂时没有可显示的对话记录，请刷新后查看。</p>'}</div>
    ${canReply ? `<form id="support-reply-form" class="support-reply" data-support-id="${e(record.id)}">
      <label class="support-field"><span>${admin ? '回复用户' : '补充说明'}</span>
        <textarea name="body" required maxlength="5000" rows="4" ${busy ? 'disabled' : ''} placeholder="${admin ? '写下答复及处理进展。' : '补充有助于我们了解问题的信息。'}"></textarea></label>
      <div class="support-form-foot"><p class="support-hint">${e(supportPrivacyHint)}</p>
        <button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在发送…' : admin ? '发送回复' : '发送补充'}</button></div>
    </form>`
    : record.status === 'closed' ? '<p class="support-closed">这条反馈已关闭，需要继续沟通时可以重新打开。</p>' : ''}
  </section>`;
}

export function renderGuidelines() {
  return `<article class="guideline-doc">
    <p class="support-kicker">使用与数据说明</p>
    <h2 id="modal-title">用户准则</h2>
    <p class="support-subtitle">先了解服务方式、数据用途和使用说明。有问题可以通过「问题反馈」联系我们。</p>
    <section><h3>服务方式</h3>
      <p>本站通过接口同步课程、作业与关卡状态，保存作答应答并读取评测结果，使用时不需要一直停留在原站页面。</p>
      <p>本站是独立服务，不隶属于任何教学平台；请遵守课程与学校的相关规定。平台规则或风控变化都可能影响服务，请自行评估相关风险。</p>
    </section>
    <section><h3>账号与数据</h3>
      <p>登录使用你在教学平台的账号换取会话，会话加密后仅用于本次服务期间的接口调用；密码不会写入本地数据库。</p>
      <p>题库只保存题目指纹与已验证答案，用于减少重复求解；工单内容不属于题库，也不会用于训练或对外提供。</p>
    </section>
    <section><h3>能做什么、不做什么</h3>
      <p>做作业批次的自动安排、逐关求解、提交与评测修复；做不了的关卡（需要监考、需要人工画图、平台锁定的）会明确标成待跟进，不会假装完成。</p>
      <p>不代刷、不绕过平台的人脸与监考环节，也不处理要求线下到场的任务。</p>
    </section>
  </article>`;
}
