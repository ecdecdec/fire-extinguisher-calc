// Общее для тестов: чтение PNG без сторонних библиотек (8 бит, RGB или RGBA, без чересстрочности).
const fs = require('node:fs');
const zlib = require('node:zlib');

function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), name = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('нужен PNG 8 бит без чересстрочности');
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error('нужен PNG RGB или RGBA');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, rgba = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let p = line[i];
      if (f === 1) p += a; else if (f === 2) p += b; else if (f === 3) p += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c); }
      cur[i] = p & 255;
    }
    for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) rgba[(y * w + x) * 4 + c] = c < bpp ? cur[x * bpp + c] : 255;
    prev = cur;
  }
  return { w, h, rgba };
}

// ---------- случайные объекты для проверок на свойства ----------
const N = require('../js/norms.js');
const P = require('../js/presets.js');

// Повторяемый генератор случайных чисел: один и тот же seed — те же объекты.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const PURPOSES = Object.keys(P.BY_ID);
const AREAS = [1, 9.5, 20, 60, 99, 100, 150, 199, 200, 201, 300, 399, 400, 450, 499, 500, 501, 600, 799, 800, 801, 1000, 1500, 1800, 1801, 2500];
const CATS = Object.keys(N.CATEGORIES);
const KINDS = ['public', 'industrial', 'warehouse'];

function randomObject(rnd, id) {
  const pick = list => list[Math.floor(rnd() * list.length)];
  const floors = [];
  const nf = 1 + Math.floor(rnd() * 3);
  for (let f = 0; f < nf; f++) {
    const rooms = [];
    const nr = Math.floor(rnd() * 8);
    for (let i = 0; i < nr; i++) {
      const r = P.blankRoom(pick(PURPOSES));
      r.id = 'o' + id + 'f' + f + 'r' + i;
      r.name = 'П' + i;
      r.area = rnd() < 0.75 ? pick(AREAS) : Math.round(rnd() * 30000) / 10;
      if (rnd() < 0.2) r.count = 1 + Math.floor(rnd() * 4);
      if (!r.t5 && rnd() < 0.25) { r.classes = ['A', 'B', 'C', 'D', 'E'].filter(() => rnd() < 0.4); if (!r.classes.length) r.classes = ['A']; }
      if (!r.t5 && rnd() < 0.2) r.category = pick(CATS);
      if (!r.t5 && rnd() < 0.15) r.sensitive = !r.sensitive;
      if (rnd() < 0.15) r.autoSuppression = true;
      if (rnd() < 0.3) { r.length = Math.round((2 + rnd() * 90) * 10) / 10; r.width = Math.round((2 + rnd() * 40) * 10) / 10; }
      if (!r.t5 && rnd() < 0.1) r.forceType = pick(['P2', 'P5', 'P10', 'C2', 'C35']);
      if (r.t5 === 'parking_open' || r.t5 === 'sto') r.t5Alt = rnd() < 0.3 ? 1 : 0;
      rooms.push(r);
    }
    floors.push({ name: (f + 1) + ' этаж', rooms: rooms });
  }
  return { kind: pick(KINDS), floors: floors };
}

function randomOptions(rnd) {
  return {
    rounding: rnd() < 0.15 ? 'block' : 'proportional',
    poolSmallRooms: rnd() < 0.8,
    onlyPowderAndCO2: rnd() < 0.9,
    wheeled: rnd() < 0.85,
    floorMinAll: rnd() < 0.7
  };
}

module.exports = { readPng, mulberry32, randomObject, randomOptions };
