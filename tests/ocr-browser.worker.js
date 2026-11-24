// Фоновый поток для проверки чтения надписей: tesseract запускается вложенным потоком.
importScripts('../js/vision.js', '../js/presets.js', '../vendor/tesseract/tesseract.min.js', '../js/vision-ocr.js', '../tools/synth-plans.js', 'ocr-browser.js');
self.onmessage = function (e) {
  self.ocrBrowserRun(e.data.origin).then(function (r) { self.postMessage({ ok: true, result: r }); },
    function (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); });
};
