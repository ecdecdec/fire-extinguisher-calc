// Тесты схемы этажа, перечня нарушений и ссылки на расчёт. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');
const P = require('../js/presets.js');
const PL = require('../js/plan.js');
const SH = require('../js/share.js');

function room(id, name, area, extra) {
  return Object.assign({ id: id, name: name, area: area, category: 'PUB', classes: ['A', 'E'] }, extra || {});
}
function check(input, options) {
  const result = E.calculate(input, options);
  return { input: input, result: result, audit: PL.audit(input, result) };
}
function count(ext, t) { return ext.filter(e => e.t === t).length; }

// ---------- расчёт: помещения с электроникой ----------

test('в помещении с электроникой порошковый не предлагается и вручную не выбирается', () => {
  const r = E.calculate({ kind: 'public', floors: [{ rooms: [room('s', 'Серверная', 20, { sensitive: true }), room('o', 'Офис', 50)] }] });
  const server = r.floors[0].units.find(u => u.title === 'Серверная');
  assert.equal(server.lines[0].code, 'ОУ-3');
  assert.deepEqual(server.alternatives, []);
  const forced = E.calculate({ kind: 'public', floors: [{ rooms: [room('s', 'Серверная', 20, { sensitive: true, forceType: 'P5' }), room('o', 'Офис', 50)] }] });
  assert.equal(forced.floors[0].units.find(u => u.title === 'Серверная').lines[0].code, 'ОУ-3');
  assert.ok(forced.warnings.some(w => w.includes('не применяется')));
  // обычному помещению порошковый по-прежнему можно выбрать вручную
  const office = r.floors[0].units.find(u => u.title === 'Офис');
  assert.ok(office.alternatives.some(a => a.code === 'ОП-10'));
});

test('этаж только из серверных: минимум на этаж добирается углекислотным', () => {
  const r = E.calculate({ kind: 'public', floors: [{ rooms: [room('s', 'Серверная', 20, { sensitive: true })] }] });
  assert.deepEqual(r.totals.map(t => t.code + ':' + t.count), ['ОУ-3:2']);
  assert.equal(r.floors[0].portable.powder, 0);
});

test('коридор без размеров и неправдоподобная площадь дают предупреждения', () => {
  const corridor = Object.assign(P.blankRoom('corridor'), { id: 'c', name: 'Коридор', area: 120 });
  const r = E.calculate({ kind: 'public', floors: [{ rooms: [corridor] }] });
  assert.ok(r.warnings.some(w => w.includes('не проверено')));
  const withDims = E.calculate({ kind: 'public', floors: [{ rooms: [Object.assign({}, corridor, { length: 60, width: 2 })] }] });
  assert.ok(!withDims.warnings.some(w => w.includes('не проверено')));
  assert.equal(withDims.summary.portable, 2); // по площади 1, по расстоянию 2 места
  const short = E.calculate({ kind: 'public', floors: [{ rooms: [Object.assign({}, corridor, { area: 40 })] }] });
  assert.deepEqual(short.warnings, []);
  const typo = E.calculate({ kind: 'public', floors: [{ rooms: [room('z', 'Зал', 1e9)] }] });
  assert.ok(typo.warnings.some(w => w.includes('проверьте ввод')));
});

test('назначение по имени помещения: серверная не остаётся кабинетом', () => {
  const g = P.guessPurpose;
  [['Серверная', 'server'], ['серверная № 2', 'server'], ['Узел связи', 'server'], ['АТС', 'server'], ['Помещение АТС', 'server'],
    ['Архив', 'archive'], ['Выставочный зал', 'museum'], ['Электрощитовая', 'electro'], ['Щитовая', 'electro'], ['ГРЩ', 'electro'],
    ['Склад ЛВЖ', 'store_liquid'], ['Склад', 'store_solid'], ['Котельная', 'boiler'], ['Венткамера', 'vent'], ['ИТП', 'vent'],
    ['Кладовая', 'storeroom'], ['Механический цех', 'workshop'], ['Коридор 2 этажа', 'corridor'], ['Вестибюль', 'corridor'],
    ['Обеденный зал', 'canteen'], ['Торговый зал', 'shopfloor'], ['Актовый зал', 'hall'], ['Учебный класс', 'classroom'],
    ['Кабинет директора', 'office'], ['Приёмная', 'office'], ['Палата', 'ward']
  ].forEach(([name, id]) => assert.equal(g(name), id, name));
  // сокращения ищутся как отдельные слова, неизвестное и пустое имя — без догадок
  [['Статистика', null], ['Лаборатория', null], ['', null], [null, null]].forEach(([name, id]) => assert.equal(g(name), id, String(name)));
  // каждое угаданное назначение есть в справочнике, и серверная по имени считается углекислотным
  const server = Object.assign(P.blankRoom('office'), { name: 'Серверная', area: 20 });
  P.applyPurpose(server, g(server.name));
  const r = E.calculate({ kind: 'public', floors: [{ rooms: [server] }] });
  assert.deepEqual(r.totals.map(t => t.code + ':' + t.count), ['ОУ-3:2']);
});

