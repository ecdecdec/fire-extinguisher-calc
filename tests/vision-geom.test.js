// Тесты геометрии плана: углы, обрезка, пропорции, гомография и выпрямление.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/vision-geom.js');

// Повторяемый генератор псевдослучайных чисел.
function makeRng(seed) {
  let s = seed | 0;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function fillRect(rgba, w, h, x0, y0, x1, y1, col) {
  const ax = Math.max(0, Math.round(x0)), ay = Math.max(0, Math.round(y0));
  const bx = Math.min(w, Math.round(x1)), by = Math.min(h, Math.round(y1));
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; rgba[o + 3] = 255;
    }
  }
}

// Рисует белый лист с планом этажа (наружные стены, коридор, 6 помещений, двери, стрелка).
// Возвращает картинку листа и истинные границы и длины стен в пикселях листа.
function makePlanSheet(sw, sh, opts) {
  const o = opts || {};
  const rgba = new Uint8ClampedArray(sw * sh * 4).fill(255);
  const bx0 = o.bx0 !== undefined ? o.bx0 : Math.round(sw * 0.14);
  const by0 = o.by0 !== undefined ? o.by0 : Math.round(sh * 0.18);
  const bx1 = o.bx1 !== undefined ? o.bx1 : Math.round(sw * 0.86);
  const by1 = o.by1 !== undefined ? o.by1 : Math.round(sh * 0.82);
  const bw = bx1 - bx0, bh = by1 - by0;
  const wt = Math.max(4, Math.round(Math.min(bw, bh) * 0.022));
  const pt = Math.max(3, Math.round(wt * 0.65));
  const black = [15, 15, 15], white = [255, 255, 255];

  // Наружные стены здания.
  fillRect(rgba, sw, sh, bx0, by0, bx1, by0 + wt, black);
  fillRect(rgba, sw, sh, bx0, by1 - wt, bx1, by1, black);
  fillRect(rgba, sw, sh, bx0, by0, bx0 + wt, by1, black);
  fillRect(rgba, sw, sh, bx1 - wt, by0, bx1, by1, black);

  // Коридор посередине.
  const cTop = by0 + Math.round(bh * 0.41);
  const cBot = by0 + Math.round(bh * 0.59);
  fillRect(rgba, sw, sh, bx0, cTop, bx1, cTop + pt, black);
  fillRect(rgba, sw, sh, bx0, cBot, bx1, cBot + pt, black);

  // Перегородки верхнего и нижнего рядов.
  const xs = [0.33, 0.67];
  for (let i = 0; i < xs.length; i++) {
    const px = bx0 + Math.round(bw * xs[i]);
    fillRect(rgba, sw, sh, px, by0, px + pt, cTop + pt, black);
    fillRect(rgba, sw, sh, px, cBot, px + pt, by1, black);
  }

  // Двери в коридор и выходы в торцах.
  const doorW = Math.max(10, Math.round(bw * 0.055));
  const mids = [0.165, 0.5, 0.835];
  for (let i = 0; i < mids.length; i++) {
    const cx = bx0 + Math.round(bw * mids[i]);
    fillRect(rgba, sw, sh, cx - doorW / 2, cTop - 1, cx + doorW / 2, cTop + pt + 1, white);
    fillRect(rgba, sw, sh, cx - doorW / 2, cBot - 1, cx + doorW / 2, cBot + pt + 1, white);
  }
  const exitH = Math.max(12, Math.round(bh * 0.11));
  const cy = (cTop + cBot) * 0.5;
  fillRect(rgba, sw, sh, bx0 - 1, cy - exitH / 2, bx0 + wt + 1, cy + exitH / 2, white);
  fillRect(rgba, sw, sh, bx1 - wt - 1, cy - exitH / 2, bx1 + 1, cy + exitH / 2, white);

  // Зеленая стрелка эвакуации по коридору и красные знаки огнетушителей.
  fillRect(rgba, sw, sh, bx0 + wt * 2, cy - 3, bx1 - wt * 2, cy + 3, [20, 150, 50]);
  fillRect(rgba, sw, sh, bx0 + bw * 0.12, by0 + bh * 0.15, bx0 + bw * 0.16, by0 + bh * 0.22, [210, 35, 35]);

  return {
    rgba: rgba, w: sw, h: sh,
    box: [bx0, by0, bx1, by1],
    wallW: bx1 - bx0,
    wallH: by1 - by0,
    wt: wt
  };
}

