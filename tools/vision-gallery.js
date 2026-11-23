// Прогон распознавания плана по набору картинок и страница для просмотра результата глазами.
//
//   node tools/vision-gallery.js [имя ...]
//
// Берёт картинки из bench/vision/img/*.png (их скачивает и готовит отдельный шаг, в git они
// не хранятся), подсказки масштаба из bench/vision/expect.json и прогоняет js/vision.js так же,
// как приложение (js/app.js, runBp): по масштабу один проход, по площади этажа два.
// Пишет bench/vision/out/results.json и bench/vision/out/index.html: каждый план с контурами
// найденных помещений, их номерами и площадями.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const V = require('../js/vision.js');
const { readPng } = require('../tests/helpers.js');

const DIR = path.join(__dirname, '..', 'bench', 'vision');
const OUT = path.join(DIR, 'out');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// Как runBp в js/app.js: масштаб по отрезку (scale) или по площади этажа (areaM2).
function recognize(pic, hint) {
  if (hint.scale > 0) {
    const out = V.findRooms(pic.rgba, pic.w, pic.h, { scale: hint.scale });
    return { scale: hint.scale, out: out, passes: 1 };
  }
  if (hint.areaM2 > 0) {
    const first = V.findRooms(pic.rgba, pic.w, pic.h, { areaM2: hint.areaM2 });
    const s1 = V.scaleFromArea(first.rooms, hint.areaM2);
    if (!(s1 > 0)) return { scale: 0, out: first, passes: 1 };
    const out = V.findRooms(pic.rgba, pic.w, pic.h, { scale: s1 });
    return { scale: V.scaleFromArea(out.rooms, hint.areaM2) || s1, out: out, passes: 2 };
  }
  return { scale: 0, out: V.findRooms(pic.rgba, pic.w, pic.h, {}), passes: 1 };
}

function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#ff7f0e', '#7f7f7f'];

function card(id, src, hint, res) {
  const rooms = res ? res.rooms : [];
  const font = Math.max(10, Math.round(Math.max(src.w, src.h) / 70));
  const polys = rooms.map(function (r, i) {
    const pts = r.poly.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    return '<polygon points="' + pts + '" fill="' + COLORS[i % COLORS.length] + '" fill-opacity="0.32" stroke="' + COLORS[i % COLORS.length] + '" stroke-width="' + Math.max(1, font / 6) + '"/>' +
      '<text x="' + r.lx + '" y="' + r.ly + '" font-size="' + font + '" text-anchor="middle" paint-order="stroke" stroke="#fff" stroke-width="' + font / 4 + '">' + r.id + (r.area ? ' ' + r.area + ' м²' : '') + '</text>';
  }).join('');
  const expect = hint.rooms ? hint.rooms : '?';
  const stat = res ? ('найдено ' + rooms.length + ', ожидается ' + expect + ', масштаб ' + (res.scale ? res.scale.toFixed(1) + ' т/м' : 'нет') + ', ' + res.ms + ' мс') : 'ошибка: ' + esc(hint.error || '');
  return '<section id="' + esc(id) + '"><h2>' + esc(id) + ' <small>' + esc(src.kind || '') + '</small></h2>' +
    '<p>' + stat + (hint.note ? '<br>' + esc(hint.note) : '') + '</p>' +
    '<div class="pic"><img src="../img/' + esc(id) + '.png" alt=""><svg viewBox="0 0 ' + src.w + ' ' + src.h + '">' + polys + '</svg></div>' +
    '<p class="src"><a href="' + esc(src.page || '#') + '">' + esc(src.title || id) + '</a>. ' + esc(src.author || '') + '. ' + esc(src.license || '') + '</p></section>';
}

function main() {
  const only = process.argv.slice(2);
  const sources = readJson(path.join(DIR, 'sources.json'), {});
  const expect = readJson(path.join(DIR, 'expect.json'), {});
  const prev = readJson(path.join(OUT, 'results.json'), {});
  fs.mkdirSync(OUT, { recursive: true });
  const ids = Object.keys(sources).filter(function (id) { return !only.length || only.indexOf(id) >= 0; });
  const results = Object.assign({}, prev);
  ids.forEach(function (id) {
    const hint = expect[id] || {};
    try {
      const pic = readPng(path.join(DIR, 'img', id + '.png'));
      const r = recognize(pic, hint);
      const areas = r.scale ? V.roundAreas(r.out.rooms, r.scale) : r.out.rooms.map(function () { return 0; });
      results[id] = {
        scale: r.scale, passes: r.passes, ms: r.out.ms, found: r.out.rooms.length, expected: hint.rooms || null,
        total: Math.round(areas.reduce(function (a, b) { return a + b; }, 0) * 10) / 10,
        rooms: r.out.rooms.map(function (room, i) {
          return { id: room.id, area: areas[i], px: room.px, lx: room.lx, ly: room.ly, bbox: room.bbox, poly: room.poly };
        })
      };
      console.log(id.padEnd(28) + ' найдено ' + String(results[id].found).padStart(3) + '  ожидается ' + String(hint.rooms || '?').padStart(3) + '  ' + r.out.ms + ' мс');
    } catch (e) {
      results[id] = { error: String(e && e.message || e) };
      console.log(id.padEnd(28) + ' ошибка: ' + results[id].error);
    }
  });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results));
  const cards = Object.keys(sources).map(function (id) {
    const res = results[id] && !results[id].error ? results[id] : null;
    return card(id, sources[id], Object.assign({}, expect[id] || {}, results[id] && results[id].error ? { error: results[id].error } : {}), res);
  }).join('\n');
  const html = '<!doctype html><meta charset="utf-8"><title>Распознавание планов</title>' +
    '<style>body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#111}section{margin:0 0 32px}h2{font-size:16px;margin:0 0 4px}' +
    'small{color:#666;font-weight:400}.pic{position:relative;max-width:1000px}.pic img{display:block;width:100%}' +
    '.pic svg{position:absolute;inset:0;width:100%;height:100%}.src{color:#666;font-size:12px}</style>' +
    '<h1>Распознавание планов: ' + Object.keys(sources).length + ' картинок</h1>' + cards;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log('страница: ' + path.join(OUT, 'index.html'));
}

main();
