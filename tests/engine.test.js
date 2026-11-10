// Тесты расчётного модуля. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../js/norms.js');
const E = require('../js/engine.js');
const P = require('../js/presets.js');

function room(name, area, extra) {
  return Object.assign({ name: name, area: area, category: 'PUB', classes: ['A', 'E'] }, extra || {});
}
function one(kind, r, options) {
  return E.calculate({ kind: kind, floors: [{ rooms: Array.isArray(r) ? r : [r] }] }, options);
}
function total(result, code, charge) {
  return result.totals.filter(t => t.code === code && (charge === undefined || t.charge === charge))
    .reduce((s, t) => s + t.count, 0);
}
function unitWith(result, floorIdx, roomName) {
  return result.floors[floorIdx].units.find(u => u.rooms.some(r => r.name === roomName));
}

// ---------- нормативные таблицы ----------

test('таблицы: размерность и формат ячеек', () => {
  for (const [g, row] of Object.entries(N.TABLE1)) {
    for (const [k, cells] of Object.entries(row.classes)) {
      assert.equal(cells.length, N.T1_COLUMNS.length, 'табл. 1 ' + g + ' ' + k);
      cells.forEach(c => assert.match(c, /^(-|\d+\+\+?)$/));
    }
  }
  for (const [g, row] of Object.entries(N.TABLE2)) {
    for (const [k, cells] of Object.entries(row.classes)) {
      assert.equal(cells.length, N.T2_COLUMNS.length, 'табл. 2 ' + g + ' ' + k);
      cells.forEach(c => assert.match(c, /^(-|\d+\+\+?)$/));
    }
  }
  assert.deepEqual(Object.values(N.TABLE1).map(r => r.area), [200, 400, 1800, 800]);
  assert.deepEqual(Object.values(N.TABLE2).map(r => r.area), [500, 800]);
  assert.deepEqual(N.DISTANCE, { PUBLIC: 20, ABV: 30, G: 40, D: 70 });
});

test('в каждой строке табл. 1 порошковый огнетушитель покрывает все её классы', () => {
  for (const row of Object.values(N.TABLE1)) {
    for (const cells of Object.values(row.classes)) {
      const powder = ['P2', 'P5', 'P10'].some(t => cells[N.T1_COLUMNS.indexOf(t)] !== '-');
      assert.ok(powder);
    }
  }
});

// ---------- сквозные примеры ----------

test('пример «бизнес-центр»: 6 × ОП-5 и 1 × ОУ-3', () => {
  const r = E.calculate(P.EXAMPLES.business.build());
  assert.equal(total(r, 'ОП-5', 'ABC(E)'), 6);
  assert.equal(total(r, 'ОУ-3'), 1);
  assert.equal(r.totals.length, 2);
  assert.equal(r.summary.portable, 7);
  assert.equal(r.summary.rooms, 8);
  assert.equal(r.summary.area, 720);
  assert.deepEqual(r.warnings, []);
});

test('пример «производственная база» считается без ошибок и предупреждений о пропусках', () => {
  const r = E.calculate(P.EXAMPLES.factory.build());
  // цех 1200 м² (В4, A+E): по площади 6 × ОП-5 (2 на 400), передвижные 2 × ОП-100 (1 на 800)
  const shop = unitWith(r, 0, 'Механический цех');
  assert.equal(shop.lines.find(l => l.kind === 'portable').count, 6);
  assert.equal(shop.lines.find(l => l.kind === 'wheeled').count, 2);
  // склад ЛВЖ 300 м² (Б, A+B): 1 × ОП-10 на 200 м² = 2
  assert.equal(unitWith(r, 0, 'Склад ЛВЖ и ГЖ').lines[0].code, 'ОП-10');
  assert.equal(unitWith(r, 0, 'Склад ЛВЖ и ГЖ').lines[0].count, 2);
  // склад 2000 м² (В3, A) с АУПТ: 10 → 5 × ОП-5, передвижные 3 × ОП-100
  const store = unitWith(r, 0, 'Склад готовой продукции');
  assert.equal(store.lines.find(l => l.kind === 'portable').count, 5);
  assert.equal(store.lines.find(l => l.kind === 'wheeled').count, 3);
  // компрессорная Д 80 м² — не оснащается
  assert.equal(unitWith(r, 0, 'Компрессорная').kind, 'exempt');
  // СТО 250 м²: 6 × ОП-5 и 3 × ОУ-2
  const sto = unitWith(r, 0, 'Участок ТО автотранспорта');
  assert.deepEqual(sto.lines.map(l => l.code + ':' + l.count), ['ОП-5:6', 'ОУ-2:3']);
  // архив: углекислотный
  assert.equal(unitWith(r, 1, 'Архив').lines[0].agent, 'co2');
  assert.ok(!r.warnings.some(w => /не найден|не указана/.test(w)));
});

