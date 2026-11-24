# Задание: приложение 2.0, фаза B (схема, распознавание плана, отчёт, хранение, казахский)

Four jobs, each on its own branch from main (after app-v2 phase A is merged into main). Read docs/briefs/common.md, AGENTS.md, docs/briefs/app-v2-a.md (phase A, the stack and the gates), docs/plan.md (sections В, 2, 3, 5, И), docs/design.md, docs/style.md, docs/architecture.md, docs/adr/0001-app-stack.md first.

The goal of phase B: the new app (app/) does everything the old app (index.html, js/app.js) does, so phase C can switch over. The old app keeps working and is not modified, except where a job below says so.

## Rules for all four jobs

- Own only the files listed for your job. Shared files (app/src/router.ts, app/src/i18n/ru.ts, app/src/i18n/kk.ts, app/src/stores/inspection.ts, package.json) get small additive changes in separate blocks, so the orchestrator can merge the branches.
- New UI strings go to ru.ts; kk.ts gets the same keys with the Russian value and a `// TODO kk` comment (job B4 translates them). Texts per docs/style.md.
- No runtime network access. Heavy parts load lazily in their own chunks: pdfmake and fonts, OCR, the plan wizard. The initial chunk stays under 300 kB gzip (report the build output).
- Data stays compatible with the old app's format (js/app.js: floors, rooms, plan marks, blueprint, image keys) until job B3 moves storage; B3 migrates without losing anything.
- No new runtime dependencies beyond those named in the job. Dev dependencies only if needed and pinned.
- Gates, all must pass and be reported: `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:e2e` (phone and desktop projects, no request except localhost), `npm run app:build`, `node --test --test-concurrency=1`, `node tools/check-ui.js`. Update the committed screenshots in app/e2e/screenshots/ for the screens you change and look at them before you finish.
- Never use real building plans; test images come from tools/synth-plans.js or the public set in bench/vision (not committed).

## B1. Схема этажа (Gemini 4 Neon XHigh; branch app-v2-b1)

