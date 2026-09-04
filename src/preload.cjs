const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbench', {
  getMeta: () => ipcRenderer.invoke('app:get-meta'),
  dashboard: {
    get: () => ipcRenderer.invoke('dashboard:get'),
  },
  tasks: {
    list: (filters) => ipcRenderer.invoke('tasks:list', filters),
    get: (id) => ipcRenderer.invoke('tasks:get', id),
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    update: (id, input) => ipcRenderer.invoke('tasks:update', id, input),
    delete: (id) => ipcRenderer.invoke('tasks:delete', id),
    addProgress: (id, input) => ipcRenderer.invoke('progress:create', id, input),
  },
  reports: {
    generate: (input) => ipcRenderer.invoke('reports:generate', input),
    export: (input) => ipcRenderer.invoke('reports:export', input),
    exportExcel: (input) => ipcRenderer.invoke('reports:export-excel', input),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    testDatabase: (input) => ipcRenderer.invoke('settings:test-database', input),
    testAi: (input) => ipcRenderer.invoke('settings:test-ai', input),
    saveExcel: (input) => ipcRenderer.invoke('settings:save-excel', input),
    save: (input) => ipcRenderer.invoke('settings:save', input),
  },
});
