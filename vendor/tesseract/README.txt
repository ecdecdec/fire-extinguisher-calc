tesseract.js 7.0.0 и tesseract.js-core 7.0.0 (Apache-2.0), данные языков из tessdata_fast (Apache-2.0).
Нужны только для js/vision-ocr.js, грузятся при первом чтении надписей. Из сети ничего не берётся.

tesseract.min.js          основной скрипт (подключается страницей или фоновым потоком)
worker.min.js             рабочий поток распознавания
core/tesseract-core-simd-lstm.wasm.js   ядро с SIMD (wasm внутри файла), выбирается, если устройство умеет SIMD
core/tesseract-core-lstm.wasm.js        ядро без SIMD, запасное
lang/rus.traineddata.gz   русский (tessdata_fast, сжат gzip; tesseract.js распаковывает сам)
lang/kaz.traineddata.gz   казахский, по запросу (opts.langs: 'rus+kaz')

Пути: workerPath, corePath и langPath задаёт js/vision-ocr.js (opts.base или opts.paths).
Релаксированное SIMD-ядро (relaxedsimd) не включено: corePath указывает на конкретный файл.
Лицензии: LICENSE-*.txt, NOTICE-bundled.txt (библиотеки внутри сборки).
