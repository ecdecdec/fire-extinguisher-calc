/*
 * Справочник назначений помещений и демонстрационные примеры.
 *
 * Назначение — это подсказка: оно подставляет типичные категорию и классы
 * пожара. Категорию помещения по взрывопожарной и пожарной опасности инспектор
 * берёт из проекта или декларации и при необходимости исправляет вручную.
 *
 * short — короткое имя: им называется помещение, если своё имя не введено,
 * и оно же стоит на кнопках быстрого добавления.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FirePresets = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PURPOSE_GROUPS = [
    {
      group: 'Общественные помещения', items: [
        { id: 'office', label: 'Кабинет, офис', short: 'Кабинет', category: 'PUB', classes: ['A', 'E'] },
        { id: 'classroom', label: 'Учебный класс, аудитория', short: 'Класс', category: 'PUB', classes: ['A', 'E'] },
        { id: 'corridor', label: 'Коридор, холл, вестибюль', short: 'Коридор', category: 'PUB', classes: ['A'] },
        { id: 'hall', label: 'Зал: актовый, зрительный, спортивный', short: 'Зал', category: 'PUB', classes: ['A', 'E'] },
        { id: 'shopfloor', label: 'Торговый зал', short: 'Торговый зал', category: 'PUB', classes: ['A', 'E'] },
        { id: 'canteen', label: 'Столовая, обеденный зал', short: 'Столовая', category: 'PUB', classes: ['A', 'E'] },
        { id: 'ward', label: 'Палата, номер, жилая комната', short: 'Палата', category: 'PUB', classes: ['A', 'E'] }
      ]
    },
    {
      group: 'Электроника и ценности (п. 9)', items: [
        { id: 'server', label: 'Серверная, узел связи', short: 'Серверная', category: 'PUB', classes: ['A', 'E'], sensitive: true },
        { id: 'archive', label: 'Архив, книгохранилище', short: 'Архив', category: 'CV3', classes: ['A'], sensitive: true },
        { id: 'museum', label: 'Музейный, выставочный зал', short: 'Выставочный зал', category: 'PUB', classes: ['A', 'E'], sensitive: true }
      ]
    },
    {
      group: 'Технические помещения', items: [
        { id: 'electro', label: 'Электрощитовая', short: 'Электрощитовая', category: 'CV4', classes: ['A', 'E'] },
        { id: 'vent', label: 'Венткамера, насосная, тепловой пункт', short: 'Венткамера', category: 'CD', classes: ['A'] },
        { id: 'storeroom', label: 'Кладовая, подсобное помещение', short: 'Кладовая', category: 'CV3', classes: ['A'] },
        { id: 'boiler', label: 'Котельная', short: 'Котельная', category: 'CG', classes: ['A', 'E'] }
      ]
    },
    {
      group: 'Производство и склады', items: [
        { id: 'store_solid', label: 'Склад твёрдых горючих материалов', short: 'Склад', category: 'CV3', classes: ['A'] },
        { id: 'store_liquid', label: 'Склад ЛВЖ, ГЖ, горючих газов', short: 'Склад ЛВЖ', category: 'CB', classes: ['A', 'B'] },
        { id: 'workshop', label: 'Производственный цех', short: 'Цех', category: 'CV4', classes: ['A', 'E'] },
        { id: 'noncomb', label: 'Помещение с негорючими материалами', short: 'Помещение без горючих материалов', category: 'CD', classes: ['A'] }
      ]
    },
    {
      group: 'Объекты обслуживания (табл. 5)', items: [
        { id: 't5_sto', label: 'Станция техобслуживания (СТО)', short: 'СТО', t5: 'sto' },
        { id: 't5_parking', label: 'Открытая стоянка транспорта', short: 'Открытая стоянка', t5: 'parking_open' },
        { id: 't5_garage', label: 'Гаражи (боксы)', short: 'Гараж', t5: 'garage_box' },
        { id: 't5_admin', label: 'Помещение охраны стоянки, гаража', short: 'Помещение охраны', t5: 'parking_admin' },
        { id: 't5_garage_terr', label: 'Территория гаража', short: 'Территория гаража', t5: 'garage_territory' },
        { id: 't5_azs_big', label: 'АЗС: 500 и более заправок в сутки', short: 'АЗС', t5: 'azs_big' },
        { id: 't5_azs_small', label: 'АЗС: менее 500 заправок в сутки', short: 'АЗС', t5: 'azs_small' },
        { id: 't5_azs_shop', label: 'Операторная, магазин, кафе при АЗС', short: 'Магазин при АЗС', t5: 'azs_shop' },
        { id: 't5_kiosk', label: 'Отдельный павильон, киоск', short: 'Киоск', t5: 'kiosk' },
        { id: 't5_builtin_trade', label: 'Встроенный магазин, кафе, аптека, салон', short: 'Встроенный магазин', t5: 'builtin_trade' },
        { id: 't5_builtin_office', label: 'Встроенный офис, зал, клуб, мастерская', short: 'Встроенный офис', t5: 'builtin_office' }
      ]
    },
    {
      group: 'Другое', items: [
        { id: 'custom', label: 'Другое (задать вручную)', short: 'Помещение', category: 'PUB', classes: ['A'] }
      ]
    }
  ];

  const BY_ID = {};
  PURPOSE_GROUPS.forEach(function (g) { g.items.forEach(function (p) { BY_ID[p.id] = p; }); });

  // quick — назначения на кнопках быстрого добавления; первое подставляется в новую строку.
  const BUILDING_KINDS = [
    { id: 'public', label: 'Общественное', hint: 'офисы, школы, больницы, торговые центры, гостиницы',
      quick: ['office', 'corridor', 'storeroom', 'server', 'electro', 'hall'] },
    { id: 'industrial', label: 'Производственное', hint: 'цеха, мастерские, котельные',
      quick: ['workshop', 'store_solid', 'store_liquid', 'electro', 'office', 'storeroom'] },
    { id: 'warehouse', label: 'Складское', hint: 'склады, базы, хранилища',
      quick: ['store_solid', 'store_liquid', 'office', 'electro', 'storeroom'] }
  ];
  BUILDING_KINDS.forEach(function (k) { k.purpose = k.quick[0]; });

  function shortName(purposeId) { return (BY_ID[purposeId] || BY_ID.custom).short; }

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
      name: '', area: '', count: 1, length: '', width: '', autoSuppression: false
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
                r('Кладовая', 'storeroom', 10, { count: 4 }),
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
    applyPurpose: applyPurpose, blankRoom: blankRoom, shortName: shortName
  };
}));
