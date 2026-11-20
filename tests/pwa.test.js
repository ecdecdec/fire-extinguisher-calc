// Устанавливаемое приложение (PWA): манифест, список файлов для работы без сети, номер сборки.
// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const build = require('../tools/build.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const strip = u => u.split('?')[0].split('#')[0].replace(/^\.\//, '');

function pngSize(file) {
  const b = fs.readFileSync(path.join(ROOT, file));
  assert.equal(b.toString('ascii', 1, 4), 'PNG', file);
  return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20);
}

test('номер сборки соответствует файлам (иначе: node tools/build.js)', () => {
  assert.deepEqual(build.problems(), []);
});

test('все файлы приложения сохраняются для работы без сети', () => {
  const assets = new Set(build.assets());
  assets.forEach(f => assert.ok(exists(f), 'есть файл ' + f));
  // всё, что подключает index.html
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => strip(m[1])).filter(u => !/^(https?:|data:|#)/.test(u));
  refs.forEach(u => assert.ok(assets.has(u), 'index.html → ' + u));
  // шрифты из CSS
  const css = read('css/app.css');
  [...css.matchAll(/url\("\.\.\/([^"]+)"\)/g)].forEach(m => assert.ok(assets.has(m[1]), 'app.css → ' + m[1]));
  // то, что подгружается позже: PDF, распознавание плана, пример плана
  ['vendor/pdfmake.min.js', 'vendor/vfs_report.js', 'js/vision.worker.js', 'js/vision.js', 'examples/plan-school.png'].forEach(f => assert.ok(assets.has(f), f));
  const app = read('js/app.js');
  assert.ok(app.includes("'vendor/pdfmake.min.js'") && app.includes("'vendor/vfs_report.js'") && app.includes("'examples/plan-school.png'"));
  assert.match(read('js/vision.worker.js'), /importScripts\('vision\.js'\)/);
  // значки из манифеста — тоже
  const man = JSON.parse(read('manifest.webmanifest'));
  man.icons.forEach(i => assert.ok(assets.has(i.src), 'значок ' + i.src));
});

test('манифест: всё, что нужно для установки на телефон и компьютер', () => {
  const man = JSON.parse(read('manifest.webmanifest'));
  ['id', 'name', 'short_name', 'description', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'lang'].forEach(k => assert.ok(man[k], k));
  assert.equal(man.display, 'standalone');
  const any = man.icons.filter(i => i.purpose === 'any' && i.type === 'image/png').map(i => i.sizes);
  const mask = man.icons.filter(i => i.purpose === 'maskable').map(i => i.sizes);
  assert.ok(any.includes('192x192') && any.includes('512x512'), 'значки 192 и 512');
  assert.ok(mask.includes('192x192') && mask.includes('512x512'), 'маскируемые значки');
  man.icons.filter(i => i.type === 'image/png').forEach(i => assert.equal(pngSize(i.src), i.sizes, i.src));
  // снимки экрана для окна установки: широкий и узкий
  assert.deepEqual(man.screenshots.map(s => s.form_factor).sort(), ['narrow', 'wide']);
  man.screenshots.forEach(s => assert.equal(pngSize(s.src), s.sizes, s.src));
  // ярлыки ведут на действия, которые понимает приложение
  const app = read('js/app.js');
  man.shortcuts.forEach(s => {
    const action = new URL(s.url, 'https://x/').searchParams.get('action');
    assert.ok(app.includes("action === '" + action + "'"), 'ярлык ' + s.url);
  });
  // «Поделиться → Огнетушители»: приём фото плана службой sw.js
  assert.equal(man.share_target.method, 'POST');
  assert.equal(man.share_target.params.files[0].name, 'plan');
  const sw = read('sw.js');
  assert.ok(sw.includes("searchParams.has('share-target')") && sw.includes("form.get('plan')"));
  assert.ok(man.share_target.action.includes('share-target'));
  // index.html: ссылка на манифест и значок для iPhone
  const html = read('index.html');
  assert.ok(html.includes('rel="manifest"') && html.includes('rel="apple-touch-icon"') && html.includes('name="theme-color"'));
});

test('служба работы без сети: обновление по кнопке, старые версии удаляются', () => {
  const sw = read('sw.js');
  assert.ok(/const VERSION = '\d+\.\d+\.\d+-[0-9a-f]{10}';/.test(sw), 'номер версии проставлен');
  assert.ok(sw.includes("event.data.type === 'SKIP_WAITING'"), 'переключение по кнопке «Обновить»');
  assert.ok(!/addEventListener\('install'[\s\S]*?skipWaiting\(\)[\s\S]*?\}\);/.test(sw.split("addEventListener('activate'")[0]), 'новая версия не включается сама посреди работы');
  assert.ok(sw.includes("cache: 'reload'"), 'файлы новой версии — мимо HTTP-кэша');
  assert.ok(sw.includes('caches.delete'), 'старые версии удаляются');
  const pf = read('js/platform.js');
  assert.ok(pf.includes("postMessage({ type: 'SKIP_WAITING' })"));
});
