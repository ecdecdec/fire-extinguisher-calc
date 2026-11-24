// Тесты чтения надписей на плане (js/vision-ocr.js). Запуск: node --test tests/
// Распознавание идёт через vendor/tesseract (без сети); один рабочий поток на все проверки.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const O = require('../js/vision-ocr.js');
const V = require('../js/vision.js');
const P = require('../js/presets.js');
const S = require('../tools/synth-plans.js');
const { readPng } = require('./helpers.js');
const nodeEnv = require('./ocr-node-env.js');

// ---------- разбор строк и масштаб: без распознавания ----------

test('parseArea: площади в разной записи', () => {
  assert.deepEqual(O.parseArea('15,6').area, 15.6);
  assert.deepEqual(O.parseArea('15.6').area, 15.6);
  assert.equal(O.parseArea('22 qm').area, 22);
  assert.equal(O.parseArea('14,2 м²').area, 14.2);
  assert.equal(O.parseArea('14,2 м2').area, 14.2);
  assert.equal(O.parseArea('3,3 кв.м').area, 3.3);
  const ft = O.parseArea('120 sq ft');
  assert.equal(ft.unit, 'ft2');
  assert.ok(Math.abs(ft.area - 11.15) < 0.01);
  assert.equal(O.parseArea('Кабинет'), null);
  assert.equal(O.parseArea('7'), null, 'целое число без единицы - номер помещения');
  assert.equal(O.parseArea('99999,5'), null);
});

test('scaleFromLabels: выброс отбрасывается, меньше трёх согласных - null', () => {
  const s = 20;
  const rooms = [10, 15, 20, 12, 30].map((a, i) => ({ id: i + 1, px: a * s * s }));
  const good = rooms.map((r) => ({ roomId: r.id, area: r.px / (s * s) }));
  const r1 = O.scaleFromLabels(rooms, good);
  assert.ok(Math.abs(r1.scale - s) < 1e-6);
  assert.equal(r1.inliers, 5);
  const bad = good.map((l) => Object.assign({}, l));
  bad[1].area = 51.5; // неверно прочитанная площадь
  const r2 = O.scaleFromLabels(rooms, bad);
  assert.equal(r2.inliers, 4);
  assert.ok(Math.abs(r2.scale / s - 1) < 0.01);
  assert.equal(O.scaleFromLabels(rooms, good.slice(0, 2)), null);
  const scatter = good.map((l, i) => ({ roomId: l.roomId, area: l.area * [1, 2.2, 0.4, 3.1, 0.7][i] }));
  assert.equal(O.scaleFromLabels(rooms, scatter), null);
});

test('findTextBoxes: у каждого помещения синтетического плана БТИ есть строка с площадью', () => {
  const p = S.make('hollow', 1);
  const rooms = p.rooms.map((r, i) => ({ id: i + 1, poly: r.poly }));
  const boxes = O.findTextBoxes(p.rgba, p.w, p.h, rooms);
  rooms.forEach((r) => assert.ok(boxes.some((b) => b.roomId === r.id), 'нет строки в помещении ' + r.id));
  boxes.forEach((b) => assert.ok(b.box[2] > b.box[0] && b.box[3] > b.box[1]));
});

// ---------- распознавание ----------

let env = null, skipWhy = '';
const OPTS = {};

test('запуск tesseract.js в этой версии Node', { timeout: 90000 }, async (t) => {
  try {
    env = await nodeEnv.setup();
    OPTS.Tesseract = env.Tesseract;
    OPTS.guessPurpose = P.guessPurpose;
    OPTS.timeoutMs = 60000;
    OPTS.paths = {
      workerPath: path.join(env.vendor, 'worker.min.js'),
      corePath: path.join(env.vendor, 'core', 'tesseract-core-simd-lstm.wasm.js'),
      langPath: env.base + 'lang'
    };
    // пробное чтение пустой картинки: поток и язык стартуют
    const rgba = new Uint8ClampedArray(60 * 40 * 4).fill(255);
    await O.readLabels(rgba, 60, 40, [{ id: 1, poly: [[0, 0], [60, 0], [60, 40], [0, 40]] }], OPTS);
  } catch (e) {
    skipWhy = String(e && e.message || e);
    t.diagnostic('tesseract.js не запустился, проверки чтения пропущены: ' + skipWhy);
  }
});

