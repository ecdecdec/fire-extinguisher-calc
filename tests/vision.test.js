// Тесты распознавания помещений на плане этажа. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../js/vision.js');
const { readPng } = require('./helpers.js');

// ---------- план этажа в памяти: известная геометрия ----------
// Здание 60 × 21 м: коридор посередине, 8 помещений сверху и 7 снизу, двери 1 м,
// выходы 1,5 м в торцах. Наружные стены 0,5 м, перегородки 0,2 м. Масштаб s точек на метр.
const MARGIN = 4, TOP = [0, 9, 18, 27, 33, 37, 40, 49, 60], BOTTOM = [0, 18, 23, 32, 41, 45, 49, 60];

function planImage(s, photo) {
  const w = Math.round((60 + 2 * MARGIN) * s), h = Math.round((21 + 2 * MARGIN) * s);
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const X = m => Math.round((m + MARGIN) * s), Y = m => Math.round((m + MARGIN) * s);
  function fill(x0, y0, x1, y1, c) { // в метрах
    for (let y = Y(y0); y < Y(y1); y++) for (let x = X(x0); x < X(x1); x++) {
      const o = (y * w + x) * 4; rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
    }
  }
  const black = [0, 0, 0], white = [255, 255, 255];
  // наружные стены
  fill(0, 0, 60, 0.5, black); fill(0, 20.5, 60, 21, black); fill(0, 0, 0.5, 21, black); fill(59.5, 0, 60, 21, black);
  // стены коридора и перегородки
  fill(0, 8.9, 60, 9.1, black); fill(0, 11.9, 60, 12.1, black);
  TOP.slice(1, -1).forEach(x => fill(x - 0.1, 0, x + 0.1, 9, black));
  BOTTOM.slice(1, -1).forEach(x => fill(x - 0.1, 12, x + 0.1, 21, black));
  // двери в коридор и выходы в торцах
  for (let i = 0; i + 1 < TOP.length; i++) { const c = (TOP[i] + TOP[i + 1]) / 2; fill(c - 0.5, 8.9, c + 0.5, 9.1, white); }
  for (let i = 0; i + 1 < BOTTOM.length; i++) { const c = (BOTTOM[i] + BOTTOM[i + 1]) / 2; fill(c - 0.5, 11.9, c + 0.5, 12.1, white); }
  fill(0, 9.75, 0.5, 11.25, white); fill(59.5, 9.75, 60, 11.25, white);
  // надписи (мелкие тёмные пятна), знаки огнетушителей (красные) и стрелка эвакуации (зелёная)
  [TOP, BOTTOM].forEach((xs, row) => {
    for (let i = 0; i + 1 < xs.length; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = row ? 16 : 4.5;
      for (let k = -1; k <= 1; k++) fill(cx + k * 0.8 - 0.2, cy - 0.35, cx + k * 0.8 + 0.2, cy + 0.35, black);
      if (i % 2 === 0) fill(cx - 0.6, cy + 1.5, cx + 0.6, cy + 2.7, [210, 40, 40]);
    }
  });
  fill(2, 10.35, 58, 10.65, [0, 150, 60]);
  if (photo) { // неровный свет, шум, размытие — как на снимке телефоном
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, f = 0.65 + 0.35 * x / w;
      for (let c = 0; c < 3; c++) rgba[o + c] = rgba[o + c] * f + (rnd() - 0.5) * 40;
    }
    const src = rgba.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * w + x + dx) * 4 + c];
      rgba[(y * w + x) * 4 + c] = sum / 9;
    }
  }
  return { rgba, w, h };
}

