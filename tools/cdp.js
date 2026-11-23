// Управление браузером (Edge или Chrome) по протоколу DevTools — для проверок интерфейса,
// снимков экрана и проверки работы без сети. Без сторонних библиотек (Node 22: fetch, WebSocket).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Статический сервер для проверок: файлы проекта по http://127.0.0.1:порт/. Свой, на Node:
// python -m http.server обрывает соединения, когда служебный сценарий (sw.js) скачивает все
// файлы приложения разом, и установка для работы без сети не завершается.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
async function serve(port) {
  const http = require('node:http');
  const server = http.createServer(function (req, res) {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (e) { res.writeHead(400); res.end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, function (err, st) {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise(function (resolve, reject) { server.once('error', reject); server.listen(port, '127.0.0.1', 511, resolve); });
  return { kill: function () { server.closeAllConnections(); server.close(); } };
}

async function launch(opts) {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('не найден Edge или Chrome (переменная BROWSER — путь к браузеру)');
  const port = opts.port || 9333;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecalc-cdp-'));
  const args = ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=' + (opts.width || 1320) + ',' + (opts.height || 900), 'about:blank'];
  const child = spawn(exe, args.concat(opts.args || []), { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) break; } catch (e) { /* ждём */ }
    await sleep(100);
  }
  return {
    port: port,
    close: async function () { child.kill(); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* файлы ещё заняты */ } }
  };
}

// Вкладка: send(метод, параметры) → результат; on(событие, fn); eval(выражение) → значение.
async function tab(browser, url) {
  const r = await fetch('http://127.0.0.1:' + browser.port + '/json/new?' + encodeURI(url || 'about:blank'), { method: 'PUT' });
  const info = await r.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiting = new Map(), handlers = {};
  ws.onmessage = function (m) {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result);
    } else if (msg.method && handlers[msg.method]) handlers[msg.method].forEach(fn => fn(msg.params));
  };
  const t = {
    id: info.id,
    send: function (method, params) {
      const id = ++seq;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      return new Promise((res, rej) => waiting.set(id, { res: res, rej: rej }));
    },
    on: function (event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
    eval: async function (expr) {
      const out = await t.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) throw new Error((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text);
      return out.result.value;
    },
    // ждать, пока выражение не станет истинным
    until: async function (expr, ms) {
      const end = Date.now() + (ms || 15000);
      while (Date.now() < end) {
        try { const v = await t.eval(expr); if (v) return v; } catch (e) { /* страница ещё грузится */ }
        await sleep(150);
      }
      throw new Error('не дождался: ' + expr);
    },
    goto: async function (u) { await t.send('Page.navigate', { url: u }); await sleep(300); },
    shot: async function (file, clip) {
      const out = await t.send('Page.captureScreenshot', Object.assign({ format: 'png', captureBeyondViewport: false }, clip ? { clip: clip } : {}));
      fs.writeFileSync(file, Buffer.from(out.data, 'base64'));
      return file;
    },
    close: function () { try { ws.close(); } catch (e) { /* уже закрыта */ } }
  };
  await t.send('Page.enable');
  await t.send('Runtime.enable');
  return t;
}

module.exports = { ROOT: ROOT, sleep: sleep, serve: serve, launch: launch, tab: tab };
