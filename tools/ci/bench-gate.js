// Порог стенда распознавания для CI: сравнивает bench/vision/out/bench.json
// с bench/vision/baseline.json и завершается с ошибкой, если балл упал больше чем на 2 пункта.
//   node tools/ci/bench-gate.js [--max-drop 2]
// Сравниваются те части, которые есть в обоих файлах: синтетика (macro F1, в пунктах из 100)
// и реальные планы (средний score, в пунктах из 100). Прогон только синтетики
// (`node tools/bench-vision.js --synth`) проверяет только синтетику.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'bench', 'vision');
const args = process.argv.slice(2);
const i = args.indexOf('--max-drop');
const rawDrop = i >= 0 ? args[i + 1] : '2';
const maxDrop = (typeof rawDrop === 'string' && rawDrop.trim() !== '') ? Number(rawDrop) : NaN;
if (!Number.isFinite(maxDrop) || maxDrop < 0) { console.error('Неверное значение --max-drop'); process.exit(2); }

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.error('Не прочитан ' + file + ': ' + e.message);
    process.exit(2);
  }
}

const now = read(path.join(DIR, 'out', 'bench.json'));
const base = read(path.join(DIR, 'baseline.json'));

function pick(report, part) {
  const p = report && report[part] && report[part].total;
  if (!p) return null;
  const v = part === 'synth' ? p.macroF1 : p.score;
  return typeof v === 'number' ? v * 100 : null;
}

const parts = [['synth', 'Синтетика (macro F1)'], ['real', 'Реальные планы (score)']];
let checked = 0, failed = 0;
function checkScore(label, a, b) {
  if (a === null || b === null) return;
  checked += 1;
  const drop = b - a;
  const bad = drop > maxDrop + 1e-9;
  if (bad) failed += 1;
  console.log((bad ? 'FAIL  ' : 'PASS  ') + label + ': ' + a.toFixed(2) + ' (базовый замер ' + b.toFixed(2) +
    ', разница ' + (a - b >= 0 ? '+' : '') + (a - b).toFixed(2) + ', допустимое падение ' + maxDrop + ')');
}

parts.forEach(function (it) {
  checkScore(it[1], pick(now, it[0]), pick(base, it[0]));
});

if (now && now.synth && now.real && base && base.synth && base.real &&
    now.overall && typeof now.overall.score === 'number' &&
    base.overall && typeof base.overall.score === 'number') {
  checkScore('Общий балл (overall)', now.overall.score, base.overall.score);
}

if (!checked) { console.error('Нечего сравнивать: в bench.json и baseline.json нет общих частей'); process.exit(2); }
if (failed) { console.error('Распознавание стало хуже базового замера больше чем на ' + maxDrop + ' п.'); process.exit(1); }
console.log('Стенд не хуже базового замера.');
