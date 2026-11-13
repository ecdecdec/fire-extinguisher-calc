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
    // первый проход без масштаба, второй с масштабом по площади, затем масштаб уточняется
    const first = V.findRooms(img.rgba, img.w, img.h);
    const out = V.findRooms(img.rgba, img.w, img.h, { scale: V.scaleFromArea(first.rooms, entered) });
    const scale = V.scaleFromArea(out.rooms, entered);
    const sum = V.roundAreas(out.rooms, scale).reduce((a, b) => a + b * 10, 0) / 10;
    assert.equal(Math.round(sum * 10) / 10, entered);
  });
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
