// Приложение «Огнетушители» для Windows (Electron).
//
// Внутри — те же файлы, что у сайта (папка www, её собирает tools/native.js). Они отдаются
// по адресу app://firecalc/… прямо из приложения: сеть не нужна и не используется (запросы
// в сеть отклоняются), объекты и картинки планов хранятся на этом компьютере (папка данных
// Windows для приложения «Огнетушители», у переносной версии — папка рядом с EXE).
// PDF сохраняется через окно «Сохранить как».
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, 'www');
const ORIGIN = 'app://firecalc/';
const DEV = !app.isPackaged; // запуск из исходников: есть инструменты разработчика и перезагрузка

// Переносная версия (…-portable.exe) хранит данные рядом с собой: с флешкой переезжают и объекты,
// а на компьютере, где её запускали, служебные данные не остаются. Задаётся до запуска.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try { app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Огнетушители-данные')); } catch (e) { /* остаётся папка по умолчанию */ }
}

// Свой адрес вместо file://: у приложения постоянное хранилище, работают фоновый поток
// распознавания плана и загрузка шрифтов.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

app.setAppUserModelId('kz.firecalc.app');

let win = null;
const saved = new Set(); // открыть можно только файл, сохранённый в этом сеансе

function serveFiles() {
  protocol.handle('app', function (request) {
    let url, rel;
    try {
      url = new URL(request.url);
      rel = decodeURIComponent(url.pathname);
    } catch (e) {
      return new Response('Не найдено', { status: 404 });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(WEB, rel));
    // только файлы приложения, без выхода за папку www
    if (url.host !== 'firecalc' || !file.startsWith(WEB + path.sep)) return new Response('Не найдено', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function menu() {
  // строка меню скрыта (Alt показывает её), сочетания клавиш работают: масштаб, во весь экран
  const file = (DEV ? [{ role: 'reload', label: 'Обновить' }, { type: 'separator' }] : []).concat([{ role: 'quit', label: 'Выход' }]);
  const view = [{ role: 'zoomIn', label: 'Крупнее' }, { role: 'zoomOut', label: 'Мельче' }, { role: 'resetZoom', label: 'Обычный размер' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Во весь экран' }]
    .concat(DEV ? [{ role: 'toggleDevTools', label: 'Инструменты разработчика' }] : []);
  return Menu.buildFromTemplate([
    { label: 'Файл', submenu: file },
    { label: 'Правка', submenu: [{ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    { label: 'Вид', submenu: view }
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 900, minWidth: 360, minHeight: 520,
    title: 'Огнетушители', backgroundColor: '#ffffff', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, devTools: DEV
    }
  });
  win.once('ready-to-show', function () { win.show(); });
  // внешние ссылки — в браузере по умолчанию, внутри окна только само приложение
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (event, url) {
    if (url.startsWith(ORIGIN)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.loadURL(ORIGIN + 'index.html');
}

// Сохранение файла (PDF) через окно «Сохранить как». Ответ странице: { saved, path }.
function handleFiles() {
  const fromApp = function (event) { return !event.senderFrame || String(event.senderFrame.url).startsWith(ORIGIN); };
  ipcMain.handle('firecalc:save-file', async function (event, name, base64) {
    if (!fromApp(event) || typeof base64 !== 'string' || base64.length > 80 * 1024 * 1024) return { saved: false };
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150) || 'file';
    const pdf = /\.pdf$/i.test(safe);
    const r = await dialog.showSaveDialog(win, {
      title: 'Сохранить файл',
      defaultPath: path.join(app.getPath('documents'), safe),
      filters: pdf ? [{ name: 'Документ PDF', extensions: ['pdf'] }] : []
    });
    if (r.canceled || !r.filePath) return { saved: false };
    await fs.promises.writeFile(r.filePath, Buffer.from(base64, 'base64'));
    saved.add(r.filePath);
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('firecalc:open-file', async function (event, filePath) {
    if (!fromApp(event) || !saved.has(filePath)) return false;
    return (await shell.openPath(filePath)) === '';
  });
}

function start() {
  app.whenReady().then(function () {
    serveFiles();
    handleFiles();
    Menu.setApplicationMenu(menu());
    // приложению сеть не нужна: любые запросы в сеть отклоняются
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, function (details, callback) {
      callback({ cancel: true });
    });
    // скачивание (если страница всё же скачивает файл): окно «Сохранить как», по умолчанию — в «Документы»
    session.defaultSession.on('will-download', function (event, item) {
      item.setSaveDialogOptions({ title: 'Сохранить файл', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
    });
    // разрешения сайта (камера, уведомления и т. п.) приложению не нужны
    session.defaultSession.setPermissionRequestHandler(function (wc, permission, callback) {
      callback(permission === 'clipboard-sanitized-write' || permission === 'persistent-storage');
    });
    createWindow();
  });

  app.on('second-instance', function () {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

// второй запуск только передаёт управление уже открытому окну
if (!app.requestSingleInstanceLock()) app.quit();
else start();
