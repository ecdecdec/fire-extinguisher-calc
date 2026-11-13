// Пересчёт: независимая проверка расчёта.
//   1. Эталонные примеры — посчитаны вручную по таблицам Приложения 3 (см. комментарии).
//   2. Свойства на тысячах случайных объектов: допустимые типы, формула количества,
//      серверная без порошка, минимум на этаж, итог = сумма строк, количество не
//      уменьшается при росте площади, объединение (п. 7) не даёт больше раздельного расчёта.
//   3. Места размещения (п. 4): найденное число мест действительно закрывает помещение.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../js/norms.js');
const E = require('../js/engine.js');
const P = require('../js/presets.js');

function room(purpose, area, extra) { return Object.assign(P.blankRoom(purpose), { area: area }, extra || {}); }
function calc(kind, rooms, options) { return E.calculate({ kind: kind, floors: [{ rooms: rooms }] }, options); }
function totals(r) {
  const out = {};
  r.totals.forEach(t => { const k = t.code + (t.charge === 'D' ? ' (D)' : ''); out[k] = (out[k] || 0) + t.count; });
  return out;
}

// ---------- 1. эталоны ----------
// Табл. 1, строки: «Общественные здания» 800 м² (ОП-5: A 4++, E 4++; ОУ-3: A 4+, E 2++),
// «В1–В4 твёрдые» 400 м² (ОП-5: A 2++, E 2++), «А, Б, В1–В4 газы и жидкости» 200 м²
// (ОП-10: A 1++, B 1++, C 1++; ОП-5: A 2+, B 2+), «Г и Д» 1800 м² (ОП-5: A 2++, E 2++).
// Табл. 2: «В1–В4 твёрдые, Г» 800 м² (ОП-100: 1++), «А, Б, В газы и жидкости» 500 м² (ОП-100: 1++).
const GOLDEN = [
  ['кабинет 450 м²: 450 × 4 / 800 = 2,25 → 3', 'public', [room('office', 450)], {}, { 'ОП-5': 3 }],
  ['кабинет 30 м²: 1 по площади + 1 до минимума на этаж (п. 5)', 'public', [room('office', 30)], {}, { 'ОП-5': 2 }],
  ['кабинет 800 м²: 800 × 4 / 800 = 4', 'public', [room('office', 800)], {}, { 'ОП-5': 4 }],
  ['кабинет 801 м²: 4,005 → 5', 'public', [room('office', 801)], {}, { 'ОП-5': 5 }],
  ['зал 1600 м²: 8', 'public', [room('hall', 1600)], {}, { 'ОП-5': 8 }],
  ['два кабинета по 450 м² — по сумме (п. 7): 900 × 4 / 800 = 4,5 → 5', 'public', [room('office', 450), room('office', 450)], {}, { 'ОП-5': 5 }],
  ['два кабинета по 450 м² без объединения: 3 + 3', 'public', [room('office', 450), room('office', 450)], { poolSmallRooms: false }, { 'ОП-5': 6 }],
  ['двенадцать кабинетов по 150 м²: 1800 × 4 / 800 = 9', 'public', [room('office', 150, { count: 12 })], {}, { 'ОП-5': 9 }],
  ['три зала по 900 м²: по 4,5 → 5, всего 15', 'public', [room('hall', 900, { count: 3 })], {}, { 'ОП-5': 15 }],
  ['серверная 20 м²: ОУ-3 (п. 9), до минимума на этаж — тоже ОУ-3', 'public', [room('server', 20)], {}, { 'ОУ-3': 2 }],
  ['серверная 20 м² и кабинет 50 м²', 'public', [room('server', 20), room('office', 50)], {}, { 'ОП-5': 1, 'ОУ-3': 1 }],
  ['архив 30 м² (В3): ОУ-3, 30 × 2 / 400 → 1, и 1 до минимума', 'public', [room('archive', 30)], {}, { 'ОУ-3': 2 }],
  ['склад 2000 м² (В3): 2000 × 2 / 400 = 10; передвижные 2000 / 800 = 2,5 → 3', 'industrial', [room('store_solid', 2000)], {}, { 'ОП-5': 10, 'ОП-100': 3 }],
  ['тот же склад с АУПТ: ручных 50 % — 5, передвижные не уменьшаются', 'industrial', [room('store_solid', 2000, { autoSuppression: true })], {}, { 'ОП-5': 5, 'ОП-100': 3 }],
  ['склад 800 м² — ровно предельная по табл. 2, передвижных нет', 'warehouse', [room('store_solid', 800)], {}, { 'ОП-5': 4 }],
  ['склад 801 м²: 5 переносных, передвижных 801 / 800 → 2', 'warehouse', [room('store_solid', 801)], {}, { 'ОП-5': 5, 'ОП-100': 2 }],
  ['склад ЛВЖ 300 м² (Б): ОП-10, 300 / 200 = 1,5 → 2', 'industrial', [room('store_liquid', 300)], {}, { 'ОП-10': 2 }],
  ['склад ЛВЖ 600 м² (Б): 3 × ОП-10; передвижные 600 / 500 → 2', 'industrial', [room('store_liquid', 600)], {}, { 'ОП-10': 3, 'ОП-100': 2 }],
  ['категория Д 60 м² в производственном здании — не оснащается (п. 6)', 'industrial', [room('noncomb', 60)], {}, {}],
  ['категория Д 60 м² в общественном здании — минимум на этаж остаётся', 'public', [room('noncomb', 60)], {}, { 'ОП-5': 2 }],
  ['категория Д 100 м²: 100 × 2 / 1800 → 1, и 1 до минимума', 'industrial', [room('noncomb', 100)], {}, { 'ОП-5': 2 }],
  ['котельная 90 м² (Г, A и E): 1 и 1 до минимума', 'industrial', [room('boiler', 90)], {}, { 'ОП-5': 2 }],
  ['котельная 90 м² с газом (A и C): класс C — по самой строгой строке, ОП-10 «++»', 'industrial', [room('boiler', 90, { classes: ['A', 'C'] })], {}, { 'ОП-10': 1, 'ОП-5': 1 }],
  ['электрощитовая 25 м² (В4): 1 и 1 до минимума', 'industrial', [room('electro', 25)], {}, { 'ОП-5': 2 }],
  ['цех 300 м² с металлами (A и D): 2 × ОП-5 и отдельно 1 × ОП-10 с порошком D', 'industrial', [room('workshop', 300, { classes: ['A', 'D'] })], {}, { 'ОП-5': 2, 'ОП-10 (D)': 1 }],
  ['помещение категории А с жидкостями 50 м² в общественном здании', 'public', [room('custom', 50, { category: 'CA', classes: ['B'] })], {}, { 'ОП-10': 1, 'ОП-5': 1 }],
  ['кабинет 450 м² с АУПТ: 3 × 50 % = 1,5 → 2', 'public', [room('office', 450, { autoSuppression: true })], {}, { 'ОП-5': 2 }],
  ['кабинет 450 м², «полными комплектами»: начатые 800 м² — все 4', 'public', [room('office', 450)], { rounding: 'block' }, { 'ОП-5': 4 }],
  ['коридор 100 × 3 м: по площади 2, по расстоянию 20 м — 3 места', 'public', [room('corridor', 300, { length: 100, width: 3 })], {}, { 'ОП-5': 3 }],
  ['кабинет 30 × 15 м: одного места хватает — 3 по площади', 'public', [room('office', 450, { length: 30, width: 15 })], {}, { 'ОП-5': 3 }],
  ['СТО 250 м²: 3 комплекта по 2 × ОП-5 и 1 × ОУ-2', 'industrial', [room('t5_sto', 250)], {}, { 'ОП-5': 6, 'ОУ-2': 3 }],
  ['12 гаражей: по ОП-2 на гараж', 'industrial', [room('t5_garage', 0, { count: 12 })], {}, { 'ОП-2': 12 }],
  ['АЗС менее 500 заправок: постоянный набор', 'industrial', [room('t5_azs_small', 0)], {}, { 'ОП-5': 2, 'ОП-10': 1, 'ОП-100': 1, 'ОУ-2': 2 }],
  ['открытая стоянка 350 м²: 4 комплекта', 'industrial', [room('t5_parking', 350)], {}, { 'ОП-5': 8, 'ЩП-В': 4 }],
  ['производственное здание без минимума на этаж: кабинет 30 м² — 1', 'industrial', [room('office', 30)], { floorMinAll: false }, { 'ОП-5': 1 }]
];

