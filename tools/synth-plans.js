/*
 * Генератор синтетических планов этажей с точным эталоном (полигоны и площади помещений).
 * Чистый JS без DOM (UMD: Node, браузер, Web Worker).
 *
 * API:
 *   VARIANTS - список имен вариантов
 *   make(variant, seed, opts) -> { rgba: Uint8ClampedArray, w, h, scale, rooms, meta }
 *     rooms: [{ name, poly: [[x, y], ...], area }]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FireSynthPlans = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VARIANTS = [
    'clean',
    'hollow',
    'door-arcs',
    'windows',
    'furniture',
    'toilets',
    'open-plan',
    'stubs',
    'gray-walls',
    'colored-walls',
    'evacuation',
    'sheet',
    'photo',
    'lowres',
    'tight',
    'two-buildings'
  ];

  // ---------- генератор псевдослучайных чисел ----------

  function mulberry32(seed) {
    let s = (typeof seed === 'number' && isFinite(seed) ? Math.floor(seed) : 1) | 0;
    if (s === 0) s = 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(variant, seed) {
    let h = (typeof seed === 'number' && isFinite(seed) ? Math.floor(seed) : 1) | 0;
    for (let i = 0; i < variant.length; i++) {
      h = (Math.imul(h, 31) + variant.charCodeAt(i)) | 0;
    }
    return h === 0 ? 1 : h;
  }

  function rand(rnd, a, b) { return a + rnd() * (b - a); }
  function randInt(rnd, a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  // ---------- рисование со сглаживанием (частичное покрытие пикселей) ----------

  function createCanvas(w, h, bg) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    const r = bg[0], g = bg[1], b = bg[2];
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
    return rgba;
  }

  function blendPixel(rgba, idx, r, g, b, a) {
    if (a <= 0) return;
    if (a >= 0.999) {
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;
      return;
    }
    const inv = 1 - a;
    rgba[idx] = rgba[idx] * inv + r * a + 0.5;
    rgba[idx + 1] = rgba[idx + 1] * inv + g * a + 0.5;
    rgba[idx + 2] = rgba[idx + 2] * inv + b * a + 0.5;
    rgba[idx + 3] = 255;
  }

  function fillRectAA(rgba, w, h, x0, y0, x1, y1, color, alpha) {
    if (x1 <= x0 || y1 <= y0) return;
    const al = alpha === undefined ? 1 : alpha;
    if (al <= 0) return;
    const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(w - 1, Math.ceil(x1) - 1);
    const iy0 = Math.max(0, Math.floor(y0)), iy1 = Math.min(h - 1, Math.ceil(y1) - 1);
    const r = color[0], g = color[1], b = color[2];
    for (let y = iy0; y <= iy1; y++) {
      const cy = Math.min(y + 1, y1) - Math.max(y, y0);
      if (cy <= 0) continue;
      const row = y * w;
      for (let x = ix0; x <= ix1; x++) {
        const cx = Math.min(x + 1, x1) - Math.max(x, x0);
        if (cx <= 0) continue;
        blendPixel(rgba, (row + x) * 4, r, g, b, cx * cy * al);
      }
    }
  }

  function strokeRectAA(rgba, w, h, x0, y0, x1, y1, lineW, color, alpha) {
    if (x1 <= x0 || y1 <= y0 || lineW <= 0) return;
    const lw = Math.min(lineW, (x1 - x0) * 0.5, (y1 - y0) * 0.5);
    fillRectAA(rgba, w, h, x0, y0, x1, y0 + lw, color, alpha);
    fillRectAA(rgba, w, h, x0, y1 - lw, x1, y1, color, alpha);
    fillRectAA(rgba, w, h, x0, y0 + lw, x0 + lw, y1 - lw, color, alpha);
    fillRectAA(rgba, w, h, x1 - lw, y0 + lw, x1, y1 - lw, color, alpha);
  }

  function drawLineAA(rgba, w, h, x0, y0, x1, y1, lineW, color, alpha) {
    const al = alpha === undefined ? 1 : alpha;
    if (al <= 0 || lineW <= 0) return;
    const half = lineW * 0.5;
    if (Math.abs(y0 - y1) < 1e-6) {
      const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
      fillRectAA(rgba, w, h, ax, y0 - half, bx, y0 + half, color, al);
      return;
    }
    if (Math.abs(x0 - x1) < 1e-6) {
      const ay = Math.min(y0, y1), by = Math.max(y0, y1);
      fillRectAA(rgba, w, h, x0 - half, ay, x0 + half, by, color, al);
      return;
    }
    const vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy;
    const pad = half + 1.5;
    const ix0 = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
    const ix1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + pad));
    const iy0 = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
    const iy1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + pad));
    const r = color[0], g = color[1], b = color[2];
    for (let y = iy0; y <= iy1; y++) {
      const py = y + 0.5, row = y * w;
      for (let x = ix0; x <= ix1; x++) {
        const px = x + 0.5;
        let t = L2 > 0 ? ((px - x0) * vx + (py - y0) * vy) / L2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = px - (x0 + t * vx), dy = py - (y0 + t * vy);
        const cov = clamp(half + 0.5 - Math.sqrt(dx * dx + dy * dy), 0, 1);
        if (cov > 0) blendPixel(rgba, (row + x) * 4, r, g, b, cov * al);
      }
    }
  }

  function drawArcAA(rgba, w, h, cx, cy, radius, a0, a1, lineW, color, alpha) {
    const al = alpha === undefined ? 1 : alpha;
    if (al <= 0 || lineW <= 0 || radius <= 0) return;
    const TWO_PI = Math.PI * 2;
    let span = a1 - a0;
    while (span < 0) span += TWO_PI;
    if (span > TWO_PI) span = TWO_PI;
    const half = lineW * 0.5, pad = half + 1.5;
    const ix0 = Math.max(0, Math.floor(cx - radius - pad));
    const ix1 = Math.min(w - 1, Math.ceil(cx + radius + pad));
    const iy0 = Math.max(0, Math.floor(cy - radius - pad));
    const iy1 = Math.min(h - 1, Math.ceil(cy + radius + pad));
    const ex0 = cx + radius * Math.cos(a0), ey0 = cy + radius * Math.sin(a0);
    const ex1 = cx + radius * Math.cos(a1), ey1 = cy + radius * Math.sin(a1);
    const r = color[0], g = color[1], b = color[2];
    for (let y = iy0; y <= iy1; y++) {
      const py = y + 0.5, dy = py - cy, row = y * w;
      for (let x = ix0; x <= ix1; x++) {
        const px = x + 0.5, dx = px - cx;
        const distC = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(distC - radius) > pad) continue;
        let da = Math.atan2(dy, dx) - a0;
        da = ((da % TWO_PI) + TWO_PI) % TWO_PI;
        let d;
        if (da <= span) {
          d = Math.abs(distC - radius);
        } else {
          const d0 = Math.hypot(px - ex0, py - ey0);
          const d1 = Math.hypot(px - ex1, py - ey1);
          d = d0 < d1 ? d0 : d1;
        }
        const cov = clamp(half + 0.5 - d, 0, 1);
        if (cov > 0) blendPixel(rgba, (row + x) * 4, r, g, b, cov * al);
      }
    }
  }

  function drawCircleAA(rgba, w, h, cx, cy, radius, color, alpha) {
    const al = alpha === undefined ? 1 : alpha;
    if (al <= 0 || radius <= 0) return;
    const pad = radius + 1.5;
    const ix0 = Math.max(0, Math.floor(cx - pad));
    const ix1 = Math.min(w - 1, Math.ceil(cx + pad));
    const iy0 = Math.max(0, Math.floor(cy - pad));
    const iy1 = Math.min(h - 1, Math.ceil(cy + pad));
    const r = color[0], g = color[1], b = color[2];
    for (let y = iy0; y <= iy1; y++) {
      const dy = y + 0.5 - cy, row = y * w;
      for (let x = ix0; x <= ix1; x++) {
        const dx = x + 0.5 - cx;
        const cov = clamp(radius + 0.5 - Math.sqrt(dx * dx + dy * dy), 0, 1);
        if (cov > 0) blendPixel(rgba, (row + x) * 4, r, g, b, cov * al);
      }
    }
  }

  function drawTriangleAA(rgba, w, h, p0, p1, p2, color, alpha) {
    const al = alpha === undefined ? 1 : alpha;
    if (al <= 0) return;
    let a = p0, b = p1, c = p2;
    const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area2) < 1e-6) return;
    if (area2 < 0) { const tmp = b; b = c; c = tmp; }
    const edges = [[a, b], [b, c], [c, a]].map(function (e) {
      const ex = e[1][0] - e[0][0], ey = e[1][1] - e[0][1], len = Math.hypot(ex, ey) || 1;
      return { x: e[0][0], y: e[0][1], nx: -ey / len, ny: ex / len };
    });
    const ix0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) - 1));
    const ix1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0]) + 1));
    const iy0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) - 1));
    const iy1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1]) + 1));
    const cr = color[0], cg = color[1], cb = color[2];
    for (let y = iy0; y <= iy1; y++) {
      const py = y + 0.5, row = y * w;
      for (let x = ix0; x <= ix1; x++) {
        const px = x + 0.5;
        let minD = 1e9;
        for (let k = 0; k < 3; k++) {
          const d = (px - edges[k].x) * edges[k].nx + (py - edges[k].y) * edges[k].ny;
          if (d < minD) minD = d;
        }
        const cov = clamp(minD + 0.5, 0, 1);
        if (cov > 0) blendPixel(rgba, (row + x) * 4, cr, cg, cb, cov * al);
      }
    }
  }

  // Встроенный растровый шрифт 5x7: цифры и запятая (для планов БТИ и размеров).
  const BITMAP_FONT = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ',': ['00000', '00000', '00000', '00000', '00110', '00100', '01000'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
  };

  function drawDigits(rgba, w, h, str, cx, cy, cellPx, color, alpha) {
    const s = String(str);
    const step = cellPx * 6;
    const totalW = s.length * step - cellPx;
    const totalH = cellPx * 7;
    const x0 = cx - totalW * 0.5, y0 = cy - totalH * 0.5;
    for (let i = 0; i < s.length; i++) {
      const glyph = BITMAP_FONT[s[i]];
      if (!glyph) continue;
      const gx = x0 + i * step;
      for (let r = 0; r < 7; r++) {
        const row = glyph[r];
        for (let c = 0; c < 5; c++) {
          if (row[c] === '1') {
            fillRectAA(rgba, w, h, gx + c * cellPx, y0 + r * cellPx, gx + (c + 1) * cellPx, y0 + (r + 1) * cellPx, color, alpha);
          }
        }
      }
    }
  }

  // Полоса текста-заглушки для заголовков, легенд и штампов (несколько мелких слов).
  function drawTextBar(rgba, w, h, x0, y0, x1, barH, rnd, color) {
    let x = x0;
    while (x + barH * 1.4 < x1) {
      const wordW = Math.min(x1 - x, barH * rand(rnd, 1.8, 4.5));
      const chars = Math.max(2, Math.floor(wordW / (barH * 0.65)));
      const cw = wordW / chars;
      for (let i = 0; i < chars; i++) {
        const cx0 = x + i * cw + cw * 0.12;
        const cx1 = x + (i + 1) * cw - cw * 0.12;
        fillRectAA(rgba, w, h, cx0, y0, cx1, y0 + barH, color, 0.9);
      }
      x += wordW + barH * rand(rnd, 0.7, 1.3);
    }
  }

  // ---------- геометрия стен, проемов и помещений ----------

  function splitBar(a, b, openings) {
    const sorted = openings.slice().sort(function (u, v) { return u[0] - v[0]; });
    const segs = [];
    let cur = a;
    for (let i = 0; i < sorted.length; i++) {
      const oa = Math.max(a, sorted[i][0]), ob = Math.min(b, sorted[i][1]);
      if (oa > cur + 1e-6) segs.push([cur, oa]);
      if (ob > cur) cur = ob;
    }
    if (b > cur + 1e-6) segs.push([cur, b]);
    return segs;
  }

  function rectPoly(x0, y0, x1, y1) {
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  function polyAreaPx(poly) {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    }
    return Math.abs(s) * 0.5;
  }

  // Преобразует список стен (в метрах) в пиксельные прямоугольники и рисует сплошные или полые стены.
  function renderWalls(rgba, w, h, wallBars, ox, oy, scale, opts) {
    const color = opts.wallColor || [12, 12, 12];
    const paper = opts.paper || [255, 255, 255];
    const hollow = !!opts.hollow;
    const rects = [];
    for (let i = 0; i < wallBars.length; i++) {
      const b = wallBars[i];
      rects.push({
        x0: ox + b.x0 * scale,
        y0: oy + b.y0 * scale,
        x1: ox + b.x1 * scale,
        y1: oy + b.y1 * scale,
        horiz: (b.x1 - b.x0) >= (b.y1 - b.y0)
      });
    }
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      fillRectAA(rgba, w, h, r.x0, r.y0, r.x1, r.y1, color, 1);
    }
    if (!hollow) return rects;

    // Полые стены из двух параллельных тонких линий (стиль БТИ / техпаспорт).
    const lw = Math.max(1.2, Math.min(2.2, (opts.hollowLineM || 0.05) * scale));
    function findCovering(px, py, skipIdx) {
      for (let k = 0; k < rects.length; k++) {
        if (k === skipIdx) continue;
        const q = rects[k];
        if (px >= q.x0 - 0.5 && px <= q.x1 + 0.5 && py >= q.y0 - 0.5 && py <= q.y1 + 0.5) return q;
      }
      return null;
    }
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
      if (rw <= 2 * lw + 0.5 || rh <= 2 * lw + 0.5) continue;
      let cx0 = r.x0 + lw, cy0 = r.y0 + lw, cx1 = r.x1 - lw, cy1 = r.y1 - lw;
      if (r.horiz) {
        const my = (r.y0 + r.y1) * 0.5;
        const leftTouch = findCovering(r.x0 - 0.5, my, i);
        if (leftTouch) cx0 = Math.max(leftTouch.x0 + lw, r.x0 - lw);
        const rightTouch = findCovering(r.x1 + 0.5, my, i);
        if (rightTouch) cx1 = Math.min(rightTouch.x1 - lw, r.x1 + lw);
      } else {
        const mx = (r.x0 + r.x1) * 0.5;
        const topTouch = findCovering(mx, r.y0 - 0.5, i);
        if (topTouch) cy0 = Math.max(topTouch.y0 + lw, r.y0 - lw);
        const botTouch = findCovering(mx, r.y1 + 0.5, i);
        if (botTouch) cy1 = Math.min(botTouch.y1 - lw, r.y1 + lw);
      }
      if (cx1 > cx0 && cy1 > cy0) fillRectAA(rgba, w, h, cx0, cy0, cx1, cy1, paper, 1);
    }
    return rects;
  }

  // Рисует окна в проемах наружных стен как три тонкие параллельные линии.
  function renderWindows(rgba, w, h, windows, ox, oy, scale, lineColor) {
    const lw = Math.max(1.0, Math.min(1.6, 0.035 * scale));
    const col = lineColor || [25, 25, 25];
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      const x0 = ox + win.x0 * scale, y0 = oy + win.y0 * scale;
      const x1 = ox + win.x1 * scale, y1 = oy + win.y1 * scale;
      const fracs = [0.18, 0.5, 0.82];
      if (win.horiz) {
        for (let k = 0; k < 3; k++) {
          const y = y0 + (y1 - y0) * fracs[k];
          drawLineAA(rgba, w, h, x0, y, x1, y, lw, col, 1);
        }
      } else {
        for (let k = 0; k < 3; k++) {
          const x = x0 + (x1 - x0) * fracs[k];
          drawLineAA(rgba, w, h, x, y0, x, y1, lw, col, 1);
        }
      }
    }
  }

  // Рисует створки и четвертькруговые дуги открывания дверей.
  function renderDoorArcs(rgba, w, h, doors, ox, oy, scale, lineColor) {
    const lw = Math.max(1.0, Math.min(1.6, 0.035 * scale));
    const col = lineColor || [35, 35, 35];
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      const x0 = ox + d.x0 * scale, y0 = oy + d.y0 * scale;
      const x1 = ox + d.x1 * scale, y1 = oy + d.y1 * scale;
      if (d.horiz) {
        const span = x1 - x0;
        const sy = d.swingSign < 0 ? y0 : y1;
        const hx = d.hingeEnd === 0 ? x0 : x1;
        const ly = sy + d.swingSign * span;
        drawLineAA(rgba, w, h, hx, sy, hx, ly, lw, col, 1);
        let a0, a1;
        if (d.hingeEnd === 0 && d.swingSign < 0) { a0 = -Math.PI * 0.5; a1 = 0; }
        else if (d.hingeEnd === 0 && d.swingSign > 0) { a0 = 0; a1 = Math.PI * 0.5; }
        else if (d.hingeEnd === 1 && d.swingSign < 0) { a0 = Math.PI; a1 = Math.PI * 1.5; }
        else { a0 = Math.PI * 0.5; a1 = Math.PI; }
        drawArcAA(rgba, w, h, hx, sy, span, a0, a1, lw, col, 1);
      } else {
        const span = y1 - y0;
        const sx = d.swingSign < 0 ? x0 : x1;
        const hy = d.hingeEnd === 0 ? y0 : y1;
        const lx = sx + d.swingSign * span;
        drawLineAA(rgba, w, h, sx, hy, lx, hy, lw, col, 1);
        let a0, a1;
        if (d.hingeEnd === 0 && d.swingSign > 0) { a0 = 0; a1 = Math.PI * 0.5; }
        else if (d.hingeEnd === 0 && d.swingSign < 0) { a0 = Math.PI * 0.5; a1 = Math.PI; }
        else if (d.hingeEnd === 1 && d.swingSign > 0) { a0 = -Math.PI * 0.5; a1 = 0; }
        else { a0 = Math.PI; a1 = Math.PI * 1.5; }
        drawArcAA(rgba, w, h, sx, hy, span, a0, a1, lw, col, 1);
      }
    }
  }

  // ---------- типовые планировки зданий ----------

  // Здание с центральным коридором и двумя рядами кабинетов (в метрах от [0, 0]).
  function buildCorridorPlan(rnd, cfg) {
    const nTop = cfg.nTop || randInt(rnd, 3, 5);
    const nBot = cfg.nBot || randInt(rnd, 3, 5);
    const tOut = cfg.tOut || rand(rnd, 0.34, 0.48);
    const tIn = cfg.tIn || rand(rnd, 0.20, 0.26);
    const hTop = cfg.hTop || rand(rnd, 4.2, 5.4);
    const hCor = cfg.hCor || rand(rnd, 2.2, 2.8);
    const hBot = cfg.hBot || rand(rnd, 4.2, 5.4);
    const doorW = cfg.doorW || rand(rnd, 0.9, 1.0);
    const exitW = cfg.exitW || rand(rnd, 1.4, 1.7);

    function makeSplits(n, minW, maxW) {
      const ws = [];
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const w = rand(rnd, minW, maxW);
        ws.push(w);
        sum += w;
      }
      return { ws: ws, sum: sum };
    }

    const minRoomW = cfg.minRoomW || 3.4, maxRoomW = cfg.maxRoomW || 6.4;
    const sTop = makeSplits(nTop, minRoomW, maxRoomW);
    const W = cfg.W || Math.max(16, Math.round(sTop.sum * 2) / 2);
    const topXs = [0];
    let acc = 0;
    for (let i = 0; i < nTop - 1; i++) {
      acc += sTop.ws[i] / sTop.sum * W;
      topXs.push(round3(acc));
    }
    topXs.push(W);

    const sBot = makeSplits(nBot, minRoomW, maxRoomW);
    const botXs = [0];
    acc = 0;
    for (let i = 0; i < nBot - 1; i++) {
      acc += sBot.ws[i] / sBot.sum * W;
      botXs.push(round3(acc));
    }
    botXs.push(W);

    const yCorTop = round3(tOut + hTop + tIn * 0.5);
    const yCorBot = round3(yCorTop + tIn + hCor);
    const H = round3(yCorBot + tIn * 0.5 + hBot + tOut);

    const walls = [];
    const doors = [];
    const windows = [];
    const rooms = [];
    const topOpen = [];
    const botOpen = [];
    const outerTopOpen = [];
    const outerBotOpen = [];

    // Двери из верхнего ряда в коридор и окна наружу
    for (let i = 0; i < nTop; i++) {
      const rx0 = i === 0 ? tOut : topXs[i] + tIn * 0.5;
      const rx1 = i === nTop - 1 ? W - tOut : topXs[i + 1] - tIn * 0.5;
      const ry0 = tOut, ry1 = yCorTop - tIn * 0.5;
      const dc = rx0 + (rx1 - rx0) * rand(rnd, 0.38, 0.62);
      const da = clamp(dc - doorW * 0.5, rx0 + 0.35, rx1 - 0.35 - doorW);
      const db = da + doorW;
      topOpen.push([da, db]);
      doors.push({ x0: da, y0: yCorTop - tIn * 0.5, x1: db, y1: yCorTop + tIn * 0.5, horiz: true, swingSign: -1, hingeEnd: i % 2 });
      if (cfg.windows && (rx1 - rx0) > 2.2) {
        const ww = Math.min(3.2, (rx1 - rx0) * 0.62);
        const wc = (rx0 + rx1) * 0.5;
        outerTopOpen.push([wc - ww * 0.5, wc + ww * 0.5]);
        windows.push({ x0: wc - ww * 0.5, y0: 0, x1: wc + ww * 0.5, y1: tOut, horiz: true });
      }
      rooms.push({ name: 'Кабинет ' + (rooms.length + 1), x0: rx0, y0: ry0, x1: rx1, y1: ry1, kind: 'room' });
    }

    // Коридор
    const corY0 = yCorTop + tIn * 0.5, corY1 = yCorBot - tIn * 0.5;
    rooms.push({ name: 'Коридор', x0: tOut, y0: corY0, x1: W - tOut, y1: corY1, kind: 'corridor' });

    // Двери из нижнего ряда в коридор и окна наружу
    for (let i = 0; i < nBot; i++) {
      const rx0 = i === 0 ? tOut : botXs[i] + tIn * 0.5;
      const rx1 = i === nBot - 1 ? W - tOut : botXs[i + 1] - tIn * 0.5;
      const ry0 = yCorBot + tIn * 0.5, ry1 = H - tOut;
      const dc = rx0 + (rx1 - rx0) * rand(rnd, 0.38, 0.62);
      const da = clamp(dc - doorW * 0.5, rx0 + 0.35, rx1 - 0.35 - doorW);
      const db = da + doorW;
      botOpen.push([da, db]);
      doors.push({ x0: da, y0: yCorBot - tIn * 0.5, x1: db, y1: yCorBot + tIn * 0.5, horiz: true, swingSign: 1, hingeEnd: (i + 1) % 2 });
      if (cfg.windows && (rx1 - rx0) > 2.2) {
        const ww = Math.min(3.2, (rx1 - rx0) * 0.62);
        const wc = (rx0 + rx1) * 0.5;
        outerBotOpen.push([wc - ww * 0.5, wc + ww * 0.5]);
        windows.push({ x0: wc - ww * 0.5, y0: H - tOut, x1: wc + ww * 0.5, y1: H, horiz: true });
      }
      rooms.push({ name: 'Кабинет ' + rooms.length, x0: rx0, y0: ry0, x1: rx1, y1: ry1, kind: 'room' });
    }

    // Наружные стены (верх, низ, лево, право) с входами в торцах коридора
    const corMid = (corY0 + corY1) * 0.5;
    const leftOpen = [[corMid - exitW * 0.5, corMid + exitW * 0.5]];
    const rightOpen = cfg.twoExits !== false ? [[corMid - exitW * 0.5, corMid + exitW * 0.5]] : [];
    doors.push({ x0: 0, y0: leftOpen[0][0], x1: tOut, y1: leftOpen[0][1], horiz: false, swingSign: 1, hingeEnd: 0 });
    if (rightOpen.length) {
      doors.push({ x0: W - tOut, y0: rightOpen[0][0], x1: W, y1: rightOpen[0][1], horiz: false, swingSign: -1, hingeEnd: 1 });
    }

    splitBar(0, W, outerTopOpen).forEach(function (s) { walls.push({ x0: s[0], y0: 0, x1: s[1], y1: tOut }); });
    splitBar(0, W, outerBotOpen).forEach(function (s) { walls.push({ x0: s[0], y0: H - tOut, x1: s[1], y1: H }); });
    splitBar(tOut, H - tOut, leftOpen).forEach(function (s) { walls.push({ x0: 0, y0: s[0], x1: tOut, y1: s[1] }); });
    splitBar(tOut, H - tOut, rightOpen).forEach(function (s) { walls.push({ x0: W - tOut, y0: s[0], x1: W, y1: s[1] }); });

    // Стены коридора
    splitBar(tOut, W - tOut, topOpen).forEach(function (s) { walls.push({ x0: s[0], y0: yCorTop - tIn * 0.5, x1: s[1], y1: yCorTop + tIn * 0.5 }); });
    splitBar(tOut, W - tOut, botOpen).forEach(function (s) { walls.push({ x0: s[0], y0: yCorBot - tIn * 0.5, x1: s[1], y1: yCorBot + tIn * 0.5 }); });

    // Перегородки верхнего и нижнего ряда
    for (let i = 1; i < nTop; i++) {
      walls.push({ x0: topXs[i] - tIn * 0.5, y0: tOut, x1: topXs[i] + tIn * 0.5, y1: yCorTop - tIn * 0.5 });
    }
    for (let i = 1; i < nBot; i++) {
      walls.push({ x0: botXs[i] - tIn * 0.5, y0: yCorBot + tIn * 0.5, x1: botXs[i] + tIn * 0.5, y1: H - tOut });
    }

    return {
      W: W, H: H, tOut: tOut, tIn: tIn, yCorTop: yCorTop, yCorBot: yCorBot,
      topXs: topXs, botXs: botXs, walls: walls, doors: doors, windows: windows, rooms: rooms
    };
  }

  function roomsToPx(planRooms, ox, oy, scale) {
    return planRooms.map(function (r) {
      const area = round3((r.x1 - r.x0) * (r.y1 - r.y0));
      return {
        name: r.name,
        poly: rectPoly(
          round3(ox + r.x0 * scale),
          round3(oy + r.y0 * scale),
          round3(ox + r.x1 * scale),
          round3(oy + r.y1 * scale)
        ),
        area: area
      };
    });
  }

  // ---------- размерные линии с засечками (для hollow / БТИ) ----------

  function drawDimensionChain(rgba, w, h, axisCoords, offsetPx, horiz, lineW, color, scale) {
    const tick = Math.max(3, 0.16 * scale);
    const extStart = horiz ? (offsetPx < 0 ? offsetPx + tick * 2.5 : offsetPx - tick * 2.5) : (offsetPx < 0 ? offsetPx + tick * 2.5 : offsetPx - tick * 2.5);
    const a0 = axisCoords[0], a1 = axisCoords[axisCoords.length - 1];
    if (horiz) {
      drawLineAA(rgba, w, h, a0 - tick, offsetPx, a1 + tick, offsetPx, lineW, color, 1);
      for (let i = 0; i < axisCoords.length; i++) {
        const x = axisCoords[i];
        drawLineAA(rgba, w, h, x, extStart, x, offsetPx + (offsetPx < extStart ? -tick : tick), lineW, color, 0.9);
        drawLineAA(rgba, w, h, x - tick * 0.7, offsetPx + tick * 0.7, x + tick * 0.7, offsetPx - tick * 0.7, lineW * 1.2, color, 1);
        if (i + 1 < axisCoords.length) {
          const segM = (axisCoords[i + 1] - x) / scale;
          const label = String(Math.round(segM * 1000));
          const cell = Math.max(1.0, Math.min(1.6, 0.045 * scale));
          drawDigits(rgba, w, h, label, (x + axisCoords[i + 1]) * 0.5, offsetPx - cell * 6, cell, color, 1);
        }
      }
    } else {
      drawLineAA(rgba, w, h, offsetPx, a0 - tick, offsetPx, a1 + tick, lineW, color, 1);
      for (let i = 0; i < axisCoords.length; i++) {
        const y = axisCoords[i];
        drawLineAA(rgba, w, h, extStart, y, offsetPx + (offsetPx < extStart ? -tick : tick), y, lineW, color, 0.9);
        drawLineAA(rgba, w, h, offsetPx - tick * 0.7, y + tick * 0.7, offsetPx + tick * 0.7, y - tick * 0.7, lineW * 1.2, color, 1);
      }
    }
  }

  // ---------- проективное преобразование (для photo) ----------

  function homography(src4, dst4) {
    // Решает A * h = b (8x8) методом Гаусса с выбором главного элемента.
    const A = new Float64Array(64);
    const b = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
      const sx = src4[i][0], sy = src4[i][1], dx = dst4[i][0], dy = dst4[i][1];
      const r1 = (2 * i) * 8, r2 = (2 * i + 1) * 8;
      A[r1] = sx; A[r1 + 1] = sy; A[r1 + 2] = 1; A[r1 + 6] = -dx * sx; A[r1 + 7] = -dx * sy; b[2 * i] = dx;
      A[r2 + 3] = sx; A[r2 + 4] = sy; A[r2 + 5] = 1; A[r2 + 6] = -dy * sx; A[r2 + 7] = -dy * sy; b[2 * i + 1] = dy;
    }
    for (let col = 0; col < 8; col++) {
      let piv = col, best = Math.abs(A[col * 8 + col]);
      for (let row = col + 1; row < 8; row++) {
        const v = Math.abs(A[row * 8 + col]);
        if (v > best) { best = v; piv = row; }
      }
      if (piv !== col) {
        for (let k = col; k < 8; k++) {
          const tmp = A[col * 8 + k]; A[col * 8 + k] = A[piv * 8 + k]; A[piv * 8 + k] = tmp;
        }
        const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
      }
      const diag = A[col * 8 + col] || 1e-12;
      for (let row = col + 1; row < 8; row++) {
        const f = A[row * 8 + col] / diag;
        if (!f) continue;
        for (let k = col; k < 8; k++) A[row * 8 + k] -= f * A[col * 8 + k];
        b[row] -= f * b[col];
      }
    }
    const h = new Float64Array(9);
    for (let row = 7; row >= 0; row--) {
      let sum = b[row];
      for (let k = row + 1; k < 8; k++) sum -= A[row * 8 + k] * h[k];
      h[row] = sum / (A[row * 8 + row] || 1e-12);
    }
    h[8] = 1;
    return h;
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function sampleBilinear(src, sw, sh, x, y, out) {
    const cx = clamp(x - 0.5, 0, sw - 1.0001);
    const cy = clamp(y - 0.5, 0, sh - 1.0001);
    const ix = Math.floor(cx), iy = Math.floor(cy);
    const fx = cx - ix, fy = cy - iy;
    const ix1 = ix + 1 < sw ? ix + 1 : ix;
    const iy1 = iy + 1 < sh ? iy + 1 : iy;
    const o00 = (iy * sw + ix) * 4, o10 = (iy * sw + ix1) * 4;
    const o01 = (iy1 * sw + ix) * 4, o11 = (iy1 * sw + ix1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = src[o00] * w00 + src[o10] * w10 + src[o01] * w01 + src[o11] * w11;
    out[1] = src[o00 + 1] * w00 + src[o10 + 1] * w10 + src[o01 + 1] * w01 + src[o11 + 1] * w11;
    out[2] = src[o00 + 2] * w00 + src[o10 + 2] * w10 + src[o01 + 2] * w01 + src[o11 + 2] * w11;
  }

  // ---------- реализации всех 16 вариантов ----------

  function makeClean(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 18, 24);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.35, 0.50),
      tIn: rand(rnd, 0.20, 0.28)
    });
    const margin = rand(rnd, 2.5, 3.5);
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [10, 10, 10], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'clean', buildingM: [plan.W, plan.H] }
    };
  }

  function makeHollow(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 26, 32);
    const plan = buildCorridorPlan(rnd, {
      nTop: randInt(rnd, 3, 4),
      nBot: randInt(rnd, 3, 4),
      tOut: rand(rnd, 0.36, 0.44),
      tIn: rand(rnd, 0.18, 0.24),
      minRoomW: 3.4,
      maxRoomW: 5.2
    });
    const margin = 3.4;
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [252, 252, 250];
    const rgba = createCanvas(w, h, paper);
    const ink = [20, 20, 20];
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, {
      wallColor: ink, paper: paper, hollow: true, hollowLineM: 0.055
    });

    // Номера помещений и площади (только цифры и запятая) внутри каждого помещения
    const cell = Math.max(1.2, Math.min(2.0, 0.055 * scale));
    for (let i = 0; i < plan.rooms.length; i++) {
      const r = plan.rooms[i];
      const cx = ox + (r.x0 + r.x1) * 0.5 * scale;
      const cy = oy + (r.y0 + r.y1) * 0.5 * scale;
      const areaStr = ((r.x1 - r.x0) * (r.y1 - r.y0)).toFixed(1).replace('.', ',');
      drawDigits(rgba, w, h, String(i + 1), cx, cy - cell * 5.5, cell, ink, 1);
      drawDigits(rgba, w, h, areaStr, cx, cy + cell * 4.5, cell, [40, 40, 40], 1);
    }

    // Размерные линии с засечками снаружи здания
    const dimW = Math.max(1.0, 0.032 * scale);
    const topPx = plan.topXs.map(function (x) { return ox + x * scale; });
    const botPx = plan.botXs.map(function (x) { return ox + x * scale; });
    const vertPx = [oy, oy + plan.yCorTop * scale, oy + plan.yCorBot * scale, oy + plan.H * scale];
    drawDimensionChain(rgba, w, h, topPx, oy - 1.1 * scale, true, dimW, [45, 45, 45], scale);
    drawDimensionChain(rgba, w, h, [ox, ox + plan.W * scale], oy - 2.2 * scale, true, dimW, [45, 45, 45], scale);
    drawDimensionChain(rgba, w, h, botPx, oy + (plan.H + 1.1) * scale, true, dimW, [45, 45, 45], scale);
    drawDimensionChain(rgba, w, h, vertPx, ox - 1.1 * scale, false, dimW, [45, 45, 45], scale);

    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'hollow', buildingM: [plan.W, plan.H] }
    };
  }

  function makeDoorArcs(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 18, 25);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.34, 0.44),
      tIn: rand(rnd, 0.18, 0.24)
    });
    const margin = rand(rnd, 2.5, 3.2);
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    renderDoorArcs(rgba, w, h, plan.doors, ox, oy, scale, [30, 30, 30]);
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'door-arcs', buildingM: [plan.W, plan.H] }
    };
  }

  function makeWindows(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 18, 28);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.36, 0.46),
      tIn: rand(rnd, 0.20, 0.25),
      windows: true
    });
    const margin = rand(rnd, 2.5, 3.2);
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    renderWindows(rgba, w, h, plan.windows, ox, oy, scale, [25, 25, 25]);
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'windows', buildingM: [plan.W, plan.H], windows: plan.windows.length }
    };
  }

  function makeFurniture(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 28, 36);
    const W = round3(rand(rnd, 11.5, 13.5));
    const H = round3(rand(rnd, 8.8, 10.0));
    const tOut = 0.34, tIn = 0.14, doorW = 0.85;
    const yCorTop = round3(tOut + rand(rnd, 3.5, 3.9));
    const hCor = round3(rand(rnd, 1.4, 1.65));
    const yCorBot = round3(yCorTop + tIn + hCor);
    const xLiving = round3(W * rand(rnd, 0.50, 0.56));
    const xKitchen = round3(W * rand(rnd, 0.34, 0.40));
    const xBath = round3(xKitchen + rand(rnd, 2.1, 2.5));

    const walls = [];
    const doors = [];
    // Наружные стены и вход
    const entY0 = yCorTop + tIn * 0.5 + (hCor - 0.95) * 0.5, entY1 = entY0 + 0.95;
    walls.push({ x0: 0, y0: 0, x1: W, y1: tOut });
    walls.push({ x0: 0, y0: H - tOut, x1: W, y1: H });
    splitBar(tOut, H - tOut, [[entY0, entY1]]).forEach(function (s) { walls.push({ x0: 0, y0: s[0], x1: tOut, y1: s[1] }); });
    walls.push({ x0: W - tOut, y0: tOut, x1: W, y1: H - tOut });

    // Внутренние перегородки
    const topDoors = [
      [tOut + 1.8, tOut + 1.8 + doorW],
      [xLiving + 1.2, xLiving + 1.2 + doorW]
    ];
    const botDoors = [
      [tOut + 1.2, tOut + 1.2 + doorW],
      [xKitchen + 0.65, xKitchen + 0.65 + 0.75],
      [xBath + 1.1, xBath + 1.1 + doorW]
    ];
    splitBar(tOut, W - tOut, topDoors).forEach(function (s) { walls.push({ x0: s[0], y0: yCorTop - tIn * 0.5, x1: s[1], y1: yCorTop + tIn * 0.5 }); });
    splitBar(tOut, W - tOut, botDoors).forEach(function (s) { walls.push({ x0: s[0], y0: yCorBot - tIn * 0.5, x1: s[1], y1: yCorBot + tIn * 0.5 }); });
    walls.push({ x0: xLiving - tIn * 0.5, y0: tOut, x1: xLiving + tIn * 0.5, y1: yCorTop - tIn * 0.5 });
    walls.push({ x0: xKitchen - tIn * 0.5, y0: yCorBot + tIn * 0.5, x1: xKitchen + tIn * 0.5, y1: H - tOut });
    walls.push({ x0: xBath - tIn * 0.5, y0: yCorBot + tIn * 0.5, x1: xBath + tIn * 0.5, y1: H - tOut });

    doors.push({ x0: botDoors[1][0], y0: yCorBot - tIn * 0.5, x1: botDoors[1][1], y1: yCorBot + tIn * 0.5, horiz: true, swingSign: 1, hingeEnd: 0 });

    const rLiving = { name: 'Гостиная', x0: tOut, y0: tOut, x1: xLiving - tIn * 0.5, y1: yCorTop - tIn * 0.5 };
    const rBed1 = { name: 'Спальня 1', x0: xLiving + tIn * 0.5, y0: tOut, x1: W - tOut, y1: yCorTop - tIn * 0.5 };
    const rCor = { name: 'Коридор', x0: tOut, y0: yCorTop + tIn * 0.5, x1: W - tOut, y1: yCorBot - tIn * 0.5 };
    const rKitchen = { name: 'Кухня', x0: tOut, y0: yCorBot + tIn * 0.5, x1: xKitchen - tIn * 0.5, y1: H - tOut };
    const rBath = { name: 'Санузел', x0: xKitchen + tIn * 0.5, y0: yCorBot + tIn * 0.5, x1: xBath - tIn * 0.5, y1: H - tOut };
    const rBed2 = { name: 'Спальня 2', x0: xBath + tIn * 0.5, y0: yCorBot + tIn * 0.5, x1: W - tOut, y1: H - tOut };
    const planRooms = [rLiving, rBed1, rCor, rKitchen, rBath, rBed2];

    const margin = 2.0;
    const w = Math.round((W + 2 * margin) * scale);
    const h = Math.round((H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, walls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    renderDoorArcs(rgba, w, h, doors, ox, oy, scale, [35, 35, 35]);

    const fCol = [38, 38, 38];
    const lw = Math.max(1.1, Math.min(1.8, 0.038 * scale));
    function boxM(x0, y0, x1, y1) {
      strokeRectAA(rgba, w, h, ox + x0 * scale, oy + y0 * scale, ox + x1 * scale, oy + y1 * scale, lw, fCol, 1);
    }
    function lineM(x0, y0, x1, y1) {
      drawLineAA(rgba, w, h, ox + x0 * scale, oy + y0 * scale, ox + x1 * scale, oy + y1 * scale, lw, fCol, 1);
    }

    // Гостиная: диван у левой стены, журнальный столик и тумба у перегородки
    const sy0 = rLiving.y0 + 0.5, sy1 = Math.min(rLiving.y1 - 0.5, sy0 + 2.3);
    boxM(rLiving.x0, sy0, rLiving.x0 + 0.92, sy1);
    lineM(rLiving.x0 + 0.2, sy0, rLiving.x0 + 0.2, sy1);
    lineM(rLiving.x0 + 0.2, (sy0 + sy1) * 0.5, rLiving.x0 + 0.92, (sy0 + sy1) * 0.5);
    boxM(rLiving.x0 + 1.6, (sy0 + sy1) * 0.5 - 0.35, rLiving.x0 + 2.6, (sy0 + sy1) * 0.5 + 0.35);
    boxM(rLiving.x1 - 0.45, rLiving.y0 + 0.7, rLiving.x1, rLiving.y0 + 2.4);

    // Спальня 1: двуспальная кровать у верхней стены с подушками и шкаф в углу
    const bx0 = rBed1.x0 + 1.1;
    boxM(bx0, rBed1.y0, bx0 + 1.65, rBed1.y0 + 2.0);
    boxM(bx0 + 0.14, rBed1.y0 + 0.12, bx0 + 0.74, rBed1.y0 + 0.48);
    boxM(bx0 + 0.90, rBed1.y0 + 0.12, bx0 + 1.50, rBed1.y0 + 0.48);
    lineM(bx0, rBed1.y0 + 0.75, bx0 + 1.65, rBed1.y0 + 0.75);
    boxM(rBed1.x1 - 0.62, rBed1.y0, rBed1.x1, rBed1.y0 + 2.1);

    // Кухня: кухонный гарнитур вдоль всей нижней стены (от стены до стены), мойка, плита и стол
    const ky0 = rKitchen.y1 - 0.62;
    boxM(rKitchen.x0, ky0, rKitchen.x1, rKitchen.y1);
    boxM(rKitchen.x0 + 0.25, ky0 + 0.1, rKitchen.x0 + 0.95, rKitchen.y1 - 0.1);
    boxM(rKitchen.x1 - 0.9, ky0 + 0.08, rKitchen.x1 - 0.25, rKitchen.y1 - 0.08);
    const tx0 = rKitchen.x0 + 1.1, ty0 = rKitchen.y0 + 0.9;
    boxM(tx0, ty0, tx0 + 1.15, ty0 + 0.75);
    boxM(tx0 + 0.15, ty0 - 0.38, tx0 + 0.52, ty0 - 0.04);
    boxM(tx0 + 0.64, ty0 - 0.38, tx0 + 1.01, ty0 - 0.04);

    // Санузел: ванна от стены до стены, унитаз и раковина
    const tubY0 = rBath.y1 - 0.75;
    boxM(rBath.x0, tubY0, rBath.x1, rBath.y1);
    boxM(rBath.x0 + 0.08, tubY0 + 0.08, rBath.x1 - 0.08, rBath.y1 - 0.08);
    boxM(rBath.x1 - 0.62, rBath.y0 + 0.65, rBath.x1, rBath.y0 + 1.05);
    boxM(rBath.x0, rBath.y0 + 0.6, rBath.x0 + 0.48, rBath.y0 + 1.15);

    // Спальня 2: кровать у правой стены и письменный стол
    boxM(rBed2.x1 - 1.05, rBed2.y1 - 2.0, rBed2.x1, rBed2.y1);
    boxM(rBed2.x1 - 0.92, rBed2.y1 - 0.48, rBed2.x1 - 0.14, rBed2.y1 - 0.12);
    boxM(rBed2.x0 + 0.35, rBed2.y1 - 0.7, rBed2.x0 + 1.55, rBed2.y1);

    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(planRooms, ox, oy, scale),
      meta: { variant: 'furniture', buildingM: [W, H] }
    };
  }

  function makeToilets(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 24, 30);
    const tOut = 0.35, tIn = 0.14, tPart = 0.20;
    const hTop = round3(rand(rnd, 3.6, 4.4));
    const hCor = round3(rand(rnd, 1.8, 2.2));
    const nToilets = randInt(rnd, 3, 4);
    const toiletW = 0.85, toiletH = 1.20, toiletDoorW = 0.70;
    const hBot = round3(rand(rnd, 3.4, 4.2));

    // Верхний ряд: 3 обычных кабинета
    const nTop = 3;
    const wTopRooms = [rand(rnd, 3.8, 5.2), rand(rnd, 3.8, 5.2), rand(rnd, 3.8, 5.2)];
    const W = round3(tOut * 2 + wTopRooms[0] + wTopRooms[1] + wTopRooms[2] + tPart * 2);
    const yCorTop = round3(tOut + hTop + tPart * 0.5);
    const yCorBot = round3(yCorTop + tPart + hCor);
    const H = round3(yCorBot + tPart * 0.5 + hBot + tOut);

    const walls = [];
    const rooms = [];
    const topOpen = [];
    const botOpen = [];

    // Верхний ряд помещений
    let cx = tOut;
    for (let i = 0; i < nTop; i++) {
      const rx0 = cx, rx1 = i === nTop - 1 ? W - tOut : round3(cx + wTopRooms[i]);
      rooms.push({ name: 'Кабинет ' + (i + 1), x0: rx0, y0: tOut, x1: rx1, y1: yCorTop - tPart * 0.5 });
      const dc = (rx0 + rx1) * 0.5;
      topOpen.push([dc - 0.45, dc + 0.45]);
      if (i < nTop - 1) {
        walls.push({ x0: rx1, y0: tOut, x1: rx1 + tPart, y1: yCorTop - tPart * 0.5 });
      }
      cx = rx1 + tPart;
    }

    // Коридор
    rooms.push({ name: 'Коридор', x0: tOut, y0: yCorTop + tPart * 0.5, x1: W - tOut, y1: yCorBot - tPart * 0.5 });

    // Нижний ряд: блок маленьких туалетов 0.85 x 1.2 м с дверями 0.7 м у коридора, плюс обычные помещения
    const blockStart = tOut;
    const toiletY0 = yCorBot + tPart * 0.5;
    const toiletY1 = round3(toiletY0 + toiletH);
    let tx = blockStart;
    for (let i = 0; i < nToilets; i++) {
      const rx0 = tx, rx1 = round3(tx + toiletW);
      rooms.push({ name: 'Туалет ' + (i + 1), x0: rx0, y0: toiletY0, x1: rx1, y1: toiletY1 });
      const dc = (rx0 + rx1) * 0.5;
      botOpen.push([dc - toiletDoorW * 0.5, dc + toiletDoorW * 0.5]);
      if (i < nToilets - 1) {
        walls.push({ x0: rx1, y0: toiletY0, x1: rx1 + tIn, y1: toiletY1 });
      }
      tx = rx1 + tIn;
    }
    const blockEnd = round3(tx - tIn);
    // Задняя стена блока туалетов и правая стена блока
    walls.push({ x0: tOut, y0: toiletY1, x1: blockEnd + tPart, y1: toiletY1 + tPart });
    walls.push({ x0: blockEnd, y0: toiletY0, x1: blockEnd + tPart, y1: H - tOut });

    // Подсобка позади блока туалетов (вход из правого кабинета не делаем, делаем дверь с коридора через остаток снизу)
    // Помещение за туалетами: если оставить глухим без двери, vision.js все равно найдет; добавим дверь из соседнего кабинета
    const backY0 = round3(toiletY1 + tPart);
    const backDoorY = round3((backY0 + H - tOut) * 0.5);
    // Уберем лишний проем в стене blockEnd, пересоберем правую стену блока с дверью 0.85 м в подсобку
    walls.pop();
    splitBar(toiletY0, H - tOut, [[backDoorY - 0.42, backDoorY + 0.42]]).forEach(function (s) {
      walls.push({ x0: blockEnd, y0: s[0], x1: blockEnd + tPart, y1: s[1] });
    });
    rooms.push({ name: 'Подсобка', x0: tOut, y0: backY0, x1: blockEnd, y1: H - tOut });

    // Оставшаяся часть нижнего ряда: два обычных кабинета
    const remX0 = round3(blockEnd + tPart);
    const remMid = round3((remX0 + (W - tOut)) * 0.5);
    const rA = { name: 'Кабинет 4', x0: remX0, y0: toiletY0, x1: remMid - tPart * 0.5, y1: H - tOut };
    const rB = { name: 'Кабинет 5', x0: remMid + tPart * 0.5, y0: toiletY0, x1: W - tOut, y1: H - tOut };
    rooms.push(rA, rB);
    walls.push({ x0: remMid - tPart * 0.5, y0: toiletY0, x1: remMid + tPart * 0.5, y1: H - tOut });
    botOpen.push([(rA.x0 + rA.x1) * 0.5 - 0.45, (rA.x0 + rA.x1) * 0.5 + 0.45]);
    botOpen.push([(rB.x0 + rB.x1) * 0.5 - 0.45, (rB.x0 + rB.x1) * 0.5 + 0.45]);

    // Наружные стены и стены коридора
    const corMid = (yCorTop + yCorBot) * 0.5;
    walls.push({ x0: 0, y0: 0, x1: W, y1: tOut });
    walls.push({ x0: 0, y0: H - tOut, x1: W, y1: H });
    splitBar(tOut, H - tOut, [[corMid - 0.7, corMid + 0.7]]).forEach(function (s) { walls.push({ x0: 0, y0: s[0], x1: tOut, y1: s[1] }); });
    walls.push({ x0: W - tOut, y0: tOut, x1: W, y1: H - tOut });
    splitBar(tOut, W - tOut, topOpen).forEach(function (s) { walls.push({ x0: s[0], y0: yCorTop - tPart * 0.5, x1: s[1], y1: yCorTop + tPart * 0.5 }); });
    splitBar(tOut, W - tOut, botOpen).forEach(function (s) { walls.push({ x0: s[0], y0: yCorBot - tPart * 0.5, x1: s[1], y1: yCorBot + tPart * 0.5 }); });

    const margin = 2.4;
    const w = Math.round((W + 2 * margin) * scale);
    const h = Math.round((H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, walls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(rooms, ox, oy, scale),
      meta: { variant: 'toilets', buildingM: [W, H], toilets: nToilets }
    };
  }

  function makeOpenPlan(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 22, 28);
    const W = round3(rand(rnd, 15, 21));
    const H = round3(rand(rnd, 10, 14));
    const tOut = rand(rnd, 0.36, 0.46);
    const entW = 4.0;
    const entCx = W * rand(rnd, 0.35, 0.65);
    const entA = clamp(entCx - entW * 0.5, tOut + 1.5, W - tOut - 1.5 - entW);
    const entB = entA + entW;

    const walls = [];
    walls.push({ x0: 0, y0: 0, x1: W, y1: tOut });
    splitBar(0, W, [[entA, entB]]).forEach(function (s) { walls.push({ x0: s[0], y0: H - tOut, x1: s[1], y1: H }); });
    walls.push({ x0: 0, y0: tOut, x1: tOut, y1: H - tOut });
    walls.push({ x0: W - tOut, y0: tOut, x1: W, y1: H - tOut });

    // Колонна внутри зала
    const colS = rand(rnd, 0.6, 0.85);
    const colX = W * rand(rnd, 0.38, 0.62) - colS * 0.5;
    const colY = H * rand(rnd, 0.38, 0.62) - colS * 0.5;
    walls.push({ x0: colX, y0: colY, x1: colX + colS, y1: colY + colS });

    const rooms = [{ name: 'Торговый зал', x0: tOut, y0: tOut, x1: W - tOut, y1: H - tOut }];
    const margin = 3.0;
    const w = Math.round((W + 2 * margin) * scale);
    const h = Math.round((H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, walls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(rooms, ox, oy, scale),
      meta: { variant: 'open-plan', buildingM: [W, H], entranceM: entW }
    };
  }

  function makeStubs(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 20, 26);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.35, 0.45),
      tIn: rand(rnd, 0.20, 0.25)
    });
    // Контрфорсы и выступы стен наружу длиной 0.5-1.0 м
    const stubW = rand(rnd, 0.35, 0.48);
    const stepTop = rand(rnd, 2.2, 3.0);
    for (let x = 1.5; x < plan.W - 1.5; x += stepTop) {
      const len = rand(rnd, 0.55, 1.0);
      plan.walls.push({ x0: x - stubW * 0.5, y0: -len, x1: x + stubW * 0.5, y1: 0.05 });
    }
    const stepBot = rand(rnd, 2.2, 3.0);
    for (let x = 1.5; x < plan.W - 1.5; x += stepBot) {
      const len = rand(rnd, 0.55, 1.0);
      plan.walls.push({ x0: x - stubW * 0.5, y0: plan.H - 0.05, x1: x + stubW * 0.5, y1: plan.H + len });
    }
    // Выступы на боковых фасадах
    const sideLen = rand(rnd, 0.6, 0.95);
    plan.walls.push({ x0: -sideLen, y0: 1.5, x1: 0.05, y1: 1.5 + stubW });
    plan.walls.push({ x0: -sideLen, y0: plan.H - 1.5 - stubW, x1: 0.05, y1: plan.H - 1.5 });
    plan.walls.push({ x0: plan.W - 0.05, y0: 1.5, x1: plan.W + sideLen, y1: 1.5 + stubW });
    plan.walls.push({ x0: plan.W - 0.05, y0: plan.H - 1.5 - stubW, x1: plan.W + sideLen, y1: plan.H - 1.5 });

    const margin = 3.5;
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'stubs', buildingM: [plan.W, plan.H] }
    };
  }

  function makeGrayWalls(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 20, 26);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.34, 0.44),
      tIn: rand(rnd, 0.20, 0.26)
    });
    const margin = rand(rnd, 2.5, 3.2);
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paperV = randInt(rnd, 243, 248);
    const wallV = randInt(rnd, 186, 194);
    const paper = [paperV, paperV, paperV];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [wallV, wallV, wallV], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'gray-walls', wallGray: wallV, paperGray: paperV }
    };
  }

  function makeColoredWalls(rnd, opts, seedNum) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 20, 26);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.34, 0.46),
      tIn: rand(rnd, 0.20, 0.26)
    });
    const margin = rand(rnd, 2.5, 3.2);
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const palette = [
      { name: 'dark-red', rgb: [148, 32, 32] },
      { name: 'dark-brown', rgb: [118, 64, 30] },
      { name: 'dark-blue', rgb: [30, 64, 155] }
    ];
    const pick = palette[Math.abs(seedNum - 1) % palette.length];
    const paper = [252, 250, 246];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: pick.rgb, paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'colored-walls', wallColorName: pick.name, wallColor: pick.rgb }
    };
  }

  function makeEvacuation(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 18, 22);
    const plan = buildCorridorPlan(rnd, {
      nTop: randInt(rnd, 3, 4),
      nBot: randInt(rnd, 3, 4),
      tOut: rand(rnd, 0.34, 0.44),
      tIn: rand(rnd, 0.18, 0.24),
      minRoomW: 3.5,
      maxRoomW: 5.5
    });
    const leftPad = 2.6 * scale;
    const topTitle = 4.6 * scale;
    const rightLegend = 8.5 * scale;
    const botPad = 2.4 * scale;
    const w = Math.round(leftPad + plan.W * scale + rightLegend + 1.5 * scale);
    const h = Math.round(topTitle + plan.H * scale + botPad);
    const ox = leftPad, oy = topTitle;
    const paper = [252, 252, 248];
    const rgba = createCanvas(w, h, paper);

    // Рамка листа (отступ 2-4% от краев, чтобы моделировать реальный бланк)
    const fm = Math.round(Math.min(w, h) * rand(rnd, 0.025, 0.045));
    const frameW = Math.max(2, Math.round(0.10 * scale));
    strokeRectAA(rgba, w, h, fm, fm, w - fm, h - fm, frameW, [25, 25, 25], 1);

    // Блок заголовка сверху
    const titleY1 = fm + Math.round(2.4 * scale);
    drawLineAA(rgba, w, h, fm, titleY1, w - fm, titleY1, Math.max(1.5, frameW * 0.7), [35, 35, 35], 1);
    drawTextBar(rgba, w, h, fm + scale * 2, fm + scale * 0.55, w - fm - scale * 2, Math.max(6, 0.5 * scale), rnd, [25, 25, 25]);
    drawTextBar(rgba, w, h, fm + scale * 4, fm + scale * 1.4, w - fm - scale * 4, Math.max(4, 0.32 * scale), rnd, [65, 65, 65]);

    // Пастельные заливки помещений
    const pastels = [
      [250, 244, 212],
      [228, 244, 228],
      [226, 238, 250],
      [250, 234, 222],
      [240, 234, 248]
    ];
    for (let i = 0; i < plan.rooms.length; i++) {
      const r = plan.rooms[i];
      const fill = r.kind === 'corridor' ? [236, 248, 234] : pastels[i % pastels.length];
      fillRectAA(rgba, w, h, ox + r.x0 * scale, oy + r.y0 * scale, ox + r.x1 * scale, oy + r.y1 * scale, fill, 1);
    }

    // Стены здания
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [18, 18, 18], paper: paper });

    // Зеленые стрелки эвакуации вдоль коридора и из помещений
    const arrowCol = rnd() < 0.5 ? [0, 92, 30] : [0, 125, 42];
    const arrowW = Math.max(2.2, 0.14 * scale);
    const cor = plan.rooms.filter(function (r) { return r.kind === 'corridor'; })[0];
    const corY = oy + (cor.y0 + cor.y1) * 0.5 * scale;
    const midX = ox + plan.W * 0.5 * scale;
    const leftX = ox + 0.6 * scale, rightX = ox + (plan.W - 0.6) * scale;
    drawLineAA(rgba, w, h, midX - 0.5 * scale, corY, leftX + 0.7 * scale, corY, arrowW, arrowCol, 1);
    drawTriangleAA(rgba, w, h, [leftX, corY], [leftX + 0.85 * scale, corY - 0.42 * scale], [leftX + 0.85 * scale, corY + 0.42 * scale], arrowCol, 1);
    drawLineAA(rgba, w, h, midX + 0.5 * scale, corY, rightX - 0.7 * scale, corY, arrowW, arrowCol, 1);
    drawTriangleAA(rgba, w, h, [rightX, corY], [rightX - 0.85 * scale, corY - 0.42 * scale], [rightX - 0.85 * scale, corY + 0.42 * scale], arrowCol, 1);

    // Красные квадратные пожарные знаки (огнетушитель / кран)
    const signCol = [200, 26, 26];
    const signHalf = Math.max(5, 0.36 * scale);
    for (let i = 0; i < plan.rooms.length; i++) {
      const r = plan.rooms[i];
      if (r.kind === 'corridor' || i % 2 === 1) continue;
      const sx = ox + (r.x0 + 0.8) * scale;
      const sy = oy + (r.y0 + 0.8) * scale;
      fillRectAA(rgba, w, h, sx - signHalf, sy - signHalf, sx + signHalf, sy + signHalf, signCol, 1);
      fillRectAA(rgba, w, h, sx - signHalf * 0.3, sy - signHalf * 0.45, sx + signHalf * 0.3, sy + signHalf * 0.45, [255, 255, 255], 1);
    }

    // Точка "Вы находитесь здесь"
    const youX = ox + plan.W * rand(rnd, 0.35, 0.65) * scale;
    drawCircleAA(rgba, w, h, youX, corY, Math.max(5, 0.34 * scale), [20, 75, 195], 1);
    drawCircleAA(rgba, w, h, youX, corY, Math.max(2, 0.13 * scale), [255, 255, 255], 1);

    // Таблица условных обозначений (легенда) с ячейками справа
    const legX0 = Math.round(ox + (plan.W + 1.0) * scale);
    const legX1 = w - fm - Math.round(0.6 * scale);
    const legY0 = titleY1 + Math.round(0.8 * scale);
    const rows = 6;
    const rowH = Math.round(Math.min((h - fm - legY0 - 0.8 * scale) / rows, 1.9 * scale));
    const legY1 = legY0 + rows * rowH;
    const colSplit = legX0 + Math.round((legX1 - legX0) * 0.30);
    const gridW = Math.max(1.2, 0.06 * scale);
    strokeRectAA(rgba, w, h, legX0, legY0, legX1, legY1, gridW, [35, 35, 35], 1);
    drawLineAA(rgba, w, h, colSplit, legY0 + rowH, colSplit, legY1, gridW, [35, 35, 35], 1);
    for (let r = 1; r < rows; r++) {
      const y = legY0 + r * rowH;
      drawLineAA(rgba, w, h, legX0, y, legX1, y, gridW, [35, 35, 35], 1);
    }
    drawTextBar(rgba, w, h, legX0 + 8, legY0 + rowH * 0.32, legX1 - 8, Math.max(4, rowH * 0.34), rnd, [30, 30, 30]);
    for (let r = 1; r < rows; r++) {
      const yc = legY0 + (r + 0.5) * rowH;
      const xc = (legX0 + colSplit) * 0.5;
      if (r === 1) {
        drawLineAA(rgba, w, h, xc - 10, yc, xc + 6, yc, 2.5, arrowCol, 1);
        drawTriangleAA(rgba, w, h, [xc + 11, yc], [xc + 4, yc - 5], [xc + 4, yc + 5], arrowCol, 1);
      } else if (r === 2) {
        fillRectAA(rgba, w, h, xc - 7, yc - 7, xc + 7, yc + 7, signCol, 1);
      } else if (r === 3) {
        drawCircleAA(rgba, w, h, xc, yc, 6, [20, 75, 195], 1);
      } else {
        strokeRectAA(rgba, w, h, xc - 8, yc - 5, xc + 8, yc + 5, 1.5, [40, 40, 40], 1);
      }
      drawTextBar(rgba, w, h, colSplit + 6, yc - rowH * 0.16, legX1 - 6, Math.max(3, rowH * 0.28), rnd, [55, 55, 55]);
    }

    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'evacuation', buildingM: [plan.W, plan.H] }
    };
  }

  function makeSheet(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 18, 22);
    const plan = buildCorridorPlan(rnd, {
      nTop: randInt(rnd, 3, 4),
      nBot: randInt(rnd, 3, 4),
      tOut: rand(rnd, 0.34, 0.44),
      tIn: rand(rnd, 0.20, 0.26),
      minRoomW: 3.4,
      maxRoomW: 5.5
    });
    const padL = 4.2 * scale, padR = 4.0 * scale, padT = 3.0 * scale, padB = 6.2 * scale;
    const w = Math.round(plan.W * scale + padL + padR);
    const h = Math.round(plan.H * scale + padT + padB);
    const ox = padL, oy = padT;
    const paper = [252, 252, 250];
    const rgba = createCanvas(w, h, paper);

    // Рамка чертежного листа по ГОСТ (слева поле подшивки больше)
    const fmLeft = Math.round(w * rand(rnd, 0.045, 0.065));
    const fmOther = Math.round(Math.min(w, h) * rand(rnd, 0.025, 0.042));
    const frameW = Math.max(2, Math.round(0.10 * scale));
    strokeRectAA(rgba, w, h, fmLeft, fmOther, w - fmOther, h - fmOther, frameW, [20, 20, 20], 1);

    // Здание в рабочем поле листа
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [14, 14, 14], paper: paper });

    // Штамп (основная надпись) в правом нижнем углу, примыкает к рамке
    const stW = Math.round((w - fmLeft - fmOther) * 0.38);
    const stH = Math.round((h - 2 * fmOther) * 0.20);
    const sx1 = w - fmOther, sy1 = h - fmOther;
    const sx0 = sx1 - stW, sy0 = sy1 - stH;
    const lw = Math.max(1.2, frameW * 0.65);
    strokeRectAA(rgba, w, h, sx0, sy0, sx1, sy1, frameW * 0.85, [20, 20, 20], 1);

    // Сетка штампа: 4 строки и вертикальные перегородки
    const nRows = 4;
    for (let r = 1; r < nRows; r++) {
      const y = sy0 + Math.round(stH * r / nRows);
      drawLineAA(rgba, w, h, sx0, y, sx1, y, lw, [25, 25, 25], 1);
    }
    const cols = [0.18, 0.38, 0.72, 0.86];
    for (let c = 0; c < cols.length; c++) {
      const x = sx0 + Math.round(stW * cols[c]);
      const yStart = c >= 2 ? sy0 + Math.round(stH * 0.25) : sy0;
      drawLineAA(rgba, w, h, x, yStart, x, sy1, lw, [25, 25, 25], 1);
    }
    // Мелкие надписи в ячейках штампа
    for (let r = 0; r < nRows; r++) {
      const y = sy0 + Math.round(stH * (r + 0.35) / nRows);
      drawTextBar(rgba, w, h, sx0 + 6, y, sx0 + stW * 0.35, Math.max(3, stH * 0.08), rnd, [50, 50, 50]);
      drawTextBar(rgba, w, h, sx0 + stW * 0.42, y, sx0 + stW * 0.69, Math.max(3, stH * 0.08), rnd, [40, 40, 40]);
    }

    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'sheet', buildingM: [plan.W, plan.H] }
    };
  }

  function makeLowres(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 4.1, 5.8);
    const plan = buildCorridorPlan(rnd, {
      nTop: randInt(rnd, 4, 6),
      nBot: randInt(rnd, 4, 6),
      tOut: rand(rnd, 0.30, 0.42),
      tIn: rand(rnd, 0.14, 0.20),
      hTop: rand(rnd, 3.8, 5.0),
      hCor: rand(rnd, 2.0, 2.5),
      hBot: rand(rnd, 3.8, 5.0),
      minRoomW: 3.2,
      maxRoomW: 5.5,
      doorW: 0.95,
      exitW: 1.5
    });
    const margin = 4.0;
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [10, 10, 10], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'lowres', buildingM: [plan.W, plan.H] }
    };
  }

  function makeTight(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 20, 26);
    const plan = buildCorridorPlan(rnd, {
      tOut: rand(rnd, 0.32, 0.44),
      tIn: rand(rnd, 0.20, 0.26)
    });
    const margin = 0.2; // ровно 0.2 м вокруг наружных стен
    const w = Math.round((plan.W + 2 * margin) * scale);
    const h = Math.round((plan.H + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, plan.walls, ox, oy, scale, { wallColor: [10, 10, 10], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(plan.rooms, ox, oy, scale),
      meta: { variant: 'tight', marginM: margin, buildingM: [plan.W, plan.H] }
    };
  }

  function makeTwoBuildings(rnd, opts) {
    const scale = (opts && opts.scale > 0) ? opts.scale : rand(rnd, 16, 20);
    const main = buildCorridorPlan(rnd, {
      nTop: randInt(rnd, 4, 5),
      nBot: randInt(rnd, 4, 5),
      tOut: rand(rnd, 0.38, 0.48),
      tIn: rand(rnd, 0.22, 0.28),
      minRoomW: 3.8,
      maxRoomW: 5.4,
      twoExits: false
    });

    // Небольшая пристройка рядом на том же листе (меньше 20% площади стен основного здания)
    const gap = rand(rnd, 3.5, 4.8);
    const aW = round3(rand(rnd, 5.0, 6.2));
    const aH = round3(rand(rnd, 3.8, 4.8));
    const aT = 0.22, aIn = 0.14;
    const axOff = round3(main.W + gap);
    const ayOff = round3((main.H - aH) * rand(rnd, 0.2, 0.8));
    const aSplit = round3(aW * rand(rnd, 0.46, 0.54));

    const annexWalls = [];
    // Наружные стены пристройки и вход 1.0 м слева
    const entY = aH * 0.5;
    annexWalls.push({ x0: 0, y0: 0, x1: aW, y1: aT });
    annexWalls.push({ x0: 0, y0: aH - aT, x1: aW, y1: aH });
    splitBar(aT, aH - aT, [[entY - 0.5, entY + 0.5]]).forEach(function (s) { annexWalls.push({ x0: 0, y0: s[0], x1: aT, y1: s[1] }); });
    annexWalls.push({ x0: aW - aT, y0: aT, x1: aW, y1: aH - aT });
    // Внутренняя перегородка пристройки с дверью 0.85 м
    splitBar(aT, aH - aT, [[entY - 0.42, entY + 0.42]]).forEach(function (s) {
      annexWalls.push({ x0: aSplit - aIn * 0.5, y0: s[0], x1: aSplit + aIn * 0.5, y1: s[1] });
    });

    const allWalls = main.walls.slice();
    for (let i = 0; i < annexWalls.length; i++) {
      const aw = annexWalls[i];
      allWalls.push({ x0: axOff + aw.x0, y0: ayOff + aw.y0, x1: axOff + aw.x1, y1: ayOff + aw.y1 });
    }
    const allRooms = main.rooms.slice();
    allRooms.push({ name: 'Пристройка 1', x0: axOff + aT, y0: ayOff + aT, x1: axOff + aSplit - aIn * 0.5, y1: ayOff + aH - aT });
    allRooms.push({ name: 'Пристройка 2', x0: axOff + aSplit + aIn * 0.5, y0: ayOff + aT, x1: axOff + aW - aT, y1: ayOff + aH - aT });

    const totalW = axOff + aW;
    const totalH = Math.max(main.H, ayOff + aH);
    const margin = 2.8;
    const w = Math.round((totalW + 2 * margin) * scale);
    const h = Math.round((totalH + 2 * margin) * scale);
    const ox = margin * scale, oy = margin * scale;
    const paper = [255, 255, 255];
    const rgba = createCanvas(w, h, paper);
    renderWalls(rgba, w, h, allWalls, ox, oy, scale, { wallColor: [12, 12, 12], paper: paper });
    return {
      rgba: rgba, w: w, h: h, scale: round3(scale),
      rooms: roomsToPx(allRooms, ox, oy, scale),
      meta: { variant: 'two-buildings', mainRooms: main.rooms.length, annexRooms: 2 }
    };
  }

  function makePhoto(rnd, opts, seedNum) {
    const basePool = ['evacuation', 'clean', 'sheet', 'door-arcs', 'hollow', 'furniture'];
    const baseVariant = (opts && opts.baseVariant) || basePool[Math.abs(seedNum - 1) % basePool.length];
    const base = make(baseVariant, seedNum * 17 + 3, { scale: (opts && opts.baseScale) || undefined });
    const sw = base.w, sh = base.h;

    // 3D-поворот листа с наклоном до 30 градусов
    const maxTilt = (opts && opts.tiltDeg > 0) ? Math.min(30, opts.tiltDeg) : rand(rnd, 16, 28);
    const tiltRad = maxTilt * Math.PI / 180;
    const az = rand(rnd, 0, Math.PI * 2);
    const rx = Math.sin(az) * tiltRad;
    const ry = Math.cos(az) * tiltRad;
    const rz = rand(rnd, -3.5, 3.5) * Math.PI / 180;

    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const F = 1.65 * Math.hypot(sw, sh);

    function projectCorner(x, y) {
      let X = x - sw * 0.5, Y = y - sh * 0.5, Z = 0;
      // Rz
      const x1 = X * cz - Y * sz, y1 = X * sz + Y * cz;
      X = x1; Y = y1;
      // Rx
      const y2 = Y * cx - Z * sx, z2 = Y * sx + Z * cx;
      Y = y2; Z = z2;
      // Ry
      const x3 = X * cy + Z * sy, z3 = -X * sy + Z * cy;
      X = x3; Z = z3;
      const denom = F + Z;
      return [F * X / denom, F * Y / denom];
    }

    const src4 = [[0, 0], [sw, 0], [sw, sh], [0, sh]];
    const proj = src4.map(function (p) { return projectCorner(p[0], p[1]); });
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < 4; i++) {
      if (proj[i][0] < minX) minX = proj[i][0];
      if (proj[i][0] > maxX) maxX = proj[i][0];
      if (proj[i][1] < minY) minY = proj[i][1];
      if (proj[i][1] > maxY) maxY = proj[i][1];
    }
    const pw = maxX - minX, ph = maxY - minY;
    const targetLong = Math.min(920, Math.max(680, Math.round(Math.max(sw, sh) * 1.05)));
    const sheetShare = 0.78;
    const fit = (targetLong * sheetShare) / Math.max(pw, ph);
    const outW = Math.max(320, Math.round(pw * fit / sheetShare));
    const outH = Math.max(240, Math.round(ph * fit / sheetShare));
    const offX = (outW - pw * fit) * 0.5 - minX * fit;
    const offY = (outH - ph * fit) * 0.5 - minY * fit;

    const dst4 = proj.map(function (p) { return [round3(p[0] * fit + offX), round3(p[1] * fit + offY)]; });
    const Hfwd = homography(src4, dst4);
    const Hinv = homography(dst4, src4);

    // Параметры освещения: теплый оттенок бумаги (~240, 220, 170), тень до 4:1, блик и шум
    const warmR = rand(rnd, 236, 245) / 255;
    const warmG = rand(rnd, 215, 225) / 255;
    const warmB = rand(rnd, 165, 178) / 255;
    const shadowAngle = rand(rnd, 0, Math.PI * 2);
    const shDx = Math.cos(shadowAngle), shDy = Math.sin(shadowAngle);
    const shadowRatio = rand(rnd, 2.8, 3.9); // до 4:1
    const darkMin = 1 / shadowRatio;
    const glareX = outW * rand(rnd, 0.30, 0.70);
    const glareY = outH * rand(rnd, 0.30, 0.70);
    const glareRx = outW * rand(rnd, 0.11, 0.18);
    const glareRy = outH * rand(rnd, 0.10, 0.16);
    const glarePeak = rand(rnd, 0.65, 0.85);
    const bgBase = [rand(rnd, 125, 155), rand(rnd, 118, 145), rand(rnd, 108, 132)];
    const noiseAmp = rand(rnd, 9, 14);

    const rgba = new Uint8ClampedArray(outW * outH * 4);
    const tmp = [0, 0, 0];
    const subOff = [-0.25, 0.25];
    // Диапазон проекции направления тени на углы кадра
    let sMin = 1e9, sMax = -1e9;
    [[0, 0], [outW, 0], [outW, outH], [0, outH]].forEach(function (c) {
      const v = c[0] * shDx + c[1] * shDy;
      if (v < sMin) sMin = v;
      if (v > sMax) sMax = v;
    });
    const sSpan = (sMax - sMin) || 1;

    for (let y = 0; y < outH; y++) {
      const row = y * outW;
      for (let x = 0; x < outW; x++) {
        // 2x2 суперсэмплинг в исходном листе для сохранения тонких линий при сжатии
        let sr = 0, sg = 0, sb = 0, hits = 0;
        for (let sy = 0; sy < 2; sy++) {
          const py = y + 0.5 + subOff[sy];
          for (let sx = 0; sx < 2; sx++) {
            const px = x + 0.5 + subOff[sx];
            const denom = Hinv[6] * px + Hinv[7] * py + Hinv[8];
            const u = (Hinv[0] * px + Hinv[1] * py + Hinv[2]) / denom;
            const v = (Hinv[3] * px + Hinv[4] * py + Hinv[5]) / denom;
            if (u >= 0 && u < sw && v >= 0 && v < sh) {
              sampleBilinear(base.rgba, sw, sh, u, v, tmp);
              sr += tmp[0]; sg += tmp[1]; sb += tmp[2];
              hits += 1;
            }
          }
        }
        // Текстурированный фон вокруг листа (стена или стол)
        const wave = 8 * Math.sin(x * 0.045 + y * 0.015) + 5 * Math.cos(y * 0.06);
        const br = bgBase[0] + wave, bg = bgBase[1] + wave, bb = bgBase[2] + wave;
        let r, g, b;
        if (hits === 4) {
          r = sr * 0.25; g = sg * 0.25; b = sb * 0.25;
        } else if (hits === 0) {
          r = br; g = bg; b = bb;
        } else {
          const k = hits * 0.25, inv = 1 - k;
          r = (sr / hits) * k + br * inv;
          g = (sg / hits) * k + bg * inv;
          b = (sb / hits) * k + bb * inv;
        }

        // Теплый свет и градиент тени
        const tSh = ((x * shDx + y * shDy) - sMin) / sSpan;
        const light = darkMin + (1 - darkMin) * tSh;
        r = r * warmR * light;
        g = g * warmG * light;
        b = b * warmB * light;

        // Блик от лампы / стекла
        const gx = (x - glareX) / glareRx, gy = (y - glareY) / glareRy;
        const gd2 = gx * gx + gy * gy;
        if (gd2 < 9) {
          const gl = glarePeak * Math.exp(-0.5 * gd2);
          r = r * (1 - gl) + 252 * gl;
          g = g * (1 - gl) + 248 * gl;
          b = b * (1 - gl) + 238 * gl;
        }

        // Шум матрицы
        const n1 = (rnd() + rnd() - 1) * noiseAmp;
        const n2 = (rnd() + rnd() - 1) * noiseAmp * 0.5;
        const o = (row + x) * 4;
        rgba[o] = r + n1;
        rgba[o + 1] = g + n1 + n2 * 0.5;
        rgba[o + 2] = b + n1 - n2 * 0.5;
        rgba[o + 3] = 255;
      }
    }

    // Применяем то же проективное преобразование к эталонным полигонам; площади в м2 неизменны
    let warpedPx = 0, totalArea = 0;
    const rooms = base.rooms.map(function (room) {
      const poly = room.poly.map(function (p) {
        const q = applyH(Hfwd, p[0], p[1]);
        return [round3(q[0]), round3(q[1])];
      });
      warpedPx += polyAreaPx(poly);
      totalArea += room.area;
      return { name: room.name, poly: poly, area: room.area };
    });
    const effScale = totalArea > 0 ? Math.sqrt(warpedPx / totalArea) : base.scale * fit;

    return {
      rgba: rgba, w: outW, h: outH, scale: round3(effScale),
      rooms: rooms,
      meta: {
        variant: 'photo',
        baseVariant: baseVariant,
        tiltDeg: round3(maxTilt),
        shadowRatio: round3(shadowRatio),
        quad: dst4,
        H: Array.prototype.slice.call(Hfwd)
      }
    };
  }

  // ---------- точка входа ----------

  function make(variant, seed, opts) {
    const seedNum = (typeof seed === 'number' && isFinite(seed)) ? Math.floor(seed) : 1;
    const rnd = mulberry32(hashSeed(String(variant), seedNum));
    let out;
    if (variant === 'clean') out = makeClean(rnd, opts);
    else if (variant === 'hollow') out = makeHollow(rnd, opts);
    else if (variant === 'door-arcs') out = makeDoorArcs(rnd, opts);
    else if (variant === 'windows') out = makeWindows(rnd, opts);
    else if (variant === 'furniture') out = makeFurniture(rnd, opts);
    else if (variant === 'toilets') out = makeToilets(rnd, opts);
    else if (variant === 'open-plan') out = makeOpenPlan(rnd, opts);
    else if (variant === 'stubs') out = makeStubs(rnd, opts);
    else if (variant === 'gray-walls') out = makeGrayWalls(rnd, opts);
    else if (variant === 'colored-walls') out = makeColoredWalls(rnd, opts, seedNum);
    else if (variant === 'evacuation') out = makeEvacuation(rnd, opts);
    else if (variant === 'sheet') out = makeSheet(rnd, opts);
    else if (variant === 'photo') out = makePhoto(rnd, opts, seedNum);
    else if (variant === 'lowres') out = makeLowres(rnd, opts);
    else if (variant === 'tight') out = makeTight(rnd, opts);
    else if (variant === 'two-buildings') out = makeTwoBuildings(rnd, opts);
    else throw new Error('Неизвестный вариант синтетического плана: ' + variant);

    out.meta = Object.assign({ seed: seedNum, totalArea: round3(out.rooms.reduce(function (s, r) { return s + r.area; }, 0)) }, out.meta);
    return out;
  }

  return {
    VARIANTS: VARIANTS.slice(),
    make: make,
    _homography: homography,
    _applyH: applyH
  };
}));
