// Знаки на схеме (ГОСТ 12.4.026-2015) и отметки, которые не огнетушители. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/signs.js');
const E = require('../js/engine.js');
const P = require('../js/presets.js');
const PL = require('../js/plan.js');
const R = require('../js/report.js');
const SH = require('../js/share.js');
const LIB = require('../js/library.js');

// Простая проверка разметки: теги закрыты, нет «undefined» и «NaN».
function wellFormed(svg) {
  assert.ok(!/undefined|NaN/.test(svg), 'нет undefined и NaN');
  const stack = [];
  const re = /<\/?([a-zA-Z]+)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(svg))) {
    if (m[0].startsWith('</')) assert.equal(stack.pop(), m[1], 'закрывающий тег ' + m[1]);
    else if (!m[2]) stack.push(m[1]);
  }
  assert.deepEqual(stack, [], 'все теги закрыты');
}

function office() {
  return {
    kind: 'public',
    floors: [{
      id: 'f1', name: '1 этаж',
      rooms: [
        Object.assign(P.blankRoom('office'), { id: 'a', name: 'Офис', area: 60, length: 10, width: 6 }),
        Object.assign(P.blankRoom('corridor'), { id: 'c', name: 'Коридор', area: 40, length: 20, width: 2 })
      ],
      plan: { open: true, ext: [] }
    }]
  };
}

test('знаки: у каждого вида есть символ, цвет по группе, разметка корректна', () => {
  S.ORDER.forEach(t => {
    const it = S.ITEMS[t];
    assert.ok(it.name && it.short && it.sign, t);
    assert.equal(S.color(t), it.group === 'evac' ? S.COLORS.green : S.COLORS.red, 'цвет ' + t);
    wellFormed(S.icon(t, 20, 'Tinos'));
    wellFormed('<svg>' + S.svgAt(t, 10, 10, 12, 'Tinos') + '</svg>');
  });
  const sprite = S.sprite();
  wellFormed(sprite);
  S.ORDER.forEach(t => assert.ok(sprite.includes('id="sg-' + t + '"'), 'символ ' + t));
  // огнетушители различаются буквой, а не цветом знака: оба красные (корпус огнетушителя красный)
  assert.equal(S.color('op'), S.color('ou'));
  assert.equal(S.ITEMS.op.badge, 'П');
  assert.equal(S.ITEMS.ou.badge, 'У');
  assert.ok(S.isExt('op') && S.isExt('ou') && S.isExt('x') && S.isExt('что-то старое'));
  ['pk', 'btn', 'tel', 'post', 'exit'].forEach(t => assert.ok(!S.isExt(t), t));
  assert.equal(S.typeOf('нет такого'), 'x');
});

test('пожарный кран, кнопка, выход и т. п. не входят в число огнетушителей', () => {
  const input = office();
  input.floors[0].plan.ext = [
    { k: 'c:0', u: 0.1, v: 0.5, t: 'exit' }, { k: 'c:0', u: 0.5, v: 0.5, t: 'pk' }, { k: 'a:0', u: 0.2, v: 0.2, t: 'btn' }
  ];
  let r = E.calculate(input);
  // одни только знаки без огнетушителей: факт не известен, числа «есть» не со схемы
  assert.equal(r.floors[0].fromPlan, false);
  assert.equal(r.check, null);
  let au = PL.audit(input, r);
  assert.equal(au.floors[0].marked, false);
  assert.equal(au.floors[0].hasMarks, true);
  assert.deepEqual(PL.gaps(au.floors[0]), [], 'без огнетушителей ничего не закрашивается');
  assert.equal(au.findings.filter(f => f.kind === 'distance').length, 0);
  // схема с одними знаками всё равно попадает в отчёт как «фактическое размещение»
  assert.ok(PL.schemes(input, r, au)[0].fact);

  input.floors[0].plan.ext.push({ k: 'c:0', u: 0.5, v: 0.5, t: 'op' }, { k: 'a:0', u: 0.9, v: 0.9, t: 'op' });
  r = E.calculate(input);
  assert.equal(r.floors[0].fromPlan, true);
  assert.equal(r.floors[0].check.installedOP, 2);
  assert.equal(r.floors[0].check.installedOU, 0);
  au = PL.audit(input, r);
  const n = PL.tally(au.floors[0]);
  assert.deepEqual([n.op, n.ou, n.other], [2, 0, 0]);
  assert.deepEqual(n.items, { exit: 1, pk: 1, btn: 1 });
  // проверка расстояния — только по огнетушителям: кран в коридоре расстояние не закрывает
  const onlyOp = PL.scene(au.floors[0].rects, input.floors[0].plan.ext.filter(e => e.t === 'op'));
  assert.equal(au.floors[0].cover.bad, onlyOp.cover.bad);
});

