// Тесты генератора синтетических планов и стенда распознавания. Запуск: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/vision.js');
const Synth = require('../tools/synth-plans.js');
const Bench = require('../tools/bench-vision.js');

const EXPECTED_VARIANTS = [
  'clean', 'hollow', 'door-arcs', 'windows', 'furniture', 'toilets',
  'open-plan', 'stubs', 'gray-walls', 'colored-walls', 'evacuation',
  'sheet', 'photo', 'lowres', 'tight', 'two-buildings'
];

function polyArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(s) * 0.5;
}

test('список вариантов содержит все 16 требуемых сценариев', function () {
  assert.deepEqual(Synth.VARIANTS, EXPECTED_VARIANTS);
  assert.throws(function () { Synth.make('no-such-variant', 1); });
});

test('генератор детерминирован для одного сида и различается для разных сидов', function () {
  Synth.VARIANTS.forEach(function (variant) {
    const a = Synth.make(variant, 2);
    const b = Synth.make(variant, 2);
    assert.equal(a.w, b.w, variant + ': ширина');
    assert.equal(a.h, b.h, variant + ': высота');
    assert.equal(a.scale, b.scale, variant + ': масштаб');
    assert.deepEqual(a.rooms, b.rooms, variant + ': помещения');
    assert.deepEqual(a.meta, b.meta, variant + ': метаданные');
    assert.equal(Buffer.compare(Buffer.from(a.rgba.buffer), Buffer.from(b.rgba.buffer)), 0, variant + ': пиксели совпадают');
  });

  // Разные сиды дают разные картинки
  ['clean', 'hollow', 'colored-walls', 'photo'].forEach(function (variant) {
    const a = Synth.make(variant, 1);
    const b = Synth.make(variant, 2);
    const sameSize = a.w === b.w && a.h === b.h;
    const samePixels = sameSize && Buffer.compare(Buffer.from(a.rgba.buffer), Buffer.from(b.rgba.buffer)) === 0;
    assert.equal(samePixels, false, variant + ': разные сиды дают разные планы');
  });
});

test('эталон корректен для всех вариантов: площади > 0, полигоны внутри картинки, есть сглаживание', function () {
  Synth.VARIANTS.forEach(function (variant) {
    [1, 2, 3].forEach(function (seed) {
      const plan = Synth.make(variant, seed);
      assert.ok(plan.rgba instanceof Uint8ClampedArray, variant + ' s' + seed + ': Uint8ClampedArray');
      assert.equal(plan.rgba.length, plan.w * plan.h * 4, variant + ' s' + seed + ': размер буфера');
      assert.ok(plan.w > 0 && plan.h > 0 && plan.scale > 0, variant + ' s' + seed + ': размеры и масштаб');
      assert.ok(Array.isArray(plan.rooms) && plan.rooms.length >= 1, variant + ' s' + seed + ': есть помещения');

      let pxAreaSum = 0, areaSum = 0;
      plan.rooms.forEach(function (room, idx) {
        assert.ok(typeof room.name === 'string' && room.name.length > 0, variant + ': имя ' + idx);
        assert.ok(room.area > 0, variant + ': площадь > 0 для ' + room.name);
        assert.ok(Array.isArray(room.poly) && room.poly.length >= 3, variant + ': полигон ' + room.name);
        room.poly.forEach(function (pt) {
          assert.ok(pt[0] >= 0 && pt[0] <= plan.w, variant + ' s' + seed + ': x=' + pt[0] + ' вне [0,' + plan.w + ']');
          assert.ok(pt[1] >= 0 && pt[1] <= plan.h, variant + ' s' + seed + ': y=' + pt[1] + ' вне [0,' + plan.h + ']');
        });
        const pa = polyArea(room.poly);
        assert.ok(pa > 0, variant + ': ненулевая площадь полигона');
        pxAreaSum += pa;
        areaSum += room.area;
        if (variant !== 'photo') {
          const fromPoly = pa / (plan.scale * plan.scale);
          assert.ok(Math.abs(fromPoly - room.area) / room.area < 0.01, variant + ': площадь полигона совпадает с area');
        }
      });

      if (variant === 'photo') {
        const effArea = pxAreaSum / (plan.scale * plan.scale);
        assert.ok(Math.abs(effArea - areaSum) / areaSum < 0.01, 'photo: масштаб соответствует сумме площадей');
        assert.equal(plan.meta.quad.length, 4, 'photo: сохранены 4 угла листа');
      }
      if (variant === 'open-plan') {
        assert.equal(plan.rooms.length, 1, 'open-plan: ровно одно помещение');
      }
      if (variant === 'lowres') {
        assert.ok(plan.scale >= 4 && plan.scale <= 6, 'lowres: масштаб 4-6 т/м, получено ' + plan.scale);
      }
      if (variant === 'toilets') {
        const small = plan.rooms.filter(function (r) { return r.area >= 0.95 && r.area <= 1.15; });
        assert.ok(small.length >= 3, 'toilets: есть маленькие санузлы 0.85x1.2 м');
      }
    });
  });

  // Проверка сглаживания (частичное покрытие крайних пикселей стен дает промежуточные оттенки)
  const clean = Synth.make('clean', 1);
  let midTone = 0;
  for (let i = 0; i < clean.rgba.length; i += 4) {
    const v = clean.rgba[i];
    if (v > 20 && v < 235) midTone += 1;
  }
  assert.ok(midTone > 0, 'clean: присутствуют сглаженные крайние пиксели');
});

