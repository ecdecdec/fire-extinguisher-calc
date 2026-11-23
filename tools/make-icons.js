// Значки приложения: знак F04 «Огнетушитель» (рисунок ISO 7010 F001, общественное достояние)
// белым на красном. Тот же рисунок, что у знаков на схеме (js/signs.js). Картинки рисует Edge
// без окна (tools/cdp.js), так что кривые и сглаживание точные.
//
//   node tools/make-icons.js   (npm run icons)
//     icons/icon-192.png, icon-512.png, icon-maskable-192.png, icon-maskable-512.png, icon-180.png, favicon.svg
//     native/android/app/src/main/res: значки всех плотностей, адаптивный значок, монохромный, заставка
//     native/desktop/build: icon.png и icon.ico для Windows
//
// В мелких размерах (до 32 точек: вкладка браузера, мелкий значок Windows) пламя знака сливается
// в пятно, поэтому там только огнетушитель.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('./cdp.js');
const S = require('../js/signs.js');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'native', 'android', 'app', 'src', 'main', 'res');
const RED = S.COLORS.red;

// рисунок знака без квадрата: белый огнетушитель с пламенем и красная табличка на корпусе
const PICT = S.signBody('op').replace(/^<rect[^>]*\/>/, '');
const PARTS = PICT.match(/<path[^>]*\/>/g);
const BODY = PARTS[0] + PARTS[PARTS.length - 1]; // огнетушитель и табличка, без пламени
// габариты в поле знака 100 × 100 (посчитаны по контурам)
const PICT_BOX = [10.76, 9.39, 89.86, 90.79];
const BODY_BOX = [10.76, 9.39, 43.9, 90.6];

// content с габаритом box по центру поля 100 × 100, большая сторона — share от стороны поля
function place(content, box, share) {
  const w = box[2] - box[0], h = box[3] - box[1], k = share * 100 / Math.max(w, h);
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return '<g transform="translate(50 50) scale(' + k.toFixed(4) + ') translate(' + (-cx).toFixed(3) + ' ' + (-cy).toFixed(3) + ')">' + content + '</g>';
}
function pict(size, share) { return size <= 32 ? place(BODY, BODY_BOX, share) : place(PICT, PICT_BOX, share); }

// виды значка: фон и доля рисунка
const DESIGNS = {
  any: function (s) { return '<rect width="100" height="100" rx="16" fill="' + RED + '"/>' + pict(s, 0.78); },      // сайт, Windows
  maskable: function (s) { return '<rect width="100" height="100" fill="' + RED + '"/>' + pict(s, 0.56); },         // край обрезает система
  apple: function (s) { return '<rect width="100" height="100" fill="' + RED + '"/>' + pict(s, 0.72); },            // iPhone скругляет сам
  launcher: function (s) { return '<rect x="4" y="4" width="92" height="92" rx="14" fill="' + RED + '"/>' + pict(s, 0.7); },
  round: function (s) { return '<circle cx="50" cy="50" r="46" fill="' + RED + '"/>' + pict(s, 0.54); },
  foreground: function (s) { return pict(s, 0.56); },                                                                // адаптивный значок: фон задан цветом
  splash: function (s) { return '<rect x="27" y="27" width="46" height="46" rx="8" fill="' + RED + '"/>' + place(PICT, PICT_BOX, 0.36); }
};

function svg(size, inner) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 100 100">' + inner + '</svg>';
}

async function render(t, design, size) {
  await t.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await t.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>' +
    svg(size, DESIGNS[design](size)) + '</body></html>';
  await t.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
  await t.until("document.readyState === 'complete' && !!document.querySelector('svg')", 10000);
  const out = await t.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 }, captureBeyondViewport: true });
  return Buffer.from(out.data, 'base64');
}

// ICO с картинками PNG внутри (Windows Vista и новее)
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(function (img, i) {
    const o = 6 + i * 16, s = img.size;
    head[o] = s >= 256 ? 0 : s; head[o + 1] = s >= 256 ? 0 : s; head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(img.png.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += img.png.length;
  });
  return Buffer.concat([head].concat(images.map(function (img) { return img.png; })));
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(path.relative(ROOT, file) + '  ' + buf.length + ' байт');
}

(async function () {
  const browser = await C.launch({ port: 9450 + Math.floor(Math.random() * 40), width: 1200, height: 1200 });
  try {
    const t = await C.tab(browser, 'about:blank');
    // сайт (PWA)
    for (const x of [['icon-192.png', 'any', 192], ['icon-512.png', 'any', 512], ['icon-maskable-192.png', 'maskable', 192], ['icon-maskable-512.png', 'maskable', 512], ['icon-180.png', 'apple', 180]]) {
      write(path.join(ROOT, 'icons', x[0]), await render(t, x[1], x[2]));
    }
    // значок вкладки: вектор, только огнетушитель
    write(path.join(ROOT, 'icons', 'favicon.svg'), Buffer.from(svg(32, DESIGNS.any(32)).replace(' width="32" height="32"', '') + '\n'));
    // Android: обычный значок 48 dp, передний план адаптивного 108 dp (безопасная зона 66 dp), заставка 288 dp
    const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    for (const d of Object.keys(D)) {
      const k = D[d];
      write(path.join(RES, 'mipmap-' + d, 'ic_launcher.png'), await render(t, 'launcher', Math.round(48 * k)));
      write(path.join(RES, 'mipmap-' + d, 'ic_launcher_round.png'), await render(t, 'round', Math.round(48 * k)));
      const fg = await render(t, 'foreground', Math.round(108 * k));
      write(path.join(RES, 'mipmap-' + d, 'ic_launcher_foreground.png'), fg);
      write(path.join(RES, 'mipmap-' + d, 'ic_launcher_monochrome.png'), fg);
      write(path.join(RES, 'drawable-' + d, 'splash_icon.png'), await render(t, 'splash', Math.round(288 * k)));
    }
    // Windows
    write(path.join(ROOT, 'native', 'desktop', 'build', 'icon.png'), await render(t, 'any', 512));
    const images = [];
    for (const s of [16, 24, 32, 48, 64, 128, 256]) images.push({ size: s, png: await render(t, 'any', s) });
    write(path.join(ROOT, 'native', 'desktop', 'build', 'icon.ico'), ico(images));
    t.close();
  } finally {
    await browser.close();
  }
}()).catch(function (e) { console.error(e); process.exit(1); });
