/*
 * Интерфейс: слева ввод помещений, справа сразу результат. На узком экране это
 * две вкладки. Vue 3 без сборки; расчёт — FireEngine, отчёт — FireReport.
 *
 * Под помещениями каждого этажа — схема (FirePlan): на ней отмечают, какие
 * огнетушители стоят на объекте; из отметок получается перечень нарушений.
 * Расчёт целиком помещается в ссылку (FireShare) — она же в QR-коде отчёта.
 *
 * Объектов может быть несколько, они хранятся только в браузере (localStorage).
 * Данные для отчёта (адрес, собственник, кто выполнил) спрашиваются при
 * скачивании PDF, чтобы не мешать началу работы.
 */
(function () {
  'use strict';

  const N = window.FireNorms, E = window.FireEngine, P = window.FirePresets, R = window.FireReport;
  const PL = window.FirePlan, SH = window.FireShare, V = window.FireVision;

  // ?ns=имя — отдельное хранилище (им пользуется страница проверки интерфейса,
  // чтобы не трогать рабочие данные).
  const NS = new URLSearchParams(window.location.search).get('ns');
  const SUFFIX = NS ? '.' + NS.replace(/[^A-Za-z0-9_-]/g, '') : '';
  const STORE_KEY = 'firecalc.store.v2' + SUFFIX;
  const OLD_KEY = 'firecalc.state.v1' + SUFFIX; // формат до списка объектов: один объект

  let seq = 0;
  function uid(prefix) { seq += 1; return prefix + Date.now().toString(36) + seq; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toNum(v) { const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(',', '.')); return isFinite(n) && n > 0 ? n : 0; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function newRoom(purpose) { return Object.assign(P.blankRoom(purpose), { id: uid('r'), more: false }); }
  function newFloor(number, purpose) {
    return { id: uid('f'), name: number + ' этаж', installedOP: '', installedOU: '', rooms: [newRoom(purpose)], plan: adoptPlan(null, {}) };
  }

  // Схема этажа: open — раскрыта ли; view — «как есть» (fact) или «по нормам» (want);
  // pos — расположение помещений, если их двигали; ext — отмеченные огнетушители.
  // Метки привязаны к id помещений; idMap переводит прежние id в новые.
  function adoptPlan(plan, idMap) {
    const out = { open: !!(plan && plan.open), view: 'fact', pos: null, ext: [] };
    if (!plan) return out;
    function rekey(k) {
      const m = /^(.*):(\d+)$/.exec(String(k));
      return m && idMap[m[1]] ? idMap[m[1]] + ':' + m[2] : null;
    }
    if (plan.pos && typeof plan.pos === 'object') {
      const pos = {};
      Object.keys(plan.pos).forEach(function (k) {
        const key = rekey(k), p = plan.pos[k];
        if (key && Array.isArray(p)) pos[key] = [Number(p[0]) || 0, Number(p[1]) || 0];
      });
      if (Object.keys(pos).length) out.pos = pos;
    }
    (Array.isArray(plan.ext) ? plan.ext : []).forEach(function (e) {
      const key = e && rekey(e.k);
      if (!key) return;
      out.ext.push({
        id: uid('e'), k: key, u: unit(e.u), v: unit(e.v),
        t: e.t === 'ou' ? 'ou' : (e.t === 'op' ? 'op' : 'x'), code: typeof e.code === 'string' ? e.code.slice(0, 12) : ''
      });
    });
    return out;
  }
  function unit(x) { const n = Number(x); return isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000 : 0.5; }

  // Загруженный план этажа: ключ картинки, её размер, масштаб и контуры помещений (в точках картинки).
  function adoptBlueprint(bp) {
    if (!bp || typeof bp !== 'object' || !(Number(bp.scale) > 0) || !Array.isArray(bp.rooms)) return null;
    const rooms = bp.rooms.filter(function (r) {
      return r && Array.isArray(r.poly) && r.poly.length >= 3 && Array.isArray(r.bbox) && r.bbox.length === 4;
    }).map(function (r) {
      return { id: r.id, poly: r.poly.map(function (p) { return [Number(p[0]) || 0, Number(p[1]) || 0]; }), bbox: r.bbox.map(Number), lx: Number(r.lx) || 0, ly: Number(r.ly) || 0 };
    });
    return { img: typeof bp.img === 'string' ? bp.img : '', w: Number(bp.w) || 0, h: Number(bp.h) || 0, scale: Number(bp.scale), rooms: rooms };
  }
  function blankObject(inspector) {
    return {
      id: uid('o'), example: '',
      building: { name: '', address: '', owner: '', inspector: inspector || '', date: today(), kind: 'public', autoSuppressionAll: false },
      floors: [newFloor(1, 'office')]
    };
  }

  // Приводит сохранённые данные или пример к виду, с которым работает интерфейс.
  function adoptObject(data) {
    const base = blankObject('');
    const building = Object.assign(base.building, data.building || {});
    if (!building.date) building.date = today();
    const floors = (data.floors || []).map(function (f, i) {
      const idMap = {};
      const rooms = (f.rooms || []).map(function (r) {
        const room = Object.assign(P.blankRoom(r.purpose || 'custom'), r, { id: uid('r'), more: false });
        if (!P.BY_ID[room.purpose]) room.purpose = 'custom'; // назначение, которого нет в справочнике (старые данные, чужая ссылка)
        if (r.id) idMap[r.id] = room.id;
        room.classes = (r.classes || room.classes || []).slice();
        // в самом раннем формате число гаражей лежало в поле units, а поля count не было
        if (!toNum(r.count)) room.count = r.t5 === 'garage_box' && toNum(r.units) ? Math.round(toNum(r.units)) : 1;
        delete room.units;
        return room;
      });
      return {
        id: uid('f'),
        name: f.name || ((i + 1) + ' этаж'),
        installedOP: f.installedOP === undefined || f.installedOP === null ? '' : f.installedOP,
        installedOU: f.installedOU === undefined || f.installedOU === null ? '' : f.installedOU,
        rooms: rooms,
        plan: adoptPlan(f.plan, idMap),
        blueprint: adoptBlueprint(f.blueprint)
      };
    });
    return { id: data.id || base.id, example: data.example || '', building: building, floors: floors.length ? floors : base.floors };
  }

  function loadStore() {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.objects) && d.objects.length) {
          return { objects: d.objects.map(adoptObject), currentId: d.currentId, options: d.options, ui: d.ui };
        }
      }
      const old = window.localStorage.getItem(OLD_KEY);
      if (old) {
        const d = JSON.parse(old);
        return { objects: [adoptObject(d)], currentId: '', options: d.options };
      }
    } catch (e) { /* повреждённые данные — начинаем с чистого листа */ }
    return null;
  }

  // Копирование в буфер обмена: современный способ, затем прежний (он работает
  // и на страницах, открытых по http).
  function copyText(text) {
    function legacy() {
      return new Promise(function (resolve, reject) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error('копирование недоступно'));
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }

  // ---------- план этажа по картинке ----------

  const MAX_PLAN_SIDE = 1600; // длинная сторона картинки плана, точек: больше — уменьшается
  const EXAMPLE_PLAN = { src: 'examples/plan-school.png', ruler: [[50, 543], [250, 543]], meters: 10 }; // линейка 10 м на примере

  // Картинки планов лежат в IndexedDB (в localStorage им тесно), по ключу из floor.blueprint.img.
  const IMG = (function () {
    let opened = null;
    function db() {
      if (!opened) {
        opened = new Promise(function (resolve, reject) {
          if (!window.indexedDB) { reject(new Error('хранилище картинок недоступно')); return; }
          const req = window.indexedDB.open('firecalc' + SUFFIX, 1);
          req.onupgradeneeded = function () { req.result.createObjectStore('img'); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
        opened.catch(function () { opened = null; });
      }
      return opened;
    }
    function run(mode, fn) {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          const t = d.transaction('img', mode), req = fn(t.objectStore('img'));
          t.oncomplete = function () { resolve(req.result); };
          t.onerror = function () { reject(t.error); };
        });
      });
    }
    return {
      put: function (key, value) { return run('readwrite', function (s) { return s.put(value, key); }); },
      get: function (key) { return run('readonly', function (s) { return s.get(key); }); }
    };
  }());

  // Картинка (файл или адрес) → уменьшенная копия для хранения и пиксели для распознавания.
  function loadPicture(src) {
    return new Promise(function (resolve, reject) {
      const isFile = typeof src !== 'string', url = isFile ? URL.createObjectURL(src) : src, img = new Image();
      img.onload = function () {
        const k = Math.min(1, MAX_PLAN_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        if (isFile) URL.revokeObjectURL(url);
        try {
          const rgba = ctx.getImageData(0, 0, w, h).data;
          const png = isFile ? /png|gif|svg/.test(src.type) : /\.(png|svg)(\?|$)/i.test(src);
          resolve({ img: canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85), w: w, h: h, rgba: rgba });
        } catch (e) { reject(new Error('не удалось прочитать картинку')); }
      };
      img.onerror = function () { if (isFile) URL.revokeObjectURL(url); reject(new Error('не удалось открыть картинку — нужен снимок или картинка (JPG, PNG)')); };
      img.src = url;
    });
  }

  // Распознавание в фоновом потоке; если потоки недоступны (страница открыта из файла) — здесь же.
  let visionWorker = null, visionJobs = 0;
  const visionWaiting = {};
  function runVision(rgba, w, h, opts) {
    function here() { return V.findRooms(rgba, w, h, opts); }
    return new Promise(function (resolve, reject) {
      try {
        if (!visionWorker) {
          visionWorker = new Worker('js/vision.worker.js?v=6');
          visionWorker.onmessage = function (e) {
            const job = visionWaiting[e.data.id];
            if (!job) return;
            delete visionWaiting[e.data.id];
            if (e.data.ok) job.resolve(e.data.out); else job.reject(new Error(e.data.error));
          };
          visionWorker.onerror = function () {
            // поток не запустился — считаем ожидающие задания здесь
            visionWorker = null;
            Object.keys(visionWaiting).forEach(function (id) {
              const job = visionWaiting[id];
              delete visionWaiting[id];
              try { job.resolve(job.here()); } catch (err) { job.reject(err); }
            });
          };
        }
        const id = ++visionJobs, copy = new Uint8ClampedArray(rgba);
        visionWaiting[id] = { resolve: resolve, reject: reject, here: here };
        visionWorker.postMessage({ id: id, w: w, h: h, buffer: copy.buffer, opts: opts }, [copy.buffer]);
      } catch (e) {
        try { resolve(here()); } catch (err) { reject(err); }
      }
    });
  }

  // pdfmake и шрифты (2 МБ) подгружаются только когда нужен PDF.
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('не удалось загрузить ' + src)); };
      document.head.appendChild(s);
    });
  }
  let pdfReady = null;
  function ensurePdf() {
    if (window.pdfMake && window.pdfMake.vfs) return Promise.resolve();
    if (!pdfReady) {
      pdfReady = loadScript('vendor/pdfmake.min.js')
        .then(function () { return loadScript('vendor/vfs_report.js'); })
        .catch(function (e) { pdfReady = null; throw e; });
    }
    return pdfReady;
  }

  const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  const TEMPLATE = `
<header class="top">
  <div class="top__in">
    <div class="brand__name">Расчёт огнетушителей</div>
    <span class="net" v-if="offline" data-test="offline">без сети</span>
    <span class="spacer"></span>
    <div class="menu">
      <button type="button" class="btn btn--sm btn--quiet" data-test="objects" :aria-expanded="menuOpen" @click.stop="menuOpen = !menuOpen">Объекты <span class="mono muted">{{ objects.length }}</span></button>
      <div class="menu__panel" v-if="menuOpen" @click.stop>
        <div :class="['menu__item', { 'menu__item--on': o.id === current.id }]" v-for="o in objects" :key="o.id">
          <button type="button" class="menu__open" data-test="object" @click="openObject(o.id)">
            <span class="menu__name">{{ objectName(o) }}</span>
            <span class="menu__meta">{{ objectMeta(o) }}</span>
          </button>
          <button type="button" class="icon icon--danger" title="Удалить объект" aria-label="Удалить объект" data-test="object-del" @click="removeObject(o.id)" v-html="iconTrash"></button>
        </div>
        <div class="menu__foot">
          <span class="muted">Примеры</span>
          <button type="button" class="link" data-test="example" v-for="(ex, key) in examples" :key="key" @click="loadExample(key)">{{ ex.title }}</button>
        </div>
        <div class="menu__note" v-if="swReady">Приложение сохранено на устройстве и работает без сети</div>
      </div>
    </div>
    <button type="button" class="btn btn--sm" data-test="new" @click="newObject"><span class="full">Новый расчёт</span><span class="short">Новый</span></button>
  </div>
  <nav class="tabs" aria-label="Разделы">
    <button type="button" :class="['tab', { 'tab--on': tab === 'input' }]" data-test="tab-input" @click="go('input')">Помещения<span class="tab__n" v-if="result.summary.rooms">{{ result.summary.rooms }}</span></button>
    <button type="button" :class="['tab', { 'tab--on': tab === 'result' }]" data-test="tab-result" @click="go('result')">Результат<span class="tab__n" v-if="extTotal">{{ extTotal }}</span></button>
  </nav>
</header>

<main :class="['work', 'work--' + tab]">

  <!-- ВВОД -->
  <section class="pane pane--input" aria-label="Помещения">
    <input type="text" class="title" data-test="title" v-model.trim="building.name" placeholder="Название объекта" aria-label="Название объекта">

    <div class="setup">
      <div class="seg" role="radiogroup" aria-label="Назначение здания">
        <label v-for="k in kinds" :key="k.id" :class="['seg__opt', { 'seg__opt--on': building.kind === k.id }]" :title="k.hint">
          <input type="radio" name="kind" class="sr" :value="k.id" v-model="building.kind"><span>{{ k.label }}</span>
        </label>
      </div>
      <label class="check">
        <input type="checkbox" v-model="building.autoSuppressionAll">
        <span>Автоматическое пожаротушение во всём здании</span>
      </label>
    </div>
    <p class="hint">{{ kindHint }}</p>
    <div class="tip" v-if="isBlank(current)" data-test="bp-tip">
      <span>Есть план эвакуации или техпаспорт? Сфотографируйте план этажа — помещения и площади найдутся сами, прямо на телефоне, без интернета.</span>
      <button type="button" class="btn btn--sm" data-test="bp-tip-open" @click="openBp(floors[0])">Загрузить план</button>
    </div>

    <div class="floor" v-for="(floor, fi) in floors" :key="floor.id">
      <div class="floor__head">
        <input type="text" class="floor__name" v-model.trim="floor.name" aria-label="Название этажа">
        <span class="floor__meta">{{ floorRooms(floor) }} пом. · {{ fmt(floorArea(floor)) }} м²</span>
        <span class="spacer"></span>
        <span class="floor__need"><b>{{ floorNeed(floor.id) }}</b></span>
        <button type="button" class="btn btn--sm btn--quiet" data-test="dup-floor" @click="duplicateFloor(fi)">Дублировать</button>
        <button type="button" class="btn btn--sm btn--quiet" data-test="del-floor" :disabled="floors.length === 1" @click="removeFloor(fi)">Удалить</button>
      </div>

      <div class="rooms">
        <div class="rooms__head" aria-hidden="true">
          <span>Помещение</span><span>Назначение</span><span>Площадь, м²</span><span>Кол-во</span><span>Категория и классы пожара</span><span></span>
        </div>

        <div :class="['room', { 'room--closed': openRoom !== room.id }]" v-for="(room, ri) in floor.rooms" :key="room.id" :data-room="room.id">
          <button type="button" class="room__summary" @click="openRoom = room.id">
            <span>{{ room.name || shortName(room.purpose) }}</span>
            <span class="room__smeta">{{ roomMeta(room) }}</span>
          </button>

          <div class="room__main">
            <label class="field f-name"><span class="sr">Помещение</span>
              <input type="text" v-model.trim="room.name" :placeholder="shortName(room.purpose)" @change="onName(room)" @keydown.enter="onName(room)"></label>
            <label class="field f-purpose"><span class="sr">Назначение</span>
              <select v-model="room.purpose" @change="onPurpose(room)">
                <optgroup v-for="g in purposeGroups" :key="g.group" :label="g.group">
                  <option v-for="p in g.items" :key="p.id" :value="p.id">{{ p.label }}</option>
                </optgroup>
              </select></label>

            <label class="field f-area" v-if="needsArea(room)"><span class="sr">Площадь, м²</span>
              <input type="number" min="0" step="any" inputmode="decimal" v-model="room.area" placeholder="м²"
                :class="{ 'is-missing': areaMissing(floor, room, ri) }" @keydown.enter.prevent="addAfter(floor, ri)"></label>
            <div class="field f-area" v-else><span class="sr">Площадь</span><input type="text" value="не нужна" disabled></div>

            <label class="field f-count"><span class="sr">Кол-во</span>
              <input type="number" min="1" step="1" inputmode="numeric" v-model="room.count" title="Сколько таких одинаковых помещений"
                aria-label="Количество одинаковых помещений" @keydown.enter.prevent="addAfter(floor, ri)"></label>

            <div class="field f-norm"><span class="sr">Категория и классы пожара</span>
              <div class="norm">
                <select class="norm__cat" v-if="!room.t5 && building.kind !== 'public'" v-model="room.category" aria-label="Категория" @change="room.forceType = ''">
                  <option v-for="c in categories" :key="c.id" :value="c.id" :title="c.title">{{ c.short }}</option>
                </select>
                <button type="button" class="norm__btn" :aria-expanded="room.more" :title="normSummary(room) + ' — изменить'" @click="room.more = !room.more">{{ normSummary(room) }}</button>
              </div>
            </div>

            <div class="room__tools">
              <button type="button" class="icon" title="Дублировать помещение" aria-label="Дублировать помещение" @click="duplicateRoom(floor, ri)" v-html="iconCopy"></button>
              <button type="button" class="icon icon--danger" data-test="del-room" title="Удалить помещение" aria-label="Удалить помещение" @click="removeRoom(floor, ri)" v-html="iconTrash"></button>
            </div>
          </div>

          <div class="room__more" v-if="room.more">
            <template v-if="!room.t5">
              <label class="field m-cat"><span>Категория</span>
                <select v-model="room.category" @change="room.forceType = ''">
                  <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.long }}</option>
                </select></label>
              <div class="field m-classes"><span>Классы пожара</span>
                <div class="chips">
                  <button type="button" v-for="k in fireClasses" :key="k.id"
                    :class="['chip', { 'chip--on': room.classes.indexOf(k.id) >= 0 }]"
                    :title="k.id + ' — ' + k.name" :aria-pressed="room.classes.indexOf(k.id) >= 0"
                    @click="toggleClass(room, k.id)">{{ k.id }}</button>
                </div>
              </div>
              <label class="field m-dim"><span>Длина, м</span><input type="number" min="0" step="any" inputmode="decimal" v-model="room.length" @change="onDims(room)"></label>
              <label class="field m-dim"><span>Ширина, м</span><input type="number" min="0" step="any" inputmode="decimal" v-model="room.width" @change="onDims(room)"></label>
              <div class="steps">
                <button type="button" class="link" data-test="steps-toggle" :aria-expanded="ui.steps" @click="ui.steps = !ui.steps">{{ ui.steps ? 'Скрыть замер шагами' : 'Нет рулетки? Измерить шагами' }}</button>
                <template v-if="ui.steps">
                  <label class="steps__f"><span>Длина, шагов</span><input type="number" min="0" step="1" inputmode="numeric" data-test="steps-l" v-model="room.stepsL" @input="onSteps(room)"></label>
                  <label class="steps__f"><span>Ширина, шагов</span><input type="number" min="0" step="1" inputmode="numeric" data-test="steps-w" v-model="room.stepsW" @input="onSteps(room)"></label>
                  <label class="steps__f"><span>Длина шага, м</span><input type="number" min="0.3" max="1.2" step="0.05" inputmode="decimal" v-model="ui.step" @input="onSteps(room)"></label>
                </template>
              </div>
            </template>
            <label class="check m-check">
              <input type="checkbox" v-model="room.autoSuppression" :disabled="building.autoSuppressionAll">
              <span>Автоматическое пожаротушение<small>{{ building.autoSuppressionAll ? 'Уже отмечено для всего здания' : 'Ручных огнетушителей 50 % от нормы (п. 10)' }}</small></span>
            </label>
            <label class="check m-check" v-if="!room.t5">
              <input type="checkbox" v-model="room.sensitive" @change="room.forceType = ''">
              <span>Дорогая электроника или ценности<small>Выбирается углекислотный огнетушитель (п. 9)</small></span>
            </label>
            <div class="room__note" v-if="!room.t5">
              Классы: A твёрдые материалы, B горючие жидкости, C газы, D металлы, E электрооборудование под напряжением.
              Длина и ширина нужны, чтобы проверить расстояние до огнетушителя (п. 4).
              <template v-if="dimsMismatch(room)"> <b>Длина × ширина = {{ dimsMismatch(room) }} м², а площадь указана {{ fmt(room.area) }} м².</b></template>
            </div>
            <div class="room__note" v-else>Норма по табл. 5: категория и классы пожара не нужны.</div>
          </div>
        </div>
      </div>

      <div class="floor__foot">
        <span class="muted">Добавить</span>
        <button type="button" class="chip chip--add" data-test="quick" v-for="q in quick" :key="q" @click="addRoom(floor, q)">{{ shortName(q) }}</button>
        <button type="button" class="chip chip--add" data-test="quick-other" @click="addRoom(floor, 'custom')">Другое</button>
      </div>

      <div class="plan">
        <div class="plan__head">
          <button type="button" class="btn btn--sm" data-test="plan-toggle" :aria-expanded="floor.plan.open" @click="floor.plan.open = !floor.plan.open">{{ floor.plan.open ? 'Скрыть схему' : 'Схема этажа' }}</button>
          <button type="button" class="btn btn--sm" data-test="bp-open" @click="openBp(floor)">{{ floor.blueprint ? 'Заменить план этажа' : 'По плану этажа' }}</button>
          <span class="plan__stat" data-test="plan-stat">{{ planStat(floor) }}</span>
        </div>
        <template v-if="floor.plan.open">
          <p class="hint" v-if="!sceneOf(floor).rects.length">Введите площадь помещений — схема построится сама</p>
          <template v-else>
            <div class="plan__tools">
              <div class="seg seg--sm" role="radiogroup" aria-label="Что показывает схема">
                <label v-for="v in planViews" :key="v.id" :class="['seg__opt', { 'seg__opt--on': floor.plan.view === v.id }]" :title="v.hint">
                  <input type="radio" class="sr" :name="'pv' + floor.id" :value="v.id" v-model="floor.plan.view" :data-test="'plan-view-' + v.id"><span>{{ v.label }}</span>
                </label>
              </div>
              <div class="seg seg--sm" role="radiogroup" aria-label="Что делает нажатие на схему" v-if="floor.plan.view === 'fact'">
                <label v-for="m in planModes" :key="m.id" :class="['seg__opt', { 'seg__opt--on': planMode === m.id }]" :title="m.hint">
                  <input type="radio" class="sr" :name="'pm' + floor.id" :value="m.id" v-model="planMode" :data-test="'plan-mode-' + m.id"><span>{{ m.label }}</span>
                </label>
              </div>
              <span class="spacer"></span>
              <button type="button" class="btn btn--sm btn--quiet" data-test="plan-clear" v-if="floor.plan.view === 'fact' && factOf(floor).marked" @click="clearExt(floor)">Убрать все</button>
              <button type="button" class="btn btn--sm btn--quiet" data-test="plan-reset" v-if="floor.plan.pos" @click="resetLayout(floor)">Расставить заново</button>
            </div>
            <svg :class="['plan__svg', 'plan__svg--' + modeOf(floor), { 'plan__svg--dense': sceneOf(floor).ext.length > 8 }]" :data-floor="floor.id" data-test="plan-svg" role="img" :aria-label="'Схема: ' + floor.name"
                 :viewBox="viewBox(floor)" :style="{ aspectRatio: viewRatio(floor) }"
                 @click="planClick(floor, $event)" @pointerdown="planDown(floor, $event)" @pointermove="planMove(floor, $event)"
                 @pointerup="planUp(floor, $event)" @pointercancel="planUp(floor, $event)">
              <image v-if="bgOf(floor)" class="plan__bg" :href="bgOf(floor).src" x="0" y="0" :width="bgOf(floor).w" :height="bgOf(floor).h" preserveAspectRatio="none"></image>
              <template v-for="r in sceneOf(floor).rects" :key="r.key">
                <polygon v-if="r.poly" :data-key="r.key" :class="['plan__room', 'plan__room--bp', { 'plan__room--sens': r.sensitive }]"
                         :points="polyPts(r.poly)"><title>{{ r.name }}</title></polygon>
                <rect v-else :data-key="r.key" :class="['plan__room', { 'plan__room--approx': r.approx, 'plan__room--sens': r.sensitive }]"
                      :x="r.x" :y="r.y" :width="r.w" :height="r.h"><title>{{ r.name }}</title></rect>
              </template>
              <rect v-for="(g, gi) in planGaps(floor)" :key="'g' + gi" class="plan__gap" :x="g.x" :y="g.y" :width="g.w" :height="g.h"></rect>
              <circle v-for="e in sceneOf(floor).ext" :key="'c' + e.id" class="plan__reach" :cx="e.x" :cy="e.y" :r="e.rect.limit"></circle>
              <text v-for="l in planLabels(floor)" :key="'l' + l.key" class="plan__label" :x="l.x" :y="l.y" :font-size="l.size" :text-anchor="l.anchor">{{ l.text }}</text>
              <g v-for="e in sceneOf(floor).ext" :key="e.id" :data-ext="e.id" :class="['plan__ext', 'plan__ext--' + e.t]" :transform="'translate(' + e.x + ' ' + e.y + ')'">
                <circle class="plan__hit" :r="px(floor, 16)"></circle>
                <circle class="plan__dot" :r="px(floor, 9)" :stroke-width="px(floor, 1.5)"></circle>
                <text text-anchor="middle" :font-size="px(floor, 10)" :y="px(floor, 3.5)">{{ e.t === 'op' ? 'П' : (e.t === 'ou' ? 'У' : '?') }}</text>
                <title>{{ extTitle(e) }}</title>
              </g>
            </svg>
            <p class="plan__hint">{{ planHint(floor) }}</p>
          </template>
        </template>
      </div>
    </div>

    <div class="section-foot">
      <button type="button" class="btn" data-test="add-floor" @click="addFloor">Добавить этаж</button>
    </div>
  </section>

  <!-- РЕЗУЛЬТАТ -->
  <section class="pane pane--result" aria-label="Результат">
    <div class="res-head">
      <h2>Требуется по нормам</h2>
      <button type="button" class="btn btn--primary" data-test="pdf" :disabled="!result.totals.length" @click="openPdf">Скачать PDF</button>
    </div>

    <div class="empty" v-if="!result.totals.length">
      <p>Введите площадь хотя бы одного помещения, и здесь появится расчёт</p>
      <p class="quick">
        <span class="muted">Или откройте пример</span>
        <button type="button" class="link" data-test="example-empty" v-for="(ex, key) in examples" :key="key" @click="loadExample(key)">{{ ex.title }}</button>
      </p>
    </div>

    <template v-else>
      <div class="ledger">
        <div v-for="t in result.totals" :key="t.kind + t.code + t.charge" :class="['total', 'total--' + t.agent]">
          <span class="total__sw"></span>
          <div>
            <div class="total__code">{{ t.code }}</div>
            <div class="total__name">{{ t.name }}<template v-if="t.charge">, порошок {{ t.charge }}</template></div>
          </div>
          <div class="total__n">{{ t.count }}<small>{{ t.kind === 'shield' ? 'компл.' : 'шт.' }}</small></div>
        </div>
      </div>
      <p class="summary">{{ summaryLine }}</p>
      <p class="share"><button type="button" class="link" data-test="share" @click="share">Ссылка на этот расчёт</button></p>

      <div class="block">
        <h3>Сверка с фактом</h3>
        <div class="scroll">
          <table class="table">
            <thead>
              <tr><th rowspan="2">Этаж</th><th colspan="3" class="grp">Порошковые, ОП</th><th colspan="3" class="grp">Углекислотные, ОУ</th></tr>
              <tr><th>нужно</th><th>есть</th><th>не хватает</th><th>нужно</th><th>есть</th><th>не хватает</th></tr>
            </thead>
            <tbody>
              <tr v-for="f in checkFloors" :key="f.id">
                <td>{{ f.name }}</td>
                <td>{{ f.portable.powder }}</td>
                <td v-if="f.fromPlan" class="fact--plan" title="Отмечено на схеме этажа">{{ f.check.installedOP }}</td>
                <td v-else><input type="number" min="0" step="1" inputmode="numeric" class="fact" data-test="fact-op" placeholder="—"
                  v-model="floorById(f.id).installedOP" :aria-label="'Установлено порошковых, ' + f.name"></td>
                <td :class="{ bad: f.check && f.check.deficitOP > 0 }">{{ f.check ? f.check.deficitOP : '' }}</td>
                <td>{{ f.portable.co2 }}</td>
                <td v-if="f.fromPlan" class="fact--plan" title="Отмечено на схеме этажа">{{ f.check.installedOU }}</td>
                <td v-else><input type="number" min="0" step="1" inputmode="numeric" class="fact" data-test="fact-ou" placeholder="—"
                  v-model="floorById(f.id).installedOU" :aria-label="'Установлено углекислотных, ' + f.name"></td>
                <td :class="{ bad: f.check && f.check.deficitOU > 0 }">{{ f.check ? f.check.deficitOU : '' }}</td>
              </tr>
            </tbody>
            <tfoot v-if="result.check"><tr>
              <td>Итого</td>
              <td>{{ result.check.requiredOP }}</td><td>{{ result.check.installedOP }}</td><td :class="{ bad: result.check.deficitOP > 0 }">{{ result.check.deficitOP }}</td>
              <td>{{ result.check.requiredOU }}</td><td>{{ result.check.installedOU }}</td><td :class="{ bad: result.check.deficitOU > 0 }">{{ result.check.deficitOU }}</td>
            </tr></tfoot>
          </table>
        </div>
        <div :class="['verdict', { 'verdict--bad': verdictBad }]" v-if="result.check">
          <div class="verdict__title">{{ verdictBad ? 'Не соответствует' : 'Соответствует' }}</div>
          <p>{{ verdictText }}</p>
        </div>
        <p class="hint" v-else>Впишите, сколько огнетушителей установлено на этаже, или отметьте их на схеме этажа — здесь появится вывод</p>
        <ol class="finds" data-test="finds" v-if="audit.findings.length">
          <li v-for="(x, i) in audit.findings" :key="i" :class="'find find--' + x.level">
            <span class="ref">{{ x.floor }} · {{ x.ref }}{{ x.level === 'warn' ? ' · проверить на месте' : '' }}</span>
            <span>{{ x.text }}<template v-if="x.action"> {{ x.action }}.</template></span>
          </li>
        </ol>
        <p class="hint" v-if="result.check && planFloors">У этажей со схемой числа «есть» взяты с неё</p>
      </div>

      <div class="block notice" v-if="result.warnings.length">
        <h3>Требует внимания</h3>
        <ul><li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li></ul>
      </div>

      <template v-for="f in result.floors" :key="f.id">
        <div class="block" v-if="f.units.length">
          <div class="floorres__head">
            <h3>{{ f.name }}</h3>
            <span class="floorres__meta">{{ floorSummary(f) }}</span>
            <span class="spacer"></span>
            <button type="button" class="link" @click="toggleFloor(f)">{{ floorOpen(f) ? 'Скрыть расчёты' : 'Все расчёты' }}</button>
          </div>

          <div class="unit" v-for="u in f.units" :key="u.id">
            <div>
              <div class="unit__title">{{ u.title }}</div>
              <div class="unit__meta">{{ unitMeta(u) }}</div>
              <button type="button" class="link unit__toggle" @click="toggle(u.id)" :aria-expanded="!!open[u.id]">{{ open[u.id] ? 'Скрыть расчёт' : 'Показать расчёт' }}</button>
            </div>
            <div class="unit__need">
              <span class="need" v-for="(l, li) in u.lines" :key="li">{{ l.count }} × {{ lineTitle(l) }}</span>
              <span class="need need--none" v-if="!u.lines.length">не требуется</span>
            </div>

            <div class="unit__why" v-if="open[u.id]">
              <div v-if="u.matrix && u.matrix.rows.length">
                <div class="matrix__cap">{{ matrixCaption(u) }}</div>
                <div class="scroll">
                  <table class="matrix">
                    <thead><tr>
                      <th class="rowh">Класс</th>
                      <th v-for="c in u.matrix.columns" :key="c.id">{{ c.code }}</th>
                      <th v-if="matrixMixed(u)"></th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="r in u.matrix.rows" :key="r.cls">
                        <th class="rowh">{{ r.cls }}</th>
                        <td v-for="(c, ci) in r.cells" :key="ci" :class="cellClass(c)">{{ c.mark === '-' ? '—' : c.n + ' ' + c.mark }}</td>
                        <td class="where" v-if="matrixMixed(u)">на {{ r.area }} м²{{ r.fallback ? ', строка «' + r.rowTitle + '»' : '' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="matrix__legend">++ рекомендуется · + допускается при обосновании · — не допускается</div>
              </div>

              <div class="whys">
                <div class="why" v-for="(s, si) in u.steps" :key="si"><span class="ref">{{ s.ref }}</span><span>{{ s.text }}</span></div>
              </div>
              <div class="note" v-for="(n, ni) in u.notes" :key="'n' + ni">{{ n }}</div>

              <div class="alts" v-if="u.kind === 'table1' && (u.alternatives.length || isForced(u))">
                <span>Заменить на</span>
                <button type="button" class="chip chip--alt" v-for="a in u.alternatives" :key="a.typeId" @click="force(u, a.typeId)">{{ a.text }}</button>
                <button type="button" class="link" v-if="isForced(u)" @click="force(u, '')">Вернуть автоматический выбор</button>
              </div>
              <div class="alts" v-if="u.kind === 'table5' && u.alternatives.length">
                <span>Заменить на</span>
                <button type="button" class="chip chip--alt" @click="swapT5(u)">{{ u.alternatives[0].text }}</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div class="block">
        <details class="fold">
          <summary>Размещение и содержание</summary>
          <div class="fold__body"><ul><li v-for="(p, i) in result.placement" :key="i">{{ p }}</li></ul></div>
        </details>
        <details class="fold">
          <summary>Параметры расчёта</summary>
          <div class="fold__body">
            <div>Как округлять количество</div>
            <label class="radio"><input type="radio" name="rounding" value="proportional" v-model="options.rounding">
              <span>Пропорционально площади<small>450 м² × 4 шт. / 800 м² = 2,25, нужно 3 шт.</small></span></label>
            <label class="radio"><input type="radio" name="rounding" value="block" v-model="options.rounding">
              <span>Полными комплектами<small>На каждые начатые 800 м² все 4 шт. Строже: на 450 м² нужно 4 шт.</small></span></label>
            <label class="check"><input type="checkbox" v-model="options.poolSmallRooms"><span>Считать небольшие помещения одной категории по суммарной площади (п. 7)</span></label>
            <label class="check"><input type="checkbox" v-model="options.onlyPowderAndCO2"><span>Предлагать только порошковые (ОП) и углекислотные (ОУ)</span></label>
            <label class="check"><input type="checkbox" v-model="options.wheeled"><span>Добавлять передвижные огнетушители большим помещениям (табл. 2)</span></label>
            <label class="check"><input type="checkbox" data-test="opt-min-all" v-model="options.floorMinAll">
              <span>Не менее двух огнетушителей на этаже — в любом здании<small>Без отметки — только в общественных, как в п. 5 Приложения 3</small></span></label>
          </div>
        </details>
        <details class="fold">
          <summary>Как считаем: правила и допущения</summary>
          <div class="fold__body">
            <p>Правила не определяют некоторые детали расчёта. Здесь перечислено, как они решены. В PDF попадают только те пункты, которые повлияли на расчёт.</p>
            <ul><li v-for="(a, i) in methodology" :key="i">{{ a }}</li></ul>
            <div>Нормативные источники</div>
            <ul><li v-for="s in sources" :key="s.id">{{ s.title }}</li></ul>
          </div>
        </details>
      </div>
    </template>

    <p class="hint" style="margin-top:16px" v-if="selfcheck" id="selfcheck">{{ selfcheck }}</p>
  </section>
</main>

<!-- ДАННЫЕ ДЛЯ ОТЧЁТА -->
<div class="modal" v-if="pdfDialog" @click.self="pdfDialog = false">
  <div class="modal__box" role="dialog" aria-modal="true" aria-labelledby="pdfTitle">
    <h2 id="pdfTitle">Данные для отчёта</h2>
    <p class="hint">Попадут в шапку PDF. Пустые поля останутся прочерками</p>
    <div class="modal__grid">
      <label class="field modal__wide"><span>Название объекта</span><input type="text" data-test="pdf-name" v-model.trim="building.name" placeholder="Школа № 12"></label>
      <label class="field modal__wide"><span>Адрес</span><input type="text" v-model.trim="building.address" placeholder="Город, улица, дом"></label>
      <label class="field modal__wide"><span>Собственник или организация</span><input type="text" v-model.trim="building.owner"></label>
      <label class="field"><span>Расчёт выполнил</span><input type="text" v-model.trim="building.inspector" placeholder="Фамилия И. О., должность"></label>
      <label class="field"><span>Дата расчёта</span><input type="date" v-model="building.date"></label>
    </div>
    <div class="modal__foot">
      <button type="button" class="btn" data-test="pdf-cancel" @click="pdfDialog = false">Отмена</button>
      <button type="button" class="btn btn--primary" data-test="pdf-go" :disabled="pdfBusy" @click="downloadPdf">{{ pdfBusy ? 'Формирую…' : 'Скачать PDF' }}</button>
    </div>
  </div>
</div>

<!-- ССЫЛКА НА РАСЧЁТ: показывается, если браузер не дал скопировать её сам -->
<div class="modal" v-if="linkDialog" @click.self="linkDialog = ''">
  <div class="modal__box" role="dialog" aria-modal="true" aria-labelledby="linkTitle" data-test="link-dialog">
    <h2 id="linkTitle">Ссылка на этот расчёт</h2>
    <p class="hint">Весь расчёт лежит в самой ссылке. Отправьте её — по ней откроется этот же объект</p>
    <input type="text" class="linkbox" readonly :value="linkDialog" aria-label="Ссылка на расчёт" @focus="$event.target.select()">
    <div class="modal__foot">
      <button type="button" class="btn" data-test="link-close" @click="linkDialog = ''">Закрыть</button>
      <button type="button" class="btn btn--primary" data-test="link-copy" @click="copyLinkNow">Скопировать</button>
    </div>
  </div>
</div>

<!-- ПЛАН ЭТАЖА ПО КАРТИНКЕ -->
<div class="modal modal--full" v-if="bp" @click.self="closeBp">
  <div class="modal__box bp" role="dialog" aria-modal="true" aria-labelledby="bpTitle" data-test="bp-dialog">
    <div class="bp__head">
      <h2 id="bpTitle">План этажа{{ bpFloorName ? ' · ' + bpFloorName : '' }}</h2>
      <span class="spacer"></span>
      <button type="button" class="btn btn--sm btn--quiet" data-test="bp-close" @click="closeBp">Закрыть</button>
    </div>
    <div class="bp__body">
      <div class="bp__stage" v-if="bp.img">
        <svg class="bp__svg" :viewBox="'0 0 ' + bp.w + ' ' + bp.h" :style="{ aspectRatio: bp.w + ' / ' + bp.h }" data-test="bp-svg" @click="bpClick">
          <image :href="bp.img" x="0" y="0" :width="bp.w" :height="bp.h"></image>
          <template v-if="bp.rooms">
            <polygon v-for="r in bp.rooms" :key="r.id" :data-bp="r.id" :points="polyPts(r.poly)"
                     :class="['bp__room', { 'bp__room--off': !r.on, 'bp__room--sel': bp.sel === r.id, 'bp__room--sens': isSensitive(r.purpose) }]"></polygon>
            <text v-for="r in bp.rooms" :key="'t' + r.id" class="bp__label" :x="r.lx" :y="r.ly + bpFont * 0.35" :font-size="bpFont" text-anchor="middle">{{ r.id }} · {{ fmt(r.area) }} м²</text>
          </template>
          <line v-if="bp.pts.length === 2" class="bp__ruler" :x1="bp.pts[0][0]" :y1="bp.pts[0][1]" :x2="bp.pts[1][0]" :y2="bp.pts[1][1]" :stroke-width="bpFont / 4"></line>
          <circle v-for="(p, i) in bp.pts" :key="'p' + i" class="bp__pt" :cx="p[0]" :cy="p[1]" :r="bpFont / 2"></circle>
        </svg>
      </div>
      <div class="bp__start" v-else>
        <p>Сфотографируйте план эвакуации этажа или загрузите план из техпаспорта. Помещения и их площади найдутся сами — на этом устройстве, без интернета.</p>
        <p class="hint">Снимайте прямо, чтобы план был целиком в кадре.</p>
        <div class="bp__actions">
          <label class="btn btn--primary">Выбрать фото или картинку<input type="file" accept="image/*" class="sr" data-test="bp-file" @change="pickBpFile"></label>
          <button type="button" class="btn" data-test="bp-example" @click="loadBpExample">Пример: план школы</button>
        </div>
        <p class="bp__error" v-if="bp.error">{{ bp.error }}</p>
      </div>
      <div class="bp__panel" v-if="bp.img">
        <template v-if="!bp.rooms">
          <h3>Масштаб</h3>
          <p class="hint">{{ bp.pts.length === 1 ? 'Нажмите на второй конец' : 'Нажмите на плане на два конца стены или линейки известной длины и укажите её. Или введите общую площадь этажа.' }}</p>
          <div class="bp__row">
            <label class="field"><span>Длина отрезка, м</span><input type="number" min="0" step="any" inputmode="decimal" v-model="bp.lenM" data-test="bp-len" :disabled="bp.pts.length < 2"></label>
            <span class="bp__or">или</span>
            <label class="field"><span>Площадь этажа, м²</span><input type="number" min="0" step="any" inputmode="decimal" v-model="bp.areaM2" data-test="bp-area"></label>
          </div>
          <div class="bp__actions">
            <button type="button" class="btn btn--primary" data-test="bp-run" :disabled="!bpReady || bp.busy" @click="runBp">{{ bp.busy ? 'Ищу помещения…' : 'Найти помещения' }}</button>
            <button type="button" class="btn btn--quiet" v-if="bp.pts.length" @click="bp.pts = []">Сбросить точки</button>
          </div>
        </template>
        <template v-else>
          <h3 data-test="bp-found">Найдено помещений: {{ bpOn.length }} · {{ fmt(bpArea) }} м²</h3>
          <p class="hint">Проверьте назначение: серверной, щитовой, складу укажите своё — или впишите имя, назначение подставится. Лишнее снимите галочкой. Нажмите на помещение на плане — оно выделится в списке.</p>
          <div class="bp__list">
            <div v-for="r in bp.rooms" :key="r.id" :data-bp-item="r.id" :class="['bp__item', { 'bp__item--sel': bp.sel === r.id, 'bp__item--off': !r.on }]">
              <input type="checkbox" v-model="r.on" :aria-label="'Учитывать помещение ' + r.id">
              <span class="bp__no">{{ r.id }}</span>
              <input type="text" class="bp__name" v-model.trim="r.name" :placeholder="shortName(r.purpose)" :aria-label="'Имя помещения ' + r.id" @change="bpName(r)" @focus="bp.sel = r.id">
              <select v-model="r.purpose" :aria-label="'Назначение помещения ' + r.id" @change="r.purposeSet = true" @focus="bp.sel = r.id">
                <optgroup v-for="g in areaPurposeGroups" :key="g.group" :label="g.group">
                  <option v-for="p in g.items" :key="p.id" :value="p.id">{{ p.label }}</option>
                </optgroup>
              </select>
              <span class="bp__area">{{ fmt(r.area) }} м²</span>
            </div>
          </div>
          <div class="bp__actions">
            <button type="button" class="btn" data-test="bp-back" @click="bp.rooms = null">Изменить масштаб</button>
            <button type="button" class="btn btn--primary" data-test="bp-apply" :disabled="!bpOn.length" @click="applyBp">Применить к этажу</button>
          </div>
          <p class="hint">Распознано за {{ bp.ms }} мс на этом устройстве.</p>
        </template>
        <p class="bp__error" v-if="bp.error">{{ bp.error }}</p>
      </div>
    </div>
  </div>
</div>

<div class="toast" v-if="notice" role="status">
  <span>{{ notice }}</span>
  <button type="button" class="toast__undo" data-test="undo" v-if="undoFn" @click="undo">Отменить</button>
</div>

<footer class="bar">
  <div class="bar__in">
    <div class="bar__sum"><span class="bar__label">Требуется по нормам</span><b>{{ totalsLine }}</b></div>
    <button type="button" class="btn btn--primary" v-if="tab === 'input'" @click="go('result')">К результату</button>
    <button type="button" class="btn btn--primary" v-else :disabled="!result.totals.length" @click="openPdf">Скачать PDF</button>
  </div>
</footer>
`;

  const PLAN_VIEWS = [
    { id: 'fact', label: 'Как есть', hint: 'Огнетушители, которые стоят на объекте: отметьте их нажатием' },
    { id: 'want', label: 'По нормам', hint: 'Расстановка, которую даёт расчёт' }
  ];
  const PLAN_MODES = [
    { id: 'op', label: '+ ОП', hint: 'Нажатие отмечает порошковый огнетушитель' },
    { id: 'ou', label: '+ ОУ', hint: 'Нажатие отмечает углекислотный огнетушитель' },
    { id: 'move', label: 'Двигать', hint: 'Перетаскивание помещений и огнетушителей' }
  ];
  const DEFAULT_STEP = 0.75; // м, средняя длина шага
  const MAX_QR_LINK = 1000;  // знаков: длиннее — QR-код в отчёте получается слишком мелким для камеры
  const EMPTY_SCENE = { rects: [], ext: [], cover: { per: {}, bad: 0, total: 0, share: 0 }, box: PL.bbox([]), limits: '', marked: false, findings: [] };

  const stored = loadStore();
  const firstObjects = stored ? stored.objects : [blankObject('')];

  const app = Vue.createApp({
    template: TEMPLATE,
    data: function () {
      return {
        objects: firstObjects,
        currentId: stored && stored.currentId ? stored.currentId : firstObjects[0].id,
        options: Object.assign({}, E.DEFAULT_OPTIONS, stored && stored.options ? stored.options : {}),
        ui: Object.assign({ steps: false, step: DEFAULT_STEP }, stored && stored.ui ? stored.ui : {}),
        planMode: 'op',
        planSize: {},   // размеры схем на экране, px: { id этажа: [ширина, высота] }
        drag: null,     // перетаскивание на схеме
        linkDialog: '', // ссылка на расчёт, если её не удалось скопировать автоматически
        bp: null,       // окно «План этажа»: картинка, масштаб, найденные помещения
        bpImages: {},   // картинки планов, уже прочитанные из хранилища: ключ → data URL
        offline: typeof navigator !== 'undefined' && navigator.onLine === false,
        swReady: false,
        tab: 'input',
        open: {},
        openRoom: '',
        menuOpen: false,
        pdfDialog: false,
        notice: '',
        undoFn: null,
        pdfBusy: false,
        selfcheck: '',
        iconCopy: ICON_COPY,
        iconTrash: ICON_TRASH
      };
    },
    computed: {
      current: function () {
        const id = this.currentId;
        return this.objects.filter(function (o) { return o.id === id; })[0] || this.objects[0];
      },
      building: function () { return this.current.building; },
      floors: function () { return this.current.floors; },
      kinds: function () { return P.BUILDING_KINDS; },
      purposeGroups: function () { return P.PURPOSE_GROUPS; },
      examples: function () { return P.EXAMPLES; },
      sources: function () { return N.SOURCES; },
      categories: function () {
        return Object.keys(N.CATEGORIES).map(function (id) {
          const c = N.CATEGORIES[id];
          return {
            id: id,
            label: id === 'PUB' ? 'Общественное' : c.label,
            short: id === 'PUB' ? 'Общ.' : c.label, // для узкого поля в строке
            long: id === 'PUB' ? 'Общественное (без категории)' : c.label + ' — ' + c.name,
            title: c.name
          };
        });
      },
      fireClasses: function () {
        return Object.keys(N.FIRE_CLASSES).map(function (id) { return { id: id, name: N.FIRE_CLASSES[id].name }; });
      },
      kind: function () {
        const id = this.building.kind;
        return P.BUILDING_KINDS.filter(function (x) { return x.id === id; })[0] || P.BUILDING_KINDS[0];
      },
      quick: function () { return this.kind.quick; },
      planViews: function () { return PLAN_VIEWS; },
      // окно «План этажа»
      areaPurposeGroups: function () { return P.PURPOSE_GROUPS.filter(function (g) { return !g.items.some(function (p) { return p.t5; }); }); },
      bpFloorName: function () { return this.bp ? (this.floorById(this.bp.floorId).name || '') : ''; },
      bpFont: function () { return this.bp ? Math.max(12, Math.round(this.bp.w / 85)) : 12; },
      bpOn: function () { return this.bp && this.bp.rooms ? this.bp.rooms.filter(function (r) { return r.on; }) : []; },
      bpArea: function () { return Math.round(this.bpOn.reduce(function (s, r) { return s + r.area * 10; }, 0)) / 10; },
      bpReady: function () {
        const bp = this.bp;
        return !!bp && !!bp.img && ((bp.pts.length === 2 && toNum(bp.lenM) > 0) || toNum(bp.areaM2) > 0);
      },
      planModes: function () { return PLAN_MODES; },
      // Исходные данные для расчёта и схемы. Если имя помещения не введено, оно называется по назначению.
      input: function () {
        const floors = this.floors.map(function (f) {
          return Object.assign({}, f, {
            rooms: f.rooms.map(function (r) { return Object.assign({}, r, { fallbackName: P.shortName(r.purpose) }); })
          });
        });
        return { building: this.building, floors: floors };
      },
      result: function () { return E.calculate(this.input, this.options); },
      // Схемы этажей с отмеченными огнетушителями и перечень нарушений.
      audit: function () { return PL.audit(this.input, this.result); },
      // Что показывает схема каждого этажа: отмеченное («как есть») или расстановку по расчёту.
      scenes: function () {
        const map = {}, self = this;
        this.audit.floors.forEach(function (fa, i) {
          const floor = self.floors[i];
          const want = floor && floor.plan.open && floor.plan.view === 'want';
          map[fa.id] = want ? PL.scene(fa.rects, PL.propose(fa.rects, self.result.floors[i])) : fa;
        });
        return map;
      },
      planFloors: function () { return this.result.floors.filter(function (f) { return f.fromPlan; }).length; },
      verdictBad: function () { return !!this.result.check && (!this.result.check.ok || this.audit.status === 'bad'); },
      verdictText: function () {
        const c = this.result.check;
        if (!c) return '';
        return c.ok && this.audit.status === 'bad' ? 'Количество достаточное, но есть нарушения по размещению.' : c.text;
      },
      checkFloors: function () { return this.result.floors.filter(function (f) { return f.units.length; }); },
      extTotal: function () { return this.result.summary.portable + this.result.summary.wheeled; },
      methodology: function () { return E.methodology(this.options, this.building); },
      kindHint: function () {
        return this.building.kind === 'public'
          ? 'В общественном здании на каждом этаже нужно не менее двух огнетушителей (п. 5), а до огнетушителя должно быть не более 20 м (п. 4)'
          : 'В производственном и складском здании норма зависит от категории помещения (А–Д) и класса пожара, до огнетушителя не более 30, 40 или 70 м (п. 4)' +
            (this.options.floorMinAll ? '; на каждом этаже считается не менее двух огнетушителей' : '');
      },
      totalsLine: function () {
        if (!this.result.totals.length) return 'пока нет данных';
        return this.result.totals.map(function (t) { return t.count + ' × ' + t.code + (t.charge === 'D' ? ' (D)' : ''); }).join(' · ');
      },
      summaryLine: function () {
        const s = this.result.summary;
        const parts = [s.portable + ' ' + E.plural(s.portable, 'переносной', 'переносных', 'переносных')];
        if (s.wheeled) parts.push(s.wheeled + ' ' + E.plural(s.wheeled, 'передвижной', 'передвижных', 'передвижных'));
        if (s.shields) parts.push(s.shields + ' ' + E.plural(s.shields, 'пожарный щит', 'пожарных щита', 'пожарных щитов'));
        parts.push(s.rooms + ' ' + E.plural(s.rooms, 'помещение', 'помещения', 'помещений'));
        parts.push(E.fmt(s.area) + ' м²');
        parts.push(s.floors + ' ' + E.plural(s.floors, 'этаж', 'этажа', 'этажей'));
        return parts.join(' · ');
      }
    },
    watch: {
      objects: { deep: true, handler: function () { this.save(); } },
      options: { deep: true, handler: function () { this.save(); } },
      ui: { deep: true, handler: function () { this.save(); } },
      currentId: function () { this.save(); },
      tab: function (value) {
        window.scrollTo(0, 0);
        if (value === 'result') ensurePdf().catch(function () { /* сообщим при скачивании */ });
      }
    },
    methods: {
      fmt: E.fmt,
      plural: E.plural,
      lineTitle: E.lineTitle,
      shortName: P.shortName,
      go: function (tab) { this.tab = tab === 'result' ? 'result' : 'input'; },

      // ----- уведомления и отмена -----
      say: function (text, undoFn) {
        const self = this;
        this.notice = text;
        this.undoFn = undoFn || null;
        clearTimeout(this._noticeTimer);
        this._noticeTimer = setTimeout(function () { self.notice = ''; self.undoFn = null; }, undoFn ? 8000 : 3500);
      },
      undo: function () {
        const fn = this.undoFn;
        this.notice = '';
        this.undoFn = null;
        clearTimeout(this._noticeTimer);
        if (fn) fn();
      },
      save: function () {
        const self = this;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(function () {
          try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify({ version: 2, currentId: self.current.id, objects: self.objects, options: self.options, ui: self.ui }));
          } catch (e) { /* хранилище недоступно — работаем без сохранения */ }
        }, 250);
      },

      // ----- объекты -----
      isBlank: function (o) {
        if (o.building.name) return false;
        return !o.floors.some(function (f) { return f.rooms.some(function (r) { return r.name || toNum(r.area); }); });
      },
      select: function (id) {
        this.currentId = id;
        this.open = {};
        this.menuOpen = false;
        this.openFirstRoomIfBlank();
      },
      // На телефоне строки свёрнуты; в пустом расчёте первая строка сразу раскрыта для ввода.
      openFirstRoomIfBlank: function () {
        const first = this.floors[0] && this.floors[0].rooms[0];
        this.openRoom = first && this.isBlank(this.current) ? first.id : '';
      },
      objectName: function (o) { return o.building.name || 'Без названия'; },
      objectMeta: function (o) {
        let rooms = 0;
        o.floors.forEach(function (f) { f.rooms.forEach(function (r) { if (toNum(r.area) || r.t5) rooms += Math.max(1, Math.round(toNum(r.count)) || 1); }); });
        return rooms + ' пом. · ' + R.formatDate(o.building.date);
      },
      newObject: function () {
        this.menuOpen = false;
        if (this.isBlank(this.current)) {
          this.go('input');
          this.say('Этот расчёт ещё пуст — можно начинать');
        } else {
          const o = blankObject(this.building.inspector);
          this.objects.unshift(o);
          this.select(o.id);
          this.go('input');
        }
        this.focusTitle();
      },
      openObject: function (id) {
        this.select(id);
        this.go('input');
      },
      removeObject: function (id) {
        const self = this;
        const index = this.objects.map(function (o) { return o.id; }).indexOf(id);
        if (index < 0) return;
        const removed = this.objects.splice(index, 1)[0];
        const wasCurrent = this.currentId === id;
        if (!this.objects.length) this.objects.push(blankObject(removed.building.inspector));
        if (wasCurrent) this.select(this.objects[Math.min(index, this.objects.length - 1)].id);
        this.menuOpen = true;
        this.say('Объект «' + this.objectName(removed) + '» удалён', function () {
          self.objects.splice(Math.min(index, self.objects.length), 0, removed);
          if (wasCurrent) self.select(removed.id);
        });
      },
      loadExample: function (key) {
        const existing = this.objects.filter(function (o) { return o.example === key; })[0];
        if (existing) {
          this.select(existing.id);
        } else {
          const o = adoptObject(P.EXAMPLES[key].build());
          o.example = key;
          o.building.inspector = this.building.inspector;
          // пустой текущий расчёт заменяется примером, чтобы не копить пустые объекты
          if (this.isBlank(this.current)) this.objects.splice(this.objects.indexOf(this.current), 1, o);
          else this.objects.unshift(o);
          this.select(o.id);
        }
        this.go('input');
        this.say('Открыт пример: ' + P.EXAMPLES[key].title);
      },
      focusTitle: function () {
        this.$nextTick(function () {
          const el = document.querySelector('.title');
          if (el && window.matchMedia('(min-width: 761px)').matches) el.focus();
        });
      },

      // ----- этажи и помещения -----
      addFloor: function () { this.floors.push(newFloor(this.nextFloorNumber(), this.kind.purpose)); },
      nextFloorNumber: function () {
        let max = 0;
        this.floors.forEach(function (f) { const m = /^(\d+)/.exec(f.name || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); });
        return Math.max(max, this.floors.length) + 1;
      },
      removeFloor: function (i) {
        const floors = this.floors;
        if (floors.length <= 1) return;
        const removed = floors.splice(i, 1)[0];
        this.say('Этаж «' + removed.name + '» удалён', function () { floors.splice(Math.min(i, floors.length), 0, removed); });
      },
      duplicateFloor: function (i) {
        const copy = clone(this.floors[i]);
        const m = /^(\d+)(.*)$/.exec(copy.name || '');
        const idMap = {};
        copy.id = uid('f');
        copy.name = m ? this.nextFloorNumber() + m[2] : (copy.name || 'Этаж') + ' (копия)';
        copy.installedOP = '';
        copy.installedOU = '';
        copy.rooms.forEach(function (r) { const id = uid('r'); idMap[r.id] = id; r.id = id; });
        // расположение помещений копируется, отметки огнетушителей — нет: факт у каждого этажа свой
        copy.plan = adoptPlan({ open: copy.plan && copy.plan.open, pos: copy.plan && copy.plan.pos }, idMap);
        this.floors.splice(i + 1, 0, copy);
        this.say('Этаж скопирован: ' + copy.name);
      },
      // Добавляет помещение (в конец или после строки index) и ставит курсор в нужное поле.
      addRoom: function (floor, purpose, index, focusField) {
        const room = newRoom(purpose || this.kind.purpose);
        if (index === undefined || index === null) floor.rooms.push(room);
        else floor.rooms.splice(index + 1, 0, room);
        this.openRoom = room.id;
        this.focusRoom(room.id, focusField || 'area');
        return room;
      },
      // Enter в площади или количестве: следующая строка того же назначения.
      // Если инспектор называет помещения, курсор встаёт в имя, иначе сразу в площадь.
      addAfter: function (floor, ri) {
        const cur = floor.rooms[ri];
        this.addRoom(floor, cur.purpose, ri, cur.name ? 'name' : 'area');
      },
      focusRoom: function (id, field) {
        this.$nextTick(function () {
          const row = document.querySelector('[data-room="' + id + '"]');
          const el = row && (row.querySelector('.f-' + field + ' input:not(:disabled)') || row.querySelector('.f-name input'));
          if (el) el.focus();
        });
      },
      removeRoom: function (floor, i) {
        const removed = floor.rooms.splice(i, 1)[0];
        this.say('Помещение «' + (removed.name || P.shortName(removed.purpose)) + '» удалено', function () {
          floor.rooms.splice(Math.min(i, floor.rooms.length), 0, removed);
        });
      },
      duplicateRoom: function (floor, i) {
        const copy = clone(floor.rooms[i]);
        copy.id = uid('r');
        delete copy.bp; // контур на плане один — у копии его нет
        floor.rooms.splice(i + 1, 0, copy);
        this.openRoom = copy.id;
      },
      // Назначение, выбранное из списка, по имени помещения больше не меняется.
      onPurpose: function (room) { P.applyPurpose(room, room.purpose); room.purposeSet = true; },
      // Назначение по имени: «Серверная» становится серверной (углекислотный огнетушитель),
      // если назначение не выбрано из списка вручную. Изменение можно отменить.
      onName: function (room) {
        if (room.purposeSet || room.t5) return;
        const guess = P.guessPurpose(room.name);
        if (!guess || guess === room.purpose) return;
        const before = { purpose: room.purpose, t5: room.t5, t5Alt: room.t5Alt, category: room.category,
          classes: room.classes.slice(), sensitive: room.sensitive, forceType: room.forceType };
        P.applyPurpose(room, guess);
        this.say('«' + room.name + '»: назначение по имени — ' + P.BY_ID[guess].label, function () {
          Object.assign(room, before);
          room.purposeSet = true;
        });
      },
      toggleClass: function (room, k) {
        const i = room.classes.indexOf(k);
        if (i >= 0) room.classes.splice(i, 1); else room.classes.push(k);
        room.forceType = '';
      },
      needsArea: function (room) {
        if (!room.t5) return true;
        const basis = N.TABLE5[room.t5].basis;
        return basis === 'per100' || basis === 'upTo100';
      },
      // Площадь подсвечивается, когда строку уже заполняли или пошли дальше, а площадь не ввели.
      areaMissing: function (floor, room, ri) {
        if (!this.needsArea(room) || toNum(room.area)) return false;
        return !!room.name || ri < floor.rooms.length - 1 || toNum(room.count) > 1;
      },
      normSummary: function (room) {
        const parts = [];
        if (room.t5) parts.push('табл. 5');
        else {
          if (this.building.kind === 'public') parts.push(room.category === 'PUB' ? 'Общественное' : N.CATEGORIES[room.category].label);
          parts.push(room.classes.length ? room.classes.slice().sort().join(', ') : 'класс не выбран');
          if (room.sensitive) parts.push('электроника');
          if (toNum(room.length) && toNum(room.width)) parts.push(E.fmt(room.length) + ' × ' + E.fmt(room.width) + ' м');
        }
        if (room.autoSuppression && !this.building.autoSuppressionAll) parts.push('АУПТ');
        return parts.join(' · ');
      },
      roomMeta: function (room) {
        const parts = [];
        if (this.needsArea(room)) parts.push(toNum(room.area) ? E.fmt(room.area) + ' м²' : 'нет площади');
        if (toNum(room.count) > 1) parts.push('× ' + Math.round(toNum(room.count)));
        return parts.join(' ');
      },
      // Площадь подставляется по размерам, пока её не ввели вручную.
      onDims: function (room) {
        const L = toNum(room.length), W = toNum(room.width);
        if (!(L && W)) return;
        const area = Math.round(L * W * 100) / 100;
        if (!toNum(room.area) || toNum(room.area) === room.autoArea) { room.area = area; room.autoArea = area; }
      },
      // Замер шагами: шаги переводятся в метры по длине шага.
      onSteps: function (room) {
        const step = toNum(this.ui.step) || DEFAULT_STEP;
        if (toNum(room.stepsL)) room.length = Math.round(toNum(room.stepsL) * step * 10) / 10;
        if (toNum(room.stepsW)) room.width = Math.round(toNum(room.stepsW) * step * 10) / 10;
        this.onDims(room);
      },
      dimsMismatch: function (room) {
        const L = toNum(room.length), W = toNum(room.width), S = toNum(room.area);
        if (!(L && W && S) || room.bp) return ''; // у помещения с плана длина и ширина — по рамке контура
        if (!(L && W && S)) return '';
        return Math.abs(L * W - S) / S > 0.1 ? E.fmt(L * W) : '';
      },
      countOf: function (room) { return Math.max(1, Math.round(toNum(room.count)) || 1); },
      floorArea: function (floor) {
        const self = this;
        return floor.rooms.reduce(function (s, r) { return s + toNum(r.area) * self.countOf(r); }, 0);
      },
      floorRooms: function (floor) {
        const self = this;
        return floor.rooms.reduce(function (s, r) { return s + self.countOf(r); }, 0);
      },
      floorById: function (id) {
        return this.floors.filter(function (f) { return f.id === id; })[0] || {};
      },
      resultFloor: function (id) {
        return this.result.floors.filter(function (f) { return f.id === id; })[0] || null;
      },
      floorNeed: function (id) {
        const f = this.resultFloor(id);
        if (!f || !f.units.length) return '—';
        const sum = {}, order = [];
        f.units.forEach(function (u) {
          u.lines.forEach(function (l) {
            if (sum[l.code] === undefined) { sum[l.code] = 0; order.push(l.code); }
            sum[l.code] += l.count;
          });
        });
        return order.length ? order.map(function (c) { return sum[c] + ' × ' + c; }).join(', ') : 'не требуется';
      },

      // ----- результат -----
      floorSummary: function (f) {
        const p = f.portable, n = p.powder + p.co2 + p.other;
        const parts = [n + ' ' + E.plural(n, 'переносной', 'переносных', 'переносных')];
        if (f.wheeled) parts.push(f.wheeled + ' ' + E.plural(f.wheeled, 'передвижной', 'передвижных', 'передвижных'));
        return parts.join(' · ');
      },
      unitMeta: function (u) {
        if (u.kind === 'floorMin') {
          return u.byRules ? 'п. 5: не менее двух огнетушителей на этаже общественного здания' : 'не менее двух огнетушителей на этаже — параметр расчёта';
        }
        const parts = [];
        if (u.pooled) parts.push(u.roomCount + ' ' + E.plural(u.roomCount, 'помещение', 'помещения', 'помещений'));
        if (u.areaLabel) parts.push(u.areaLabel + ' м²');
        if (u.kind === 'table5') parts.push('табл. 5');
        else if (u.kind === 'exempt') parts.push('категория Д, менее 100 м²');
        else {
          parts.push(u.category === 'PUB' ? 'общественное' : 'категория ' + u.categoryLabel);
          parts.push((u.classes.length > 1 ? 'классы ' : 'класс ') + u.classes.join(', '));
        }
        return parts.join(' · ');
      },
      // Строка нормативной таблицы: подпись и оформление ячеек.
      matrixMixed: function (u) {
        const rows = u.matrix.rows;
        return rows.some(function (r) { return r.fallback || r.area !== rows[0].area; });
      },
      matrixCaption: function (u) {
        if (this.matrixMixed(u)) return 'Табл. 1 · число огнетушителей на предельную площадь';
        return 'Табл. 1 · ' + u.matrix.rows[0].rowTitle + ' · на ' + u.matrix.rows[0].area + ' м²';
      },
      cellClass: function (c) {
        if (c.chosen) return 'on';
        if (c.mark === '-') return 'no';
        return c.mark === '++' ? 'rec' : 'ok';
      },
      toggle: function (id) { this.open[id] = !this.open[id]; },
      floorOpen: function (f) {
        const open = this.open;
        return f.units.length > 0 && f.units.every(function (u) { return open[u.id]; });
      },
      toggleFloor: function (f) {
        const value = !this.floorOpen(f), open = this.open;
        f.units.forEach(function (u) { open[u.id] = value; });
      },
      findRoom: function (id) {
        for (let i = 0; i < this.floors.length; i++) {
          for (let j = 0; j < this.floors[i].rooms.length; j++) {
            if (this.floors[i].rooms[j].id === id) return this.floors[i].rooms[j];
          }
        }
        return null;
      },
      isForced: function (u) { return u.lines.some(function (l) { return l.forced; }); },
      force: function (u, typeId) {
        const self = this;
        u.rooms.forEach(function (r) { const room = self.findRoom(r.id); if (room) room.forceType = typeId; });
      },
      swapT5: function (u) {
        const room = this.findRoom(u.rooms[0].id);
        if (room) room.t5Alt = room.t5Alt ? 0 : 1;
      },

      // ----- схема этажа -----
      sceneOf: function (floor) { return this.scenes[floor.id] || EMPTY_SCENE; },
      factOf: function (floor) {
        return this.audit.floors.filter(function (f) { return f.id === floor.id; })[0] || EMPTY_SCENE;
      },
      // «По нормам» ничего не отмечают — только двигают помещения.
      modeOf: function (floor) { return floor.plan.view === 'want' ? 'move' : this.planMode; },
      // Пока что-то тащат, поле зрения не пересчитывается — иначе схема уезжает из-под пальца.
      viewOf: function (floor) {
        const d = this.drag;
        return d && d.floorId === floor.id ? d.view : PL.view(this.sceneOf(floor).box);
      },
      viewBox: function (floor) { const v = this.viewOf(floor); return [v.x, v.y, v.w, v.h].join(' '); },
      viewRatio: function (floor) { const v = this.viewOf(floor); return v.w + ' / ' + v.h; },
      // Сколько метров схемы занимают n пикселей экрана: метки и подписи не зависят от масштаба.
      px: function (floor, n) {
        const v = this.viewOf(floor), s = this.planSize[floor.id];
        const scale = s && s[0] > 0 && s[1] > 0 ? Math.min(s[0] / v.w, s[1] / v.h) : 600 / v.w;
        return Math.round(n / scale * 1000) / 1000;
      },
      measurePlans: function () {
        const size = {}, old = this.planSize;
        let changed = false;
        Array.prototype.forEach.call(document.querySelectorAll('.plan__svg'), function (el) {
          const id = el.getAttribute('data-floor'), box = el.getBoundingClientRect();
          size[id] = [Math.round(box.width), Math.round(box.height)];
          if (!old[id] || old[id][0] !== size[id][0] || old[id][1] !== size[id][1]) changed = true;
        });
        if (changed || Object.keys(size).length !== Object.keys(old).length) this.planSize = size;
      },
      // Места дальше нормы. Пока ничего не отмечено, красным ничего не закрашивается.
      planGaps: function (floor) { return PL.gaps(this.sceneOf(floor)); },
      planLabels: function (floor) {
        const size = this.px(floor, 11), pad = this.px(floor, 5), out = [];
        this.sceneOf(floor).rects.forEach(function (r) {
          const max = Math.floor((r.w - 2 * pad) / (size * 0.58));
          if (r.h < size * 1.5 || max < 3) return;
          const text = r.name.length <= max ? r.name : r.name.slice(0, max - 1) + '…';
          // помещение с плана подписывается в самой просторной точке, остальные — в левом верхнем углу
          if (r.poly) out.push({ key: r.key, x: r.lx, y: r.ly + size * 0.35, size: size, text: text, anchor: 'middle' });
          else out.push({ key: r.key, x: r.x + pad, y: r.y + pad + size * 0.8, size: size, text: text, anchor: 'start' });
        });
        return out;
      },
      polyPts: function (poly) { return poly.map(function (p) { return p[0] + ',' + p[1]; }).join(' '); },
      isSensitive: function (purpose) { return !!(P.BY_ID[purpose] && P.BY_ID[purpose].sensitive); },
      // Картинка плана под схемой этажа (читается из хранилища при первом показе).
      bgOf: function (floor) {
        const bp = PL.blueprintOf(floor);
        if (!bp || !bp.img) return null;
        const src = this.bpImages[bp.img], self = this;
        if (src === undefined) {
          this._bgLoading = this._bgLoading || {};
          if (!this._bgLoading[bp.img]) {
            this._bgLoading[bp.img] = true;
            IMG.get(bp.img).then(function (v) { self.bpImages[bp.img] = v || ''; }, function () { self.bpImages[bp.img] = ''; });
          }
          return null;
        }
        return src ? { src: src, w: bp.w / bp.scale, h: bp.h / bp.scale } : null;
      },
      planStat: function (floor) {
        const fa = this.factOf(floor);
        if (!fa.marked) return '';
        const n = PL.tally(fa);
        return 'Отмечено: ОП ' + n.op + ' · ОУ ' + n.ou + (n.other ? ' · других ' + n.other : '') + ' · ' +
          (fa.cover.bad > 0 ? 'дальше нормы ' + Math.max(1, Math.round(fa.cover.share * 100)) + ' % площади' : 'расстояние в норме');
      },
      planHint: function (floor) {
        const sc = this.sceneOf(floor);
        const approx = (sc.rects.some(function (r) { return r.approx; }) ? ' Пунктир — размеры помещения не заданы, форма условная.' : '') +
          (this.factOf(floor).skipped ? ' На схеме показаны первые ' + PL.MAX_RECTS + ' помещений этажа.' : '');
        const reach = sc.limits ? ' Круг — ' + sc.limits + ' по прямой, красным — дальше нормы.' : '';
        if (floor.plan.view === 'want') {
          const extra = sc.ext.filter(function (e) { return e.extra; }).length;
          const fr = this.resultFloor(floor.id);
          return 'Расстановка по расчёту: ' + sc.ext.length + ' ' + E.plural(sc.ext.length, 'огнетушитель', 'огнетушителя', 'огнетушителей') +
            (extra ? ', из них ' + extra + ' — по расстоянию (п. 4)' : '') + '.' +
            (fr && fr.wheeled ? ' Передвижные (' + fr.wheeled + ') на схеме не показаны.' : '') +
            ' В PDF попадает как предлагаемая схема.' +
            (floor.blueprint ? ' Помещения — по загруженному плану.' : ' Помещения можно перетаскивать.') + approx;
        }
        if (this.planMode === 'move') {
          return (floor.blueprint ? 'Помещения стоят по загруженному плану. Огнетушители можно перетаскивать.' : 'Перетащите помещения так, как они стоят на этаже. Огнетушители тоже двигаются.') + approx;
        }
        return 'Нажмите на помещение — отметится огнетушитель, который там стоит. Нажмите на него ещё раз — уберётся.' + reach + approx;
      },
      extTitle: function (e) {
        return (e.code || (e.t === 'op' ? 'ОП, порошковый' : (e.t === 'ou' ? 'ОУ, углекислотный' : 'другой'))) + ' · ' + e.rect.name;
      },
      // Точка нажатия в метрах схемы.
      planPoint: function (svg, ev) {
        const m = svg.getScreenCTM && svg.getScreenCTM();
        if (!m) return null;
        const pt = svg.createSVGPoint();
        pt.x = ev.clientX;
        pt.y = ev.clientY;
        const p = pt.matrixTransform(m.inverse());
        return { x: p.x, y: p.y };
      },
      planClick: function (floor, ev) {
        if (this._dragged) return;
        if (floor.plan.view !== 'fact') { this.say('Это расстановка по расчёту. Отмечать огнетушители — в режиме «Как есть»'); return; }
        if (this.planMode === 'move') return;
        const mark = ev.target.closest ? ev.target.closest('[data-ext]') : null;
        if (mark) { this.removeExt(floor, mark.getAttribute('data-ext')); return; }
        const p = this.planPoint(ev.currentTarget, ev);
        const rect = p && PL.at(this.sceneOf(floor).rects, p.x, p.y);
        if (!rect) { this.say('Нажмите внутри помещения'); return; }
        floor.plan.ext.push({ id: uid('e'), k: rect.key, u: unit((p.x - rect.x) / rect.w), v: unit((p.y - rect.y) / rect.h), t: this.planMode, code: '' });
        if (this.planMode === 'op' && rect.sensitive) this.say('«' + rect.name + '»: порошковый в помещении с электроникой — нарушение');
      },
      removeExt: function (floor, id) {
        const list = floor.plan.ext;
        const i = list.map(function (e) { return e.id; }).indexOf(id);
        if (i < 0) return;
        const removed = list.splice(i, 1)[0];
        this.say('Огнетушитель убран со схемы', function () { list.splice(Math.min(i, list.length), 0, removed); });
      },
      clearExt: function (floor) {
        const plan = floor.plan, prev = plan.ext;
        plan.ext = [];
        this.say('Отметки убраны', function () { plan.ext = prev; });
      },
      resetLayout: function (floor) {
        const plan = floor.plan, prev = plan.pos;
        plan.pos = null;
        this.say('Помещения расставлены заново', function () { plan.pos = prev; });
      },
      planDown: function (floor, ev) {
        if (this.modeOf(floor) !== 'move') return;
        const svg = ev.currentTarget, p = this.planPoint(svg, ev), sc = this.sceneOf(floor);
        if (!p) return;
        const mark = floor.plan.view === 'fact' && ev.target.closest ? ev.target.closest('[data-ext]') : null;
        let drag = null;
        if (mark) {
          const id = mark.getAttribute('data-ext');
          const e = floor.plan.ext.filter(function (x) { return x.id === id; })[0];
          if (e) drag = { kind: 'ext', e: e };
        } else {
          const key = ev.target.getAttribute ? ev.target.getAttribute('data-key') : '';
          const r = sc.rects.filter(function (x) { return x.key === key; })[0];
          // помещения с загруженного плана стоят на своих местах
          if (r && !r.fixed) drag = { kind: 'room', key: key, ox: r.x, oy: r.y, froze: !floor.plan.pos };
        }
        if (!drag) return;
        drag.floorId = floor.id;
        drag.sx = p.x;
        drag.sy = p.y;
        drag.view = PL.view(sc.box);
        drag.moved = false;
        // первое перетаскивание закрепляет расположение всех помещений
        if (drag.froze) floor.plan.pos = PL.freeze(sc.rects);
        this.drag = drag;
        try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* не страшно: перетаскивание работает и без захвата */ }
        ev.preventDefault();
      },
      planMove: function (floor, ev) {
        const d = this.drag;
        if (!d || d.floorId !== floor.id) return;
        const p = this.planPoint(ev.currentTarget, ev);
        if (!p) return;
        if (Math.abs(p.x - d.sx) + Math.abs(p.y - d.sy) > this.px(floor, 4)) d.moved = true;
        if (!d.moved) return;
        if (d.kind === 'room') {
          floor.plan.pos[d.key] = [d.ox + p.x - d.sx, d.oy + p.y - d.sy];
        } else {
          const r = PL.at(this.factOf(floor).rects, p.x, p.y);
          if (r) { d.e.k = r.key; d.e.u = unit((p.x - r.x) / r.w); d.e.v = unit((p.y - r.y) / r.h); }
        }
      },
      planUp: function (floor) {
        const d = this.drag, self = this;
        if (!d) return;
        if (d.kind === 'room') {
          if (d.moved) {
            const cur = floor.plan.pos[d.key];
            floor.plan.pos[d.key] = PL.snap(this.factOf(floor).rects, d.key, cur[0], cur[1]);
          } else if (d.froze) {
            floor.plan.pos = null;
          }
        }
        this.drag = null;
        if (d.moved) {
          // нажатие, которым закончилось перетаскивание, ничего не отмечает
          this._dragged = true;
          setTimeout(function () { self._dragged = false; }, 0);
        }
      },

      // ----- план этажа по картинке -----
      openBp: function (floor) {
        const self = this;
        this.bp = { floorId: floor.id, img: '', imgKey: '', w: 0, h: 0, pts: [], lenM: '', areaM2: '', busy: false, rooms: null, sel: null, error: '', scale: 0, ms: 0 };
        this._bpPixels = null;
        // план уже загружен — открывается с ним, масштаб прежний
        const old = PL.blueprintOf(floor);
        if (old && old.img) {
          IMG.get(old.img).then(function (src) {
            if (!src || !self.bp || self.bp.floorId !== floor.id) return;
            return loadPicture(src).then(function (pic) {
              self.setBpPicture(pic, old.img);
              self.bp.areaM2 = String(Math.round(self.floorArea(floor)));
            });
          }).catch(function () { /* картинки нет — начинаем с выбора */ });
        }
      },
      closeBp: function () { this.bp = null; this._bpPixels = null; },
      setBpPicture: function (pic, key) {
        const bp = this.bp;
        if (!bp) return;
        this._bpPixels = pic.rgba;
        bp.img = pic.img; bp.imgKey = key || ''; bp.w = pic.w; bp.h = pic.h;
        bp.pts = []; bp.rooms = null; bp.sel = null; bp.error = '';
      },
      pickBpFile: function (ev) {
        const file = ev.target.files && ev.target.files[0], self = this;
        ev.target.value = '';
        if (!file || !this.bp) return;
        this.bp.error = '';
        loadPicture(file).then(function (pic) { self.setBpPicture(pic, ''); }, function (e) { if (self.bp) self.bp.error = e.message; });
      },
      loadBpExample: function () {
        const self = this;
        loadPicture(EXAMPLE_PLAN.src).then(function (pic) {
          self.setBpPicture(pic, '');
          self.bp.pts = EXAMPLE_PLAN.ruler.map(function (p) { return p.slice(); });
          self.bp.lenM = String(EXAMPLE_PLAN.meters);
        }, function (e) { if (self.bp) self.bp.error = e.message; });
      },
      // Нажатие на план: до распознавания — концы отрезка для масштаба, после — выбор помещения.
      bpClick: function (ev) {
        const bp = this.bp;
        if (!bp || bp.busy) return;
        if (bp.rooms) {
          const el = ev.target.closest ? ev.target.closest('[data-bp]') : null;
          let id = el ? Number(el.getAttribute('data-bp')) : 0;
          if (!id) { // нажали на подпись или рядом — помещение по точке
            const q = this.planPoint(ev.currentTarget, ev);
            const hit = q && bp.rooms.filter(function (r) { return PL.inPoly(r.poly, q.x, q.y); })[0];
            id = hit ? hit.id : 0;
          }
          if (!id) return;
          bp.sel = id;
          this.$nextTick(function () {
            const row = document.querySelector('[data-bp-item="' + bp.sel + '"]');
            if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
          });
          return;
        }
        const p = this.planPoint(ev.currentTarget, ev);
        if (!p) return;
        const pt = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
        bp.pts = bp.pts.length >= 2 ? [pt] : bp.pts.concat([pt]);
      },
      runBp: function () {
        const bp = this.bp, px = this._bpPixels, self = this;
        if (!bp || !px || !this.bpReady) return;
        bp.busy = true;
        bp.error = '';
        const byLength = bp.pts.length === 2 && toNum(bp.lenM) > 0 ? V.scaleFromLength(bp.pts[0], bp.pts[1], toNum(bp.lenM)) : 0;
        const scaled = byLength
          ? Promise.resolve(byLength)
          : runVision(px, bp.w, bp.h, {}).then(function (out) { return V.scaleFromArea(out.rooms, toNum(bp.areaM2)); });
        scaled.then(function (scale) {
          if (!(scale > 0)) throw new Error('Помещения не найдены — проверьте, что план целиком в кадре и стены видны');
          return runVision(px, bp.w, bp.h, { scale: scale }).then(function (out) {
            // по площади: второй проход с масштабом находит помещения чуть иначе, чем первый,
            // поэтому масштаб уточняется, чтобы сумма площадей совпала с введённой
            return { scale: byLength ? scale : (V.scaleFromArea(out.rooms, toNum(bp.areaM2)) || scale), out: out };
          });
        }).then(function (res) {
          if (!self.bp || self.bp !== bp) return;
          bp.busy = false;
          bp.scale = res.scale;
          bp.ms = res.out.ms;
          if (!res.out.rooms.length) { bp.error = 'Помещения не найдены — проверьте масштаб и что стены на плане видны'; return; }
          const fallback = self.kind.purpose;
          const areas = V.roundAreas(res.out.rooms, res.scale);
          bp.rooms = res.out.rooms.map(function (r, i) {
            return Object.assign({}, r, { area: areas[i], name: '', on: true, purposeSet: false, purpose: V.looksLikeCorridor(r, res.scale) ? 'corridor' : fallback });
          });
        }).catch(function (e) {
          if (!self.bp || self.bp !== bp) return;
          bp.busy = false;
          bp.error = e && e.message ? e.message : String(e);
        });
      },
      // Имя в списке подсказывает назначение, как и в строке помещения.
      bpName: function (r) {
        if (r.purposeSet) return;
        const guess = P.guessPurpose(r.name);
        if (guess && P.BY_ID[guess] && !P.BY_ID[guess].t5) r.purpose = guess;
      },
      // Найденные помещения становятся помещениями этажа; схема строится по плану.
      applyBp: function () {
        const bp = this.bp, floor = this.floorById(bp.floorId), keep = this.bpOn, self = this;
        if (!keep.length || !floor.rooms) return;
        const prev = { rooms: floor.rooms, blueprint: floor.blueprint || null, plan: clone(floor.plan) };
        const key = bp.imgKey || uid('img'), s = bp.scale;
        this.bpImages[key] = bp.img;
        IMG.put(key, bp.img).catch(function () { self.say('Картинку плана сохранить не удалось — после перезагрузки схема будет без неё'); });
        function r1(x) { return Math.round(x * 10) / 10; }
        floor.blueprint = {
          img: key, w: bp.w, h: bp.h, scale: Math.round(s * 10000) / 10000,
          rooms: keep.map(function (r) {
            return { id: r.id, poly: r.poly.map(function (p) { return [r1(p[0]), r1(p[1])]; }), bbox: r.bbox, lx: r1(r.lx), ly: r1(r.ly) };
          })
        };
        floor.rooms = keep.map(function (r) {
          return Object.assign(P.blankRoom(r.purpose), {
            id: uid('r'), more: false, name: r.name, area: r.area, count: 1,
            length: r1((r.bbox[2] - r.bbox[0]) / s), width: r1((r.bbox[3] - r.bbox[1]) / s), bp: r.id, purposeSet: !!r.purposeSet
          });
        });
        floor.plan.open = true;
        floor.plan.view = 'want';
        floor.plan.pos = null;
        floor.plan.ext = [];
        // та же сумма, что в списке найденного и в итоге этажа
        const total = r1(floor.rooms.reduce(function (t, r) { return t + r.area; }, 0));
        this.closeBp();
        this.say('По плану: ' + keep.length + ' ' + E.plural(keep.length, 'помещение', 'помещения', 'помещений') + ', ' + E.fmt(total) + ' м²', function () {
          floor.rooms = prev.rooms;
          floor.blueprint = prev.blueprint;
          floor.plan = prev.plan;
        });
      },

      // ----- ссылка на расчёт -----
      // Код расчёта для адреса. Весь объект лежит в самой ссылке, сервер не нужен.
      shareCode: function () { return SH.encode(this.current); },
      linkFor: function (code) { return window.location.href.split('#')[0].split('?')[0] + '#o=' + code; },
      // Копирует ссылку; если браузер не даёт (страница открыта по http с другого
      // устройства) — показывает её в окне, откуда её можно скопировать вручную.
      share: function () {
        const self = this;
        this.shareCode().then(function (code) {
          const link = self.linkFor(code);
          return copyText(link).then(function () {
            self.say('Ссылка скопирована: по ней откроется этот расчёт');
          }, function () {
            self.linkDialog = link;
            self.$nextTick(function () {
              const el = document.querySelector('.linkbox');
              if (el) { el.focus(); el.select(); }
            });
          });
        }).catch(function (e) { self.say('Не удалось собрать ссылку: ' + (e && e.message ? e.message : e)); });
      },
      copyLinkNow: function () {
        const self = this, el = document.querySelector('.linkbox');
        if (el) { el.focus(); el.select(); }
        copyText(this.linkDialog).then(function () {
          self.linkDialog = '';
          self.say('Ссылка скопирована: по ней откроется этот расчёт');
        }, function () {
          self.say('Выделите ссылку и скопируйте её вручную');
        });
      },
      // Открывает расчёт из адреса страницы (#o=…), если он там есть.
      importLink: function () {
        const self = this;
        const code = SH.codeFromHash(window.location.hash);
        if (!code) return;
        SH.decode(code).then(function (data) {
          const o = adoptObject(data);
          const sig = JSON.stringify(SH.pack(o));
          const same = self.objects.filter(function (x) { return JSON.stringify(SH.pack(x)) === sig; })[0];
          if (same) self.select(same.id);
          else {
            if (self.isBlank(self.current)) self.objects.splice(self.objects.indexOf(self.current), 1, o);
            else self.objects.unshift(o);
            self.select(o.id);
          }
          self.say('Расчёт открыт по ссылке');
        }).catch(function () {
          self.say('Не удалось открыть расчёт по ссылке');
        }).then(function () {
          try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* адрес остаётся как есть */ }
        });
      },

      // ----- PDF -----
      openPdf: function () {
        this.pdfDialog = true;
        ensurePdf().catch(function () { /* сообщим при скачивании */ });
        this.$nextTick(function () {
          const el = document.querySelector('.modal input');
          if (el) el.focus();
        });
      },
      makePdf: function () {
        const self = this, result = this.result, audit = this.audit, now = new Date();
        const schemes = PL.schemes(this.input, result, audit);
        // QR-код в отчёте ведёт на этот же расчёт — если сайт открыт по адресу и ссылка помещается в код.
        const link = /^https?:$/.test(window.location.protocol)
          ? this.shareCode().then(function (code) { const l = self.linkFor(code); return l.length <= MAX_QR_LINK ? l : ''; }).catch(function () { return ''; })
          : Promise.resolve('');
        return Promise.all([ensurePdf(), link]).then(function (x) {
          const doc = R.buildDoc(result, { generatedAt: now, audit: audit, schemes: schemes, link: x[1] });
          return { pdf: window.pdfMake.createPdf(doc, null, R.FONTS), name: R.fileName(result, now) };
        });
      },
      downloadPdf: function () {
        const self = this;
        this.pdfBusy = true;
        this.makePdf().then(function (x) {
          x.pdf.download(x.name, function () {
            self.pdfBusy = false;
            self.pdfDialog = false;
            self.say('PDF сохранён: ' + x.name);
          });
        }).catch(function (e) {
          self.pdfBusy = false;
          self.say('Не удалось сформировать PDF: ' + (e && e.message ? e.message : e));
        });
      }
    },
    updated: function () { this.measurePlans(); },
    mounted: function () {
      const self = this;
      document.addEventListener('click', function () { self.menuOpen = false; });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { self.menuOpen = false; self.pdfDialog = false; self.linkDialog = ''; if (self.bp && !self.bp.busy) self.closeBp(); }
      });

      this.openFirstRoomIfBlank();

      // схема: размеры на экране
      window.addEventListener('resize', function () { self.measurePlans(); });
      this.$nextTick(function () { self.measurePlans(); });
      // если палец отпустили за пределами схемы, перетаскивание всё равно заканчивается
      ['pointerup', 'pointercancel'].forEach(function (type) {
        window.addEventListener(type, function () {
          const d = self.drag;
          if (!d) return;
          const floor = self.floors.filter(function (f) { return f.id === d.floorId; })[0];
          if (floor) self.planUp(floor); else self.drag = null;
        });
      });

      // работа без сети: служебный сценарий кладёт приложение в память браузера
      window.addEventListener('online', function () { self.offline = false; });
      window.addEventListener('offline', function () { self.offline = true; });
      if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
        navigator.serviceWorker.register('sw.js').catch(function () { /* без него приложение работает как обычный сайт */ });
        navigator.serviceWorker.ready.then(function () { self.swReady = true; }).catch(function () {});
      }

      // расчёт по ссылке (QR-код из отчёта)
      window.addEventListener('hashchange', function () { self.importLink(); });
      this.importLink();

      const q = new URLSearchParams(window.location.search);
      const demo = q.get('demo');
      if (demo && P.EXAMPLES[demo]) {
        this.loadExample(demo);
        this.notice = '';
      }
      const step = q.get('step');
      if (step === '3' || step === 'result') this.tab = 'result';
      if (q.get('open') === 'all') {
        this.result.floors.forEach(function (f) { f.units.forEach(function (u) { self.open[u.id] = true; }); });
      }
      // ?selfcheck=1 — проверка, что PDF формируется в этом браузере
      if (q.get('selfcheck')) {
        this.selfcheck = 'Самопроверка: формирую PDF…';
        this.makePdf().then(function (x) {
          x.pdf.getBuffer(function (buffer) {
            self.selfcheck = 'Самопроверка: PDF сформирован, ' + Math.round(buffer.length / 1024) + ' КБ, файл «' + x.name + '».';
          });
        }).catch(function (e) { self.selfcheck = 'Самопроверка: ошибка PDF — ' + (e && e.message ? e.message : e); });
      }
    }
  });

  app.config.errorHandler = function (err) {
    // Ошибка в интерфейсе не должна оставлять пустой экран без объяснения.
    console.error(err);
    const box = document.createElement('div');
    box.className = 'toast';
    box.textContent = 'Ошибка интерфейса: ' + (err && err.message ? err.message : err);
    document.body.appendChild(box);
  };

  app.mount('#app');
}());
