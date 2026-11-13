// Пример плана этажа для показа распознавания: план эвакуации школы, 60 × 21 м.
// Пишет examples/plan-school.svg (исходник) и examples/plan-school.json (масштаб и
// площади помещений по внутренним граням стен — для проверки распознавания).
// PNG делается снимком SVG в браузере при масштабе 1:1 (1300 × 580 точек).
//
//   node tools/make-example-plan.js
const fs = require('node:fs');
const path = require('node:path');

const S = 20, ML = 50, MT = 70, W = 1300, H = 580; // точек на метр, поля, размер картинки
const X = m => ML + m * S, Y = m => MT + m * S;
const TOP = [[0, 'Каб. 101'], [9, 'Каб. 102'], [18, 'Каб. 103'], [27, 'Учительская'], [33, 'Серверная'], [37, 'Санузел'], [40, 'Каб. 104'], [49, 'Каб. 105'], [60]];
const BOTTOM = [[0, 'Актовый зал'], [18, 'Лестница'], [23, 'Каб. 106'], [32, 'Каб. 107'], [41, 'Щитовая'], [45, 'Кладовая'], [49, 'Библиотека'], [60]];

const parts = [], rooms = [];
const rect = (x0, y0, x1, y1, fill) => parts.push('<rect x="' + X(x0) + '" y="' + Y(y0) + '" width="' + (x1 - x0) * S + '" height="' + (y1 - y0) * S + '" fill="' + fill + '" shape-rendering="crispEdges"/>');
const text = (x, y, size, str, fill, weight) => parts.push('<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + (fill || '#222') + '" font-weight="' + (weight || 400) + '" text-anchor="middle" font-family="Arial, sans-serif">' + str + '</text>');
const fmt = a => (Math.round(a * 10) / 10).toFixed(1).replace('.', ',');

// стены
rect(0, 0, 60, 0.5, '#111'); rect(0, 20.5, 60, 21, '#111'); rect(0, 0, 0.5, 21, '#111'); rect(59.5, 0, 60, 21, '#111');
rect(0, 8.9, 60, 9.1, '#111'); rect(0, 11.9, 60, 12.1, '#111');
TOP.slice(1, -1).forEach(([x]) => rect(x - 0.1, 0, x + 0.1, 9, '#111'));
BOTTOM.slice(1, -1).forEach(([x]) => rect(x - 0.1, 12, x + 0.1, 21, '#111'));
// двери в коридор (1 м) и выходы в торцах (1,5 м)
const door = (c, y0, y1) => rect(c - 0.5, y0, c + 0.5, y1, '#fff');
for (let i = 0; i + 1 < TOP.length; i++) door((TOP[i][0] + TOP[i + 1][0]) / 2, 8.9, 9.1);
for (let i = 0; i + 1 < BOTTOM.length; i++) door((BOTTOM[i][0] + BOTTOM[i + 1][0]) / 2, 11.9, 12.1);
rect(0, 9.75, 0.5, 11.25, '#fff'); rect(59.5, 9.75, 60, 11.25, '#fff');

// подписи помещений и площади (как в техпаспорте)
function label(xs, row) {
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i][0] === 0 ? 0.5 : xs[i][0] + 0.1, b = xs[i + 1][0] === 60 ? 59.5 : xs[i + 1][0] - 0.1;
    const area = (b - a) * 8.4, cx = X((xs[i][0] + xs[i + 1][0]) / 2), cy = Y(row ? 16.2 : 4.2);
    text(cx, cy, 14, xs[i][1]);
    text(cx, cy + 20, 13, fmt(area) + ' м²', '#444');
    rooms.push({ name: xs[i][1], area: Math.round(area * 100) / 100, row: row ? 'bottom' : 'top' });
  }
}
label(TOP, 0);
const corridor = { name: 'Коридор', area: Math.round(59 * 2.8 * 100) / 100, row: 'corridor' };
// знаки огнетушителей (красные) и стрелки эвакуации (зелёные) — цветное распознавание пропускает
[[4.5, 2], [22.5, 2], [44.5, 2], [9, 18.5], [36.5, 18.5], [54.5, 18.5]].forEach(([x, y]) => {
  parts.push('<rect x="' + (X(x) - 9) + '" y="' + (Y(y) - 9) + '" width="18" height="18" rx="2" fill="#d32f2f"/>');
  parts.push('<text x="' + X(x) + '" y="' + (Y(y) + 4) + '" font-size="10" fill="#fff" text-anchor="middle" font-family="Arial">ОП</text>');
});
parts.push('<path d="M' + X(29) + ' ' + Y(10.5) + ' H' + X(2) + ' M' + X(31) + ' ' + Y(10.5) + ' H' + X(58) + '" stroke="#1b8a3a" stroke-width="4" fill="none"/>');
parts.push('<path d="M' + X(2) + ' ' + Y(10.5) + ' l14 -8 v16 z M' + X(58) + ' ' + Y(10.5) + ' l-14 -8 v16 z" fill="#1b8a3a"/>');
text(X(30), Y(10.5) + 5, 14, 'Коридор', '#222');
label(BOTTOM, 1);
// улица: заголовок, выходы, масштабная линейка, условные обозначения
text(W / 2, 40, 22, 'План эвакуации · 1 этаж · Школа (пример)', '#111', 700);
text(X(-1.2), Y(10.5) - 26, 13, 'Выход', '#1b8a3a', 700);
text(X(61.2), Y(10.5) - 26, 13, 'Выход', '#1b8a3a', 700);
parts.push('<rect x="' + ML + '" y="' + (H - 40) + '" width="' + 10 * S + '" height="6" fill="#111" shape-rendering="crispEdges"/>');
parts.push('<text x="' + (ML + 10 * S + 12) + '" y="' + (H - 32) + '" font-size="14" fill="#111" font-family="Arial">10 м</text>');
parts.push('<text x="' + (W - ML) + '" y="' + (H - 32) + '" font-size="13" fill="#444" text-anchor="end" font-family="Arial">ОП — огнетушитель   ⟶ путь эвакуации</text>');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
  '<rect width="' + W + '" height="' + H + '" fill="#fff"/>' + parts.join('') + '</svg>\n';
const dir = path.join(__dirname, '..', 'examples');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'plan-school.svg'), svg);
const ordered = rooms.filter(r => r.row === 'top').concat([corridor], rooms.filter(r => r.row === 'bottom'));
fs.writeFileSync(path.join(dir, 'plan-school.json'), JSON.stringify({
  title: 'План эвакуации школы (пример)', w: W, h: H, scale: S,
  rooms: ordered.map(r => ({ name: r.name, area: r.area }))
}, null, 2) + '\n');
console.log('examples/plan-school.svg и .json: ' + ordered.length + ' помещений, ' +
  Math.round(ordered.reduce((s, r) => s + r.area, 0)) + ' м², масштаб ' + S + ' точек на метр');