// ---------- правила по отдельности ----------

test('п. 3: 450 м² общественного назначения — 3 шт., «по блокам» — 4 шт.', () => {
  assert.equal(total(one('industrial', room('Офисы', 450)), 'ОП-5'), 3);
  assert.equal(total(one('industrial', room('Офисы', 450), { rounding: 'block' }), 'ОП-5'), 4);
  assert.equal(total(one('industrial', room('Зал', 800)), 'ОП-5'), 4);
  assert.equal(total(one('industrial', room('Зал', 801)), 'ОП-5'), 5);
});

test('п. 5: на этаже общественного здания не менее двух ручных огнетушителей', () => {
  const r = one('public', room('Кабинет', 30));
  assert.equal(r.floors[0].portable.powder, 2);
  assert.ok(r.floors[0].units.some(u => u.kind === 'floorMin'));
  // в производственном здании п. 5 не применяется
  const ind = one('industrial', room('Кабинет', 30));
  assert.equal(ind.floors[0].portable.powder, 1);
  assert.ok(!ind.floors[0].units.some(u => u.kind === 'floorMin'));
  // пустой этаж и этаж без введённых площадей не дополняются
  assert.equal(E.calculate({ kind: 'public', floors: [{ rooms: [] }] }).summary.portable, 0);
  assert.equal(E.calculate({ kind: 'public', floors: [{ rooms: [room('Кабинет', '')] }] }).summary.portable, 0);
  // помещение категории Д менее 100 м² само огнетушителей не требует, но минимум на этаж остаётся
  assert.equal(one('public', room('Венткамера', 60, { category: 'CD', classes: ['A'] })).summary.portable, 2);
});

test('п. 6: категория Д менее 100 м² не оснащается, 100 м² и более — оснащается', () => {
  assert.equal(one('industrial', room('Насосная', 99, { category: 'CD', classes: ['A'] })).summary.portable, 0);
  assert.equal(one('industrial', room('Насосная', 100, { category: 'CD', classes: ['A'] })).summary.portable, 1);
});

test('п. 7: небольшие помещения одной категории считаются по суммарной площади', () => {
  const rooms = [1, 2, 3, 4].map(i => room('Кладовая ' + i, 10, { category: 'CV3', classes: ['A'] }));
  const pooled = one('industrial', rooms);
  assert.equal(pooled.floors[0].units.length, 1);
  assert.equal(pooled.floors[0].units[0].area, 40);
  assert.equal(pooled.summary.portable, 1);
  assert.equal(one('industrial', rooms, { poolSmallRooms: false }).summary.portable, 4);
});

test('п. 7: помещения с разными классами, но одинаковой нормой объединяются; разные категории — нет', () => {
  const r = one('industrial', [room('Офисы', 450), room('Коридор', 300, { classes: ['A'] })]);
  assert.equal(r.floors[0].units.length, 1);
  assert.deepEqual(r.floors[0].units[0].classes, ['A', 'E']);
  assert.equal(r.summary.portable, 4); // 750 × 4 / 800 = 3,75
  const r2 = one('industrial', [
    room('Склад 1', 100, { category: 'CV1', classes: ['A'] }),
    room('Склад 2', 100, { category: 'CV2', classes: ['A'] })
  ]);
  assert.equal(r2.floors[0].units.length, 2);
});