// ---------- квартира с мебелью: мебель не помещение ----------
// 12 × 9 м: сверху гостиная и спальня, посередине коридор 1,5 м, снизу кухня, санузел и
// вторая спальня. Наружные стены 0,3 м, перегородки 0,12 м, двери 0,9 м. Мебель — тонкими
// линиями (0,03 м): у стен, в углах и отдельно стоящая. У санузла дверь нарисована створкой
// и дугой — так он замкнут, но остаётся помещением.
const APT = { W: 12, H: 9, M: 2 };
function apartmentImage(s) {
  const w = Math.round((APT.W + 2 * APT.M) * s), h = Math.round((APT.H + 2 * APT.M) * s);
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const P = m => (m + APT.M) * s;
  // заливка с частичным покрытием крайних точек (как у сглаженного чертежа)
  function fill(x0, y0, x1, y1, c) {
    const ax = P(x0), bx = P(x1), ay = P(y0), by = P(y1);
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      const cov = Math.max(0, Math.min(x + 1, bx) - Math.max(x, ax)) * Math.max(0, Math.min(y + 1, by) - Math.max(y, ay));
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.min(rgba[o + k], 255 * (1 - cov) + c * cov);
    }
  }
  const clear = (x0, y0, x1, y1) => {
    for (let y = Math.round(P(y0)); y < Math.round(P(y1)); y++) for (let x = Math.round(P(x0)); x < Math.round(P(x1)); x++) { const o = (y * w + x) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = 255; }
  };
  const t = 0.03; // линия мебели
  const box = (x0, y0, x1, y1) => { fill(x0, y0, x1, y0 + t, 40); fill(x0, y1 - t, x1, y1, 40); fill(x0, y0, x0 + t, y1, 40); fill(x1 - t, y0, x1, y1, 40); };
  const arc = (cx, cy, r, a0, a1) => { for (let k = 0; k <= 200; k++) { const a = a0 + (a1 - a0) * k / 200, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a); fill(x - t / 2, y - t / 2, x + t / 2, y + t / 2, 40); } };
  // стены
  fill(0, 0, 12, 0.3, 0); fill(0, 8.7, 12, 9, 0); fill(0, 0, 0.3, 9, 0); fill(11.7, 0, 12, 9, 0);
  fill(0.3, 3.94, 11.7, 4.06, 0); fill(0.3, 5.44, 11.7, 5.56, 0);  // стены коридора
  fill(6.44, 0.3, 6.56, 3.94, 0);                                  // гостиная | спальня
  fill(4.44, 5.56, 4.56, 8.7, 0); fill(6.94, 5.56, 7.06, 8.7, 0);  // кухня | санузел | спальня 2
  // двери в коридор и вход
  clear(2.8, 3.94, 3.7, 4.06); clear(8.8, 3.94, 9.7, 4.06);
  clear(1.8, 5.44, 2.7, 5.56); clear(5.25, 5.44, 6.15, 5.56); clear(9.3, 5.44, 10.2, 5.56);
  clear(0, 4.25, 0.3, 5.25);
  // дверь санузла: створка внутрь и дуга от её конца до другого косяка
  fill(5.25, 5.56, 5.25 + t, 6.46, 40); arc(5.25, 5.5, 0.9, 0, Math.PI / 2);
  // спальня: кровать изголовьем к наружной стене, подушки; шкаф в углу; тумбочка
  box(8.5, 0.3, 10.1, 2.3); box(8.65, 0.45, 9.25, 0.8); box(9.35, 0.45, 9.95, 0.8);
  box(11.1, 0.3, 11.7, 2.3); box(7.9, 0.4, 8.35, 0.85);
  // гостиная: диван у стены, журнальный столик и тумба отдельно
  box(0.3, 1.0, 1.2, 3.2); box(2.2, 1.6, 3.2, 2.2); box(4.5, 0.6, 6.2, 1.0);
  // кухня: тумба вдоль стены от угла, стол со стульями посередине
  box(0.3, 8.1, 4.2, 8.7); box(1.6, 6.6, 2.8, 7.4);
  [[1.8, 6.25], [2.4, 6.25], [1.8, 7.5], [2.4, 7.5]].forEach(([x, y]) => box(x, y, x + 0.4, y + 0.35));
  // санузел: ванна в углу, унитаз и раковина
  box(4.56, 8.0, 6.26, 8.7); box(6.3, 6.4, 6.94, 6.8); box(6.5, 7.2, 6.9, 7.8);
  // спальня 2: кровать у стены, стол отдельно
  box(10.8, 6.2, 11.7, 8.2); box(7.6, 7.6, 8.8, 8.2);
  return { rgba, w, h };
}
// Помещения квартиры и их площади по внутренним граням стен (вместе с мебелью).
const APT_ROOMS = [
  { name: 'гостиная', x: 3, y: 2.5, area: 6.14 * 3.64 },
  { name: 'спальня', x: 7.5, y: 3, area: 5.14 * 3.64 },
  { name: 'коридор', x: 6, y: 4.75, area: 11.4 * 1.38 },
  { name: 'кухня', x: 3, y: 6.2, area: 4.14 * 3.14 },
  { name: 'санузел', x: 6.5, y: 7.3, area: 2.38 * 3.14 },
  { name: 'спальня 2', x: 9, y: 7, area: 4.64 * 3.14 }
];

