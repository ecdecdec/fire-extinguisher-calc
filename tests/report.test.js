// Тесты PDF-отчёта. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../js/engine.js');
const P = require('../js/presets.js');
const R = require('../js/report.js');

// Множество знаков, которые есть в шрифте из vendor/vfs_fonts.js (таблица cmap).
function fontCoverage(fontName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'vfs_fonts.js'), 'utf8');
  const m = new RegExp('"' + fontName.replace('.', '\\.') + '":\\s*"([A-Za-z0-9+/=]+)"').exec(src);
  assert.ok(m, 'шрифт ' + fontName + ' найден в vfs_fonts.js');
  const buf = Buffer.from(m[1], 'base64');
  const numTables = buf.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (buf.toString('ascii', o, o + 4) === 'cmap') cmap = buf.readUInt32BE(o + 8);
  }
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

function collectStrings(node, out) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(x => collectStrings(x, out));
  else if (node && typeof node === 'object') Object.keys(node).forEach(k => { if (k !== 'qr') collectStrings(node[k], out); });
  return out;
}

function docStrings(dd) {
  const out = collectStrings(dd.content, []);
  collectStrings(dd.header(2, 3), out);
  collectStrings(dd.footer(2, 3), out);
  collectStrings(dd.info, out);
  return out;
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

test('в отчёте нет знаков, которых нет в шрифте Roboto', () => {
  const regular = fontCoverage('Roboto-Regular.ttf');
  const medium = fontCoverage('Roboto-Medium.ttf');
  const all = inputs();
  [[all.business, {}], [all.factory, {}], [all.factory, { rounding: 'block', onlyPowderAndCO2: false }], [all.empty, {}]].forEach(([input, options]) => {
    const dd = R.buildDoc(E.calculate(input, options), { generatedAt: fixedDate });
    const missing = new Set();
    docStrings(dd).forEach(s => {
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp === 10 || cp === 13) continue;
        if (!regular.has(cp) || !medium.has(cp)) missing.add(ch + ' (U+' + cp.toString(16).toUpperCase() + ')');
      }
    });
    assert.deepEqual([...missing], []);
  });
});

// Все узлы описания документа с ключом key (например, qr).
function nodes(node, key, out) {
  out = out || [];
  if (Array.isArray(node)) node.forEach(x => nodes(x, key, out));
  else if (node && typeof node === 'object') { if (key in node) out.push(node); Object.keys(node).forEach(k => nodes(node[k], key, out)); }
  return out;
}

