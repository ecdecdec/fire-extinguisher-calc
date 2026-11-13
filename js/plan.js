/*
 * Схема этажа: помещения как прямоугольники в масштабе, огнетушители как точки,
 * проверка расстояния до огнетушителя (Прил. 3, п. 4) и перечень нарушений.
 *
 * Чистые функции без доступа к DOM: один и тот же код работает в интерфейсе,
 * в PDF-отчёте и в тестах Node.
 *
 * Как это устроено:
 *   — схема строится сама по введённым помещениям. Если заданы длина и ширина,
 *     прямоугольник точный; если только площадь — условный (approx);
 *   — огнетушитель привязан к помещению: ключ «id помещения:номер копии» и
 *     положение внутри него в долях (u, v). Помещения можно двигать и менять —
 *     огнетушители остаются на своих местах в них;
 *   — расстояние считается по прямой, без учёта стен и дверей (то же допущение,
 *     что и в расчёте п. 4). Фактический путь обхода может быть длиннее;
 *   — отмеченное на схеме — это фактическое наличие. Расстановку «по нормам»
 *     (propose) программа строит отдельно и с фактом не смешивает;
 *   — если план этажа загружен картинкой (floor.blueprint), помещения, найденные
 *     на нём, стоят на своих местах настоящими контурами (poly, в метрах) и не
 *     двигаются; расстояния и расстановка считаются по этим контурам.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./norms.js'), require('./engine.js'));
  else root.FirePlan = factory(root.FireNorms, root.FireEngine);
}(typeof self !== 'undefined' ? self : this, function (N, E) {
  'use strict';

  const MAX_RECTS = 150;   // больше помещений на одном этаже на схеме не рисуется
  const MAX_CELLS = 3000;  // на столько клеток делится этаж при проверке расстояния
  const INSET = 0.4;       // м от стены до огнетушителя в расчётной расстановке
  const EPS = 1e-6;

  const num = E.toNumber;
  function round(x, d) { const k = Math.pow(10, d); return Math.round(x * k) / k; }
  function clamp01(x) { const n = Number(x); return isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5; }
  function fmt(x) { return E.fmt(x); }

  // ---------- помещения как прямоугольники ----------

  // Размер прямоугольника: по длине и ширине, иначе условный по площади.
  // Коридор без размеров рисуется полосой шириной 2 м.
  // Помещение без площади в расчёт не входит — нет его и на схеме.
  function sizeOf(room) {
    const L = num(room.length), W = num(room.width), S = num(room.area);
    if (!(S > 0)) return null;
    if (L > 0 && W > 0) return { w: Math.max(L, W), h: Math.min(L, W), approx: false };
    if (room.purpose === 'corridor' && S >= 8) return { w: S / 2, h: 2, approx: true };
    const w = Math.sqrt(S * 1.5);
    return { w: w, h: S / w, approx: true };
  }

  // Загруженный план этажа: { img, w, h, scale (точек на метр), rooms: [{ id, poly, bbox, lx, ly }] } в точках картинки.
  function blueprintOf(floor) {
    const bp = floor && floor.blueprint;
    return bp && bp.scale > 0 && Array.isArray(bp.rooms) ? bp : null;
  }

  // Каждая копия помещения (строка с количеством) — отдельный прямоугольник.
  // Помещение с загруженного плана — его настоящий контур на своём месте.
  function instances(floor, building, floorIndex) {
    const list = [];
    let skipped = 0;
    const bp = blueprintOf(floor), shapes = {};
    if (bp) bp.rooms.forEach(function (g) { shapes[g.id] = g; });
    ((floor && floor.rooms) || []).forEach(function (r, ri) {
      const size = sizeOf(r);
      if (!size) return;
      const t5 = N.TABLE5[r.t5] ? r.t5 : '';
      const category = t5 ? 'PUB' : (N.CATEGORIES[r.category] ? r.category : 'PUB');
      const id = r.id || ('r' + (floorIndex || 0) + '_' + ri);
      const name = (r.name || '').trim() || (r.fallbackName || '').trim() || ('Помещение ' + (ri + 1));
      const copies = E.countOf(r);
      const shape = bp && r.bp !== undefined && r.bp !== null ? shapes[r.bp] : null;
      for (let i = 0; i < copies; i++) {
        if (list.length >= MAX_RECTS) { skipped += 1; continue; }
        const item = {
          key: id + ':' + i, roomId: id, idx: i, copies: copies, name: name,
          w: size.w, h: size.h, approx: size.approx,
          corridor: r.purpose === 'corridor',
          sensitive: !t5 && !!(r.sensitive || r.electronics),
          limit: E.distanceLimit(category, building || { kind: 'public' }).m,
          // помещение категории Д менее 100 м² допускается не оснащать (п. 6) — расстояние не проверяется
          check: !(!t5 && category === 'CD' && num(r.area) < 100)
        };
        if (shape && i === 0) {
          const s = bp.scale;
          item.poly = shape.poly.map(function (p) { return [p[0] / s, p[1] / s]; });
          item.x = shape.bbox[0] / s;
          item.y = shape.bbox[1] / s;
          item.w = (shape.bbox[2] - shape.bbox[0]) / s;
          item.h = (shape.bbox[3] - shape.bbox[1]) / s;
          item.lx = shape.lx / s;
          item.ly = shape.ly / s;
          item.fixed = true;
          item.approx = false;
        }
        list.push(item);
      }
    });
    return { list: list, skipped: skipped };
  }

  // Точка внутри многоугольника (чётность пересечений).
  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function contains(r, x, y) {
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return false;
    return r.poly ? inPoly(r.poly, x, y) : true;
  }

  function bbox(rects) {
    if (!rects.length) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    rects.forEach(function (r) {
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
  }

  // Расположение по умолчанию. Если на этаже есть коридор, помещения встают по
  // обе стороны от него; иначе — рядами.
  function autoLayout(list, rowsOnly) {
    const out = {};
    if (!list.length) return out;
    let spine = null;
    if (!rowsOnly) list.forEach(function (r) { if (r.corridor && (!spine || r.w > spine.w)) spine = r; });
    if (spine && list.length > 1) {
      out[spine.key] = [0, 0];
      let top = 0, bottom = 0;
      list.forEach(function (r) {
        if (r === spine) return;
        if (top <= bottom) { out[r.key] = [top, -r.h]; top += r.w; }
        else { out[r.key] = [bottom, spine.h]; bottom += r.w; }
      });
      return out;
    }
    let total = 0, maxW = 0;
    list.forEach(function (r) { total += r.w * r.h; maxW = Math.max(maxW, r.w); });
    const target = Math.max(maxW, Math.sqrt(total * 1.8));
    let x = 0, y = 0, rowH = 0;
    list.forEach(function (r) {
      if (x > 0 && x + r.w > target + EPS) { x = 0; y += rowH; rowH = 0; }
      out[r.key] = [x, y];
      x += r.w;
      rowH = Math.max(rowH, r.h);
    });
    return out;
  }

  // pos — расположение, заданное пользователем ({ ключ: [x, y] }), или null.
  // Помещения, добавленные после того как схему начали двигать, встают рядом ниже.
  // Помещения с загруженного плана (fixed) стоят на своих местах; добавленные
  // вручную встают под планом.
  function layout(list, pos) {
    const anyFixed = list.some(function (r) { return r.fixed; });
    const auto = pos || anyFixed ? null : autoLayout(list);
    const placed = {}, loose = [];
    list.forEach(function (r) {
      const p = r.fixed ? [r.x, r.y] : (pos ? pos[r.key] : (auto ? auto[r.key] : null));
      if (p && isFinite(p[0]) && isFinite(p[1])) placed[r.key] = [Number(p[0]), Number(p[1])]; else loose.push(r);
    });
    if (loose.length) {
      const b = bbox(list.filter(function (r) { return placed[r.key]; }).map(function (r) {
        return { x: placed[r.key][0], y: placed[r.key][1], w: r.w, h: r.h };
      }));
      const gap = b.w > 0 ? 1 : 0;
      const sub = autoLayout(loose, true);
      loose.forEach(function (r) { placed[r.key] = [b.x0 + sub[r.key][0], b.y1 + gap + sub[r.key][1]]; });
    }
    return list.map(function (r) { return Object.assign({}, r, { x: placed[r.key][0], y: placed[r.key][1] }); });
  }

  function freeze(rects) {
    const pos = {};
    rects.forEach(function (r) { pos[r.key] = [round(r.x, 2), round(r.y, 2)]; });
    return pos;
  }

  // Верхнее помещение под точкой.
  function at(rects, x, y) {
    for (let i = rects.length - 1; i >= 0; i--) if (contains(rects[i], x, y)) return rects[i];
    return null;
  }

  // Куда встанет помещение после перетаскивания: прилипает к стенам соседей,
  // иначе — к сетке 0,5 м.
  function snap(rects, key, x, y) {
    const me = rects.filter(function (r) { return r.key === key; })[0];
    if (!me) return [x, y];
    const T = 0.75;
    let nx = Math.round(x * 2) / 2, ny = Math.round(y * 2) / 2, bx = T, by = T;
    rects.forEach(function (o) {
      if (o.key === key) return;
      if (y < o.y + o.h + T && y + me.h > o.y - T) {
        [o.x + o.w, o.x - me.w, o.x, o.x + o.w - me.w].forEach(function (c) { const d = Math.abs(x - c); if (d < bx) { bx = d; nx = c; } });
      }
      if (x < o.x + o.w + T && x + me.w > o.x - T) {
        [o.y + o.h, o.y - me.h, o.y, o.y + o.h - me.h].forEach(function (c) { const d = Math.abs(y - c); if (d < by) { by = d; ny = c; } });
      }
    });
    return [round(nx, 2), round(ny, 2)];
  }

  // ---------- огнетушители на схеме ----------

  function typeOf(t) { return t === 'ou' ? 'ou' : (t === 'op' ? 'op' : 'x'); }

  // Метки → точки с координатами. Метки удалённых помещений пропускаются.
  function resolve(rects, ext) {
    const by = {};
    rects.forEach(function (r) { by[r.key] = r; });
    const out = [];
    (Array.isArray(ext) ? ext : []).forEach(function (e, i) {
      const r = e && by[e.k];
      if (!r) return;
      const u = clamp01(e.u), v = clamp01(e.v);
      out.push({
        id: e.id || ('e' + i), k: e.k, u: u, v: v, t: typeOf(e.t), code: e.code || '', extra: !!e.extra,
        x: r.x + u * r.w, y: r.y + v * r.h, rect: r
      });
    });
    return out;
  }

  // ---------- проверка расстояния ----------

  // Клетки помещений; у контура с плана — только клетки, центр которых внутри него.
  function cellsOf(rects) {
    let area = 0;
    rects.forEach(function (r) { if (r.check) area += r.w * r.h; });
    const s = Math.max(1, Math.sqrt(area / MAX_CELLS));
    const cells = [];
    rects.forEach(function (r) {
      if (!r.check) return;
      const nx = Math.max(1, Math.round(r.w / s)), ny = Math.max(1, Math.round(r.h / s));
      const cw = r.w / nx, ch = r.h / ny;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x0 = r.x + i * cw, y0 = r.y + j * ch;
          if (r.poly && !inPoly(r.poly, x0 + cw / 2, y0 + ch / 2)) continue;
          cells.push({ r: r, i: i, j: j, x0: x0, y0: y0, x1: x0 + cw, y1: y0 + ch, lim2: r.limit * r.limit, done: false });
        }
      }
    });
    return cells;
  }

  // Квадрат расстояния от точки до самого дальнего угла клетки: клетка в норме,
  // если вся лежит в пределах расстояния от одного огнетушителя.
  function reach2(px, py, c) {
    const dx = Math.max(Math.abs(px - c.x0), Math.abs(px - c.x1));
    const dy = Math.max(Math.abs(py - c.y0), Math.abs(py - c.y1));
    return dx * dx + dy * dy;
  }

  // per[ключ помещения] = { area, bad, far, runs } — runs: полосы вне нормы для рисования.
  function coverage(rects, pts) {
    const cells = cellsOf(rects);
    const per = {};
    let total = 0, bad = 0, last = null;
    cells.forEach(function (c) {
      const a = (c.x1 - c.x0) * (c.y1 - c.y0);
      let best = Infinity;
      for (let k = 0; k < pts.length; k++) {
        const d = reach2(pts[k].x, pts[k].y, c);
        if (d < best) best = d;
      }
      const p = per[c.r.key] || (per[c.r.key] = { area: 0, bad: 0, far: 0, runs: [] });
      p.area += a;
      total += a;
      if (best <= c.lim2 + EPS) { last = null; return; }
      p.bad += a;
      bad += a;
      p.far = Math.max(p.far, Math.sqrt(best));
      if (last && last.r === c.r && last.j === c.j && last.i === c.i - 1) last.run.w += c.x1 - c.x0;
      else p.runs.push((last = { r: c.r, j: c.j, i: c.i, run: { x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0 } }).run);
      if (last) last.i = c.i;
    });
    return { total: total, bad: bad, share: total > 0 ? bad / total : 0, per: per };
  }

  // ---------- расстановка по нормам ----------

  // Места вдоль стен контура с плана: на каждой стене через шаг gap, отступ внутрь INSET.
  function polyCandidates(r, perWall, gap, out) {
    const P = r.poly;
    for (let k = 0; k < P.length; k++) {
      const a = P[k], b = P[(k + 1) % P.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.6) continue;
      const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len, cnt = Math.min(perWall, Math.max(1, Math.round(len / gap)));
      for (let t = 0; t < cnt; t++) {
        const f = (t + 0.5) / cnt, px = a[0] + (b[0] - a[0]) * f, py = a[1] + (b[1] - a[1]) * f;
        if (inPoly(P, px + nx * INSET, py + ny * INSET)) out.push({ rect: r, x: px + nx * INSET, y: py + ny * INSET });
        else if (inPoly(P, px - nx * INSET, py - ny * INSET)) out.push({ rect: r, x: px - nx * INSET, y: py - ny * INSET });
      }
    }
    if (Math.min(r.w, r.h) > r.limit) {
      const gx = Math.ceil(r.w / (1.4 * r.limit)), gy = Math.ceil(r.h / (1.4 * r.limit));
      for (let i = 0; i < gx; i++) for (let j = 0; j < gy; j++) {
        const x = r.x + r.w * (i + 0.5) / gx, y = r.y + r.h * (j + 0.5) / gy;
        if (inPoly(P, x, y)) out.push({ rect: r, x: x, y: y });
      }
    }
  }

  // Возможные места: вдоль стен, а в помещениях глубже предельного расстояния — ещё и в глубине (на колоннах).
  function candidates(rects, perWall) {
    const out = [];
    rects.forEach(function (r) {
      const ix = Math.min(INSET, r.w / 2), iy = Math.min(INSET, r.h / 2);
      const gap = Math.max(1.5, r.limit / 8); // шаг мест вдоль стены
      if (r.poly) { polyCandidates(r, perWall, gap, out); return; }
      const nx = Math.min(perWall, Math.max(1, Math.round(r.w / gap))), ny = Math.min(perWall, Math.max(1, Math.round(r.h / gap)));
      for (let i = 0; i < nx; i++) {
        const x = r.x + r.w * (i + 0.5) / nx;
        out.push({ rect: r, x: x, y: r.y + iy }, { rect: r, x: x, y: r.y + r.h - iy });
      }
      for (let j = 0; j < ny; j++) {
        const y = r.y + r.h * (j + 0.5) / ny;
        out.push({ rect: r, x: r.x + ix, y: y }, { rect: r, x: r.x + r.w - ix, y: y });
      }
      if (Math.min(r.w, r.h) > r.limit) {
        const gx = Math.ceil(r.w / (1.4 * r.limit)), gy = Math.ceil(r.h / (1.4 * r.limit));
        for (let i = 0; i < gx; i++) for (let j = 0; j < gy; j++) out.push({ rect: r, x: r.x + r.w * (i + 0.5) / gx, y: r.y + r.h * (j + 0.5) / gy });
      }
    });
    return out;
  }

  // Следующее место. Берётся первая ещё не закрытая клетка и среди мест, которые
  // до неё достают, — то, что закрывает больше всего клеток (так помещение
  // проходится от края к краю без лишних огнетушителей). Когда всё закрыто —
  // место, самое дальнее от уже занятых.
  function pickBest(cands, cells, placed) {
    let pool = cands, open = false;
    for (let k = 0; k < cells.length; k++) {
      const anchor = cells[k];
      if (anchor.done) continue;
      open = true;
      const reachIt = cands.filter(function (c) { return reach2(c.x, c.y, anchor) <= anchor.lim2 + EPS; });
      if (reachIt.length) { pool = reachIt; break; }
    }
    // при равенстве: дальше от уже занятых мест, затем ближе к середине стены.
    // Место в коридоре ценится выше: огнетушители ставят на путях эвакуации (п. 12).
    let best = null, bestGain = -1, bestFar = -1, bestMid = Infinity;
    pool.forEach(function (c) {
      let gain = 0;
      if (open) {
        for (let k = 0; k < cells.length; k++) {
          if (!cells[k].done && reach2(c.x, c.y, cells[k]) <= cells[k].lim2 + EPS) gain += 1;
        }
        if (c.rect.corridor) gain *= 1.25;
      }
      let far = Infinity;
      for (let k = 0; k < placed.length; k++) {
        const dx = placed[k].x - c.x, dy = placed[k].y - c.y;
        far = Math.min(far, dx * dx + dy * dy);
      }
      const mx = c.x - (c.rect.x + c.rect.w / 2), my = c.y - (c.rect.y + c.rect.h / 2);
      const mid = mx * mx + my * my;
      if (gain > bestGain || (gain === bestGain && (far > bestFar || (far === bestFar && mid < bestMid)))) {
        best = c; bestGain = gain; bestFar = far; bestMid = mid;
      }
    });
    return best ? { c: best, gain: bestGain } : null;
  }

  // Расстановка по результату расчёта этажа: столько и таких огнетушителей,
  // сколько требует норма, в своих помещениях; затем, если по расстоянию остались
  // непокрытые места, — дополнительные (extra).
  function propose(rects, floorResult) {
    if (!rects.length) return [];
    const cells = cellsOf(rects);
    const perWall = rects.length > 60 ? 2 : 40;
    const placed = [];
    function put(c, t, code, extra) {
      placed.push({ x: c.x, y: c.y, rect: c.rect, t: t, code: code, extra: extra });
      cells.forEach(function (cell) { if (!cell.done && reach2(c.x, c.y, cell) <= cell.lim2 + EPS) cell.done = true; });
    }
    ((floorResult && floorResult.units) || []).forEach(function (u) {
      const ids = {};
      u.rooms.forEach(function (r) { ids[r.id] = true; });
      u.lines.forEach(function (l) {
        if (l.kind !== 'portable') return;
        const t = l.agent === 'powder' ? 'op' : (l.agent === 'co2' ? 'ou' : 'x');
        let pool;
        if (u.kind === 'floorMin') {
          // общий огнетушитель этажа: в коридоре, если он есть; порошковый — не в помещении с электроникой
          pool = rects.filter(function (r) { return t !== 'op' || !r.sensitive; });
          const corridors = pool.filter(function (r) { return r.corridor; });
          if (corridors.length) pool = corridors;
        } else {
          pool = rects.filter(function (r) { return ids[r.roomId]; });
        }
        if (!pool.length) return;
        const cands = candidates(pool, perWall);
        const own = cells.filter(function (c) { return pool.indexOf(c.r) >= 0; });
        for (let i = 0; i < Math.min(l.count, 80); i++) {
          // разносятся друг от друга огнетушители своих помещений, чужие не учитываются
          const b = pickBest(cands, own, placed.filter(function (p) { return pool.indexOf(p.rect) >= 0; }));
          if (!b) break;
          put(b.c, t, l.code, false);
        }
      });
    });
    const all = candidates(rects.filter(function (r) { return r.check; }), perWall);
    for (let extra = 0; extra < 40 && cells.some(function (c) { return !c.done; }); extra++) {
      const b = pickBest(all, cells, placed);
      if (!b || b.gain <= 0) break;
      put(b.c, b.c.rect.sensitive ? 'ou' : 'op', '', true);
    }
    return placed.map(function (p) {
      return { k: p.rect.key, u: round((p.x - p.rect.x) / p.rect.w, 3), v: round((p.y - p.rect.y) / p.rect.h, 3), t: p.t, code: p.code, extra: p.extra };
    });
  }

  // ---------- сцена этажа и перечень нарушений ----------

  function limitsText(rects) {
    const set = {};
    rects.forEach(function (r) { if (r.check) set[r.limit] = true; });
    const list = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    return list.length ? list.join(', ') + ' м' : '';
  }

  // Поле зрения схемы с отступом. Очень вытянутая схема (длинный коридор)
  // дополняется полями, чтобы на экране не превращаться в узкую полоску.
  function view(box) {
    const pad = Math.max(1, Math.max(box.w, box.h) * 0.04);
    const v = { x: box.x0 - pad, y: box.y0 - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
    if (v.w > 4 * v.h) { const h = v.w / 4; v.y -= (h - v.h) / 2; v.h = h; }
    if (v.h > 1.4 * v.w) { const w = v.h / 1.4; v.x -= (w - v.w) / 2; v.w = w; }
    return v;
  }

  // Схемы для отчёта: этажи, где схему открывали или что-то отметили.
  // fact — как есть (если отмечено), want — расстановка по расчёту.
  function schemes(input, result, au) {
    const out = [];
    au.floors.forEach(function (fa, i) {
      const plan = input.floors[i] && input.floors[i].plan;
      if (!fa.rects.length || !(fa.marked || (plan && plan.open))) return;
      out.push({ name: fa.name, fact: fa.marked ? fa : null, want: scene(fa.rects, propose(fa.rects, result.floors[i])) });
    });
    return out;
  }

  function scene(rects, ext) {
    const pts = resolve(rects, ext);
    return { rects: rects, ext: pts, cover: coverage(rects, pts), box: bbox(rects), limits: limitsText(rects) };
  }

  // Полосы «дальше нормы» для рисования. Пока на схеме ничего не отмечено,
  // факт неизвестен — красным ничего не закрашивается.
  function gaps(sc) {
    const out = [];
    if (!sc.ext.length) return out;
    Object.keys(sc.cover.per).forEach(function (key) { sc.cover.per[key].runs.forEach(function (r) { out.push(r); }); });
    return out;
  }

  // Сколько чего на схеме: «ОП — 3, ОУ — 1».
  function tally(sc) {
    let op = 0, ou = 0, other = 0;
    sc.ext.forEach(function (e) { if (e.t === 'op') op += 1; else if (e.t === 'ou') ou += 1; else other += 1; });
    return { op: op, ou: ou, other: other };
  }

  // Проверка объекта: по каждому этажу — схема с отмеченными огнетушителями и
  // нарушения. level: 'bad' — нарушение, 'warn' — проверить на месте.
  function audit(input, result) {
    const out = { floors: [], findings: [], checked: 0, total: 0, status: 'none' };
    const building = result.building;
    ((input && input.floors) || []).forEach(function (floor, fi) {
      const fr = result.floors[fi];
      if (!fr) return;
      const inst = instances(floor, building, fi);
      const rects = layout(inst.list, floor.plan && floor.plan.pos);
      const fa = scene(rects, floor.plan && floor.plan.ext);
      fa.id = fr.id;
      fa.name = fr.name;
      fa.skipped = inst.skipped;
      fa.marked = fa.ext.length > 0;
      fa.findings = [];
      // f: level — 'bad' (нарушение) или 'warn' (проверить на месте); kind — 'deficit', 'powder', 'distance';
      // text — что выявлено; action — что сделать; room — помещение, если нарушение в нём.
      function add(level, text, ref, extra) {
        const f = Object.assign({ level: level, floorId: fr.id, floor: fr.name, text: text, ref: ref, kind: '', action: '', room: '' }, extra || {});
        fa.findings.push(f);
        out.findings.push(f);
      }
      // типы огнетушителей одного вида, которые расчёт требует на этаже: «(ОП-5)»
      function codesOf(agent) {
        const set = {};
        fr.units.forEach(function (u) { u.lines.forEach(function (l) { if (l.kind === 'portable' && l.agent === agent) set[l.code] = true; }); });
        const list = Object.keys(set);
        return list.length ? ' (' + list.join(' или ') + ')' : '';
      }
      if (fr.units.length) out.total += 1;

      // количество — по сверке расчёта с фактом
      if (fr.check) {
        out.checked += 1;
        const c = fr.check;
        // минимум на этаж: в общественном здании — п. 5; в остальных он применён по параметру расчёта
        const min = fr.units.filter(function (u) { return u.kind === 'floorMin'; })[0];
        const ref = !min ? 'Прил. 3, п. 3' : (min.byRules ? 'Прил. 3, п. 3 и п. 5' : 'Прил. 3, п. 3; минимум на этаж — параметр расчёта');
        if (c.deficitOP > 0) {
          add('bad', 'Порошковых огнетушителей (ОП) ' + c.installedOP + ' из ' + c.requiredOP + ' требуемых — не хватает ' + c.deficitOP + '.', ref, {
            kind: 'deficit', action: 'Добавить ' + c.deficitOP + ' ' + E.plural(c.deficitOP, 'порошковый огнетушитель', 'порошковых огнетушителя', 'порошковых огнетушителей') + codesOf('powder')
          });
        }
        if (c.deficitOU > 0) {
          add('bad', 'Углекислотных огнетушителей (ОУ) ' + c.installedOU + ' из ' + c.requiredOU + ' требуемых — не хватает ' + c.deficitOU + '.', ref, {
            kind: 'deficit', action: 'Добавить ' + c.deficitOU + ' ' + E.plural(c.deficitOU, 'углекислотный огнетушитель', 'углекислотных огнетушителя', 'углекислотных огнетушителей') + codesOf('co2')
          });
        }
      }

      // порошковый в помещении с электроникой
      const seen = {};
      fa.ext.forEach(function (e) {
        if (e.t !== 'op' || !e.rect.sensitive || seen[e.rect.roomId]) return;
        const unit = fr.units.filter(function (u) { return u.rooms.some(function (r) { return r.id === e.rect.roomId; }); })[0];
        // если по табл. 1 для этого помещения порошковый нужен (углекислотный не закрывает класс пожара) — не нарушение
        if (unit && unit.lines.some(function (l) { return l.agent === 'powder'; })) return;
        seen[e.rect.roomId] = true;
        add('bad', '«' + e.rect.name + '»: стоит порошковый огнетушитель. В помещении с электронным оборудованием порошковые не применяются — заменить на углекислотный (ОУ).',
          'Прил. 3, п. 9; СТ РК 1487-2006', { kind: 'powder', room: e.rect.name, action: 'Убрать порошковый огнетушитель, поставить углекислотный (ОУ)' });
      });

      // расстояние до огнетушителя — только если на схеме что-то отмечено
      if (fa.marked) {
        const byRoom = {}, order = [];
        rects.forEach(function (r) {
          const p = fa.cover.per[r.key];
          if (!p || !(p.bad > 0)) return;
          let g = byRoom[r.roomId];
          if (!g) { g = byRoom[r.roomId] = { name: r.name, limit: r.limit, approx: r.approx, copies: r.copies, area: 0, bad: 0, far: 0, n: 0 }; order.push(r.roomId); }
          g.area += p.area; g.bad += p.bad; g.far = Math.max(g.far, p.far); g.n += 1;
        });
        order.forEach(function (id) {
          const g = byRoom[id];
          const pct = Math.max(1, Math.round(100 * g.bad / g.area));
          add(g.approx ? 'warn' : 'bad',
            '«' + g.name + '»' + (g.copies > 1 ? ' (' + g.n + ' из ' + g.copies + ')' : '') + ': до ближайшего огнетушителя до ' + fmt(Math.ceil(g.far * 10) / 10) +
            ' м при норме не более ' + g.limit + ' м — вне нормы ' + pct + ' % площади.' +
            (g.approx ? ' Размеры помещения не заданы — проверьте на месте.' : ''),
            'Прил. 3, п. 4', {
              kind: 'distance', room: g.name,
              action: g.approx
                ? 'Проверить на месте расстояние до огнетушителя: не более ' + g.limit + ' м'
                : 'Добавить огнетушитель или перенести ближе: сейчас до ' + fmt(Math.ceil(g.far * 10) / 10) + ' м при норме ' + g.limit + ' м'
            });
        });
      }
      out.floors.push(fa);
    });
    if (out.findings.some(function (f) { return f.level === 'bad'; })) out.status = 'bad';
    else if (out.checked > 0) out.status = 'ok';
    return out;
  }

  // ---------- рисунок схемы для PDF ----------

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // sc — сцена этажа (scene); width, maxHeight — в пунктах. Возвращает { svg, width, height }.
  function svg(sc, width, maxHeight) {
    const v = view(sc.box);
    let W = width, k = W / v.w;
    if (v.h * k > maxHeight) { k = maxHeight / v.h; W = v.w * k; }
    const H = v.h * k;
    function X(x) { return round((x - v.x) * k, 2); }
    function Y(y) { return round((y - v.y) * k, 2); }
    function S(d) { return round(d * k, 2); }
    const p = [];
    p.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + round(W, 2) + '" height="' + round(H, 2) + '" viewBox="0 0 ' + round(W, 2) + ' ' + round(H, 2) + '">');
    p.push('<defs><clipPath id="frame"><rect x="0" y="0" width="' + round(W, 2) + '" height="' + round(H, 2) + '"/></clipPath></defs>');
    sc.rects.forEach(function (r) {
      const fill = '" fill="' + (r.sensitive ? '#f1f1f1' : '#ffffff') + '" stroke="#171717" stroke-width="0.7"' + (r.approx ? ' stroke-dasharray="3 2"' : '') + '/>';
      if (r.poly) p.push('<polygon points="' + r.poly.map(function (q) { return X(q[0]) + ',' + Y(q[1]); }).join(' ') + fill);
      else p.push('<rect x="' + X(r.x) + '" y="' + Y(r.y) + '" width="' + S(r.w) + '" height="' + S(r.h) + fill);
    });
    gaps(sc).forEach(function (u) {
      p.push('<rect x="' + X(u.x) + '" y="' + Y(u.y) + '" width="' + S(u.w) + '" height="' + S(u.h) + '" fill="#c4291c" fill-opacity="0.3"/>');
    });
    p.push('<g clip-path="url(#frame)">');
    const ring = sc.ext.length > 8 ? '#c9c9c9' : '#8a8a8a'; // когда огнетушителей много, круги бледнее
    sc.ext.forEach(function (e) {
      p.push('<circle cx="' + X(e.x) + '" cy="' + Y(e.y) + '" r="' + S(e.rect.limit) + '" fill="none" stroke="' + ring + '" stroke-width="0.5" stroke-dasharray="2 2"/>');
    });
    p.push('</g>');
    const fs = 6.5;
    sc.rects.forEach(function (r) {
      const max = Math.floor((S(r.w) - 5) / (fs * 0.56));
      if (S(r.h) < fs * 1.6 || max < 3) return;
      const label = r.name.length <= max ? r.name : r.name.slice(0, max - 1) + '.';
      // у контура с плана подпись — в самой просторной точке помещения, иначе — в левом верхнем углу
      if (r.poly) p.push('<text x="' + X(r.lx) + '" y="' + round(Y(r.ly) + fs * 0.35, 2) + '" text-anchor="middle" font-family="Roboto" font-size="' + fs + '" fill="#525252">' + esc(label) + '</text>');
      else p.push('<text x="' + round(X(r.x) + 2.5, 2) + '" y="' + round(Y(r.y) + fs + 1.5, 2) + '" font-family="Roboto" font-size="' + fs + '" fill="#525252">' + esc(label) + '</text>');
    });
    sc.ext.forEach(function (e) {
      const fill = e.t === 'op' ? '#c4291c' : (e.t === 'ou' ? '#171717' : '#737373');
      p.push('<circle cx="' + X(e.x) + '" cy="' + Y(e.y) + '" r="4.6" fill="' + fill + '" stroke="#ffffff" stroke-width="0.8"/>');
      p.push('<text x="' + X(e.x) + '" y="' + round(Y(e.y) + 2.1, 2) + '" text-anchor="middle" font-family="Roboto" font-size="5.6" fill="#ffffff">' +
        (e.t === 'op' ? 'П' : (e.t === 'ou' ? 'У' : '?')) + '</text>');
    });
    p.push('</svg>');
    return { svg: p.join(''), width: round(W, 2), height: round(H, 2) };
  }

  return {
    MAX_RECTS: MAX_RECTS,
    instances: instances, layout: layout, autoLayout: autoLayout, freeze: freeze, bbox: bbox, view: view,
    blueprintOf: blueprintOf, inPoly: inPoly,
    at: at, snap: snap, resolve: resolve, coverage: coverage, propose: propose, scene: scene, gaps: gaps, tally: tally,
    audit: audit, schemes: schemes, svg: svg
  };
}));