// Ожидаемые площади: по внутренним граням стен.
function expectedRooms() {
  const rooms = [];
  const inner = (xs, i) => [xs[i] === 0 ? 0.5 : xs[i] + 0.1, xs[i + 1] === 60 ? 59.5 : xs[i + 1] - 0.1];
  for (let i = 0; i + 1 < TOP.length; i++) { const [a, b] = inner(TOP, i); rooms.push({ row: 'top', area: (b - a) * 8.4 }); }
  rooms.push({ row: 'corridor', area: 59 * 2.8 });
  for (let i = 0; i + 1 < BOTTOM.length; i++) { const [a, b] = inner(BOTTOM, i); rooms.push({ row: 'bottom', area: (b - a) * 8.4 }); }
  return rooms;
}

// tol — допустимая доля ошибки площади: на снимке размытые стены толще, помещения чуть меньше.
function checkRooms(found, s, label, tol) {
  const exp = expectedRooms();
  assert.equal(found.length, exp.length, label + ': число помещений');
  // по порядку чтения: верхний ряд, коридор, нижний ряд
  found.forEach((r, i) => {
    const e = exp[i], got = r.px / (s * s);
    assert.ok(Math.abs(got - e.area) / e.area < tol, label + ': помещение ' + (i + 1) + ' — ' + got.toFixed(2) + ' м² вместо ' + e.area.toFixed(2));
  });
}

test('план этажа: 16 помещений с площадями по внутренним граням стен', () => {
  const s = 10, img = planImage(s, false);
  const out = V.findRooms(img.rgba, img.w, img.h, { scale: s });
  checkRooms(out.rooms, s, 'чистый план', 0.03);
  // надписи, красные знаки и зелёная стрелка не разделили помещения и не попали в стены
  const corridor = out.rooms[8];
  assert.ok(V.looksLikeCorridor(corridor, s), 'коридор узнан');
  assert.ok(!V.looksLikeCorridor(out.rooms[0], s));
  // у каждого помещения есть контур, точка для подписи внутри рамки и площадь в м²
  out.rooms.forEach(r => {
    assert.ok(r.poly.length >= 4, 'контур ' + r.id);
    assert.ok(r.lx > r.bbox[0] && r.lx < r.bbox[2] && r.ly > r.bbox[1] && r.ly < r.bbox[3]);
    assert.ok(r.area > 0);
  });
  // прямоугольное помещение — 4 угла
  assert.equal(out.rooms[0].poly.length, 4);
});

test('снимок телефоном: неровный свет, шум и размытие — те же помещения', () => {
  const s = 10, img = planImage(s, true);
  checkRooms(V.findRooms(img.rgba, img.w, img.h, { scale: s }).rooms, s, 'фото', 0.07);
});

test('масштаб по общей площади этажа и по длине стены', () => {
  const s = 10, img = planImage(s, false);
  const total = expectedRooms().reduce((t, r) => t + r.area, 0);
  const first = V.findRooms(img.rgba, img.w, img.h); // масштаб ещё неизвестен
  assert.equal(first.rooms.length, 16);
  const k = V.scaleFromArea(first.rooms, total);
  assert.ok(Math.abs(k - s) / s < 0.03, 'масштаб по площади ' + k.toFixed(2));
  const again = V.findRooms(img.rgba, img.w, img.h, { scale: k });
  assert.equal(again.rooms.length, 16);
  assert.equal(V.scaleFromLength([0, 0], [300, 400], 50), 10);
  assert.equal(V.scaleFromLength([0, 0], [0, 0], 5), 0);
});

