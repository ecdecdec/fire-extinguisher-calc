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

module.exports = { readPng };
