# Задание: стенд для проверки распознавания (этап 0.4 плана)

Model: Gemini 4 Neon (XHigh). Branch: bench. Read docs/briefs/common.md first and follow it.

Goal: a repeatable benchmark that tells, with numbers, whether a change to js/vision.js made recognition better or worse.

Create:
1. tools/synth-plans.js (UMD or CommonJS module, no DOM): a deterministic generator of synthetic floor plans with exact ground truth. API: `make(variant, seed, opts)` returns `{ rgba: Uint8ClampedArray, w, h, scale /* px per metre */, rooms: [{ name, poly: [[x,y],...] /* px, inner wall faces */, area /* m2 */ }], meta }`, plus `VARIANTS` (list of names). Draw with anti-aliasing (partial pixel coverage). Variants, each a realistic case the recognizer must handle:
   - clean: black filled walls 0.2 to 0.5 m, doors as gaps;
   - hollow: walls drawn as two thin parallel lines (БТИ/техпаспорт style), with room numbers and areas printed inside rooms as digits (use a small built-in bitmap font, digits and comma only), dimension lines with ticks outside the building;
   - door-arcs: door leaves with quarter-circle swing arcs drawn in thin lines;
   - windows: windows in outer walls drawn as three thin parallel lines;
   - furniture: apartment with beds, sofas, kitchen counter, bathtub drawn in thin lines, some touching walls;
   - toilets: small rooms 0.85 x 1.2 m with 0.7 m doors next to a corridor;
   - open-plan: one large room with an entrance 4 m wide to the outside and a column;
   - stubs: outer wall with buttresses or wall stubs sticking out 0.5 to 1 m;
   - gray-walls: walls filled with neutral mid-gray (about 190 on 245 paper);
   - colored-walls: walls in dark red, dark brown or dark blue;
   - evacuation: pastel room fills, green arrows along corridors, red square fire signs, a "you are here" dot, a title text block above, a legend table with cells at the side, a sheet frame;
   - sheet: architectural sheet with frame and a title block (штамп) grid at the bottom right;
   - photo: any of the above, warped by a perspective transform (tilt up to 30 degrees), with a background around the sheet, a glare blob, a shadow gradient (up to 4:1), a warm colour cast (paper about 240,220,170) and noise;
   - lowres: rendered at 4 to 6 px per metre;
   - tight: cropped to 0.2 m around the outer walls;
   - two-buildings: a main building and a smaller annex on one sheet.
   Ground-truth polygons must be in the coordinates of the final image (after perspective warp, apply the same transform to the polygons; the true area in m2 stays the same).
2. tools/bench-vision.js: runs `require('../js/vision.js').findRooms` the same way js/app.js runBp does (by scale, or by total floor area in two passes) and prints a table:
   - synthetic suite (every variant x 3 seeds): matched rooms by IoU >= 0.5 (rasterize polygons in pure JS), precision, recall, F1, rooms split and merged, median and P90 area error in percent, an "underestimated area" share (rooms whose area came out more than 10 % too small: dangerous, fewer extinguishers), time per plan;
   - real suite (bench/vision/expect.json): found vs expected room count with the expected range, and "junk": found rooms whose label point (lx, ly) lies outside the labelled main_plan_box (fractions of the image) expanded by 3 %; skip entries with plan: false;
   - totals per variant and per kind, and an overall score. Write bench/vision/out/bench.json. If bench/vision/baseline.json exists, print the change against it per line and overall; `--save-baseline` writes the current result there.
   It must run in under 5 minutes on a normal PC. Options: `--only <variant>` and `--real` / `--synth`.
3. tests/synth.test.js: the generator is deterministic for a seed, ground-truth areas are positive and polygons lie inside the image, and the clean variant is recognized by the current js/vision.js with F1 = 1 (sanity check of the bench itself).

Do not modify js/vision.js, js/app.js or any existing test. When done, run `node tools/bench-vision.js --save-baseline` and commit bench/vision/baseline.json too (it is small JSON, it may be committed; bench/vision/out must not be).

In the final report, list the baseline numbers per variant (synthetic) and the totals for the real suite, and name the five weakest variants.