test('п. 7: размеры помещения не влияют на объединение', () => {
  const a = one('industrial', [room('К1', 10, { classes: ['A'] }), room('К2', 10, { classes: ['A'] })]);
  const b = one('industrial', [room('К1', 10, { classes: ['A'], length: 5, width: 2 }), room('К2', 10, { classes: ['A'] })]);
  assert.equal(a.summary.portable, 1);
  assert.equal(b.summary.portable, 1);
});

test('п. 9: помещение с электроникой — углекислотный огнетушитель', () => {
  const r = one('industrial', room('Серверная', 20, { sensitive: true }));
  assert.equal(r.totals.length, 1);
  assert.equal(r.totals[0].code, 'ОУ-3');
  assert.equal(r.floors[0].units[0].lines[0].viaP9, true);
  // категория Б: ОУ для класса A не допускается — A порошком, E углекислотным
  const b = one('industrial', room('Щитовая', 50, { category: 'CB', classes: ['A', 'E'], sensitive: true }));
  const lines = b.floors[0].units[0].lines;
  assert.deepEqual(lines.map(l => l.agent).sort(), ['co2', 'powder']);
  assert.deepEqual(lines.find(l => l.agent === 'co2').classes, ['E']);
});

test('п. 10: АУПТ — 50 % от нормы с округлением вверх', () => {
  assert.equal(one('industrial', room('Зал', 1600)).summary.portable, 8);
  assert.equal(one('industrial', room('Зал', 1600, { autoSuppression: true })).summary.portable, 4);
  assert.equal(one('industrial', room('Зал', 450, { autoSuppression: true })).summary.portable, 2); // 3 → 1,5 → 2
  assert.equal(E.calculate({ kind: 'industrial', autoSuppressionAll: true, floors: [{ rooms: [room('Зал', 1600)] }] }).summary.portable, 4);
});

test('выбор строки для категорий В1–В4 зависит от классов пожара', () => {
  assert.equal(E.rowKeyFor('CV2', ['A']), 'G2');
  assert.equal(E.rowKeyFor('CV2', ['A', 'B']), 'G1');
  assert.equal(E.rowKeyFor('CV2', ['C']), 'G1');
  assert.equal(E.rowKeyFor('CA', ['A']), 'G1');
  assert.equal(E.rowKeyFor('CG', ['A']), 'G3');
  assert.equal(E.rowKeyFor('PUB', ['A', 'E']), 'G4');
  // 300 м², В3: твёрдые — 2 × ОП-5 (2 на 400); с жидкостями — 2 × ОП-10 (1 на 200)
  assert.equal(total(one('industrial', room('Склад', 300, { category: 'CV3', classes: ['A'] })), 'ОП-5'), 2);
  assert.equal(total(one('industrial', room('Склад', 300, { category: 'CV3', classes: ['A', 'B'] })), 'ОП-10'), 2);
});

test('рекомендуемый «++» тип предпочитается допустимому «+»', () => {
  const u = one('industrial', room('Склад ГЖ', 300, { category: 'CB', classes: ['A', 'B'] })).floors[0].units[0];
  assert.equal(u.lines[0].code, 'ОП-10');
  assert.equal(u.lines[0].recommended, true);
  assert.ok(u.alternatives.some(a => a.code === 'ОП-5' && a.recommended === false && a.count === 3));
});

test('класс D подбирается отдельным огнетушителем с порошком D', () => {
  const lines = one('industrial', room('Участок', 100, { category: 'CV1', classes: ['A', 'D'] })).floors[0].units[0].lines;
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => l.charge).sort(), ['ABC(E)', 'D']);
});

test('класс, не предусмотренный строкой, считается по самой строгой строке с предупреждением', () => {
  // котельная: категория Г, классы A и C; C по строке «А, Б, В1–В4» — 1 × ОП-10 на 200 м²
  const r = one('industrial', room('Котельная', 80, { category: 'CG', classes: ['A', 'C'] }));
  const u = r.floors[0].units[0];
  assert.ok(u.lines.length >= 1);
  assert.ok(r.warnings.some(w => w.includes('не предусмотрен')));
  assert.ok(r.summary.portable >= 1);
  // общественное помещение с классом B
  const p = one('industrial', room('Лаборатория', 300, { classes: ['A', 'B'] }));
  assert.ok(p.warnings.some(w => w.includes('не предусмотрен')));
  // определяющий — класс B: 300 × 1 / 200 = 1,5 → 2 × ОП-10
  assert.equal(total(p, 'ОП-10'), 2);
});

