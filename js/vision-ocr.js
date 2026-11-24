/*
 * Чтение надписей на плане этажа: площади («15,6», «22 qm», «14,2 м²», «120 sq ft») и названия
 * помещений. Работает на устройстве (tesseract.js из vendor/tesseract, без сети), в браузере,
 * в фоновом потоке и в Node. Читаются только небольшие области внутри найденных помещений,
 * весь лист не распознаётся.
 *
 * API (глобальное имя FireVisionOcr, в Node module.exports):
 *
 *   findTextBoxes(rgba, w, h, rooms, opts) -> [{ roomId, box: [x0, y0, x1, y1], h, glyphs }]
 *     Кандидаты в строки текста: мелкие тёмные пятна внутри многоугольника помещения,
 *     собранные в строки по близости и общей высоте. box в точках картинки с полями,
 *     h - высота знака, roomId - номер помещения (room.id). Не требует tesseract.
 *     rooms: результат FireVision.findRooms (нужны id и poly).
 *     opts: mask (готовая маска FireVision._inkMask), maxHeightShare (доля большей стороны
 *     картинки, по умолчанию 0,05), minHeight (по умолчанию 4 точки), maxPerRoom (6).
 *
 *   readLabels(rgba, w, h, rooms, opts) -> Promise<[{ roomId, texts, area, unit, name, purpose }]>
 *     texts: [{ text, conf, box }] - что прочитано в каждой строке;
 *     area: площадь в м2 или null, unit: 'm2' или 'ft2' (в каком виде напечатано);
 *     name: название (слово), purpose: код назначения из FirePresets.guessPurpose или null.
 *     opts:
 *       Tesseract  - объект tesseract.js (по умолчанию глобальный Tesseract; в браузере
 *                    грузится loadTesseract, в Node его даёт tests/ocr-node-env.js);
 *       base       - адрес папки vendor/tesseract/ (по умолчанию рядом со страницей);
 *       paths      - { workerPath, corePath, langPath } вместо base;
 *       langs      - 'rus' (по умолчанию), можно 'rus+kaz' (kaz.traineddata.gz - ещё 2,1 МБ);
 *       boxes      - готовый результат findTextBoxes;
 *       guessPurpose - функция названия в код назначения (по умолчанию FirePresets.guessPurpose);
 *       timeoutMs  - предел на всё чтение, по умолчанию 60000.
 *     Рабочий поток tesseract создаётся один раз и хранится; dispose() его закрывает.
 *
 *   scaleFromLabels(rooms, labels) -> { scale, inliers, total, share, spread } или null
 *     Масштаб в точках на метр: медиана sqrt(px / area) по помещениям с прочитанной площадью,
 *     выбросы отбрасываются. inliers - сколько помещений согласны, share - их доля, spread -
 *     относительный разброс согласных (0,02 = 2 %). null, если согласны меньше трёх.
 *
 *   parseArea(text) -> { area, unit, value, hasUnit } или null  (разбор одной строки)
 *   dispose() -> Promise  (закрыть рабочий поток)
 *
 * Помещения берутся из FireVision.findRooms; здесь используются его _inkMask и _components.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vision.js'));
  else root.FireVisionOcr = factory(root.FireVision);
}(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  const FT2_TO_M2 = 0.09290304;
  const MIN_AREA = 0.8, MAX_AREA = 3000;

  // ---------- 1. строки текста внутри помещений ----------

  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function polyBox(poly) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    poly.forEach(function (p) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    });
    return [x0, y0, x1, y1];
  }

  function findTextBoxes(rgba, w, h, rooms, opts) {
    const o = opts || {};
    const mask = o.mask || V._inkMask(rgba, w, h);
    const parts = V._components(mask, w, h, true);
    const minH = o.minHeight || 4;
    const maxH0 = Math.max(minH + 2, (o.maxHeightShare || 0.05) * Math.max(w, h));
    const perRoom = o.maxPerRoom || 6;
    const out = [];
    // мелкие связные области: возможные знаки
    const glyphs = [];
    for (let k = 1; k <= parts.count; k++) {
      const f = parts.info[k], gw = f.x1 - f.x0 + 1, gh = f.y1 - f.y0 + 1;
      if (f.n < 3 || gh > maxH0 || gw > maxH0 * 1.6) continue;
      if (gh > 6 * gw + 2 && gh > minH * 2) continue;
      glyphs.push({ x0: f.x0, y0: f.y0, x1: f.x1 + 1, y1: f.y1 + 1, cx: (f.x0 + f.x1 + 1) / 2, cy: (f.y0 + f.y1 + 1) / 2 });
    }
    rooms.forEach(function (room) {
      if (!room.poly || room.poly.length < 3) return;
      const bb = polyBox(room.poly);
      const roomShort = Math.min(bb[2] - bb[0], bb[3] - bb[1]);
      const maxH = Math.min(maxH0, roomShort * 0.3);
      const mine = glyphs.filter(function (g) {
        return g.cx >= bb[0] && g.cx <= bb[2] && g.cy >= bb[1] && g.cy <= bb[3] &&
          g.y1 - g.y0 <= maxH && inPoly(room.poly, g.cx, g.cy);
      }).sort(function (a, b) { return a.x0 - b.x0; });
      // сборка строк: знак присоединяется к строке, с которой совпадает по высоте и стоит рядом
      const lines = [];
      mine.forEach(function (g) {
        const gh = g.y1 - g.y0;
        let best = null, bestGap = 1e9;
        lines.forEach(function (L) {
          const lh = L.y1 - L.y0, gap = g.x0 - L.x1;
          if (gap > 1.1 * Math.max(lh, gh) || gap < -0.5 * lh) return;
          const ov = Math.min(g.y1, L.y1) - Math.max(g.y0, L.y0);
          const small = gh < 0.55 * lh;
          // запятая, точка и «й» стоят у границ строки
          const ok = small ? (g.cy > L.y0 - 0.25 * lh && g.cy < L.y1 + 0.35 * lh) : ov >= 0.5 * Math.min(gh, lh);
          if (ok && gap < bestGap) { best = L; bestGap = gap; }
        });
        if (best) {
          best.x1 = Math.max(best.x1, g.x1);
          best.y0 = Math.min(best.y0, g.y0); best.y1 = Math.max(best.y1, g.y1);
          best.n += 1;
          if (gh >= 0.55 * (best.y1 - best.y0)) best.big += 1;
        } else lines.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, n: 1, big: 1 });
      });
      const good = lines.filter(function (L) { return L.n >= 2 && L.big >= 2 && L.y1 - L.y0 >= minH; });
      good.sort(function (a, b) { return a.y0 - b.y0; });
      good.slice(0, perRoom).forEach(function (L) {
        const lh = L.y1 - L.y0, p = Math.max(2, Math.round(0.4 * lh));
        out.push({
          roomId: room.id,
          box: [Math.max(0, L.x0 - p), Math.max(0, L.y0 - p), Math.min(w, L.x1 + p), Math.min(h, L.y1 + p)],
          h: lh, glyphs: L.n
        });
      });
    });
    return out;
  }

  // ---------- 2. разбор строки ----------

  const UNIT_RE = '(м\\s*[2²]|м\\s*\\^\\s*2|кв\\.?\\s*м|m\\s*[2²]|sq\\.?\\s*m|sqm|qm|а[тгм]|[дгц]м|q\\.?\\s*m|sq\\.?\\s*ft|sqft|ft\\s*[2²]|кв\\.?\\s*ф)';

  // Буквы, которые распознаватель путает с цифрами внутри числа.
  function fixDigits(s) {
    return s.replace(/[OОоo]/g, '0').replace(/[зЗ]/g, '3').replace(/[lI|!]/g, '1').replace(/[Бб]/g, '6').replace(/[Ss]/g, '5');
  }

  function toNumber(tok) {
    const t = tok.replace(',', '.');
    const v = parseFloat(t);
    return isFinite(v) ? v : NaN;
  }

  // Строка с площадью: число с десятичной частью или с единицей измерения.
  function parseArea(text) {
    if (!text) return null;
    const s = String(text).replace(/\s+/g, ' ').replace(/[‚،]/g, ',').trim();
    // число с единицей
    const withUnit = new RegExp('([0-9OОlI|]{1,4}(?:\\s?[.,]\\s?[0-9OОlI|]{1,2})?)\\s*' + UNIT_RE, 'i').exec(s);
    let tok = null, unit = 'm2', hasUnit = false;
    if (withUnit) {
      tok = withUnit[1]; hasUnit = true;
      if (/ft|ф/i.test(withUnit[2])) unit = 'ft2';
    } else {
      const m = /(^|[^0-9])([0-9]{1,4})\s?[.,]\s?([0-9]{1,2})(?![0-9])/.exec(s);
      if (m) tok = m[2] + ',' + m[3];
    }
    if (!tok) return null;
    const value = toNumber(fixDigits(tok.replace(/\s/g, '')));
    if (!isFinite(value)) return null;
    const area = unit === 'ft2' ? value * FT2_TO_M2 : value;
    if (area < MIN_AREA || area > MAX_AREA) return null;
    return { area: Math.round(area * 100) / 100, unit: unit, value: value, hasUnit: hasUnit };
  }

  // Название: слово из букв (не меньше трёх), без цифр и знаков.
  function cleanName(text) {
    const s = String(text || '').replace(/[\n\r]+/g, ' ').replace(/[^A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі\s.\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const letters = s.replace(/[^A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/g, '');
    if (letters.length < 3) return '';
    return s.replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  }

  // ---------- 3. рабочий поток tesseract ----------

  const state = { key: '', promise: null, worker: null, core: '' };

  function simdOk() {
    try {
      return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array(
        [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) { return false; }
  }

  function absUrl(p) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || /^[A-Za-z]:[\\/]/.test(p) || p.charAt(0) === '/' && typeof location === 'undefined') return p;
    try {
      if (typeof location !== 'undefined' && location.href) return new URL(p, location.href).href;
    } catch (e) { /* остаётся как есть */ }
    return p;
  }

  // Адрес чужого источника (http, https или без протокола) не допускается: иначе tesseract.js
  // взял бы файлы из сети. Свой источник: тот же адрес, что у страницы, или из opts.allowOrigins.
  function checkLocal(p, o, what) {
    const s = String(p);
    const m = /^(https?:)?[/][/]([^/?#]+)/i.exec(s);
    if (!m) return s;
    const origin = (m[1] ? m[1].toLowerCase() : (typeof location !== 'undefined' && location.protocol ? location.protocol : 'https:')) + '//' + m[2].toLowerCase();
    const allow = (o.allowOrigins || []).map(function (x) { return String(x).toLowerCase().replace(/[/]$/, ''); });
    if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') allow.push(location.origin.toLowerCase());
    if (allow.indexOf(origin) < 0) throw new Error('Путь ' + what + ' ведёт на другой адрес (' + origin + '): файлы распознавания берутся только из vendor/tesseract.');
    return s;
  }

  function pathsFor(o) {
    let base = o.base || 'vendor/tesseract/';
    if (!/[/\\]$/.test(base)) base += '/';
    checkLocal(base, o, 'base');
    base = absUrl(base);
    const given = o.paths || {};
    const def = {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core/' + (simdOk() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'),
      langPath: base + 'lang'
    };
    const out = {};
    ['workerPath', 'corePath', 'langPath'].forEach(function (k) {
      out[k] = given[k] ? checkLocal(given[k], o, k) : def[k];
    });
    return out;
  }

  function getTesseract(o) {
    const T = o.Tesseract || (typeof Tesseract !== 'undefined' ? Tesseract : null);
    if (!T || !T.createWorker) throw new Error('tesseract.js не загружен: передайте opts.Tesseract или подключите vendor/tesseract/tesseract.min.js');
    return T;
  }

  function getWorker(o) {
    const langs = o.langs || 'rus', p = pathsFor(o);
    const key = langs + '|' + p.workerPath + '|' + p.corePath;
    if (state.promise && state.key === key) return state.promise;
    const T = getTesseract(o);
    state.key = key;
    state.core = String(p.corePath).split(/[/\\]/).pop();
    state.promise = T.createWorker(langs, 1, {
      workerPath: p.workerPath, workerBlobURL: false, corePath: p.corePath, langPath: p.langPath,
      gzip: true, cacheMethod: 'none', logger: function () {}
    }).then(function (wk) {
      state.worker = wk;
      return wk.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1', user_defined_dpi: '300' }).then(function () { return wk; });
    }).catch(function (e) { state.promise = null; state.key = ''; throw e; });
    return state.promise;
  }

  function dispose() {
    const pr = state.promise;
    state.promise = null; state.key = ''; state.worker = null;
    if (!pr) return Promise.resolve();
    return pr.then(function (wk) { return wk.terminate(); }, function () {});
  }

  // Область картинки в серый PGM: увеличение до крупных знаков, растяжение контраста, белые поля.
  function cropPgm(rgba, w, h, box, glyphH, target, thr) {
    const bx0 = Math.floor(box[0]), by0 = Math.floor(box[1]);
    const bw = Math.max(1, Math.ceil(box[2]) - bx0), bh = Math.max(1, Math.ceil(box[3]) - by0);
    const f = Math.max(0.5, Math.min(6, (target || 28) / Math.max(4, glyphH)));
    const tw = Math.max(8, Math.round(bw * f)), th = Math.max(8, Math.round(bh * f)), pad = 14;
    const W = tw + 2 * pad, H = th + 2 * pad;
    const lum = new Float32Array(bw * bh);
    let lo = 255, hi = 0;
    for (let y = 0; y < bh; y++) {
      const sy = Math.min(h - 1, by0 + y);
      for (let x = 0; x < bw; x++) {
        const o = (sy * w + Math.min(w - 1, bx0 + x)) * 4;
        const l = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
        lum[y * bw + x] = l;
        if (l < lo) lo = l;
        if (l > hi) hi = l;
      }
    }
    const span = Math.max(30, hi - lo);
    const hdr = 'P5\n' + W + ' ' + H + '\n255\n';
    const bytes = new Uint8Array(hdr.length + W * H);
    for (let i = 0; i < hdr.length; i++) bytes[i] = hdr.charCodeAt(i);
    bytes.fill(255, hdr.length);
    for (let y = 0; y < th; y++) {
      const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < tw; x++) {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const a = lum[y0 * bw + x0] * (1 - tx) + lum[y0 * bw + x1] * tx;
        const b = lum[y1 * bw + x0] * (1 - tx) + lum[y1 * bw + x1] * tx;
        let v = ((a * (1 - ty) + b * ty) - lo) / span * 255;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        if (thr) v = v < thr ? 0 : 255; // жирнее тонкие штрихи
        bytes[hdr.length + (y + pad) * W + x + pad] = v | 0;
      }
    }
    return bytes;
  }

  function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { reject(new Error('Время вышло: ' + what)); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // Набор вариантов подготовки картинки: (высота знака в точках, порог жирности).
  const VARIANTS = [[28, 0], [24, 200], [36, 190], [28, 190], [36, 200], [24, 190], [20, 190], [28, 200], [36, 0], [24, 0], [20, 0], [20, 200]];

  // Одна строка читается в нескольких видах; побеждает площадь, за которую набралось больше уверенности.
  // Три первых вида дали одну и ту же площадь с высокой уверенностью: хватит.
  function agree(c) {
    const a = c.map(function (x) { return parseArea(x.text); });
    return a[0] && a[1] && a[2] && a[0].area === a[1].area && a[1].area === a[2].area && c[0].conf >= 85 && c[1].conf >= 85 && c[2].conf >= 85;
  }

  function readBox(wk, rgba, w, h, b) {
    const cands = [];
    let stopped = false;
    let chain = Promise.resolve();
    VARIANTS.forEach(function (v, k) {
      chain = chain.then(function () {
        if (k === 3 && agree(cands)) stopped = true;
        if (stopped) return null;
        return wk.recognize(cropPgm(rgba, w, h, b.box, b.h, v[0], v[1])).then(function (res) {
          const d = res.data || {};
          cands.push({ text: String(d.text || '').trim(), conf: Math.round(d.confidence || 0) });
        });
      });
    });
    return chain.then(function () {
      const votes = {};
      cands.forEach(function (c) {
        const a = parseArea(c.text);
        if (!a) return;
        const k = a.area + a.unit;
        if (!votes[k]) votes[k] = { sum: 0, best: c };
        votes[k].sum += 100 + c.conf;
        if (c.conf > votes[k].best.conf) votes[k].best = c;
      });
      let win = null;
      Object.keys(votes).forEach(function (k) { if (!win || votes[k].sum > win.sum) win = votes[k]; });
      let pick = win ? win.best : null;
      if (!pick) cands.forEach(function (c) { if (c.text && (!pick || c.conf > pick.conf)) pick = c; });
      return pick ? { text: pick.text, conf: pick.conf, box: b.box.slice() } : null;
    });
  }

  function readLabels(rgba, w, h, rooms, opts) {
    const o = opts || {};
    const boxes = o.boxes || findTextBoxes(rgba, w, h, rooms, o);
    const guess = o.guessPurpose || (typeof FirePresets !== 'undefined' && FirePresets.guessPurpose) || null;
    const byRoom = {};
    rooms.forEach(function (r) { byRoom[r.id] = { roomId: r.id, texts: [], area: null, unit: null, name: '', purpose: null }; });
    const job = getWorker(o).then(function (wk) {
      let chain = Promise.resolve();
      boxes.forEach(function (b) {
        chain = chain.then(function () {
          return readBox(wk, rgba, w, h, b).then(function (t) {
            if (t && byRoom[b.roomId]) byRoom[b.roomId].texts.push(t);
          });
        });
      });
      return chain;
    }).then(function () {
      return rooms.map(function (r) {
        const lab = byRoom[r.id];
        let bestArea = null, bestScore = -1, bestName = null, bestNameConf = -1;
        lab.texts.forEach(function (t) {
          const a = parseArea(t.text);
          if (a) {
            const score = t.conf + (a.hasUnit ? 30 : 0);
            if (score > bestScore) { bestScore = score; bestArea = a; }
          }
          const nm = cleanName(t.text);
          if (nm && !a && t.conf > bestNameConf) { bestNameConf = t.conf; bestName = nm; }
        });
        if (bestArea) { lab.area = bestArea.area; lab.unit = bestArea.unit; }
        if (bestName) {
          lab.name = bestName;
          lab.purpose = guess ? guess(bestName) : null;
        }
        return lab;
      });
    });
    return withTimeout(job, o.timeoutMs || 60000, 'чтение надписей');
  }

  // ---------- 4. масштаб ----------

  function polyArea(poly) {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    return Math.abs(s) / 2;
  }

  function median(a) {
    const s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
  }

  function scaleFromLabels(rooms, labels, opts) {
    const tol = (opts && opts.tol) || 0.06;
    const px = {};
    rooms.forEach(function (r) { px[r.id] = r.px > 0 ? r.px : (r.poly ? polyArea(r.poly) : 0); });
    const s = [];
    labels.forEach(function (l) {
      if (l.area > 0 && px[l.roomId] > 0) s.push(Math.sqrt(px[l.roomId] / l.area));
    });
    if (s.length < 3) return null;
    // каждое значение проверяется как кандидат: берём то, с которым согласно больше всего помещений
    let bestIn = [], bestSpread = 1e9;
    s.forEach(function (c) {
      const inl = s.filter(function (v) { return Math.abs(v / c - 1) <= tol; });
      const m = median(inl);
      const dev = median(inl.map(function (v) { return Math.abs(v - m); })) / m;
      if (inl.length > bestIn.length || (inl.length === bestIn.length && dev < bestSpread)) { bestIn = inl; bestSpread = dev; }
    });
    if (bestIn.length < 3) return null;
    const scale = median(bestIn);
    const mn = Math.min.apply(null, bestIn), mx = Math.max.apply(null, bestIn);
    return {
      scale: scale, inliers: bestIn.length, total: s.length,
      share: Math.round(bestIn.length / s.length * 1000) / 1000, spread: Math.round((mx - mn) / scale * 1000) / 1000
    };
  }

  return {
    findTextBoxes: findTextBoxes, readLabels: readLabels, scaleFromLabels: scaleFromLabels,
    parseArea: parseArea, dispose: dispose, info: function () { return { core: state.core, simd: simdOk() }; },
    // для тестов
    _cropPgm: cropPgm, _pathsFor: pathsFor, _cleanName: cleanName
  };
}));
