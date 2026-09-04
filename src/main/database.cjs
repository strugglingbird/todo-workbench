const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TASK_FIELDS = [
  'title',
  'description',
  'requester',
  'owner',
  'collaborators',
  'status',
  'priority',
  'progress',
  'start_date',
  'due_date',
];

function nowIso() {
  return new Date().toISOString();
}

function clampProgress(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function normalizeTaskInput(input, existing = {}) {
  const progress = clampProgress(input.progress ?? existing.progress ?? 0);
  let status = input.status || existing.status || 'todo';
  if (progress >= 100) status = 'done';
  if (status === 'done') return { ...input, progress: 100, status };
  if (!['todo', 'doing', 'blocked'].includes(status)) status = 'todo';
  return { ...input, progress, status };
}

function taskWhere(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.status && filters.status !== 'all') {
    clauses.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.priority && filters.priority !== 'all') {
    clauses.push('t.priority = ?');
    params.push(filters.priority);
  }
  if (filters.search) {
    clauses.push('(t.title LIKE ? OR t.description LIKE ? OR t.requester LIKE ? OR t.owner LIKE ?)');
    const search = `%${filters.search}%`;
    params.push(search, search, search, search);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

class SQLiteAdapter {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath);
  }

  async init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        requester TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        collaborators TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        progress INTEGER NOT NULL DEFAULT 0,
        start_date TEXT,
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS progress_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        completed_work TEXT NOT NULL,
        requester TEXT NOT NULL DEFAULT '',
        next_steps TEXT NOT NULL DEFAULT '',
        contacts TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_progress_task_time ON progress_entries(task_id, occurred_at);
    `);
  }

  async close() {
    this.db.close();
  }

  async listTasks(filters = {}) {
    const where = taskWhere(filters);
    return this.db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM progress_entries p WHERE p.task_id = t.id) AS timeline_count
      FROM tasks t
      ${where.sql}
      ORDER BY
        CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        COALESCE(t.due_date, '9999-12-31') ASC,
        t.updated_at DESC
    `).all(...where.params);
  }

  async getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
    if (!task) return null;
    task.timeline = this.db.prepare(`
      SELECT * FROM progress_entries WHERE task_id = ?
      ORDER BY occurred_at DESC, id DESC
    `).all(Number(id));
    return task;
  }

  async createTask(input) {
    const task = normalizeTaskInput(input);
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO tasks (
        title, description, requester, owner, collaborators, status, priority,
        progress, start_date, due_date, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(task.title || '').trim(),
      String(task.description || '').trim(),
      String(task.requester || '').trim(),
      String(task.owner || '').trim(),
      String(task.collaborators || '').trim(),
      task.status,
      task.priority || 'medium',
      task.progress,
      task.start_date || null,
      task.due_date || null,
      timestamp,
      timestamp,
      task.status === 'done' ? timestamp : null,
    );
    return this.getTask(Number(result.lastInsertRowid));
  }

  async updateTask(id, input) {
    const current = await this.getTask(id);
    if (!current) throw new Error('任务不存在或已被删除。');
    const task = normalizeTaskInput(input, current);
    const updates = [];
    const params = [];
    for (const field of TASK_FIELDS) {
      if (Object.hasOwn(task, field)) {
        updates.push(`${field} = ?`);
        params.push(field === 'progress' ? clampProgress(task[field]) : task[field] || (['start_date', 'due_date'].includes(field) ? null : ''));
      }
    }
    updates.push('updated_at = ?');
    params.push(nowIso());
    if (task.status === 'done' && !current.completed_at) {
      updates.push('completed_at = ?');
      params.push(nowIso());
    } else if (task.status !== 'done' && current.completed_at) {
      updates.push('completed_at = NULL');
    }
    params.push(Number(id));
    this.db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getTask(id);
  }

  async deleteTask(id) {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id));
    return { deleted: result.changes > 0 };
  }

  async addProgress(taskId, input) {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('任务不存在或已被删除。');
    const progress = clampProgress(input.progress);
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO progress_entries (
          task_id, progress, completed_work, requester, next_steps, contacts,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(taskId),
        progress,
        String(input.completed_work || '').trim(),
        String(input.requester || task.requester || '').trim(),
        String(input.next_steps || '').trim(),
        String(input.contacts || '').trim(),
        input.occurred_at || timestamp,
        timestamp,
      );
      const status = progress >= 100 ? 'done' : progress > 0 ? 'doing' : task.status;
      this.db.prepare(`
        UPDATE tasks SET progress = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(progress, status, timestamp, status === 'done' ? timestamp : null, Number(taskId));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getTask(taskId);
  }

  async getDashboard() {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        ROUND(AVG(progress)) AS average_progress
      FROM tasks
    `).get();
    const recent = this.db.prepare(`
      SELECT p.*, t.title AS task_title
      FROM progress_entries p JOIN tasks t ON t.id = p.task_id
      ORDER BY p.occurred_at DESC, p.id DESC LIMIT 6
    `).all();
    const upcoming = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status != 'done' AND due_date IS NOT NULL
      ORDER BY due_date ASC LIMIT 6
    `).all();
    return { counts, recent, upcoming };
  }

  async getReportData(startIso, endIso) {
    const tasks = this.db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      LEFT JOIN progress_entries p ON p.task_id = t.id
      WHERE (p.occurred_at >= ? AND p.occurred_at < ?)
        OR (t.created_at >= ? AND t.created_at < ?)
        OR (t.completed_at >= ? AND t.completed_at < ?)
      ORDER BY t.updated_at DESC
    `).all(startIso, endIso, startIso, endIso, startIso, endIso);
    const progressStatement = this.db.prepare(`
      SELECT * FROM progress_entries
      WHERE task_id = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at ASC, id ASC
    `);
    return tasks.map((task) => ({
      ...task,
      timeline: progressStatement.all(task.id, startIso, endIso),
    }));
  }
}

