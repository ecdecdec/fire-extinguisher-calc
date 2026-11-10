/*
 * Расчётный модуль: тип и количество огнетушителей по Приложению 3 к Правилам
 * пожарной безопасности РК (приказ МЧС РК № 55) и СТ РК 1487-2006.
 *
 * Чистые функции без доступа к DOM: один и тот же код работает в браузере и в
 * Node (тесты: node --test tests/).
 *
 * Порядок расчёта:
 *   1. Для каждого помещения определяется строка табл. 1 (по категории и
 *      классам пожара) и подбирается тип огнетушителя.
 *   2. Небольшие помещения одной категории с одинаковой нормой объединяются в
 *      расчётную группу (п. 7) — считается суммарная площадь.
 *   3. Количество = площадь × норма / предельная площадь, с округлением вверх.
 *   4. Поправки: АУПТ — 50 % (п. 10); расстояние до огнетушителя (п. 4);
 *      передвижные огнетушители для больших помещений (п. 2, табл. 2).
 *   5. По этажу: не менее двух огнетушителей в общественном здании (п. 5).
 *   6. Сверка с фактическим наличием, если оно указано.
 *
 * Все тексты шагов рассчитаны на вывод в PDF шрифтом Roboto, поэтому в них нет
 * стрелок, скобок «потолка» и других знаков, которых нет в этом шрифте.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./norms.js'));
  else root.FireEngine = factory(root.FireNorms);
}(typeof self !== 'undefined' ? self : this, function (N) {
  'use strict';

  const DEFAULT_OPTIONS = {
    rounding: 'proportional', // 'proportional': S × n / Sпред вверх; 'block': на каждую начатую Sпред — полный комплект n
    poolSmallRooms: true,     // п. 7 — суммировать площади небольших помещений
    onlyPowderAndCO2: true,   // рассматривать только ОП и ОУ (условие задачи)
    wheeled: true             // рассчитывать передвижные огнетушители (п. 2, табл. 2)
  };

  const CLASS_ORDER = ['A', 'B', 'C', 'D', 'E'];
  const PREF_PORTABLE = ['P5', 'P10', 'P2', 'C35', 'C2', 'W10', 'E6', 'E3'];
  const PREF_WHEELED = ['WP100', 'WC80', 'WC25', 'WF100', 'WE50', 'WE25'];
  const BRIEF_AGENTS = { powder: true, co2: true };

  // ---------- общие вспомогательные функции ----------

  function parseCell(s) {
    if (!s) return null;
    const m = /^(\d+)(\+\+|\+)$/.exec(String(s).replace(/\s+/g, ''));
    return m ? { n: parseInt(m[1], 10), mark: m[2] } : null;
  }

  function ceilSafe(x) { return Math.ceil(x - 1e-9); }

  function fmt(x) {
    const r = Math.round(Number(x) * 100) / 100;
    return String(r).replace('.', ',');
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = parseFloat(String(v).replace(',', '.').replace(/\s+/g, ''));
    return isFinite(n) && n > 0 ? n : 0;
  }

  function toCount(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(String(v).replace(',', '.')));
    return isFinite(n) && n >= 0 ? n : null;
  }

  function lexLess(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) < (b[i] || 0)) return true;
      if ((a[i] || 0) > (b[i] || 0)) return false;
    }
    return false;
  }

  function normClasses(list) {
    const set = {};
    (list || []).forEach(function (k) { if (CLASS_ORDER.indexOf(k) >= 0) set[k] = true; });
    return CLASS_ORDER.filter(function (k) { return set[k]; });
  }

  function categoryLabel(c) { return (N.CATEGORIES[c] || N.CATEGORIES.PUB).label; }

  function step(ref, text) { return { ref: ref, text: text }; }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function lineTitle(l) { return l.code + (l.charge ? ' (' + l.charge + ')' : ''); }

  // ---------- строки таблиц и предельные расстояния ----------

  // Строка табл. 1 для помещения. Для категорий В1–В4 строка зависит от того,
  // что горит: при классах B или C — «горючие газы и жидкости», иначе — «твёрдые».
  function rowKeyFor(category, classes) {
    const c = category || 'PUB';
    if (c === 'PUB') return 'G4';
    if (c === 'CA' || c === 'CB') return 'G1';
    if (/^CV[1-4]$/.test(c)) return (classes.indexOf('B') >= 0 || classes.indexOf('C') >= 0) ? 'G1' : 'G2';
    return 'G3';
  }

  // Строка табл. 2 (передвижные). Для категории Д и общественных помещений не применяется.
  function wheeledRowKeyFor(category, classes) {
    const c = category || 'PUB';
    if (c === 'CA' || c === 'CB') return 'G1';
    if (/^CV[1-4]$/.test(c)) return (classes.indexOf('B') >= 0 || classes.indexOf('C') >= 0) ? 'G1' : 'G2G';
    if (c === 'CG') return 'G2G';
    return null;
  }

  // Ячейки табл. 1 для класса пожара; если в строке помещения класса нет —
  // берётся самая строгая строка (FALLBACK_ROW) с пометкой.
  function classCells(rowKey, cls) {
    const row = N.TABLE1[rowKey];
    if (row.classes[cls]) return { rowKey: rowKey, area: row.area, cells: row.classes[cls], fallback: false };
    const fb = N.TABLE1[N.FALLBACK_ROW];
    if (fb.classes[cls]) return { rowKey: N.FALLBACK_ROW, area: fb.area, cells: fb.classes[cls], fallback: true };
    return null;
  }

  // Предельное расстояние до огнетушителя (п. 4).
  function distanceLimit(category, building) {
    const c = category || 'PUB';
    if (building.kind === 'public') return { m: N.DISTANCE.PUBLIC, why: 'общественное здание' };
    if (c === 'PUB') return { m: N.DISTANCE.PUBLIC, why: 'помещение общественного назначения' };
    if (c === 'CG') return { m: N.DISTANCE.G, why: 'категория Г' };
    if (c === 'CD') return { m: N.DISTANCE.D, why: 'категория Д' };
    return { m: N.DISTANCE.ABV, why: 'категории А, Б, В1–В4' };
  }

  // Минимальное число мест размещения в прямоугольном помещении L×W, при котором
  // расстояние по прямой от любой точки до ближайшего огнетушителя не больше R.
  //   points     — при наилучшей расстановке (сетка, огнетушители в центрах ячеек);
  //                меньшим числом мест требование п. 4 выполнить нельзя;
  //   wallPoints — если размещать только у стен (как обычно и делают);
  //                null — у стен требование не выполнить, нужны места в глубине.
  function placement(L, W, R) {
    function grid() {
      let best = Infinity;
      for (let kx = 1; kx <= 500; kx++) {
        const hx = L / (2 * kx);
        if (hx >= R) continue;
        const hy = Math.sqrt(R * R - hx * hx);
        const ky = Math.max(1, ceilSafe(W / (2 * hy)));
        best = Math.min(best, kx * ky);
        if (ky === 1) break;
      }
      return isFinite(best) ? best : 1;
    }
    // Огнетушители вдоль стен длиной len; глубина помещения depth.
    function alongWalls(len, depth) {
      let best = Infinity;
      if (depth < R) best = ceilSafe(len / (2 * Math.sqrt(R * R - depth * depth)));
      if (depth / 2 < R) best = Math.min(best, 2 * ceilSafe(len / (2 * Math.sqrt(R * R - depth * depth / 4))));
      return Math.max(1, best);
    }
    const wall = Math.min(alongWalls(L, W), alongWalls(W, L));
    return { points: grid(), wallPoints: isFinite(wall) ? wall : null };
  }

  // ---------- количество ----------

  function quantity(area, sMax, n, rounding) {
    if (!(area > 0)) return 0;
    if (rounding === 'block') return ceilSafe(area / sMax) * n;
    return Math.max(1, ceilSafe(area * n / sMax));
  }

  function basisText(area, sMax, n, rounding, result) {
    if (rounding === 'block') {
      const blocks = ceilSafe(area / sMax);
      const ratio = area / sMax;
      const head = fmt(area) + ' м² / ' + sMax + ' м² = ' + fmt(ratio);
      return head + (Math.abs(ratio - blocks) < 1e-9 ? '' : ', округление вверх — ' + blocks) +
        '; ' + blocks + ' × ' + n + ' шт. = ' + result + ' шт.';
    }
    const raw = area * n / sMax;
    const head = fmt(area) + ' м² × ' + n + ' шт. / ' + sMax + ' м² = ' + fmt(raw);
    return head + (Math.abs(raw - result) < 1e-9 ? ' шт.' : ', округление вверх — ' + result + ' шт.');
  }

  // Количество для выбранного типа: по самому требовательному из классов пожара.
  function pickCount(pick, area, rounding) {
    let best = null;
    pick.classes.forEach(function (k) {
      const p = pick.per[k];
      const count = quantity(area, p.area, p.n, rounding);
      if (!best || count > best.count) best = { count: count, cls: k, n: p.n, area: p.area };
    });
    best.basis = basisText(area, best.area, best.n, rounding, best.count);
    return best;
  }

  // ---------- подбор типа огнетушителя для помещения ----------

  function buildPlan(room, opts) {
    const classes = room.classes.length ? room.classes.slice() : ['A'];
    const rowKey = rowKeyFor(room.category, classes);
    const info = {}, fallback = [], missing = [];
    classes.forEach(function (k) {
      const c = classCells(rowKey, k);
      if (!c) { missing.push(k); return; }
      info[k] = c;
      if (c.fallback) fallback.push(k);
    });
    const allowed = N.T1_COLUMNS.filter(function (t) {
      return !opts.onlyPowderAndCO2 || BRIEF_AGENTS[N.PORTABLE_TYPES[t].agent];
    });
    function cell(t, k) { return info[k] ? parseCell(info[k].cells[N.T1_COLUMNS.indexOf(t)]) : null; }
    function evaluate(t, ks) {
      const per = {};
      let recommended = true;
      for (let i = 0; i < ks.length; i++) {
        const c = cell(t, ks[i]);
        if (!c) return null;
        per[ks[i]] = { n: c.n, mark: c.mark, area: info[ks[i]].area, rowKey: info[ks[i]].rowKey };
        if (c.mark !== '++') recommended = false;
      }
      return { typeId: t, classes: ks.slice(), per: per, recommended: recommended, viaP9: false, forced: false };
    }
    // Лучший тип для набора классов: покрывает больше классов (п. 2 —
    // универсальность); затем рекомендуемый «++» для всех классов; затем
    // рекомендуемый для определяющего класса (того, что требует больше всего
    // огнетушителей на единицу площади); затем распространённость.
    function best(ks, candidates) {
      let win = null;
      candidates.forEach(function (t) {
        const cov = ks.filter(function (k) { return cell(t, k); });
        if (!cov.length) return;
        const ev = evaluate(t, cov);
        let binding = cov[0];
        cov.forEach(function (k) {
          if (ev.per[k].n / ev.per[k].area > ev.per[binding].n / ev.per[binding].area) binding = k;
        });
        const p = PREF_PORTABLE.indexOf(t);
        const key = [-cov.length, ev.recommended ? 0 : 1, ev.per[binding].mark === '++' ? 0 : 1, p < 0 ? 99 : p];
        if (!win || lexLess(key, win.key)) win = { ev: ev, key: key };
      });
      return win ? win.ev : null;
    }

    const picks = [];
    let rest = classes.filter(function (k) { return info[k] && k !== 'D'; });
    function take(ev) {
      picks.push(ev);
      rest = rest.filter(function (k) { return ev.classes.indexOf(k) < 0; });
    }
    let forcedIgnored = false;
    if (room.forceType) {
      const ev = allowed.indexOf(room.forceType) >= 0 ? best(rest, [room.forceType]) : null;
      if (ev) { ev.forced = true; take(ev); } else forcedIgnored = true;
    }
    if (room.sensitive && rest.length) {
      const ev = best(rest, allowed.filter(function (t) { return N.PORTABLE_TYPES[t].agent === 'co2'; }));
      if (ev) { ev.viaP9 = true; take(ev); }
    }
    while (rest.length) {
      const ev = best(rest, allowed);
      if (!ev) break;
      take(ev);
    }
    const uncovered = rest.slice();
    // Класс D требует специального порошка — подбирается отдельным огнетушителем.
    if (info.D) {
      const ev = best(['D'], allowed);
      if (ev) picks.push(ev); else uncovered.push('D');
    }
    picks.forEach(function (p) {
      p.charge = N.PORTABLE_TYPES[p.typeId].agent === 'powder' ? (p.classes.indexOf('D') >= 0 ? 'D' : 'ABC(E)') : '';
    });
    return {
      rowKey: rowKey, classes: classes, info: info, picks: picks, uncovered: uncovered,
      missing: missing, fallback: fallback, forcedIgnored: forcedIgnored, allowed: allowed, evaluate: evaluate
    };
  }

  // Ключ объединения помещений (п. 7): одна категория, одинаковые тип и норма.
  function poolKey(room, plan) {
    return JSON.stringify([room.category, room.autoSuppression ? 1 : 0, plan.picks.map(function (p) {
      const pairs = {};
      p.classes.forEach(function (k) { pairs[p.per[k].n + '/' + p.per[k].area] = true; });
      return [p.typeId, p.charge, p.viaP9 ? 1 : 0, p.forced ? 1 : 0, Object.keys(pairs).sort()];
    })]);
  }

  // ---------- расчётная группа по таблице 1 ----------

  function rowStep(room, plan) {
    const row = N.TABLE1[plan.rowKey];
    const tail = 'строка «' + row.title + '» табл. 1, предельная защищаемая площадь ' + row.area + ' м².';
    const c = room.category;
    if (c === 'PUB') return 'Помещение общественного назначения: ' + tail;
    if (/^CV[1-4]$/.test(c)) {
      return 'Категория ' + categoryLabel(c) + (plan.rowKey === 'G1'
        ? ', возможны пожары классов B или C (горючие жидкости, газы): '
        : ', твёрдые горючие вещества и материалы: ') + tail;
    }
    return 'Категория ' + categoryLabel(c) + ': ' + tail;
  }

  function makeLine(kind, meta, pick, count, basis) {
    const m = meta[pick.typeId];
    const marks = {};
    pick.classes.forEach(function (k) { marks[k] = pick.per[k].mark; });
    return {
      kind: kind, typeId: pick.typeId, code: m.code, name: m.name, agent: m.agent, charge: pick.charge || '',
      classes: pick.classes.slice(), marks: marks, recommended: pick.recommended,
      viaP9: !!pick.viaP9, forced: !!pick.forced, count: count, basis: basis
    };
  }

  function normText(pick) {
    return pick.classes.map(function (k) {
      const p = pick.per[k];
      return 'класс ' + k + ' — ' + p.n + ' шт. на ' + p.area + ' м² («' + p.mark + '»)';
    }).join('; ');
  }

  // Строки табл. 1 для классов пожара помещения: что допускает таблица и что выбрано.
  // Показывается в интерфейсе рядом с расчётом — видно, из какой ячейки взята норма.
  function buildMatrix(plan) {
    const cols = plan.allowed;
    return {
      columns: cols.map(function (t) { return { id: t, code: N.PORTABLE_TYPES[t].code }; }),
      rows: plan.classes.filter(function (k) { return plan.info[k]; }).map(function (k) {
        const info = plan.info[k];
        return {
          cls: k, area: info.area, rowTitle: N.TABLE1[info.rowKey].title, fallback: info.fallback,
          cells: cols.map(function (t) {
            const c = parseCell(info.cells[N.T1_COLUMNS.indexOf(t)]);
            const chosen = plan.picks.some(function (p) { return p.typeId === t && p.classes.indexOf(k) >= 0; });
            return c ? { n: c.n, mark: c.mark, chosen: chosen } : { n: 0, mark: '-', chosen: false };
          })
        };
      })
    };
  }

  function computeUnit(group, building, opts) {
    // Пояснения строятся по помещению с самым полным набором классов пожара.
    const rep = group.planRoom || group.rooms[0];
    const plan = group.plan;
    const row = N.TABLE1[plan.rowKey];
    const area = group.area;
    const classSet = {};
    group.rooms.forEach(function (r) { (r.classes.length ? r.classes : ['A']).forEach(function (k) { classSet[k] = true; }); });
    const unit = {
      id: 'u_' + group.rooms[0].id,
      kind: 'table1',
      title: group.rooms.map(function (r) { return r.name; }).join(', '),
      rooms: group.rooms.map(function (r) { return { id: r.id, name: r.name, area: r.area }; }),
      pooled: group.rooms.length > 1,
      area: area,
      category: rep.category,
      categoryLabel: categoryLabel(rep.category),
      rowTitle: row.title,
      rowArea: row.area,
      norm: 'Табл. 1: ' + row.title,
      classes: CLASS_ORDER.filter(function (k) { return classSet[k]; }),
      fallback: plan.fallback.slice(),
      autoSuppression: !!rep.autoSuppression,
      matrix: buildMatrix(plan),
      lines: [], steps: [], warnings: [], notes: [], alternatives: [], placement: []
    };

    unit.steps.push(step('Прил. 3, п. 3; табл. 1', rowStep(rep, plan)));
    if (unit.pooled) {
      const parts = group.rooms.length <= 8
        ? group.rooms.map(function (r) { return fmt(r.area); }).join(' + ') + ' = ' + fmt(area) + ' м²'
        : fmt(area) + ' м² (' + group.rooms.length + ' помещений)';
      unit.steps.push(step('Прил. 3, п. 7', 'Небольшие помещения одной категории с одинаковой нормой считаются по суммарной площади: ' + parts + '.'));
    }
    if (group.rooms.some(function (r) { return !r.classes.length; })) {
      unit.warnings.push('Не выбраны классы пожара — принят класс A (твёрдые горючие вещества).');
    }
    if (plan.fallback.length) {
      const fb = N.TABLE1[N.FALLBACK_ROW];
      const msg = 'Класс пожара ' + plan.fallback.join(', ') + ' строкой «' + row.title + '» табл. 1 не предусмотрен — для него применена наиболее строгая строка «' +
        fb.title + '» (' + fb.area + ' м²). Это допущение: проверьте категорию помещения.';
      unit.steps.push(step('Прил. 3, табл. 1', msg));
      unit.warnings.push(msg);
    }
    if (plan.missing.length || plan.uncovered.length) {
      unit.warnings.push('Для класса пожара ' + plan.missing.concat(plan.uncovered).join(', ') + ' допустимый огнетушитель не найден' +
        (opts.onlyPowderAndCO2 ? ' среди ОП и ОУ' : '') + ' — требуется индивидуальное решение.');
    }
    if (plan.forcedIgnored) {
      const ft = N.PORTABLE_TYPES[rep.forceType];
      unit.warnings.push('Выбранный вручную тип ' + (ft ? ft.code : rep.forceType) + ' не допускается табл. 1 для этих классов пожара — тип подобран автоматически.');
    }

    plan.picks.forEach(function (p) {
      const c = pickCount(p, area, opts.rounding);
      const line = makeLine('portable', N.PORTABLE_TYPES, p, c.count, c.basis);
      unit.lines.push(line);
      let text = lineTitle(line) + ': ' + normText(p) + '.';
      if (p.classes.length > 1 && p.classes.some(function (k) { return p.per[k].n / p.per[k].area !== c.n / c.area; })) {
        text += ' Определяющий — класс ' + c.cls + '.';
      }
      text += ' Расчёт: ' + c.basis;
      if (p.forced) text += ' Тип выбран вручную.';
      unit.steps.push(step('Прил. 3, табл. 1', text));
      if (p.viaP9) {
        unit.steps.push(step('Прил. 3, п. 9', 'Помещение с дорогостоящим электронным оборудованием или ценностями: выбран углекислотный огнетушитель, чтобы не повредить их огнетушащим веществом.'));
      }
      if (!p.recommended && !p.viaP9) {
        unit.notes.push(lineTitle(line) + ': отметка «+» — применяется при отсутствии рекомендуемых и при обосновании (прим. 1 к табл. 1).');
      }
    });
    // п. 10 — автоматическая установка пожаротушения
    if (rep.autoSuppression && unit.lines.length) {
      unit.lines.forEach(function (l) {
        const before = l.count;
        l.count = Math.max(1, ceilSafe(before * 0.5));
        l.basis += ' АУПТ: ' + before + ' × 50 % = ' + fmt(before * 0.5) + (before % 2 ? ', округление вверх — ' + l.count : '') + ' шт.';
      });
      unit.steps.push(step('Прил. 3, п. 10', 'Помещение оборудовано автоматической установкой пожаротушения — 50 % от нормы: ' +
        unit.lines.map(function (l) { return lineTitle(l) + ' — ' + l.count + ' шт'; }).join('; ') + '.'));
    }

    // п. 4 — расстояние до огнетушителя (для помещений с указанными размерами)
    let needPoints = 0;
    group.rooms.forEach(function (r) {
      const L = toNumber(r.length), W = toNumber(r.width);
      if (!(L > 0 && W > 0)) return;
      const lim = distanceLimit(r.category, building);
      const pl = placement(L, W, lim.m);
      unit.placement.push({ room: r.name, length: L, width: W, limit: lim.m, why: lim.why, points: pl.points, wallPoints: pl.wallPoints });
      needPoints = Math.max(needPoints, pl.points);
      let text = '«' + r.name + '», ' + fmt(L) + ' × ' + fmt(W) + ' м: расстояние до огнетушителя не более ' + lim.m + ' м (' + lim.why +
        ') — не менее ' + pl.points + ' ' + plural(pl.points, 'места', 'мест', 'мест') + ' размещения';
      if (pl.wallPoints === null) text += '; у стен требование не выполнить — нужны места в глубине помещения (на колоннах)';
      else if (pl.wallPoints > pl.points) text += ' (при размещении только у стен — ' + pl.wallPoints + ')';
      unit.steps.push(step('Прил. 3, п. 4', text + '.'));
    });
    const totalPortable = unit.lines.reduce(function (s, l) { return s + l.count; }, 0);
    if (unit.lines.length && needPoints > totalPortable) {
      const l = unit.lines[0];
      l.count += needPoints - totalPortable;
      l.basis += ' По расстоянию (п. 4) — не менее ' + needPoints + ' мест размещения, принято ' + l.count + ' шт.';
      unit.steps.push(step('Прил. 3, п. 4', 'По площади получено ' + totalPortable + ' шт., а мест размещения нужно не менее ' + needPoints +
        ' — количество ' + lineTitle(l) + ' увеличено до ' + l.count + ' шт.'));
    }
    if (!unit.pooled && !unit.placement.length && unit.lines.length) {
      // Размеры не указаны: оценка по квадратному помещению той же площади.
      const lim = distanceLimit(rep.category, building);
      const side = Math.sqrt(area);
      const pl = placement(side, side, lim.m);
      if (pl.points > totalPortable) {
        unit.warnings.push('При такой площади одного места размещения мало: до огнетушителя должно быть не более ' + lim.m +
          ' м (п. 4). Укажите длину и ширину помещения — расчёт проверит расстояние.');
      }
    }

    // п. 2, табл. 2 — передвижные огнетушители для больших производственных и складских помещений
    const wKey = wheeledRowKeyFor(rep.category, plan.classes);
    if (opts.wheeled && wKey && !unit.pooled && area > N.TABLE2[wKey].area) {
      addWheeled(unit, rep, plan, wKey, opts);
    }

    // Допустимые замены одним типом (кроме класса D)
    const nonD = plan.classes.filter(function (k) { return plan.info[k] && k !== 'D'; });
    if (nonD.length) {
      plan.allowed.forEach(function (t) {
        const ev = plan.evaluate(t, nonD);
        if (!ev) return;
        const chosen = plan.picks.filter(function (p) { return p.classes.indexOf('D') < 0; });
        if (chosen.length === 1 && chosen[0].typeId === t) return;
        let count = pickCount(ev, area, opts.rounding).count;
        if (rep.autoSuppression) count = Math.max(1, ceilSafe(count * 0.5));
        count = Math.max(count, needPoints);
        const m = N.PORTABLE_TYPES[t];
        unit.alternatives.push({ typeId: t, code: m.code, name: m.name, count: count, recommended: ev.recommended,
          text: count + ' × ' + m.code + (ev.recommended ? ' («++»)' : ' («+», при обосновании)') });
      });
    }
    return unit;
  }

  function addWheeled(unit, room, plan, wKey, opts) {
    const row = N.TABLE2[wKey];
    const allowed = N.T2_COLUMNS.filter(function (t) { return !opts.onlyPowderAndCO2 || BRIEF_AGENTS[N.WHEELED_TYPES[t].agent]; });
    let rest = plan.classes.filter(function (k) { return row.classes[k]; });
    function cell(t, k) { return parseCell(row.classes[k][N.T2_COLUMNS.indexOf(t)]); }
    while (rest.length) {
      let win = null;
      allowed.forEach(function (t) {
        const cov = rest.filter(function (k) { return cell(t, k); });
        if (!cov.length) return;
        const per = {};
        let recommended = true;
        cov.forEach(function (k) { const c = cell(t, k); per[k] = { n: c.n, mark: c.mark, area: row.area, rowKey: wKey }; if (c.mark !== '++') recommended = false; });
        const p = PREF_WHEELED.indexOf(t);
        const key = [-cov.length, recommended ? 0 : 1, p < 0 ? 99 : p];
        if (!win || lexLess(key, win.key)) win = { key: key, pick: { typeId: t, classes: cov, per: per, recommended: recommended } };
      });
      if (!win) break;
      const pick = win.pick;
      pick.charge = N.WHEELED_TYPES[pick.typeId].agent === 'powder' ? (pick.classes.indexOf('D') >= 0 ? 'D' : 'ABC(E)') : '';
      const c = pickCount(pick, unit.area, opts.rounding);
      const line = makeLine('wheeled', N.WHEELED_TYPES, pick, c.count, c.basis);
      unit.lines.push(line);
      unit.steps.push(step('Прил. 3, п. 2; табл. 2', 'Площадь ' + fmt(unit.area) + ' м² больше предельной для строки «' + row.title + '» табл. 2 (' + row.area +
        ' м²) — дополнительно передвижные: ' + lineTitle(line) + ', ' + normText(pick) + '. Расчёт: ' + c.basis));
      rest = rest.filter(function (k) { return pick.classes.indexOf(k) < 0; });
    }
  }

  // ---------- объекты обслуживания по таблице 5 ----------

  function computeT5Unit(room) {
    const e = N.TABLE5[room.t5];
    const area = room.area;
    const unit = {
      id: 'u_' + room.id, kind: 'table5', title: room.name,
      rooms: [{ id: room.id, name: room.name, area: area }], pooled: false, area: area,
      category: null, categoryLabel: '—', rowTitle: e.title, rowArea: null,
      norm: 'Табл. 5: ' + e.title, classes: [],
      fallback: [], autoSuppression: !!room.autoSuppression, matrix: null,
      lines: [], steps: [], warnings: [], notes: [], alternatives: [], placement: []
    };
    let blocks = 1, basis;
    if (e.basis === 'per100' || e.basis === 'upTo100') {
      if (!(area > 0)) unit.warnings.push('Не указана площадь — принят один комплект.');
      blocks = Math.max(1, ceilSafe(area / 100));
      basis = (e.basis === 'upTo100' ? 'до 100 м² — один комплект, далее на каждые 100 м²' : 'комплект на каждые 100 м²') +
        ': ' + fmt(area) + ' / 100 = ' + fmt(area / 100) + (area % 100 === 0 && area > 0 ? '' : ', округление вверх — ' + blocks) + ' компл';
      if (room.t5 === 'parking_admin' && area > 100) {
        unit.warnings.push('Для помещения охраны норма задана только «до 100 м²» — для большей площади применён расчёт на каждые 100 м² (допущение).');
      }
    } else if (e.basis === 'perUnit') {
      blocks = Math.max(1, toCount(room.units) || 1);
      basis = 'на каждый гараж: ' + blocks + ' ' + plural(blocks, 'гараж', 'гаража', 'гаражей');
    } else {
      basis = 'фиксированный набор на объект';
    }
    unit.steps.push(step('Прил. 3, табл. 5', '«' + e.title + '» — ' + basis + '.'));

    e.items.forEach(function (it) {
      const idx = it.options.length > 1 && room.t5Alt ? 1 : 0;
      const o = it.options[idx];
      const kind = o.agent === 'shield' ? 'shield' : (o.wheeled ? 'wheeled' : 'portable');
      const count = o.n * blocks;
      const line = {
        kind: kind, typeId: o.code, code: o.code, name: '', agent: o.agent,
        charge: o.agent === 'powder' ? 'ABC(E)' : '',
        classes: [], marks: {}, recommended: true, viaP9: false, forced: false, count: count,
        basis: o.n + (kind === 'shield' ? ' компл.' : ' шт.') + ' × ' + blocks + ' = ' + count + (kind === 'shield' ? ' компл.' : ' шт.')
      };
      unit.lines.push(line);
      const other = it.options.filter(function (x, i) { return i !== idx; }).map(function (x) { return (x.n * blocks) + ' × ' + x.code; });
      unit.steps.push(step('Прил. 3, табл. 5', lineTitle(line) + ': ' + line.basis + (other.length ? ' Допустимая замена: ' + other.join(' или ') + '.' : '')));
      if (other.length) unit.alternatives.push({ t5Alt: idx ? 0 : 1, text: other.join(' или ') });
    });

    if (room.autoSuppression) {
      unit.lines.forEach(function (l) {
        if (l.kind !== 'portable') return;
        const before = l.count;
        l.count = Math.max(1, ceilSafe(before * 0.5));
        l.basis += ' АУПТ: ' + before + ' × 50 % — ' + l.count + ' шт.';
      });
      unit.steps.push(step('Прил. 3, п. 10', 'Помещение оборудовано автоматической установкой пожаротушения — ручные огнетушители в размере 50 % от нормы.'));
    }
    unit.notes.push('Порошковые огнетушители допускается заменять воздушно-эмульсионными (прим. 3 к табл. 5).');
    return unit;
  }

  function exemptUnit(room) {
    return {
      id: 'u_' + room.id, kind: 'exempt', title: room.name,
      rooms: [{ id: room.id, name: room.name, area: room.area }], pooled: false, area: room.area,
      category: 'CD', categoryLabel: 'Д', rowTitle: '', rowArea: null, norm: 'Прил. 3, п. 6',
      classes: room.classes.slice(), fallback: [], autoSuppression: false, matrix: null, lines: [],
      steps: [step('Прил. 3, п. 6', 'Помещение категории Д площадью ' + fmt(room.area) + ' м² (менее 100 м²) допускается не оснащать ручными огнетушителями.')],
      warnings: [], notes: [], alternatives: [], placement: []
    };
  }

  function floorMinUnit(floor, have, add) {
    return {
      id: 'u_min_' + floor.id, kind: 'floorMin', title: 'Минимум на этаж',
      rooms: [], pooled: false, area: 0, category: null, categoryLabel: '—', rowTitle: '', rowArea: null,
      norm: 'Прил. 3, п. 5', classes: ['A', 'E'], fallback: [], autoSuppression: false, matrix: null,
      lines: [{
        kind: 'portable', typeId: 'P5', code: N.PORTABLE_TYPES.P5.code, name: N.PORTABLE_TYPES.P5.name, agent: 'powder', charge: 'ABC(E)',
        classes: ['A', 'E'], marks: { A: '++', E: '++' }, recommended: true, viaP9: false, forced: false,
        count: add, basis: '2 − ' + have + ' = ' + add + ' шт.'
      }],
      steps: [step('Прил. 3, п. 5', 'По расчёту на этаже ' + have + ' ' + plural(have, 'ручной огнетушитель', 'ручных огнетушителя', 'ручных огнетушителей') +
        ', а в общественном здании на каждом этаже их должно быть не менее двух — добавлено ' + add + ' × ' + N.PORTABLE_TYPES.P5.code + ' (ABC(E)).')],
      warnings: [], notes: [], alternatives: [], placement: []
    };
  }

  // ---------- нормализация входных данных ----------

  function normalize(input) {
    const b = input || {};
    const src = b.building || b;
    const building = {
      name: src.name || '', address: src.address || '', owner: src.owner || '',
      inspector: src.inspector || '', date: src.date || '', kind: src.kind || 'public'
    };
    const allAuto = !!(src.autoSuppressionAll || b.autoSuppressionAll);
    const floors = (b.floors || []).map(function (f, fi) {
      return {
        id: f.id || ('f' + fi),
        name: f.name || ((fi + 1) + ' этаж'),
        installedOP: toCount(f.installedOP),
        installedOU: toCount(f.installedOU),
        rooms: (f.rooms || []).map(function (r, ri) {
          return {
            id: r.id || ('r' + fi + '_' + ri),
            name: (r.name || '').trim() || ('Помещение ' + (ri + 1)),
            purpose: r.purpose || '',
            category: r.t5 ? null : (N.CATEGORIES[r.category] ? r.category : 'PUB'),
            area: toNumber(r.area),
            classes: normClasses(r.classes),
            sensitive: !!(r.sensitive || r.electronics),
            autoSuppression: !!(r.autoSuppression || allAuto),
            length: toNumber(r.length), width: toNumber(r.width),
            forceType: N.PORTABLE_TYPES[r.forceType] ? r.forceType : '',
            t5: N.TABLE5[r.t5] ? r.t5 : '',
            t5Alt: r.t5Alt ? 1 : 0,
            units: r.units
          };
        })
      };
    });
    return { building: building, floors: floors };
  }

  // ---------- основной расчёт ----------

  function calculate(input, options) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const data = normalize(input);
    const building = data.building;
    const result = {
      building: building, options: opts, version: N.VERSION,
      floors: [], totals: [], warnings: [], assumptions: [], placement: [], check: null,
      summary: { rooms: 0, area: 0, floors: data.floors.length, portable: 0, wheeled: 0, shields: 0 }
    };
    let anyInstalled = false;

    data.floors.forEach(function (floor) {
      const fr = { id: floor.id, name: floor.name, units: [], warnings: [], portable: { powder: 0, co2: 0, other: 0 }, wheeled: 0, check: null };
      const position = {};
      const placed = [];   // { pos, unit }
      const groups = [];
      const byKey = {};

      floor.rooms.forEach(function (room, i) {
        position[room.id] = i;
        result.summary.rooms += 1;
        result.summary.area += room.area;
        if (room.t5) { placed.push({ pos: i, unit: computeT5Unit(room) }); return; }
        if (!(room.area > 0)) { fr.warnings.push('«' + room.name + '»: не указана площадь — помещение не рассчитано.'); return; }
        if (room.category === 'CD' && room.area < 100) { placed.push({ pos: i, unit: exemptUnit(room) }); return; }
        const plan = buildPlan(room, opts);
        const wKey = wheeledRowKeyFor(room.category, plan.classes);
        const small = room.area < N.TABLE1[plan.rowKey].area && !(opts.wheeled && wKey && room.area > N.TABLE2[wKey].area);
        if (opts.poolSmallRooms && small) {
          const key = poolKey(room, plan);
          const g = byKey[key];
          if (g) {
            g.rooms.push(room);
            g.area += room.area;
            if (plan.classes.length > g.plan.classes.length) { g.plan = plan; g.planRoom = room; }
            return;
          }
          byKey[key] = { rooms: [room], area: room.area, plan: plan, planRoom: room };
          groups.push(byKey[key]);
        } else {
          groups.push({ rooms: [room], area: room.area, plan: plan, planRoom: room });
        }
      });
      groups.forEach(function (g) { placed.push({ pos: position[g.rooms[0].id], unit: computeUnit(g, building, opts) }); });
      placed.sort(function (a, b) { return a.pos - b.pos; });
      fr.units = placed.map(function (x) { return x.unit; });

      function tally() {
        fr.portable = { powder: 0, co2: 0, other: 0 };
        fr.wheeled = 0;
        fr.units.forEach(function (u) {
          u.lines.forEach(function (l) {
            if (l.kind === 'wheeled') { fr.wheeled += l.count; return; }
            if (l.kind !== 'portable') return;
            if (l.agent === 'powder') fr.portable.powder += l.count;
            else if (l.agent === 'co2') fr.portable.co2 += l.count;
            else fr.portable.other += l.count;
          });
        });
        return fr.portable.powder + fr.portable.co2 + fr.portable.other;
      }

      // п. 5 — не менее двух ручных огнетушителей на этаже общественного здания.
      // Этаж, по которому ещё ничего не введено (нет ни одного помещения с данными), не дополняется.
      const have = tally();
      if (building.kind === 'public' && fr.units.length && have < 2) {
        fr.units.push(floorMinUnit(floor, have, 2 - have));
        tally();
      }

      // Сверка с фактическим наличием (если заполнено)
      if (floor.installedOP !== null || floor.installedOU !== null) {
        anyInstalled = true;
        const instOP = floor.installedOP || 0, instOU = floor.installedOU || 0;
        fr.check = {
          requiredOP: fr.portable.powder, installedOP: instOP, deficitOP: Math.max(0, fr.portable.powder - instOP),
          requiredOU: fr.portable.co2, installedOU: instOU, deficitOU: Math.max(0, fr.portable.co2 - instOU)
        };
        fr.check.ok = fr.check.deficitOP === 0 && fr.check.deficitOU === 0;
      }
      result.floors.push(fr);
    });

    // Итог по типам
    const totals = {};
    result.floors.forEach(function (fr) {
      fr.units.forEach(function (u) {
        u.lines.forEach(function (l) {
          const key = l.kind + '|' + l.code + '|' + l.charge;
          if (!totals[key]) totals[key] = { kind: l.kind, code: l.code, charge: l.charge, agent: l.agent, name: l.name || nameByCode(l.code), count: 0 };
          totals[key].count += l.count;
          if (l.kind === 'portable') result.summary.portable += l.count;
          else if (l.kind === 'wheeled') result.summary.wheeled += l.count;
          else result.summary.shields += l.count;
        });
      });
    });
    const kindOrder = { portable: 0, wheeled: 1, shield: 2 };
    result.totals = Object.keys(totals).map(function (k) { return totals[k]; })
      .filter(function (t) { return t.count > 0; })
      .sort(function (a, b) { return (kindOrder[a.kind] - kindOrder[b.kind]) || (b.count - a.count) || a.code.localeCompare(b.code); });

    if (anyInstalled) {
      const c = { requiredOP: 0, installedOP: 0, deficitOP: 0, requiredOU: 0, installedOU: 0, deficitOU: 0, floorsChecked: 0, floorsTotal: result.floors.length };
      result.floors.forEach(function (fr) {
        if (!fr.check) return;
        c.floorsChecked += 1;
        ['requiredOP', 'installedOP', 'deficitOP', 'requiredOU', 'installedOU', 'deficitOU'].forEach(function (k) { c[k] += fr.check[k]; });
      });
      c.ok = c.deficitOP === 0 && c.deficitOU === 0;
      c.text = c.ok
        ? 'Фактическое количество ручных огнетушителей на проверенных этажах не меньше расчётного.'
        : 'Не хватает: ' + [
          c.deficitOP ? c.deficitOP + ' ' + plural(c.deficitOP, 'порошкового', 'порошковых', 'порошковых') + ' (ОП)' : '',
          c.deficitOU ? c.deficitOU + ' ' + plural(c.deficitOU, 'углекислотного', 'углекислотных', 'углекислотных') + ' (ОУ)' : ''
        ].filter(Boolean).join(' и ') + '.';
      result.check = c;
    }

    result.floors.forEach(function (fr) {
      fr.warnings.forEach(function (w) { result.warnings.push(fr.name + ': ' + w); });
      fr.units.forEach(function (u) { u.warnings.forEach(function (w) { result.warnings.push(fr.name + ', «' + u.title + '»: ' + w); }); });
    });
    // В отчёт попадают только те допущения, которые повлияли на этот расчёт.
    const used = { table1: false, pooled: false, rowByClass: false, fallback: false, exempt: false, auto: false,
      dims: false, wheeled: false, t5: false, sensitive: false, pub: false };
    result.floors.forEach(function (fr) {
      fr.units.forEach(function (u) {
        if (u.kind === 'table1') {
          used.table1 = true;
          if (u.pooled) used.pooled = true;
          if (/^CV[1-4]$/.test(u.category)) used.rowByClass = true;
          if (u.category === 'PUB') used.pub = true;
          if (u.fallback.length) used.fallback = true;
          if (u.placement.length) used.dims = true;
          if (u.lines.some(function (l) { return l.kind === 'wheeled'; })) used.wheeled = true;
          if (u.lines.some(function (l) { return l.viaP9; })) used.sensitive = true;
        }
        if (u.kind === 'table5') used.t5 = true;
        if (u.kind === 'exempt') used.exempt = true;
        if (u.autoSuppression) used.auto = true;
      });
    });
    result.assumptions = assumptionList(opts, building, used);
    result.placement = placementRules(building, result);
    return result;
  }

  // Полный перечень правил и допущений расчёта — для раздела «Как считаем».
  function methodology(options, building) {
    return assumptionList(Object.assign({}, DEFAULT_OPTIONS, options || {}), building || { kind: 'public' }, null);
  }

  function nameByCode(code) {
    const all = Object.assign({}, N.PORTABLE_TYPES, N.WHEELED_TYPES);
    const id = Object.keys(all).filter(function (k) { return all[k].code === code; })[0];
    if (id) return all[id].name;
    if (code === 'ЩП-В') return 'щит пожарный для очагов класса B (комплект)';
    return '';
  }

  // used === null — полный перечень; иначе только то, что применялось в расчёте.
  function assumptionList(opts, building, used) {
    const a = [];
    function on(flag) { return !used || used[flag]; }
    if (on('table1')) {
      a.push(opts.rounding === 'block'
        ? 'Количество: на каждую начатую предельную площадь — полный комплект по табл. 1 (S / Sпред с округлением вверх, умножить на норму).'
        : 'Количество: S × норма / Sпред с округлением вверх, не менее 1 шт. на расчётную группу. Основание — п. 3: число определяется «в зависимости от предельной площади, защищаемой одним огнетушителем» (например, 4 шт. на 800 м² = 1 шт. на 200 м²).');
    }
    if (opts.poolSmallRooms && on('pooled')) {
      a.push('Пункт 7: «небольшим» считается помещение площадью меньше предельной по табл. 1; суммируются помещения одного этажа одной категории, для которых подобран один и тот же тип огнетушителя с одинаковой нормой.');
    }
    if (on('rowByClass')) {
      a.push('Для категорий В1–В4 строка табл. 1 выбирается по классам пожара: при классах B или C — «горючие газы и жидкости» (200 м²), иначе — «твёрдые горючие вещества и материалы» (400 м²).');
    }
    if (on('fallback')) {
      a.push('Если класс пожара не предусмотрен строкой табл. 1 (например, B и C для категории Г или для общественных зданий), для него применяется наиболее строгая строка «А, Б, В1–В4 (горючие газы и жидкости)»; результат помечается предупреждением.');
    }
    if (on('exempt')) {
      a.push('Пункт 6 применяется к каждому помещению категории Д отдельно, до суммирования площадей.');
    }
    if (on('auto')) {
      a.push('Пункт 10 (АУПТ): 50 % от нормы с округлением вверх, не менее 1 шт.; минимум два огнетушителя на этаж (п. 5) проверяется после этой поправки.');
    }
    if (on('dims')) {
      a.push('Пункт 4: расстояние проверяется по прямой для прямоугольного помещения с указанными длиной и шириной; минимальное число мест размещения — при наилучшей расстановке. Фактический путь обхода по плану может быть длиннее' +
        (building.kind === 'public' ? '; для всех помещений общественного здания принято 20 м.' : '.'));
    }
    if (opts.wheeled && on('wheeled')) {
      a.push('Передвижные огнетушители (п. 2, табл. 2) добавляются помещениям категорий А, Б, В1–В4 и Г, площадь которых больше предельной по табл. 2 (500 или 800 м²). Порог в Правилах прямо не назван — принят по табл. 2.');
    }
    if (on('pub')) {
      a.push('Помещения общественного назначения считаются по строке «Общественные здания» табл. 1. Встроенные объекты обслуживания из перечня табл. 5 (магазины, кафе, офисы и др.) считаются по табл. 5, только если для них выбрано такое назначение.');
    }
    if (on('t5')) {
      a.push('Для объектов обслуживания по табл. 5 заряд порошковых огнетушителей принят ABC(E): в таблице он не указан.');
    }
    if (on('sensitive')) {
      a.push('Для помещений с дорогостоящей электроникой, архивов и музеев выбирается углекислотный огнетушитель (п. 9).');
    }
    if (opts.onlyPowderAndCO2) {
      a.push('Рассматриваются только порошковые (ОП) и углекислотные (ОУ) огнетушители; пенные, водные и воздушно-эмульсионные не предлагаются.');
    }
    a.push('Обозначения огнетушителей — по вместимости корпуса, как в табл. 1 и 5: ОП-5 — 5 л (заряд 4 кг), ОП-10 — 10 л (9 кг); огнетушитель с большим зарядом допускается.');
    a.push('Не рассчитываются объекты со специальными нормами: предприятия нефтепродуктообеспечения (Прил. 10), строящиеся здания (Прил. 11), транспорт, а также пожарные щиты по табл. 3 и 4.');
    return a;
  }

  function placementRules(building, result) {
    const p = [];
    const cats = {};
    result.floors.forEach(function (fr) { fr.units.forEach(function (u) { if (u.lines.length && u.category) cats[u.category] = true; }); });
    if (building.kind === 'public') {
      p.push('Расстояние от возможного очага пожара до огнетушителя — не более 20 м (п. 4, общественные здания).');
    } else {
      if (cats.PUB) p.push('Помещения общественного назначения — не более 20 м до огнетушителя (п. 4).');
      if (cats.CA || cats.CB || cats.CV1 || cats.CV2 || cats.CV3 || cats.CV4) p.push('Помещения категорий А, Б, В1–В4 — не более 30 м до огнетушителя (п. 4).');
      if (cats.CG) p.push('Помещения категории Г — не более 40 м до огнетушителя (п. 4).');
      if (cats.CD) p.push('Помещения категории Д — не более 70 м до огнетушителя (п. 4).');
    }
    p.push('Огнетушители размещаются на видных местах и у эвакуационных выходов, не мешая эвакуации. Верх огнетушителя массой менее 15 кг — не выше 1,5 м от пола, массой 15 кг и более — не выше 1,0 м (п. 12).');
    p.push('Заряд порошковых огнетушителей: для класса A — порошок ABC(E); для классов B, C и E — BC(E) или ABC(E); для класса D — порошок D (прим. 2 к табл. 1).');
    p.push('Каждый огнетушитель обеспечивается паспортом (п. 11). Запорно-пусковые устройства пломбируются (п. 56 Правил).');
    p.push('Места размещения обозначаются знаками пожарной безопасности (п. 18 Правил).');
    p.push('Эксплуатация и техническое обслуживание — по СТ РК 1487-2006 (п. 9 Правил). Огнетушители, отправленные на перезарядку, заменяются заряженными (п. 8).');
    return p;
  }

  // Короткая строка итога латиницей — для QR-кода в отчёте.
  function summaryCode(result) {
    const map = { 'О': 'O', 'П': 'P', 'У': 'U', 'В': 'V', 'Э': 'E', 'Щ': 'SH' };
    return result.totals.map(function (t) {
      const code = t.code.split('').map(function (ch) { return map[ch] !== undefined ? map[ch] : ch; }).join('');
      return code + (t.charge === 'D' ? '(D)' : '') + 'x' + t.count;
    }).join(';');
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    calculate: calculate,
    methodology: methodology,
    placement: placement,
    rowKeyFor: rowKeyFor,
    quantity: quantity,
    summaryCode: summaryCode,
    lineTitle: lineTitle,
    plural: plural,
    fmt: fmt
  };
}));
