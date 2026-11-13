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
    doorM: 1.2,       // типичный дверной проём, м (для подсказок; разделение — по глубине, см. tauM)
    outM: 1.5,        // вход уже 2 × outM не соединяет здание с улицей, м
    minRoomM2: 1,     // меньше — не помещение (ниша, шахта, толщина стены)
    tauM: 0.2,        // помещение отделяется проёмом, если поднимается над ним хотя бы на столько, м
    openRatio: 0.75,  // проём не уже 3/4 ширины помещения — это одно помещение (арка, сужение)
    furnitureM: 3,    // отдельно стоящий предмет меньше этого (мебель, колонна, значок) — не стена, м
    thinM: 0.08,      // контур мебели у стены тоньше этого пересекается при поиске её помещения, м
    hairM: 0.06,      // линии тоньше (мебель, дуги дверей, размеры) — не стены на крупном плане, м
    furnitureM2: 10   // замкнутый контур у стены больше этого — не мебель, м²
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

  // ---------- помещения по глубине ----------

  // Разбиение свободного места на помещения по глубине — расстоянию до стен.
  // Точки обходятся от самых удалённых от стен к ближним (подсчётом, с шагом 1/4 точки).
  // Каждый новый максимум начинает область; где две области встречаются (в проёме),
  // меньшая присоединяется к большей, если поднимается над проёмом меньше чем на tau
  // или проём почти так же широк, как она сама (ratio). Поэтому помещение отделяется
  // от коридора дверью любой ширины, если само заметно шире проёма, а ниши, выступы
  // и неровности стен остаются частью своего помещения. Порог не зависит от того,
  // сколько точек приходится на ширину двери, — это и важно для больших зданий,
  // снятых одной картинкой.
  function segment(free, dist2, w, h, tau, ratio) {
    const n = w * h, Q = 4, cap = Q * (w + h);
    const depth = new Float32Array(n), key = new Int32Array(n);
    let maxK = 0, total = 0;
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      const d = Math.sqrt(dist2[i]), k = Math.min(cap, Math.floor(d * Q));
      depth[i] = d; key[i] = k; total += 1;
      if (k > maxK) maxK = k;
    }
    const at = new Int32Array(maxK + 2);
    for (let i = 0; i < n; i++) if (free[i]) at[maxK - key[i] + 1] += 1;
    for (let k = 1; k <= maxK + 1; k++) at[k] += at[k - 1];
    const order = new Int32Array(total);
    for (let i = 0; i < n; i++) if (free[i]) order[at[maxK - key[i]]++] = i;
    const parent = key.fill(-1), peak = new Float32Array(n), sad = new Float32Array(n), roots = new Int32Array(4);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    for (let t = 0; t < total; t++) {
      const p = order[t], d = depth[p], x = p % w;
      let m = 0;
      for (let s = 0; s < 4; s++) {
        let q;
        if (s === 0) { if (x === 0) continue; q = p - 1; } else if (s === 1) { if (x === w - 1) continue; q = p + 1; } else if (s === 2) { if (p < w) continue; q = p - w; } else { if (p >= n - w) continue; q = p + w; }
        if (parent[q] < 0) continue;
        const r = find(q);
        let seen = false;
        for (let k = 0; k < m; k++) if (roots[k] === r) { seen = true; break; }
        if (!seen) roots[m++] = r;
      }
      if (!m) { parent[p] = p; peak[p] = d; continue; }
      // слияние: самая глубокая из встретившихся областей забирает неглубокие
      let best = 0;
      for (let k = 1; k < m; k++) if (peak[roots[k]] > peak[roots[best]]) best = k;
      const R = roots[best];
      for (let k = 0; k < m; k++) {
        if (k === best) continue;
        const S = roots[k];
        if (peak[S] - d < tau || d >= ratio * peak[S]) {
          parent[S] = R;
          if (sad[S] > sad[R]) sad[R] = sad[S];
        } else {
          // остались разными: здесь проём между ними
          if (d > sad[S]) sad[S] = d;
          if (d > sad[R]) sad[R] = d;
        }
      }
      parent[p] = R;
    }
    // Ядро помещения — точки глубже всех его проёмов. Ядра разрастаются до стен все
    // сразу (поиск в ширину), поэтому граница проходит посередине проёма, а не уходит
    // целиком в одно помещение и не ползёт вдоль стены в соседнее.
    const label = new Int32Array(n), id = new Int32Array(n), queue = new Int32Array(total);
    let count = 0, head = 0, tail = 0;
    for (let t = 0; t < total; t++) {
      const p = order[t], r = find(p);
      if (depth[p] <= sad[r] + 0.5) continue;
      if (!id[r]) id[r] = ++count;
      label[p] = id[r];
      queue[tail++] = p;
    }
    while (head < tail) {
      const i = queue[head++], L = label[i], x = i % w;
      let j;
      if (x > 0 && free[j = i - 1] && !label[j]) { label[j] = L; queue[tail++] = j; }
      if (x < w - 1 && free[j = i + 1] && !label[j]) { label[j] = L; queue[tail++] = j; }
      if (i >= w && free[j = i - w] && !label[j]) { label[j] = L; queue[tail++] = j; }
      if (i < n - w && free[j = i + w] && !label[j]) { label[j] = L; queue[tail++] = j; }
    }
    return { labels: label, count: count };
  }

  // Тонкие линии — контуры мебели, створки и дуги дверей, размерные линии — не стены, если
  // план достаточно крупный, чтобы отличить их от стен. thinPx — толщина «тонкой» линии
  // в точках (6 см в натуре, не больше 3 точек): от 2,5 точки убираются линии в 1–2 точки,
  // от 1,5 — только в одну точку, мельче — ничего. Не включается и тогда, когда самые
  // толстые стены тоньше 6 точек или после этого осталось меньше 40 % тёмного (стены
  // нарисованы контуром из тонких линий).
  function dropThin(obst, w, h, thinPx) {
    if (!(thinPx >= 1.5)) return false;
    const n = w * h, inv = new Uint8Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) { if (obst[i]) total += 1; else inv[i] = 1; }
    if (!total) return false;
    const dIn = edt(inv, w, h);
    let maxD = 0;
    for (let i = 0; i < n; i++) if (obst[i] && dIn[i] > maxD) maxD = dIn[i];
    if (maxD < 9) return false;
    const core = new Uint8Array(n);
    if (thinPx >= 2.5) {
      for (let i = 0; i < n; i++) if (obst[i] && dIn[i] >= 4) core[i] = 1; // глубже 2 точек: линия от 3 точек
    } else {
      for (let i = 0; i < n - w; i++) { // есть сплошной квадрат 2 × 2: линия от 2 точек
        if (i % w === w - 1 || !obst[i] || !obst[i + 1] || !obst[i + w] || !obst[i + w + 1]) continue;
        core[i] = core[i + 1] = core[i + w] = core[i + w + 1] = 1;
      }
    }
    const dCore = edt(core, w, h), near = thinPx >= 2.5 ? 4.5 : 1;
    let kept = 0;
    for (let i = 0; i < n; i++) if (obst[i] && dCore[i] <= near) kept += 1;
    if (kept < 0.4 * total) return false;
    for (let i = 0; i < n; i++) if (obst[i] && dCore[i] > near) obst[i] = 0;
    return true;
  }

  // Мебель у стены (кровать, шкаф, ванна, кухня) — замкнутый контур внутри помещения:
  // проёмом он ни с чем не соединён (разве что проколами в сглаженной линии), а за его
  // тонкой линией почти со всех сторон одно и то же помещение. Такая область
  // присоединяется к этому помещению вместе с линией контура (площадь под мебелью —
  // площадь помещения). reach — сколько точек линии можно пересечь: дальше — уже стена.
  // Возвращает число присоединённых областей.
  function absorbFurniture(label, count, obst, street, w, h, reach, maxPx) {
    const n = w * h, size = new Float64Array(count + 1), edgeN = new Float64Array(count + 1), touch = new Float64Array(count + 1);
    const outside = new Uint8Array(count + 1);
    const bx0 = new Int32Array(count + 1).fill(w), by0 = new Int32Array(count + 1).fill(h), bx1 = new Int32Array(count + 1).fill(-1), by1 = new Int32Array(count + 1).fill(-1);
    for (let i = 0; i < n; i++) {
      const L = label[i];
      if (!L) continue;
      size[L] += 1;
      const x = i % w, y = (i - x) / w;
      if (x < bx0[L]) bx0[L] = x;
      if (x > bx1[L]) bx1[L] = x;
      if (y < by0[L]) by0[L] = y;
      if (y > by1[L]) by1[L] = y;
      let border = false, other = false;
      for (let s = 0; s < 4; s++) {
        let j;
        if (s === 0) { if (x === 0) { border = true; continue; } j = i - 1; } else if (s === 1) { if (x === w - 1) { border = true; continue; } j = i + 1; } else if (s === 2) { if (y === 0) { border = true; continue; } j = i - w; } else { if (y === h - 1) { border = true; continue; } j = i + w; }
        if (label[j] === L) continue;
        border = true;
        if (street[j]) outside[L] = 1;
        else if (label[j]) other = true;
      }
      if (border) edgeN[L] += 1;
      if (other) touch[L] += 1;
    }
    // почти замкнута: касается соседей не больше чем десятой частью границы (проколы в линии)
    const closed = function (L) { return !outside[L] && touch[L] <= Math.max(2, 0.1 * edgeN[L]); };
    const votes = new Map(), crossed = [];
    const DXS = [-1, 1, 0, 0], DYS = [0, 0, -1, 1];
    for (let i = 0; i < n; i++) {
      const L = label[i];
      if (!L || size[L] > maxPx || !closed(L)) continue;
      const x = i % w, y = (i - x) / w;
      for (let s = 0; s < 4; s++) {
        let cx = x + DXS[s], cy = y + DYS[s];
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        const j0 = cy * w + cx;
        if (!obst[j0]) {
          // прокол: соседняя область прямо за краем — тоже голос за неё
          const M = label[j0];
          if (M && M !== L) {
            let rec = votes.get(L);
            if (!rec) { rec = { total: 0, out: 0, by: new Map() }; votes.set(L, rec); }
            rec.total += 1;
            rec.by.set(M, (rec.by.get(M) || 0) + 1);
          }
          continue;
        }
        let v = L, k = 0;
        const path = [];
        while (k <= reach) {
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) { v = -2; break; }
          const j = cy * w + cx;
          if (street[j]) { v = -2; break; }
          if (!obst[j]) { v = label[j] || -1; break; }
          path.push(j);
          cx += DXS[s]; cy += DYS[s]; k += 1;
        }
        if (k > reach) v = -1; // толстая линия — стена
        if (v === L) continue; // вогнутость самого контура
        let rec = votes.get(L);
        if (!rec) { rec = { total: 0, out: 0, by: new Map() }; votes.set(L, rec); }
        rec.total += 1;
        if (v === -2) rec.out += 1;
        else if (v > 0) { rec.by.set(v, (rec.by.get(v) || 0) + 1); for (let q = 0; q < path.length; q++) crossed.push(path[q], L, v); }
      }
    }
    const map = new Int32Array(count + 1);
    for (let L = 0; L <= count; L++) map[L] = L;
    const root = function (L) { while (map[L] !== L) { map[L] = map[map[L]]; L = map[L]; } return L; };
    const cands = Array.from(votes.keys()).sort(function (a, b) { return size[a] - size[b]; });
    let merged = 0;
    // Мебель: за тонкой линией почти везде одно помещение (у стены или в углу остальное —
    // стены), сама область заметно меньше его и лежит внутри его габарита. Туалет за дверью
    // с нарисованной дугой сюда не попадает: он не внутри габарита коридора.
    cands.forEach(function (L) {
      const rec = votes.get(L);
      if (rec.out || !rec.total) return;
      let top = 0, topN = 0, labeled = 0;
      const sum = new Map();
      rec.by.forEach(function (c, M) { const r = root(M); if (r !== L) { sum.set(r, (sum.get(r) || 0) + c); labeled += c; } });
      sum.forEach(function (c, r) { if (c > topN) { topN = c; top = r; } });
      if (!top || labeled < 0.25 * rec.total || topN < 0.85 * labeled || size[L] >= 0.3 * size[top]) return;
      const t = reach + 1;
      if (bx0[L] < bx0[top] - t || by0[L] < by0[top] - t || bx1[L] > bx1[top] + t || by1[L] > by1[top] + t) return;
      map[L] = top;
      size[top] += size[L];
      merged += 1;
    });
    if (!merged) return 0;
    for (let q = 0; q < crossed.length; q += 3) {
      const L = crossed[q + 1];
      if (root(L) !== L && !label[crossed[q]]) label[crossed[q]] = L;
    }
    for (let i = 0; i < n; i++) if (label[i]) label[i] = root(label[i]);
    return merged;
  }

  // ---------- главное ----------

  // rgba — Uint8ClampedArray (w × h × 4). options.scale — точек на метр (если известен);
  // options.areaM2 — общая площадь этажа, если масштаб неизвестен: тогда масштаб для
  // первого прохода оценивается по габариту здания на картинке (около 85 % габарита —
  // помещения), а точный подбирается по найденным помещениям (scaleFromArea).
  function findRooms(rgba, w, h, options) {
    const t0 = now();
    const o = Object.assign({}, DEFAULTS, options || {});
    const n = w * h, big = Math.max(w, h);
    let scale = o.scale > 0 ? o.scale : 0;
    const ink = inkMask(rgba, w, h);
    removeSmall(ink, w, h, Math.max(6, Math.round(big * 0.015)));

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
    if (!scale && o.areaM2 > 0 && sx1 > sx0 && sy1 > sy0) scale = Math.sqrt((sx1 - sx0 + 1) * (sy1 - sy0 + 1) * 0.85 / o.areaM2);
    // без масштаба пороги берутся от размера картинки
    const rDoor = scale ? o.doorM * scale / 2 : big * 0.008;
    const rOut = scale ? o.outM * scale : big * 0.02;
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

    // Препятствия — стены. Отдельно стоящие мелкие предметы (мебель, колонна, значок, надпись),
    // не связанные со стенами здания, стенами не считаются: их площадь — площадь помещения.
    // Но кусок стены между дверями, отделённый от остальных стен просветом в точку-другую,
    // и прямая перегородка — стены: такой кусок почти касается стен здания или вытянут в линию.
    const floatMax = scale ? o.furnitureM * scale : big * 0.04;
    const nearShell = new Float64Array(parts.count + 1).fill(INF);
    for (let i = 0; i < n; i++) {
      if (!ink[i] || keep[parts.labels[i]]) continue;
      const k = parts.labels[i];
      if (distShell[i] < nearShell[k]) nearShell[k] = distShell[i];
    }
    const wallish = new Uint8Array(parts.count + 1);
    for (let k = 1; k <= parts.count; k++) {
      const f = parts.info[k], a = f.x1 - f.x0 + 1, b = f.y1 - f.y0 + 1;
      wallish[k] = keep[k] || Math.max(a, b) >= floatMax || nearShell[k] <= 2.25 || Math.max(a, b) >= 6 * Math.min(a, b) ? 1 : 0;
    }
    const obst = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (ink[i] && wallish[parts.labels[i]]) obst[i] = 1;
    dropThin(obst, w, h, scale ? Math.min(3, o.hairM * scale) : 0);
    const dist = edt(obst, w, h);

    // помещения по глубине (segment), затем мебель у стен присоединяется к своим помещениям
    const free = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!obst[i] && !street[i]) free[i] = 1;
    const tau = scale ? Math.max(2, o.tauM * scale) : Math.max(2, big * 0.002);
    const seg = segment(free, dist, w, h, tau, o.openRatio);
    const label = seg.labels;
    const reach = scale ? Math.max(2, Math.round(o.thinM * scale)) : 2;
    absorbFurniture(label, seg.count, obst, street, w, h, reach, scale ? o.furnitureM2 * scale * scale : n * 0.01);

    // сведения о помещениях
    const K = seg.count;
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