test('ручной выбор типа и недопустимый тип', () => {
  const r = one('industrial', room('Офисы', 450, { forceType: 'P10' }));
  assert.equal(total(r, 'ОП-10'), 2); // 2 на 800 м²: 450 × 2 / 800 = 1,125 → 2
  assert.equal(r.floors[0].units[0].lines[0].forced, true);
  const bad = one('industrial', room('Склад ГЖ', 100, { category: 'CB', classes: ['A'], forceType: 'P2' }));
  assert.ok(bad.warnings.some(w => w.includes('не допускается')));
  assert.equal(bad.summary.portable, 1);
});

test('п. 4: число мест размещения', () => {
  assert.deepEqual(E.placement(6, 4, 20), { points: 1, wallPoints: 1 });
  assert.deepEqual(E.placement(30, 15, 20), { points: 1, wallPoints: 2 });
  assert.deepEqual(E.placement(100, 3, 20), { points: 3, wallPoints: 3 });
  assert.deepEqual(E.placement(60, 40, 20), { points: 4, wallPoints: null });
  assert.deepEqual(E.placement(50, 50, 20), { points: 4, wallPoints: null });
  assert.equal(E.placement(60, 40, 30).points, 2);
});

test('п. 4: длинный коридор — количество увеличивается по расстоянию', () => {
  const r = one('public', room('Коридор', 300, { classes: ['A'], length: 100, width: 3 }));
  assert.equal(total(r, 'ОП-5'), 3); // по площади 2, по расстоянию 3 места
  assert.equal(r.floors[0].units[0].placement[0].points, 3);
  // в производственном здании для категории Д предел 70 м
  const d = one('industrial', room('Цех', 3000, { category: 'CD', classes: ['A'], length: 100, width: 30 }));
  assert.equal(d.floors[0].units[0].placement[0].limit, 70);
});

test('табл. 2: передвижные для больших производственных и складских помещений', () => {
  const big = room('Склад', 2000, { category: 'CV3', classes: ['A'] });
  const r = one('warehouse', big);
  assert.equal(total(r, 'ОП-5'), 10);
  assert.equal(total(r, 'ОП-100'), 3);
  assert.equal(r.summary.wheeled, 3);
  assert.equal(total(one('warehouse', big, { wheeled: false }), 'ОП-100'), 0);
  // 800 м² — ещё не больше предельной
  assert.equal(total(one('warehouse', room('Склад', 800, { category: 'CV3', classes: ['A'] })), 'ОП-100'), 0);
  // категория Д и общественные помещения передвижными не оснащаются
  assert.equal(one('warehouse', room('Цех', 5000, { category: 'CD', classes: ['A'] })).summary.wheeled, 0);
  assert.equal(one('public', room('Зал', 5000)).summary.wheeled, 0);
});

test('табл. 5: СТО, АЗС, гаражи', () => {
  const sto = { name: 'СТО', area: 250, t5: 'sto' };
  let r = one('industrial', sto);
  assert.equal(total(r, 'ОП-5'), 6);
  assert.equal(total(r, 'ОУ-2'), 3);
  r = one('industrial', Object.assign({}, sto, { t5Alt: 1 }));
  assert.equal(total(r, 'ОП-10'), 3);
  assert.equal(total(r, 'ОП-5'), 0);
  r = one('industrial', { name: 'АЗС', area: 0, t5: 'azs_small' });
  assert.deepEqual(r.totals.map(t => t.code + ':' + t.count).sort(), ['ОП-10:1', 'ОП-100:1', 'ОП-5:2', 'ОУ-2:2'].sort());
  r = one('industrial', { name: 'Гаражи', area: 0, t5: 'garage_box', units: 12 });
  assert.equal(total(r, 'ОП-2'), 12);
  r = one('industrial', { name: 'Стоянка', area: 350, t5: 'parking_open' });
  assert.equal(total(r, 'ОП-5'), 8);
  assert.equal(r.summary.shields, 4);
});

