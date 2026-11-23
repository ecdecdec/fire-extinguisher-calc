// Сообщает странице, что она открыта в приложении для компьютера (js/platform.js: kind = 'desktop'),
// и даёт ей два действия: сохранить файл через окно «Сохранить как» и открыть только что сохранённый.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('firecalcDesktop', {
  platform: process.platform,
  saveFile: function (name, base64) { return ipcRenderer.invoke('firecalc:save-file', String(name), String(base64)); },
  openFile: function (filePath) { return ipcRenderer.invoke('firecalc:open-file', String(filePath)); }
});
