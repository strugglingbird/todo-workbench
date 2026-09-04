const api = window.workbench;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  currentView: 'dashboard',
  dashboard: null,
  tasks: [],
  selectedTask: null,
  settings: null,
  report: null,
  filters: { status: 'all', priority: 'all', search: '' },
};

const viewCopy = {
  dashboard: ['工作概览', '聚焦今天，稳步推进每一件事。'],
  tasks: ['待办任务', '管理任务、责任关系与每一次推进。'],
  reports: ['工作汇报', '把过程记录沉淀为清晰、可信的工作成果。'],
  settings: ['系统设置', '按你的工作环境配置启动、存储与模型能力。'],
};

const statusMeta = {
  todo: { label: '待开始', className: 'status-todo' },
  doing: { label: '进行中', className: 'status-doing' },
  blocked: { label: '受阻', className: 'status-blocked' },
  done: { label: '已完成', className: 'status-done' },
};

const priorityMeta = {
  low: { label: '低', color: '#88a59d' },
  medium: { label: '中', color: '#d4a63e' },
  high: { label: '高', color: '#e47b4f' },
  urgent: { label: '紧急', color: '#b9453e' },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readableError(error) {
  return String(error?.message || error || '操作失败')
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '');
}

function dateFromValue(value) {
  if (!value) return null;
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
}

