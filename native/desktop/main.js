// Приложение «Огнетушители» для Windows (Electron).
//
// Внутри — те же файлы, что у сайта (папка www, её собирает tools/native.js). Они отдаются
// по адресу app://firecalc/… прямо из приложения: сеть не нужна, объекты и картинки планов
// хранятся на этом компьютере (папка данных Windows для приложения «Огнетушители»).
// PDF сохраняется через обычное окно «Сохранить как».
const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, 'www');
const ORIGIN = 'app://firecalc/';

// Свой адрес вместо file://: у приложения постоянное хранилище, работают фоновый поток
// распознавания плана и загрузка шрифтов.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

app.setAppUserModelId('kz.firecalc.app');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function serveFiles() {
  protocol.handle('app', function (request) {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(WEB, rel));
    // только файлы приложения, без выхода за папку www
    if (url.host !== 'firecalc' || (file !== WEB && !file.startsWith(WEB + path.sep))) return new Response('Не найдено', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function menu() {
  // строка меню скрыта (Alt показывает её), но сочетания клавиш работают: обновить, масштаб, во весь экран
  return Menu.buildFromTemplate([
    { label: 'Файл', submenu: [{ role: 'reload', label: 'Обновить' }, { type: 'separator' }, { role: 'quit', label: 'Выход' }] },
    { label: 'Правка', submenu: [{ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    { label: 'Вид', submenu: [{ role: 'zoomIn', label: 'Крупнее' }, { role: 'zoomOut', label: 'Мельче' }, { role: 'resetZoom', label: 'Обычный размер' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Во весь экран' }, { role: 'toggleDevTools', label: 'Инструменты разработчика' }] }
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 900, minWidth: 360, minHeight: 520,
    title: 'Огнетушители', backgroundColor: '#ffffff', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false
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

app.whenReady().then(function () {
  serveFiles();
  Menu.setApplicationMenu(menu());
  // PDF и другие файлы: окно «Сохранить как», по умолчанию — в «Загрузки»
  session.defaultSession.on('will-download', function (event, item) {
    item.setSaveDialogOptions({ title: 'Сохранить файл', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
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
