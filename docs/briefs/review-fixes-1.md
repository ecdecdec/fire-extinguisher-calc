# Задание: исправления по проверке веток bench и vision-geom

Model: Gemini 4 Neon (High). Branch: review-fixes-1 (from main). Read docs/briefs/common.md first. Do not modify js/vision.js (another job is changing it).

The reviews (Gemini 4 Argon High) found these problems. Fix each, add a test where it says so, keep every existing test passing (`node --test`).

tools/bench-vision.js and tools/synth-plans.js:
1. `evalRealPlan`: `inRange` must use the valid count (found minus junk), the same as `score`. Test it in tests/synth.test.js.
2. `--only` together with `--save-baseline` must refuse to save (print why and exit with code 1) instead of overwriting the full baseline with a subset.
3. `drawDimensionChain`: extension lines must point toward the building on every side (callers pass absolute coordinates, so `offsetPx < 0` is always false); vertical chains get digit labels like horizontal ones; remove the duplicate ternary.
4. Remove dead code: the unused `areas` in `recognize()`, the push and immediate pop of the solid wall.
5. Re-run `node tools/bench-vision.js --save-baseline` at the end and commit the new baseline (numbers may move slightly because of fix 1 and 3; report old and new totals).

js/vision-geom.js:
6. `warp` must order the quad with `orderQuad` (as `rectifiedSize` and `planBox` do) and reject a missing or non-4-point quad with a clear error. Test: the same result for a quad given in any vertex order.
7. Degenerate or concave quad from user dragging: where the homogeneous divisor is not positive, output white instead of garbage; if `cornerScales` finds no valid point, do not shrink the source to 8 x 8. Test with a concave and a collinear quad.
8. `refineQuadFullRes`: the "near the image border" threshold must scale with the work scale (1.5 / workScale), not a fixed 3 px. Test on a 1600 px wide picture with the sheet edge on the border.
9. `mergeCollinear` / `lineProposals`: keep the real covered length (union of intervals) so empty gaps do not count as covered edge.
10. False 'sheet' on borderless drawings: on bench/vision/img/black-walls-scalebar.png detectQuad returns 'sheet' and cuts off the bottom third of the plan. Require that dark plan content does not lie outside the quad (or at least two sides near the image edge are allowed only when the content check passes); report the per-image kind and score table again for all 59 pictures and note which changed.
11. Code quality: move the inline magic thresholds of `evaluateCandidate` and `planBox` into one named `DEFAULTS` table at the top with a short comment per value; remove the duplicated paper-luminance histogram, the duplicated side-length code (one helper) and the duplicated bilinear sampler (one helper used by both warp paths); remove `spans`, `seg.support`, `borderMean`, `borderStd` if unused; do not export `_orderQuad` unless a test needs it. Behaviour must stay the same apart from fixes 6 to 10.

Report what changed per item, test results, and the bench and detectQuad numbers before and after.
