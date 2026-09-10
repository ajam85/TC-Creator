/* ═══════════════════════════════════════
   TC CREATOR — preload.js
   Bezpečný most mezi main a renderer
═══════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile:     ()                            => ipcRenderer.invoke('open-file'),
  saveFile:     (filePath, data)              => ipcRenderer.invoke('save-file', { filePath, data }),
  exportCsv:    (defaultName, content)        => ipcRenderer.invoke('export-csv', { defaultName, content }),
  exportJson:   (defaultName, data)           => ipcRenderer.invoke('export-json', { defaultName, data }),
  exportXlsx:   (defaultName, rows, headers, dropdownValues) => ipcRenderer.invoke('export-xlsx', { defaultName, rows, headers, dropdownValues }),
  loadLastFile: (filePath)                    => ipcRenderer.invoke('load-last-file', filePath),
  silentBackup: (filePath, data)              => ipcRenderer.invoke('silent-backup', { filePath, data })
});
