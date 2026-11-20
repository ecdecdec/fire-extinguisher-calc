/*
 * Значки на схеме этажа — знаки безопасности по ГОСТ 12.4.026-2015 «Цвета
 * сигнальные, знаки безопасности и разметка сигнальная» (межгосударственный
 * стандарт, принят в том числе Казахстаном).
 *
 * Почему так:
 *   — места размещения первичных средств пожаротушения обозначаются знаками
 *     пожарной безопасности, а их цветографическое изображение — по документам
 *     по стандартизации (Правила пожарной безопасности РК, п. 18 и п. 166);
 *   — на плане показывают эвакуационные выходы, кнопки ручных пожарных
 *     извещателей, телефоны, пожарные краны и огнетушители (там же, прил. 2, п. 1);
 *   — знаки пожарной безопасности — красный квадрат с белым символом, эвакуационные —
 *     зелёный квадрат с белым символом (ГОСТ 12.4.026-2015, табл. 1 и 2);
 *   — корпус огнетушителя любого типа красный (ГОСТ 30612-99, п. 4.4.28; ГОСТ 12.4.026-2015,
 *     п. 5.1.2), поэтому тип различается не цветом знака, а буквой в кружке у знака:
 *     П — порошковый, У — углекислотный (ГОСТ 28130-89, п. 1.2 и 1.5: символ дополняется
 *     буквенным обозначением, которое объясняется в условных обозначениях).
 *
 * Символы нарисованы заново в поле 100 × 100 по образцам приложений К и Л
 * стандарта и упрощены так, чтобы читаться при размере 16–24 точки.
 * Чистые функции, без DOM: тот же код рисует знаки в интерфейсе, в PDF и в тестах.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FireSigns = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Сигнальные цвета (ГОСТ 12.4.026-2015, табл. 1; образцы RAL 3020, 6024, 9003, 9004 — прил. В, табл. В.1).
  // Оттенок на экране приблизительный: RAL задаёт краску, а не точку экрана.
  const COLORS = {
    red: '#C1121C',
    green: '#008351',
    white: '#FFFFFF',
    black: '#1A1A1A'
  };

  // Белые символы знаков в поле 100 × 100 (фон знака рисуется отдельно).
  const W = 'fill="#FFFFFF"';
  const WS = 'fill="none" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round"';
  const SYMBOLS = {
    // F04 «Огнетушитель»: корпус, горловина, рычаг, шланг с раструбом
    F04: '<rect x="41" y="37" width="22" height="50" rx="7" ' + W + '/>' +
      '<rect x="46.5" y="27" width="11" height="11" ' + W + '/>' +
      '<path d="M44 27 L64 19.5 L66 24 L47 31 Z" ' + W + '/>' +
      '<path d="M47 31 C35 31 31 38 31 50 L31 62" stroke-width="5" ' + WS + '/>' +
      '<path d="M26.5 61 L35.5 61 L33.5 72 L28.5 72 Z" ' + W + '/>',
    // F02 «Пожарный кран»: свёрнутый рукав, ствол, вентиль
    F02: '<rect x="22" y="20" width="32" height="58" rx="10" stroke-width="5" ' + WS + '/>' +
      '<rect x="30" y="29" width="16" height="40" rx="5" stroke-width="5" ' + WS + '/>' +
      '<path d="M54 40 H66" stroke-width="5" ' + WS + '/>' +
      '<circle cx="74" cy="40" r="9" stroke-width="5" ' + WS + '/>' +
      '<path d="M74 31 V49 M65 40 H83" stroke-width="4" ' + WS + '/>' +
      '<path d="M26 77 L22 90 L30 90 Z" ' + W + '/>',
    // F05 «Телефон для использования при пожаре»: трубка и волны
    F05: '<path d="M30 25 C20 38 26 62 44 76 C58 87 70 86 76 78" stroke-width="13" ' + WS + '/>' +
      '<path d="M60 26 A16 16 0 0 1 74 40 M60 14 A28 28 0 0 1 86 40" stroke-width="5" ' + WS + '/>',
    // F06 «Место размещения нескольких средств противопожарной защиты»: полукруг
    F06: '<path d="M18 68 A32 32 0 0 1 82 68 Z" ' + W + '/>',
    // F10 «Кнопка включения установок (систем) пожарной автоматики»
    F10: '<rect x="18" y="18" width="64" height="64" rx="3" ' + W + '/>' +
      '<circle cx="50" cy="50" r="22" fill="' + COLORS.red + '"/>' +
      '<circle cx="50" cy="50" r="8" ' + W + '/>',
    // E01 «Выход здесь»: дверной проём и бегущий человек
    E01: '<path d="M62 14 H85 V87 H62" stroke-width="6" ' + WS + '/>' +
      '<circle cx="47" cy="22" r="8" ' + W + '/>' +
      '<path d="M44 35 L37 58 M42 39 L56 47 M41 38 L27 46 M37 58 L50 66 L48 84 M37 58 L26 69 L14 67" stroke-width="8.5" ' + WS + '/>'
  };

  // group: fire — знак пожарной безопасности (красный), evac — эвакуационный (зелёный).
  // ext — огнетушитель (входит в подсчёт и в проверку расстояния); badge — буква типа.
  const ITEMS = {
    op: { sign: 'F04', group: 'fire', ext: true, badge: 'П', dark: false, short: 'ОП', name: 'Огнетушитель порошковый' },
    ou: { sign: 'F04', group: 'fire', ext: true, badge: 'У', dark: true, short: 'ОУ', name: 'Огнетушитель углекислотный' },
    x: { sign: 'F04', group: 'fire', ext: true, badge: '?', dark: false, short: 'Другой', name: 'Огнетушитель другого типа' },
    pk: { sign: 'F02', group: 'fire', ext: false, short: 'ПК', name: 'Пожарный кран' },
    btn: { sign: 'F10', group: 'fire', ext: false, short: 'Кнопка', name: 'Кнопка ручного пуска пожарной сигнализации' },
    tel: { sign: 'F05', group: 'fire', ext: false, short: 'Телефон', name: 'Телефон для вызова пожарной охраны' },
    post: { sign: 'F06', group: 'fire', ext: false, short: 'Щит', name: 'Пожарный щит (несколько средств пожаротушения)' },
    exit: { sign: 'E01', group: 'evac', ext: false, short: 'Выход', name: 'Эвакуационный выход' }
  };
  // Порядок в инструментах и в условных обозначениях.
  const ORDER = ['op', 'ou', 'x', 'pk', 'btn', 'tel', 'post', 'exit'];
  // То, что инспектор отмечает на схеме (огнетушитель «другого типа» приходит только из старых ссылок).
  const MARKABLE = ['op', 'ou', 'pk', 'btn', 'tel', 'post', 'exit'];

  const SIGN_NAMES = {
    F02: 'F02 «Пожарный кран»', F04: 'F04 «Огнетушитель»', F05: 'F05 «Телефон для использования при пожаре»',
    F06: 'F06 «Место размещения нескольких средств противопожарной защиты»',
    F10: 'F10 «Кнопка включения установок (систем) пожарной автоматики»', E01: 'E01 «Выход здесь»'
  };

  function typeOf(t) { return ITEMS[t] ? t : 'x'; }
  function isExt(t) { return !ITEMS[t] || ITEMS[t].ext; }
  function item(t) { return ITEMS[typeOf(t)]; }
  function bg(t) { return item(t).group === 'evac' ? COLORS.green : COLORS.red; }

  function round(x) { return Math.round(x * 100) / 100; }

  // Знак целиком в поле 100 × 100: цветной квадрат с белой каймой и белым символом.
  function signBody(t) {
    const it = item(t);
    return '<rect x="2" y="2" width="96" height="96" rx="6" fill="' + bg(t) + '" stroke="#FFFFFF" stroke-width="4"/>' + SYMBOLS[it.sign];
  }

  // Знак с центром в (cx, cy) стороной size; у огнетушителя — кружок с буквой типа
  // в правом нижнем углу. font — шрифт буквы (в PDF — Tinos, в интерфейсе — шрифт страницы).
  function svgAt(t, cx, cy, size, font, noBadge) {
    const it = item(t), k = size / 100, x = cx - size / 2, y = cy - size / 2;
    let s = '<g transform="translate(' + round(x) + ' ' + round(y) + ') scale(' + round(k * 1000) / 1000 + ')">' + signBody(t) + '</g>';
    if (it.badge && !noBadge) s += badgeAt(t, cx + size * 0.42, cy + size * 0.42, size * 0.3, font);
    return s;
  }

  function badgeAt(t, cx, cy, r, font) {
    const it = item(t);
    const fill = it.dark ? COLORS.black : COLORS.white, ink = it.dark ? COLORS.white : COLORS.black;
    return '<circle cx="' + round(cx) + '" cy="' + round(cy) + '" r="' + round(r) + '" fill="' + fill + '" stroke="' + COLORS.black + '" stroke-width="' + round(r * 0.16) + '"/>' +
      '<text x="' + round(cx) + '" y="' + round(cy + r * 0.45) + '" text-anchor="middle" font-family="' + (font || 'sans-serif') + '" font-weight="bold" font-size="' + round(r * 1.3) + '" fill="' + ink + '">' + it.badge + '</text>';
  }

  // Отдельная картинка знака (для условных обозначений и кнопок): <svg> стороной size;
  // у огнетушителя поле чуть больше, чтобы поместился кружок с буквой. noBadge — без буквы.
  function icon(t, size, font, noBadge) {
    const pad = item(t).badge && !noBadge ? size * 0.26 : 0, full = size + pad;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + round(full) + '" height="' + round(full) + '" viewBox="0 0 ' + round(full) + ' ' + round(full) + '" focusable="false">' +
      svgAt(t, size / 2, size / 2, size, font, noBadge) + '</svg>';
  }

  // Набор символов для страницы: <symbol id="sg-тип"> для каждого вида знака.
  function sprite() {
    return '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">' +
      ORDER.map(function (t) { return '<symbol id="sg-' + t + '" viewBox="0 0 100 100">' + signBody(t) + '</symbol>'; }).join('') + '</svg>';
  }

  // Расшифровка: «Знак F04 «Огнетушитель» (ГОСТ 12.4.026-2015), П — порошковый».
  function legendText(t) {
    const it = item(t);
    return it.name + ': знак ' + SIGN_NAMES[it.sign] + (it.badge ? ', буква ' + it.badge : '');
  }

  return {
    COLORS: COLORS, ITEMS: ITEMS, ORDER: ORDER, MARKABLE: MARKABLE, SIGN_NAMES: SIGN_NAMES,
    typeOf: typeOf, isExt: isExt, item: item, color: bg,
    signBody: signBody, svgAt: svgAt, badgeAt: badgeAt, icon: icon, sprite: sprite, legendText: legendText
  };
}));