GOLDEN.forEach(([title, kind, rooms, options, expected]) => {
  test('эталон: ' + title, () => {
    assert.deepEqual(totals(calc(kind, rooms, options)), expected);
  });
});

// ---------- 2. свойства на случайных объектах ----------

const { mulberry32, randomObject, randomOptions } = require('./helpers.js');

function grandTotal(r) { return r.summary.portable + r.summary.wheeled + r.summary.shields; }

// Проверяет расчёт по правилам, не повторяя код модуля: ячейки и предельные площади берутся
// из строки нормативной таблицы, показанной в расчёте (unit.matrix).
function checkInvariants(input, opts, r, label) {
  const sum = {};
  r.floors.forEach(f => f.units.forEach(u => u.lines.forEach(l => {
    assert.ok(Number.isInteger(l.count) && l.count >= 0, label + ': количество — целое неотрицательное');
    const k = l.kind + '|' + l.code + '|' + l.charge;
    sum[k] = (sum[k] || 0) + l.count;
  })));
  r.totals.forEach(t => {
    const k = t.kind + '|' + t.code + '|' + t.charge;
    assert.equal(t.count, sum[k], label + ': итог ' + t.code + ' = сумма строк');
    delete sum[k];
  });
  Object.keys(sum).forEach(k => assert.equal(sum[k], 0, label + ': строка ' + k + ' без итога'));
  assert.equal(r.summary.portable + r.summary.wheeled + r.summary.shields, r.totals.reduce((s, t) => s + t.count, 0), label + ': сводка');

  r.floors.forEach((f, fi) => {
    f.units.forEach(u => {
      if (u.kind !== 'table1') return;
      const cols = u.matrix.columns.map(c => c.id);
      const where = label + ', этаж ' + (fi + 1) + ', «' + u.title + '»';
      // выбранные ячейки — допустимые; каждый класс закрыт (если нет предупреждения)
      const notFound = u.warnings.some(w => w.includes('не найден'));
      u.matrix.rows.forEach(row => {
        row.cells.forEach(c => { if (c.chosen) assert.notEqual(c.mark, '-', where + ': выбран недопустимый тип для класса ' + row.cls); });
        if (!notFound) assert.ok(row.cells.some(c => c.chosen), where + ': класс ' + row.cls + ' не закрыт');
      });
      // количество: по самому требовательному классу; АУПТ — 50 %; одинаковые помещения — умножение
      u.lines.forEach((l, li) => {
        if (l.kind !== 'portable') return;
        const ci = cols.indexOf(l.typeId);
        assert.ok(ci >= 0, where + ': тип ' + l.code + ' в строке таблицы');
        let base = 0;
        l.classes.forEach(k => {
          const row = u.matrix.rows.find(x => x.cls === k), cell = row.cells[ci];
          const q = opts.rounding === 'block'
            ? Math.ceil(u.area / row.area - 1e-9) * cell.n
            : Math.max(1, Math.ceil(u.area * cell.n / row.area - 1e-9));
          base = Math.max(base, q);
        });
        let exp = u.autoSuppression ? Math.max(1, Math.ceil(base * 0.5 - 1e-9)) : base;
        exp *= u.count;
        if (li === 0 && u.placement.length) {
          assert.ok(l.count >= exp && (l.count - exp) % u.count === 0, where + ': ' + l.code + ' ' + l.count + ' (по площади ' + exp + ')');
        } else {
          assert.equal(l.count, exp, where + ': ' + l.code);
        }
      });
      // помещение с электроникой: порошковый — только для класса, который углекислотный не закрывает
      if (u.sensitive) {
        const co2 = ['C2', 'C35'].map(id => cols.indexOf(id)).filter(i => i >= 0);
        u.lines.forEach(l => {
          if (l.agent !== 'powder' || l.kind !== 'portable') return;
          l.classes.forEach(k => {
            const row = u.matrix.rows.find(x => x.cls === k);
            assert.ok(co2.every(i => row.cells[i].mark === '-'), where + ': порошковый в помещении с электроникой для класса ' + k);
          });
        });
      }
    });
    // минимум на этаж
    const portable = f.portable.powder + f.portable.co2 + f.portable.other;
    if (input.kind === 'public' && f.units.length) assert.ok(portable >= 2, label + ': этаж ' + (fi + 1) + ' общественного здания — не менее двух');
    if (input.kind !== 'public' && opts.floorMinAll && f.units.some(u => u.kind === 'table1')) {
      assert.ok(portable >= 2, label + ': этаж ' + (fi + 1) + ' — не менее двух (параметр расчёта)');
    }
  });
}

