/*
 * PDF-отчёт: описание документа для pdfmake из результата расчёта.
 * Чистая функция — без DOM и без pdfmake, поэтому проверяется тестами в Node.
 * В браузере: pdfMake.createPdf(FireReport.buildDoc(result, meta)).
 *
 * Первая страница — заключение, его читают и подписывают: вывод, что требуется,
 * что сделать, по этажам, подписи и QR-код. Дальше приложения: схемы размещения,
 * расчёт по помещениям, правила и допущения.
 *
 * В тексте только знаки, которые есть в шрифте Roboto из vfs_fonts.js
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
  const C = {
    text: '#1c2530', muted: '#5b6573', faint: '#8a939e', line: '#d6dae0',
    red: '#b3261e', redBg: '#fbeceb', green: '#1a7f4b', greenBg: '#e8f4ed', amber: '#8a5a00', infoBg: '#f1f3f5',
    powder: '#c4291c', co2: '#1c2530'
  };

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
  // ссылки — 2 pt: код 2–4 см, как обычно на документах. С бумаги читается камерой телефона,
  // с экрана — при увеличении страницы.
  function qrSide(text) {
    const bytes = new TextEncoder().encode(text).length;
    let v = 1;
    while (v < 40 && QR_CAP_L[v - 1] < bytes) v += 1;
    const n = 17 + 4 * v;
    return (2 * (n + 4) <= 92 ? 2 : 1) * (n + 4);
  }

  // ---------- оформление ----------

  // Таблица без рамок: строки разделены тонкими линиями.
  const rows = {
    hLineWidth: function (i) { return i === 0 ? 0 : 0.6; },
    vLineWidth: function () { return 0; },
    hLineColor: function () { return C.line; },
    paddingLeft: function (i) { return i === 0 ? 0 : 6; },
    paddingRight: function (i, node) { return i === node.table.widths.length - 1 ? 0 : 6; },
    paddingTop: function () { return 4; },
    paddingBottom: function () { return 4; }
  };
  const boxes = {
    hLineWidth: function () { return 0.6; },
    vLineWidth: function () { return 0.6; },
    hLineColor: function () { return C.line; },
    vLineColor: function () { return C.line; },
    paddingLeft: function () { return 10; },
    paddingRight: function () { return 10; },
    paddingTop: function () { return 8; },
    paddingBottom: function () { return 9; }
  };

  function th(text, extra) { return Object.assign({ text: text, style: 'th' }, extra || {}); }
  function label(text) { return { text: text.toUpperCase(), style: 'label' }; }
  function bullets(items, color) {
    return { ul: items.map(function (t) { return { text: t, margin: [0, 0, 0, 3] }; }), style: 'small', color: color || C.text, margin: [0, 0, 0, 6] };
  }

  // «4 × ОП-5, 1 × ОУ-3» — что требуется на этаже.
  function needOf(f) {
    const sum = {}, order = [];
    f.units.forEach(function (u) {
      u.lines.forEach(function (l) {
        const key = l.code + (l.charge === 'D' ? ' (D)' : '');
        if (sum[key] === undefined) { sum[key] = 0; order.push(key); }
        sum[key] += l.count;
      });
    });
    return order.length ? order.map(function (k) { return sum[k] + ' × ' + k; }).join(', ') : 'не требуется';
  }

  function floorRooms(f) {
    let n = 0, area = 0;
    f.units.forEach(function (u) { u.rooms.forEach(function (r) { n += r.count; area += r.area * r.count; }); });
    return { n: n, area: area };
  }

  // ---------- вывод ----------

  function verdict(result, audit) {
    const c = result.check, findings = audit ? audit.findings : [];
    const total = result.summary.portable + result.summary.wheeled;
    if (!c) {
      if (!result.totals.length) return { tone: 'info', title: 'Нет данных', text: 'Помещения не введены или по нормам огнетушители не требуются.' };
      return {
        tone: 'info', title: 'Требуется ' + total + ' ' + plural(total, 'огнетушитель', 'огнетушителя', 'огнетушителей'),
        text: 'Фактическое наличие не вносилось — это расчёт потребности по нормам.'
      };
    }
    const place = findings.filter(function (f) { return f.level === 'bad' && f.kind !== 'deficit'; }).length;
    const warn = findings.filter(function (f) { return f.level === 'warn'; }).length;
    const floors = result.floors.filter(function (f) { return f.units.length; }).length;
    const parts = [];
    if (!c.ok) parts.push(c.text);
    else parts.push('Огнетушителей ' + (c.floorsChecked < floors ? 'на проверенных этажах ' : '') + 'достаточно.');
    if (place) parts.push('Нарушений размещения: ' + place + '.');
    if (warn) parts.push('Проверить на месте: ' + warn + '.');
    if (c.floorsChecked < floors) parts.push('Не проверено этажей: ' + (floors - c.floorsChecked) + '.');
    const bad = !c.ok || place > 0;
    return { tone: bad ? 'bad' : 'ok', title: bad ? 'Не соответствует' : 'Соответствует', text: parts.join(' ') };
  }

  function verdictBlock(v) {
    const color = v.tone === 'bad' ? C.red : (v.tone === 'ok' ? C.green : C.text);
    const bg = v.tone === 'bad' ? C.redBg : (v.tone === 'ok' ? C.greenBg : C.infoBg);
    const bar = v.tone === 'info' ? C.faint : color;
    return {
      table: { widths: ['*'], body: [[{ stack: [{ text: v.title, style: 'verdict', color: color }, { text: v.text, margin: [0, 3, 0, 0] }], fillColor: bg }]] },
      layout: {
        hLineWidth: function () { return 0; },
        vLineWidth: function (i) { return i === 0 ? 3 : 0; },
        vLineColor: function () { return bar; },
        paddingLeft: function () { return 12; },
        paddingRight: function () { return 12; },
        paddingTop: function () { return 10; },
        paddingBottom: function () { return 11; }
      }
    };
  }

  // ---------- что требуется: по карточке на тип огнетушителя ----------

  function card(t) {
    const color = t.agent === 'powder' ? C.powder : (t.agent === 'co2' ? C.co2 : C.faint);
    return {
      stack: [
        { canvas: [{ type: 'rect', x: 0, y: 0, w: 24, h: 3, color: color }], margin: [0, 0, 0, 6] },
        { text: [{ text: String(t.count), style: 'big' }, { text: t.kind === 'shield' ? ' компл.' : ' шт.', color: C.muted }] },
        { text: t.code + (t.charge === 'D' ? ' (D)' : ''), bold: true, margin: [0, 3, 0, 0] },
        { text: [t.name, t.charge ? 'порошок ' + t.charge : ''].filter(Boolean).join(', '), style: 'small', color: C.muted }
      ]
    };
  }

  function cards(totals) {
    const per = 4, out = [];
    for (let i = 0; i < totals.length; i += per) {
      const row = totals.slice(i, i + per).map(card);
      while (row.length < per) row.push({ text: '', border: [false, false, false, false] });
      out.push({ table: { widths: [ '*', '*', '*', '*' ], body: [row] }, layout: boxes, margin: [0, 0, 0, 6] });
    }
    return out;
  }

  // ---------- что сделать ----------

  function todoTable(findings) {
    const list = findings.filter(function (f) { return f.level === 'bad'; }).concat(findings.filter(function (f) { return f.level !== 'bad'; }));
    const body = [[th('№'), th('Где'), th('Что сделать'), th('Основание')]];
    list.forEach(function (f, i) {
      body.push([
        { text: String(i + 1), color: C.muted },
        { text: f.floor + (f.room ? ', «' + f.room + '»' : '') },
        { text: f.action || f.text, color: f.level === 'warn' ? C.amber : C.text },
        { text: f.ref, style: 'small', color: C.muted }
      ]);
    });
    return { table: { headerRows: 1, widths: [14, 118, '*', 104], body: body }, layout: rows };
  }

  // ---------- по этажам ----------

  function floorsTable(result, audit) {
    const floors = result.floors.filter(function (f) { return f.units.length; });
    if (!floors.length) return null;
    const right = { alignment: 'right' };
    if (!result.check) {
      const body = [[th('Этаж'), th('Помещений', right), th('Площадь, м²', right), th('Требуется')]];
      floors.forEach(function (f) {
        const s = floorRooms(f);
        body.push([f.name, { text: String(s.n), alignment: 'right' }, { text: E.fmt(s.area), alignment: 'right' }, { text: needOf(f), bold: true }]);
      });
      return { table: { headerRows: 1, widths: ['*', 60, 70, 210], body: body }, layout: rows };
    }
    const findings = audit ? audit.findings : [];
    const body = [[th('Этаж'), th('Требуется'), th('Установлено'), th('Вывод')]];
    floors.forEach(function (f) {
      const c = f.check;
      let outcome;
      if (!c) outcome = { text: 'не проверялся', color: C.muted };
      else {
        const parts = [];
        if (c.deficitOP) parts.push('не хватает ОП: ' + c.deficitOP);
        if (c.deficitOU) parts.push('не хватает ОУ: ' + c.deficitOU);
        const mine = findings.filter(function (x) { return x.floorId === f.id && x.kind !== 'deficit'; });
        const bad = mine.filter(function (x) { return x.level === 'bad'; }).length, warn = mine.length - bad;
        if (bad) parts.push('нарушений размещения: ' + bad);
        if (warn) parts.push('проверить на месте: ' + warn);
        outcome = parts.length ? { text: parts.join('; '), color: c.deficitOP || c.deficitOU || bad ? C.red : C.amber } : { text: 'в норме', color: C.green };
      }
      body.push([
        f.name,
        needOf(f),
        c ? 'ОП — ' + c.installedOP + ', ОУ — ' + c.installedOU + (f.fromPlan ? ' (по схеме)' : '') : { text: '—', color: C.muted },
        outcome
      ]);
    });
    return { table: { headerRows: 1, widths: [80, '*', 120, 130], body: body }, layout: rows };
  }

  // ---------- подписи ----------

  function signature(text, name) {
    const line = function (w) { return { canvas: [{ type: 'line', x1: 0, y1: 11, x2: w, y2: 11, lineWidth: 0.6, lineColor: C.text }] }; };
    return {
      columns: [
        { width: 140, text: text },
        { width: 100, stack: [line(100), { text: '(подпись)', style: 'tiny', color: C.muted, alignment: 'center', margin: [0, 2, 0, 0] }] },
        { width: '*', stack: [name ? { text: name } : line(110), { text: '(фамилия, инициалы)', style: 'tiny', color: C.muted, margin: [0, name ? 1 : 2, 0, 0] }] }
      ],
      columnGap: 10,
      margin: [0, 12, 0, 0]
    };
  }

  // ---------- приложения ----------

  function schemeBlock(caption, sc, width) {
    const pic = PL.svg(sc, width, 230);
    return { width: width, stack: [{ text: caption, style: 'small', color: C.muted, margin: [0, 0, 0, 4] }, { svg: pic.svg, width: pic.width, height: pic.height }] };
  }

  function countMarks(sc) {
    const n = PL.tally(sc);
    return 'ОП — ' + n.op + ', ОУ — ' + n.ou + (n.other ? ', других — ' + n.other : '');
  }

  function normText(u) {
    if (u.kind === 'table1') {
      return u.rowTitle + ', ' + u.rowArea + ' м²' + (u.category === 'PUB' ? '' : ' · кат. ' + u.categoryLabel) + (u.classes.length ? ' · ' + u.classes.join(', ') : '');
    }
    if (u.kind === 'table5') return 'Табл. 5: ' + u.rowTitle;
    if (u.kind === 'exempt') return 'Категория Д, менее 100 м² (п. 6)';
    if (u.kind === 'floorMin') return 'Не менее двух на этаже' + (u.byRules ? ' (п. 5)' : ' (параметр расчёта)');
    return u.norm;
  }

  function requiredText(u) {
    if (!u.lines.length) return { text: 'не требуется', color: C.muted };
    return { text: u.lines.map(function (l) { return l.count + ' × ' + E.lineTitle(l); }).join('\n'), bold: true };
  }

  function basisText(u) {
    if (!u.lines.length) return { text: u.kind === 'exempt' ? 'допускается не оснащать' : '—', color: C.muted };
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
    const s = result.summary;
    const content = [];

    // ---------- страница 1: заключение ----------
    const facts = [
      b.address,
      KIND_LABEL[b.kind],
      s.floors + ' ' + plural(s.floors, 'этаж', 'этажа', 'этажей') + ', ' + s.rooms + ' ' + plural(s.rooms, 'помещение', 'помещения', 'помещений') + ', ' + E.fmt(s.area) + ' м²',
      b.owner
    ].filter(Boolean);
    content.push({
      columns: [
        { width: '*', stack: [
          { text: 'РАСЧЁТ ОГНЕТУШИТЕЛЕЙ', style: 'eyebrow' },
          { text: b.name || 'Объект без названия', style: 'title' },
          { text: facts.join(' · '), style: 'meta', margin: [0, 3, 0, 0] }
        ] },
        { width: 140, stack: [
          { text: dateText, alignment: 'right', bold: true },
          { text: b.inspector || '', alignment: 'right', style: 'meta' }
        ] }
      ],
      columnGap: 16,
      margin: [0, 0, 0, 14]
    });

    content.push(verdictBlock(verdict(result, audit)));

    if (result.totals.length) {
      content.push(label('Требуется по нормам'));
      cards(result.totals).forEach(function (t) { content.push(t); });
      const parts = ['всего переносных — ' + s.portable];
      if (s.wheeled) parts.push('передвижных — ' + s.wheeled);
      if (s.shields) parts.push('пожарных щитов — ' + s.shields);
      content.push({ text: parts.join(', ') + '. Заряд порошковых — по примечанию 2 к табл. 1.', style: 'small', color: C.muted });
    }

    if (findings.length) {
      content.push(label('Что сделать'));
      content.push(todoTable(findings));
    }

    const ft = floorsTable(result, audit);
    if (ft) {
      content.push(label('По этажам'));
      content.push(ft);
    }

    if (result.warnings.length) {
      content.push({ text: 'Замечаний к исходным данным: ' + result.warnings.length + ' — см. приложение «Расчёт по помещениям».', style: 'small', color: C.amber, margin: [0, 8, 0, 0] });
    }

    // подписи и QR-код — одним блоком, чтобы не разрывались между страницами
    const sign = {
      stack: [
        signature('Расчёт выполнил', b.inspector),
        signature('С расчётом ознакомлен (представитель объекта)', ''),
        { text: 'Расчёт выполнен автоматически по нормам и допущениям, приведённым в приложении. Исходные данные введены пользователем; результат подлежит проверке должностным лицом.', style: 'tiny', color: C.muted, margin: [0, 12, 0, 0] }
      ]
    };
    if (meta.link) {
      const side = qrSide(meta.link);
      content.push({
        columns: [
          { width: '*', stack: [sign] },
          { width: Math.max(side, 70), stack: [
            { qr: meta.link, fit: side, eccLevel: 'L', foreground: C.text, alignment: 'center' },
            { text: 'Открыть расчёт на телефоне', style: 'tiny', color: C.muted, alignment: 'center', margin: [0, 3, 0, 0] }
          ] }
        ],
        columnGap: 20,
        unbreakable: true,
        margin: [0, 16, 0, 0]
      });
    } else {
      content.push(Object.assign(sign, { unbreakable: true, margin: [0, 16, 0, 0] }));
    }

    // ---------- приложения ----------
    let appendix = 0;
    function appendixTitle(title) {
      appendix += 1;
      return { text: 'Приложение ' + appendix + '. ' + title, style: 'h2', pageBreak: appendix === 1 ? 'before' : undefined };
    }

    if (schemes.length) {
      // заголовок — отдельно: переход на новую страницу внутри неразрывного блока pdfmake не выполняет и теряет блок
      content.push(appendixTitle('Схемы размещения огнетушителей'));
      content.push({
        text: 'П — порошковый (ОП), У — углекислотный (ОУ). Пунктирный круг — предельное расстояние по прямой (п. 4); красным закрашены места дальше нормы. «Как есть» — отмечено при осмотре, «По нормам» — расчётная расстановка.',
        style: 'small', color: C.muted, margin: [0, 0, 0, 6]
      });
      let approx = false, planned = false;
      schemes.forEach(function (sc) {
        const both = !!sc.fact, width = both ? 250 : 400;
        const extra = sc.want.ext.filter(function (e) { return e.extra; }).length;
        const cols = [];
        if (both) cols.push(schemeBlock('Как есть — отмечено при осмотре: ' + countMarks(sc.fact), sc.fact, width));
        cols.push(schemeBlock('По нормам — расчётная расстановка: ' + countMarks(sc.want) + (extra ? ' (из них по расстоянию — ' + extra + ')' : ''), sc.want, width));
        if (sc.want.rects.some(function (r) { return r.approx; })) approx = true;
        if (sc.want.rects.some(function (r) { return r.poly; })) planned = true;
        content.push({ stack: [{ text: sc.name, bold: true, style: 'h3' }, { columns: cols, columnGap: 15 }], unbreakable: true, margin: [0, 0, 0, 8] });
      });
      const notes = [];
      if (planned) notes.push('контуры помещений — по загруженному плану этажа');
      if (approx) notes.push('помещения с пунктирным контуром введены без размеров, их форма условная');
      notes.push('передвижные огнетушители и пожарные щиты на схеме не показаны');
      content.push({ text: 'Примечание: ' + notes.join('; ') + '.', style: 'small', color: C.muted, margin: [0, 2, 0, 0] });
    }

    content.push(appendixTitle('Расчёт по помещениям'));
    if (!result.floors.some(function (f) { return f.units.length; })) content.push({ text: 'Нет данных.', color: C.muted });
    result.floors.forEach(function (f) {
      if (!f.units.length) return;
      const p = f.portable;
      const sub = ['переносных — ' + (p.powder + p.co2 + p.other) + ' (ОП — ' + p.powder + ', ОУ — ' + p.co2 + (p.other ? ', прочих — ' + p.other : '') + ')'];
      if (f.wheeled) sub.push('передвижных — ' + f.wheeled);
      content.push({ text: [{ text: f.name, bold: true }, { text: '   ' + sub.join('; '), color: C.muted }], style: 'h3' });
      const body = [[th('№'), th('Помещения'), th('Площадь, м²', { alignment: 'right' }), th('Норма'), th('Требуется'), th('Как посчитано')]];
      f.units.forEach(function (u, i) {
        // большая группа небольших помещений (п. 7) — числом и первыми именами, а не столбцом из всех
        const title = u.rooms.length > 4
          ? u.roomCount + ' ' + plural(u.roomCount, 'помещение', 'помещения', 'помещений') + ': ' + u.rooms.slice(0, 3).map(function (r) { return r.name; }).join(', ') + ' и др.'
          : u.title;
        body.push([
          { text: String(i + 1), color: C.muted },
          title,
          { text: u.areaLabel || '—', alignment: 'right' },
          { text: normText(u), style: 'small' },
          requiredText(u),
          { text: basisText(u), style: 'small' }
        ]);
      });
      content.push({ table: { headerRows: 1, widths: [14, '*', 44, 112, 84, 150], body: body }, layout: rows, fontSize: 8.5 });
      // пояснения: всё, чего нет в таблице (расстояние, суммирование, АУПТ, серверная…)
      const notes = [];
      f.units.forEach(function (u, i) {
        u.steps.forEach(function (st) {
          if (st.kind === 'row' || st.kind === 'line' || st.kind === 'minor') return;
          notes.push({ text: [{ text: (i + 1) + '. ', bold: true }, { text: st.ref + ': ', color: C.muted }, st.text], margin: [0, 0, 0, 2] });
        });
        u.notes.forEach(function (n) { notes.push({ text: [{ text: (i + 1) + '. ', bold: true }, { text: n, color: C.muted }], margin: [0, 0, 0, 2] }); });
      });
      if (notes.length) content.push({ stack: notes, style: 'small', margin: [0, 6, 0, 4] });
    });
    if (result.warnings.length) {
      content.push({ text: 'Замечания к исходным данным', bold: true, style: 'h3', color: C.amber });
      content.push(bullets(result.warnings, C.amber));
    }

    content.push(appendixTitle('Правила размещения, допущения и источники'));
    content.push({ text: 'Требования к размещению и содержанию', bold: true, style: 'h3' });
    content.push(bullets(result.placement));
    content.push({ text: 'Принятые допущения', bold: true, style: 'h3' });
    content.push({ text: 'Правила не определяют некоторые детали расчёта. Ниже указано, как они решены в этом расчёте.', style: 'small', color: C.muted, margin: [0, 0, 0, 4] });
    content.push(bullets(result.assumptions));
    content.push({
      stack: [{ text: 'Нормативные источники', bold: true, style: 'h3' }, bullets(N.SOURCES.map(function (x) { return x.title + '.'; }))],
      unbreakable: true
    });

    return {
      pageSize: 'A4',
      pageMargins: [40, 44, 40, 48],
      info: {
        title: 'Расчёт огнетушителей' + (b.name ? ': ' + b.name : ''),
        author: b.inspector || appName,
        subject: 'Расчёт количества и типов огнетушителей по Приложению 3 к ППБ РК и СТ РК 1487-2006',
        creator: appName
      },
      header: function (currentPage) {
        if (currentPage === 1) return null;
        return { text: (b.name || 'Расчёт огнетушителей') + ' · ' + dateText, style: 'tiny', color: C.muted, margin: [40, 22, 40, 0] };
      },
      footer: function (currentPage, pageCount) {
        return {
          columns: [
            { text: appName + ' · Прил. 3 к ППБ РК (приказ № 55), СТ РК 1487-2006', style: 'tiny', color: C.muted },
            { text: 'стр. ' + currentPage + ' из ' + pageCount, style: 'tiny', color: C.muted, alignment: 'right', width: 70 }
          ],
          margin: [40, 16, 40, 0]
        };
      },
      content: content,
      defaultStyle: { font: 'Roboto', fontSize: 9.5, color: C.text, lineHeight: 1.2 },
      styles: {
        eyebrow: { fontSize: 8, bold: true, color: C.muted, characterSpacing: 0.8 },
        title: { fontSize: 18, bold: true, margin: [0, 3, 0, 0] },
        meta: { fontSize: 9, color: C.muted },
        verdict: { fontSize: 15, bold: true },
        label: { fontSize: 8, bold: true, color: C.muted, characterSpacing: 0.8, margin: [0, 16, 0, 6] },
        big: { fontSize: 20, bold: true },
        h2: { fontSize: 13, bold: true, margin: [0, 0, 0, 8] },
        h3: { fontSize: 10.5, margin: [0, 12, 0, 5] },
        th: { bold: true, fontSize: 8, color: C.muted },
        small: { fontSize: 8.5 },
        tiny: { fontSize: 7.5 }
      }
    };
  }

  function fileName(result, generatedAt) {
    const d = generatedAt instanceof Date ? generatedAt : new Date();
    const date = /^\d{4}-\d{2}-\d{2}/.test(result.building.date || '') ? result.building.date.slice(0, 10) : isoDate(d);
    const name = (result.building.name || 'объект').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return 'Расчёт_огнетушителей_' + (name || 'объект') + '_' + date + '.pdf';
  }

  return { APP_NAME: APP_NAME, KIND_LABEL: KIND_LABEL, buildDoc: buildDoc, fileName: fileName, formatDate: formatDate, qrSide: qrSide };
}));
