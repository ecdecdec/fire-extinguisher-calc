// Рисует значки приложения (PNG и ICO) без сторонних библиотек: красный корпус
// огнетушителя и тёмная головка на белом поле — тот же знак, что на вкладке (icons/favicon.svg).
//
//   node tools/make-icons.js                    → icons/icon-180.png, icon-192.png, icon-512.png,
//                                                  icon-maskable-192.png, icon-maskable-512.png
//   node tools/make-icons.js --android <res>    → значки и заставка приложения для Android (папка res)
//   node tools/make-icons.js --desktop <dir>    → icon.png (512) и icon.ico для приложения Windows
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RED = [196, 41, 28], INK = [23, 23, 23], WHITE = [255, 255, 255];

// Знак задан в поле 32 × 32, как значок вкладки.
const SHAPES = [
  { x: 11, y: 10, w: 10, h: 18, r: 3, color: RED },
  { x: 13, y: 4, w: 6, h: 5, r: 1, color: INK }
];

function inside(s, px, py) {
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
  const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
  return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= s.r * s.r;
}

// Фон: 'square' — белый квадрат во всё поле; 'round' — белый круг; 'rounded' — квадрат со скруглением;
// 'none' — прозрачный (передний план адаптивного значка Android).
function backgroundAt(bg, u, v) {
  if (bg === 'square') return true;
  if (bg === 'none') return false;
  const x = u - 0.5, y = v - 0.5;
  if (bg === 'round') return x * x + y * y <= 0.25;
  const r = 0.18, ax = Math.max(Math.abs(x) - (0.5 - r), 0), ay = Math.max(Math.abs(y) - (0.5 - r), 0);
  return ax * ax + ay * ay <= r * r;
}

// scale — доля поля, которую занимает знак (у «маскируемого» значка меньше: края обрезает система).
function draw(size, scale, bg) {
  const SS = 4; // сглаживание: 4 × 4 пробы на точку
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fu = (x + (sx + 0.5) / SS) / size, fv = (y + (sy + 0.5) / SS) / size;
          const u = (fu - 0.5) / scale * 32 + 16, v = (fv - 0.5) / scale * 32 + 16;
          let c = backgroundAt(bg, fu, fv) ? WHITE : null;
          for (const s of SHAPES) if (inside(s, u, v)) c = s.color;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const o = row + 1 + x * 4, n = SS * SS;
      // цвет без примеси прозрачного фона, прозрачность — по доле проб
      raw[o] = a ? Math.round(r * 255 / a) : 0; raw[o + 1] = a ? Math.round(g * 255 / a) : 0; raw[o + 2] = a ? Math.round(b * 255 / a) : 0; raw[o + 3] = Math.round(a / n);
    }
  }
  return raw;
}

const CRC = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}());
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(size, scale, bg) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(draw(size, scale, bg || 'square'), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ICO с картинками PNG внутри (Windows Vista и новее).
function ico(sizes, scale, bg) {
  const images = sizes.map(function (s) { return png(s, scale, bg); });
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach(function (s, i) {
    const o = 6 + i * 16;
    head[o] = s >= 256 ? 0 : s; head[o + 1] = s >= 256 ? 0 : s; head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(images[i].length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head].concat(images));
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(file + ' — ' + buf.length + ' байт');
}

const args = process.argv.slice(2);
const android = args.indexOf('--android') >= 0 ? args[args.indexOf('--android') + 1] : '';
const desktop = args.indexOf('--desktop') >= 0 ? args[args.indexOf('--desktop') + 1] : '';

if (android) {
  // плотности экрана Android: обычный значок 48 dp, передний план адаптивного 108 dp, заставка
  const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  Object.keys(D).forEach(function (d) {
    const k = D[d];
    write(path.join(android, 'mipmap-' + d, 'ic_launcher.png'), png(Math.round(48 * k), 0.78, 'rounded'));
    write(path.join(android, 'mipmap-' + d, 'ic_launcher_round.png'), png(Math.round(48 * k), 0.72, 'round'));
    write(path.join(android, 'mipmap-' + d, 'ic_launcher_foreground.png'), png(Math.round(108 * k), 0.5, 'none'));
    write(path.join(android, 'drawable-' + d, 'splash_icon.png'), png(Math.round(96 * k), 0.9, 'none'));
  });
  // заставка: белый фон и значок по центру (картинка не растягивается на весь экран)
  write(path.join(android, 'drawable', 'splash.xml'), Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <item android:drawable="@android:color/white" />\n' +
    '    <item><bitmap android:gravity="center" android:src="@drawable/splash_icon" /></item>\n</layer-list>\n'));
} else if (desktop) {
  write(path.join(desktop, 'icon.png'), png(512, 0.86, 'rounded'));
  write(path.join(desktop, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256], 0.86, 'rounded'));
} else {
  const dir = path.join(__dirname, '..', 'icons');
  [['icon-192.png', 192, 0.9], ['icon-512.png', 512, 0.9], ['icon-maskable-192.png', 192, 0.6], ['icon-maskable-512.png', 512, 0.6], ['icon-180.png', 180, 0.8]].forEach(function (x) {
    write(path.join(dir, x[0]), png(x[1], x[2], 'square'));
  });
}
