// Тесты PDF-отчёта. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../js/engine.js');
const P = require('../js/presets.js');
const PL = require('../js/plan.js');
const R = require('../js/report.js');
const { mulberry32, randomObject, randomOptions } = require('./helpers.js');

// Множество знаков шрифта отчёта (таблица cmap файла vendor/fonts/*.ttf).
function fontCoverage(fileName) {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'fonts', fileName));
  const numTables = buf.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (buf.toString('ascii', o, o + 4) === 'cmap') cmap = buf.readUInt32BE(o + 8);
  }
  assert.ok(cmap, 'таблица cmap в ' + fileName);
  const has = new Set();
  const n = buf.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const t = cmap + buf.readUInt32BE(cmap + 8 + i * 8);
    const format = buf.readUInt16BE(t);
    if (format === 4) {
      const segX2 = buf.readUInt16BE(t + 6);
      const ends = t + 14, starts = ends + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s++) {
        const e = buf.readUInt16BE(ends + s * 2), st = buf.readUInt16BE(starts + s * 2);
        for (let c = st; c <= e && c < 0xFFFF; c++) has.add(c);
      }
    } else if (format === 12) {
      const groups = buf.readUInt32BE(t + 12);
      for (let g = 0; g < groups; g++) {
        const a = buf.readUInt32BE(t + 16 + g * 12), b = buf.readUInt32BE(t + 20 + g * 12);
        for (let c = a; c <= b; c++) has.add(c);
      }
    }
  }
  return has;
}
const REGULAR = fontCoverage('Tinos-Regular.ttf'), BOLD = fontCoverage('Tinos-Bold.ttf');

function collectStrings(node, out) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(x => collectStrings(x, out));
  else if (node && typeof node === 'object') Object.keys(node).forEach(k => { if (k !== 'qr') collectStrings(node[k], out); });
  return out;
}

function docStrings(dd) {
  const out = collectStrings(dd.content, []);
  collectStrings(dd.header(2, 3), out);
  collectStrings(dd.info, out);
  return out;
}

// Все узлы описания документа с ключом key (например, qr).
function nodes(node, key, out) {
  out = out || [];
  if (Array.isArray(node)) node.forEach(x => nodes(x, key, out));
  else if (node && typeof node === 'object') { if (key in node) out.push(node); Object.keys(node).forEach(k => nodes(node[k], key, out)); }
  return out;
}

function missingGlyphs(strings) {
  const missing = new Set();
  strings.forEach(s => {
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp === 10 || cp === 13) continue;
      if (!REGULAR.has(cp) || !BOLD.has(cp)) missing.add(ch + ' (U+' + cp.toString(16).toUpperCase() + ')');
    }
  });
  return [...missing];
}

const fixedDate = new Date(2026, 10, 11);

function inputs() {
  const business = P.EXAMPLES.business.build();
  business.building.inspector = 'Иванов И. И.';
  business.building.date = '2026-11-11';
  const factory = P.EXAMPLES.factory.build();
  // помещение с нестандартным классом пожара — чтобы в отчёт попали предупреждения
  factory.floors[0].rooms.push(Object.assign(P.blankRoom('boiler'), { name: 'Котельная', area: 90, classes: ['A', 'C'] }));
  return { business, factory, empty: { kind: 'public', floors: [] } };
}

function fullDoc(input, options, link) {
  const result = E.calculate(input, options);
  const audit = PL.audit(input, result);
  return R.buildDoc(result, { generatedAt: fixedDate, audit: audit, schemes: PL.schemes(input, result, audit), link: link });
}

test('в отчёте нет знаков, которых нет в шрифте отчёта (Tinos)', () => {
  const all = inputs();
  [[all.business, {}], [all.factory, {}], [all.factory, { rounding: 'block', onlyPowderAndCO2: false }], [all.empty, {}]].forEach(([input, options]) => {
    assert.deepEqual(missingGlyphs(docStrings(fullDoc(input, options, 'https://x.kz/#o=zAb'))), []);
  });
  // казахские буквы в адресе и названии тоже есть в шрифте
  const kz = inputs().business;
  kz.building.address = 'Петропавл қ., Нұрсұлтан Назарбаев көшесі, 181, Әлихан Бөкейхан, Ғабит Мүсірепов, Шоқан, Ұлы Дала, Үкімет, Һ';
  assert.deepEqual(missingGlyphs(docStrings(fullDoc(kz, {}))), []);
});