test('свойства на 3000 случайных объектах: типы, формула, серверная, минимум, итоги', () => {
  const rnd = mulberry32(20261113);
  for (let i = 0; i < 3000; i++) {
    const input = randomObject(rnd, i), opts = randomOptions(rnd);
    checkInvariants(input, opts, E.calculate(input, opts), 'объект ' + i + ' ' + JSON.stringify(opts));
  }
});

test('количество не уменьшается, когда площадь помещения растёт или добавляется помещение', () => {
  const rnd = mulberry32(7);
  let checked = 0;
  for (let i = 0; i < 1500; i++) {
    const input = randomObject(rnd, i), opts = randomOptions(rnd);
    const before = grandTotal(E.calculate(input, opts));
    const rooms = [];
    input.floors.forEach(f => f.rooms.forEach(r => { if (!r.t5 || r.area > 0) rooms.push(r); }));
    if (!rooms.length) continue;
    const r = rooms[Math.floor(rnd() * rooms.length)];
    const old = r.area;
    r.area = Math.round((Number(old) + 1 + rnd() * 500) * 10) / 10;
    const after = grandTotal(E.calculate(input, opts));
    assert.ok(after >= before, 'объект ' + i + ': площадь «' + r.name + '» ' + old + ' → ' + r.area + ' м², огнетушителей ' + before + ' → ' + after);
    r.area = old;
    // добавленное помещение тоже не уменьшает итог
    const extra = Object.assign(P.blankRoom('office'), { id: 'extra' + i, name: 'Доп', area: 10 + Math.round(rnd() * 300) });
    input.floors[0].rooms.push(extra);
    assert.ok(grandTotal(E.calculate(input, opts)) >= before, 'объект ' + i + ': добавлено помещение — итог уменьшился');
    checked += 1;
  }
  assert.ok(checked > 1000);
});