Own: app/src/components/scheme/**, the Scheme part of the floor screen, app/src/engine/marks.ts (new), their tests.

1. Full-screen scheme of the floor built from js/plan.js scene geometry: rooms with names and areas, the blueprint image under the rooms when the floor has one (IndexedDB image store and key as in js/app.js), coverage circles of the limit distance (п. 4 приложения 3 к Правилам) for placed extinguishers, uncovered parts highlighted as js/plan.js `audit` reports them.
2. Pan and zoom with two fingers and the mouse wheel, double tap to zoom, a «По размеру» button. Zoom applies to the scheme only; the page does not zoom.
3. Sign strip at the bottom on phones, at the side on desktop: ОП, ОУ, F02, F10, F05, F06, E01 with icons from js/signs.js, targets at least 48 px. The selected sign stays selected for repeated placing.
4. Tap on an empty place puts the selected sign there; `navigator.vibrate(15)` where available. The mark gets its room by hit test.
5. Tap on a mark opens actions (bottom sheet on phones, popover on desktop): «Переместить» (drag), «Тип» (extinguisher types from js/engine.js catalog), «Состояние», «Удалить» (with «Отменить»). A tap never deletes directly.
6. «Состояние» of an extinguisher mark (decision Д5), each field optional, findings in the same shape as js/plan.js `audit` findings (place, finding, measure, reference) so the result screen and the report list them:
   - пломба на запорно-пусковом устройстве: нет → основание «п. 56 Правил; п. 111 приложения 3 к совместному приказу МВД РК № 758 и МНЭ РК № 31»;
   - индикатор давления в зелёной зоне: нет, или огнетушитель неисправен → основание «п. 51 приложения 3 к совместному приказу МВД РК № 758 и МНЭ РК № 31; СТ РК 1487-2006»;
   - дата следующего технического обслуживания (перезарядки) с этикетки: раньше даты проверки → то же основание, что для давления;
   - размещение (видное место, высота не более 1,5 м, не мешает эвакуации): нет → основание «п. 12 приложения 3 к Правилам».
   These references were checked by the orchestrator against the editions of 25.08.2026 (Правила) and 27.08.2026 (совместный приказ); do not change them.
7. Undo and redo of scheme edits (Ctrl+Z and Ctrl+Y on desktop, «Отменить» in the message on phones).
8. On floors with a scheme the installed counts come from the marks, as in the old app.

Tests: unit tests for hit testing, the state findings (every field, dates around the inspection date), undo; e2e: place three signs, move one, change a type, set a state that gives a finding and see it on the result screen, delete with undo, zoom with the wheel; screenshots of the scheme on phone and desktop.

## B2. Распознавание плана (Gemini 4 Neon XHigh; branch app-v2-b2)

Own: app/src/screens/plan/**, app/src/components/plan/**, app/src/workers/**, their tests. Uses js/vision.js, js/vision-geom.js and js/vision-ocr.js without modifying them.

1. «Снять план» on the floor screen: camera or gallery (`<input type="file" accept="image/*" capture="environment">`), on desktop a file chooser and dropping an image onto the window.
2. Step «Углы»: `detectQuad` proposes the corners; four handles to drag with a magnifier near the finger; «Повернуть» by 90°; «Без обрезки» for scans and screenshots. Then `warp` to a rectified image of sensible size.
3. Step «Помещения»: `findRooms` runs in a module Web Worker built by Vite (the old js/vision.worker.js stays for the old app), with progress and «Отмена». Rooms are drawn over the image.
4. Step «Масштаб»: first from printed areas with js/vision-ocr.js (lazy chunk; vendor/tesseract files are copied into the build as static assets and the paths point to them; nothing from a CDN); used when at least 3 rooms agree, and the screen says where the scale came from. Otherwise the floor area in м² or a segment: two points on the plan and its length in metres.
5. Step «Проверка»: rooms over the image and as a list; exclude a room, rename, merge two rooms; areas recalculate at once without a new recognition; undo. Splitting by a drawn line only if it fits in the job; otherwise list it for stage 2.6.
6. «Добавить помещения»: rooms go to the floor (names from OCR through `guessPurpose` of js/presets.js), the image goes to the image store, the blueprint geometry is saved in the old format so the scheme (B1) shows it.
7. Errors per docs/style.md, for example «Помещения не найдены. Проверьте масштаб или снимите план ближе».

Tests: unit tests for the worker protocol and the scale choice; e2e with a synthetic plan PNG made by tools/synth-plans.js and committed as a small fixture in app/e2e/fixtures/ (synthetic only): through all steps to rooms with areas within 10 % of the truth; screenshots of every step on phone and desktop.

## B3. Отчёт, перенос и хранение (Gemini 4 Argon High; branch app-v2-b3)

Own: app/src/screens/report/**, app/src/services/** (platform and storage), the storage parts of app/src/stores/, their tests.

1. Отчёт: a dialog with the header fields of js/report.js (государственный орган, акт о назначении проверки, ИИН или БИН, руководитель субъекта контроля), prefilled from the profile and the object; an HTML preview of the report data; buttons «Сохранить PDF», «Открыть», «Отправить», «Печать». A typed platform service replaces js/platform.js: Electron bridge `window.firecalcDesktop` (saveFile, openFile, print), Capacitor Filesystem and Share as js/platform.js uses them, a download on the web. pdfmake and fonts load lazily.
2. Ссылка и QR-код on the result as in the old app (js/share.js).
3. Storage (plan 5.1): IndexedDB database with a schema version and migrations; objects and images (Blobs) in separate stores; one-time import from localStorage `firecalc.store.v2` and the old image store, the old data stays as a backup; `navigator.storage.persist()`; used space in Settings. Every change is saved (typing debounced by 250 ms), flushed on pagehide. ADR 0008 «Хранение в IndexedDB».
4. Резервная копия (plan 5.2): «Сохранить копию» writes all objects with images to one .json file; «Восстановить из копии» reads it and asks «Заменить» or «Добавить» for objects with the same id.
5. Файл объекта (plan 3.7, basic): the same format for one object, «Сохранить объект в файл» and «Открыть файл объекта».

Tests: unit tests for the migrations, export and import round trip, persist unavailable; e2e: create an object, reload, it is there; export, import in a clean browser profile, the same data; «Сохранить PDF» on the web gives a PDF whose text contains the header fields.

## B4. Казахский язык (Gemini 4 Argon High; branch app-v2-b4; after B1–B3 are merged)

Own: app/src/i18n/kk.ts, docs/kk-glossary.md (new), the Kazakh parts of js/library-kk.js, the language option of js/report.js and its tests.

1. kk.ts: every key translated. Terms as in the official Kazakh texts of the norms (js/library-kk.js, adilet.zan.kz Kazakh versions); the glossary lists each term: Russian, Kazakh, source.
2. js/library-kk.js: the fields use, status and why in Kazakh (they are explanations of the program, not norm texts); check the short labels.
3. PDF in Kazakh: js/report.js gets an option `lang` ('ru' by default) with a dictionary; in Kazakh the conclusion quotes the official Kazakh text of п. 51 приложения 3 and строки 57 приложения 1 of the joint order (https://zakon.uchet.kz/kaz/docs/V1800017647 or adilet), verbatim; the PDF font shows Ә Ғ Қ Ң Ө Ұ Ү Һ І. Tests for both languages; render a Kazakh sample and look at it.
4. Numbers and dates in Kazakh mode: decimal comma, ДД.ММ.ГГГГ.

Tests: key parity, no Russian value left in kk.ts except an allowed list (abbreviations like ОП-5, units); e2e screenshots of every screen in Kazakh.

## Report (every job)

What was built, gate results with numbers, bundle sizes, screenshots list, what is left and why. Commit in logical steps with short Russian messages.