// Проецирует 4 угла листа через 3D-камеру (поворот вокруг осей X и Y в градусах).
function projectSheetCorners(sw, sh, cw, ch, pitchDeg, yawDeg, scaleFill) {
  const f = Math.max(cw, ch);
  const cx = cw * 0.5, cy = ch * 0.5;
  const rx = pitchDeg * Math.PI / 180;
  const ry = yawDeg * Math.PI / 180;
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  // Подбираем дистанцию Z0 так, чтобы лист занимал нужную долю кадра.
  const z0 = f / (scaleFill || 0.66);
  const hw = sw * 0.5, hh = sh * 0.5;
  const local = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return local.map(function (p) {
    const x0 = p[0], y0 = p[1];
    // Поворот вокруг X, затем вокруг Y.
    const y1 = y0 * cosX, z1 = y0 * sinX;
    const x2 = x0 * cosY + z1 * sinY;
    const z2 = -x0 * sinY + z1 * cosY + z0;
    return [cx + f * x2 / z2, cy + f * y1 / z2];
  });
}

// Накладывает перспективно искаженный лист на текстурированный серый фон с градиентом тени.
function makePerspectivePhoto(sheet, cw, ch, pitchDeg, yawDeg, seed) {
  const quad = projectSheetCorners(sheet.w, sheet.h, cw, ch, pitchDeg, yawDeg, 0.65);
  const Hinv = G.homography(quad, [[0, 0], [sheet.w, 0], [sheet.w, sheet.h], [0, sheet.h]]);
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  const rng = makeRng(seed || 42);

  // Текстурированный серый фон (шум + легкая фактура стены).
  for (let y = 0; y < ch; y++) {
    const rowWave = Math.sin(y * 0.14) * 6;
    for (let x = 0; x < cw; x++) {
      const colWave = Math.cos(x * 0.09) * 5;
      const grain = (rng() - 0.5) * 26;
      const base = Math.max(50, Math.min(180, 128 + rowWave + colWave + grain));
      const o = (y * cw + x) * 4;
      rgba[o] = base; rgba[o + 1] = base - 2; rgba[o + 2] = base - 4; rgba[o + 3] = 255;
    }
  }

  // Переносим лист на фон с билинейной выборкой.
  const sw = sheet.w, sh = sheet.h, src = sheet.rgba;
  const h0 = Hinv[0], h1 = Hinv[1], h2 = Hinv[2];
  const h3 = Hinv[3], h4 = Hinv[4], h5 = Hinv[5];
  const h6 = Hinv[6], h7 = Hinv[7], h8 = Hinv[8];
  for (let y = 0; y < ch; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < cw; x++) {
      const xc = x + 0.5;
      const dn = h6 * xc + h7 * yc + h8;
      const sx = (h0 * xc + h1 * yc + h2) / dn - 0.5;
      const sy = (h3 * xc + h4 * yc + h5) / dn - 0.5;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : sw - 1;
      const y1 = y0 + 1 < sh ? y0 + 1 : sh - 1;
      const fx = sx - x0, fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      const o = (y * cw + x) * 4;
      rgba[o]     = src[p00]     * w00 + src[p10]     * w10 + src[p01]     * w01 + src[p11]     * w11;
      rgba[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      rgba[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
    }
  }

  // Диагональный градиент тени и легкий шум камеры по всему снимку.
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const shad = 0.62 + 0.38 * (0.65 * x / cw + 0.35 * y / ch);
      const n = (rng() - 0.5) * 10;
      const o = (y * cw + x) * 4;
      rgba[o]     = rgba[o] * shad + n;
      rgba[o + 1] = rgba[o + 1] * shad + n;
      rgba[o + 2] = rgba[o + 2] * shad + n;
    }
  }

  return { rgba: rgba, w: cw, h: ch, quad: quad };
}

