# Задание: чтение надписей на плане (этап 2.5 плана)

Model: Gemini 4 Neon (XHigh). Branch: vision-ocr (from main). Read docs/briefs/common.md, AGENTS.md, docs/plan.md item 2.5, docs/audit/scanner.md section 4 (rank 7) first. Network allowed for downloading tesseract.js files. Do not modify js/vision.js (use its exports read-only).

Goal: on БТИ and техпаспорт plans every room has its area printed («15,6», «22 qm», «14,2 м²») and often its name. Reading them on the device gives the scale without any input and cross-checks every computed area. Room names fill the purpose automatically.

1. Vendor tesseract.js (Apache-2.0) for fully offline use: worker script, core wasm (SIMD with a non-SIMD fallback), language data rus and kaz (tessdata_fast first; report sizes; total budget 8 MB, loaded only on first use). Put them in vendor/tesseract/ with their licence files. Nothing may be fetched from a CDN at run time: set workerPath, corePath and langPath to the vendored files.
2. js/vision-ocr.js (UMD like js/vision.js, works in the browser, in a Web Worker and in Node):
   - `findTextBoxes(rgba, w, h, rooms)`: text candidates inside each room polygon: small dark components grouped into lines by proximity and baseline (you may call FireVision `_inkMask` and `_components`), each box padded and returned with its room id;
   - `readLabels(rgba, w, h, rooms, opts)` returns a Promise of `[{ roomId, texts: [{ text, conf, box }], area, unit, name }]`: OCR on the cropped boxes only (never the whole sheet), area parsed from numbers like 15,6 / 15.6 / 22 qm / 14,2 м² / 120 sq ft (convert to m²), name matched against known purposes when it is a word;
   - `scaleFromLabels(rooms, labels)` returns `{ scale, inliers, spread }`: robust estimate of pixels per metre from rooms that have a printed area (median or RANSAC of sqrt(px / area)), with the share of inliers and the spread; `null` when fewer than 3 rooms agree.
3. Tests (tests/vision-ocr.test.js, Node): the БТИ-style synthetic variant from tools/synth-plans.js (hollow) prints areas in its bitmap font: the scale from labels is within 2 % of the true scale and at least 80 % of printed areas are read; bench/vision/img/round-house-areas.png (areas printed as «22 qm» etc.): report what is read. Keep tests reasonably fast (cache the worker; skip with a clear message if the wasm cannot start in this Node version, but say so in the report).
4. Report: sizes of vendored files, time per plan, recognition rate, what fails (rotated text, fractions «№/S», stamps).

Do not register the files in index.html or sw.js; the new app (phase B) will load them lazily. Document the API at the top of js/vision-ocr.js.
