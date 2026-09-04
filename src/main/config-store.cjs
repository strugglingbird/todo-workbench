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
    };
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
    };
    this.#persist();
    return this.getPublic();
  }
}

module.exports = { ConfigStore, DEFAULT_CONFIG };
