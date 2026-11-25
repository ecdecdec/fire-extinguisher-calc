/*
 * Работа без сети и обновление приложения (PWA).
 *
 *   — при первом открытии все файлы приложения кладутся в память браузера;
 *   — дальше приложение открывается из неё сразу, без ожидания сети, в том числе PDF
 *     и распознавание плана;
 *   — новая версия (другой VERSION) скачивается в фоне; приложение показывает
 *     «Вышла новая версия — Обновить» и переключается по нажатию, чтобы не сменить
 *     файлы посреди работы;
 *   — фото плана, отправленное через «Поделиться → Огнетушители» на Android
 *     (share_target в manifest.webmanifest), передаётся приложению.
 *
 * VERSION ставит tools/build.js (npm run build) по содержимому файлов: любое изменение
 * файла из ASSETS даёт новую версию. Новый файл приложения добавьте в ASSETS.
 */
const VERSION = '1.0.1-da2fa912d3';
const CACHE = 'firecalc-' + VERSION;
const INBOX = 'firecalc-inbox';
const ASSETS = [
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/config.js', 'js/signs.js', 'js/norms.js', 'js/engine.js', 'js/presets.js', 'js/plan.js',
  'js/vision.js', 'js/vision.worker.js', 'js/share.js', 'js/report.js', 'js/library.js', 'js/platform.js', 'js/app.js',
  'vendor/vue.global.prod.js', 'vendor/pdfmake.min.js', 'vendor/vfs_report.js',
  'vendor/fonts/ibm-plex-sans-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-latin-500-normal.woff2',
  'vendor/fonts/ibm-plex-sans-cyrillic-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-cyrillic-500-normal.woff2',
  'vendor/fonts/ibm-plex-sans-cyrillic-ext-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-cyrillic-ext-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-latin-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-cyrillic-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-cyrillic-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-cyrillic-ext-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-cyrillic-ext-500-normal.woff2',
  'examples/plan-school.png',
  'icons/favicon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png'
];

const SCOPE = new URL('./', self.location).href;
const SHELL = new URL('index.html', self.location).href;
const PRECACHED = new Set(ASSETS.map(function (a) { return new URL(a, self.location).href; }));

self.addEventListener('install', function (event) {
  // cache: 'reload' — мимо HTTP-кэша, чтобы в новую версию не попали старые файлы
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(ASSETS.map(function (a) { return new Request(a, { cache: 'reload' }); }));
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== INBOX && k.indexOf('firecalc-') === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Приложение просит включить скачанную новую версию (кнопка «Обновить»).
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Файл хранится под адресом без «?v=…» и прочих параметров.
function keyOf(url) { return url.origin + url.pathname; }

function fromCache(key) {
  return caches.open(CACHE).then(function (cache) { return cache.match(key); });
}

// Сеть с запасным вариантом из памяти (для файлов вне ASSETS, например страницы проверки).
// Запасной вариант берётся только из кэша приложения: файл, присланный через «Поделиться»
// (кэш входящих), никогда не отдаётся как страница или скрипт приложения.
function networkFirst(request) {
  return fetch(request).catch(function () {
    return fromCache(keyOf(new URL(request.url))).then(function (hit) { return hit || Response.error(); });
  });
}

// Фото плана из меню «Поделиться» (Android): сохраняется и передаётся приложению адресом ?inbox=share.
function receiveShare(request) {
  return request.formData().then(function (form) {
    const file = form.get('plan');
    if (!file || typeof file === 'string') return null;
    return caches.open(INBOX).then(function (cache) {
      return cache.put('inbox/plan', new Response(file, {
        headers: { 'Content-Type': file.type || 'image/jpeg', 'X-File-Name': encodeURIComponent(file.name || 'plan.jpg') }
      }));
    });
  }).catch(function () { return null; }).then(function () {
    return Response.redirect(SCOPE + '?inbox=share', 303);
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.searchParams.has('share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  const key = keyOf(url);

  // само приложение: index.html из памяти сразу (адрес с #o=…, ?demo=… и т. п. — та же страница)
  if (request.mode === 'navigate' && (key === SCOPE || key === SHELL)) {
    event.respondWith(fromCache(SHELL).then(function (hit) { return hit || networkFirst(request); }));
    return;
  }
  // файлы приложения: из памяти, без ожидания сети
  if (PRECACHED.has(key)) {
    event.respondWith(fromCache(key).then(function (hit) { return hit || networkFirst(request); }));
    return;
  }
  event.respondWith(networkFirst(request));
});
