// Рисует значки приложения (PNG) без сторонних библиотек: красный корпус
// огнетушителя и тёмная головка на белом поле — тот же знак, что на вкладке.
//
//   node tools/make-icons.js      → icons/icon-192.png, icon-512.png, icon-maskable-512.png, icon-180.png
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

// scale — доля поля, которую занимает знак (у «маскируемого» значка меньше: края обрезает система).
function draw(size, scale) {
  const SS = 4; // сглаживание: 4 × 4 пробы на точку
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size - 0.5) / scale * 32 + 16;
          const v = ((y + (sy + 0.5) / SS) / size - 0.5) / scale * 32 + 16;
          let c = WHITE;
          for (const s of SHAPES) if (inside(s, u, v)) c = s.color;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = row + 1 + x * 3, n = SS * SS;
      raw[o] = Math.round(r / n); raw[o + 1] = Math.round(g / n); raw[o + 2] = Math.round(b / n);
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
function png(size, scale) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 бит, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(draw(size, scale), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
[['icon-192.png', 192, 0.9], ['icon-512.png', 512, 0.9], ['icon-maskable-512.png', 512, 0.6], ['icon-180.png', 180, 0.8]].forEach(function (x) {
  const file = path.join(dir, x[0]);
  fs.writeFileSync(file, png(x[1], x[2]));
  console.log(file + ' — ' + fs.statSync(file).size + ' байт');
});
