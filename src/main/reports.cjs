const STATUS_LABELS = {
  todo: '待开始',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
};

const PRIORITY_LABELS = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function localDateLabel(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getPeriodRange(type, anchorValue) {
  const anchor = startOfDay(anchorValue ? new Date(`${anchorValue}T12:00:00`) : new Date());
  let start;
  let end;
  let typeLabel;

  if (type === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    typeLabel = '月报';
  } else if (type === 'quarter') {
    const quarterMonth = Math.floor(anchor.getMonth() / 3) * 3;
    start = new Date(anchor.getFullYear(), quarterMonth, 1);
    end = new Date(anchor.getFullYear(), quarterMonth + 3, 1);
    typeLabel = '季报';
  } else if (type === 'year') {
    start = new Date(anchor.getFullYear(), 0, 1);
    end = new Date(anchor.getFullYear() + 1, 0, 1);
    typeLabel = '年报';
  } else {
    const day = anchor.getDay() || 7;
    start = addDays(anchor, 1 - day);
    end = addDays(start, 7);
    typeLabel = '周报';
  }

  return {
    type: type || 'week',
    typeLabel,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startLabel: localDateLabel(start),
    endLabel: localDateLabel(addDays(end, -1)),
    title: `${localDateLabel(start)} 至 ${localDateLabel(addDays(end, -1))} ${typeLabel}`,
  };
}

function compactText(value, fallback = '无') {
  const text = String(value || '').trim();
  return text || fallback;
}

function buildReportMarkdown(tasks, period) {
  const entries = tasks.flatMap((task) => task.timeline || []);
  const completedTasks = tasks.filter((task) => task.status === 'done');
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const touchedTasks = tasks.filter((task) => (task.timeline || []).length > 0);
  const averageProgress = tasks.length
    ? Math.round(tasks.reduce((total, task) => total + Number(task.progress || 0), 0) / tasks.length)
    : 0;

  const lines = [
    `# ${period.title}`,
    '',
    `> 统计周期：${period.startLabel} - ${period.endLabel}`,
    '',
    '## 工作概览',
    '',
    `- 涉及任务：${tasks.length} 项`,
    `- 本期有进展：${touchedTasks.length} 项`,
    `- 已完成：${completedTasks.length} 项`,
    `- 受阻：${blockedTasks.length} 项`,
    `- 进度填报：${entries.length} 条`,
    `- 当前平均进度：${averageProgress}%`,
    '',
  ];

  if (!tasks.length) {
    lines.push('## 本期记录', '', '本统计周期暂无任务或进度记录。', '');
    return lines.join('\n');
  }

  lines.push('## 任务进展', '');
  for (const task of tasks) {
    lines.push(`### ${task.title}`);
    lines.push('');
    lines.push(`- 状态：${STATUS_LABELS[task.status] || task.status} · 进度 ${task.progress}% · 优先级 ${PRIORITY_LABELS[task.priority] || task.priority}`);
    lines.push(`- 需求人：${compactText(task.requester)} · 负责人：${compactText(task.owner)}`);
    lines.push(`- 协作人：${compactText(task.collaborators)}`);
    if (task.description) lines.push(`- 任务说明：${compactText(task.description)}`);
    lines.push('');
    if (!task.timeline?.length) {
      lines.push('本期无新增进度填报。', '');
      continue;
    }
    for (const entry of task.timeline) {
      lines.push(`#### ${localDateLabel(new Date(entry.occurred_at))} · 进度 ${entry.progress}%`);
      lines.push('');
      lines.push(`- 已完成：${compactText(entry.completed_work)}`);
      lines.push(`- 需求人：${compactText(entry.requester || task.requester)}`);
      lines.push(`- 下一步：${compactText(entry.next_steps)}`);
      lines.push(`- 待对接：${compactText(entry.contacts)}`);
      lines.push('');
    }
  }

  if (blockedTasks.length) {
    lines.push('## 风险与阻塞', '');
    for (const task of blockedTasks) {
      const latest = task.timeline?.at(-1);
      lines.push(`- **${task.title}**：${latest?.next_steps || task.description || '需进一步确认阻塞原因与解决方案。'}`);
    }
    lines.push('');
  }

  const followUps = entries.filter((entry) => entry.next_steps || entry.contacts);
  lines.push('## 下阶段跟进', '');
  if (!followUps.length) {
    lines.push('暂无明确待跟进事项。', '');
  } else {
    for (const entry of followUps) {
      const task = tasks.find((candidate) => candidate.id === entry.task_id);
      lines.push(`- **${task?.title || '任务'}**：${compactText(entry.next_steps)}；对接：${compactText(entry.contacts)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function ensureHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('模型 API 地址格式不正确。');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型 API 仅支持 HTTP 或 HTTPS 地址。');
  return url.toString();
}

function extractAiText(payload) {
  const chatContent = payload?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') return chatContent;
  if (Array.isArray(chatContent)) {
    return chatContent.map((item) => item.text || item.content || '').join('\n').trim();
  }
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output.flatMap((item) => item.content || [])
      .map((item) => item.text || '').join('\n').trim();
  }
  throw new Error('模型返回成功，但没有找到可用的文本内容。');
}

async function callAi(aiConfig, prompt) {
  const endpoint = ensureHttpUrl(aiConfig.endpoint);
  const isResponsesApi = /\/responses\/?(?:\?.*)?$/.test(endpoint);
  const body = isResponsesApi
    ? { model: aiConfig.model, input: prompt }
    : {
        model: aiConfig.model,
        messages: [
          { role: 'system', content: '你是一位严谨的中文办公助理，擅长把事实记录整理成简洁、专业、可执行的工作汇报。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      };
  const headers = { 'Content-Type': 'application/json' };
  if (aiConfig.apiKey) headers.Authorization = `Bearer ${aiConfig.apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('模型请求超时，请检查网络或 API 配置。');
    throw new Error(`模型请求失败：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `模型 API 返回 ${response.status}`);
  }
  return extractAiText(payload);
}

async function polishReport(aiConfig, markdown) {
  const prompt = [
    '请润色以下工作汇报，输出 Markdown。',
    '要求：不虚构信息；保留日期、人员、进度和任务事实；突出成果、风险、下一步；语言专业简洁；不要添加开场白。',
    '',
    markdown,
  ].join('\n');
  return callAi(aiConfig, prompt);
}

async function testAi(aiConfig) {
  const text = await callAi(aiConfig, '请只回复“连接成功”。');
  return { ok: true, message: text.slice(0, 100) };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function markdownToHtml(markdown, title) {
  const body = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) body.push('</ul>');
    listOpen = false;
  };
  for (const line of String(markdown).split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      if (!listOpen) body.push('<ul>');
      listOpen = true;
      body.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith('#### ')) body.push(`<h4>${inlineMarkdown(line.slice(5))}</h4>`);
    else if (line.startsWith('### ')) body.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) body.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) body.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
    else if (line.startsWith('> ')) body.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
    else if (line.trim()) body.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
  @page { margin: 18mm; }
  body { max-width: 850px; margin: 40px auto; padding: 0 28px; color: #172b2a; font: 15px/1.75 "Microsoft YaHei UI", sans-serif; }
  h1 { color: #103d3a; font-size: 28px; border-bottom: 3px solid #e96d4c; padding-bottom: 12px; }
  h2 { margin-top: 30px; color: #103d3a; font-size: 20px; }
  h3 { margin-top: 24px; color: #315b57; font-size: 17px; }
  h4 { margin: 18px 0 4px; color: #496d69; }
  blockquote { margin: 16px 0; padding: 10px 16px; background: #f3f0e8; border-left: 4px solid #d5a443; }
  li { margin: 6px 0; } code { background: #eeeae1; padding: 2px 5px; border-radius: 4px; }
</style></head><body>${body.join('\n')}</body></html>`;
}

module.exports = {
  getPeriodRange,
  buildReportMarkdown,
  polishReport,
  testAi,
  markdownToHtml,
};
