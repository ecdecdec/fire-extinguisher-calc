// Сборка приложения.
//
//   node tools/build.js           — проставить номер сборки в sw.js, index.html и js/config.js.
//                                   Номер считается по содержимому файлов приложения: после
//                                   любого изменения запустите перед публикацией и коммитом,
//                                   иначе установленные приложения не узнают о новой версии.
//   node tools/build.js --check   — только проверить, что номер соответствует файлам (тест).
//   node tools/build.js --dist <папка> [--public-url https://адрес-сайта/]
//                                 — чистая копия приложения (только нужные файлы) для упаковки
//                                   в приложения для Android и Windows (native/).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };

// Список файлов приложения — из sw.js (ASSETS), чтобы он был в одном месте.
function assets() {
  const sw = read('sw.js');
  const m = /const ASSETS = \[([\s\S]*?)\];/.exec(sw);
  if (!m) throw new Error('в sw.js не найден список ASSETS');
  return m[1].match(/'[^']+'/g).map(function (s) { return s.slice(1, -1); });
}

// Содержимое без самих номеров сборки — иначе номер зависел бы сам от себя.
// Переводы строк приводятся к LF: git в Windows (core.autocrlf) отдаёт файлы с CRLF,
// а хостинг и другие компьютеры — с LF; номер сборки от этого меняться не должен.
function normalized(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  if (!/\.(html|js|webmanifest|css|svg)$/.test(file)) return buf;
  let s = buf.toString('utf8').replace(/\r\n/g, '\n');
  if (file === 'index.html') s = s.replace(/\?v=[A-Za-z0-9._-]+/g, '?v=#');
  if (file === 'js/config.js') s = s.replace(/\n\s*build: '[^']*',?/g, '').replace(/version: '[^']*'/g, "version: '#'");
  if (file === 'sw.js') s = s.replace(/const VERSION = '[^']*';/, "const VERSION = '#';");
  return Buffer.from(s, 'utf8');
}

function compute() {
  const pkg = JSON.parse(read('package.json'));
  const list = assets().concat(['sw.js']).sort();
  const h = crypto.createHash('sha256');
  list.forEach(function (f) {
    h.update(f + '\0');
    h.update(normalized(f));
    h.update('\0');
  });
  const build = h.digest('hex').slice(0, 10);
  return { version: pkg.version, build: build, tag: pkg.version + '-' + build, files: list };
}

// Какие номера сейчас стоят в файлах.
function stamps() {
  const sw = /const VERSION = '([^']*)';/.exec(read('sw.js'));
  const html = read('index.html').match(/\?v=([A-Za-z0-9._-]+)/g) || [];
  const cfg = read('js/config.js');
  const v = /version: '([^']*)'/.exec(cfg), b = /build: '([^']*)'/.exec(cfg);
  return {
    sw: sw ? sw[1] : '',
    html: Array.from(new Set(html.map(function (x) { return x.slice(3); }))),
    version: v ? v[1] : '', build: b ? b[1] : ''
  };
}

function problems() {
  const want = compute(), have = stamps(), out = [];
  if (have.sw !== want.tag) out.push('sw.js: VERSION = «' + have.sw + '», нужно «' + want.tag + '»');
  if (have.html.length !== 1 || have.html[0] !== want.build) out.push('index.html: ?v=' + have.html.join(',') + ', нужно ?v=' + want.build);
  if (have.version !== want.version) out.push('js/config.js: version = «' + have.version + '», нужно «' + want.version + '»');
  if (have.build !== want.build) out.push('js/config.js: build = «' + have.build + '», нужно «' + want.build + '»');
  assets().forEach(function (f) { if (!fs.existsSync(path.join(ROOT, f))) out.push('нет файла из ASSETS: ' + f); });
  return out;
}

function stamp() {
  const want = compute();
  const write = function (f, s) { fs.writeFileSync(path.join(ROOT, f), s); };
  write('sw.js', read('sw.js').replace(/const VERSION = '[^']*';/, "const VERSION = '" + want.tag + "';"));
  write('index.html', read('index.html').replace(/\?v=[A-Za-z0-9._-]+/g, '?v=' + want.build));
  let cfg = read('js/config.js').replace(/version: '[^']*'/, "version: '" + want.version + "'");
  cfg = /build: '[^']*'/.test(cfg) ? cfg.replace(/build: '[^']*'/, "build: '" + want.build + "'") : cfg.replace(/(version: '[^']*',)/, "$1\n  build: '" + want.build + "',");
  write('js/config.js', cfg);
  // номер считается по нормализованному содержимому, поэтому после записи он тот же
  const left = problems();
  if (left.length) throw new Error('номер сборки не сошёлся:\n' + left.join('\n'));
  return want;
}

function dist(dir, publicUrl) {
  const out = path.resolve(dir);
  if (out === ROOT || ROOT.startsWith(out + path.sep)) throw new Error('папка сборки не может содержать проект');
  fs.rmSync(out, { recursive: true, force: true });
  compute().files.forEach(function (f) {
    const to = path.join(out, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), to);
  });
  if (publicUrl) {
    if (!/^https:\/\/[^\s']+$/.test(publicUrl)) throw new Error('адрес сайта должен начинаться с https://');
    const cfgFile = path.join(out, 'js', 'config.js');
    fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace(/publicUrl: '[^']*'/, "publicUrl: '" + publicUrl + "'"));
  }
  return out;
}

module.exports = { assets: assets, compute: compute, stamps: stamps, problems: problems };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = function (name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
  try {
    if (args.indexOf('--check') >= 0) {
      const p = problems();
      if (p.length) { console.error('Номер сборки устарел. Запустите: node tools/build.js\n' + p.join('\n')); process.exit(1); }
      console.log('Номер сборки в порядке: ' + compute().tag);
    } else {
      const s = stamp();
      console.log('Сборка ' + s.tag + ' (' + s.files.length + ' файлов)');
      if (opt('--dist')) console.log('Копия приложения: ' + dist(opt('--dist'), opt('--public-url')));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