// ---------- схема: расположение ----------

test('схема строится сама: точные и условные прямоугольники, копии, коридор посередине', () => {
  const floor = { rooms: [
    Object.assign(P.blankRoom('corridor'), { id: 'c', name: 'Коридор', area: 60, length: 30, width: 2 }),
    room('a', 'Кабинет', 18, { count: 4 }),
    room('b', 'Зал', 60, { length: 10, width: 6 }),
    room('n', 'Без площади', '')
  ] };
  const inst = PL.instances(floor, { kind: 'public' }, 0);
  assert.equal(inst.list.length, 6); // коридор + 4 кабинета + зал; помещение без площади не рисуется
  assert.deepEqual(inst.list.map(r => r.approx), [false, true, true, true, true, false]);
  inst.list.forEach(r => assert.equal(r.limit, 20));
  const cab = inst.list[1];
  assert.ok(Math.abs(cab.w * cab.h - 18) < 1e-9);
  const rects = PL.layout(inst.list, null);
  const spine = rects[0];
  assert.deepEqual([spine.x, spine.y], [0, 0]);
  // остальные примыкают к коридору сверху или снизу и не пересекаются
  rects.slice(1).forEach(r => assert.ok(Math.abs(r.y + r.h) < 1e-9 || Math.abs(r.y - spine.h) < 1e-9, r.key));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
      assert.ok(!overlap, a.key + ' и ' + b.key);
    }
  }
});

test('расположение можно закрепить; новые помещения встают ниже; перетаскивание прилипает к стенам', () => {
  const list = PL.instances({ rooms: [room('a', 'А', 100, { length: 10, width: 10 }), room('b', 'Б', 100, { length: 10, width: 10 })] }, { kind: 'public' }, 0).list;
  const pos = PL.freeze(PL.layout(list, null));
  pos['b:0'] = [40, 0];
  const more = PL.instances({ rooms: [room('a', 'А', 100, { length: 10, width: 10 }), room('b', 'Б', 100, { length: 10, width: 10 }), room('c', 'В', 25, { length: 5, width: 5 })] }, { kind: 'public' }, 0).list;
  const rects = PL.layout(more, pos);
  assert.deepEqual([rects[1].x, rects[1].y], [40, 0]);
  assert.ok(rects[2].y >= 10, 'новое помещение ниже остальных');
  // помещение Б отпущено рядом с правой стеной А — встаёт вплотную
  assert.deepEqual(PL.snap(rects, 'b:0', 10.4, 0.3), [10, 0]);
  // вдали от соседей — по сетке 0,5 м
  assert.deepEqual(PL.snap(rects, 'b:0', 70.26, 33.1), [70.5, 33]);
  assert.equal(PL.at(rects, 5, 5).key, 'a:0');
  assert.equal(PL.at(rects, 500, 500), null);
});

// ---------- схема: расстояние и нарушения ----------

test('пример «бизнес-центр»: три нарушения на первом этаже, второй этаж в норме', () => {
  const x = check(P.EXAMPLES.business.build());
  assert.equal(x.result.floors[0].fromPlan, true);
  assert.equal(x.audit.status, 'bad');
  assert.equal(x.audit.checked, 2);
  assert.deepEqual(x.audit.findings.map(f => f.floor), ['1 этаж', '1 этаж', '1 этаж']);
  const text = x.audit.findings.map(f => f.text).join('\n');
  assert.ok(text.includes('Порошковых огнетушителей (ОП) 3 из 4 требуемых — не хватает 1.'));
  assert.ok(text.includes('Углекислотных огнетушителей (ОУ) 0 из 1 требуемых — не хватает 1.'));
  assert.ok(text.includes('«Серверная»: стоит порошковый огнетушитель'));
  assert.ok(x.audit.findings.every(f => f.level === 'bad' && f.ref.startsWith('Прил. 3')));
  assert.equal(x.audit.floors[0].cover.bad, 0);
  assert.deepEqual(x.audit.floors[1].findings, []);
});

