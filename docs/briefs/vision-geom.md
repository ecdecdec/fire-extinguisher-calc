# Задание: углы плана на снимке и выпрямление (этап 2.1 плана, вычисления)

Model: Gemini 4 Neon (XHigh). Branch: vision-geom. Read docs/briefs/common.md first and follow it.

Goal: before recognition, the app will show the photo with four draggable corners around the plan; the inspector adjusts them and the picture is straightened and cropped. You write the computations; the owner writes the interface.

Create js/vision-geom.js, a UMD module like js/vision.js (global name FireVisionGeom, `module.exports` in Node, usable from a Web Worker), with pure functions:
1. `detectQuad(rgba, w, h)` returns `{ quad: [[x,y],[x,y],[x,y],[x,y]] /* top-left, top-right, bottom-right, bottom-left, image px */, score /* 0..1 */, kind }` where kind is:
   - 'sheet': a paper sheet or a framed plan photographed with background around it (find the largest convex quadrilateral consistent with strong edges: paper against wall, frame of the plan, glass frame);
   - 'frame': the image is the sheet itself (scan, screenshot) but a printed frame line exists inside: return the frame;
   - 'full': nothing better found: return the image corners.
   Work on a downscaled copy (about 400 to 600 px on the long side) and refine corners at full resolution if cheap.
2. `planBox(rgba, w, h, quad)` returns a suggested crop inside the quad that contains the floor plan but not the title text, the legend table or the instruction text columns typical for evacuation plans: the bounding box of the largest connected structure of long thick lines (the building outline), expanded by a small margin; `null` if unsure.
3. `rectifiedSize(quad, w, h)` returns `{ w, h }` for the straightened picture: aspect ratio estimated from the quad (average of opposite sides is acceptable; a better estimate from vanishing points is welcome), long side at most 1600 px.
4. `homography(src4, dst4)` (direct linear transform, 3x3 as a Float64Array of 9) and `applyH(H, x, y)`.
5. `warp(rgba, w, h, quad, outW, outH)` returns a new Uint8ClampedArray of outW x outH x 4: bilinear sampling, with light area averaging when shrinking strongly so thin lines survive.

Tests (tests/vision-geom.test.js), on synthetic pictures made inside the test file: a white sheet with a drawn floor plan, warped by a known perspective (tilt 15 and 30 degrees) onto a textured gray background with a shadow gradient: detectQuad finds every corner within 2 % of the image diagonal; warp back gives the plan with wall lengths within 2 % of the truth; a scan-like picture with a printed frame gives kind 'frame'; a screenshot-like picture filling the image gives 'full'; homography maps the four points exactly (1e-6). Also run detectQuad on the real pictures in bench/vision/img and report, per picture, kind and score; look at a few results (you can render the quad onto a copy of the picture in memory and describe it) and report where it fails.

Performance on a 1600 x 1200 picture in Node: detectQuad under 150 ms, warp under 300 ms.

Create only js/vision-geom.js and tests/vision-geom.test.js. Do not register the file in index.html or sw.js.