test('вариант clean распознается текущим js/vision.js с F1 = 1 (самопроверка стенда)', function () {
  [1, 2, 3].forEach(function (seed) {
    const plan = Synth.make('clean', seed);
    const out = V.findRooms(plan.rgba, plan.w, plan.h, { scale: plan.scale });
    const m = Bench.matchRooms(plan.rooms, out.rooms, plan.w, plan.h, plan.scale);
    assert.equal(m.f1, 1, 'clean seed ' + seed + ': F1 = ' + m.f1 + ' (P=' + m.precision + ', R=' + m.recall + ')');
    assert.equal(m.splits, 0, 'clean seed ' + seed + ': без разрезов');
    assert.equal(m.merged, 0, 'clean seed ' + seed + ': без слияний');
    assert.ok(m.medErrPct !== null && m.medErrPct < 4, 'clean seed ' + seed + ': медианная ошибка площади ' + m.medErrPct + '%');
    assert.equal(m.under10Count, 0, 'clean seed ' + seed + ': нет занижения >10%');

    // Также проверяем двухпроходный режим по общей площади (как runBp)
    const byArea = Bench.recognize(plan.rgba, plan.w, plan.h, { areaM2: plan.meta.totalArea });
    const mArea = Bench.matchRooms(plan.rooms, byArea.out.rooms, plan.w, plan.h, byArea.scale);
    assert.equal(mArea.f1, 1, 'clean seed ' + seed + ' (по площади): F1 = ' + mArea.f1);
  });
});

test('растеризация и метрики стенда корректно считают IoU, разрезы, слияния и мусор', function () {
  const r1 = Bench.rasterizePoly([[10, 10], [30, 10], [30, 30], [10, 30]], 100, 100);
  const r2 = Bench.rasterizePoly([[20, 10], [40, 10], [40, 30], [20, 30]], 100, 100);
  assert.equal(r1.px, 400);
  assert.equal(Bench.intersectRasters(r1, r2), 200);

  // Разрез: одно эталонное помещение поделено на две половины
  const gtSplit = [{ name: 'Комната', poly: [[0, 0], [40, 0], [40, 20], [0, 20]], area: 8 }];
  const predSplit = [
    { px: 400, poly: [[0, 0], [20, 0], [20, 20], [0, 20]] },
    { px: 400, poly: [[20, 0], [40, 0], [40, 20], [20, 20]] }
  ];
  const ms = Bench.matchRooms(gtSplit, predSplit, 100, 100, 10);
  assert.equal(ms.splits, 1);
  assert.equal(ms.merged, 0);

  // Слияние: два эталонных помещения объединены в одно найденное
  const gtMerge = [
    { name: 'А', poly: [[0, 0], [20, 0], [20, 20], [0, 20]], area: 4 },
    { name: 'Б', poly: [[20, 0], [40, 0], [40, 20], [20, 20]], area: 4 }
  ];
  const predMerge = [{ px: 800, poly: [[0, 0], [40, 0], [40, 20], [0, 20]] }];
  const mm = Bench.matchRooms(gtMerge, predMerge, 100, 100, 10);
  assert.equal(mm.merged, 2);
  assert.equal(mm.mergeEvents, 1);

  // Мусор на реальном плане: точка подписи вне main_plan_box + 3%
  const ev = Bench.evalRealPlan(
    [{ lx: 50, ly: 50 }, { lx: 95, ly: 50 }],
    100, 100,
    { rooms: 1, roomsRange: [1, 2], box: [0.2, 0.2, 0.8, 0.8] }
  );
  assert.equal(ev.found, 2);
  assert.equal(ev.junk, 1);
  assert.equal(ev.inRange, true);
  assert.equal(ev.score, 0.5);
});
