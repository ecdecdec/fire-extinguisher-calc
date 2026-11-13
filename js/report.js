/*
 * PDF-отчёт: описание документа для pdfmake из результата расчёта.
 * Чистая функция — без DOM и без pdfmake, поэтому проверяется тестами в Node.
 * В браузере: pdfMake.createPdf(FireReport.buildDoc(result, meta), null, FireReport.FONTS).
 *
 * Отчёт оформлен как служебный документ, а не как экран приложения: шрифт с засечками
 * (Tinos — метрика Times New Roman), только чёрный цвет, пронумерованные разделы,
 * таблицы с сеткой, вывод обычной фразой, подписи, приложения с новой страницы.
 * Без плашек, карточек, цветных полос и надписей заглавными буквами с разрядкой.
 *
 * Первая страница: сведения об объекте, требуемое количество по этажам, сверка
 * с фактом, нарушения и меры, вывод, подписи. Приложения: схемы размещения, расчёт
 * по помещениям, требования и допущения.
 *
 * В тексте только знаки из подмножества шрифта vendor/fonts/Tinos-*.ttf
 * (проверяет tests/report.test.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./norms.js'), require('./engine.js'), require('./plan.js'));
  else root.FireReport = factory(root.FireNorms, root.FireEngine, root.FirePlan);
}(typeof self !== 'undefined' ? self : this, function (N, E, PL) {
  'use strict';

  const APP_NAME = 'Расчёт огнетушителей';
  const KIND_LABEL = {
    public: 'Общественное здание',
    industrial: 'Производственное здание',
    warehouse: 'Складское здание'
  };
  // Шрифт отчёта: файлы лежат в pdfMake.vfs (vendor/vfs_report.js).
  const FONTS = { Tinos: { normal: 'Tinos-Regular.ttf', bold: 'Tinos-Bold.ttf', italics: 'Tinos-Regular.ttf', bolditalics: 'Tinos-Bold.ttf' } };
  const INK = '#000000';
  const SOFT = '#333333';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function formatDate(value) {
    if (!value) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (m) return m[3] + '.' + m[2] + '.' + m[1];
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function plural(n, a, b, c) { return E.plural(n, a, b, c); }

  // ---------- QR-код ----------

  // Ёмкость QR-кода в байтах при уровне коррекции L, версии 1–40.
  const QR_CAP_L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
    929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953];

  // Сторона QR-кода со ссылкой, pt. pdfmake округляет клетку вниз до целого пункта, поэтому
  // сторона кратна числу клеток (с запасом на версию больше). Клетка 1 pt (0,35 мм), у короткой
  // ссылки 2 pt: код 2–4 см, как обычно на документах. С бумаги читается камерой телефона,
  // с экрана — при увеличении страницы.
  function qrSide(text) {
    const bytes = new TextEncoder().encode(text).length;
    let v = 1;
    while (v < 40 && QR_CAP_L[v - 1] < bytes) v += 1;
    const n = 17 + 4 * v;
    return (2 * (n + 4) <= 92 ? 2 : 1) * (n + 4);
  }

  // ---------- таблицы ----------

  // Таблица с сеткой тонких чёрных линий, как в служебных документах.
  const GRID = {
    hLineWidth: function () { return 0.5; },
    vLineWidth: function () { return 0.5; },
    hLineColor: function () { return INK; },
    vLineColor: function () { return INK; },
    paddingLeft: function () { return 4; },
    paddingRight: function () { return 4; },
    paddingTop: function () { return 2; },
    paddingBottom: function () { return 2; }
  };

  function th(text, extra) { return Object.assign({ text: text, bold: true, alignment: 'center' }, extra || {}); }
  function num(value, extra) { return Object.assign({ text: value === '' || value === null || value === undefined ? '' : String(value), alignment: 'center' }, extra || {}); }
  function heading(text) { return { text: text, style: 'section' }; }

  // Тип огнетушителя для таблиц: «ОП-5, порошковый, заряд ABC(E)».
  function typeName(t) {
    const kind = t.kind === 'wheeled' ? 'передвижной' : '';
    if (t.kind === 'shield') return t.code + ', щит пожарный (комплект)';
    if (t.agent === 'powder') return t.code + ', порошковый' + (kind ? ' ' + kind : '') + ', заряд ' + (t.charge || 'ABC(E)');
    if (t.agent === 'co2') return t.code + ', углекислотный' + (kind ? ' ' + kind : '');
    return t.code + (t.name ? ', ' + t.name : '');
  }
  function lineKey(l) { return l.kind + '|' + l.code + '|' + l.charge; }

  function floorRooms(f) {
    let n = 0, area = 0;
    f.units.forEach(function (u) { u.rooms.forEach(function (r) { n += r.count; area += r.area * r.count; }); });
    return { n: n, area: area };
  }

  // ---------- разделы первой страницы ----------

  function objectTable(result) {
    const b = result.building, s = result.summary;
    const rows = [
      ['Наименование объекта', b.name],
      ['Адрес', b.address],
      ['Собственник (организация)', b.owner],
      ['Функциональное назначение', KIND_LABEL[b.kind] || ''],
      ['Этажей, помещений, общая площадь', s.floors + ' ' + plural(s.floors, 'этаж', 'этажа', 'этажей') + ', ' + s.rooms + ' ' +
        plural(s.rooms, 'помещение', 'помещения', 'помещений') + ', ' + E.fmt(s.area) + ' м²']
    ];
    return { table: { widths: [185, '*'], body: rows.map(function (r) { return [r[0], r[1] || '']; }) }, layout: GRID, fontSize: 10, lineHeight: 1.05 };
  }

  // Требуемое количество: типы по строкам, этажи по столбцам (до пяти этажей), итог.
  function needTable(result) {
    const floors = result.floors.filter(function (f) { return f.units.length; });
    const byFloor = floors.length > 1 && floors.length <= 5;
    const head = [th('№'), th('Тип огнетушителя')];
    if (byFloor) floors.forEach(function (f) { head.push(th(f.name)); });
    head.push(th('Всего, шт.'));
    const body = [head];
    const sums = floors.map(function () { return 0; });
    let total = 0, shields = 0;
    result.totals.forEach(function (t, i) {
      const row = [num(i + 1), typeName(t)];
      if (byFloor) {
        floors.forEach(function (f, fi) {
          let c = 0;
          f.units.forEach(function (u) { u.lines.forEach(function (l) { if (lineKey(l) === lineKey(t)) c += l.count; }); });
          if (t.kind !== 'shield') sums[fi] += c;
          row.push(num(c || ''));
        });
      }
      row.push(num(t.count, { bold: true }));
      if (t.kind === 'shield') shields += t.count; else total += t.count;
      body.push(row);
    });
    const foot = [{ text: 'Итого огнетушителей', bold: true, colSpan: 2 }, {}];
    if (byFloor) sums.forEach(function (c) { foot.push(num(c, { bold: true })); });
    foot.push(num(total, { bold: true }));
    body.push(foot);
    const widths = [18, '*'];
    if (byFloor) floors.forEach(function () { widths.push(52); });
    widths.push(56);
    const out = [{ table: { headerRows: 1, widths: widths, body: body }, layout: GRID, fontSize: 10, lineHeight: 1.05 }];
    if (shields) out.push({ text: 'Пожарные щиты (комплектов): ' + shields + '; в итог огнетушителей не входят.', style: 'note' });
    return out;
  }

  function checkTable(result) {
    const c = result.check;
    const body = [
      [th('Этаж', { rowSpan: 2 }), th('Порошковые (ОП)', { colSpan: 3 }), {}, {}, th('Углекислотные (ОУ)', { colSpan: 3 }), {}, {}],
      [{}, th('требуется'), th('установлено'), th('недостаёт'), th('требуется'), th('установлено'), th('недостаёт')]
    ];
    result.floors.forEach(function (f) {
      if (!f.units.length) return;
      if (!f.check) { body.push([f.name, { text: 'наличие не проверялось', colSpan: 6, alignment: 'center' }, {}, {}, {}, {}, {}]); return; }
      const k = f.check;
      body.push([f.name, num(k.requiredOP), num(k.installedOP), num(k.deficitOP || '', { bold: true }), num(k.requiredOU), num(k.installedOU), num(k.deficitOU || '', { bold: true })]);
    });
    body.push([{ text: 'Итого', bold: true }, num(c.requiredOP, { bold: true }), num(c.installedOP, { bold: true }), num(c.deficitOP || '', { bold: true }),
      num(c.requiredOU, { bold: true }), num(c.installedOU, { bold: true }), num(c.deficitOU || '', { bold: true })]);
    const out = [{ table: { headerRows: 2, widths: ['*', 54, 62, 58, 54, 62, 58], body: body }, layout: GRID, fontSize: 10, lineHeight: 1.05 }];
    if (result.floors.some(function (f) { return f.fromPlan; })) {
      out.push({ text: 'На этажах со схемой количество установленных огнетушителей взято с неё (отмечено при осмотре).', style: 'note' });
    }
    return out;
  }

  function findingsTable(findings) {
    const list = findings.filter(function (f) { return f.level === 'bad'; }).concat(findings.filter(function (f) { return f.level !== 'bad'; }));
    const body = [[th('№'), th('Место'), th('Выявлено'), th('Необходимо'), th('Основание')]];
    list.forEach(function (f, i) {
      body.push([num(i + 1), f.floor + (f.place ? ', ' + f.place : ''), f.what || f.text, f.action || '', { text: f.ref, fontSize: 9 }]);
    });
    return { table: { headerRows: 1, widths: [18, 80, '*', '*', 74], body: body }, layout: GRID, fontSize: 10, lineHeight: 1.05 };
  }

  // Вывод — обычной фразой; главное слово выделено полужирным.
  function conclusion(result, audit) {
    const c = result.check, s = result.summary, findings = audit ? audit.findings : [];
    if (!result.totals.length) return { text: 'Помещения не введены или по нормам огнетушители не требуются, расчёт не выполнен.' };
    if (!c) {
      const parts = ['Для объекта требуется ' + s.portable + ' ' + plural(s.portable, 'переносной огнетушитель', 'переносных огнетушителя', 'переносных огнетушителей')];
      if (s.wheeled) parts.push(s.wheeled + ' ' + plural(s.wheeled, 'передвижной', 'передвижных', 'передвижных'));
      return { text: parts.join(' и ') + ' (раздел 2). Фактическое наличие огнетушителей не проверялось.' };
    }
    const place = findings.filter(function (f) { return f.level === 'bad' && f.kind !== 'deficit'; }).length;
    const warn = findings.filter(function (f) { return f.level === 'warn'; }).length;
    const floors = result.floors.filter(function (f) { return f.units.length; }).length;
    const bad = !c.ok || place > 0;
    const details = [];
    if (!c.ok) details.push(c.text);
    if (place) details.push('Нарушений размещения: ' + place + '.');
    if (warn) details.push('Требует проверки на месте: ' + warn + '.');
    if (c.floorsChecked < floors) details.push('Не проверено этажей: ' + (floors - c.floorsChecked) + '.');
    return {
      text: [
        'Оснащение объекта огнетушителями требованиям Приложения 3 к Правилам пожарной безопасности ',
        { text: bad ? 'не соответствует' : 'соответствует', bold: true },
        '.' + (details.length ? ' ' + details.join(' ') : '')
      ]
    };
  }

  function signature(text, name) {
    const line = function (w) { return { canvas: [{ type: 'line', x1: 0, y1: 12, x2: w, y2: 12, lineWidth: 0.5, lineColor: INK }] }; };
    return {
      columns: [
        { width: 150, text: text },
        { width: 100, stack: [line(100), { text: '(подпись)', style: 'caption', alignment: 'center', margin: [0, 1, 0, 0] }] },
        { width: '*', stack: [name ? { text: name, margin: [0, 2, 0, 0] } : line(130), { text: '(фамилия, инициалы)', style: 'caption', margin: [0, name ? 0 : 1, 0, 0] }] }
      ],
      columnGap: 10,
      margin: [0, 10, 0, 0]
    };
  }

  // ---------- приложения ----------

  function appendixHead(n, title, dateText) {
    return {
      stack: [
        { text: 'Приложение ' + n, alignment: 'right' },
        { text: 'к расчёту от ' + dateText, alignment: 'right' },
        { text: title, style: 'appendix' }
      ],
      pageBreak: 'before'
    };
  }

  function schemeBlock(caption, sc, width) {
    const pic = PL.svg(sc, width, 230);
    return { width: width, stack: [{ svg: pic.svg, width: pic.width, height: pic.height, alignment: 'center' }, { text: caption, style: 'caption', alignment: 'center', margin: [0, 3, 0, 0] }] };
  }

  function countMarks(sc) {
    const n = PL.tally(sc);
    return 'ОП ' + n.op + ', ОУ ' + n.ou + (n.other ? ', других ' + n.other : '');
  }

  function normText(u) {
    if (u.kind === 'table1') return u.rowTitle + ', ' + u.rowArea + ' м²';
    if (u.kind === 'table5') return 'Табл. 5: ' + String(u.rowTitle).split(/[:,]/)[0];
    if (u.kind === 'exempt') return 'п. 6: допускается не оснащать';
    if (u.kind === 'floorMin') return u.byRules ? 'п. 5: не менее двух на этаже' : 'Не менее двух на этаже (параметр расчёта)';
    return u.norm;
  }

  function classText(u) {
    if (u.kind === 'table5') return 'табл. 5';
    if (u.kind === 'floorMin') return '';
    const cat = u.category === 'PUB' ? 'Общественное' : 'Категория ' + u.categoryLabel;
    return cat + (u.classes.length ? '; ' + u.classes.join(', ') : '');
  }

  function requiredText(u) {
    if (!u.lines.length) return 'не требуется';
    return { text: u.lines.map(function (l) { return l.count + ' × ' + E.lineTitle(l); }).join('\n'), bold: true };
  }

  function basisText(u) {
    if (!u.lines.length) return u.kind === 'exempt' ? 'Помещение категории Д менее 100 м²' : '';
    return u.lines.map(function (l) { return l.basis; }).join('\n');
  }

  // meta: generatedAt — дата формирования; audit — проверка объекта (plan.js: audit);
  // schemes — схемы этажей (plan.js: schemes); link — ссылка на этот расчёт для QR-кода.
  function buildDoc(result, meta) {
    meta = meta || {};
    const audit = meta.audit || null;
    const findings = audit ? audit.findings : [];
    const schemes = meta.schemes || [];
    const b = result.building;
    const generated = meta.generatedAt instanceof Date ? meta.generatedAt : new Date();
    const dateText = formatDate(b.date) || formatDate(generated);
    const appName = meta.appName || APP_NAME;
    const content = [];
    let section = 0;
    function next(title) { section += 1; return heading(section + '. ' + title); }

    // ---------- первая страница ----------
    content.push({ text: 'РАСЧЁТ', style: 'title' });
    content.push({ text: 'необходимого количества первичных средств пожаротушения (огнетушителей)', alignment: 'center', fontSize: 12 });
    content.push({
      text: 'по Приложению 3 к Правилам пожарной безопасности, утверждённым приказом Министра по чрезвычайным ситуациям Республики Казахстан от 21 февраля 2022 года № 55, и СТ РК 1487-2006',
      alignment: 'center', fontSize: 10, margin: [30, 3, 30, 0]
    });
    const city = /^(г\.|город|пос\.|с\.)\s*[^,]+/i.exec(b.address || '');
    content.push({ columns: [{ text: city ? city[0] : '' }, { text: dateText, alignment: 'right' }], margin: [0, 10, 0, 0] });

    content.push(next('Сведения об объекте'));
    content.push(objectTable(result));

    content.push(next('Требуемое количество огнетушителей'));
    if (result.totals.length) needTable(result).forEach(function (x) { content.push(x); });
    else content.push({ text: 'Помещения не введены или по нормам огнетушители не требуются.' });

    if (result.check) {
      content.push(next('Сверка с фактическим наличием'));
      checkTable(result).forEach(function (x) { content.push(x); });
    }

    if (findings.length) {
      content.push(next('Выявленные нарушения и меры по их устранению'));
      content.push(findingsTable(findings));
    }

    content.push(next('Вывод'));
    content.push(conclusion(result, audit));
    if (result.warnings.length) {
      content.push({ text: 'Замечания к исходным данным (' + result.warnings.length + ') приведены в приложении «Расчёт по помещениям».', style: 'note' });
    }

    // подписи и QR-код одним блоком, чтобы не разрывались между страницами
    const sign = {
      stack: [
        signature('Расчёт выполнил', b.inspector),
        signature('С расчётом ознакомлен (представитель объекта)', ''),
        { text: 'Расчёт выполнен в программе «' + appName + '» по исходным данным, введённым пользователем. Расчёт по помещениям и принятые допущения приведены в приложениях.', style: 'note', margin: [0, 10, 0, 0] }
      ]
    };
    if (meta.link) {
      const side = qrSide(meta.link);
      content.push({
        columns: [
          { width: '*', stack: [sign] },
          { width: Math.max(side, 72), stack: [
            { qr: meta.link, fit: side, eccLevel: 'L', foreground: INK, alignment: 'center' },
            { text: 'Электронная версия расчёта', style: 'caption', alignment: 'center', margin: [0, 3, 0, 0] }
          ] }
        ],
        columnGap: 18,
        unbreakable: true,
        margin: [0, 10, 0, 0]
      });
    } else {
      content.push(Object.assign(sign, { unbreakable: true, margin: [0, 10, 0, 0] }));
    }

    // ---------- приложения ----------
    let appendix = 0;

    if (schemes.length) {
      appendix += 1;
      content.push(appendixHead(appendix, 'Схемы размещения огнетушителей', dateText));
      let approx = false, planned = false;
      schemes.forEach(function (sc) {
        // широкий этаж (длинное здание) — схемы друг под другом во всю ширину, иначе рядом
        const v = PL.view(sc.want.box);
        const both = !!sc.fact, wide = v.w > v.h * 1.6;
        const width = wide ? 500 : (both ? 240 : 400);
        const extra = sc.want.ext.filter(function (e) { return e.extra; }).length;
        const blocks = [];
        if (both) blocks.push(schemeBlock('а) фактическое размещение, отмечено при осмотре: ' + countMarks(sc.fact), sc.fact, width));
        blocks.push(schemeBlock((both ? 'б) ' : '') + 'размещение по расчёту: ' + countMarks(sc.want) + (extra ? ', из них по расстоянию ' + extra : ''), sc.want, width));
        if (sc.want.rects.some(function (r) { return r.approx; })) approx = true;
        if (sc.want.rects.some(function (r) { return r.poly; })) planned = true;
        const body = wide || !both
          ? { stack: blocks.map(function (x) { return { stack: x.stack, margin: [0, 0, 0, 8] }; }) }
          : { columns: blocks, columnGap: 14 };
        content.push({ stack: [{ text: sc.name, bold: true, margin: [0, 6, 0, 4] }, body], unbreakable: true, margin: [0, 0, 0, 8] });
      });
      const notes = ['П (белый круг): порошковый огнетушитель', 'У (чёрный круг): углекислотный', 'пунктирная окружность: предельное расстояние до огнетушителя по прямой (п. 4)', 'серая заливка: места дальше нормы'];
      content.push({ text: 'Условные обозначения: ' + notes.join('; ') + '.', style: 'note' });
      const extra = [];
      if (planned) extra.push('контуры помещений построены по загруженному плану этажа');
      if (approx) extra.push('помещения с пунктирным контуром введены без размеров, их форма условная');
      extra.push('передвижные огнетушители и пожарные щиты на схемах не показаны');
      content.push({ text: 'Примечание: ' + extra.join('; ') + '.', style: 'note' });
    }

    appendix += 1;
    content.push(appendixHead(appendix, 'Расчёт по помещениям', dateText));
    if (!result.floors.some(function (f) { return f.units.length; })) content.push({ text: 'Нет данных.' });
    result.floors.forEach(function (f) {
      if (!f.units.length) return;
      const s = floorRooms(f);
      content.push({ text: [{ text: f.name, bold: true }, '. Помещений: ' + s.n + ', площадь ' + E.fmt(s.area) + ' м².'], margin: [0, 8, 0, 4] });
      const body = [[th('№'), th('Помещение'), th('Площадь, м²'), th('Категория, классы пожара'), th('Норма'), th('Требуется'), th('Расчёт')]];
      f.units.forEach(function (u, i) {
        // большая группа небольших помещений (п. 7) — числом и первыми именами, а не столбцом из всех
        const title = u.rooms.length > 4
          ? u.roomCount + ' ' + plural(u.roomCount, 'помещение', 'помещения', 'помещений') + ': ' + u.rooms.slice(0, 3).map(function (r) { return r.name; }).join(', ') + ' и др.'
          : u.title;
        body.push([num(i + 1), title, num(u.areaLabel || ''), classText(u), normText(u), requiredText(u), basisText(u)]);
      });
      content.push({ table: { headerRows: 1, widths: [16, 74, 42, 70, 82, 70, '*'], body: body }, layout: GRID, fontSize: 9.5, lineHeight: 1.05 });
      // пояснения: всё, чего нет в таблице (расстояние, суммирование, АУПТ, серверная…)
      const notes = [];
      f.units.forEach(function (u, i) {
        u.steps.forEach(function (st) {
          if (st.kind === 'row' || st.kind === 'line' || st.kind === 'minor') return;
          notes.push({ text: [{ text: 'К строке ' + (i + 1) + '. ', bold: true }, String(st.text).replace(/\.$/, '') + ' (' + st.ref + ').'] });
        });
        u.notes.forEach(function (n) { notes.push({ text: [{ text: 'К строке ' + (i + 1) + '. ', bold: true }, n] }); });
      });
      if (notes.length) content.push({ stack: notes, fontSize: 9.5, margin: [0, 5, 0, 0] });
    });
    if (result.warnings.length) {
      content.push({ text: 'Замечания к исходным данным', bold: true, margin: [0, 10, 0, 4] });
      content.push({ ol: result.warnings.slice(), fontSize: 9.5 });
    }

    appendix += 1;
    content.push(appendixHead(appendix, 'Требования к размещению, принятые допущения и нормативные документы', dateText));
    content.push({ text: '1. Требования к размещению и содержанию огнетушителей', bold: true, margin: [0, 4, 0, 4] });
    content.push({ ol: result.placement.slice(), fontSize: 10 });
    content.push({ text: '2. Принятые при расчёте допущения', bold: true, margin: [0, 10, 0, 2] });
    content.push({ text: 'Правила не определяют некоторые детали расчёта. Ниже указано, как они решены в этом расчёте.', fontSize: 10, margin: [0, 0, 0, 4] });
    content.push({ ol: result.assumptions.slice(), fontSize: 10 });
    content.push({
      stack: [{ text: '3. Нормативные документы', bold: true, margin: [0, 10, 0, 4] }, { ol: N.SOURCES.map(function (x) { return x.title + '.'; }), fontSize: 10 }],
      unbreakable: true
    });

    return {
      pageSize: 'A4',
      pageMargins: [57, 40, 34, 40],
      info: {
        title: 'Расчёт огнетушителей' + (b.name ? ': ' + b.name : ''),
        author: b.inspector || appName,
        subject: 'Расчёт необходимого количества огнетушителей по Приложению 3 к ППБ РК и СТ РК 1487-2006',
        creator: appName
      },
      // номер страницы посередине верхнего поля, начиная со второй
      header: function (currentPage) {
        if (currentPage === 1) return null;
        return { text: String(currentPage), alignment: 'center', fontSize: 10, margin: [0, 20, 0, 0] };
      },
      content: content,
      defaultStyle: { font: 'Tinos', fontSize: 11, color: INK, lineHeight: 1.15 },
      styles: {
        title: { fontSize: 14, bold: true, alignment: 'center', characterSpacing: 0.5 },
        section: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
        appendix: { fontSize: 12, bold: true, alignment: 'center', margin: [0, 12, 0, 8] },
        note: { fontSize: 9.5, color: SOFT, margin: [0, 4, 0, 0] },
        caption: { fontSize: 8.5, color: SOFT }
      }
    };
  }

  function fileName(result, generatedAt) {
    const d = generatedAt instanceof Date ? generatedAt : new Date();
    const date = /^\d{4}-\d{2}-\d{2}/.test(result.building.date || '') ? result.building.date.slice(0, 10) : isoDate(d);
    const name = (result.building.name || 'объект').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return 'Расчёт_огнетушителей_' + (name || 'объект') + '_' + date + '.pdf';
  }

  return { APP_NAME: APP_NAME, KIND_LABEL: KIND_LABEL, FONTS: FONTS, buildDoc: buildDoc, fileName: fileName, formatDate: formatDate, qrSide: qrSide };
}));
