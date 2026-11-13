// Шрифт отчёта для pdfmake: Tinos — метрический аналог Times New Roman (SIL OFL,
// vendor/fonts/Tinos-OFL.txt), в подмножестве знаков: латиница, кириллица с казахскими
// буквами, пунктуация. Собирает vendor/vfs_report.js из vendor/fonts/Tinos-*.ttf.
//
//   node tools/make-pdf-fonts.js
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'vendor');
const files = ['Tinos-Regular.ttf', 'Tinos-Bold.ttf'];
const entries = files.map(function (name) {
  return '    ' + JSON.stringify(name) + ': ' + JSON.stringify(fs.readFileSync(path.join(dir, 'fonts', name)).toString('base64'));
});
const out = '// Шрифт отчёта для pdfmake: Tinos (SIL OFL, vendor/fonts/Tinos-OFL.txt).\n' +
  '// Собран tools/make-pdf-fonts.js из vendor/fonts/Tinos-*.ttf; вручную не правится.\n' +
  '(function (root) {\n' +
  '  root.pdfMake = root.pdfMake || {};\n' +
  '  root.pdfMake.vfs = Object.assign(root.pdfMake.vfs || {}, {\n' + entries.join(',\n') + '\n  });\n' +
  '}(typeof self !== \'undefined\' ? self : this));\n';
fs.writeFileSync(path.join(dir, 'vfs_report.js'), out);
console.log('vendor/vfs_report.js — ' + out.length + ' байт');
