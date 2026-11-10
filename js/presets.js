/*
 * Справочник назначений помещений и демонстрационные примеры.
 *
 * Назначение — это подсказка: оно подставляет типичные категорию и классы
 * пожара. Категорию помещения по взрывопожарной и пожарной опасности инспектор
 * берёт из проекта или декларации и при необходимости исправляет вручную.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FirePresets = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PURPOSE_GROUPS = [
    {
      group: 'Общественные помещения', items: [
        { id: 'office', label: 'Кабинет, офис', category: 'PUB', classes: ['A', 'E'] },
        { id: 'classroom', label: 'Учебный класс, аудитория', category: 'PUB', classes: ['A', 'E'] },
        { id: 'corridor', label: 'Коридор, холл, вестибюль', category: 'PUB', classes: ['A'] },
        { id: 'hall', label: 'Зал: актовый, зрительный, спортивный', category: 'PUB', classes: ['A', 'E'] },
        { id: 'shopfloor', label: 'Торговый зал', category: 'PUB', classes: ['A', 'E'] },
        { id: 'canteen', label: 'Столовая, обеденный зал', category: 'PUB', classes: ['A', 'E'] },
        { id: 'ward', label: 'Палата, номер, жилая комната', category: 'PUB', classes: ['A', 'E'] }
      ]
    },
    {
      group: 'Электроника и ценности (п. 9)', items: [
        { id: 'server', label: 'Серверная, узел связи', category: 'PUB', classes: ['A', 'E'], sensitive: true },
        { id: 'archive', label: 'Архив, книгохранилище', category: 'CV3', classes: ['A'], sensitive: true },
        { id: 'museum', label: 'Музейный, выставочный зал', category: 'PUB', classes: ['A', 'E'], sensitive: true }
      ]
    },
    {
      group: 'Технические помещения', items: [
        { id: 'electro', label: 'Электрощитовая', category: 'CV4', classes: ['A', 'E'] },
        { id: 'vent', label: 'Венткамера, насосная, тепловой пункт', category: 'CD', classes: ['A'] },
        { id: 'storeroom', label: 'Кладовая, подсобное помещение', category: 'CV3', classes: ['A'] },
        { id: 'boiler', label: 'Котельная', category: 'CG', classes: ['A', 'E'] }
      ]
    },
    {
      group: 'Производство и склады', items: [
        { id: 'store_solid', label: 'Склад твёрдых горючих материалов', category: 'CV3', classes: ['A'] },
        { id: 'store_liquid', label: 'Склад ЛВЖ, ГЖ, горючих газов', category: 'CB', classes: ['A', 'B'] },
        { id: 'workshop', label: 'Производственный цех', category: 'CV4', classes: ['A', 'E'] },
        { id: 'noncomb', label: 'Помещение с негорючими материалами', category: 'CD', classes: ['A'] }
      ]
    },
    {
      group: 'Объекты обслуживания (табл. 5)', items: [
        { id: 't5_sto', label: 'Станция техобслуживания (СТО)', t5: 'sto' },
        { id: 't5_parking', label: 'Открытая стоянка транспорта', t5: 'parking_open' },
        { id: 't5_garage', label: 'Гаражи (боксы)', t5: 'garage_box' },
        { id: 't5_admin', label: 'Помещение охраны стоянки, гаража', t5: 'parking_admin' },
        { id: 't5_garage_terr', label: 'Территория гаража', t5: 'garage_territory' },
        { id: 't5_azs_big', label: 'АЗС: 500 и более заправок в сутки', t5: 'azs_big' },
        { id: 't5_azs_small', label: 'АЗС: менее 500 заправок в сутки', t5: 'azs_small' },
        { id: 't5_azs_shop', label: 'Операторная, магазин, кафе при АЗС', t5: 'azs_shop' },
        { id: 't5_kiosk', label: 'Отдельный павильон, киоск', t5: 'kiosk' },
        { id: 't5_builtin_trade', label: 'Встроенный магазин, кафе, аптека, салон', t5: 'builtin_trade' },
        { id: 't5_builtin_office', label: 'Встроенный офис, зал, клуб, мастерская', t5: 'builtin_office' }
      ]
    },
    {
      group: 'Другое', items: [
        { id: 'custom', label: 'Другое (задать вручную)', category: 'PUB', classes: ['A'] }
      ]
    }
  ];

  const BY_ID = {};
  PURPOSE_GROUPS.forEach(function (g) { g.items.forEach(function (p) { BY_ID[p.id] = p; }); });

  const BUILDING_KINDS = [
    { id: 'public', label: 'Общественное', hint: 'офисы, школы, больницы, торговые центры, гостиницы', purpose: 'office' },
    { id: 'industrial', label: 'Производственное', hint: 'цеха, мастерские, котельные', purpose: 'workshop' },
    { id: 'warehouse', label: 'Складское', hint: 'склады, базы, хранилища', purpose: 'store_solid' }
  ];

  // Подставляет в помещение категорию и классы пожара по назначению.
  function applyPurpose(room, purposeId) {
    const p = BY_ID[purposeId] || BY_ID.custom;
    room.purpose = p.id;
    room.t5 = p.t5 || '';
    room.t5Alt = 0;
    room.category = p.t5 ? 'PUB' : p.category;
    room.classes = p.t5 ? [] : p.classes.slice();
    room.sensitive = !!p.sensitive;
    room.forceType = '';
    return room;
  }

  function blankRoom(purposeId) {
    return applyPurpose({
      name: '', area: '', length: '', width: '', autoSuppression: false, units: 1
    }, purposeId || 'office');
  }

  function r(name, purpose, area, extra) {
    return Object.assign(blankRoom(purpose), { name: name, area: area }, extra || {});
  }

  // Примеры собираются заново при каждом вызове, чтобы их можно было свободно править.
  const EXAMPLES = {
    business: {
      title: 'Бизнес-центр, 2 этажа',
      build: function () {
        return {
          building: { name: 'Бизнес-центр (пример)', address: 'г. Астана, ул. Примерная, 1', owner: 'ТОО «Пример»', kind: 'public' },
          floors: [
            {
              name: '1 этаж', installedOP: 3, installedOU: 0,
              rooms: [
                r('Офисы', 'office', 450, { length: 30, width: 15 }),
                r('Серверная', 'server', 20),
                r('Кладовая 1', 'storeroom', 10),
                r('Кладовая 2', 'storeroom', 10),
                r('Кладовая 3', 'storeroom', 10),
                r('Кладовая 4', 'storeroom', 10),
                r('Венткамера', 'vent', 60)
              ]
            },
            { name: '2 этаж', installedOP: 2, installedOU: 0, rooms: [r('Офисы', 'office', 150)] }
          ]
        };
      }
    },
    factory: {
      title: 'Производственная база',
      build: function () {
        return {
          building: { name: 'Производственная база (пример)', address: 'г. Караганда, промзона, участок 7', owner: 'ТОО «Пример-Пром»', kind: 'industrial' },
          floors: [
            {
              name: '1 этаж', installedOP: '', installedOU: '',
              rooms: [
                r('Механический цех', 'workshop', 1200, { length: 60, width: 20 }),
                r('Склад ЛВЖ и ГЖ', 'store_liquid', 300),
                r('Склад готовой продукции', 'store_solid', 2000, { autoSuppression: true }),
                r('Компрессорная', 'noncomb', 80),
                r('Электрощитовая', 'electro', 25),
                r('Участок ТО автотранспорта', 't5_sto', 250)
              ]
            },
            {
              name: '2 этаж (АБК)', installedOP: '', installedOU: '',
              rooms: [
                r('Кабинеты', 'office', 180),
                r('Архив', 'archive', 30)
              ]
            }
          ]
        };
      }
    }
  };

  return {
    PURPOSE_GROUPS: PURPOSE_GROUPS, BY_ID: BY_ID, BUILDING_KINDS: BUILDING_KINDS, EXAMPLES: EXAMPLES,
    applyPurpose: applyPurpose, blankRoom: blankRoom
  };
}));
