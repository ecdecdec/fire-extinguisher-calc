// Формирует PDF-отчёты для встроенных примеров без браузера — чтобы быстро
// посмотреть, как выглядит отчёт после правок.
//
//   node tools/sample-pdf.js [папка]      (по умолчанию ./out)
//
// QR-код в образцах ведёт на example.kz: длина ссылки настоящая, адрес — нет.
// В PDF, сформированном на сайте, в коде стоит адрес самого сайта.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pdfMake = require(path.join(root, 'vendor', 'pdfmake.min.js'));
pdfMake.vfs = require(path.join(root, 'vendor', 'vfs_fonts.js')).pdfMake.vfs;
const E = require(path.join(root, 'js', 'engine.js'));
const P = require(path.join(root, 'js', 'presets.js'));
const PL = require(path.join(root, 'js', 'plan.js'));
const R = require(path.join(root, 'js', 'report.js'));
const SH = require(path.join(root, 'js', 'share.js'));

const outDir = path.resolve(process.argv[2] || path.join(root, 'out'));
fs.mkdirSync(outDir, { recursive: true });

const now = new Date();
const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

Object.keys(P.EXAMPLES).forEach(async function (key) {
  const input = P.EXAMPLES[key].build();
  input.building.inspector = 'Иванов И. И., инспектор';
  input.building.date = today;
  // у производственной базы схема открыта, чтобы в отчёт попала расстановка по нормам
  if (key === 'factory') input.floors.forEach(function (f, fi) { f.rooms.forEach(function (r, ri) { r.id = 'x' + fi + '_' + ri; }); f.plan = { open: true, ext: [] }; });
  const result = E.calculate(input);
  const audit = PL.audit(input, result);
  const link = 'https://example.kz/#o=' + await SH.encode(input);
  const meta = { generatedAt: now, audit: audit, schemes: PL.schemes(input, result, audit), link: link };
  const file = path.join(outDir, key + '.pdf');
  pdfMake.createPdf(R.buildDoc(result, meta)).getBuffer(function (buffer) {
    fs.writeFileSync(file, Buffer.from(buffer));
    console.log(file + ' — ' + buffer.length + ' байт; итог: ' +
      result.totals.map(function (t) { return t.count + ' × ' + t.code; }).join(', '));
  });
});