test('объединение небольших помещений (п. 7) не даёт больше, чем раздельный расчёт', () => {
  const rnd = mulberry32(99);
  for (let i = 0; i < 1500; i++) {
    const input = randomObject(rnd, i), opts = randomOptions(rnd);
    const pooled = grandTotal(E.calculate(input, Object.assign({}, opts, { poolSmallRooms: true })));
    const apart = grandTotal(E.calculate(input, Object.assign({}, opts, { poolSmallRooms: false })));
    assert.ok(pooled <= apart, 'объект ' + i + ': по сумме ' + pooled + ', по отдельности ' + apart);
  }
});

// ---------- 3. места размещения (п. 4) ----------

// Наибольшее расстояние от точки помещения L × W до ближайшего из мест — по сетке проб.
function farthest(L, W, spots) {
  let worst = 0;
  const steps = 60;
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const x = L * i / steps, y = W * j / steps;
    let best = Infinity;
    spots.forEach(s => { best = Math.min(best, Math.hypot(x - s[0], y - s[1])); });
    worst = Math.max(worst, best);
  }
  return worst;
}

test('п. 4: найденное число мест закрывает помещение, у стен — тоже', () => {
  const rnd = mulberry32(4);
  for (let n = 0; n < 400; n++) {
    const L = 2 + rnd() * 150, W = 2 + rnd() * 60, R = [20, 30, 40, 70][Math.floor(rnd() * 4)];
    const p = E.placement(L, W, R);
    // расстановка сеткой: ищется сетка kx × ky с тем же числом мест, которая закрывает помещение
    let covered = false;
    for (let kx = 1; kx <= p.points && !covered; kx++) {
      if (p.points % kx) continue;
      const ky = p.points / kx, spots = [];
      for (let i = 0; i < kx; i++) for (let j = 0; j < ky; j++) spots.push([L * (2 * i + 1) / (2 * kx), W * (2 * j + 1) / (2 * ky)]);
      if (farthest(L, W, spots) <= R * 1.01) covered = true;
    }
    assert.ok(covered, L.toFixed(1) + ' × ' + W.toFixed(1) + ' м, R = ' + R + ': ' + p.points + ' мест не закрывают помещение');
    // одного места меньше сеткой не хватает (иначе расчёт завышает)
    if (p.points > 1) {
      let fewer = false;
      for (let kx = 1; kx < p.points && !fewer; kx++) {
        const ky = Math.ceil((p.points - 1) / kx);
        if (kx * ky > p.points - 1) continue;
        const spots = [];
        for (let i = 0; i < kx; i++) for (let j = 0; j < ky; j++) spots.push([L * (2 * i + 1) / (2 * kx), W * (2 * j + 1) / (2 * ky)]);
        if (farthest(L, W, spots) <= R * 0.99) fewer = true;
      }
      assert.ok(!fewer, L.toFixed(1) + ' × ' + W.toFixed(1) + ' м, R = ' + R + ': хватило бы ' + (p.points - 1));
    }
  }
});
