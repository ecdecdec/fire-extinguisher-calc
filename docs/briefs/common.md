# Общие правила для заданий моделям (Gemini через agy)

Project: offline PWA for Kazakhstan fire-safety inspectors (ДЧС). Vanilla JS (UMD modules that work in the browser, in a Web Worker and in Node tests), Vue 3 global build, no bundler, no runtime dependencies. The floor-plan recognizer is js/vision.js (pure functions over RGBA pixels, runs in js/vision.worker.js), tests are in tests/ and run with `node --test tests/`.

Rules for every job:
1. Work only inside the current directory (a git worktree on its own branch). Commit your work on the current branch when done, in one or a few commits with short plain Russian commit messages. Do not push, do not create other branches, do not touch the git configuration.
2. Change only the files your job lists. Do not run `node tools/build.js` or `npm run build` (they restamp index.html, sw.js and js/config.js; the owner does it after merging). Because of that, tests/pwa.test.js may fail on the build stamp: ignore only that failure. Every other test must pass.
3. No new dependencies, no npm install, no network access. Node 22 is available.
4. Code style: like the existing code (ES2015+, functions, no classes needed, no optional chaining `?.` or `??` because old Android WebViews must run the code). Comments and test names in Russian, short and plain. Do not use the em dash character or the middle dot character in new comments, strings or commit messages.
5. Keep memory low: Uint8Array, Int32Array, Float32Array where possible; the code runs on mid-range phones.
6. Public test pictures are in bench/vision/img/*.png (59 floor plans from Wikimedia Commons, list and expected room counts in bench/vision/sources.json and bench/vision/expect.json). `node tools/vision-gallery.js` runs the recognizer on all of them and writes bench/vision/out/index.html and results.json. bench/vision/img and bench/vision/out are not in git: never add them to a commit.
7. Final answer (stdout): a short report in English: what you changed (files), how you verified it (commands and their results), numbers before and after where relevant, known limitations. No padding.
