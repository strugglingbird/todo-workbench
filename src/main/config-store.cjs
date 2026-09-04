const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  database: {
    type: 'sqlite',
    sqlitePath: '',
    mysql: {
      host: '127.0.0.1',
      port: 3306,
      database: 'todo_workbench',
      user: 'root',
      passwordEncrypted: '',
    },
  },
  ai: {
    enabled: false,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4.1-mini',
    apiKeyEncrypted: '',
  },
  excel: {
    activeTemplateId: 'standard',
    templates: [
      {
        id: 'standard',
        name: '标准工作汇报',
        headers: ['任务名称', '状态', '完成进度', '优先级', '需求人', '负责人', '本期完成内容', '下一步跟进', '待对接人员', '记录时间', '截止日期'],
      },
      {
        id: 'follow-up',
        name: '任务跟进清单',
        headers: ['任务名称', '需求人', '当前进度', '下一步待办', '对接人', '计划完成时间', '风险与阻塞'],
      },
    ],
  },
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

class ConfigStore {
  constructor({ userDataPath, safeStorage }) {
    this.filePath = path.join(userDataPath, 'config.json');
    this.safeStorage = safeStorage;
    this.config = this.#load();
  }

  #load() {
    const defaults = cloneDefaults();
    if (!fs.existsSync(this.filePath)) return defaults;

    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        ...defaults,
        ...saved,
        database: {
          ...defaults.database,
          ...saved.database,
          mysql: { ...defaults.database.mysql, ...saved.database?.mysql },
        },
        ai: { ...defaults.ai, ...saved.ai },
        excel: normalizeExcelConfig(saved.excel || defaults.excel),
      };
    } catch (error) {
      console.error('Unable to read config.json, using defaults.', error);
      return defaults;
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  #encrypt(value) {
    if (!value) return '';
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法提供安全凭据存储，密码和 API Key 未保存。');
    }
    return this.safeStorage.encryptString(value).toString('base64');
  }

  #decrypt(value) {
    if (!value) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch (error) {
      console.error('Unable to decrypt a stored credential.', error);
      return '';
    }
  }

  getPublic() {
    return {
      database: {
        type: this.config.database.type,
        sqlitePath: this.config.database.sqlitePath,
        mysql: {
          host: this.config.database.mysql.host,
          port: this.config.database.mysql.port,
          database: this.config.database.mysql.database,
          user: this.config.database.mysql.user,
          hasPassword: Boolean(this.config.database.mysql.passwordEncrypted),
        },
      },
      ai: {
        enabled: this.config.ai.enabled,
        endpoint: this.config.ai.endpoint,
        model: this.config.ai.model,
        hasApiKey: Boolean(this.config.ai.apiKeyEncrypted),
      },
      excel: this.getExcelConfig(),
    };
  }

  getExcelConfig() {
    return JSON.parse(JSON.stringify(normalizeExcelConfig(this.config.excel)));
  }

  getDatabaseConfig() {
    return {
      ...this.config.database,
      mysql: {
        ...this.config.database.mysql,
        password: this.#decrypt(this.config.database.mysql.passwordEncrypted),
      },
    };
  }

  getAiConfig() {
    return {
      ...this.config.ai,
      apiKey: this.#decrypt(this.config.ai.apiKeyEncrypted),
    };
  }

  buildDatabaseConfig(input) {
    const current = this.getDatabaseConfig();
    return {
      type: input.type === 'mysql' ? 'mysql' : 'sqlite',
      sqlitePath: String(input.sqlitePath || '').trim(),
      mysql: {
        host: String(input.mysql?.host || current.mysql.host).trim(),
        port: Number(input.mysql?.port || current.mysql.port || 3306),
        database: String(input.mysql?.database || current.mysql.database).trim(),
        user: String(input.mysql?.user || current.mysql.user).trim(),
        password: input.mysql?.password || current.mysql.password,
      },
    };
  }

  save(input) {
    const database = this.buildDatabaseConfig(input.database || {});
    const currentAi = this.getAiConfig();
    const aiInput = input.ai || {};
    const mysqlPasswordEncrypted = input.database?.mysql?.clearPassword
      ? ''
      : input.database?.mysql?.password
        ? this.#encrypt(input.database.mysql.password)
        : this.config.database.mysql.passwordEncrypted;
    const apiKeyEncrypted = aiInput.clearApiKey
      ? ''
      : aiInput.apiKey
        ? this.#encrypt(aiInput.apiKey)
        : this.config.ai.apiKeyEncrypted;

    this.config = {
      database: {
        type: database.type,
        sqlitePath: database.sqlitePath,
        mysql: {
          host: database.mysql.host,
          port: database.mysql.port,
          database: database.mysql.database,
          user: database.mysql.user,
          passwordEncrypted: mysqlPasswordEncrypted,
        },
      },
      ai: {
        enabled: Boolean(aiInput.enabled),
        endpoint: String(aiInput.endpoint || currentAi.endpoint).trim(),
        model: String(aiInput.model || currentAi.model).trim(),
        apiKeyEncrypted,
      },
      excel: input.excel
        ? normalizeExcelConfig(input.excel)
        : normalizeExcelConfig(this.config.excel),
    };
    this.#persist();
    return this.getPublic();
  }

  saveExcelConfig(input) {
    this.config.excel = normalizeExcelConfig(input);
    this.#persist();
    return this.getExcelConfig();
  }
}

function normalizeExcelConfig(input = {}) {
  const fallback = cloneDefaults().excel;
  const seenIds = new Set();
  const templates = (Array.isArray(input.templates) ? input.templates : fallback.templates)
    .slice(0, 30)
    .map((template, index) => {
      const rawId = String(template?.id || `custom-${Date.now()}-${index}`);
      let id = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `template-${index + 1}`;
      while (seenIds.has(id)) id = `${id}-${index + 1}`;
      seenIds.add(id);
      const headers = [...new Set((Array.isArray(template?.headers) ? template.headers : [])
        .map((header) => String(header || '').trim().slice(0, 60))
        .filter(Boolean))]
        .slice(0, 30);
      if (!headers.length) return null;
      return {
        id,
        name: String(template?.name || `自定义模板 ${index + 1}`).trim().slice(0, 80),
        headers,
      };
    })
    .filter(Boolean);
  const safeTemplates = templates.length ? templates : fallback.templates;
  const activeTemplateId = safeTemplates.some((template) => template.id === input.activeTemplateId)
    ? input.activeTemplateId
    : safeTemplates[0].id;
  return { activeTemplateId, templates: safeTemplates };
}

module.exports = { ConfigStore, DEFAULT_CONFIG, normalizeExcelConfig };
