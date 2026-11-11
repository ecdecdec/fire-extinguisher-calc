/*
 * PDF-отчёт: собирает описание документа для pdfmake из результата расчёта.
 * Чистая функция — не обращается ни к DOM, ни к pdfmake, поэтому проверяется
 * тестами в Node. В браузере: pdfMake.createPdf(FireReport.buildDoc(result)).
 *
 * В тексте используются только знаки, которые есть в шрифте Roboto из
 * vfs_fonts.js (проверяется тестом tests/report.test.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./norms.js'), require('./engine.js'));
  else root.FireReport = factory(root.FireNorms, root.FireEngine);
}(typeof self !== 'undefined' ? self : this, function (N, E) {
  'use strict';

  const APP_NAME = 'Расчёт огнетушителей';
  const KIND_LABEL = {
    public: 'Общественное здание',
    industrial: 'Производственное здание',
    warehouse: 'Складское здание'
  };
  const C = { text: '#1c2530', muted: '#5b6573', line: '#b8bec7', head: '#eef1f4', accent: '#b3261e', ok: '#1a7f4b', bad: '#b3261e', warn: '#8a5a00' };

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

  function requiredText(unit) {
    if (!unit.lines.length) return 'не требуется';
    return unit.lines.map(function (l) { return l.count + ' × ' + E.lineTitle(l); }).join('\n');
  }

  function normShort(unit) {
    if (unit.kind === 'table1') return 'Табл. 1: ' + unit.rowTitle + ' (' + unit.rowArea + ' м²)';
    if (unit.kind === 'table5') return 'Табл. 5: ' + unit.rowTitle;
    return unit.norm;
  }

  function kindWord(kind) {
    return kind === 'wheeled' ? 'передвижной' : kind === 'shield' ? 'пожарный щит' : 'переносной';
  }

  const grid = {
    hLineWidth: function () { return 0.6; },
    vLineWidth: function () { return 0.6; },
    hLineColor: function () { return C.line; },
    vLineColor: function () { return C.line; },
    paddingLeft: function () { return 5; },
    paddingRight: function () { return 5; },
    paddingTop: function () { return 3; },
    paddingBottom: function () { return 3; }
  };

  function th(text, extra) { return Object.assign({ text: text, style: 'th' }, extra || {}); }
  function h2(text) { return { text: text, style: 'h2' }; }
  function bullets(items) {
    return { ul: items.map(function (t) { return { text: t, margin: [0, 0, 0, 2] }; }), style: 'small', margin: [0, 0, 0, 4] };
  }

  function buildDoc(result, meta) {
    meta = meta || {};
    const b = result.building;
    const generated = meta.generatedAt instanceof Date ? meta.generatedAt : new Date();
    const dateText = formatDate(b.date) || formatDate(generated);
    const appName = meta.appName || APP_NAME;
    const content = [];
    let section = 0;
    function nextSection(title) { section += 1; return h2(section + '. ' + title); }

    // ---------- шапка ----------
    const qrPayload = ['FIRECALC', b.date || isoDate(generated), E.summaryCode(result) || '-', 'S=' + Math.round(result.summary.area)].join('|');
    content.push({
      columns: [
        {
          width: '*',
          stack: [
            { text: 'РАСЧЁТ', style: 'title' },
            { text: 'необходимого количества и типов огнетушителей', style: 'subtitle' },
            { text: 'по Приложению 3 к Правилам пожарной безопасности Республики Казахстан (приказ МЧС РК от 21.02.2022 № 55) и СТ РК 1487-2006', style: 'small', color: C.muted, margin: [0, 4, 0, 0] }
          ]
        },
        { width: 64, qr: qrPayload, fit: 64, eccLevel: 'M', foreground: C.text }
      ],
      columnGap: 16,
      margin: [0, 0, 0, 12]
    });

    content.push({
      table: {
        widths: [150, '*'],
        body: [
          ['Объект', b.name || '—'],
          ['Адрес', b.address || '—'],
          ['Собственник (организация)', b.owner || '—'],
          ['Функциональное назначение', KIND_LABEL[b.kind] || '—'],
          ['Этажей / помещений / площадь', result.summary.floors + ' / ' + result.summary.rooms + ' / ' + E.fmt(result.summary.area) + ' м²'],
          ['Дата расчёта', dateText],
          ['Расчёт выполнил', b.inspector || '—']
        ].map(function (r) { return [{ text: r[0], color: C.muted }, { text: r[1] }]; })
      },
      layout: grid,
      margin: [0, 0, 0, 6]
    });

    // ---------- итог ----------
    content.push(nextSection('Итог: требуется по нормам'));
    if (result.totals.length) {
      const body = [[th('№'), th('Огнетушитель'), th('Вид'), th('Заряд'), th('Количество', { alignment: 'right' })]];
      result.totals.forEach(function (t, i) {
        body.push([
          String(i + 1),
          { text: [{ text: t.code, bold: true }, t.name ? { text: ' — ' + t.name, color: C.muted } : ''] },
          kindWord(t.kind),
          t.charge ? 'порошок ' + t.charge : '—',
          { text: t.count + (t.kind === 'shield' ? ' компл.' : ' шт.'), bold: true, alignment: 'right' }
        ]);
      });
      content.push({ table: { headerRows: 1, widths: [18, '*', 70, 80, 62], body: body }, layout: grid });
      const parts = ['Всего переносных: ' + result.summary.portable + ' шт.'];
      if (result.summary.wheeled) parts.push('передвижных: ' + result.summary.wheeled + ' шт.');
      if (result.summary.shields) parts.push('пожарных щитов: ' + result.summary.shields + ' компл.');
      content.push({ text: parts.join(', '), margin: [0, 5, 0, 0], bold: true });
    } else {
      content.push({ text: 'Помещения не введены или по нормам огнетушители не требуются.', color: C.muted });
    }

    // ---------- сверка с фактом ----------
    if (result.check) {
      content.push(nextSection('Сверка с фактическим наличием'));
      const body = [[
        th('Этаж'), th('ОП: требуется', { alignment: 'right' }), th('ОП: есть', { alignment: 'right' }), th('ОП: не хватает', { alignment: 'right' }),
        th('ОУ: требуется', { alignment: 'right' }), th('ОУ: есть', { alignment: 'right' }), th('ОУ: не хватает', { alignment: 'right' })
      ]];
      function cells(name, c, bold) {
        function num(v, bad) { return { text: String(v), alignment: 'right', bold: !!bold || (bad && v > 0), color: bad && v > 0 ? C.bad : C.text }; }
        return [{ text: name, bold: !!bold }, num(c.requiredOP), num(c.installedOP), num(c.deficitOP, true), num(c.requiredOU), num(c.installedOU), num(c.deficitOU, true)];
      }
      result.floors.forEach(function (f) {
        if (f.check) body.push(cells(f.name, f.check));
        else body.push([{ text: f.name }, { text: 'фактическое наличие не указано', colSpan: 6, color: C.muted }, {}, {}, {}, {}, {}]);
      });
      body.push(cells('Итого', result.check, true));
      content.push({ table: { headerRows: 1, widths: ['*', 58, 44, 62, 58, 44, 62], body: body }, layout: grid });
      content.push({
        text: [{ text: 'Вывод: ', bold: true }, { text: result.check.ok ? 'соответствует. ' : 'не соответствует. ', bold: true, color: result.check.ok ? C.ok : C.bad }, result.check.text],
        margin: [0, 5, 0, 0]
      });
      content.push({ text: 'Сверяется количество ручных порошковых (ОП) и углекислотных (ОУ) огнетушителей по этажам. Типоразмер, заряд, исправность и размещение проверяются при осмотре.', style: 'small', color: C.muted, margin: [0, 3, 0, 0] });
    }

    // ---------- расчёт по этажам ----------
    content.push(nextSection('Расчёт по этажам'));
    if (!result.floors.some(function (f) { return f.units.length; })) {
      content.push({ text: 'Нет данных.', color: C.muted });
    }
    result.floors.forEach(function (f) {
      if (!f.units.length) return;
      const p = f.portable;
      const sub = ['переносных: ' + (p.powder + p.co2 + p.other) + ' шт. (ОП — ' + p.powder + ', ОУ — ' + p.co2 + (p.other ? ', прочих — ' + p.other : '') + ')'];
      if (f.wheeled) sub.push('передвижных: ' + f.wheeled + ' шт.');
      content.push({ text: [{ text: f.name, bold: true }, { text: '   ' + sub.join('; '), color: C.muted }], style: 'h3' });
      const body = [[th('№'), th('Помещения'), th('Площадь, м²', { alignment: 'right' }), th('Норма'), th('Классы пожара'), th('Требуется')]];
      f.units.forEach(function (u, i) {
        body.push([
          String(i + 1),
          { text: u.title },
          { text: u.areaLabel || '—', alignment: 'right' },
          { text: normShort(u), style: 'small' },
          u.classes.length ? u.classes.join(', ') : '—',
          { text: requiredText(u), bold: u.lines.length > 0, color: u.lines.length ? C.text : C.muted }
        ]);
      });
      content.push({ table: { headerRows: 1, widths: [16, '*', 46, 128, 46, 104], body: body }, layout: grid, margin: [0, 0, 0, 6] });

      f.units.forEach(function (u, i) {
        const stack = [];
        // Подзаголовок держится вместе с первым пунктом, чтобы не оставаться внизу страницы.
        if (i === 0) stack.push({ text: 'Обоснование', style: 'small', bold: true, color: C.muted, margin: [0, 0, 0, 3] });
        stack.push({ text: (i + 1) + '. ' + u.title, bold: true, style: 'small', margin: [0, 0, 0, 1] });
        u.steps.forEach(function (s) {
          stack.push({ text: [{ text: s.ref + ': ', color: C.muted }, s.text], style: 'small', margin: [10, 0, 0, 1] });
        });
        u.notes.forEach(function (n) {
          stack.push({ text: 'Примечание: ' + n, style: 'small', color: C.muted, margin: [10, 0, 0, 1] });
        });
        content.push({ stack: stack, margin: [0, 0, 0, 4], unbreakable: stack.length <= 9 });
      });
    });

    // ---------- размещение ----------
    content.push(nextSection('Требования к размещению и содержанию'));
    content.push(bullets(result.placement));

    // ---------- предупреждения ----------
    if (result.warnings.length) {
      content.push(nextSection('Требует внимания'));
      content.push(Object.assign(bullets(result.warnings), { color: C.warn }));
    }

    // ---------- подписи ----------
    // Подписи стоят сразу после расчёта; допущения и источники идут за ними
    // как справочная часть — так подписи не остаются одни на последней странице.
    function signature(label, name) {
      return {
        columns: [
          { width: 170, text: label },
          { width: 150, stack: [{ canvas: [{ type: 'line', x1: 0, y1: 11, x2: 150, y2: 11, lineWidth: 0.6, lineColor: C.text }] }, { text: '(подпись)', style: 'tiny', alignment: 'center', margin: [0, 2, 0, 0] }] },
          { width: '*', stack: [name ? { text: name, margin: [0, 0, 0, 1] } : { canvas: [{ type: 'line', x1: 0, y1: 11, x2: 160, y2: 11, lineWidth: 0.6, lineColor: C.text }] }, { text: '(фамилия, инициалы)', style: 'tiny', margin: [0, name ? 0 : 2, 0, 0] }] }
        ],
        columnGap: 12,
        margin: [0, 10, 0, 0]
      };
    }
    content.push({
      stack: [
        signature('Расчёт выполнил', b.inspector),
        signature('С расчётом ознакомлен (представитель объекта)', ''),
        { text: 'Расчёт сформирован автоматически по указанным нормам и допущениям. Исходные данные (площади, категории помещений, классы пожара) введены пользователем. Результат подлежит проверке должностным лицом.', style: 'tiny', color: C.muted, margin: [0, 12, 0, 0] }
      ],
      unbreakable: true,
      margin: [0, 8, 0, 6]
    });

    // ---------- справочная часть: допущения и источники ----------
    content.push(nextSection('Принятые допущения'));
    content.push({ text: 'Правила не определяют некоторые детали расчёта. Ниже указано, как они решены в этом расчёте.', style: 'small', color: C.muted, margin: [0, 0, 0, 3] });
    content.push(bullets(result.assumptions));

    // Заголовок и список держатся вместе, чтобы раздел не разрывался между страницами.
    content.push({
      stack: [nextSection('Нормативные источники'), bullets(N.SOURCES.map(function (s) { return s.title + '.'; }))],
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
            { text: appName + ' · нормы: Прил. 3 к ППБ РК (приказ № 55), СТ РК 1487-2006', style: 'tiny', color: C.muted },
            { text: 'стр. ' + currentPage + ' из ' + pageCount, style: 'tiny', color: C.muted, alignment: 'right', width: 70 }
          ],
          margin: [40, 16, 40, 0]
        };
      },
      content: content,
      defaultStyle: { font: 'Roboto', fontSize: 9.5, color: C.text, lineHeight: 1.15 },
      styles: {
        title: { fontSize: 20, bold: true, characterSpacing: 1 },
        subtitle: { fontSize: 13, bold: true },
        h2: { fontSize: 11.5, bold: true, margin: [0, 12, 0, 5] },
        h3: { fontSize: 10, margin: [0, 6, 0, 4] },
        th: { bold: true, fontSize: 8.5, fillColor: C.head },
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

  return { APP_NAME: APP_NAME, KIND_LABEL: KIND_LABEL, buildDoc: buildDoc, fileName: fileName, formatDate: formatDate };
}));
