// Окружение Node для vendor/tesseract: Worker поверх worker_threads и сервер языковых файлов.
// Возвращает { Tesseract, base, close }, base - адрес сервера с файлами vendor/tesseract.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { Worker: NodeWorker } = require('node:worker_threads');

const VENDOR = path.join(__dirname, '..', 'vendor', 'tesseract');

function installWorker() {
  if (global.Worker && global.Worker.__ocrShim) return;
  if (typeof global.self === 'undefined') global.self = global;
  function ShimWorker(file) {
    const self = this;
    this.onmessage = null;
    this.onerror = null;
    this._w = new NodeWorker(path.join(__dirname, 'ocr-node-worker.js'), { workerData: { path: file } });
    this._w.on('message', function (d) { if (self.onmessage) self.onmessage({ data: d }); });
    this._w.on('error', function (e) { if (self.onerror) self.onerror(e); });
  }
  ShimWorker.prototype.postMessage = function (m) { this._w.postMessage(m); };
  ShimWorker.prototype.terminate = function () { return this._w.terminate(); };
  ShimWorker.__ocrShim = true;
  global.Worker = ShimWorker;
}

function serve() {
  return new Promise(function (resolve, reject) {
    const srv = http.createServer(function (req, res) {
      const f = path.join(VENDOR, decodeURIComponent(req.url.split('?')[0]));
      if (f.indexOf(VENDOR) !== 0 || !fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
      res.end(fs.readFileSync(f));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', function () {
      resolve({ srv: srv, base: 'http://127.0.0.1:' + srv.address().port + '/' });
    });
  });
}

async function setup() {
  installWorker();
  const s = await serve();
  const Tesseract = require(path.join(VENDOR, 'tesseract.min.js'));
  return { Tesseract: Tesseract, base: s.base, vendor: VENDOR, close: function () { s.srv.close(); } };
}

module.exports = { setup: setup, VENDOR: VENDOR };