test('отмеченное на схеме заменяет вписанные числа; метки несуществующих помещений не считаются', () => {
  const input = { kind: 'public', floors: [{ installedOP: 9, installedOU: 9, rooms: [room('o', 'Офис', 200, { length: 20, width: 10 })],
    plan: { ext: [{ k: 'o:0', u: 0.5, v: 0.5, t: 'op' }, { k: 'gone:0', u: 0.5, v: 0.5, t: 'op' }, { k: 'o:7', u: 0.5, v: 0.5, t: 'ou' }] } }] };
  const x = check(input);
  assert.deepEqual([x.result.floors[0].check.installedOP, x.result.floors[0].check.installedOU], [1, 0]);
  assert.equal(x.audit.floors[0].ext.length, 1);
  // без меток работают вписанные числа
  input.floors[0].plan.ext = [];
  assert.equal(E.calculate(input).floors[0].check.installedOP, 9);
  assert.equal(E.calculate(input).floors[0].fromPlan, false);
});

test('п. 4 на схеме: в длинном коридоре с одним огнетушителем часть площади дальше нормы', () => {
  const corridor = Object.assign(P.blankRoom('corridor'), { id: 'c', name: 'Коридор', area: 120, length: 60, width: 2 });
  const input = { kind: 'public', floors: [{ rooms: [corridor], plan: { ext: [{ k: 'c:0', u: 0.02, v: 0.5, t: 'op' }] } }] };
  const x = check(input);
  const far = x.audit.findings.find(f => f.ref === 'Прил. 3, п. 4');
  assert.ok(far, 'есть нарушение по расстоянию');
  assert.equal(far.level, 'bad');
  assert.ok(/до ближайшего огнетушителя до 5\d(,\d)? м при норме не более 20 м/.test(far.text), far.text);
  assert.ok(x.audit.floors[0].cover.share > 0.6 && x.audit.floors[0].cover.share < 0.7);
  // два огнетушителя на четверти и трёх четвертях длины закрывают коридор
  input.floors[0].plan.ext = [{ k: 'c:0', u: 0.25, v: 0.5, t: 'op' }, { k: 'c:0', u: 0.75, v: 0.5, t: 'op' }];
  assert.equal(check(input).audit.floors[0].cover.bad, 0);
  // без размеров форма условная — это не нарушение, а «проверить на месте»
  const noDims = { kind: 'public', floors: [{ rooms: [Object.assign({}, corridor, { length: '', width: '' })], plan: { ext: [{ k: 'c:0', u: 0.02, v: 0.5, t: 'op' }] } }] };
  assert.equal(check(noDims).audit.findings.find(f => f.ref === 'Прил. 3, п. 4').level, 'warn');
  // пока на схеме ничего не отмечено, расстояние не проверяется
  input.floors[0].plan.ext = [];
  assert.deepEqual(check(input).audit.findings, []);
});

test('порошковый в серверной — нарушение; где табл. 1 сама требует порошковый — нет', () => {
  const input = { kind: 'public', floors: [{ rooms: [room('s', 'Серверная', 20, { sensitive: true }), room('o', 'Офис', 100)],
    plan: { ext: [{ k: 's:0', u: 0.5, v: 0.5, t: 'ou' }, { k: 'o:0', u: 0.5, v: 0.5, t: 'op' }] } }] };
  assert.deepEqual(check(input).audit.findings, []);
  input.floors[0].plan.ext[0].t = 'op';
  const bad = check(input).audit.findings.map(f => f.text).join('\n');
  assert.ok(bad.includes('«Серверная»: стоит порошковый огнетушитель'));
  // категория Б: класс A углекислотным не закрыть — порошковый в таком помещении положен
  const b = { kind: 'industrial', floors: [{ rooms: [room('p', 'Пультовая', 50, { category: 'CB', sensitive: true })],
    plan: { ext: [{ k: 'p:0', u: 0.3, v: 0.5, t: 'op' }, { k: 'p:0', u: 0.7, v: 0.5, t: 'ou' }] } }] };
  assert.ok(!check(b).audit.findings.some(f => f.text.includes('стоит порошковый')));
});

