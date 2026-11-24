'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ru = require('../js/library.js');
const kk = require('../js/library-kk.js');

const KK_LETTERS = /[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/;

function texts(item) {
  const out = [];
  (item.text || []).forEach(function (t) { out.push(t); });
  (item.head || []).forEach(function (t) { out.push(t); });
  (item.rows || []).forEach(function (r) { r.forEach(function (t) { out.push(t); }); });
  return out;
}

test('казахский справочник: те же документы и пункты, что в русском', function () {
  assert.deepStrictEqual(kk.map(function (d) { return d.id; }), ru.map(function (d) { return d.id; }));
  ru.forEach(function (d, i) {
    assert.deepStrictEqual(
      kk[i].items.map(function (x) { return x.ref; }),
      d.items.map(function (x) { return x.ref; }),
      d.id
    );
  });
});

test('казахский справочник: нет пустых текстов', function () {
  kk.forEach(function (d) {
    assert.ok(d.title && d.short && d.doc, d.id);
    d.items.forEach(function (it) {
      const t = texts(it);
      assert.ok(t.length > 0, d.id + ' ' + it.ref);
      t.forEach(function (s) { assert.ok(typeof s === 'string' && s.trim().length > 0, d.id + ' ' + it.ref); });
    });
  });
});

test('казахский справочник: форма таблиц совпадает с русской', function () {
  ru.forEach(function (d, i) {
    d.items.forEach(function (it, j) {
      const k = kk[i].items[j];
      if (it.rows) {
        assert.strictEqual(k.rows.length, it.rows.length, d.id + ' ' + it.ref);
        assert.strictEqual(k.head.length, it.head.length, d.id + ' ' + it.ref);
        k.rows.forEach(function (r, n) { assert.strictEqual(r.length, it.rows[n].length); });
      } else {
        assert.strictEqual(k.text.length, it.text.length, d.id + ' ' + it.ref);
      }
    });
  });
});

test('казахский справочник: у каждого казахского документа есть источник', function () {
  assert.ok(Array.isArray(kk.sources) && kk.sources.length > 0);
  const ids = {};
  kk.sources.forEach(function (s) {
    assert.ok(/^https:\/\//.test(s.url), s.id);
    assert.ok(/^\d{2}\.\d{2}\.\d{4}$/.test(s.edition), s.id);
    ids[s.id] = true;
  });
  kk.forEach(function (d) {
    if (d.lang !== 'ru') assert.ok(ids[d.id], 'нет источника: ' + d.id);
  });
});

test('казахский справочник: казахские пункты содержат казахские буквы, русские помечены', function () {
  kk.forEach(function (d) {
    d.items.forEach(function (it) {
      const joined = texts(it).join(' ');
      if (it.lang === 'ru') {
        assert.ok(d.note && KK_LETTERS.test(d.note), 'нет казахской пометки: ' + d.id);
      } else {
        assert.ok(KK_LETTERS.test(joined), 'нет казахских букв: ' + d.id + ' ' + it.ref);
      }
    });
  });
});

test('казахский справочник: ГОСТ и СТ РК остались русскими, Правила и регламент казахские', function () {
  const byId = {};
  kk.forEach(function (d) { byId[d.id] = d; });
  ['st1487', 'g26', 'g28130', 'g30612'].forEach(function (id) { assert.strictEqual(byId[id].lang, 'ru', id); });
  ['ppb', 'app2', 'app3', 'tr405'].forEach(function (id) { assert.notStrictEqual(byId[id].lang, 'ru', id); });
});