function ocrTest(name, fn) {
  test(name, { timeout: 120000 }, async (t) => {
    if (!env || skipWhy) { t.skip('tesseract.js не запустился: ' + skipWhy); return; }
    await fn(t);
  });
}

ocrTest('БТИ-план (hollow): площади читаются, масштаб по ним в пределах 2 %', async (t) => {
  let total = 0, okRead = 0, ms = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const p = S.make('hollow', seed);
    const rooms = p.rooms.map((r, i) => ({ id: i + 1, poly: r.poly, px: r.area * p.scale * p.scale }));
    const t0 = Date.now();
    const labels = await O.readLabels(p.rgba, p.w, p.h, rooms, OPTS);
    ms += Date.now() - t0;
    labels.forEach((l, i) => {
      total += 1;
      if (l.area !== null && l.area.toFixed(1) === p.rooms[i].area.toFixed(1)) okRead += 1;
    });
    const sc = O.scaleFromLabels(rooms, labels);
    assert.ok(sc, 'масштаб не найден, seed ' + seed);
    assert.ok(Math.abs(sc.scale / p.scale - 1) <= 0.02, 'seed ' + seed + ': ошибка масштаба ' + ((sc.scale / p.scale - 1) * 100).toFixed(2) + ' %');
  }
  t.diagnostic('прочитано верно ' + okRead + ' из ' + total + ', ' + Math.round(ms / 8) + ' мс на план');
  assert.ok(okRead / total >= 0.8, 'верно прочитано ' + okRead + ' из ' + total);
});

ocrTest('БТИ-план: помещения найдены самим распознавателем, масштаб по надписям в пределах 2 %', async (t) => {
  let checked = 0;
  for (const seed of [1, 6]) {
    const p = S.make('hollow', seed);
    const found = V.findRooms(p.rgba, p.w, p.h, {});
    if (found.rooms.length < 6) continue;
    const labels = await O.readLabels(p.rgba, p.w, p.h, found.rooms, OPTS);
    const sc = O.scaleFromLabels(found.rooms, labels);
    assert.ok(sc && sc.inliers >= 5, 'seed ' + seed);
    assert.ok(Math.abs(sc.scale / p.scale - 1) <= 0.02, 'seed ' + seed + ': ' + sc.scale + ' вместо ' + p.scale);
    checked += 1;
  }
  assert.ok(checked >= 1);
});

ocrTest('round-house-areas.png: что прочитано («22 qm» и другие)', async (t) => {
  const file = path.join(__dirname, '..', 'bench', 'vision', 'img', 'round-house-areas.png');
  if (!fs.existsSync(file)) { t.skip('нет bench/vision/img/round-house-areas.png'); return; }
  const img = readPng(file);
  // помещения круглого дома не отделены проёмами, поэтому берём прямоугольники вокруг надписей
  const R = [[450, 470, 800, 640], [1000, 620, 1260, 780], [330, 870, 620, 1020], [980, 920, 1250, 1060], [850, 1150, 1050, 1290], [570, 1210, 780, 1340]];
  const want = [22, 16, 14.2, 10, 3.3, 2.4];
  const rooms = R.map((r, i) => ({ id: i + 1, px: 1, poly: [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]] }));
  const t0 = Date.now();
  const labels = await O.readLabels(img.rgba, img.w, img.h, rooms, OPTS);
  const got = labels.map((l) => l.area);
  const ok = got.filter((a, i) => a === want[i]).length;
  t.diagnostic('прочитано ' + JSON.stringify(got) + ' вместо ' + JSON.stringify(want) + ', верно ' + ok + ' из 6, ' + (Date.now() - t0) + ' мс');
  assert.ok(ok >= 4);
});

test('название помещения: очистка слова и назначение', () => {
  // растровый шрифт синтетики букв не рисует, поэтому проверяем только разбор названий
  assert.equal(O._cleanName('Серверная 12'), 'Серверная');
  assert.equal(O._cleanName('15,6'), '');
  assert.equal(P.guessPurpose(O._cleanName('Коридор')), 'corridor');
});

test('закрытие рабочего потока', async () => {
  await O.dispose();
  if (env) env.close();
});
