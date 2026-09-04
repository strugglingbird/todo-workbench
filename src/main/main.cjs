const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} = require('electron');
const { ConfigStore } = require('./config-store.cjs');
const { DatabaseManager } = require('./database.cjs');
const {
  getPeriodRange,
  buildReportMarkdown,
  buildReportFacts,
  mapFactsLocally,
  mapFactsWithAi,
  polishReport,
  testAi,
  markdownToHtml,
} = require('./reports.cjs');
const { writeExcelReport } = require('./excel-export.cjs');

let mainWindow;
let tray;
let configStore;
let databaseManager;
let isQuitting = false;
const smokeTest = process.argv.includes('--smoke-test');

function assertText(value, fieldName, maxLength = 10_000) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${fieldName}不能为空。`);
  if (text.length > maxLength) throw new Error(`${fieldName}内容过长。`);
  return text;
}

function assertId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('任务编号无效。');
  return id;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#f4f0e7',
    title: '待办工作台',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!smokeTest) mainWindow.show();
  });
  if (smokeTest) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`
          new Promise((resolve) => setTimeout(() => resolve({
            title: document.title,
            views: document.querySelectorAll('.view').length,
            bridgeReady: Boolean(window.workbench),
            loadingFinished: document.querySelector('#loading-overlay').hidden,
            excelTemplates: document.querySelectorAll('#excel-template-select option').length,
            excelExportReady: Boolean(document.querySelector('[data-export="excel"]'))
          }), 600))
        `);
        console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
        app.exit(result.views === 4 && result.bridgeReady && result.loadingFinished
          && result.excelTemplates >= 2 && result.excelExportReady ? 0 : 1);
      } catch (error) {
        console.error('SMOKE_ERROR', error);
        app.exit(1);
      }
    });
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && !smokeTest) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (smokeTest || tray) return;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', '..', 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('待办工作台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开待办工作台', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function loginItemSettings(openAtLogin) {
  if (app.isPackaged) return { openAtLogin };
  return { openAtLogin, path: process.execPath, args: [app.getAppPath()] };
}

async function exportReport({ markdown, title, format }) {
  const safeTitle = String(title || '工作汇报').replace(/[\\/:*?"<>|]/g, '-');
  const selectedFormat = ['md', 'html', 'pdf'].includes(format) ? format : 'md';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出工作汇报',
    defaultPath: `${safeTitle}.${selectedFormat}`,
    filters: selectedFormat === 'md'
      ? [{ name: 'Markdown 文档', extensions: ['md'] }]
      : selectedFormat === 'html'
        ? [{ name: 'HTML 文档', extensions: ['html'] }]
        : [{ name: 'PDF 文档', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  if (selectedFormat === 'md') {
    fs.writeFileSync(result.filePath, markdown, 'utf8');
  } else {
    const html = markdownToHtml(markdown, title);
    if (selectedFormat === 'html') {
      fs.writeFileSync(result.filePath, html, 'utf8');
    } else {
      const temporaryPath = path.join(app.getPath('temp'), `todo-report-${Date.now()}.html`);
      fs.writeFileSync(temporaryPath, html, 'utf8');
      const reportWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await reportWindow.loadFile(temporaryPath);
        const pdf = await reportWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        });
        fs.writeFileSync(result.filePath, pdf);
      } finally {
        reportWindow.destroy();
        fs.rmSync(temporaryPath, { force: true });
      }
    }
  }
  return { canceled: false, filePath: result.filePath };
}

async function exportExcelReport(input) {
  const excelConfig = configStore.getExcelConfig();
  const template = excelConfig.templates.find((item) => item.id === input?.templateId);
  if (!template) throw new Error('所选 Excel 模板不存在，请重新选择。');
  const period = getPeriodRange(input?.type, input?.anchorDate);
  const safeTitle = period.title.replace(/[\\/:*?"<>|]/g, '-');
  const safeTemplateName = template.name.replace(/[\\/:*?"<>|]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 Excel 工作汇报',
    defaultPath: `${safeTitle}-${safeTemplateName}.xlsx`,
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const outputPath = result.filePath.toLowerCase().endsWith('.xlsx')
    ? result.filePath
    : `${result.filePath}.xlsx`;

  const tasks = await databaseManager.invoke('getReportData', period.startIso, period.endIso);
  const facts = buildReportFacts(tasks, period);
  let rows = mapFactsLocally(facts, template.headers);
  let polished = false;
  if (input?.useAi && facts.length) {
    const aiConfig = configStore.getAiConfig();
    if (!aiConfig.enabled) throw new Error('请先在设置中启用大模型润色。');
    rows = await mapFactsWithAi(aiConfig, facts, template.headers);
    polished = true;
  }
  const workbookResult = await writeExcelReport({
    filePath: outputPath,
    title: period.title,
    period,
    templateName: template.name,
    headers: template.headers,
    rows,
    polished,
  });
  return {
    canceled: false,
    filePath: outputPath,
    polished,
    ...workbookResult,
  };
}

function registerIpc() {
  ipcMain.handle('app:get-meta', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataPath: app.getPath('userData'),
  }));

  ipcMain.handle('dashboard:get', () => databaseManager.invoke('getDashboard'));
  ipcMain.handle('tasks:list', (_event, filters) => databaseManager.invoke('listTasks', filters || {}));
  ipcMain.handle('tasks:get', (_event, id) => databaseManager.invoke('getTask', assertId(id)));
  ipcMain.handle('tasks:create', (_event, input) => {
    const payload = { ...input, title: assertText(input?.title, '任务标题', 255) };
    return databaseManager.invoke('createTask', payload);
  });
  ipcMain.handle('tasks:update', (_event, id, input) => {
    const payload = { ...input };
    if (Object.hasOwn(payload, 'title')) payload.title = assertText(payload.title, '任务标题', 255);
    return databaseManager.invoke('updateTask', assertId(id), payload);
  });
  ipcMain.handle('tasks:delete', (_event, id) => databaseManager.invoke('deleteTask', assertId(id)));
  ipcMain.handle('progress:create', (_event, taskId, input) => {
    const payload = {
      ...input,
      completed_work: assertText(input?.completed_work, '本次完成内容'),
    };
    return databaseManager.invoke('addProgress', assertId(taskId), payload);
  });

  ipcMain.handle('reports:generate', async (_event, input) => {
    const period = getPeriodRange(input?.type, input?.anchorDate);
    const tasks = await databaseManager.invoke('getReportData', period.startIso, period.endIso);
    const rawMarkdown = buildReportMarkdown(tasks, period);
    let markdown = rawMarkdown;
    let polished = false;
    if (input?.useAi) {
      const aiConfig = configStore.getAiConfig();
      if (!aiConfig.enabled) throw new Error('请先在设置中启用大模型润色。');
      markdown = await polishReport(aiConfig, rawMarkdown);
      polished = true;
    }
    return { period, markdown, rawMarkdown, polished, taskCount: tasks.length };
  });
  ipcMain.handle('reports:export', (_event, input) => exportReport(input || {}));
  ipcMain.handle('reports:export-excel', (_event, input) => exportExcelReport(input || {}));

  ipcMain.handle('settings:get', () => ({
    ...configStore.getPublic(),
    startup: app.getLoginItemSettings().openAtLogin,
  }));
  ipcMain.handle('settings:test-database', async (_event, input) => {
    const config = configStore.buildDatabaseConfig(input || {});
    return databaseManager.test(config);
  });
  ipcMain.handle('settings:test-ai', async (_event, input) => {
    const current = configStore.getAiConfig();
    return testAi({
      enabled: true,
      endpoint: input?.endpoint || current.endpoint,
      model: input?.model || current.model,
      apiKey: input?.apiKey || current.apiKey,
    });
  });
  ipcMain.handle('settings:save-excel', (_event, input) => configStore.saveExcelConfig(input || {}));
  ipcMain.handle('settings:save', async (_event, input) => {
    const databaseConfig = configStore.buildDatabaseConfig(input?.database || {});
    await databaseManager.test(databaseConfig);
    configStore.save(input || {});
    await databaseManager.reset();
    await databaseManager.getAdapter();
    const startup = Boolean(input?.startup);
    app.setLoginItemSettings(loginItemSettings(startup));
    return {
      ...configStore.getPublic(),
      startup: app.getLoginItemSettings().openAtLogin,
    };
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    configStore = new ConfigStore({ userDataPath: app.getPath('userData'), safeStorage });
    databaseManager = new DatabaseManager({ configStore, userDataPath: app.getPath('userData') });
    await databaseManager.getAdapter();
    registerIpc();
    createWindow();
    createTray();

    app.on('activate', () => {
      showMainWindow();
    });
  }).catch((error) => {
    dialog.showErrorBox('待办工作台启动失败', error.message);
    app.quit();
  });
}

app.on('before-quit', async () => {
  isQuitting = true;
  if (databaseManager) await databaseManager.reset();
});