// ---------- расстановка по нормам ----------

test('расстановка по нормам: столько, сколько по расчёту, и без мест дальше нормы', () => {
  [P.EXAMPLES.business.build(), P.EXAMPLES.factory.build()].forEach(input => {
    input.floors.forEach((f, fi) => f.rooms.forEach((r, ri) => { r.id = r.id || ('x' + fi + '_' + ri); }));
    const result = E.calculate(input);
    input.floors.forEach((floor, fi) => {
      const rects = PL.layout(PL.instances(floor, result.building, fi).list, null);
      const want = PL.scene(rects, PL.propose(rects, result.floors[fi]));
      const fr = result.floors[fi];
      const onPlan = id => rects.some(r => r.roomId === id);
      // порошковых и углекислотных — как по расчёту (кроме объектов без площади, которых нет на схеме)
      const need = { op: 0, ou: 0 };
      fr.units.forEach(u => u.lines.forEach(l => {
        if (l.kind !== 'portable' || !(u.kind === 'floorMin' || u.rooms.some(r => onPlan(r.id)))) return;
        need[l.agent === 'powder' ? 'op' : 'ou'] += l.count;
      }));
      const norm = want.ext.filter(e => !e.extra);
      assert.deepEqual({ op: count(norm, 'op'), ou: count(norm, 'ou') }, need, input.building.name + ', ' + fr.name);
      assert.equal(want.cover.bad, 0, 'всё в пределах нормы: ' + fr.name);
      // порошковый попадает в помещение с электроникой, только если так требует расчёт
      want.ext.forEach(e => {
        if (e.t !== 'op' || !e.rect.sensitive) return;
        const unit = fr.units.find(u => u.rooms.some(r => r.id === e.rect.roomId));
        assert.ok(unit.lines.some(l => l.agent === 'powder'));
      });
    });
  });
});

test('расстановка: большой зал закрывается местами в глубине, длинный коридор — вдоль стен', () => {
  const hall = { kind: 'public', floors: [{ rooms: [room('h', 'Зал', 2400, { length: 60, width: 40 })] }] };
  let result = E.calculate(hall);
  let rects = PL.layout(PL.instances(hall.floors[0], result.building, 0).list, null);
  let want = PL.scene(rects, PL.propose(rects, result.floors[0]));
  assert.equal(count(want.ext, 'op'), 12);
  assert.equal(want.cover.bad, 0);
  const corridor = { kind: 'public', floors: [{ rooms: [Object.assign(P.blankRoom('corridor'), { id: 'c', name: 'Коридор', area: 300, length: 100, width: 3 })] }] };
  result = E.calculate(corridor);
  rects = PL.layout(PL.instances(corridor.floors[0], result.building, 0).list, null);
  want = PL.scene(rects, PL.propose(rects, result.floors[0]));
  assert.equal(want.ext.length, 3);
  assert.equal(want.cover.bad, 0);
  // пустой этаж
  assert.deepEqual(PL.propose([], null), []);
});

test('минимум на этаж ставится в коридор, а не в серверную', () => {
  const input = { kind: 'public', floors: [{ rooms: [
    room('s', 'Серверная', 20, { sensitive: true }),
    Object.assign(P.blankRoom('corridor'), { id: 'c', name: 'Коридор', area: 30, length: 15, width: 2 })
  ] }] };
  const result = E.calculate(input);
  const rects = PL.layout(PL.instances(input.floors[0], result.building, 0).list, null);
  const want = PL.resolve(rects, PL.propose(rects, result.floors[0]));
  assert.ok(want.filter(e => e.rect.roomId === 's').every(e => e.t === 'ou'));
  assert.ok(want.some(e => e.t === 'op'));
});

