// Фоновый поток для Node: запускает vendor/tesseract/worker.min.js так, как его запускает браузер.
// Нужен только тестам: в Node нет Worker и importScripts, а пакет tesseract.js не установлен.
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const fs = require('node:fs');

global.self = global;
global.location = { href: 'file:///tesseract-core.js' };
global.WorkerGlobalScope = function WorkerGlobalScope() {};
global.addEventListener = function (type, fn) {
  if (type === 'message') parentPort.on('message', function (d) { fn({ data: d }); });
};
global.postMessage = function (m) { parentPort.postMessage(m); };
global.importScripts = function (file) {
  const code = fs.readFileSync(file, 'utf8');
  const mod = { exports: {} };
  const fn = vm.runInThisContext('(function (module, exports, require) {' + code + '\n})', { filename: file });
  fn(mod, mod.exports, require);
  if (mod.exports && (typeof mod.exports === 'function' || typeof mod.exports === 'object') && Object.keys(mod.exports).length + (typeof mod.exports === 'function' ? 1 : 0)) {
    global.TesseractCore = mod.exports;
  }
};
vm.runInThisContext(fs.readFileSync(workerData.path, 'utf8'), { filename: workerData.path });