class MySQLAdapter {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async init() {
    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({
      host: this.config.host,
      port: Number(this.config.port || 3306),
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      charset: 'utf8mb4',
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 5,
    });
    const connection = await this.pool.getConnection();
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT NOT NULL,
          requester VARCHAR(120) NOT NULL DEFAULT '',
          owner VARCHAR(120) NOT NULL DEFAULT '',
          collaborators VARCHAR(500) NOT NULL DEFAULT '',
          status VARCHAR(20) NOT NULL DEFAULT 'todo',
          priority VARCHAR(20) NOT NULL DEFAULT 'medium',
          progress INT NOT NULL DEFAULT 0,
          start_date VARCHAR(32) NULL,
          due_date VARCHAR(32) NULL,
          created_at VARCHAR(32) NOT NULL,
          updated_at VARCHAR(32) NOT NULL,
          completed_at VARCHAR(32) NULL,
          INDEX idx_tasks_status (status),
          INDEX idx_tasks_due_date (due_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS progress_entries (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          task_id BIGINT UNSIGNED NOT NULL,
          progress INT NOT NULL,
          completed_work TEXT NOT NULL,
          requester VARCHAR(120) NOT NULL DEFAULT '',
          next_steps TEXT NOT NULL,
          contacts VARCHAR(500) NOT NULL DEFAULT '',
          occurred_at VARCHAR(32) NOT NULL,
          created_at VARCHAR(32) NOT NULL,
          INDEX idx_progress_task_time (task_id, occurred_at),
          CONSTRAINT fk_progress_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    } finally {
      connection.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }

  async listTasks(filters = {}) {
    const where = taskWhere(filters);
    const [rows] = await this.pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM progress_entries p WHERE p.task_id = t.id) AS timeline_count
      FROM tasks t ${where.sql}
      ORDER BY
        FIELD(t.status, 'doing', 'blocked', 'todo', 'done'),
        FIELD(t.priority, 'urgent', 'high', 'medium', 'low'),
        COALESCE(t.due_date, '9999-12-31') ASC,
        t.updated_at DESC
    `, where.params);
    return rows;
  }

  async getTask(id) {
    const [tasks] = await this.pool.query('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
    if (!tasks[0]) return null;
    const [timeline] = await this.pool.query(`
      SELECT * FROM progress_entries WHERE task_id = ? ORDER BY occurred_at DESC, id DESC
    `, [Number(id)]);
    return { ...tasks[0], timeline };
  }

  async createTask(input) {
    const task = normalizeTaskInput(input);
    const timestamp = nowIso();
    const [result] = await this.pool.query(`
      INSERT INTO tasks (
        title, description, requester, owner, collaborators, status, priority,
        progress, start_date, due_date, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      String(task.title || '').trim(), String(task.description || '').trim(),
      String(task.requester || '').trim(), String(task.owner || '').trim(),
      String(task.collaborators || '').trim(), task.status, task.priority || 'medium',
      task.progress, task.start_date || null, task.due_date || null, timestamp,
      timestamp, task.status === 'done' ? timestamp : null,
    ]);
    return this.getTask(result.insertId);
  }

