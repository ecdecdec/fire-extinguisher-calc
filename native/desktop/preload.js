// Сообщает странице, что она открыта в приложении для компьютера (js/platform.js: kind = 'desktop').
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('firecalcDesktop', {
  platform: process.platform
});
