const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SQLiteAdapter, normalizeTaskInput } = require('../src/main/database.cjs');

test('normalizeTaskInput keeps task state and progress consistent', () => {
  assert.deepEqual(normalizeTaskInput({ status: 'todo', progress: 100 }), {
    status: 'done',
    progress: 100,
  });
  assert.equal(normalizeTaskInput({ status: 'done', progress: 20 }).progress, 100);
  assert.equal(normalizeTaskInput({ status: 'unexpected', progress: 30 }).status, 'todo');
});

test('SQLite adapter stores tasks and their complete progress timeline', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-workbench-'));
  const databasePath = path.join(directory, 'test.db');
  const database = new SQLiteAdapter(databasePath);
  await database.init();
  t.after(async () => {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const task = await database.createTask({
    title: '准备产品评审',
    description: '整理需求和原型',
    requester: '张经理',
    owner: '李同学',
    priority: 'high',
    progress: 0,
    due_date: '2026-09-08',
  });
  assert.equal(task.title, '准备产品评审');
  assert.equal(task.status, 'todo');

  const progressed = await database.addProgress(task.id, {
    progress: 60,
    completed_work: '完成需求梳理和第一版原型',
    requester: '张经理',
    next_steps: '约评审会议',
    contacts: '产品组、研发组',
    occurred_at: '2026-09-04T08:00:00.000Z',
  });
  assert.equal(progressed.progress, 60);
  assert.equal(progressed.status, 'doing');
  assert.equal(progressed.timeline.length, 1);
  assert.equal(progressed.timeline[0].contacts, '产品组、研发组');

  const completed = await database.addProgress(task.id, {
    progress: 100,
    completed_work: '评审通过',
    next_steps: '进入研发排期',
    contacts: '研发负责人',
    occurred_at: '2026-09-05T08:00:00.000Z',
  });
  assert.equal(completed.status, 'done');
  assert.ok(completed.completed_at);

  const dashboard = await database.getDashboard();
  assert.equal(dashboard.counts.total, 1);
  assert.equal(dashboard.counts.done, 1);
  assert.equal(dashboard.recent.length, 2);

  const reportTasks = await database.getReportData(
    '2026-09-01T00:00:00.000Z',
    '2026-09-08T00:00:00.000Z',
  );
  assert.equal(reportTasks.length, 1);
  assert.equal(reportTasks[0].timeline.length, 2);
});