test('рисунок схемы для отчёта: все помещения, круги и метки', () => {
  const x = check(P.EXAMPLES.business.build());
  const pic = PL.svg(x.audit.floors[0], 250, 230);
  assert.ok(pic.svg.startsWith('<svg ') && pic.svg.endsWith('</svg>'));
  assert.ok(pic.width <= 250 && pic.height <= 230.01);
  assert.equal((pic.svg.match(/<circle /g) || []).length, 6); // 3 огнетушителя: круг расстояния и метка
  assert.ok(pic.svg.includes('Офисы'));
  assert.ok(!/NaN|undefined|Infinity/.test(pic.svg));
  // имя помещения с разметкой не ломает рисунок
  const odd = check({ kind: 'public', floors: [{ rooms: [room('q', '<b>&"', 400, { length: 20, width: 20 })], plan: { ext: [{ k: 'q:0', u: 0.5, v: 0.5, t: 'op' }] } }] });
  assert.ok(PL.svg(odd.audit.floors[0], 400, 230).svg.includes('&lt;b&gt;&amp;&quot;'));
});

test('схемы для отчёта: этажи с отметками или открытой схемой', () => {
  const b = check(P.EXAMPLES.business.build());
  const s = PL.schemes(b.input, b.result, b.audit);
  assert.deepEqual(s.map(x => [x.name, !!x.fact]), [['1 этаж', true], ['2 этаж', true]]);
  assert.equal(count(s[0].want.ext, 'ou'), 1);
  const f = check(P.EXAMPLES.factory.build());
  assert.deepEqual(PL.schemes(f.input, f.result, f.audit), []);
});

// ---------- этаж по загруженному плану ----------

test('этаж по плану с картинки: контуры на своих местах, расстановка по ним, PDF-рисунок', () => {
  const V = require('../js/vision.js');
  const { readPng } = require('./helpers.js');
  const dir = require('node:path').join(__dirname, '..', 'examples');
  const meta = JSON.parse(require('node:fs').readFileSync(dir + '/plan-school.json', 'utf8'));
  const img = readPng(dir + '/plan-school.png');
  const found = V.findRooms(img.rgba, img.w, img.h, { scale: meta.scale });
  const blueprint = { img: 'k', w: img.w, h: img.h, scale: meta.scale, rooms: found.rooms.map(r => ({ id: r.id, poly: r.poly, bbox: r.bbox, lx: r.lx, ly: r.ly })) };
  const rooms = found.rooms.map((r, i) => {
    const purpose = meta.rooms[i].name === 'Серверная' ? 'server' : (V.looksLikeCorridor(r, meta.scale) ? 'corridor' : 'office');
    return Object.assign(P.blankRoom(purpose), { id: 'p' + r.id, name: meta.rooms[i].name, area: r.area, length: 1, width: 1, bp: r.id });
  });
  rooms.push(Object.assign(P.blankRoom('storeroom'), { id: 'extra', name: 'Склад во дворе', area: 20 })); // добавлено вручную
  const input = { kind: 'public', floors: [{ rooms, blueprint, plan: { open: true, ext: [] } }] };
  const result = E.calculate(input);
  const fa = PL.audit(input, result).floors[0];
  const planned = fa.rects.filter(r => r.fixed);
  assert.equal(planned.length, 16);
  assert.ok(planned.every(r => r.poly && r.poly.length >= 4 && !r.approx));
  // помещение стоит там же, где на картинке (в метрах)
  assert.ok(Math.abs(planned[0].x - found.rooms[0].bbox[0] / meta.scale) < 1e-9);
  assert.ok(Math.abs(planned[0].y - found.rooms[0].bbox[1] / meta.scale) < 1e-9);
  // добавленное вручную — под планом, не поверх него
  const extra = fa.rects.find(r => !r.fixed);
  assert.ok(extra.y >= Math.max(...planned.map(r => r.y + r.h)), 'вручную добавленное — ниже плана');
  // попадание в контур: точка внутри рамки, но вне контура L-образного помещения не считается
  const corridor = planned.find(r => r.corridor);
  assert.equal(PL.at(fa.rects, corridor.lx, corridor.ly).key, corridor.key);
  // расстановка по нормам: все места внутри своих контуров, мест дальше нормы нет
  const want = PL.scene(fa.rects, PL.propose(fa.rects, result.floors[0]));
  assert.equal(want.cover.bad, 0);
  want.ext.forEach(e => assert.ok(!e.rect.poly || PL.inPoly(e.rect.poly, e.x, e.y), 'место внутри контура: ' + e.rect.name));
  // в серверной — только углекислотный, в коридоре стоит хотя бы один огнетушитель
  assert.ok(want.ext.filter(e => e.rect.name === 'Серверная').every(e => e.t === 'ou'));
  assert.ok(want.ext.some(e => e.rect.corridor), 'огнетушитель в коридоре');
  // рисунок для отчёта: 16 контуров многоугольниками и одно помещение прямоугольником
  const pic = PL.svg(want, 400, 230);
  assert.equal((pic.svg.match(/<polygon /g) || []).length, 16);
  assert.ok(!/NaN|undefined/.test(pic.svg));
  // без картинки плана (например, открыто по ссылке) схема строится обычным способом
  const noPlan = { kind: 'public', floors: [{ rooms, plan: { open: true, ext: [] } }] };
  assert.ok(PL.audit(noPlan, E.calculate(noPlan)).floors[0].rects.every(r => !r.fixed));
});

