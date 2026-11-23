> Разбор: сканер планов. Модель Gemini 4 Neon (XHigh) через agy, 23.11.2026, только чтение кода.
> Главные выводы сверены с кодом и вошли в docs/plan.md. Остальное не проверено.

# Floor-Plan Recognition Pipeline Audit & Improvement Proposal

---

## 1. Current Pipeline Stage by Stage

1. **Image ingestion & downscaling** — `loadPicture` ([js/app.js:194-217](../../js/app.js#L194-L217)): loads file/URL into `<img>`, downscales so `max(w, h) <= MAX_PLAN_SIDE` (`1600`, [js/app.js:159](../../js/app.js#L159)), composites onto white `<canvas>`, extracts `RGBA`, and re-encodes as PNG or JPEG (q=0.85) DataURL.
2. **Scale orchestration & worker dispatch** — `runBp` ([js/app.js:1698-1735](../../js/app.js#L1698-L1735)), `runVision` ([js/app.js:222-251](../../js/app.js#L222-L251)), `self.onmessage` ([js/vision.worker.js:8-16](../../js/vision.worker.js#L8-L16)): uses ruler length (`scaleFromLength`, [js/vision.js:638-641](../../js/vision.js#L638-L641)) for a single pass, or `areaM2` for two full passes (pass 1 guesses scale from shell bbox; `scaleFromArea` [js/vision.js:618-621](../../js/vision.js#L618-L621) sets pass 2 scale and refines it post-pass 2). Copies `rgba` and transfers to worker.
3. **Ink & color binarization** — `inkMask` ([js/vision.js:44-93](../../js/vision.js#L44-L93)): computes Rec.601 luminance `lum`, chroma flag `mx - mn > 60`, global Otsu threshold capped at `110`, and integral-image local mean (`half = max(7, round(max(w, h) / 80))`). Keeps non-colored (or very dark `l <= 60`) pixels where `l < tg` or (`l < 160` and `l < 0.78 * localMean`).
4. **Small-blob denoising** — `removeSmall` ([js/vision.js:132-139](../../js/vision.js#L132-L139)) via 8-connected `components` ([js/vision.js:98-129](../../js/vision.js#L98-L129)), called at [js/vision.js:489](../../js/vision.js#L489): removes ink components whose longer bbox side `< max(6, round(big * 0.015))`.
5. **Building shell & initial scale** — `findRooms` ([js/vision.js:493-513](../../js/vision.js#L493-L513)): reruns `components`; excludes page-frame candidates (`nearAll`: within 3% of all 4 edges); keeps components with pixel count `>= 0.2 * largest` as `shell`; optionally initializes `scale = sqrt(shellBboxArea * 0.85 / areaM2)`; computes squared EDT `distShell = edt(shell)` ([js/vision.js:144-184](../../js/vision.js#L144-L184)).
6. **Exterior ("street") opening** — `findRooms` ([js/vision.js:515-529](../../js/vision.js#L515-L529)): 4-connected BFS from all 4 image edges through `!shell && distShell > rOut^2` (`rOut = outM * scale` or `big * 0.02`), then dilates `wide` back by `rOut` via `dOut = edt(wide)` to mark `street`.
7. **Obstacle filtering & thin-line removal** — `findRooms` ([js/vision.js:535-550](../../js/vision.js#L535-L550)), `dropThin` ([js/vision.js:346-371](../../js/vision.js#L346-L371)): promotes ink components to `obst` if in `shell`, longer side `>= floatMax`, within `1.5 px` of `shell`, or aspect ratio `>= 6`. If `scale >= 25 px/m` (`thinPx >= 1.5`), `dropThin` erodes 1–2 px lines via two EDTs (`dIn`, `dCore`) unless `< 40%` of ink survives or thickest wall `< 5 px`. Computes `dist = edt(obst)`.
8. **Depth-persistence room segmentation** — `segment` ([js/vision.js:269-338](../../js/vision.js#L269-L338)): counting-sorts `free = !obst && !street` pixels by descending `floor(sqrt(dist) * 4)`, sweeps top-down with DSU merging minor peaks when `peak[S] - d < tau` or `d >= 0.75 * peak[S]`, seeds cores at `depth > sad[r] + 0.5`, and expands labels across `free` via 4-connected BFS.
9. **Wall-adjacent furniture absorption** — `absorbFurniture` ([js/vision.js:379-475](../../js/vision.js#L379-L475)): casts 4-cardinal rays (length `reach = max(2, round(0.08 * scale))`) from small, nearly closed regions through `obst`; merges a region into a single surrounding room if `>= 85%` of labeled rays agree, area `< 30%` of host, no ray hits `street`, and bbox fits inside host bbox `+ reach + 1`.
10. **Filtering, vectorization & post-processing** — `findRooms` ([js/vision.js:561-615](../../js/vision.js#L561-L615)): drops border-touching, `< minPx`, outside-shell-bbox, and `surrounds` regions; traces outer boundaries with Moore-neighbor `trace` ([js/vision.js:193-217](../../js/vision.js#L193-L217)) and split Douglas-Peucker `simplify`/`dp` ([js/vision.js:219-254](../../js/vision.js#L219-L254)); sorts in reading order. UI applies `roundAreas` ([js/vision.js:626-635](../../js/vision.js#L626-L635)) and `looksLikeCorridor` ([js/vision.js:644-648](../../js/vision.js#L644-L648)).

---

## 2. Failure Modes on Real Inputs

| Input Type | What Goes Wrong | Root Cause (`file:line`) | Severity |
|---|---|---|---|
| **Phone photos of wall-mounted evacuation plans** (perspective, glass glare/reflections, uneven light, shadows, JPEG noise, moiré) | **Perspective:** non-uniform `scale` across the floor skews areas by 20–50%+, breaks straight-row reading order, and turns rectangular rooms into trapezoids. **Glare/reflections:** washed-out walls (`lum >= 160`) vanish, letting `street` flood inside or merging rooms. **Shadows:** paper darker than `tg` (`<= 110`) turns solid black ink, erasing whole wings. **Warm/indoor lighting:** yellow cast pushes `mx - mn > 60` on neutral paper/gray walls, erasing walls with `l > 60`. **JPEG/moiré:** ringing/halftone dots connect nearby text or break thin walls into `< 24 px` scraps deleted by `removeSmall`. | No homography/deskew ([js/app.js:194-216](../../js/app.js#L194-L216)); hard `l >= 160` reject ([js/vision.js:86](../../js/vision.js#L86)); global `l < min(otsu, 110)` ([js/vision.js:68,85](../../js/vision.js#L68)); unnormalized chroma `mx - mn > 60` ([js/vision.js:53,84](../../js/vision.js#L53)); scale-blind `removeSmall` ([js/vision.js:489](../../js/vision.js#L489)). | **Critical** |
| **Colored plans** (green evacuation arrows, red fire symbols, colored room fills, legend/title blocks, frames) | **Dark colored symbols:** dark green arrows or shadowed red fire signs with `l <= 60` bypass the color mask and act as walls, slicing corridors lengthwise. **Colored/shaded room fills:** low-saturation beige/gray fills (`mx - mn <= 60`, `l < 160`) become ink borders or solid blocks; saturated fills shift local mean and erase thin adjacent walls. **Frames & legend/title blocks:** on photos with `> 3%` margin around the sheet, the GOST frame + штамп + legend is not caught by `nearAll`, becomes `largest`, poisons `shell` and `sx0..sy1`, and seals the sheet margin so `street` cannot reach the building (or legend boxes appear as fake rooms). | `colored[i] && l > 60` ([js/vision.js:84](../../js/vision.js#L84)); `mx - mn > 60` ([js/vision.js:53](../../js/vision.js#L53)); `nearAll` 3% rule & `0.2 * largest` ([js/vision.js:494-507](../../js/vision.js#L494-L507)); `wallish` fails to exclude `nearAll` ([js/vision.js:543-548](../../js/vision.js#L543-L548)). | **Critical** |
| **БТИ / техпаспорт drawings** (thin lines, printed room numbers/areas, dimension lines, hatching, door arcs, triple-line windows, stairs, columns) | **Thin lines & downscaling:** 1–2 px CAD lines blur above `l = 160` during `1600 px` downscale or are erased by `dropThin` when thicker load-bearing walls exist (`maxD >= 9`), erasing interior partitions. **Printed areas & dimension lines:** underlined fractions (`№ / S`), circled numbers, and dimension strings exceed `removeSmall` (`24 px`) and trigger the `aspect >= 6` rule in `wallish`, splitting rooms. **Hatching & stairs:** dense parallel stair treads or cross-hatching form solid obstacles or dozens of micro-regions. **Door arcs:** at `scale < 25` (or when drawn `>= 3 px` at high scale), closed arcs seal small rooms or form phantom D-shaped rooms. **Triple-line windows:** either vanish (leaking `street` inside) or enclose narrow glass cavities. **Columns:** inside rooms, columns pinch the EDT and over-segment one hall into multiple rooms. | `MAX_PLAN_SIDE = 1600` ([js/app.js:159,198-206](../../js/app.js#L198-L206)); `l >= 160` ([js/vision.js:86](../../js/vision.js#L86)); `wallish` aspect `>= 6` ([js/vision.js:545](../../js/vision.js#L545)); `dropThin` ([js/vision.js:346-371,549](../../js/vision.js#L346-L371)); EDT watershed sensitivity to interior obstacles ([js/vision.js:269-316](../../js/vision.js#L269-L316)). | **Critical** |
| **Apartments & private houses with furniture** | **Wall-to-wall fixtures** (bathtubs spanning full bathroom width, wall-to-wall kitchen cabinets/wardrobes) fail the `absorbFurniture` host-bbox containment check and become phantom rooms. **High-res furniture (`scale > 50`):** `0.03 m` lines become `>= 3 px`, bypassing `dropThin` (capped at `3 px` / `dIn >= 4`). **Small real rooms:** realistic Soviet/KZ toilets (`0.85 × 1.2 m`, `peak = 0.42 m`, `0.7 m` door -> `d = 0.35 m`) merge into the corridor (`peak - d = 0.07 < 0.20` and `0.35/0.42 = 0.83 >= 0.75`); conversely, enclosed closets/server cubicles inside larger rooms get absorbed by `absorbFurniture`. **Nested/complex furniture** (sofas with cushions, stoves, chairs around tables) leaves unabsorbed holes or splits rooms. | `dropThin` cap `Math.min(3, hairM * scale)` & `dIn >= 4` ([js/vision.js:358,549](../../js/vision.js#L358)); `absorbFurniture` bbox check ([js/vision.js:463](../../js/vision.js#L463)) and lack of wall-vs-furniture semantics ([js/vision.js:454-467](../../js/vision.js#L454-L467)); `tauM = 0.2`, `openRatio = 0.75` ([js/vision.js:31-32,306](../../js/vision.js#L306)). | **High** |
| **Hollow double-line walls vs filled black walls** | Hollow walls (two parallel thin lines `0.15–0.5 m` apart) leave an interior cavity that is `!obst && !street`, detected as long narrow **false rooms** (often auto-labeled "corridor"!). Exterior hollow cavities fail `absorbFurniture` because one side hits `street`. Thin parallel lines also break across doors/windows into `< 0.2 * largest` fragments, collapsing `shell` and leaking `street` into rooms; if a stamp/column gives `maxD >= 9` and `>= 40%` ink, `dropThin` erases the hollow walls completely. | No parallel-line pairing anywhere in [js/vision.js](../../js/vision.js); `shell` `0.2 * largest` ([js/vision.js:504](../../js/vision.js#L504)); `dropThin` ([js/vision.js:355-369](../../js/vision.js#L355-L369)); `looksLikeCorridor` ([js/vision.js:644-648](../../js/vision.js#L644-L648)). | **Critical** |
| **Very low & very high resolution** | **Low res (`< 5–8 px/m` or small `< 400 px` image):** thin walls vanish, `tau = max(2, ...)` (`>= 0.5–1.0 m`) merges adjacent rooms and corridors, `removeSmall` (`minLen >= 6`) deletes piers, and `minPx` drops real small rooms. **High res (4000×3000 photo or small apartment zoomed in):** downscale to `1600 px` smears 1–2 px lines above `l = 160`; for small 8–12 m apartments (`scale = 100–150 px/m`), `thinPx` caps at `3 px` so 3–5 px furniture/arcs survive `dropThin`, while `reach = round(0.08 * scale)` grows to `8–12 px`, chewing through real partitions in `absorbFurniture`. | `MAX_PLAN_SIDE = 1600` ([js/app.js:159,198-206](../../js/app.js#L159)); `tau = Math.max(2, ...)` ([js/vision.js:555](../../js/vision.js#L555)); `Math.min(3, hairM * scale)` ([js/vision.js:549](../../js/vision.js#L549)); `reach` ([js/vision.js:558](../../js/vision.js#L558)); UI only warns below `scale < 3` ([js/app.js:784](../../js/app.js#L784)). | **High** |
| **Rotated or skewed images** | Axis-aligned `shell` bbox inflates `sx1 - sx0` and `sy1 - sy0`, overestimating initial `areaM2` scale (`0.85 * bboxArea`) by up to 2×. `looksLikeCorridor` and imported `length`/`width` use axis-aligned `bbox`, missing rotated corridors completely. `absorbFurniture` uses axis-aligned bbox containment and 4-cardinal rays (`sqrt(2)` thicker across diagonal lines). 4-connected BFS creates jagged doorway cuts. Reading-order sort scrambles room numbering. | `sx0..sy1` scale guess ([js/vision.js:509](../../js/vision.js#L509)); `looksLikeCorridor` ([js/vision.js:644-648](../../js/vision.js#L644-L648)); `applyBp` `length`/`width` ([js/app.js:1760](../../js/app.js#L1760)); `absorbFurniture` rays & bbox ([js/vision.js:407,463](../../js/vision.js#L407)); 4-connected BFS ([js/vision.js:329-336](../../js/vision.js#L329-L336)). | **High** |
| **Curved and diagonal walls** | 2 px diagonal walls often contain no solid `2×2` block, so `dropThin` (`1.5 <= thinPx < 2.5`) **erases them completely**. Diagonal/curved passages produce staircase EDT ripples and skewed 4-connected BFS cuts. `simplify` retains `pts[0]` unconditionally and approximates arcs poorly at `eps = 0.15 * scale`. L/U/curved corridors fail `looksLikeCorridor`. | `dropThin` `2×2` core test ([js/vision.js:360-363](../../js/vision.js#L360-L363)); 4-connected BFS ([js/vision.js:329-336](../../js/vision.js#L329-L336)); `simplify` ([js/vision.js:245-254](../../js/vision.js#L245-L254)); `looksLikeCorridor` ([js/vision.js:644-648](../../js/vision.js#L644-L648)). | **Medium** |
| **Open-plan spaces** (studios, kitchen-living rooms, open offices) | Partial dividers, kitchen islands, structural columns, or bay-window alcoves create local EDT saddles (`d < 0.75 * peak` and `peak - d >= 0.2 m`) that arbitrarily fracture one open-plan room into pieces, OR wide zones separated by a low counter/archway merge unpredictably. Wide storefronts/entrances (`> 3 m`) let `street` flood the entire open floor, yielding 0 rooms. No interactive split/merge UI exists to fix either case. | `segment` saddle criteria ([js/vision.js:306](../../js/vision.js#L306)); `outM = 1.5` (`3 m` entrance cap, [js/vision.js:29,512-527](../../js/vision.js#L512-L527)); modal only offers on/off checkbox ([js/app.js:768](../../js/app.js#L768)). | **High** |
| **Several buildings / annexes on one sheet** | Any secondary building/annex with `< 20%` of the largest building's ink pixels is dropped from `shell`, immediately flooded by `street`, and excluded by `sx0..sx1, sy0..sy1`. If both buildings survive `shell`, their union bbox includes the empty yard between them, badly overestimating initial `areaM2` scale. | `f.n < largest * 0.2` ([js/vision.js:504](../../js/vision.js#L504)); `sx0..sy1` filter & scale guess ([js/vision.js:506,509,587](../../js/vision.js#L506)). | **Medium–High** |
| **Screenshots** (CAD viewers, PDF viewers, mobile crops) | **Tightly cropped screenshots:** outer building walls lying within `3%` of all 4 edges trigger `nearAll` and are **deleted from `shell`**, returning 0 rooms; tight margins `< 2 * rOut` also block `street` from wrapping around the building. **Uncropped viewer screenshots:** dark app toolbars/sidebars/window borders become `largest` ink component and wipe out the actual plan. | `nearAll` 3% margin ([js/vision.js:494-504](../../js/vision.js#L494-L504)); `street` border flood requires `distShell > rOut^2` ([js/vision.js:518-520](../../js/vision.js#L518-L520)); `largest` component heuristic ([js/vision.js:498-504](../../js/vision.js#L498-L504)). | **High** |
| **Hand-drawn sketches** | Faint pencil/light strokes (`l >= 160`) disappear; **blue or red ballpoint pen** ink (`mx - mn > 60`, `l > 60`) is dropped as "colored" annotations! Small hand-drawn gaps at wall corners break `shell` into `< 20%` fragments or `< 24 px` dashes erased by `removeSmall`, leaking `street` inside. Uneven pen thickness triggers partial `dropThin` erasure. | `colored` filter ([js/vision.js:53,84](../../js/vision.js#L53)); `l >= 160` ([js/vision.js:86](../../js/vision.js#L86)); `removeSmall` ([js/vision.js:489](../../js/vision.js#L489)); no gap bridging before `street` flood ([js/vision.js:518](../../js/vision.js#L518)). | **Medium** |
| **Scanned PDF pages** *(mentioned in product scope)* | File inputs use `accept="image/*"` — PDFs cannot even be opened directly. When converted to images, yellowed/aged paper triggers `mx - mn > 60`, punch-hole/binding shadows trigger `l < tg`, and faint thin lines drop out on `1600 px` downscale. | `accept="image/*"` ([js/app.js:739-740,760](../../js/app.js#L739-L740)); `inkMask` ([js/vision.js:53,68,85-86](../../js/vision.js#L53)). | **Medium** |

---

## 3. Concrete Bugs, Fragile Constants & Mobile Performance Issues

### 3.1 Concrete Code Bugs

1. **`nearAll` components leak back into `obst`** ([js/vision.js:504, 543-548](../../js/vision.js#L543-L548)): Page frames excluded from `shell` at line 504 still satisfy `Math.max(a, b) >= floatMax` at line 545 (`wallish` never checks `!nearAll(f)`), re-inserting the page border into `obst`.
2. **Tightly cropped plans deleted by `nearAll`** ([js/vision.js:494-504](../../js/vision.js#L494-L504)): Any building whose outer wall reaches within `3%` of all four image edges is indistinguishable from a page frame and discarded, leaving `shell` empty.
3. **`absorbFurniture` corrupts neighbor partition walls by ignoring `v`** ([js/vision.js:443, 469-472](../../js/vision.js#L443)): Line 443 records `crossed.push(path[q], L, v)` (the target room reached by each ray), but lines 469-472 never read `crossed[q + 2]`. When `L` merges into `top`, *every* obstacle pixel crossed toward *any* neighbor `v != top` (up to 15% of rays) is also converted to `L`/`top`, punching holes through real partitions.
4. **Scalar `sad[r]` starves wings and causes BFS room bleed + disconnected room labels** ([js/vision.js:308-313, 322-336, 570, 603](../../js/vision.js#L308-L336)):
   - Each region stores only its single *highest* unmerged saddle `sad[r]`. If a corridor has one wide archway (`sad = 1.0 m`) to a hall and narrows to `1.8 m` (`depth = 0.9 m`) in another wing, that entire wing fails `depth[p] > sad[r] + 0.5` and gets **no core seeds**; neighboring offices' unweighted BFS then floods through their doors and absorbs that corridor wing.
   - Because cores are thresholded globally by `sad[r]`, a single DSU root `r` can yield **two disconnected pixel islands** sharing label `id[r]` (also possible after `absorbFurniture` relabeling at [js/vision.js:473](../../js/vision.js#L473)). `trace(label, w, h, L, first[L])` ([js/vision.js:603](../../js/vision.js#L603)) traces only the island containing `first[L]`, while `cnt[L]` sums *both* islands — creating an invisible area mismatch between `poly` and `area`.
5. **Quantized counting sort causes `peak[r]` error up to `0.25 px`** ([js/vision.js:270-284, 298](../../js/vision.js#L270-L284)): Pixels within the same `Q = 4` bucket are visited in raster order, not descending `depth`, so `peak[p]` can be initialized to a smaller value than a later pixel in the same bucket.
6. **`surrounds` deletes legitimate ring/wrap-around corridors and misses `< 3`-room margins** ([js/vision.js:591-599](../../js/vision.js#L591-L599)): A central-core office floor or ring corridor enclosing `>= 3` rooms (stairs/elevators/restrooms) has a bbox enclosing all other candidates and is silently deleted. Conversely, a framed 1–2 room plan keeps its outer sheet margin as a giant room.
7. **Unchecking false rooms in `areaM2` mode silently corrupts all remaining room areas** ([js/app.js:768, 1726-1729, 1744-1768](../../js/app.js#L1726-L1729)): `scaleFromArea` divides total pixel area of *all* detected regions (including false positives) by `areaM2`. When the inspector unchecks false rooms (`r.on = false`), `bp.scale` and the surviving rooms' areas are never recomputed — permanently underestimating real room areas and potentially under-calculating required fire extinguishers.
8. **Reopening a blueprint discards ruler calibration and degrades JPEG quality** ([js/app.js:211, 1616-1618](../../js/app.js#L1616-L1618)): `openBp` sets `bp.areaM2 = String(Math.round(self.floorArea(floor)))` (losing exact ruler scale) and passes the stored JPEG DataURL through `loadPicture`, re-encoding JPEG q=0.85 on every edit cycle.
9. **Worker lifecycle & UI-freeze bug** ([js/app.js:234-242, 1624](../../js/app.js#L234-L242)): `visionWorker.onerror` executes every queued job synchronously on the UI thread without calling `visionWorker.terminate()`; `closeBp` does not cancel in-flight worker work.
10. **Unimplemented `areaM2` unit check** ([js/app.js:961-969](../../js/app.js#L961-L969)): Comment claims to detect area in cm², but `bpUnits` only checks `lenM > 300`.
11. **Dead code `rDoor` / `doorPx`** ([js/vision.js:28, 511, 614](../../js/vision.js#L511)): `rDoor` is calculated and returned as `doorPx`, but never read anywhere in the repository.
12. **`edt1` `INF = 1e20` precision loss & wasted work** ([js/vision.js:38, 168-171](../../js/vision.js#L38)): At `1e20`, float64 ULP is `16384`, so `1e20 + q*q === 1e20` for `q <= 90` and quantized above it; missing `if (f[q] >= INF) continue;` forces useless parabola stack popping on every background pixel (doesn't corrupt finite outputs for `n <= 1600`, but slows EDT and requires `Float64Array`).

### 3.2 Fragile Constants (Pixels & Meters That Fail to Scale)

| Constant / Expression | Location | Why It Breaks |
|---|---|---|
| `MAX_PLAN_SIDE = 1600` | [js/app.js:159](../../js/app.js#L159) | Destroys 1–2 px CAD lines on large buildings (`> 80 m` -> `< 20 px/m`, `160 m` -> `< 10 px/m`) and on photos where the sheet occupies half the frame. |
| `mx - mn > 60`, `l > 60` | [js/vision.js:53,84](../../js/vision.js#L53) | Absolute RGB delta breaks on warm/yellow lighting; `l > 60` fails to exclude dark green/red/blue symbols. |
| `tg = min(otsu, 110)`, `l >= 160`, `0.78 * mean` | [js/vision.js:68,85-89](../../js/vision.js#L68) | `l < 110` blackens shadowed paper; `l >= 160` erases glare/faint lines; `0.78` drops low-contrast antialiased lines (`200` on `245`). |
| `removeSmall`: `max(6, round(big * 0.015))` | [js/vision.js:489](../../js/vision.js#L489) | Scale-blind (`24 px` at `1600 px` = `3 m` on a large hall, `0.24 m` on an apartment); deletes short wall piers and keeps touching text strings. |
| `nearAll`: `0.03`, `shell`: `0.2 * largest` | [js/vision.js:495,504](../../js/vision.js#L495) | `0.03` deletes tightly cropped plans and misses photographed frames; `0.2` drops secondary buildings and window-segmented exterior walls. |
| `0.85` bbox fill factor | [js/vision.js:509](../../js/vision.js#L509) | Fails on L/U/T-shaped, rotated, or multi-building plans (true fill 20–50%), biasing pass-1 scale by up to 2×. |
| `outM = 1.5` (`3 m` max entrance) | [js/vision.js:29,512](../../js/vision.js#L29) | Floods buildings with `> 3 m` garage doors, shopfronts, loading bays, or wide lobbies; unscaled `big * 0.02` (`32 px`) is arbitrary. |
| `nearShell <= 2.25` (`1.5 px`), `aspect >= 6`, `furnitureM = 3` | [js/vision.js:33,535,545](../../js/vision.js#L545) | `1.5 px` gap threshold doesn't scale with resolution; `aspect >= 6` promotes wide text labels and dimension lines to walls; `3 m` treats large tables/sofas as walls. |
| `hairM = 0.06` capped at `3 px`, `maxD < 9`, `0.4 * total`, `dIn >= 4` | [js/vision.js:35,355-368,549](../../js/vision.js#L355-L368) | Inactive below `25 px/m`; at `scale >= 80 px/m`, `3 px` furniture survives (`dIn >= 4`); erases 1–2 px interior partitions when thick outer walls exist; `2×2` core erases 2 px diagonal walls. (Note: `maxD < 9` checks thickness `>= 5 px`, not 6 px as commented at line 344.) |
| `tauM = 0.2`, `openRatio = 0.75`, `tau = max(2, ...)` | [js/vision.js:31-32,306,555](../../js/vision.js#L306) | Always merges `0.85–1.1 m` toilets/corridors with `0.7–0.9 m` doors; splits rooms with columns or alcoves. |
| `thinM = 0.08`, `reach = max(2, round(0.08 * scale))`, `0.3` area, `0.85` votes | [js/vision.js:34,461,558](../../js/vision.js#L558) | At low scale `reach = 2 px` crosses thin partitions; at high scale `reach = 12+ px` crosses thick partitions; `0.3` fails for beds/wardrobes in tiny bedrooms. |
| `looksLikeCorridor`: `>= 3.5`, `<= 4.5 m` | [js/vision.js:647](../../js/vision.js#L647) | Axis-aligned bbox misses L/T/U/rotated corridors and mislabels hollow wall cavities and balconies as corridors. |

### 3.3 Performance & Memory Problems on a Mid-Range Phone

For a typical `1600 × 1200` (`n = 1.92 M` pixels) photo on a mid-range Android phone (Snapdragon 6xx / Helio G-series, 3–4 GB RAM, Android WebView):

- **Peak RAM (~100–140 MB live, ~210–250 MB allocated per pass; ~450 MB in 2-pass `areaM2` mode):**
  - `inkMask` integral image `I`: `Float64Array` = **15.4 MB** (max sum `4.9e8` fits in `Uint32Array`, 7.7 MB).
  - **5 full-image `Float64Array` EDTs** (`distShell`, `dOut`, `dIn`, `dCore`, `dist`): **15.4 MB each** (max `dist^2 = 4e6` fits exactly in `Float32Array`/`Int32Array`, 7.7 MB).
  - `components` allocates `labels + stack` = **15.4 MB**, run twice (`parts.labels` stays live across Stages 3–5 alongside `distShell`).
  - `segment` simultaneously holds `depth`, `key/parent`, `order`, `peak`, `sad`, `label`, `id` (7.7 MB just to map roots!), and `queue` = **~63 MB live**.
  - On 3–4 GB Android phones, a ~140 MB worker spike plus decoded 12 MP camera image (`~48 MB` native bitmap before canvas draw) risks Android WebView renderer OOM kills.
- **CPU / Cache Bottlenecks:**
  - `edt` column pass ([js/vision.js:148-152](../../js/vision.js#L148-L152)) performs strided 8-byte column reads/writes across a 15.4 MB array, thrashing mobile L2 cache; running 5 EDTs per pass (10 in `areaM2` mode!) dominates runtime.
  - `areaM2` mode ([js/app.js:1706,1709](../../js/app.js#L1706)) copies `7.7 MB` `rgba` twice and recomputes scale-independent stages (`inkMask`, `removeSmall`, `components`) from scratch.
  - `absorbFurniture` pushes 3 entries per ray step into a dynamic JS `crossed` array ([js/vision.js:443](../../js/vision.js#L443)) and allocates per-candidate `Map` objects, causing GC pauses.
  - **Exact mobile timing:** *Unsure without benchmarking on target hardware* (Node is unavailable in this read-only environment), but on mid-range ARM cores, 10 unoptimized `Float64` 1.92M-pixel EDTs + 2 `segment` passes + GC typically take **2–5 seconds** (and freeze the UI completely if the worker falls back to the main thread).
- **UI Touch Bottleneck:** `.bp__svg` has `max-height: 55vh` on phones ([css/app.css:517](../../css/app.css#L517)) with no pinch-zoom or pan — placing two ruler endpoints accurately with a finger is nearly impossible, introducing large squared area errors.

---

## 4. Ranked Improvements (Impact / Effort)

Context from the repo: the entire PWA currently weighs **~2.3 MB uncompressed** (`js/vision.js` is 35.6 KB), uses **no bundler**, precaches everything in [sw.js:19-35](../../sw.js#L19-L35), and deploys via [vercel.json](../../vercel.json) and Capacitor Android WebView **without COOP/COEP headers** — meaning `SharedArrayBuffer` / multi-threaded WASM is unavailable (any WASM must run single-threaded/SIMD).

| Rank | Improvement | Impact | Effort | Added Download Size | Key Design Details & Offline/Phone Feasibility |
|---|---|---|---|---|---|
| **1** | **Core pipeline bug fixes + illumination normalization (background division + Sauvola/Wolf) + white-balanced color separation** | **Very High** | **Low** (1–2 weeks) | **+5–10 KB** (pure JS) | Fixes the #1 real-photo killer (glare, shadows, yellow lighting, dark red/green symbols, tight crops, scale recalculation on room uncheck, `Float32`/`Uint32` RAM halving). Estimate smooth background `B` via downscaled morphological closing (or separable max-filter / block percentile), normalize `I_norm = 255 * I / max(B, eps)` per channel (**auto white-balance + illumination flattening in one step!**). Then separate chroma in normalized RGB/HSV (`S > 0.28` & `V > 0.12` removes dark green/red signs without hurting yellowed paper) and binarize with Sauvola/Wolf (`T = m * (1 + k * (s/R - 1))` using `Uint32` + `Float64` squared integral images). Also fix `nearAll`, `absorbFurniture`'s `crossed` bug, `surrounds`, and live `areaM2` rescaling on room toggle. |
| **2** | **Interactive correction tools + pinch-zoom/pan canvas + magnifier loupe** | **Very High** | **Medium** (2–3 weeks) | **+15–25 KB** (pure JS) | Even a 90%-accurate recognizer fails field adoption if the inspector cannot fix the remaining 10% in 10 seconds. Add: (a) **pinch-zoom/pan + floating loupe** for ruler & editing; (b) **tap-to-merge** two adjacent rooms (instant: union in Region Adjacency Graph + re-trace union polygon, `< 5 ms`); (c) **draw-a-line split** (rasterize 2 px barrier into room's local bbox mask, 2-component flood-fill inside that room only, `< 10 ms`); (d) **draw/erase wall brush** (patch `wallMask` in dirty bbox, run local incremental re-segmentation in `< 30 ms`); (e) **move/add/delete polygon vertex** (pure vector edit, shoelace area update, `< 1 ms`); (f) **tap to add missed room** (seed flood-fill at tap point inside `!wallMask`). Render image + mask on `<canvas>` during touch gestures (60 fps on mid-range phones) and commit lightweight SVG only on release. |
| **3** | **4-point perspective correction with automatic corner detection & auto-deskew** | **High** | **Low–Med** (1–2 weeks) | **+8–15 KB** (pure JS) | Essential for wall-mounted evacuation plans photographed from below/side (where area distortion is systematic). Downscale to `~400 px`, detect strong edges -> find largest convex quadrilateral (via contour/LSD + line intersection scoring) matching the sheet/frame border; show 4 draggable corners with a 2× zoom loupe so the inspector confirms or adjusts in 2 seconds (or skips for flat scans/screenshots). Solve `8×8` DLT homography (`H`), warp at target resolution with bilinear/area sampling (preserving aspect ratio via Zhang's / rectangle aspect estimation from vanishing points, or user-provided X/Y or single scale). For flat rotated scans, also run dominant-angle Hough/projection deskew (`±15°`). Runs in `< 150 ms` on phone. |
| **4** | **Per-room confidence score & doubtful-room highlighting** | **Med–High** | **Low** (3–5 days) | **+3–5 KB** (pure JS) | Guides the inspector's eyes straight to errors instead of manually verifying 30 rooms. Score `[0..1]` per room from cheap already-computed signals: (1) doorway leak / saddle margin `(peak - sad) / peak`; (2) wall-enclosure ratio (fraction of perimeter touching real `wallMask` vs BFS cut); (3) internal clutter ratio (removed ink / holes inside room); (4) hollow-wall cavity signature (extreme aspect ratio + width `0.1–0.65 m`); (5) extreme area (`< 2 m²` or `> 40%` of floor); (6) OCR area disagreement (once Rank 7 is added). Highlight low-confidence rooms in amber with a 1-tap reason chip ("Возможна склейка / пустота стены / сверьте площадь"). |
| **5** | **Line-segment detection & parallel-line pairing (hollow walls) + frame/legend rejection** | **High** | **Med–High** (3–4 weeks) | **+15–25 KB** (pure JS) | Directly solves БТИ/CAD **hollow double-line walls**, triple-line windows, and rectangular sheet frames/title blocks. Run fast gradient-aligned line segment detector (LSD / EDLines on grayscale *before* harsh binarization — rescues faint 1–2 px lines lost to thresholding!). Bridge collinear gaps `< 0.25 m` (faint glare breaks, crossing text). Pair antiparallel segments whose perpendicular distance falls within `0.08–0.65 m` (or dominant mode of inter-line gap histogram!) and fill the strip between them into a solid `wallMask`. Classify long sheet-spanning rectangles & high-density text/table grids (штамп/легенда) and mask them out cleanly without `nearAll`'s 3% hack. |
| **6** | **Door arc & jamb gap detection** | **Med–High** | **Medium** (2–3 weeks) | **+10–15 KB** (pure JS) | Solves the hardest structural failure of EDT watershed: **small toilets/closets merging into corridors** and **door-swing phantom rooms**. On the thin-line residual (`ink && !solidWall`), detect quarter-circle arcs (`~70–105°`, radius `0.55–1.3 m`) paired with a radial leaf segment touching a wall endpoint (curvature tracing / fast 3-point circle RANSAC on thin connected components). Also detect collinear wall-endpoint jamb pairs separated by `0.6–1.4 m` (open doors without arcs). Erase door arc/leaf ink from `wallMask` and insert a 1-px **virtual door divider** across the jamb before room flood-fill — making room segmentation topological rather than relying on fragile `tauM`/`openRatio` tuning. |
| **7** | **On-device OCR of printed room areas & numbers (Tesseract.js WASM, `rus`+`kaz`, ROI-only)** | **High** *(for БТИ/техпаспорт)* | **Medium** (2–3 weeks) | **+4–6 MB** lazy-loaded (`tesseract-core-simd.wasm` ~2.5 MB + `rus_fast` ~2 MB; `+1.5–2 MB` if adding `kaz_fast`, gzipped; ~8–12 MB cached uncompressed) | Huge practical win for Kazakhstan БТИ / техпаспорт drawings where exact room areas (`18,4`, `24.6`) and room names/numbers are already printed! **Do NOT run full-page OCR** (slow: 4–10 s, noisy on walls/lines). Instead: extract text-line candidate bboxes inside each detected room from Stage 2's removed small components (plus `0°/90°` orientation check), crop tight `~120×40 px` patches, and run single-threaded SIMD `tesseract.js` in a lazy-loaded worker (cached on demand via Cache Storage like `ensurePdf` at [js/app.js:264](../../js/app.js#L264), **not** blocking initial PWA install). Parse numeric area tokens (`/\d+[.,]\d{1,2}/`) to: (a) **auto-calibrate `scale`** without manual ruler tapping (`median(sqrt(roomPx / ocrArea))` via RANSAC!), (b) **cross-check** every geometric area and flag discrepancies `> 10%`, and (c) auto-fill room names (`Серверная`, `Щитовая`, `Асхана`) for `P.guessPurpose`. Use `rus` `tessdata_fast` first (covers digits + Russian labels; add `kaz` for `Ә, Ғ, Қ, Ң, Ө, Ұ, Ү, Һ, І` as an optional pack). *Caveat:* exact APK/PWA size budget and recognition rate on stamped/skewed БТИ fractions need validation on real scans. |
| **8** | **Small on-device neural segmentation model (ONNX Runtime Web / TF.js)** | **High ceiling**, low near-term ROI | **Very High** (2–4+ months) | **+6–18 MB** lazy-loaded (ORT Web single-threaded WASM ~3–5 MB + INT8 MobileNetV3-UNet ~3–8 MB; larger if multi-class) | **Why ranked last on Impact/Effort:** (1) **Speed & tiling:** Mid-range phones without WebGPU/SAB run a `512×512` MobileNetV3-UNet in ~0.8–2 s (WebGL2) or ~2–5 s (single-threaded WASM SIMD) — and `512×512` is too coarse for a 60 m school (`8.5 px/m`), requiring `2×2` or `3×2` overlapping tiles (4–6× latency + tile-seam stitching). (2) **Licensing & domain gap:** **CubiCasa5k is CC BY-NC 4.0** (non-commercial) — unusable in any commercial/paid product and legally ambiguous even for government agency (ДЧС) deployment without legal clearance or a commercial license; Structured3D and FloorPlanCAD are also non-commercial/research-only; moreover, Finnish/Japanese residential plans look very different from Kazakhstan GOST evacuation plans and БТИ drawings. (3) **Viable future path:** Only pursue as an optional downloadable "AI mode" pack once you build an Apache-2.0/MIT model trained on a **custom procedural KZ synthetic generator** (extending [tools/make-example-plan.js](../../tools/make-example-plan.js) with realistic CAD/БТИ/photo degradations) plus a few hundred locally collected & cleanly licensed Kazakhstan plans. |

*Bonus low-effort ingestion note:* If inspectors frequently receive БТИ техпаспорт as **PDF files**, rendering page 1 via a lazy-loaded `pdf.js` (`~0.8–1.2 MB` gzipped) at `2500 px` directly into the canvas avoids lossy phone-photos-of-screens altogether — very high practical impact if PDF input is common.

---

## 5. Test and Benchmark Plan

### 5.1 Image Corpus to Collect (Target: 60–100 Real + 40 Synthetic/Degraded Cases)

Collect stratified samples (redact PII — owner names, IIN, addresses — before storing; keep non-public field photos in a local/private benchmark folder outside git & `.vercelignore`):

1. **Wall-mounted evacuation plans (15–20 photos):** straight-on, 15–35° oblique perspective, behind glass/plexiglass with ceiling-light glare, uneven corridor shadows, warm tungsten cast, dense green arrows + red fire signs + GOST frames/legends.
2. **БТИ / техпаспорт drawings (15–20 scans/photos/PDF renders):** hollow double-line walls, thin single-line partitions, printed room numbers & underlined areas, dimension lines, triple-line windows, door arcs, staircases, hatching, yellowed paper, BTI stamps.
3. **Apartments & private houses (15–20 images):** heavy furniture, wall-to-wall bathtubs/kitchen counters/wardrobes, tiny `0.85 × 1.2 m` toilets, diagonal/bay walls, colored real-estate marketing plans.
4. **Large & complex public/industrial buildings (10–15 images):** schools, hospitals, offices (`60–160 m` span), central-core ring corridors, open-plan halls with columns, L/U/T-shaped wings, multi-building site plans.
5. **Edge & adversarial cases (10–15 images):** tightly cropped screenshots, uncropped CAD/PDF viewer screenshots with dark UI chrome, hand-drawn pencil & blue-pen sketches, low-res WhatsApp-compressed photos (`< 800 px`), rotated `10°`/`45°`/`90°` plans, empty/blurry non-plan photos (must return 0 rooms cleanly).

### 5.2 Ground-Truth Format

Extend the existing [examples/plan-school.json](../../examples/plan-school.json) schema into a unified per-image annotation file (`*.gt.json`):

```json
{
  "image": "bti-apt-01.png",
  "w": 1600,
  "h": 1120,
  "category": "bti_hollow_walls",
  "tags": ["hollow_walls", "door_arcs", "printed_areas", "warm_cast"],
  "quad": [[42, 31], [1560, 58], [1544, 1088], [28, 1071]],
  "calibration": { "scale": 42.5, "ruler": [[120, 980], [545, 980], 10.0], "totalAreaM2": 84.2 },
  "buildingKind": "public",
  "rooms": [
    {
      "id": "gt1",
      "name": "Санузел",
      "purpose": "office",
      "isCorridor": false,
      "areaM2": 1.3,
      "printedAreaM2": 1.3,
      "poly": [[410, 520], [450, 520], [450, 585], [410, 585]],
      "holes": []
    }
  ]
}
```

Use polygons (annotated in a lightweight browser tool or CVAT/LabelMe exported to this JSON) so IoU can be computed exactly by rasterizing `gt.poly` vs `pred.poly` in pure JS (scanline fill) with zero native dependencies.

### 5.3 Metrics

Evaluate both ruler-scale mode and `areaM2` mode:

- **Room detection & topology:** 1-to-1 optimal matching (Hungarian/greedy) at `IoU >= 0.50` -> **Precision**, **Recall**, **F1**, exact room count error `|N_pred - N_gt|`, **Split rate** (GT room covered by `>= 2` predicted rooms with `>= 20%` overlap each), **Merge rate** (predicted room covering `>= 2` GT rooms with `>= 20%` overlap each), and **False-positive rate** (unmatched predicted rooms: hollow walls, furniture, legends).
- **Geometric quality:** **mIoU**, median IoU, and **P10 IoU** (catches single badly mangled rooms) across matched pairs.
- **Area accuracy:** Median and **P90 relative area error** `|A_pred - A_gt| / A_gt` (%), plus total floor area error (%).
- **Domain-specific safety metric:** Pass GT rooms vs predicted rooms through `FireEngine.calculate` (`js/engine.js`) and measure **extinguisher count error** (`ΔОП`, `ΔОУ`, and under-estimation rate — under-counting extinguishers is a safety failure!).
- **Sub-task metrics (as added):** Quad corner error (`px` RMSE), corridor F1, OCR area exact-match rate (`±0.1 m²`).
- **Runtime & memory budgets:** `ms` (P50/P95) and peak `process.memoryUsage().arrayBuffers` in Node (target: `< 60 MB` peak arrayBuffers, `< 500 ms` on desktop Node ≈ `< 1.5 s` on mid-range phone).

### 5.4 Wiring Into Existing Node Tests

1. **Extend [tests/helpers.js](../../tests/helpers.js):**
   - `readPng` ([tests/helpers.js:5-35](../../tests/helpers.js#L5-L35)) currently rejects grayscale (color type 0), gray+alpha (type 4), and palette (type 3) PNGs. Add support for all standard non-interlaced PNG color types, and add a pure-JS polygon rasterizer + IoU/matching helper (`rasterizePoly`, `matchRooms`).
   - For real JPEG phone photos, either pre-convert benchmark assets once to lossless PNG (zero new npm runtime deps) or add a tiny dev-only JPEG decoder for the benchmark script.
2. **Tier 1 — Fast deterministic regression suite (`npm test` -> [tests/vision.test.js](../../tests/vision.test.js)):**
   - Keep `npm test` fast (`< 5 s`), zero-dependency, and strictly passing (100%).
   - Add synthetic stress generators right alongside `planImage` and `apartmentImage`: hollow double-line walls, warm/yellow white balance + severe shadow (`0.25..1.0`) + glare patches, dark red/green symbols (`l = 40`), tightly cropped plan (`< 2%` margin), sheet with GOST frame + title block + legend, wall-to-wall bathtub & kitchen counter, realistic `0.85 × 1.2 m` toilet, ring corridor around 4 core rooms, `s = 100` apartment, 15°/45° rotated plans, 2-building sheet, and perspective-warped synthetic plan.
   - Add stage-level unit tests (see Section 6.4).
3. **Tier 2 — Real-plan benchmark suite (`npm run bench:vision` -> `tools/bench-vision.js`):**
   - Reads `benchmarks/vision/manifest.json` (excluded from `sw.js` `ASSETS` and `.vercelignore`; supports an optional `BENCH_PRIVATE_DIR` env var for unredacted real ДЧС photos).
   - Prints a per-category markdown/console scorecard and diffs against `benchmarks/vision/baseline.json`, exiting non-zero if any category's F1, mIoU, P90 area error, or extinguisher under-estimation regresses beyond tolerance (e.g., `-2%`).

---

## 6. Recommended Architecture for a Rewritten Pipeline

### 6.1 Modular Stages

Keep vanilla JS UMD modules (no bundler; works identically via `require()` in Node, `<script>` in browser, and `importScripts()` in Web Worker; register in `sw.js` `ASSETS`).

1. **`vision-geom.js` — Preprocess & Rectification:**
   - Adaptive pyramid (`full` up to `2048 px` for thin-line extraction; `work` `<= 1200 px` or `~25 px/m` for segmentation; `thumb` `~400 px` for quad/angle detection).
   - `detectQuad(thumb)` -> 4 corners + confidence; `warpHomography(rgba, quad, outW, outH)` -> rectified RGBA; `detectSkewAngle(gray)` -> `±15°` deskew when no quad is warped.
2. **`vision-ink.js` — Normalization, Color Separation & Binarization:**
   - Per-channel smooth background illumination estimate `bg` -> illumination-flattened, white-balanced RGB + `gray`.
   - HSV/chromaticity separation -> `colorMask` (saturated evacuation arrows, fire signs, colored room fills) vs neutral `inkGray`.
   - Sauvola/Wolf adaptive thresholding (`Uint32` + `Float64` integral images) -> `inkMask` (`Uint8Array`).
3. **`vision-walls.js` — Wall & Door Structure Extraction:**
   - Gradient-based line segment detection (on `inkGray`, rescuing faint lines) + collinear gap bridging.
   - Parallel-line pairing (auto-detecting wall-thickness mode in px/m) -> fills hollow double-line walls & merges triple-line windows into solid `wallMask`.
   - Sheet layout classifier: separates outer GOST frame, title block (штамп), and legend tables from building structures -> `sheetMask`.
   - Thin-line residual analysis: detects **door arcs + jamb gaps** -> `doors[]` (virtual 1-px divider segments) and **text-line candidates** -> `textBoxes[]` (for optional OCR and clean removal from `wallMask`).
4. **`vision-rooms.js` — Multi-Building Exterior & Graph-Based Room Segmentation:**
   - Exterior detection: temporarily closes `doors[]` and short exterior gaps (`<= 0.3 m`), floods from border/sheet-margin -> `exteriorMask` (supports **multiple buildings** naturally without `0.2 * largest` or `sx0..sx1` clipping!).
   - Room segmentation: runs `Float32` EDT (`dist`) on `wallMask | doorDividers`; uses **local-saddle persistence watershed** (recording saddles per *edge* in a Region Adjacency Graph instead of a single global `sad[r]` scalar!) + Euclidean-weighted propagation so wings never starve and boundaries stay centered in doorways.
   - Graph-based cleanup: merges wall-adjacent fixtures/furniture using RAG edge attributes (shared boundary thickness from `wallThicknessMap`, internal clutter, and neighbor count — removing the broken bbox containment test and the `crossed` wall-hole bug).
   - Vectorization & semantics: traces outer contour **and interior holes**, optional orthogonal corner snapping + Douglas-Peucker, medial-axis width estimation for `looksLikeCorridor` (rotation- & L-shape-invariant), and per-room `confidence` + warning flags.
5. **`vision-ocr.js` *(optional, lazy-loaded)* — ROI Text & Area Cross-Check:**
   - Crops `textBoxes[]` inside each room, runs single-threaded SIMD `tesseract.js` (`rus`/`kaz`), extracts printed `areaM2` and room labels, proposes RANSAC `scale` when printed areas exist, and attaches `ocrArea` / `ocrName` + discrepancy flags to rooms.
6. **`vision-edit.js` — Fast Interactive Edit Engine:**
   - Pure operations over the cached `SegmentationState`: `mergeRooms(idA, idB)`, `splitRoom(id, polyline)`, `applyWallStroke(polyline, radius, addOrErase)` (local dirty-bbox re-flood/re-segment), `addRoomAt(x, y)`, `moveVertex(id, idx, pt)`, `recomputeAreas(activeIds, scaleOrAreaM2)`.

### 6.2 Data Passed Between Stages (Memory-Bounded Contracts)

Use compact typed arrays (`Uint8Array`, `Int32Array`, `Float32Array`) and a reusable `ScratchPool` to keep peak RAM at **~30–45 MB** (down from ~140 MB):

```text
Stage 1 -> RectifiedImage   { w, h, rgba: Uint8ClampedArray, homography: Float64Array(9), skewDeg }
Stage 2 -> InkBundle        { w, h, gray: Uint8Array, ink: Uint8Array, color: Uint8Array }
Stage 3 -> StructureBundle  { w, h, wallMask: Uint8Array, wallThick: Uint8Array,
                              doors: [{ x0, y0, x1, y1, kind, conf }],
                              textBoxes: [{ x0, y0, x1, y1, angle }],
                              sheetExclude: Uint8Array }
Stage 4 -> SegmentationState { w, h, wallMask, exteriorMask, dist: Float32Array,
                               labelMap: Int32Array, rag: Map<edgeKey, EdgeStats>,
                               rooms: [{ id, px, area, bbox, lx, ly, poly, holes,
                                         corridor, confidence, flags, ocr? }] }
Stage 6 -> EditDelta        { changedRoomIds, rooms, scale, ms }
```

### 6.3 Worker Boundary (`js/vision.worker.js` <-> `js/app.js`)

Replace the stateless "copy 7.7 MB RGBA on every call" RPC ([js/app.js:244-246](../../js/app.js#L244-L246)) with a **stateful session protocol**:

- **`loadSession({ sessionId, w, h, buffer })`** *(transfers `ArrayBuffer` once)*: worker stores raw/rectified image and clears any previous session to bound RAM.
- **`detectQuad({ sessionId })`** -> `{ quad, confidence }`.
- **`analyze({ sessionId, jobId, quad?, scale?, areaM2?, options })`**:
  - Caches `InkBundle` and `StructureBundle` per `(sessionId, quad)` — so **pass 2 in `areaM2` mode or re-scaling never re-transfers pixels or re-runs normalization/line detection**!
  - Posts `{ jobId, type: 'progress', stage, pct }` between stages and checks `cancelledJobId` before each stage so closing the modal or changing scale aborts cleanly.
  - Returns lightweight JSON (`rooms`, `doors`, `scale`, `warnings`, `ms`) plus optional downscaled preview mask (`Transferable`) if overlay debugging is enabled.
- **`edit({ sessionId, op, payload })`** -> `{ rooms, scale, ms }` (runs in `< 30 ms` against cached `SegmentationState`, returning only updated polygons/areas).
- **`runOcr({ sessionId, roomIds })`** -> runs in a **separate lazy worker** (or lazy `importScripts`) so base recognition loads instantaneously and OCR never blocks interactive edits.
- **Error recovery:** On `worker.onerror`, call `visionWorker.terminate()`, respawn a clean worker on next request, and show a recoverable error message — only fall back to main-thread execution when `new Worker(...)` throws synchronously (e.g., `file://` origin).

### 6.4 Keeping Every Stage Testable

- **Zero DOM/Canvas/Worker coupling in all core modules:** Every stage is a pure function `(input, config, debugOut?) => output`, directly runnable via `node --test` (matching the existing pattern in [js/vision.js:21-24](../../js/vision.js#L21-L24)).
- **Direct stage unit tests:**
  - `vision-geom`: test homography round-trip on known quads (`error < 0.5 px`).
  - `vision-ink`: test synthetic glare, 4:1 shadows, warm `(240,220,170)` paper, and dark green/red symbols (`l = 45`) directly on `inkMask` / `colorMask` IoU.
  - `vision-walls`: test hollow parallel-line pairing, triple-line window merging, door-arc detection, and GOST frame rejection on small synthetic rasters.
  - `vision-rooms`: test multi-building exterior flooding, ring corridors, small toilets with virtual door dividers, and RAG furniture merging.
  - `vision-edit`: test `splitRoom`, `mergeRooms`, `applyWallStroke`, and area conservation (`sum(split) == original` minus barrier).
- **Opt-in `debug` hooks:** Passing `{ debug: true }` returns intermediate masks/line segments/RAG edges so `tools/bench-vision.js` can dump visual overlays on failing benchmark images without polluting production memory or worker messages.
- **Determinism:** Fix tie-breaking order in DSU/watershed, avoid unordered iteration dependencies, and seed any RANSAC (e.g., door-arc or OCR-scale fitting) deterministically (reusing `mulberry32` from [tests/helpers.js:42](../../tests/helpers.js#L42)) so Node benchmarks reproduce mobile behavior identically.