function formatDate(value, withTime = false) {
  const date = dateFromValue(value);
  if (!date || Number.isNaN(date.getTime())) return '未设置';
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function monthDay(value) {
  const date = dateFromValue(value);
  if (!date) return { day: '--', month: '--' };
  return { day: String(date.getDate()).padStart(2, '0'), month: `${date.getMonth() + 1}月` };
}

function localDateInput(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function localDateTimeInput(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function relativeDate(value) {
  const date = dateFromValue(value);
  if (!date) return '未设截止时间';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  const days = Math.round((date - today) / 86_400_000);
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天截止';
  if (days === 1) return '明天截止';
  return `${days} 天后截止`;
}

function showLoading(message = '正在处理...') {
  $('#loading-message').textContent = message;
  $('#loading-overlay').hidden = false;
}

function hideLoading() {
  $('#loading-overlay').hidden = true;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toast-stack').append(element);
  setTimeout(() => element.remove(), 3_500);
}

function emptyState(title, detail) {
  return `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></div>`;
}

function switchView(view) {
  state.currentView = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  $('#view-title').textContent = viewCopy[view][0];
  $('#view-subtitle').textContent = viewCopy[view][1];
  $('#add-task-button').hidden = view === 'settings';
  if (view === 'tasks') loadTasks();
  if (view === 'dashboard') loadDashboard();
  if (view === 'settings') loadSettings();
}

function renderDashboard() {
  const dashboard = state.dashboard || { counts: {}, recent: [], upcoming: [] };
  const counts = dashboard.counts || {};
  const total = Number(counts.total || 0);
  const done = Number(counts.done || 0);
  const average = Number(counts.average_progress || 0);
  $('#nav-task-count').textContent = String(Math.max(0, total - done));
  $('#hero-summary').textContent = total
    ? `目前共有 ${total - done} 项待推进工作，${counts.doing || 0} 项正在进行，${counts.blocked || 0} 项需要关注。`
    : '还没有任务记录，从创建第一项待办开始安排今天。';
  $('#overall-progress').style.setProperty('--progress', `${average * 3.6}deg`);
  $('#overall-progress strong').textContent = `${average}%`;

  const stats = [
    ['全部任务', total, 'all', '#6b918a'],
    ['进行中', Number(counts.doing || 0), 'doing', '#3b8b7e'],
    ['待开始', Number(counts.todo || 0), 'todo', '#d4a63e'],
    ['受阻事项', Number(counts.blocked || 0), 'blocked', '#d46149'],
  ];
  $('#stat-grid').innerHTML = stats.map(([label, value, status, color]) => `
    <article class="stat-card" data-stat-status="${status}" style="--stat-color:${color}">
      <span>${label}</span><strong>${value}</strong><i></i>
    </article>
  `).join('');

  $('#recent-activity').innerHTML = dashboard.recent?.length
    ? dashboard.recent.map((entry) => `
      <div class="activity-item" data-task-id="${entry.task_id}">
        <span class="activity-mark">${entry.progress}%</span>
        <div><strong>${escapeHtml(entry.task_title)}</strong><p>${escapeHtml(entry.completed_work)}</p></div>
        <time>${formatDate(entry.occurred_at, true)}</time>
      </div>
    `).join('')
    : emptyState('暂无进度动态', '填报任务进度后会显示在这里。');

  $('#upcoming-list').innerHTML = dashboard.upcoming?.length
    ? dashboard.upcoming.map((task) => {
      const date = monthDay(task.due_date);
      return `
        <div class="upcoming-item" data-task-id="${task.id}">
          <div class="date-tile"><strong>${date.day}</strong><span>${date.month}</span></div>
          <div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(relativeDate(task.due_date))} · ${task.progress}%</p></div>
        </div>
      `;
    }).join('')
    : emptyState('暂无临近截止任务', '设置任务截止日期后会在这里提醒。');
}

async function loadDashboard() {
  try {
    state.dashboard = await api.dashboard.get();
    renderDashboard();
  } catch (error) {
    toast(readableError(error), 'error');
  }
}

function renderTasks() {
  $('#task-result-count').textContent = `${state.tasks.length} 个任务`;
  $('#task-grid').innerHTML = state.tasks.length
    ? state.tasks.map((task) => {
      const status = statusMeta[task.status] || statusMeta.todo;
      const priority = priorityMeta[task.priority] || priorityMeta.medium;
      const dueClass = task.due_date && task.status !== 'done' && dateFromValue(task.due_date) < new Date().setHours(0, 0, 0, 0) ? 'overdue' : '';
      return `
        <article class="task-card" data-task-id="${task.id}" style="--priority-color:${priority.color};--progress-color:${priority.color}">
          <div class="task-card-top">
            <span class="status-badge ${status.className}">${status.label}</span>
            <span class="priority-badge">${priority.label}优先级</span>
          </div>
          <h3>${escapeHtml(task.title)}</h3>
          <p class="task-description">${escapeHtml(task.description || '暂无任务说明')}</p>
          <div class="task-people"><span>需求：${escapeHtml(task.requester || '未填写')}</span><span>负责：${escapeHtml(task.owner || '未填写')}</span></div>
          <div class="task-card-footer">
            <div class="task-progress-label"><span>完成进度</span><strong>${task.progress}%</strong></div>
            <div class="progress-track"><span style="width:${task.progress}%"></span></div>
            <div class="task-meta-row"><span class="${dueClass}">${escapeHtml(relativeDate(task.due_date))}</span><span>${task.timeline_count || 0} 条进展</span></div>
          </div>
        </article>
      `;
    }).join('')
    : emptyState('没有匹配的任务', '调整筛选条件，或新建一项任务。');
}

async function loadTasks() {
  try {
    state.tasks = await api.tasks.list(state.filters);
    renderTasks();
  } catch (error) {
    toast(readableError(error), 'error');
  }
}

function openTaskForm(task = null) {
  $('#task-form').reset();
  $('#task-id').value = task?.id || '';
  $('#task-dialog-title').textContent = task ? '编辑任务' : '新建任务';
  $('#task-title').value = task?.title || '';
  $('#task-status').value = task?.status || 'todo';
  $('#task-priority').value = task?.priority || 'medium';
  $('#task-requester').value = task?.requester || '';
  $('#task-owner').value = task?.owner || '';
  $('#task-collaborators').value = task?.collaborators || '';
  $('#task-start-date').value = task?.start_date?.slice(0, 10) || localDateInput();
  $('#task-due-date').value = task?.due_date?.slice(0, 10) || '';
  $('#task-progress').value = task?.progress || 0;
  $('#task-progress-value').textContent = `${task?.progress || 0}%`;
  $('#task-description').value = task?.description || '';
  $('#task-dialog').showModal();
  setTimeout(() => $('#task-title').focus(), 50);
}

async function saveTask(event) {
  event.preventDefault();
  const id = $('#task-id').value;
  const payload = {
    title: $('#task-title').value,
    status: $('#task-status').value,
    priority: $('#task-priority').value,
    requester: $('#task-requester').value,
    owner: $('#task-owner').value,
    collaborators: $('#task-collaborators').value,
    start_date: $('#task-start-date').value || null,
    due_date: $('#task-due-date').value || null,
    progress: Number($('#task-progress').value),
    description: $('#task-description').value,
  };
  showLoading(id ? '正在更新任务...' : '正在创建任务...');
  try {
    const task = id ? await api.tasks.update(Number(id), payload) : await api.tasks.create(payload);
    $('#task-dialog').close();
    toast(id ? '任务已更新' : '任务已创建');
    await Promise.all([loadTasks(), loadDashboard()]);
    if (id && $('#detail-dialog').open) await openTaskDetails(task.id);
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

function renderTaskDetail(task) {
  const status = statusMeta[task.status] || statusMeta.todo;
  const priority = priorityMeta[task.priority] || priorityMeta.medium;
  const timeline = task.timeline || [];
  $('#task-detail').innerHTML = `
    <header class="detail-cover">
      <button class="modal-close" data-close-dialog="detail-dialog">×</button>
      <div><span class="status-badge ${status.className}">${status.label}</span></div>
      <h2>${escapeHtml(task.title)}</h2>
      <p>${escapeHtml(task.description || '暂无任务说明')}</p>
      <div class="detail-progress"><div class="progress-track"><span style="width:${task.progress}%"></span></div><strong>${task.progress}%</strong></div>
    </header>
    <div class="detail-body">
      <div class="detail-facts">
        <div class="fact"><span>需求人</span><strong>${escapeHtml(task.requester || '未填写')}</strong></div>
        <div class="fact"><span>负责人</span><strong>${escapeHtml(task.owner || '未填写')}</strong></div>
        <div class="fact"><span>协作 / 对接人</span><strong>${escapeHtml(task.collaborators || '未填写')}</strong></div>
        <div class="fact"><span>截止日期</span><strong>${escapeHtml(formatDate(task.due_date))}</strong></div>
      </div>
      <div class="detail-actions">
        <button class="button button-primary" data-detail-action="progress">＋ 填报进度</button>
        <button class="button button-ghost" data-detail-action="edit">编辑任务</button>
        ${task.status !== 'done' ? '<button class="button button-ghost" data-detail-action="complete">完成任务</button>' : ''}
        <button class="button button-danger" data-detail-action="delete">删除</button>
      </div>
      <div class="timeline-heading"><h3>完整处理流程</h3><span>${timeline.length} 条进度记录</span></div>
      ${timeline.length ? `<div class="timeline">${timeline.map((entry) => `
        <article class="timeline-entry">
          <div class="timeline-entry-head"><strong>进度推进至 ${entry.progress}%</strong><time>${formatDate(entry.occurred_at, true)}</time></div>
          <div class="timeline-entry-grid">
            <div class="timeline-block"><span>本次完成</span><p>${escapeHtml(entry.completed_work)}</p></div>
            <div class="timeline-block"><span>下一步待跟进</span><p>${escapeHtml(entry.next_steps || '暂无')}</p></div>
            <div class="timeline-block"><span>需求人</span><p>${escapeHtml(entry.requester || task.requester || '未填写')}</p></div>
            <div class="timeline-block"><span>待对接 / 沟通人</span><p>${escapeHtml(entry.contacts || '暂无')}</p></div>
          </div>
        </article>
      `).join('')}</div>` : '<div class="timeline-empty">还没有进度记录，第一次推进后从这里开始沉淀过程。</div>'}
    </div>
  `;
}

async function openTaskDetails(id) {
  try {
    state.selectedTask = await api.tasks.get(Number(id));
    if (!state.selectedTask) throw new Error('任务不存在或已被删除。');
    renderTaskDetail(state.selectedTask);
    if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  } catch (error) {
    toast(readableError(error), 'error');
  }
}

function openProgressForm(task, complete = false) {
  $('#progress-form').reset();
  $('#progress-task-id').value = task.id;
  $('#progress-task-title').textContent = task.title;
  $('#progress-time').value = localDateTimeInput();
  $('#progress-value').value = complete ? 100 : task.progress;
  $('#progress-value-label').textContent = `${complete ? 100 : task.progress}%`;
  $('#progress-requester').value = task.requester || '';
  if (complete) {
    $('#progress-completed').value = '任务已完成并交付。';
    $('#progress-next').value = '等待需求人确认验收。';
  }
  $('#progress-dialog').showModal();
  setTimeout(() => $('#progress-completed').focus(), 50);
}

async function saveProgress(event) {
  event.preventDefault();
  const taskId = Number($('#progress-task-id').value);
  const payload = {
    completed_work: $('#progress-completed').value,
    occurred_at: new Date($('#progress-time').value).toISOString(),
    progress: Number($('#progress-value').value),
    requester: $('#progress-requester').value,
    contacts: $('#progress-contacts').value,
    next_steps: $('#progress-next').value,
  };
  showLoading('正在保存进度记录...');
  try {
    state.selectedTask = await api.tasks.addProgress(taskId, payload);
    $('#progress-dialog').close();
    renderTaskDetail(state.selectedTask);
    toast('进度记录已加入任务时间线');
    await Promise.all([loadTasks(), loadDashboard()]);
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

async function deleteSelectedTask() {
  const task = state.selectedTask;
  if (!task || !window.confirm(`确定删除“${task.title}”吗？任务的全部进度记录也会删除。`)) return;
  showLoading('正在删除任务...');
  try {
    await api.tasks.delete(task.id);
    $('#detail-dialog').close();
    state.selectedTask = null;
    toast('任务已删除');
    await Promise.all([loadTasks(), loadDashboard()]);
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

async function generateReport(event) {
  event.preventDefault();
  const request = {
    type: $('#report-type').value,
    anchorDate: $('#report-anchor').value,
    useAi: $('#report-use-ai').checked,
  };
  const useAi = request.useAi;
  showLoading(useAi ? '大模型正在整理汇报...' : '正在汇总任务记录...');
  try {
    state.report = { ...await api.reports.generate(request), request };
    $('#report-preview-title').textContent = state.report.period.title;
    $('#report-markdown').textContent = state.report.markdown;
    $('#report-markdown').hidden = false;
    $('#report-empty').hidden = true;
    $('#export-actions').hidden = false;
    toast(`${state.report.taskCount} 项任务已汇总${state.report.polished ? '并完成润色' : ''}`);
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

async function exportCurrentReport(format) {
  if (!state.report) return;
  if (format === 'excel') {
    await exportExcelReport();
    return;
  }
  showLoading(`正在导出 ${format.toUpperCase()}...`);
  try {
    const result = await api.reports.export({
      markdown: state.report.markdown,
      title: state.report.period.title,
      format,
    });
    if (!result.canceled) toast(`汇报已导出到 ${result.filePath}`);
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

async function exportExcelReport() {
  const templateId = $('#excel-template-select').value;
  const template = state.settings?.excel?.templates.find((item) => item.id === templateId);
  if (!template) {
    toast('请先选择一个 Excel 表格模板。', 'error');
    return;
  }
  showLoading(state.report.polished ? '大模型正在按表头匹配并生成 Excel...' : '正在生成 Excel 工作簿...');
  try {
    const result = await api.reports.exportExcel({
      type: state.report.request.type,
      anchorDate: state.report.request.anchorDate,
      useAi: state.report.polished,
      templateId,
    });
    if (!result.canceled) {
      toast(`Excel 已导出：${result.rowCount} 行 × ${result.columnCount} 列`);
    }
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

function databaseFormValue() {
  return {
    type: $('input[name="database-type"]:checked').value,
    sqlitePath: $('#sqlite-path').value,
    mysql: {
      host: $('#mysql-host').value,
      port: Number($('#mysql-port').value),
      database: $('#mysql-database').value,
      user: $('#mysql-user').value,
      password: $('#mysql-password').value,
    },
  };
}

function aiFormValue() {
  return {
    enabled: $('#ai-enabled').checked,
    endpoint: $('#ai-endpoint').value,
    model: $('#ai-model').value,
    apiKey: $('#ai-key').value,
  };
}

function renderExcelTemplates() {
  const excel = state.settings?.excel;
  if (!excel) return;
  const select = $('#excel-template-select');
  select.innerHTML = excel.templates.map((template) => `
    <option value="${escapeHtml(template.id)}">${escapeHtml(template.name)} · ${template.headers.length} 列</option>
  `).join('');
  select.value = excel.activeTemplateId;
}

function openExcelTemplateForm(createNew = false) {
  const excel = state.settings?.excel;
  const selectedId = $('#excel-template-select').value || excel?.activeTemplateId;
  const template = createNew ? null : excel?.templates.find((item) => item.id === selectedId);
  $('#excel-template-id').value = template?.id || '';
  $('#excel-template-name').value = template?.name || '';
  $('#excel-template-headers').value = template?.headers.join('\n') || '';
  $('#excel-template-dialog-title').textContent = template ? '编辑表格模板' : '新建表格模板';
  $('#delete-excel-template').hidden = !template;
  if (!$('#excel-template-dialog').open) $('#excel-template-dialog').showModal();
  setTimeout(() => $('#excel-template-name').focus(), 50);
}

function parseTemplateHeaders(value) {
  return [...new Set(String(value).split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))];
}

async function saveExcelTemplate(event) {
  event.preventDefault();
  const name = $('#excel-template-name').value.trim();
  const headers = parseTemplateHeaders($('#excel-template-headers').value);
  if (!name || !headers.length) {
    toast('请填写模板名称和至少一个表头。', 'error');
    return;
  }
  if (headers.length > 30) {
    toast('一个模板最多支持 30 个表头。', 'error');
    return;
  }
  const excel = state.settings.excel;
  const currentId = $('#excel-template-id').value;
  const id = currentId || `custom-${Date.now()}`;
  const templates = currentId
    ? excel.templates.map((item) => item.id === currentId ? { id, name, headers } : item)
    : [...excel.templates, { id, name, headers }];
  showLoading('正在保存 Excel 模板...');
  try {
    state.settings.excel = await api.settings.saveExcel({ activeTemplateId: id, templates });
    renderExcelTemplates();
    $('#excel-template-dialog').close();
    toast('Excel 表格模板已保存');
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

async function deleteExcelTemplate() {
  const excel = state.settings.excel;
  const id = $('#excel-template-id').value;
  const template = excel.templates.find((item) => item.id === id);
  if (!template) return;
  if (excel.templates.length <= 1) {
    toast('至少需要保留一个 Excel 模板。', 'error');
    return;
  }
  if (!window.confirm(`确定删除表格模板“${template.name}”吗？`)) return;
  showLoading('正在删除 Excel 模板...');
  try {
    const templates = excel.templates.filter((item) => item.id !== id);
    state.settings.excel = await api.settings.saveExcel({
      activeTemplateId: templates[0].id,
      templates,
    });
    renderExcelTemplates();
    $('#excel-template-dialog').close();
    toast('Excel 表格模板已删除');
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

async function selectExcelTemplate() {
  const excel = state.settings?.excel;
  if (!excel) return;
  try {
    state.settings.excel = await api.settings.saveExcel({
      activeTemplateId: $('#excel-template-select').value,
      templates: excel.templates,
    });
  } catch (error) {
    toast(readableError(error), 'error');
  }
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $('#startup-setting').checked = settings.startup;
  $(`input[name="database-type"][value="${settings.database.type}"]`).checked = true;
  $('#sqlite-path').value = settings.database.sqlitePath || '';
  $('#mysql-host').value = settings.database.mysql.host || '';
  $('#mysql-port').value = settings.database.mysql.port || 3306;
  $('#mysql-database').value = settings.database.mysql.database || '';
  $('#mysql-user').value = settings.database.mysql.user || '';
  $('#mysql-password').value = '';
  $('#mysql-password-hint').textContent = settings.database.mysql.hasPassword ? '已安全保存密码，留空不会修改。' : '尚未保存密码。';
  $('#ai-enabled').checked = settings.ai.enabled;
  $('#ai-endpoint').value = settings.ai.endpoint || '';
  $('#ai-model').value = settings.ai.model || '';
  $('#ai-key').value = '';
  $('#ai-key-hint').textContent = settings.ai.hasApiKey ? '已使用系统凭据加密保存，留空不会修改。' : '尚未保存 API Key。';
  $('#report-use-ai').disabled = !settings.ai.enabled;
  $('#ai-hint').textContent = settings.ai.enabled ? `使用 ${settings.ai.model}` : '需先在设置中启用';
  $('#storage-label').textContent = settings.database.type === 'mysql' ? 'MySQL 数据库' : '本地 SQLite';
  renderExcelTemplates();
  toggleDatabaseFields();
}

async function loadSettings() {
  try {
    state.settings = await api.settings.get();
    renderSettings();
  } catch (error) {
    toast(readableError(error), 'error');
  }
}

function toggleDatabaseFields() {
  const type = $('input[name="database-type"]:checked').value;
  $('#sqlite-fields').hidden = type !== 'sqlite';
  $('#mysql-fields').hidden = type !== 'mysql';
}

async function testDatabase() {
  const result = $('#database-test-result');
  result.className = '';
  result.textContent = '正在连接...';
  try {
    await api.settings.testDatabase(databaseFormValue());
    result.className = 'success';
    result.textContent = '连接成功，数据表已就绪。';
  } catch (error) {
    result.className = 'error';
    result.textContent = readableError(error);
  }
}

async function testModel() {
  const result = $('#ai-test-result');
  result.className = '';
  result.textContent = '正在请求模型...';
  try {
    const response = await api.settings.testAi(aiFormValue());
    result.className = 'success';
    result.textContent = response.message || '模型连接成功。';
  } catch (error) {
    result.className = 'error';
    result.textContent = readableError(error);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  showLoading('正在验证并保存设置...');
  try {
    state.settings = await api.settings.save({
      startup: $('#startup-setting').checked,
      database: databaseFormValue(),
      ai: aiFormValue(),
    });
    renderSettings();
    await Promise.all([loadTasks(), loadDashboard()]);
    toast('设置已保存并生效');
  } catch (error) {
    toast(readableError(error), 'error');
  } finally {
    hideLoading();
  }
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#add-task-button').addEventListener('click', () => openTaskForm());
  $('#task-form').addEventListener('submit', saveTask);
  $('#progress-form').addEventListener('submit', saveProgress);
  $('#report-form').addEventListener('submit', generateReport);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#excel-template-form').addEventListener('submit', saveExcelTemplate);
  $('#test-database').addEventListener('click', testDatabase);
  $('#test-ai').addEventListener('click', testModel);
  $('#manage-excel-template').addEventListener('click', () => openExcelTemplateForm());
  $('#new-excel-template').addEventListener('click', () => openExcelTemplateForm(true));
  $('#delete-excel-template').addEventListener('click', deleteExcelTemplate);
  $('#excel-template-select').addEventListener('change', selectExcelTemplate);

  $('#task-progress').addEventListener('input', (event) => {
    $('#task-progress-value').textContent = `${event.target.value}%`;
    if (Number(event.target.value) === 100) $('#task-status').value = 'done';
  });
  $('#task-status').addEventListener('change', (event) => {
    if (event.target.value === 'done') {
      $('#task-progress').value = 100;
      $('#task-progress-value').textContent = '100%';
    }
  });
  $('#progress-value').addEventListener('input', (event) => {
    $('#progress-value-label').textContent = `${event.target.value}%`;
  });

  let searchTimer;
  $('#task-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = event.target.value.trim();
      loadTasks();
    }, 220);
  });
  $('#priority-filter').addEventListener('change', (event) => {
    state.filters.priority = event.target.value;
    loadTasks();
  });
  $('#status-filter').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-status]');
    if (!chip) return;
    $$('.filter-chip', $('#status-filter')).forEach((item) => item.classList.toggle('active', item === chip));
    state.filters.status = chip.dataset.status;
    loadTasks();
  });
  $('#database-type').addEventListener('change', toggleDatabaseFields);

  document.addEventListener('click', (event) => {
    const viewTarget = event.target.closest('[data-view-target]');
    if (viewTarget) switchView(viewTarget.dataset.viewTarget);

    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) $(`#${closeButton.dataset.closeDialog}`).close();

    const taskTarget = event.target.closest('[data-task-id]');
    if (taskTarget && !event.target.closest('button')) openTaskDetails(taskTarget.dataset.taskId);

    const stat = event.target.closest('[data-stat-status]');
    if (stat) {
      state.filters.status = stat.dataset.statStatus;
      $$('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.status === state.filters.status));
      switchView('tasks');
    }

    const detailAction = event.target.closest('[data-detail-action]')?.dataset.detailAction;
    if (detailAction === 'progress') openProgressForm(state.selectedTask);
    if (detailAction === 'complete') openProgressForm(state.selectedTask, true);
    if (detailAction === 'edit') {
      $('#detail-dialog').close();
      openTaskForm(state.selectedTask);
    }
    if (detailAction === 'delete') deleteSelectedTask();

    const exportButton = event.target.closest('[data-export]');
    if (exportButton) exportCurrentReport(exportButton.dataset.export);
  });

  $$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  }));
}

async function initialize() {
  const today = new Date();
  $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(today);
  $('#report-anchor').value = localDateInput(today);
  const hour = today.getHours();
  $('#hero-greeting').textContent = hour < 11 ? '早上好，把重要的事一件件做好。' : hour < 18 ? '下午好，保持节奏，继续向前。' : '辛苦了，整理今天，也准备明天。';
  bindEvents();
  showLoading('正在准备工作台...');
  try {
    const [meta, dashboard, tasks, settings] = await Promise.all([
      api.getMeta(), api.dashboard.get(), api.tasks.list(state.filters), api.settings.get(),
    ]);
    state.dashboard = dashboard;
    state.tasks = tasks;
    state.settings = settings;
    $('#app-version').textContent = `v${meta.version}`;
    $('#data-path-label').textContent = meta.dataPath;
    renderDashboard();
    renderTasks();
    renderSettings();
  } catch (error) {
    toast(`工作台初始化失败：${readableError(error)}`, 'error');
  } finally {
    hideLoading();
  }
}

initialize();
