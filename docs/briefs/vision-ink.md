# Задание: стены на снимке (этап 2.2 плана)

Model: Gemini 4 Neon (XHigh). Branch: vision-ink. Read docs/briefs/common.md first and follow it.

Goal: replace `inkMask(rgba, w, h)` in js/vision.js (the first stage: which pixels are wall ink) so that walls survive real photos and modern drawings, while clean black-wall plans keep working exactly as now.

Problems seen on the test set (bench/vision, run `node tools/vision-gallery.js` and look at bench/vision/out/index.html):
- gray walls (neutral mid-gray fill, for example ru-apartment-zoning: walls about 192 on a light blue page) are not ink at all, the plan gives 1 room instead of 8;
- warm light: a pixel with max-min channel difference over 60 is treated as colour and never as a wall, so dark walls with a colour cast vanish; dark blue or brown walls vanish too;
- dark green arrows and dark red signs with luminance under 60 are treated as walls and cut corridors;
- glare and shadows: fixed thresholds (Otsu capped at 110, nothing above 160, 0.78 of the local mean) erase walls in glare and blacken paper in shadow;
- pastel room fills must never be walls.

Do:
1. Background (paper) estimation per channel on a downscaled copy (for example a large max or high-percentile filter, then a blur, then upscale), normalise each pixel by it: this flattens light and removes the colour cast in one step.
2. A wall pixel is dark relative to its local paper (contrast threshold scaled to the local contrast, Sauvola or Wolf style on the normalised luminance) AND either near-neutral (low chroma after normalisation) or very dark. Saturated pixels of medium lightness (green arrows, red signs, pastel and strong fills) are not walls, even when fairly dark, unless they are much darker than any symbol colour (dark red or dark blue walls drawn as solid thick lines must still count: decide by darkness and thickness, and explain the rule in a comment).
3. Neutral mid-gray filled regions (gray walls) count as ink when their contrast to the paper is clear (about 35 luminance levels or more).
4. Keep the signature and export (`_inkMask`), keep it fast (no slower than the current version by more than 30 % on a 1600 x 1200 picture) and memory-light (Uint8, Uint32, Float32).
5. Add unit tests (tests/vision-ink.test.js) on small synthetic pictures: warm cast paper (240,220,170) with dark walls; a 4:1 shadow gradient; a glare blob over a wall; gray walls 190 on 245; dark red walls; green arrows and red signs that are not walls; pastel fills that are not walls; a 1 px black line preserved.
6. All existing tests must still pass (tests/vision.test.js has synthetic plans, a furnished apartment, a 188-room building and the school example).
7. Run `node tools/vision-gallery.js` before your change (save a copy of bench/vision/out/results.json outside the repo or in memory) and after, and report per plan the found count before and after against the expected count in bench/vision/expect.json. Clean plans must not get worse: black-walls-scalebar (25 of 25), evac-hotel-angle, arch-heathcote, red-walls-scalebar.

Change only js/vision.js and add tests/vision-ink.test.js.