// ---------- ссылка на расчёт ----------

test('ссылка: объект упаковывается и восстанавливается с тем же расчётом и теми же нарушениями', async () => {
  const src = P.EXAMPLES.business.build();
  src.building.inspector = 'Иванов И. И.';
  src.building.date = '2026-11-12';
  src.floors[0].plan.pos = { 'b1:0': [0, 0], 'b2:0': [0, 15], 'b3:2': [12.5, 15] };
  const code = await SH.encode(src);
  assert.match(code, /^[zj][A-Za-z0-9_-]+$/);
  assert.ok(code.length < 900, 'ссылка помещается в QR-код: ' + code.length);
  const back = await SH.decode(code);
  assert.equal(back.building.name, 'Бизнес-центр (пример)');
  assert.equal(back.building.inspector, 'Иванов И. И.');
  assert.equal(back.floors[0].rooms[2].count, 4);
  assert.equal(back.floors[0].rooms[1].sensitive, true);
  assert.deepEqual(back.floors[0].plan.pos, { 's0_0:0': [0, 0], 's0_1:0': [0, 15], 's0_2:2': [12.5, 15] });
  // расчёт тот же (помещениям после восстановления нужны назначения из справочника)
  back.floors.forEach(f => { f.rooms = f.rooms.map(r => Object.assign(P.blankRoom(r.purpose), r)); });
  const a = check(src), b = check(back);
  assert.deepEqual(b.result.totals, a.result.totals);
  assert.deepEqual(b.audit.findings.map(f => f.text), a.audit.findings.map(f => f.text));
  assert.equal(SH.codeFromHash('#o=' + code), code);
  assert.equal(SH.codeFromHash('#other'), '');
});

test('ссылка: повреждённые и чужие данные не открываются и не ломают разбор', async () => {
  await assert.rejects(SH.decode(''));
  await assert.rejects(SH.decode('zAAAA'));
  await assert.rejects(SH.decode('j' + Buffer.from('{"a":1}').toString('base64url')));
  await assert.rejects(SH.decode('z' + 'A'.repeat(20000)));
  assert.throws(() => SH.unpack([2, [], []]));
  // лишние и неверные поля отбрасываются
  const odd = SH.unpack([1, ['Объект', 5, null, '', 'вчера', 9, 1], [['Этаж', 'x', -1, [['Комната', 'нет такого назначения', '12,5', 5000, 'ZZ', 'AEEQ', 7, 'a', null, 'p5']], 1, [[0, 0, 1, 2], [9, 0, 1, 1]], [[0, 0, 5, -1, 7], [0, 4999, 0, 0, 0]]]]]);
  assert.deepEqual(odd.building, { name: 'Объект', address: '', owner: '', inspector: '', date: '', kind: 'public', autoSuppressionAll: true });
  const r = odd.floors[0].rooms[0];
  assert.deepEqual([r.area, r.count, r.category, r.classes, r.forceType, r.length], [12.5, 999, 'PUB', ['A', 'E'], '', '']);
  assert.deepEqual(odd.floors[0].plan.pos, { 's0_0:0': [1, 2] });
  assert.deepEqual(odd.floors[0].plan.ext, [{ k: 's0_0:0', u: 1, v: 0, t: 'x', code: '' }]);
  assert.equal(odd.floors[0].installedOU, '');
});