test('служебный документ: заголовок, разделы, распределение по этажам, сверка, вывод, подписи, приложения', () => {
  const all = inputs();
  const result = E.calculate(all.business);
  const dd = R.buildDoc(result, { generatedAt: fixedDate });
  const text = docStrings(dd).join('\n');
  ['РАСЧЁТ', 'необходимого количества первичных средств пожаротушения (огнетушителей)', 'г. Астана', '11.11.2026',
    '1. Сведения об объекте', 'Бизнес-центр (пример)', 'Общественное здание', '2 этажа, 8 помещений, 720 м²',
    '2. Требуемое количество огнетушителей', 'ОП-5, порошковый, заряд ABC(E)', 'ОУ-3, углекислотный', 'Итого огнетушителей',
    '3. Сверка с фактическим наличием', 'Порошковые (ОП)', 'недостаёт', 'На этажах со схемой',
    '4. Вывод', 'не соответствует', 'Не хватает: 1 порошкового (ОП) и 1 углекислотного (ОУ).', 'Расчёт выполнил', 'Иванов И. И.',
    'Приложение 1', 'к расчёту от 11.11.2026', 'Расчёт по помещениям', '450 м² × 4 шт. / 800 м² = 2,25, с округлением вверх 3 шт.',
    'Приложение 2', 'Требования к размещению, принятые допущения и нормативные документы', 'СТ РК 1487-2006', 'Прил. 3, п. 7', 'Прил. 3, п. 5'
  ].forEach(x => assert.ok(text.includes(x), 'есть «' + x + '»'));
  assert.equal(dd.pageSize, 'A4');
  assert.equal(dd.defaultStyle.font, 'Tinos');
  // распределение по этажам: ОП-5 — 4 на первом, 2 на втором, всего 6
  const need = nodes(dd.content, 'table').find(t => JSON.stringify(t.table.body[0]).includes('Тип огнетушителя'));
  const op5 = need.table.body.find(r => typeof r[1] === 'string' && r[1].startsWith('ОП-5'));
  assert.deepEqual(op5.slice(2).map(c => c.text), ['4', '2', '6']);
  // строка нормы и формула — в таблице, а не повторяются в пояснениях
  assert.ok(!text.includes('Помещение общественного назначения: строка'));
  // каждое приложение начинается с новой страницы; номер страницы сверху со второй
  assert.equal(nodes(dd.content, 'pageBreak').filter(n => n.pageBreak === 'before').length, 2);
  assert.equal(dd.header(1, 3), null);
  assert.equal(dd.header(2, 3).text, '2');
  // без ссылки QR-кода нет
  assert.equal(nodes(dd.content, 'qr').length, 0);
  // без фактических данных — расчёт потребности, без сверки
  const noCheck = all.business;
  noCheck.floors.forEach(f => { f.installedOP = ''; f.installedOU = ''; f.plan = null; });
  const text2 = docStrings(R.buildDoc(E.calculate(noCheck), { generatedAt: fixedDate })).join('\n');
  assert.ok(text2.includes('Для объекта требуется 7 переносных огнетушителей (раздел 2). Фактическое наличие огнетушителей не проверялось.'));
  assert.ok(!text2.includes('Сверка с фактическим наличием'));
  // замечания к исходным данным — строкой на первой странице и списком в приложении
  const text3 = docStrings(R.buildDoc(E.calculate(all.factory), { generatedAt: fixedDate })).join('\n');
  assert.ok(text3.includes('Замечания к исходным данным (') && text3.includes('Замечания к исходным данным\n'));
});

