/*
 * Интерфейс: слева ввод помещений, справа сразу результат. На узком экране это
 * две вкладки. Vue 3 без сборки; расчёт — FireEngine, отчёт — FireReport.
 *
 * Объектов может быть несколько, они хранятся только в браузере (localStorage).
 * Данные для отчёта (адрес, собственник, кто выполнил) спрашиваются при
 * скачивании PDF, чтобы не мешать началу работы.
 */
(function () {
  'use strict';

  const N = window.FireNorms, E = window.FireEngine, P = window.FirePresets, R = window.FireReport;

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
    return { id: uid('f'), name: number + ' этаж', installedOP: '', installedOU: '', rooms: [newRoom(purpose)] };
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
      return {
        id: uid('f'),
        name: f.name || ((i + 1) + ' этаж'),
        installedOP: f.installedOP === undefined || f.installedOP === null ? '' : f.installedOP,
        installedOU: f.installedOU === undefined || f.installedOU === null ? '' : f.installedOU,
        rooms: (f.rooms || []).map(function (r) {
          const room = Object.assign(P.blankRoom(r.purpose || 'custom'), r, { id: uid('r'), more: false });
          room.classes = (r.classes || room.classes || []).slice();
          if (!toNum(room.count)) room.count = r.t5 === 'garage_box' && toNum(r.units) ? Math.round(toNum(r.units)) : 1;
          delete room.units;
          return room;
        })
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
          return { objects: d.objects.map(adoptObject), currentId: d.currentId, options: d.options };
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
        .then(function () { return loadScript('vendor/vfs_fonts.js'); })
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
              <input type="text" v-model.trim="room.name" :placeholder="shortName(room.purpose)"></label>
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
                <td><input type="number" min="0" step="1" inputmode="numeric" class="fact" data-test="fact-op" placeholder="—"
                  v-model="floorById(f.id).installedOP" :aria-label="'Установлено порошковых, ' + f.name"></td>
                <td :class="{ bad: f.check && f.check.deficitOP > 0 }">{{ f.check ? f.check.deficitOP : '' }}</td>
                <td>{{ f.portable.co2 }}</td>
                <td><input type="number" min="0" step="1" inputmode="numeric" class="fact" data-test="fact-ou" placeholder="—"
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
        <div :class="['verdict', { 'verdict--bad': !result.check.ok }]" v-if="result.check">
          <div class="verdict__title">{{ result.check.ok ? 'Соответствует' : 'Не соответствует' }}</div>
          <p>{{ result.check.text }}</p>
        </div>
        <p class="hint" v-else>Впишите, сколько огнетушителей установлено на этаже, и здесь появится вывод</p>
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

  const stored = loadStore();
  const firstObjects = stored ? stored.objects : [blankObject('')];

  const app = Vue.createApp({
    template: TEMPLATE,
    data: function () {
      return {
        objects: firstObjects,
        currentId: stored && stored.currentId ? stored.currentId : firstObjects[0].id,
        options: Object.assign({}, E.DEFAULT_OPTIONS, stored && stored.options ? stored.options : {}),
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
      result: function () {
        // Если имя помещения не введено, оно называется по назначению.
        const floors = this.floors.map(function (f) {
          return Object.assign({}, f, {
            rooms: f.rooms.map(function (r) { return Object.assign({}, r, { fallbackName: P.shortName(r.purpose) }); })
          });
        });
        return E.calculate({ building: this.building, floors: floors }, this.options);
      },
      checkFloors: function () { return this.result.floors.filter(function (f) { return f.units.length; }); },
      extTotal: function () { return this.result.summary.portable + this.result.summary.wheeled; },
      methodology: function () { return E.methodology(this.options, this.building); },
      kindHint: function () {
        return this.building.kind === 'public'
          ? 'В общественном здании на каждом этаже нужно не менее двух огнетушителей (п. 5), а до огнетушителя должно быть не более 20 м (п. 4)'
          : 'В производственном и складском здании норма зависит от категории помещения (А–Д) и класса пожара, до огнетушителя не более 30, 40 или 70 м (п. 4)';
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
            window.localStorage.setItem(STORE_KEY, JSON.stringify({ version: 2, currentId: self.current.id, objects: self.objects, options: self.options }));
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
        copy.id = uid('f');
        copy.name = m ? this.nextFloorNumber() + m[2] : (copy.name || 'Этаж') + ' (копия)';
        copy.installedOP = '';
        copy.installedOU = '';
        copy.rooms.forEach(function (r) { r.id = uid('r'); });
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
        floor.rooms.splice(i + 1, 0, copy);
        this.openRoom = copy.id;
      },
      onPurpose: function (room) { P.applyPurpose(room, room.purpose); },
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
      onDims: function (room) {
        const L = toNum(room.length), W = toNum(room.width);
        if (L && W && !toNum(room.area)) room.area = Math.round(L * W * 100) / 100;
      },
      dimsMismatch: function (room) {
        const L = toNum(room.length), W = toNum(room.width), S = toNum(room.area);
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
        if (u.kind === 'floorMin') return 'п. 5: не менее двух огнетушителей на этаже общественного здания';
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
        const result = this.result, now = new Date();
        return ensurePdf().then(function () {
          return { pdf: window.pdfMake.createPdf(R.buildDoc(result, { generatedAt: now })), name: R.fileName(result, now) };
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
    mounted: function () {
      const self = this;
      document.addEventListener('click', function () { self.menuOpen = false; });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { self.menuOpen = false; self.pdfDialog = false; }
      });

      this.openFirstRoomIfBlank();

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