  async updateTask(id, input) {
    const current = await this.getTask(id);
    if (!current) throw new Error('任务不存在或已被删除。');
    const task = normalizeTaskInput(input, current);
    const updates = [];
    const params = [];
    for (const field of TASK_FIELDS) {
      if (Object.hasOwn(task, field)) {
        updates.push(`${field} = ?`);
        params.push(field === 'progress' ? clampProgress(task[field]) : task[field] || (['start_date', 'due_date'].includes(field) ? null : ''));
      }
    }
    updates.push('updated_at = ?');
    params.push(nowIso());
    if (task.status === 'done' && !current.completed_at) {
      updates.push('completed_at = ?');
      params.push(nowIso());
    } else if (task.status !== 'done' && current.completed_at) {
      updates.push('completed_at = NULL');
    }
    params.push(Number(id));
    await this.pool.query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, params);
    return this.getTask(id);
  }

  async deleteTask(id) {
    const [result] = await this.pool.query('DELETE FROM tasks WHERE id = ?', [Number(id)]);
    return { deleted: result.affectedRows > 0 };
  }

  async addProgress(taskId, input) {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('任务不存在或已被删除。');
    const progress = clampProgress(input.progress);
    const timestamp = nowIso();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`
        INSERT INTO progress_entries (
          task_id, progress, completed_work, requester, next_steps, contacts,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        Number(taskId), progress, String(input.completed_work || '').trim(),
        String(input.requester || task.requester || '').trim(),
        String(input.next_steps || '').trim(), String(input.contacts || '').trim(),
        input.occurred_at || timestamp, timestamp,
      ]);
      const status = progress >= 100 ? 'done' : progress > 0 ? 'doing' : task.status;
      await connection.query(`
        UPDATE tasks SET progress = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `, [progress, status, timestamp, status === 'done' ? timestamp : null, Number(taskId)]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getTask(taskId);
  }

  async getDashboard() {
    const [[counts]] = await this.pool.query(`
      SELECT COUNT(*) AS total,
        SUM(status = 'todo') AS todo,
        SUM(status = 'doing') AS doing,
        SUM(status = 'blocked') AS blocked,
        SUM(status = 'done') AS done,
        ROUND(AVG(progress)) AS average_progress
      FROM tasks
    `);
    const [recent] = await this.pool.query(`
      SELECT p.*, t.title AS task_title FROM progress_entries p
      JOIN tasks t ON t.id = p.task_id
      ORDER BY p.occurred_at DESC, p.id DESC LIMIT 6
    `);
    const [upcoming] = await this.pool.query(`
      SELECT * FROM tasks WHERE status != 'done' AND due_date IS NOT NULL
      ORDER BY due_date ASC LIMIT 6
    `);
    return { counts, recent, upcoming };
  }

  async getReportData(startIso, endIso) {
    const [tasks] = await this.pool.query(`
      SELECT DISTINCT t.* FROM tasks t
      LEFT JOIN progress_entries p ON p.task_id = t.id
      WHERE (p.occurred_at >= ? AND p.occurred_at < ?)
        OR (t.created_at >= ? AND t.created_at < ?)
        OR (t.completed_at >= ? AND t.completed_at < ?)
      ORDER BY t.updated_at DESC
    `, [startIso, endIso, startIso, endIso, startIso, endIso]);
    for (const task of tasks) {
      const [timeline] = await this.pool.query(`
        SELECT * FROM progress_entries
        WHERE task_id = ? AND occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at ASC, id ASC
      `, [task.id, startIso, endIso]);
      task.timeline = timeline;
    }
    return tasks;
  }
}

class DatabaseManager {
  constructor({ configStore, userDataPath }) {
    this.configStore = configStore;
    this.userDataPath = userDataPath;
    this.adapter = null;
  }

  resolveConfig(config = this.configStore.getDatabaseConfig()) {
    return {
      ...config,
      sqlitePath: config.sqlitePath || path.join(this.userDataPath, 'todo-workbench.db'),
    };
  }

  async createAdapter(config) {
    const resolved = this.resolveConfig(config);
    const adapter = resolved.type === 'mysql'
      ? new MySQLAdapter(resolved.mysql)
      : new SQLiteAdapter(resolved.sqlitePath);
    await adapter.init();
    return adapter;
  }

  async getAdapter() {
    if (!this.adapter) this.adapter = await this.createAdapter(this.configStore.getDatabaseConfig());
    return this.adapter;
  }

  async reset() {
    if (this.adapter) await this.adapter.close();
    this.adapter = null;
  }

  async test(config) {
    const adapter = await this.createAdapter(config);
    await adapter.close();
    return { ok: true };
  }

  async invoke(method, ...args) {
    const adapter = await this.getAdapter();
    return adapter[method](...args);
  }
}

module.exports = {
  DatabaseManager,
  SQLiteAdapter,
  MySQLAdapter,
  normalizeTaskInput,
  clampProgress,
};
