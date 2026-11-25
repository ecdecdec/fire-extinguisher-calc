# Задание: коридор вдоль наружной стены, доводка по стенду

Model: Gemini 4 Neon (XHigh). Branch: vision-corridor. Read docs/briefs/common.md first, then the last commit on this branch (`git show HEAD~1 -- js/vision.js tests/vision.test.js`): Claude already made the main change, your job is to finish it.

## What is already done (last commits on this branch)

On evacuation plans the outer wall is often drawn in another colour and broken by windows and exits into separate pieces. Each piece was smaller than 20 % of the main wall component, so it did not stop the street flood, and the whole corridor between the rooms and the outer wall became street (not found). Fix in js/vision.js, findRooms:
1. The street flood now stops at all wall-like ink (`obst`), not only at the main component (`shell`). New helper `streetMask`.
2. `openPockets`: space that was street with `shell` only and became enclosed only because of the other lines returns to street if more than 1/7 of its border touches the street (pockets between a wall and dimension lines or captions).
3. `foreign` components: a piece that encloses more area not attached to the main walls than area attached to them (a key map next to the plan, legend frames) does not stop the street; the gap between such a key map and the building is not a room.
4. Candidates must lie in a region connected (through doors) to the main walls (`inMain`), inside the building box extended by large non-foreign wall pieces, and be at least `minWideM` = 0.6 m wide (slivers between double lines of a wall or window).
5. Test: `план эвакуации: коридор вдоль наружной стены из отдельных кусков...` in tests/vision.test.js.

Bench (`node tools/bench-vision.js`), main before vs this branch: total 58.06 to 61.11, real plans 50.3 % to 55.6 %, synthetic F1 65.8 % to 66.6 %. Time per picture about 1.3 to 1.6 times the old one.

## Your job

1. Find why these real plans got worse and fix it without losing the gains: catalog-plan (62.5 % to 39.5 %), photo-drawing-table (73.3 % to 56.4 %), temple-columns (73.7 % to 66.7 %), evac-cn-color (59.8 % to 53.2 %). Use `node tools/bench-vision.js --only <id>` and `node tools/vision-gallery.js <id>`; look at the pictures (bench/vision/out/index.html) for old and new results. The old code is `git show main:js/vision.js`.
2. Make it faster: the extra steps (second street flood, openPockets, region labelling, foreign check) should cost at most 25 % over main on a 1600 x 1200 picture. Report timings for evac-cn-color, catalog-plan, evac-my-platform (best of 3 runs, old and new).
3. Add a test for openPockets: a building with a long thin caption or dimension line parallel to the outer wall at 1 to 2 m, open at the ends: no room between them. Check the test fails when openPockets is disabled.
4. Keep all tests passing and the bench total not lower than 61.11; report the full bench summary and per-plan changes over 3 points.

Change js/vision.js and tests/vision.test.js only. Do not touch norms, the interface or sw.js.
