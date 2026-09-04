const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getPeriodRange,
  buildReportMarkdown,
  buildReportFacts,
  mapFactsLocally,
  markdownToHtml,
} = require('../src/main/reports.cjs');

test('weekly period starts on Monday and ends on Sunday', () => {
  const period = getPeriodRange('week', '2026-09-04');
  assert.match(period.title, /2026\/08\/31/);
  assert.match(period.title, /2026\/09\/06/);
  assert.equal(period.typeLabel, '周报');
});

test('custom headers map to structured task facts without AI', () => {
  const period = getPeriodRange('week', '2026-09-04');
  const facts = buildReportFacts([{
    id: 9,
    title: '准备项目周会',
    status: 'doing',
    priority: 'high',
    progress: 50,
    requester: '项目经理',
    owner: '小李',
    collaborators: '研发组',
    timeline: [{
      progress: 60,
      completed_work: '完成议题收集',
      next_steps: '整理会议材料',
      contacts: '产品负责人',
      occurred_at: '2026-09-04T08:00:00.000Z',
    }],
  }], period);
  const [row] = mapFactsLocally(facts, ['工作事项', '本周成果', '后续计划', '需沟通人员', '当前进度']);
  assert.equal(row.工作事项, '准备项目周会');
  assert.equal(row.本周成果, '完成议题收集');
  assert.equal(row.后续计划, '整理会议材料');
  assert.equal(row.需沟通人员, '产品负责人');
  assert.equal(row.当前进度, 60);
});

test('report contains task facts, follow-ups and escaped HTML', () => {
  const period = getPeriodRange('month', '2026-09-04');
  const markdown = buildReportMarkdown([{
    id: 1,
    title: '上线 <新功能>',
    description: '完成发布',
    requester: '业务部门',
    owner: '项目组',
    collaborators: '运维',
    status: 'doing',
    priority: 'high',
    progress: 75,
    timeline: [{
      task_id: 1,
      progress: 75,
      completed_work: '完成预发布验证',
      requester: '业务部门',
      next_steps: '安排正式发布',
      contacts: '运维',
      occurred_at: '2026-09-04T08:00:00.000Z',
    }],
  }], period);
  assert.match(markdown, /完成预发布验证/);
  assert.match(markdown, /安排正式发布/);
  const html = markdownToHtml(markdown, period.title);
  assert.match(html, /&lt;新功能&gt;/);
  assert.doesNotMatch(html, /<新功能>/);
});