test('площади помещений округлены так, что их сумма равна общей площади', () => {
  const r1 = x => Math.round(x * 10) / 10;
  // каждое по отдельности: 3 × 33,33 = 99,9 вместо 100; с наибольшими остатками — 100
  const three = V.roundAreas([{ px: 3333.33 }, { px: 3333.33 }, { px: 3333.34 }], 10);
  assert.equal(r1(three.reduce((a, b) => a + b, 0)), 100);
  assert.deepEqual(three.slice().sort(), [33.3, 33.3, 33.4]);
  // случайные наборы: сумма равна округлённой общей, каждая площадь отличается от точной меньше чем на 0,1
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 300; n++) {
    const s = 3 + rnd() * 30;
    const rooms = Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => ({ px: Math.round(rnd() * 400000) + 50 }));
    const areas = V.roundAreas(rooms, s);
    const exact = rooms.map(r => r.px / (s * s));
    assert.equal(r1(areas.reduce((a, b) => a + b, 0)), r1(exact.reduce((a, b) => a + b, 0)), 'сумма, набор ' + n);
    areas.forEach((a, i) => {
      assert.ok(Math.abs(a - exact[i]) < 0.1 + 1e-9, 'набор ' + n + ': ' + a + ' и ' + exact[i]);
      assert.equal(a, r1(a), 'одна цифра после запятой');
    });
  }
  assert.deepEqual(V.roundAreas([], 10), []);
});

test('масштаб по площади: найденная сумма площадей равна введённой (как в окне «Загрузить план»)', () => {
  const img = planImage(10, true);
  [500, 777.7, 1234.5].forEach(entered => {
    // первый проход с масштабом по габариту здания, второй — по найденным помещениям, затем масштаб уточняется
    const first = V.findRooms(img.rgba, img.w, img.h, { areaM2: entered });
    const out = V.findRooms(img.rgba, img.w, img.h, { scale: V.scaleFromArea(first.rooms, entered) });
    const scale = V.scaleFromArea(out.rooms, entered);
    const sum = V.roundAreas(out.rooms, scale).reduce((a, b) => a + b * 10, 0) / 10;
    assert.equal(Math.round(sum * 10) / 10, entered);
  });
});

test('мебель не помещение: кровать, шкаф, тумба, ванна, диван, стол входят в площадь своих помещений', () => {
  const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  [50, 30, 25, 20].forEach(s => {
    const img = apartmentImage(s);
    const out = V.findRooms(img.rgba, img.w, img.h, { scale: s });
    const P = m => (m + APT.M) * s;
    const names = out.rooms.map(r => (APT_ROOMS.find(e => inPoly(r.poly, P(e.x), P(e.y))) || { name: '?' }).name);
    assert.deepEqual(names.slice().sort(), APT_ROOMS.map(e => e.name).sort(), s + ' точек на метр: ' + out.rooms.map((r, i) => names[i] + ' ' + (r.px / s / s).toFixed(1)).join(', '));
    out.rooms.forEach((r, i) => {
      const e = APT_ROOMS.find(x => x.name === names[i]);
      assert.ok(Math.abs(r.px / s / s - e.area) / e.area < 0.05, s + ': ' + e.name + ' ' + (r.px / s / s).toFixed(2) + ' м² вместо ' + e.area.toFixed(2));
    });
    // и по общей площади тоже (как в окне «Загрузить план»): находятся те же шесть помещений
    const total = APT_ROOMS.reduce((t, e) => t + e.area, 0);
    const first = V.findRooms(img.rgba, img.w, img.h, { areaM2: total });
    const byArea = V.findRooms(img.rgba, img.w, img.h, { scale: V.scaleFromArea(first.rooms, total) });
    assert.equal(byArea.rooms.length, APT_ROOMS.length, s + ': по площади, ' + byArea.rooms.map(r => (r.px / byArea.scale / byArea.scale).toFixed(1)).join(', '));
  });
});