test('первая страница — заключение: вывод, что требуется, по этажам, подписи; дальше приложения', () => {
  const all = inputs();
  const result = E.calculate(all.business);
  const dd = R.buildDoc(result, { generatedAt: fixedDate });
  const text = docStrings(dd).join('\n');
  ['РАСЧЁТ ОГНЕТУШИТЕЛЕЙ', 'Бизнес-центр (пример)', 'Не соответствует', 'Не хватает: 1 порошкового (ОП) и 1 углекислотного (ОУ).',
    'ТРЕБУЕТСЯ ПО НОРМАМ', 'ПО ЭТАЖАМ', 'Установлено', 'ОП — 3, ОУ — 0 (по схеме)', 'не хватает ОП: 1; не хватает ОУ: 1', 'в норме',
    'Расчёт выполнил', 'Иванов И. И.', '11.11.2026', 'Приложение 1. Расчёт по помещениям', 'Как посчитано', '450 м² × 4 шт. / 800 м² = 2,25, округление вверх — 3 шт.',
    'Приложение 2. Правила размещения, допущения и источники', 'Принятые допущения', 'Нормативные источники',
    'ОП-5', 'ОУ-3', 'СТ РК 1487-2006', 'Прил. 3, п. 7', 'Прил. 3, п. 5', 'стр. 2 из 3'
  ].forEach(x => assert.ok(text.includes(x), 'есть «' + x + '»'));
  assert.equal(dd.pageSize, 'A4');
  // строка нормы и формула — в таблице, а не повторяются в пояснениях
  assert.ok(!text.includes('Помещение общественного назначения: строка'));
  // приложения начинаются с новой страницы
  assert.equal(nodes(dd.content, 'pageBreak').filter(n => n.pageBreak === 'before').length, 1);
  // без ссылки QR-кода нет
  assert.equal(nodes(dd.content, 'qr').length, 0);
  // без фактических данных — расчёт потребности, без колонки «Установлено»
  const noCheck = all.business;
  noCheck.floors.forEach(f => { f.installedOP = ''; f.installedOU = ''; f.plan = null; });
  const text2 = docStrings(R.buildDoc(E.calculate(noCheck), { generatedAt: fixedDate })).join('\n');
  assert.ok(text2.includes('Требуется 7 огнетушителей') && text2.includes('Фактическое наличие не вносилось'));
  assert.ok(!text2.includes('Установлено') && text2.includes('4 × ОП-5, 1 × ОУ-3'));
  // замечания к исходным данным — строкой на первой странице и списком в приложении
  const text3 = docStrings(R.buildDoc(E.calculate(all.factory), { generatedAt: fixedDate })).join('\n');
  assert.ok(text3.includes('Замечаний к исходным данным: ') && text3.includes('Замечания к исходным данным'));
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

test('отчёт проверки: что сделать, схемы «как есть» и «по нормам», небольшой QR-код со ссылкой', () => {
  const PL = require('../js/plan.js');
  const input = inputs().business;
  const result = E.calculate(input);
  const audit = PL.audit(input, result);
  const link = 'https://fire-extinguisher-calc.vercel.app/#o=' + 'z'.repeat(400);
  const dd = R.buildDoc(result, { generatedAt: fixedDate, audit: audit, schemes: PL.schemes(input, result, audit), link: link });
  const strings = docStrings(dd);
  const text = strings.join('\n');
  ['ЧТО СДЕЛАТЬ', 'Добавить 1 порошковый огнетушитель (ОП-5)', 'Добавить 1 углекислотный огнетушитель (ОУ-3)',
    '1 этаж, «Серверная»', 'Убрать порошковый огнетушитель, поставить углекислотный (ОУ)', 'Прил. 3, п. 9; СТ РК 1487-2006', 'Нарушений размещения: 1.',
    'Приложение 1. Схемы размещения огнетушителей', 'Как есть — отмечено при осмотре: ОП — 3, ОУ — 0', 'По нормам — расчётная расстановка: ОП — 4, ОУ — 1',
    'Приложение 2. Расчёт по помещениям', 'Открыть расчёт на телефоне'
  ].forEach(x => assert.ok(text.includes(x), 'есть «' + x + '»'));
  const qr = nodes(dd.content, 'qr');
  assert.equal(qr.length, 1);
  assert.equal(qr[0].qr, link);
  // QR небольшой: 2–4 см, клетка не меньше 1 pt (pdfmake округляет её вниз до целого пункта)
  assert.ok(qr[0].fit >= 60 && qr[0].fit <= 115, 'сторона ' + qr[0].fit);
  [10, 100, 450, 1000].forEach(n => { const side = R.qrSide('https://x.kz/#o=' + 'a'.repeat(n)); assert.ok(side >= 49 && side <= 115, n + ': ' + side); });
  assert.equal(strings.filter(x => x.startsWith('<svg ')).length, 4); // два этажа, по две схемы
  // знаки рисунков и подписей есть в шрифте отчёта
  const regular = fontCoverage('Roboto-Regular.ttf'), medium = fontCoverage('Roboto-Medium.ttf');
  const missing = new Set();
  strings.forEach(x => { for (const ch of x) { const cp = ch.codePointAt(0); if (cp !== 10 && cp !== 13 && !(regular.has(cp) && medium.has(cp))) missing.add(ch); } });
  assert.deepEqual([...missing], []);
  // количество в норме, а нарушение по размещению есть — вывод всё равно «не соответствует»
  const placed = { kind: 'public', floors: [{ rooms: [
    Object.assign(P.blankRoom('server'), { id: 's', name: 'Серверная', area: 20 }),
    Object.assign(P.blankRoom('office'), { id: 'o', name: 'Офис', area: 100 })
  ], plan: { ext: [{ k: 's:0', u: 0.5, v: 0.5, t: 'op' }, { k: 's:0', u: 0.2, v: 0.5, t: 'ou' }] } }] };
  const r2 = E.calculate(placed);
  assert.equal(r2.check.ok, true);
  const t2 = docStrings(R.buildDoc(r2, { generatedAt: fixedDate, audit: PL.audit(placed, r2) })).join('\n');
  assert.ok(t2.includes('Не соответствует') && t2.includes('Огнетушителей достаточно.') && t2.includes('Нарушений размещения: 1.'));
});