test('сверка с фактическим наличием', () => {
  const b = P.EXAMPLES.business.build();
  const r = E.calculate(b);
  assert.deepEqual(r.floors[0].check, { requiredOP: 4, installedOP: 3, deficitOP: 1, requiredOU: 1, installedOU: 0, deficitOU: 1, ok: false });
  assert.equal(r.floors[1].check.ok, true);
  assert.equal(r.check.ok, false);
  assert.equal(r.check.deficitOP, 1);
  assert.equal(r.check.deficitOU, 1);
  b.floors.forEach(f => { f.installedOP = ''; f.installedOU = ''; });
  assert.equal(E.calculate(b).check, null);
  b.floors[0].installedOP = 0;
  assert.equal(E.calculate(b).check.deficitOP, 4);
});

// ---------- устойчивость и качество текста ----------

test('некорректный ввод не ломает расчёт', () => {
  assert.equal(E.calculate().summary.portable, 0);
  assert.equal(E.calculate({}).summary.portable, 0);
  const r = E.calculate({ kind: 'public', floors: [{ rooms: [
    { name: '', area: 'abc' }, { name: 'X', area: '12,5', classes: ['Z'] }, { name: 'Y', area: -5, category: 'NOPE' }
  ] }] });
  assert.ok(r.warnings.some(w => w.includes('не указана площадь')));
  assert.equal(r.summary.portable, 2);
});

test('у каждого шага есть ссылка на пункт норм, у каждой строки — расчёт', () => {
  [P.EXAMPLES.business.build(), P.EXAMPLES.factory.build()].forEach(input => {
    const r = E.calculate(input);
    r.floors.forEach(f => f.units.forEach(u => {
      assert.ok(u.steps.length > 0);
      u.steps.forEach(s => assert.ok(s.ref && s.text));
      u.lines.forEach(l => { assert.ok(l.count > 0); assert.ok(l.basis); });
    }));
  });
});

test('итог сходится с суммой по этажам', () => {
  [P.EXAMPLES.business.build(), P.EXAMPLES.factory.build()].forEach(input => {
    const r = E.calculate(input);
    const sum = r.floors.reduce((s, f) => s + f.units.reduce((a, u) => a + u.lines.reduce((b, l) => b + l.count, 0), 0), 0);
    assert.equal(r.totals.reduce((s, t) => s + t.count, 0), sum);
    assert.equal(r.summary.portable + r.summary.wheeled + r.summary.shields, sum);
    const byFloor = r.floors.reduce((s, f) => s + f.portable.powder + f.portable.co2 + f.portable.other, 0);
    assert.equal(byFloor, r.summary.portable);
  });
});

test('каждое назначение из справочника даёт расчёт', () => {
  Object.values(P.BY_ID).forEach(p => {
    const rm = Object.assign(P.blankRoom(p.id), { name: p.label, area: 120 });
    const r = E.calculate({ kind: 'industrial', floors: [{ rooms: [rm] }] });
    assert.ok(r.floors[0].units.length === 1, p.id);
    assert.ok(r.summary.portable >= 1, p.id);
  });
});

test('в допущения попадает только применённое, methodology даёт полный перечень', () => {
  const office = one('public', room('Кабинет', 30));
  assert.ok(!office.assumptions.some(a => a.includes('Передвижные')));
  assert.ok(!office.assumptions.some(a => a.includes('АУПТ')));
  assert.ok(!office.assumptions.some(a => a.includes('Пункт 7')));
  const big = one('warehouse', room('Склад', 2000, { category: 'CV3', classes: ['A'], autoSuppression: true }));
  assert.ok(big.assumptions.some(a => a.includes('Передвижные')));
  assert.ok(big.assumptions.some(a => a.includes('АУПТ')));
  assert.ok(big.assumptions.some(a => a.includes('В1–В4')));
  const all = E.methodology();
  assert.ok(all.length > office.assumptions.length);
  office.assumptions.concat(big.assumptions).forEach(a => assert.ok(all.includes(a) || a.includes('20 м'), a));
});

test('код для QR содержит только латиницу и цифры', () => {
  const r = E.calculate(P.EXAMPLES.factory.build());
  assert.match(E.summaryCode(r), /^[A-Za-z0-9\-();x]+$/);
});
