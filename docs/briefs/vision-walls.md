# Задание: строение стен и улица (этапы 2.3 и 2.4 плана)

Model: Gemini 4 Neon (XHigh). Branch: vision-walls (made from main after the vision-ink and bench branches are merged). Read docs/briefs/common.md, docs/audit/scanner.md (sections 2, 3, 6) and the bench tool (tools/bench-vision.js, tools/synth-plans.js) first.

Goal: after the new ink stage, the walls themselves must be understood: which lines are walls, where the doors are, and what is outside the building. Measure everything with `node tools/bench-vision.js` (synthetic and real suites) before and after; the real-suite "junk" and the synthetic F1 must improve without making the clean variants worse.

Problems to solve (see the bench variants with the same names):
1. Hollow walls (two parallel thin lines, БТИ style): the space between the lines becomes a narrow fake room. Detect pairs of parallel line segments 0.08 to 0.65 m apart (use the dominant spacing on the plan) and fill them as wall.
2. Windows drawn as three parallel lines in an outer wall: treat as wall.
3. Hatching, floor tile grids, stair treads: regular patterns of thin parallel lines inside a room are not walls (they cut halls into pieces now: see bench/vision/img/arch-modern-grid.png).
4. Dimension lines with ticks and numbers outside the building, sheet frames, title blocks and legend tables: not walls and never rooms (the legend cells become rooms now: evac-ru-kdc-1, evac-de-1, arch-dims-lines).
5. Doors: a door leaf with a quarter-circle swing arc, or a gap between two wall ends 0.6 to 1.4 m wide, is a door. Close it with a virtual line before splitting rooms, so a small toilet (0.85 x 1.2 m, door 0.7 m) is its own room and not part of the corridor (variant toilets).
6. Outside: the street must not flood the building through a wide entrance (variant open-plan, real plan apartment-color-furniture: 3 rooms found instead of about 15). Close gaps in the outer outline up to about 4 m before flooding from the image edge; pockets between buttresses or wall stubs outside the outline are outside, not rooms (variant stubs, real plan red-walls-scalebar).
7. Several buildings on one sheet: each is a building (variant two-buildings); no single 20 % threshold that drops the annex.
8. Room splitting: keep the depth idea of `segment`, but store the opening depth per pair of neighbouring regions instead of one value per region (docs/audit/scanner.md section 3.1, item 4), so a corridor wing is not starved of seeds.

Keep the public API of js/vision.js (`findRooms`, `scaleFromArea`, `scaleFromLength`, `roundAreas`, `looksLikeCorridor`) and its result format. Add per-room `confidence` (0 to 1) and `flags` (short codes like 'merged?', 'cavity?', 'outside?') to each room in the result; the interface will use them later. Memory and time: no worse than now on a 1600 x 1200 picture (report numbers).

Add tests for each problem above (small synthetic pictures in tests/), keep all existing tests passing, and run `node tools/vision-gallery.js` to report found vs expected per real plan before and after.

Change js/vision.js and tests only (a new helper module js/vision-walls.js is fine if vision.js gets too big; then add it to vision.worker.js importScripts and say so in the report, the owner will add it to sw.js ASSETS).