// Измеряет габариты темных стен на выпрямленном плане (исключая кромку 3%).
function measureWalls(rgba, w, h) {
  const px0 = Math.round(w * 0.03), px1 = Math.round(w * 0.97);
  const py0 = Math.round(h * 0.03), py1 = Math.round(h * 0.97);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = py0; y < py1; y++) {
    for (let x = px0; x < px1; x++) {
      const o = (y * w + x) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const l = r * 0.299 + g * 0.587 + b * 0.114;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (l < 95 && mx - mn < 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------- 1. Гомография ----------

test('homography и applyH переводят четыре точки точно (1e-6)', () => {
  const cases = [
    [
      [[0, 0], [100, 0], [100, 80], [0, 80]],
      [[0, 0], [100, 0], [100, 80], [0, 80]]
    ],
    [
      [[0, 0], [1600, 0], [1600, 1200], [0, 1200]],
      [[180, 95], [1410, 160], [1520, 1085], [90, 1020]]
    ],
    [
      [[240.5, 130.2], [1190.7, 88.4], [1312.3, 944.8], [115.9, 1012.6]],
      [[0, 0], [1200, 0], [1200, 850], [0, 850]]
    ]
  ];
  for (let c = 0; c < cases.length; c++) {
    const src = cases[c][0], dst = cases[c][1];
    const H = G.homography(src, dst);
    assert.ok(H instanceof Float64Array);
    assert.equal(H.length, 9);
    for (let i = 0; i < 4; i++) {
      const p = G.applyH(H, src[i][0], src[i][1]);
      assert.ok(Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < 1e-6, 'случай ' + c + ', угол ' + i);
    }
    const Hinv = G.homography(dst, src);
    const mid = G.applyH(H, 420.3, 310.7);
    const back = G.applyH(Hinv, mid[0], mid[1]);
    assert.ok(Math.hypot(back[0] - 420.3, back[1] - 310.7) < 1e-6, 'обратная гомография');
  }
  // Вырожденный случай (3 точки на одной прямой) возвращает null.
  assert.equal(G.homography([[0, 0], [50, 0], [100, 0], [0, 50]], [[0, 0], [10, 0], [10, 10], [0, 10]]), null);
});

// ---------- 2. Перспектива 15 и 30 градусов: углы и длины стен ----------

test('перспектива 15 и 30 градусов на сером фоне с тенью: углы и длины стен в пределах 2%', () => {
  const sheet = makePlanSheet(900, 620);
  const configs = [
    { name: 'наклон 15 град', pitch: 15, yaw: 6, seed: 11 },
    { name: 'наклон 30 град', pitch: 26, yaw: 15, seed: 23 },
    { name: 'чистый наклон 30 град по оси X', pitch: 30, yaw: 0, seed: 37 }
  ];
  const cw = 1200, ch = 900, diag = Math.hypot(cw, ch);
  const trueAspect = sheet.wallW / sheet.wallH;

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const photo = makePerspectivePhoto(sheet, cw, ch, cfg.pitch, cfg.yaw, cfg.seed);
    const det = G.detectQuad(photo.rgba, cw, ch);
    assert.equal(det.kind, 'sheet', cfg.name + ': ожидается sheet, получено ' + det.kind);
    assert.ok(det.score >= 0.55 && det.score <= 1, cfg.name + ': оценка ' + det.score);

    // Каждый угол должен быть ближе 2% диагонали снимка.
    let maxErr = 0;
    for (let k = 0; k < 4; k++) {
      const err = Math.hypot(det.quad[k][0] - photo.quad[k][0], det.quad[k][1] - photo.quad[k][1]);
      if (err > maxErr) maxErr = err;
    }
    assert.ok(maxErr / diag < 0.02, cfg.name + ': ошибка угла ' + (maxErr / diag * 100).toFixed(2) + '%');

    // Выпрямление в истинный размер листа: длины горизонтальной и вертикальной стен в пределах 2%.
    const backExact = G.warp(photo.rgba, cw, ch, det.quad, sheet.w, sheet.h);
    const mExact = measureWalls(backExact, sheet.w, sheet.h);
    const errW = Math.abs(mExact.w - sheet.wallW) / sheet.wallW;
    const errH = Math.abs(mExact.h - sheet.wallH) / sheet.wallH;
    assert.ok(errW < 0.02, cfg.name + ': ошибка ширины стен ' + (errW * 100).toFixed(2) + '%');
    assert.ok(errH < 0.02, cfg.name + ': ошибка высоты стен ' + (errH * 100).toFixed(2) + '%');

    // Выпрямление с автоматической оценкой пропорций (rectifiedSize): соотношение длин стен в пределах 2%.
    const sz = G.rectifiedSize(det.quad, cw, ch);
    assert.ok(sz.w <= 1600 && sz.h <= 1600 && sz.w > 0 && sz.h > 0);
    const backAuto = G.warp(photo.rgba, cw, ch, det.quad, sz.w, sz.h);
    const mAuto = measureWalls(backAuto, sz.w, sz.h);
    const gotAspect = mAuto.w / mAuto.h;
    const errAr = Math.abs(gotAspect - trueAspect) / trueAspect;
    assert.ok(errAr < 0.02, cfg.name + ': ошибка пропорций стен ' + (errAr * 100).toFixed(2) + '%');
  }
});

// ---------- 3. Скан с печатной рамкой ('frame') ----------

test('скан с печатной рамкой и штампом определяется как frame', () => {
  const w = 1200, h = 900;
  const sheet = makePlanSheet(w, h, { bx0: 150, by0: 140, bx1: 920, by1: 720 });
  const rgba = sheet.rgba;
  const black = [10, 10, 10];
  // Печатная рамка листа с отступом 40 px.
  const fx0 = 40, fy0 = 36, fx1 = w - 40, fy1 = h - 36;
  fillRect(rgba, w, h, fx0, fy0, fx1, fy0 + 3, black);
  fillRect(rgba, w, h, fx0, fy1 - 3, fx1, fy1, black);
  fillRect(rgba, w, h, fx0, fy0, fx0 + 3, fy1, black);
  fillRect(rgba, w, h, fx1 - 3, fy0, fx1, fy1, black);
  // Штамп в правом нижнем углу, примыкающий к рамке.
  fillRect(rgba, w, h, fx1 - 240, fy1 - 110, fx1, fy1 - 108, black);
  fillRect(rgba, w, h, fx1 - 240, fy1 - 110, fx1 - 238, fy1, black);
  fillRect(rgba, w, h, fx1 - 240, fy1 - 55, fx1, fy1 - 53, black);

  const det = G.detectQuad(rgba, w, h);
  assert.equal(det.kind, 'frame', 'ожидается frame, получено ' + det.kind);
  assert.ok(det.score >= 0.6);
  const exp = [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]];
  const diag = Math.hypot(w, h);
  for (let i = 0; i < 4; i++) {
    const err = Math.hypot(det.quad[i][0] - exp[i][0], det.quad[i][1] - exp[i][1]);
    assert.ok(err / diag < 0.015, 'угол рамки ' + i + ', ошибка ' + err.toFixed(1) + ' px');
  }
});

// ---------- 4. Скриншот во всю картинку ('full') ----------

test('скриншот плана во всю картинку определяется как full', () => {
  // Вариант А: прямоугольное здание почти впритык к краям картинки.
  const tight = makePlanSheet(1000, 700, { bx0: 25, by0: 25, bx1: 975, by1: 675 });
  const r1 = G.detectQuad(tight.rgba, tight.w, tight.h);
  assert.equal(r1.kind, 'full', 'впритык: получено ' + r1.kind);
  assert.deepEqual(r1.quad, [[0, 0], [1000, 0], [1000, 700], [0, 700]]);

  // Вариант Б: план со свободными белыми полями, но без печатной рамки листа.
  const padded = makePlanSheet(1000, 700, { bx0: 120, by0: 100, bx1: 880, by1: 600 });
  const r2 = G.detectQuad(padded.rgba, padded.w, padded.h);
  assert.equal(r2.kind, 'full', 'с полями без рамки: получено ' + r2.kind);
  assert.deepEqual(r2.quad, [[0, 0], [1000, 0], [1000, 700], [0, 700]]);
});

// ---------- 5. rectifiedSize и сохранение тонких линий в warp ----------

test('rectifiedSize ограничивает длинную сторону 1600 px, а warp сохраняет тонкие линии при сжатии', () => {
  const big = G.rectifiedSize([[0, 0], [3200, 0], [3200, 2400], [0, 2400]], 3200, 2400);
  assert.equal(big.w, 1600);
  assert.equal(big.h, 1200);

  // Белый холст 1600x1200 с тонкими черными линиями толщиной 1 px.
  const w = 1600, h = 1200;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let x = 200; x < 1400; x++) {
    const o = (600 * w + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
  }
  for (let y = 150; y < 1050; y++) {
    const o = (y * w + 800) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
  }
  // Сильное сжатие в 4 раза: линии не должны пропасть.
  const small = G.warp(rgba, w, h, [[0, 0], [w, 0], [w, h], [0, h]], 400, 300);
  let darkH = 0, darkV = 0;
  for (let x = 60; x < 340; x++) {
    let mn = 255;
    for (let dy = -1; dy <= 1; dy++) mn = Math.min(mn, small[((150 + dy) * 400 + x) * 4]);
    if (mn < 245) darkH += 1;
  }
  for (let y = 45; y < 255; y++) {
    let mn = 255;
    for (let dx = -1; dx <= 1; dx++) mn = Math.min(mn, small[(y * 400 + 200 + dx) * 4]);
    if (mn < 245) darkV += 1;
  }
  assert.ok(darkH > 260, 'горизонтальная тонкая линия сохранилась: ' + darkH);
  assert.ok(darkV > 195, 'вертикальная тонкая линия сохранилась: ' + darkV);
});

// ---------- 6. planBox: здание без заголовка и легенды ----------

test('planBox выделяет здание без заголовка, таблицы инструкций и легенды', () => {
  const sw = 1000, sh = 720;
  // Здание занимает левую среднюю часть листа.
  const sheet = makePlanSheet(sw, sh, { bx0: 70, by0: 155, bx1: 640, by1: 540 });
  const rgba = sheet.rgba;
  const dark = [30, 30, 30], gray = [80, 80, 80];

  // Заголовок сверху (имитация букв: короткие темные штрихи).
  for (let x = 220; x < 760; x += 22) {
    fillRect(rgba, sw, sh, x, 42, x + 12, 68, [190, 30, 30]);
    fillRect(rgba, sw, sh, x + 4, 82, x + 14, 98, dark);
  }
  // Колонка легенды справа (тонкая рамка 1 px и мелкие строки текста).
  fillRect(rgba, sw, sh, 720, 160, 945, 162, gray);
  fillRect(rgba, sw, sh, 720, 560, 945, 562, gray);
  fillRect(rgba, sw, sh, 720, 160, 722, 562, gray);
  fillRect(rgba, sw, sh, 943, 160, 945, 562, gray);
  for (let row = 0; row < 10; row++) {
    const ry = 190 + row * 34;
    for (let x = 740; x < 920; x += 18) fillRect(rgba, sw, sh, x, ry, x + 10, ry + 8, dark);
  }
  // Строки инструкций снизу.
  for (let row = 0; row < 3; row++) {
    const ry = 600 + row * 28;
    for (let x = 90; x < 880; x += 16) fillRect(rgba, sw, sh, x, ry, x + 9, ry + 8, dark);
  }

  // Прямой лист.
  const pb1 = G.planBox(rgba, sw, sh, [[0, 0], [sw, 0], [sw, sh], [0, sh]]);
  assert.ok(pb1, 'planBox найден на прямом листе');
  assert.ok(pb1.bbox[0] <= 75 && pb1.bbox[2] >= 635, 'захвачена ширина здания');
  assert.ok(pb1.bbox[1] <= 160 && pb1.bbox[3] >= 535, 'захвачена высота здания');
  assert.ok(pb1.bbox[1] > 100, 'верхний заголовок отрезан: y0=' + pb1.bbox[1].toFixed(1));
  assert.ok(pb1.bbox[2] < 715, 'правая легенда отрезана: x1=' + pb1.bbox[2].toFixed(1));
  assert.ok(pb1.bbox[3] < 595, 'нижняя инструкция отрезана: y1=' + pb1.bbox[3].toFixed(1));

  // Тот же лист под углом 15 градусов на сером фоне.
  const photo = makePerspectivePhoto(sheet, 1200, 900, 15, 10, 99);
  const det = G.detectQuad(photo.rgba, 1200, 900);
  assert.equal(det.kind, 'sheet');
  const pb2 = G.planBox(photo.rgba, 1200, 900, det.quad);
  assert.ok(pb2, 'planBox найден на фото под углом');
  assert.ok(pb2.uv[0] < 0.12 && pb2.uv[2] > 0.60 && pb2.uv[2] < 0.72, 'uv по X: ' + pb2.uv.map(x => x.toFixed(2)));
  assert.ok(pb2.uv[1] > 0.14 && pb2.uv[1] < 0.25 && pb2.uv[3] > 0.71 && pb2.uv[3] < 0.85, 'uv по Y: ' + pb2.uv.map(x => x.toFixed(2)));

  // На пустой белой картинке возвращает null.
  const blank = new Uint8ClampedArray(400 * 300 * 4).fill(255);
  assert.equal(G.planBox(blank, 400, 300), null);
});

// ---------- 7. Граничные случаи и производительность 1600 x 1200 ----------

test('пустая и мелкая картинки не ломают detectQuad', () => {
  const blank = new Uint8ClampedArray(320 * 240 * 4).fill(255);
  assert.equal(G.detectQuad(blank, 320, 240).kind, 'full');
  const dark = new Uint8ClampedArray(320 * 240 * 4).fill(0);
  assert.equal(G.detectQuad(dark, 320, 240).kind, 'full');
  const tiny = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  assert.equal(G.detectQuad(tiny, 16, 16).kind, 'full');
});

test('производительность на 1600 x 1200: detectQuad < 150 мс, warp < 300 мс', () => {
  const sheet = makePlanSheet(1000, 720);
  const photo = makePerspectivePhoto(sheet, 1600, 1200, 20, 12, 7);
  // Прогрев JIT перед замером.
  G.detectQuad(photo.rgba, 1600, 1200);
  G.warp(photo.rgba, 1600, 1200, photo.quad, 1600, 1200);

  const t0 = performance.now();
  const det = G.detectQuad(photo.rgba, 1600, 1200);
  const detMs = performance.now() - t0;

  const t1 = performance.now();
  const out = G.warp(photo.rgba, 1600, 1200, det.quad, 1600, 1200);
  const warpMs = performance.now() - t1;

  assert.equal(det.kind, 'sheet');
  assert.equal(out.length, 1600 * 1200 * 4);
  assert.ok(detMs < 150, 'detectQuad слишком долгий: ' + Math.round(detMs) + ' мс');
  assert.ok(warpMs < 300, 'warp слишком долгий: ' + Math.round(warpMs) + ' мс');
});