test('большое здание на одной картинке: 9,5 точки на метр, двери едва уже порога — все 188 помещений', () => {
  // 160 × 84 м, четыре полосы «кабинеты | коридор | кабинеты», кабинеты 6 и 12 м, двери 1 м.
  // При 9,5 точки на метр дверь занимает 10–11 точек: раньше кабинеты сливались с коридором.
  const W = 160, H = 84, M = 4, s = 1600 / (W + 2 * M);
  const w = Math.round((W + 2 * M) * s), h = Math.round((H + 2 * M) * s);
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const fill = (x0, y0, x1, y1, c) => {
    const ax = (x0 + M) * s, bx = (x1 + M) * s, ay = (y0 + M) * s, by = (y1 + M) * s;
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      const cov = c === 255 ? 1 : Math.max(0, Math.min(x + 1, bx) - Math.max(x, ax)) * Math.max(0, Math.min(y + 1, by) - Math.max(y, ay));
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = c === 255 ? 255 : Math.min(rgba[o + k], 255 * (1 - cov));
    }
  };
  let rooms = 0;
  const doors = [];
  fill(0, 0, W, 0.5, 0); fill(0, H - 0.5, W, H, 0); fill(0, 0, 0.5, H, 0); fill(W - 0.5, 0, W, H, 0);
  for (let b = 0; b < 4; b++) {
    const y0 = b * 21, cTop = y0 + 9, cBot = y0 + 12;
    if (b > 0) fill(0, y0 - 0.1, W, y0 + 0.1, 0);
    fill(0, cTop - 0.1, W, cTop + 0.1, 0); fill(0, cBot - 0.1, W, cBot + 0.1, 0);
    doors.push([0, cTop + 0.75, 0.5, cBot - 0.75], [W - 0.5, cTop + 0.75, W, cBot - 0.75]);
    [[y0, cTop, cTop], [cBot, y0 + 21, cBot]].forEach(([ra, rb, wy]) => {
      for (let x = 0, k = 0; x < W - 0.01; k++) {
        const width = Math.min(k % 5 === 4 ? 12 : 6, W - x);
        if (x > 0) fill(x - 0.1, ra, x + 0.1, rb, 0);
        doors.push([x + width / 2 - 0.5, wy - 0.1, x + width / 2 + 0.5, wy + 0.1]);
        x += width; rooms += 1;
      }
    });
    rooms += 1;
  }
  doors.forEach(d => fill(d[0], d[1], d[2], d[3], 255));
  const out = V.findRooms(rgba, w, h, { scale: s });
  assert.equal(out.rooms.length, rooms, 'по отрезку');
  const total0 = 160 * 84 * 0.93;
  const first = V.findRooms(rgba, w, h, { areaM2: total0 });
  const total = out.rooms.reduce((t, r) => t + r.px, 0) / (s * s);
  assert.equal(V.findRooms(rgba, w, h, { scale: V.scaleFromArea(first.rooms, total) }).rooms.length, rooms, 'по площади');
  assert.ok(out.ms < 6000, 'быстро: ' + out.ms + ' мс');
});

test('пустая и сплошь тёмная картинка не ломают распознавание', () => {
  const w = 120, h = 80;
  assert.deepEqual(V.findRooms(new Uint8ClampedArray(w * h * 4).fill(255), w, h, { scale: 10 }).rooms, []);
  const dark = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < dark.length; i += 4) dark[i] = 255;
  assert.deepEqual(V.findRooms(dark, w, h, { scale: 10 }).rooms, []);
});

// ---------- пример плана в репозитории ----------

test('пример плана школы: помещения, площади и коридор', () => {
  const file = path.join(__dirname, '..', 'examples', 'plan-school.png');
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'plan-school.json'), 'utf8'));
  const img = readPng(file);
  assert.deepEqual([img.w, img.h], [meta.w, meta.h]);
  const out = V.findRooms(img.rgba, img.w, img.h, { scale: meta.scale });
  assert.equal(out.rooms.length, meta.rooms.length, 'помещений');
  const total = out.rooms.reduce((t, r) => t + r.area, 0), expTotal = meta.rooms.reduce((t, r) => t + r.area, 0);
  assert.ok(Math.abs(total - expTotal) / expTotal < 0.05, 'общая площадь ' + total.toFixed(1) + ' вместо ' + expTotal.toFixed(1));
  out.rooms.forEach((r, i) => {
    const e = meta.rooms[i];
    assert.ok(Math.abs(r.area - e.area) / e.area < 0.08, (e.name) + ': ' + r.area + ' м² вместо ' + e.area);
  });
  assert.ok(out.rooms.some(r => V.looksLikeCorridor(r, meta.scale)), 'коридор узнан');
  assert.ok(out.ms < 3000, 'быстро: ' + out.ms + ' мс');
});