test('не похоже на сгенерированное: без длинных тире и «·», без цветов, без надписей заглавными над разделами', () => {
  const all = inputs();
  [all.business, all.factory].forEach(input => {
    const dd = fullDoc(input, {}, 'https://x.kz/#o=zAb');
    const strings = docStrings(dd);
    const text = strings.join('\n');
    assert.ok(!text.includes('·'), 'разделитель «·»');
    const dashes = strings.filter(s => !s.startsWith('<svg') && s.includes('—'));
    assert.deepEqual(dashes, [], 'длинные тире');
    // цвета: только чёрный и тёмно-серый, на схемах — без красного
    const colors = new Set();
    nodes(dd, 'color').forEach(n => colors.add(String(n.color).toLowerCase()));
    nodes(dd.styles, 'color').forEach(n => colors.add(String(n.color).toLowerCase()));
    colors.add(String(dd.defaultStyle.color).toLowerCase());
    assert.deepEqual([...colors].filter(c => !['#000000', '#333333'].includes(c)), [], 'цвета');
    assert.equal(nodes(dd.content, 'fillColor').length, 0, 'заливки');
    strings.filter(s => s.startsWith('<svg')).forEach(s => {
      assert.ok(!/#c4291c|#b3261e|#1a7f4b/i.test(s), 'цвет на схеме');
      assert.ok(!s.includes('Roboto') && s.includes('font-family="Tinos"'));
    });
    // надписи заглавными: только сам заголовок «РАСЧЁТ»
    const caps = strings.filter(s => s.length > 3 && s === s.toUpperCase() && /[А-ЯЁ]{4,}/.test(s));
    assert.deepEqual(caps, ['РАСЧЁТ']);
  });
});

test('отчёт на 300 случайных объектах: строится, все знаки есть в шрифте, без длинных тире и «·»', () => {
  const rnd = mulberry32(55);
  for (let i = 0; i < 300; i++) {
    const input = randomObject(rnd, i), opts = randomOptions(rnd);
    // часть этажей — как после осмотра: отметки на схеме или вписанные числа
    input.floors.forEach(f => {
      if (rnd() < 0.5) f.plan = { open: true, ext: f.rooms.filter(() => rnd() < 0.5).map(r => ({ k: r.id + ':0', u: rnd(), v: rnd(), t: rnd() < 0.7 ? 'op' : 'ou' })) };
      else if (rnd() < 0.5) { f.installedOP = Math.floor(rnd() * 6); f.installedOU = Math.floor(rnd() * 3); }
    });
    const link = rnd() < 0.5 ? 'https://x.kz/#o=' + 'a'.repeat(Math.floor(rnd() * 900)) : undefined;
    const strings = docStrings(fullDoc(input, opts, link));
    assert.deepEqual(missingGlyphs(strings), [], 'объект ' + i);
    assert.deepEqual(strings.filter(s => !s.startsWith('<svg') && (s.includes('—') || s.includes('·'))), [], 'объект ' + i);
  }
});

test('имя файла без запрещённых знаков', () => {
  const result = E.calculate(inputs().business);
  const name = R.fileName(result, fixedDate);
  assert.equal(name, 'Расчёт_огнетушителей_Бизнес-центр_(пример)_2026-11-11.pdf');
  assert.ok(!/[\\/:*?"<>|]/.test(name));
  assert.equal(R.fileName(E.calculate({}), fixedDate), 'Расчёт_огнетушителей_объект_2026-11-11.pdf');
});

test('пустой расчёт формирует отчёт без ошибок', () => {
  const dd = R.buildDoc(E.calculate(inputs().empty), { generatedAt: fixedDate });
  assert.ok(docStrings(dd).join('\n').includes('Помещения не введены'));
});

test('отчёт проверки: нарушения и меры, схемы «фактическое» и «по расчёту», небольшой QR-код со ссылкой', () => {
  const input = inputs().business;
  const link = 'https://fire-extinguisher-calc.vercel.app/#o=' + 'z'.repeat(400);
  const dd = fullDoc(input, {}, link);
  const strings = docStrings(dd);
  const text = strings.join('\n');
  ['4. Выявленные нарушения и меры по их устранению', 'Установить ещё 1 порошковый огнетушитель (ОП-5)', 'Установить ещё 1 углекислотный огнетушитель (ОУ-3)',
    '1 этаж, «Серверная»', 'Заменить порошковый огнетушитель углекислотным (ОУ)', 'Прил. 3, п. 9; СТ РК 1487-2006', 'Нарушений размещения: 1.',
    'Приложение 1', 'Схемы размещения огнетушителей', 'а) фактическое размещение, отмечено при осмотре: ОП 3, ОУ 0', 'б) размещение по расчёту: ОП 4, ОУ 1',
    'Условные обозначения', 'Приложение 2', 'Расчёт по помещениям', 'Приложение 3', 'Электронная версия расчёта'
  ].forEach(x => assert.ok(text.includes(x), 'есть «' + x + '»'));
  const qr = nodes(dd.content, 'qr');
  assert.equal(qr.length, 1);
  assert.equal(qr[0].qr, link);
  // QR небольшой: 2–4 см, клетка не меньше 1 pt (pdfmake округляет её вниз до целого пункта)
  assert.ok(qr[0].fit >= 60 && qr[0].fit <= 115, 'сторона ' + qr[0].fit);
  [10, 100, 450, 1000].forEach(n => { const side = R.qrSide('https://x.kz/#o=' + 'a'.repeat(n)); assert.ok(side >= 49 && side <= 115, n + ': ' + side); });
  assert.equal(strings.filter(x => x.startsWith('<svg ')).length, 4); // два этажа, по две схемы
  assert.deepEqual(missingGlyphs(strings), []);
  // количество в норме, а нарушение по размещению есть — вывод всё равно «не соответствует»
  const placed = { kind: 'public', floors: [{ rooms: [
    Object.assign(P.blankRoom('server'), { id: 's', name: 'Серверная', area: 20 }),
    Object.assign(P.blankRoom('office'), { id: 'o', name: 'Офис', area: 100 })
  ], plan: { ext: [{ k: 's:0', u: 0.5, v: 0.5, t: 'op' }, { k: 's:0', u: 0.2, v: 0.5, t: 'ou' }] } }] };
  const r2 = E.calculate(placed);
  assert.equal(r2.check.ok, true);
  const t2 = docStrings(R.buildDoc(r2, { generatedAt: fixedDate, audit: PL.audit(placed, r2) })).join('\n');
  assert.ok(t2.includes('не соответствует') && t2.includes('Нарушений размещения: 1.'), t2.slice(0, 400));
});