test('на схеме «по нормам» видны отмеченные выходы и краны, огнетушители — по расчёту', () => {
  const input = office();
  input.floors[0].plan.ext = [{ k: 'c:0', u: 0.05, v: 0.5, t: 'exit' }, { k: 'c:0', u: 0.95, v: 0.5, t: 'pk' }];
  const r = E.calculate(input);
  const au = PL.audit(input, r);
  const want = PL.wantScene(au.floors[0].rects, r.floors[0], input.floors[0].plan.ext);
  assert.deepEqual(want.ext.filter(e => !e.isExt).map(e => e.t).sort(), ['exit', 'pk']);
  assert.ok(want.ext.filter(e => e.isExt).length >= 2, 'не менее двух огнетушителей на этаже (п. 5)');
  assert.deepEqual(PL.kindsOf([want]), S.ORDER.filter(t => want.ext.some(e => e.t === t)));
});

test('ссылка сохраняет все виды отметок', async () => {
  const input = office();
  input.floors[0].plan.ext = S.MARKABLE.map((t, i) => ({ k: 'a:0', u: (i + 1) / 10, v: 0.5, t: t }));
  const back = SH.unpack(JSON.parse(JSON.stringify(SH.pack(input))));
  assert.deepEqual(back.floors[0].plan.ext.map(e => e.t), S.MARKABLE);
  const code = await SH.encode(input);
  const decoded = await SH.decode(code);
  assert.deepEqual(decoded.floors[0].plan.ext.map(e => e.t), S.MARKABLE);
});

test('PDF: знаки в цвете по ГОСТ 12.4.026-2015 и условные обозначения с расшифровкой букв', () => {
  const input = office();
  input.floors[0].plan.ext = [{ k: 'c:0', u: 0.05, v: 0.5, t: 'exit' }, { k: 'c:0', u: 0.5, v: 0.5, t: 'op' }, { k: 'a:0', u: 0.5, v: 0.5, t: 'ou' }];
  const r = E.calculate(input);
  const au = PL.audit(input, r);
  const sc = PL.schemes(input, r, au);
  const pic = PL.svg(sc[0].fact, 300, 200).svg;
  wellFormed(pic);
  assert.ok(pic.includes(S.COLORS.red) && pic.includes(S.COLORS.green), 'красный и зелёный знаки');
  assert.ok(/>П<\/text>/.test(pic) && />У<\/text>/.test(pic), 'буквы типа');
  const dd = R.buildDoc(r, { generatedAt: new Date(2026, 10, 20), audit: au, schemes: sc });
  const all = JSON.stringify(dd.content);
  assert.ok(all.includes('Условные обозначения. Знаки безопасности по ГОСТ 12.4.026-2015'));
  const legend = PL.legendSvg(PL.kindsOf([sc[0].fact, sc[0].want]), [{ draw: 'ring', text: 'Круг' }], 500).svg;
  wellFormed(legend);
  ['Огнетушитель порошковый (буква П), знак F04', 'Огнетушитель углекислотный (буква У), знак F04', 'Эвакуационный выход, знак E01'].forEach(x => assert.ok(legend.includes(x), x));
  assert.ok(R && dd.content.length > 0);
});

test('справочник норм: документы с текстами, ссылки на пункты, которые использует программа', () => {
  const ids = LIB.map(d => d.id);
  ['ppb', 'app2', 'app3', 'tr405', 'st1487', 'g26', 'g28130', 'g30612'].forEach(id => assert.ok(ids.includes(id), id));
  LIB.forEach(d => {
    assert.ok(d.title && d.doc && d.status && d.items.length, d.id);
    d.items.forEach(it => {
      assert.ok(it.ref, d.id);
      assert.ok((it.text && it.text.length) || (it.rows && it.rows.length), d.id + ' ' + it.ref);
      (it.text || []).forEach(t => assert.ok(t.length > 20 && !/undefined/.test(t), d.id + ' ' + it.ref));
    });
  });
  const app3 = LIB.find(d => d.id === 'app3');
  assert.equal(app3.items.length, 17);
  assert.match(app3.items[3].text.join(' '), /20 м – для общественных зданий/);
  assert.match(app3.items[4].text[0], /не менее двух ручных огнетушителей/);
  const ppb = LIB.find(d => d.id === 'ppb');
  assert.match(ppb.items.find(i => i.ref === 'п. 18').text[1], /знаками пожарной безопасности/);
  const g26 = LIB.find(d => d.id === 'g26');
  const k1 = g26.items.find(i => /К\.1/.test(i.ref));
  // все знаки, которыми рисует схема, есть в выписке из стандарта
  S.ORDER.filter(t => S.ITEMS[t].sign !== 'E01').forEach(t => assert.ok(k1.rows.some(r => r[0] === S.ITEMS[t].sign), S.ITEMS[t].sign));
});
