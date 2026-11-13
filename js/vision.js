/*
 * План этажа → помещения и их площади. Чистые функции над пикселями (RGBA) без DOM:
 * работают в браузере в фоновом потоке (js/vision.worker.js), в Node (тесты)
 * и без сети — ничего никуда не отправляется.
 *
 * Как устроено:
 *   1. Стены и надписи — тёмные бесцветные пиксели. Цветное (зелёные стрелки
 *      эвакуации, красные знаки) стенами не считается. Порог учитывает среднюю
 *      яркость вокруг точки, поэтому читается и фото с неровным светом.
 *   2. Мелкие тёмные пятна — буквы, цифры, значки — убираются.
 *   3. Для каждой свободной точки — расстояние до ближайшей стены. Где проход уже
 *      дверного проёма, помещения разделяются: «ядро» помещения — точки дальше
 *      половины ширины двери от стен. Ядра разрастаются до стен — так находится
 *      вся площадь помещения.
 *   4. Улица — то, что соединено с краем картинки проходом шире входа в здание.
 *
 * Масштаб (точек на метр) задаёт пользователь: длиной известной стены или общей
 * площадью этажа (scaleFromArea). Без масштаба размеры дверей берутся от размера
 * картинки, площади — в точках.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FireVision = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    doorM: 1.2,     // проём уже этого разделяет помещения, м
    outM: 1.5,      // вход уже 2 × outM не соединяет здание с улицей, м
    minRoomM2: 1    // меньше — не помещение (ниша, шахта, толщина стены)
  };
  const INF = 1e20;

  function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

  // ---------- 1. стены и надписи ----------

  function inkMask(rgba, w, h) {
    const n = w * h, lum = new Uint8Array(n), colored = new Uint8Array(n), hist = new Float64Array(256);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const l = (r * 299 + g * 587 + b * 114) / 1000 | 0;
      lum[i] = l;
      hist[l] += 1;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx - mn > 60) colored[i] = 1;
    }
    // общий порог по Оцу: для толстых сплошных стен, внутри которых «местный» порог не срабатывает
    let total = 0;
    for (let t = 0; t < 256; t++) total += t * hist[t];
    let sumB = 0, wB = 0, best = -1, otsu = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (total - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; otsu = t; }
    }
    const tg = Math.min(otsu, 110);
    // местный порог: темнее средней яркости окрестности
    const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += lum[y * w + x];
        I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row;
      }
    }
    const half = Math.max(7, Math.round(Math.max(w, h) / 80));
    const ink = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const y0 = y - half < 0 ? 0 : y - half, y1 = y + half >= h ? h - 1 : y + half;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, l = lum[i];
        if (colored[i] && l > 60) continue;
        if (l < tg) { ink[i] = 1; continue; }
        if (l >= 160) continue;
        const x0 = x - half < 0 ? 0 : x - half, x1 = x + half >= w ? w - 1 : x + half;
        const s = I[(y1 + 1) * W1 + x1 + 1] - I[y0 * W1 + x1 + 1] - I[(y1 + 1) * W1 + x0] + I[y0 * W1 + x0];
        if (l < 0.78 * s / ((x1 - x0 + 1) * (y1 - y0 + 1))) ink[i] = 1;
      }
    }
    return ink;
  }

  // ---------- связные области ----------

  // Метки 1..count для точек mask[i] === 1; info[k] — число точек и рамка области.
  function components(mask, w, h, conn8) {
    const n = w * h, labels = new Int32Array(n), stack = new Int32Array(n), info = [null];
    let count = 0;
    for (let s = 0; s < n; s++) {
      if (!mask[s] || labels[s]) continue;
      count += 1;
      let top = 0, k = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      stack[top++] = s;
      labels[s] = count;
      while (top) {
        const i = stack[--top], x = i % w, y = (i - x) / w;
        k += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if ((!dx && !dy) || (!conn8 && dx && dy)) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (mask[j] && !labels[j]) { labels[j] = count; stack[top++] = j; }
          }
        }
      }
      info.push({ n: k, x0: x0, y0: y0, x1: x1, y1: y1 });
    }
    return { labels: labels, count: count, info: info };
  }

  // Убирает тёмные пятна меньше minLen точек по большей стороне: буквы, цифры, значки.
  function removeSmall(mask, w, h, minLen) {
    const c = components(mask, w, h, true), drop = new Uint8Array(c.count + 1);
    for (let k = 1; k <= c.count; k++) {
      const f = c.info[k];
      if (Math.max(f.x1 - f.x0, f.y1 - f.y0) + 1 < minLen) drop[k] = 1;
    }
    for (let i = 0; i < mask.length; i++) if (mask[i] && drop[c.labels[i]]) mask[i] = 0;
  }

  // ---------- расстояния ----------

  // Квадрат расстояния до ближайшей точки src[i] === 1 (точное, за линейное время).
  function edt(src, w, h) {
    const n = w * h, d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = src[i] ? 0 : INF;
    const m = Math.max(w, h), f = new Float64Array(m), out = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = d[y * w + x];
      edt1(f, h, out, v, z);
      for (let y = 0; y < h; y++) d[y * w + x] = out[y];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) f[x] = d[o + x];
      edt1(f, w, out, v, z);
      for (let x = 0; x < w; x++) d[o + x] = out[x];
    }
    return d;
  }

  function edt1(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k] && k > 0) {
        k -= 1;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k += 1;
      const t = q - v[k];
      d[q] = t * t + f[v[k]];
    }
  }

  // ---------- контур помещения ----------

  const DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1]; // по часовой, начиная с запада
  function dirOf(dx, dy) { for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d; return 0; }

  // Обход границы области L (окрестность Мура). start — первая точка области при
  // построчном просмотре: слева и сверху от неё области нет.
  function trace(label, w, h, L, start) {
    const sx = start % w, sy = (start - sx) / w;
    const pts = [[sx, sy]];
    let cx = sx, cy = sy, b = 0, second = -1;
    const limit = 8 * (w + h) * 4;
    for (let step = 0; step < limit; step++) {
      let nx = -1, ny = -1, nb = 0;
      for (let k = 1; k <= 8; k++) {
        const d = (b + k) % 8, x = cx + DX[d], y = cy + DY[d];
        if (x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === L) {
          const pd = (d + 7) % 8;
          nb = dirOf(cx + DX[pd] - x, cy + DY[pd] - y);
          nx = x; ny = y;
          break;
        }
      }
      if (nx < 0) break; // одиночная точка
      const ni = ny * w + nx;
      if (second < 0) second = ni;
      else if (cx === sx && cy === sy && ni === second) break; // контур замкнулся
      cx = nx; cy = ny; b = nb;
      if (!(cx === sx && cy === sy)) pts.push([cx, cy]);
    }
    return pts;
  }

  function dist2Seg(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
    const L2 = vx * vx + vy * vy;
    let t = L2 ? (wx * vx + wy * vy) / L2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const ex = wx - t * vx, ey = wy - t * vy;
    return ex * ex + ey * ey;
  }

  // Упрощение ломаной (Дуглас — Пекер), концы сохраняются.
  function dp(pts, eps) {
    const keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]], e2 = eps * eps;
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      const seg = stack.pop(), a = seg[0], b = seg[1];
      let far = -1, fd = e2;
      for (let i = a + 1; i < b; i++) {
        const d = dist2Seg(pts[i], pts[a], pts[b]);
        if (d > fd) { fd = d; far = i; }
      }
      if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter(function (p, i) { return keep[i]; });
  }

  // Упрощение замкнутого контура: делится в самой дальней от начала точке.
  function simplify(pts, eps) {
    if (pts.length < 4) return pts;
    let far = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[0][0], dy = pts[i][1] - pts[0][1], d = dx * dx + dy * dy;
      if (d > fd) { fd = d; far = i; }
    }
    const a = dp(pts.slice(0, far + 1), eps), b = dp(pts.slice(far).concat([pts[0]]), eps);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  // ---------- главное ----------

  // rgba — Uint8ClampedArray (w × h × 4). options.scale — точек на метр (если известен).
  function findRooms(rgba, w, h, options) {
    const t0 = now();
    const o = Object.assign({}, DEFAULTS, options || {});
    const n = w * h, big = Math.max(w, h), scale = o.scale > 0 ? o.scale : 0;
    const ink = inkMask(rgba, w, h);
    removeSmall(ink, w, h, Math.max(6, Math.round(big * 0.015)));
    const dist = edt(ink, w, h);
    const rDoor = scale ? o.doorM * scale / 2 : big * 0.008;
    const rOut = scale ? o.outM * scale : big * 0.02;

    // Стены здания — крупные тёмные линии. Надписи, линейка, условные обозначения и
    // рамка листа улицу не загораживают: рамка — линия у всех четырёх краёв картинки.
    const parts = components(ink, w, h, true), keep = new Uint8Array(parts.count + 1);
    const nearAll = function (f) {
      const mx = w * 0.03, my = h * 0.03;
      return f.x0 <= mx && f.y0 <= my && f.x1 >= w - 1 - mx && f.y1 >= h - 1 - my;
    };
    let largest = 0;
    for (let k = 1; k <= parts.count; k++) if (!nearAll(parts.info[k]) && parts.info[k].n > largest) largest = parts.info[k].n;
    const shell = new Uint8Array(n);
    let sx0 = w, sy0 = h, sx1 = -1, sy1 = -1;
    for (let k = 1; k <= parts.count; k++) {
      const f = parts.info[k];
      if (nearAll(f) || f.n < largest * 0.2) continue;
      keep[k] = 1;
      sx0 = Math.min(sx0, f.x0); sy0 = Math.min(sy0, f.y0); sx1 = Math.max(sx1, f.x1); sy1 = Math.max(sy1, f.y1);
    }
    for (let i = 0; i < n; i++) if (ink[i] && keep[parts.labels[i]]) shell[i] = 1;
    const distShell = edt(shell, w, h);

    // улица: от края картинки через проходы шире 2 × rOut, плюс полоса rOut вдоль наружных стен
    const rOut2 = rOut * rOut, wide = new Uint8Array(n), queue = new Int32Array(n);
    let head = 0, tail = 0;
    function out(i) { if (!wide[i] && !shell[i] && distShell[i] > rOut2) { wide[i] = 1; queue[tail++] = i; } }
    for (let x = 0; x < w; x++) { out(x); out((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { out(y * w); out(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x > 0) out(i - 1);
      if (x < w - 1) out(i + 1);
      if (i >= w) out(i - w);
      if (i < n - w) out(i + w);
    }
    const dOut = edt(wide, w, h), street = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!shell[i] && dOut[i] <= rOut2) street[i] = 1;

    // ядра помещений и их разрастание до стен
    const rDoor2 = rDoor * rDoor, core = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!ink[i] && !street[i] && dist[i] > rDoor2) core[i] = 1;
    const cc = components(core, w, h, false), label = cc.labels;
    head = 0; tail = 0;
    for (let i = 0; i < n; i++) if (label[i]) queue[tail++] = i;
    while (head < tail) {
      const i = queue[head++], L = label[i], x = i % w;
      let j;
      if (x > 0 && !label[j = i - 1] && !ink[j] && !street[j]) { label[j] = L; queue[tail++] = j; }
      if (x < w - 1 && !label[j = i + 1] && !ink[j] && !street[j]) { label[j] = L; queue[tail++] = j; }
      if (i >= w && !label[j = i - w] && !ink[j] && !street[j]) { label[j] = L; queue[tail++] = j; }
      if (i < n - w && !label[j = i + w] && !ink[j] && !street[j]) { label[j] = L; queue[tail++] = j; }
    }

    // сведения о помещениях
    const K = cc.count;
    const cnt = new Float64Array(K + 1), x0 = new Int32Array(K + 1).fill(w), y0 = new Int32Array(K + 1).fill(h);
    const x1 = new Int32Array(K + 1).fill(-1), y1 = new Int32Array(K + 1).fill(-1), edge = new Uint8Array(K + 1);
    const first = new Int32Array(K + 1).fill(-1), best = new Float64Array(K + 1).fill(-1), bestI = new Int32Array(K + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, L = label[i];
        if (!L) continue;
        if (first[L] < 0) first[L] = i;
        cnt[L] += 1;
        if (x < x0[L]) x0[L] = x;
        if (x > x1[L]) x1[L] = x;
        if (y < y0[L]) y0[L] = y;
        if (y > y1[L]) y1[L] = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge[L] = 1;
        if (dist[i] > best[L]) { best[L] = dist[i]; bestI[L] = i; }
      }
    }
    const minPx = scale ? o.minRoomM2 * scale * scale : n * 0.0008;
    const eps = Math.max(1, scale ? 0.15 * scale : big * 0.002);
    // кандидаты: не у края картинки, не меньше ниши, внутри рамки стен здания
    const cand = [];
    for (let L = 1; L <= K; L++) {
      if (edge[L] || cnt[L] < minPx) continue;
      const lx = bestI[L] % w, ly = (bestI[L] - lx) / w;
      if (lx < sx0 || lx > sx1 || ly < sy0 || ly > sy1) continue;
      cand.push(L);
    }
    // область, рамка которой охватывает все остальные, — поле вокруг здания (например, внутри рамки листа)
    const surrounds = function (L) {
      let ux0 = w, uy0 = h, ux1 = -1, uy1 = -1, others = 0;
      cand.forEach(function (M) {
        if (M === L) return;
        others += 1;
        ux0 = Math.min(ux0, x0[M]); uy0 = Math.min(uy0, y0[M]); ux1 = Math.max(ux1, x1[M]); uy1 = Math.max(uy1, y1[M]);
      });
      return others >= 3 && x0[L] <= ux0 && y0[L] <= uy0 && x1[L] >= ux1 && y1[L] >= uy1;
    };
    const rooms = [];
    cand.forEach(function (L) {
      if (surrounds(L)) return;
      const poly = simplify(trace(label, w, h, L, first[L]), eps).map(function (p) { return [p[0] + 0.5, p[1] + 0.5]; });
      const lx = bestI[L] % w, ly = (bestI[L] - lx) / w;
      rooms.push({
        px: cnt[L], area: scale ? round1(cnt[L] / (scale * scale)) : 0,
        bbox: [x0[L], y0[L], x1[L] + 1, y1[L] + 1], lx: lx + 0.5, ly: ly + 0.5, poly: poly
      });
    });
    // порядок чтения: ряд за рядом, слева направо
    const row = Math.max(1, h * 0.05);
    rooms.sort(function (a, b) { return (Math.round(a.bbox[1] / row) - Math.round(b.bbox[1] / row)) || (a.bbox[0] - b.bbox[0]); });
    rooms.forEach(function (r, i) { r.id = i + 1; });
    return { w: w, h: h, scale: scale, rooms: rooms, doorPx: rDoor * 2, ms: Math.round(now() - t0) };
  }

  // Масштаб по общей площади этажа: сумма площадей найденных помещений = areaM2.
  function scaleFromArea(rooms, areaM2) {
    const px = rooms.reduce(function (s, r) { return s + r.px; }, 0);
    return px > 0 && areaM2 > 0 ? Math.sqrt(px / areaM2) : 0;
  }

  // Площади помещений в м² с точностью 0,1, сумма которых равна округлённой общей площади
  // (метод наибольших остатков). При округлении каждой площади отдельно сумма по списку
  // расходится с общей площадью на 0,1–0,5 м², и итог этажа не совпадает с введённым.
  function roundAreas(rooms, scale) {
    const s2 = scale * scale;
    const exact = rooms.map(function (r) { return r.px / s2 * 10; });
    const out = exact.map(function (x) { return Math.floor(x + 1e-9); });
    let rest = Math.round(exact.reduce(function (a, b) { return a + b; }, 0)) - out.reduce(function (a, b) { return a + b; }, 0);
    const order = exact.map(function (x, i) { return i; })
      .sort(function (a, b) { return (exact[b] - out[b]) - (exact[a] - out[a]) || a - b; });
    for (let k = 0; k < order.length && rest > 0; k++, rest--) out[order[k]] += 1;
    return out.map(function (x) { return x / 10; });
  }

  // Масштаб по отрезку известной длины.
  function scaleFromLength(a, b, meters) {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return d > 0 && meters > 0 ? d / meters : 0;
  }

  // Похоже на коридор: вытянутое и узкое.
  function looksLikeCorridor(room, scale) {
    const bw = room.bbox[2] - room.bbox[0], bh = room.bbox[3] - room.bbox[1];
    const long = Math.max(bw, bh), short = Math.min(bw, bh);
    return short > 0 && long / short >= 3.5 && (!scale || short / scale <= 4.5);
  }

  return {
    DEFAULTS: DEFAULTS, findRooms: findRooms, scaleFromArea: scaleFromArea, scaleFromLength: scaleFromLength,
    roundAreas: roundAreas, looksLikeCorridor: looksLikeCorridor,
    // для тестов
    _inkMask: inkMask, _edt: edt, _components: components
  };
}));
