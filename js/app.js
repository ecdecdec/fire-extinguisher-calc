/*
 * Интерфейс: боковая панель с тремя разделами — объект, этажи и помещения,
 * результат. Vue 3 без сборки; расчёт — FireEngine, отчёт — FireReport.
 * Введённые данные хранятся только в браузере (localStorage).
 */
(function () {
  'use strict';

  const N = window.FireNorms, E = window.FireEngine, P = window.FirePresets, R = window.FireReport;

  // ?ns=имя — отдельное хранилище (им пользуется страница проверки интерфейса,
  // чтобы не трогать рабочие данные).
  const NS = new URLSearchParams(window.location.search).get('ns');
  const STORAGE_KEY = 'firecalc.state.v1' + (NS ? '.' + NS.replace(/[^A-Za-z0-9_-]/g, '') : '');

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
  function blankState() {
    return {
      building: { name: '', address: '', owner: '', inspector: '', date: today(), kind: 'public', autoSuppressionAll: false },
      floors: [newFloor(1, 'office')],
      options: Object.assign({}, E.DEFAULT_OPTIONS)
    };
  }

  // Приводит сохранённые данные или пример к виду, с которым работает интерфейс.
  function adopt(data) {
    const base = blankState();
    const building = Object.assign(base.building, data.building || {});
    if (!building.date) building.date = today();
    const floors = (data.floors || []).map(function (f, i) {
      return {
        id: uid('f'),
        name: f.name || ((i + 1) + ' этаж'),
        installedOP: f.installedOP === undefined || f.installedOP === null ? '' : f.installedOP,
        installedOU: f.installedOU === undefined || f.installedOU === null ? '' : f.installedOU,
        rooms: (f.rooms || []).map(function (r) {
          const room = Object.assign(P.blankRoom(r.purpose || 'custom'), r, { id: uid('r') });
          room.classes = (r.classes || room.classes || []).slice();
          room.more = !!(toNum(room.length) || toNum(room.width) || room.autoSuppression);
          return room;
        })
      };
    });
    return {
      building: building,
      floors: floors.length ? floors : base.floors,
      options: Object.assign(base.options, data.options || {})
    };
  }

  function loadSaved() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
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
<div class="shell">
  <aside class="side">
    <div class="side__top">
      <div class="brand__name">Расчёт огнетушителей</div>
      <button type="button" :class="['btn', 'btn--sm', 'btn--quiet', 'side__reset-top', { 'btn--danger': confirmReset }]" @click="reset">{{ confirmReset ? 'Точно очистить?' : 'Очистить' }}</button>
    </div>

    <nav class="steps" aria-label="Разделы">
      <button type="button" v-for="s in steps" :key="s.n" :class="['step', { 'step--on': step === s.n }]" :aria-current="step === s.n ? 'step' : null" @click="go(s.n)">
        <span class="step__n">{{ s.n }}</span>
        <span class="step__t"><span class="step__full">{{ s.title }}</span><span class="step__short">{{ s.short }}</span></span>
        <span class="step__meta" v-if="navMeta(s.n)">{{ navMeta(s.n) }}</span>
      </button>
    </nav>

    <div class="side__totals">
      <div class="side__label">Требуется по нормам</div>
      <div class="side__empty" v-if="!result.totals.length">нет данных</div>
      <div class="side__row" v-for="t in result.totals" :key="t.kind + t.code + t.charge">
        <span>{{ t.code }}{{ t.charge === 'D' ? ' (D)' : '' }}</span><span>{{ t.count }}</span>
      </div>
      <button type="button" class="btn btn--primary side__pdf" data-test="pdf" :disabled="!result.totals.length || pdfBusy" @click="downloadPdf">{{ pdfBusy ? 'Формирую…' : 'Скачать PDF' }}</button>
    </div>

    <div class="side__foot">
      <button type="button" data-test="reset" :class="['link', 'side__reset', { 'side__reset--sure': confirmReset }]" @click="reset">{{ confirmReset ? 'Точно очистить?' : 'Очистить данные' }}</button>
      <div>Приложение 3 к Правилам пожарной безопасности РК (приказ МЧС РК № 55) и СТ РК 1487-2006</div>
    </div>
  </aside>

  <main class="main">

    <!-- 1. ОБЪЕКТ -->
    <section v-show="step === 1">
      <div class="page-head"><h1>Объект</h1></div>
      <div class="form">
        <div class="grid2">
          <label class="field"><span>Название объекта</span><input type="text" v-model.trim="building.name" placeholder="Школа № 12"></label>
          <label class="field"><span>Адрес</span><input type="text" v-model.trim="building.address" placeholder="Город, улица, дом"></label>
          <label class="field"><span>Собственник или организация</span><input type="text" v-model.trim="building.owner"></label>
          <label class="field"><span>Расчёт выполнил</span><input type="text" v-model.trim="building.inspector" placeholder="Фамилия И. О., должность"></label>
          <label class="field"><span>Дата расчёта</span><input type="date" v-model="building.date"></label>
        </div>

        <div class="group">
          <h2>Назначение здания</h2>
          <div class="kinds">
            <label v-for="k in kinds" :key="k.id" :class="['kind', { 'kind--on': building.kind === k.id }]">
              <input type="radio" name="kind" :value="k.id" v-model="building.kind">
              <b>{{ k.label }}</b><small>{{ k.hint }}</small>
            </label>
          </div>
          <p class="hint">{{ kindHint }}</p>
        </div>

        <label class="check">
          <input type="checkbox" v-model="building.autoSuppressionAll">
          <span>Всё здание оборудовано автоматической установкой пожаротушения<small>Ручных огнетушителей нужно 50 % от нормы (п. 10)</small></span>
        </label>

        <div class="next"><button type="button" class="btn" data-test="next" @click="go(2)">К помещениям</button></div>

        <div class="quick">
          <span class="muted">Открыть пример</span>
          <button type="button" class="link" data-test="example" v-for="(ex, key) in examples" :key="key" @click="loadExample(key)">{{ ex.title }}</button>
        </div>
      </div>
    </section>

    <!-- 2. ЭТАЖИ И ПОМЕЩЕНИЯ -->
    <section v-show="step === 2">
      <div class="page-head"><h1>Этажи и помещения</h1></div>
      <p class="legend">
        Назначение подставляет типичные категорию и классы пожара, их можно исправить.
        Классы: <span class="mono">A</span> твёрдые материалы, <span class="mono">B</span> горючие жидкости, <span class="mono">C</span> газы,
        <span class="mono">D</span> металлы, <span class="mono">E</span> электрооборудование под напряжением.
      </p>

      <div class="floor" v-for="(floor, fi) in floors" :key="floor.id">
        <div class="floor__head">
          <input type="text" class="floor__name" v-model.trim="floor.name" aria-label="Название этажа">
          <span class="floor__meta">{{ floor.rooms.length }} пом. · {{ fmt(floorArea(floor)) }} м²</span>
          <span class="spacer"></span>
          <button type="button" class="btn btn--sm btn--quiet" @click="duplicateFloor(fi)">Дублировать этаж</button>
          <button type="button" class="btn btn--sm btn--quiet" :disabled="floors.length === 1" @click="removeFloor(fi)">Удалить</button>
        </div>

        <div class="rooms">
          <div class="rooms__head" aria-hidden="true">
            <span>Помещение</span><span>Назначение</span><span>Площадь, м²</span><span>Категория</span><span>Классы пожара</span><span></span>
          </div>
          <div class="room" v-for="(room, ri) in floor.rooms" :key="room.id">
            <div class="room__main">
              <label class="field f-name"><span class="sr">Помещение</span>
                <input type="text" v-model.trim="room.name" :placeholder="'Помещение ' + (ri + 1)"></label>
              <label class="field f-purpose"><span class="sr">Назначение</span>
                <select v-model="room.purpose" @change="onPurpose(room)">
                  <optgroup v-for="g in purposeGroups" :key="g.group" :label="g.group">
                    <option v-for="p in g.items" :key="p.id" :value="p.id">{{ p.label }}</option>
                  </optgroup>
                </select></label>

              <label class="field f-area" v-if="areaMode(room) === 'area'"><span class="sr">Площадь, м²</span>
                <input type="number" min="0" step="any" inputmode="decimal" v-model="room.area" placeholder="0"></label>
              <label class="field f-area" v-else-if="areaMode(room) === 'units'"><span class="sr">Гаражей, шт.</span>
                <input type="number" min="1" step="1" inputmode="numeric" v-model="room.units"></label>
              <div class="field f-area" v-else><span class="sr">Площадь</span><input type="text" value="не нужна" disabled></div>

              <template v-if="!room.t5">
                <label class="field f-cat"><span class="sr">Категория</span>
                  <select v-model="room.category" @change="room.forceType = ''">
                    <option v-for="c in categories" :key="c.id" :value="c.id" :title="c.title">{{ c.label }}</option>
                  </select></label>
                <div class="field f-classes"><span class="sr">Классы пожара</span>
                  <div class="chips">
                    <button type="button" v-for="k in fireClasses" :key="k.id"
                      :class="['chip', { 'chip--on': room.classes.indexOf(k.id) >= 0 }]"
                      :title="k.id + ' — ' + k.name" :aria-pressed="room.classes.indexOf(k.id) >= 0"
                      @click="toggleClass(room, k.id)">{{ k.id }}</button>
                  </div>
                </div>
              </template>
              <div class="room__t5" v-else>{{ t5Note(room) }}</div>

              <div class="room__tools">
                <button type="button" :class="['icon', 'icon--more', { 'icon--on': room.more }]" @click="room.more = !room.more" :aria-expanded="room.more">Ещё</button>
                <button type="button" class="icon" title="Дублировать помещение" aria-label="Дублировать помещение" @click="duplicateRoom(floor, ri)" v-html="iconCopy"></button>
                <button type="button" class="icon icon--danger" title="Удалить помещение" aria-label="Удалить помещение" @click="removeRoom(floor, ri)" v-html="iconTrash"></button>
              </div>
            </div>

            <div class="room__more" v-if="room.more">
              <template v-if="!room.t5">
                <label class="field"><span>Длина, м</span><input type="number" min="0" step="any" inputmode="decimal" v-model="room.length" @change="onDims(room)"></label>
                <label class="field"><span>Ширина, м</span><input type="number" min="0" step="any" inputmode="decimal" v-model="room.width" @change="onDims(room)"></label>
              </template>
              <label class="check">
                <input type="checkbox" v-model="room.autoSuppression" :disabled="building.autoSuppressionAll">
                <span>Автоматическое пожаротушение<small>{{ building.autoSuppressionAll ? 'Уже отмечено для всего здания' : 'Ручных огнетушителей 50 % от нормы (п. 10)' }}</small></span>
              </label>
              <label class="check" v-if="!room.t5">
                <input type="checkbox" v-model="room.sensitive" @change="room.forceType = ''">
                <span>Дорогая электроника или ценности<small>Выбирается углекислотный огнетушитель (п. 9)</small></span>
              </label>
              <div class="room__note" v-if="!room.t5">
                Длина и ширина нужны, чтобы проверить расстояние до огнетушителя (п. 4). Без них расчёт идёт только по площади.
                <template v-if="dimsMismatch(room)"> <b>Длина × ширина = {{ dimsMismatch(room) }} м², а площадь указана {{ fmt(room.area) }} м².</b></template>
              </div>
            </div>
          </div>
        </div>

        <div class="floor__foot">
          <button type="button" class="btn btn--sm btn--add" @click="addRoom(floor)">Добавить помещение</button>
          <div class="floor__need">По расчёту на этаже <b>{{ floorNeed(floor.id) }}</b></div>
          <div class="floor__fact">
            <span>Установлено фактически</span>
            <label>ОП <input type="number" min="0" step="1" inputmode="numeric" v-model="floor.installedOP" placeholder="—" aria-label="Фактически порошковых"></label>
            <label>ОУ <input type="number" min="0" step="1" inputmode="numeric" v-model="floor.installedOU" placeholder="—" aria-label="Фактически углекислотных"></label>
          </div>
        </div>
      </div>

      <div class="section-foot">
        <button type="button" class="btn" data-test="add-floor" @click="addFloor">Добавить этаж</button>
        <span class="next"><button type="button" class="btn" data-test="next" @click="go(3)">К результату</button></span>
      </div>
    </section>

    <!-- 3. РЕЗУЛЬТАТ -->
    <section v-show="step === 3">
      <div class="page-head"><h1>Результат</h1></div>

      <div class="result-top">
        <div>
          <div class="empty" v-if="!result.totals.length">Добавьте в разделе 2 помещения с площадью, и здесь появится расчёт</div>
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
          </template>
        </div>

        <div>
          <div :class="['verdict', { 'verdict--bad': !result.check.ok }]" v-if="result.check">
            <div class="verdict__label">Сверка с фактическим наличием</div>
            <div class="verdict__title">{{ result.check.ok ? 'Соответствует' : 'Не соответствует' }}</div>
            <p>{{ result.check.text }}</p>
            <div class="scroll">
              <table class="table">
                <thead>
                  <tr><th rowspan="2">Этаж</th><th colspan="3" class="grp">Порошковые, ОП</th><th colspan="3" class="grp">Углекислотные, ОУ</th></tr>
                  <tr><th>нужно</th><th>есть</th><th>не хватает</th><th>нужно</th><th>есть</th><th>не хватает</th></tr>
                </thead>
                <tbody>
                  <tr v-for="f in result.floors" :key="f.id">
                    <td>{{ f.name }}</td>
                    <template v-if="f.check">
                      <td>{{ f.check.requiredOP }}</td><td>{{ f.check.installedOP }}</td><td :class="{ bad: f.check.deficitOP > 0 }">{{ f.check.deficitOP }}</td>
                      <td>{{ f.check.requiredOU }}</td><td>{{ f.check.installedOU }}</td><td :class="{ bad: f.check.deficitOU > 0 }">{{ f.check.deficitOU }}</td>
                    </template>
                    <td v-else colspan="6" class="muted" style="text-align:left">фактическое наличие не указано</td>
                  </tr>
                </tbody>
                <tfoot><tr>
                  <td>Итого</td>
                  <td>{{ result.check.requiredOP }}</td><td>{{ result.check.installedOP }}</td><td :class="{ bad: result.check.deficitOP > 0 }">{{ result.check.deficitOP }}</td>
                  <td>{{ result.check.requiredOU }}</td><td>{{ result.check.installedOU }}</td><td :class="{ bad: result.check.deficitOU > 0 }">{{ result.check.deficitOU }}</td>
                </tr></tfoot>
              </table>
            </div>
          </div>
          <p class="aside-note" v-else-if="result.totals.length">
            Чтобы сверить расчёт с фактом, укажите в разделе 2, сколько ОП и ОУ установлено на каждом этаже.
            <button type="button" class="link" @click="go(2)">Перейти к помещениям</button>
          </p>
        </div>
      </div>

      <div class="block notice" v-if="result.warnings.length">
        <h2>Требует внимания</h2>
        <ul><li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li></ul>
      </div>

      <template v-for="f in result.floors" :key="f.id">
        <div class="block" v-if="f.units.length">
          <div class="floorres__head">
            <h2>{{ f.name }}</h2>
            <span class="floorres__meta">{{ floorSummary(f) }}</span>
            <span class="spacer"></span>
            <button type="button" class="link" @click="toggleFloor(f)">{{ floorOpen(f) ? 'Скрыть расчёты' : 'Показать все расчёты' }}</button>
          </div>

          <div class="unit" v-for="u in f.units" :key="u.id">
            <div>
              <div class="unit__title">{{ u.title }}</div>
              <div class="unit__meta">{{ unitMeta(u) }}<button type="button" class="link" @click="toggle(u.id)" :aria-expanded="!!open[u.id]">{{ open[u.id] ? 'Скрыть расчёт' : 'Показать расчёт' }}</button></div>
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

      <div class="block" v-if="result.totals.length">
        <h2>Размещение и содержание</h2>
        <ul class="prose"><li v-for="(p, i) in result.placement" :key="i">{{ p }}</li></ul>
      </div>

      <div class="block">
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

      <p class="hint" style="margin-top:16px" v-if="selfcheck" id="selfcheck">{{ selfcheck }}</p>
    </section>
  </main>
</div>

<div class="toast" v-if="notice" role="status">{{ notice }}</div>

<footer class="bar">
  <div class="bar__in">
    <div class="bar__sum"><span class="bar__label">Требуется по нормам</span><b>{{ totalsLine }}</b></div>
    <button type="button" class="btn btn--primary" v-if="step < 3" @click="go(step + 1)">{{ step === 1 ? 'К помещениям' : 'К результату' }}</button>
    <button type="button" class="btn btn--primary" v-if="step === 3" :disabled="!result.totals.length || pdfBusy" @click="downloadPdf">{{ pdfBusy ? 'Формирую…' : 'Скачать PDF' }}</button>
  </div>
</footer>
`;

  const saved = loadSaved();
  const initial = saved ? adopt(saved) : blankState();

  const app = Vue.createApp({
    template: TEMPLATE,
    data: function () {
      return {
        step: 1,
        building: initial.building,
        floors: initial.floors,
        options: initial.options,
        open: {},
        notice: '',
        pdfBusy: false,
        confirmReset: false,
        selfcheck: '',
        iconCopy: ICON_COPY,
        iconTrash: ICON_TRASH
      };
    },
    computed: {
      steps: function () {
        return [
          { n: 1, title: 'Объект', short: 'Объект' },
          { n: 2, title: 'Этажи и помещения', short: 'Помещения' },
          { n: 3, title: 'Результат', short: 'Результат' }
        ];
      },
      kinds: function () { return P.BUILDING_KINDS; },
      purposeGroups: function () { return P.PURPOSE_GROUPS; },
      examples: function () { return P.EXAMPLES; },
      sources: function () { return N.SOURCES; },
      categories: function () {
        return Object.keys(N.CATEGORIES).map(function (id) {
          // Короткие подписи, чтобы помещались в узкое поле; расшифровка — во всплывающей подсказке.
          return { id: id, label: id === 'PUB' ? 'Общественное' : N.CATEGORIES[id].label, title: N.CATEGORIES[id].name };
        });
      },
      fireClasses: function () {
        return Object.keys(N.FIRE_CLASSES).map(function (id) { return { id: id, name: N.FIRE_CLASSES[id].name }; });
      },
      result: function () {
        return E.calculate({ building: this.building, floors: this.floors }, this.options);
      },
      methodology: function () { return E.methodology(this.options, this.building); },
      defaultPurpose: function () {
        const kind = this.building.kind;
        const k = P.BUILDING_KINDS.filter(function (x) { return x.id === kind; })[0];
        return k ? k.purpose : 'office';
      },
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
      building: { deep: true, handler: function () { this.save(); } },
      floors: { deep: true, handler: function () { this.save(); } },
      options: { deep: true, handler: function () { this.save(); } },
      step: function (value) {
        window.scrollTo(0, 0);
        if (value === 3) ensurePdf().catch(function () { /* сообщим при нажатии «Скачать PDF» */ });
      }
    },
    methods: {
      fmt: E.fmt,
      plural: E.plural,
      lineTitle: E.lineTitle,
      go: function (n) { this.step = Math.min(3, Math.max(1, n)); },
      say: function (text) {
        const self = this;
        this.notice = text;
        clearTimeout(this._noticeTimer);
        this._noticeTimer = setTimeout(function () { self.notice = ''; }, 3500);
      },
      save: function () {
        const self = this;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(function () {
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ building: self.building, floors: self.floors, options: self.options }));
          } catch (e) { /* хранилище недоступно — работаем без сохранения */ }
        }, 250);
      },
      apply: function (state) {
        this.building = state.building;
        this.floors = state.floors;
        this.options = state.options;
        this.open = {};
      },
      reset: function () {
        const self = this;
        if (!this.confirmReset) {
          this.confirmReset = true;
          clearTimeout(this._resetTimer);
          this._resetTimer = setTimeout(function () { self.confirmReset = false; }, 4000);
          return;
        }
        clearTimeout(this._resetTimer);
        this.confirmReset = false;
        this.apply(blankState());
        this.step = 1;
        this.say('Данные очищены');
      },
      loadExample: function (key) {
        const state = adopt(P.EXAMPLES[key].build());
        if (this.building.inspector) state.building.inspector = this.building.inspector;
        state.options = this.options;
        this.apply(state);
        this.step = 2;
        this.say('Загружен пример: ' + P.EXAMPLES[key].title);
      },
      // Счётчик справа от названия раздела в боковой панели.
      navMeta: function (n) {
        const s = this.result.summary;
        if (n === 2) return s.rooms ? String(s.rooms) : '';
        if (n === 3) return s.portable + s.wheeled ? String(s.portable + s.wheeled) : '';
        return '';
      },

      // ----- этажи и помещения -----
      addFloor: function () { this.floors.push(newFloor(this.nextFloorNumber(), this.defaultPurpose)); },
      nextFloorNumber: function () {
        let max = 0;
        this.floors.forEach(function (f) { const m = /^(\d+)/.exec(f.name || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); });
        return Math.max(max, this.floors.length) + 1;
      },
      removeFloor: function (i) { if (this.floors.length > 1) this.floors.splice(i, 1); },
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
      addRoom: function (floor) { floor.rooms.push(newRoom(this.defaultPurpose)); },
      removeRoom: function (floor, i) { floor.rooms.splice(i, 1); },
      duplicateRoom: function (floor, i) {
        const copy = clone(floor.rooms[i]);
        copy.id = uid('r');
        floor.rooms.splice(i + 1, 0, copy);
      },
      onPurpose: function (room) { P.applyPurpose(room, room.purpose); },
      toggleClass: function (room, k) {
        const i = room.classes.indexOf(k);
        if (i >= 0) room.classes.splice(i, 1); else room.classes.push(k);
        room.forceType = '';
      },
      areaMode: function (room) {
        if (!room.t5) return 'area';
        const basis = N.TABLE5[room.t5].basis;
        return basis === 'perUnit' ? 'units' : basis === 'fixed' ? 'none' : 'area';
      },
      t5Note: function (room) {
        const mode = this.areaMode(room);
        if (mode === 'units') return 'Норма по табл. 5: вместо площади укажите число гаражей';
        if (mode === 'none') return 'Норма по табл. 5: постоянный набор на объект';
        return 'Норма по табл. 5: категория и классы пожара не нужны';
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
      floorArea: function (floor) {
        return floor.rooms.reduce(function (s, r) { return s + toNum(r.area); }, 0);
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
        if (u.pooled) parts.push(u.rooms.length + ' ' + E.plural(u.rooms.length, 'помещение', 'помещения', 'помещений'));
        if (u.area) parts.push(E.fmt(u.area) + ' м²');
        if (u.kind === 'table5') parts.push('табл. 5');
        else if (u.kind === 'exempt') parts.push('категория Д, менее 100 м²');
        else {
          parts.push(u.category === 'PUB' ? 'общественное назначение' : 'категория ' + u.categoryLabel);
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
        return 'Табл. 1 · ' + u.matrix.rows[0].rowTitle + ' · число огнетушителей на ' + u.matrix.rows[0].area + ' м²';
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
          x.pdf.download(x.name, function () { self.pdfBusy = false; self.say('PDF сохранён: ' + x.name); });
        }).catch(function (e) {
          self.pdfBusy = false;
          self.say('Не удалось сформировать PDF: ' + (e && e.message ? e.message : e));
        });
      }
    },
    mounted: function () {
      const self = this;
      const q = new URLSearchParams(window.location.search);
      const demo = q.get('demo');
      if (demo && P.EXAMPLES[demo]) {
        this.apply(adopt(P.EXAMPLES[demo].build()));
        this.notice = '';
      }
      const step = parseInt(q.get('step'), 10);
      if (step >= 1 && step <= 3) this.step = step;
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
