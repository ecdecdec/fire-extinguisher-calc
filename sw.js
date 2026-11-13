/*
 * Работа без сети. Приложение целиком кладётся в память браузера при первом
 * открытии; дальше оно запускается и считает без интернета, в том числе PDF.
 *
 * Порядок: сначала сеть (чтобы после обновления сайта сразу приходили новые
 * файлы), а если сети нет или она не отвечает за 3,5 с — сохранённая копия.
 * При изменении списка файлов увеличьте номер в CACHE.
 */
const CACHE = 'firecalc-v9';
const SLOW_NETWORK_MS = 3500;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/norms.js', 'js/engine.js', 'js/presets.js', 'js/plan.js', 'js/vision.js', 'js/vision.worker.js', 'js/share.js', 'js/report.js', 'js/app.js',
  'examples/plan-school.png',
  'vendor/vue.global.prod.js', 'vendor/pdfmake.min.js', 'vendor/vfs_report.js',
  'vendor/fonts/ibm-plex-sans-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-latin-500-normal.woff2',
  'vendor/fonts/ibm-plex-sans-cyrillic-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-cyrillic-500-normal.woff2',
  'vendor/fonts/ibm-plex-sans-cyrillic-ext-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-cyrillic-ext-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-latin-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-cyrillic-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-cyrillic-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-cyrillic-ext-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-cyrillic-ext-500-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Файл хранится под адресом без «?v=…» и прочих параметров.
function keyOf(request) {
  const url = new URL(request.url);
  return url.origin + url.pathname;
}

function fromNetwork(request) {
  return fetch(request).then(function (response) {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(function (cache) { return cache.put(keyOf(request), copy); }).catch(function () {});
    }
    return response;
  });
}

function fromCache(request) {
  return caches.match(keyOf(request)).then(function (hit) {
    if (hit) return hit;
    return request.mode === 'navigate' ? caches.match(new URL('index.html', self.registration.scope).href) : undefined;
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const network = fromNetwork(request);
  const slow = new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('slow network')); }, SLOW_NETWORK_MS); });
  event.respondWith(
    Promise.race([network, slow]).catch(function () {
      return fromCache(request).then(function (hit) { return hit || network; });
    })
  );
});
