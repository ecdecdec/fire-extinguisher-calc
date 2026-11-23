> Разбор: интерфейс и ощущение приложения. Модель Gemini 4 Argon (High) через agy, 23.11.2026, только чтение кода.
> Главные выводы сверены с кодом и вошли в docs/plan.md. Остальное не проверено.

# Audit Report: Fire Extinguisher Calculation & Inspection App (ДЧС РК)

---

## 1. Why the Android and Windows Apps Feel Like a Website in a Wrapper

Prioritized from highest-impact shell and interaction breaks to platform-specific leaks.

### P0 — Core Shell, Input & Viewport Mechanics

1. **Unbounded webpage scroll and tab switching that loses scroll position (`window.scrollTo(0, 0)`)**
   - **Evidence**: On screens `<= 1180px`, `.work` collapses into a single document flow ([css/app.css:457-460](../../css/app.css#L457-L460)) where `body` scrolls the entire page. Switching between the `Помещения` and `Результат` tabs calls `window.scrollTo(0, 0)` ([js/app.js:1058-1061](../../js/app.js#L1058-L1061)), destroying the inspector's vertical scroll position in the room list every time they check the result. Floors, rooms, and expanded SVG floor schemes stack in one long document ([js/app.js:318-504](../../js/app.js#L318-L504)), and object switching lives inside a web dropdown (`div.menu__panel`, [js/app.js:283-305](../../js/app.js#L283-L305), [css/app.css:140-154](../../css/app.css#L140-L154)).
   - **Fix (Web)**: Lock the app shell to `height: 100dvh; overflow: hidden;` on `html, body, #app`, and make each screen/pane an independent scroll container (`overflow-y: auto; overscroll-behavior-y: contain`) using `v-show` (or cached scroll offsets) so switching views never resets scroll position.

2. **Missing `user-select: none`, `-webkit-touch-callout: none`, and `-webkit-tap-highlight-color: transparent` on UI chrome**
   - **Evidence**: `user-select: none; -webkit-user-select: none;` is set **only** on `.plan__svg` ([css/app.css:238](../../css/app.css#L238)) and `.bp__svg` ([css/app.css:288](../../css/app.css#L288)). Neither `body` ([css/app.css:51-52](../../css/app.css#L51-L52)) nor interactive controls (`.btn`, `.tab`, `.chip`, `.tool`, `.seg__opt`, `.room__summary`, `summary`, `.top`) disable tap highlights, touch callouts, or text selection. Tapping controls in Android WebView flashes the default Chromium tap box; long-pressing a button or label pops up Android text-selection handles and the `"Копировать / Поделиться / Веб-поиск"` bar; dragging the mouse on Windows highlights button and header text.
   - **Fix (Web)**: Add `-webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;` to `body` in [css/app.css:52](../../css/app.css#L52), and explicitly re-enable `user-select: text` only on `input, textarea, .lib__item, .ref, .linkbox`. In [js/app.js:1924](../../js/app.js#L1924), block `contextmenu` outside editable inputs when `PF.kind !== 'web'`.

3. **Edge-to-edge Android 15/16 (`targetSdk 36`) collision, missing `viewport-fit=cover`, missing `env(safe-area-inset-*)`, and missing `windowLightNavigationBar`**
   - **Evidence**:
     - [index.html:5](../../index.html#L5) omits `viewport-fit=cover`.
     - `css/app.css` has **zero** `env(safe-area-inset-top)` or `env(safe-area-inset-bottom)` rules on `.top` ([css/app.css:134-135](../../css/app.css#L134-L135)), `.bar` ([css/app.css:464-465](../../css/app.css#L464-L465)), `.toast` ([css/app.css:409](../../css/app.css#L409)), or `.modal--full` ([css/app.css:512](../../css/app.css#L512)).
     - [native/android/variables.gradle:3-4](../../native/android/variables.gradle#L3-L4) sets `compileSdkVersion = 36` and `targetSdkVersion = 36`, where Android enforces edge-to-edge and deprecates `android:statusBarColor` / `android:navigationBarColor`.
     - In [native/android/app/src/main/res/values/styles.xml:17-20](../../native/android/app/src/main/res/values/styles.xml#L17-L20), `android:navigationBarColor` is set to `@android:color/white` and `android:windowLightStatusBar` is `true`, **but `android:windowLightNavigationBar` is missing**—causing light navigation bar buttons to render with poor contrast or a forced gray system scrim on Android 8.1–14.
   - **Fix (Web & Native)**: Add `viewport-fit=cover` to [index.html:5](../../index.html#L5); apply `padding-top: env(safe-area-inset-top)` to `.top` and `.modal--full .bp__head` and `padding-bottom: calc(8px + env(safe-area-inset-bottom))` to `.bar__in`. In [native/android/app/src/main/res/values/styles.xml:19](../../native/android/app/src/main/res/values/styles.xml#L19), add `<item name="android:windowLightNavigationBar">true</item>`.

4. **On-screen keyboard pushes the 64px fixed bottom `.bar` over the active input**
   - **Evidence**:
     - [native/android/app/src/main/AndroidManifest.xml:12-18](../../native/android/app/src/main/AndroidManifest.xml#L12-L18) does not declare `android:windowSoftInputMode="adjustResize"`.
     - On screens `<= 1180px`, `<footer class="bar">` is `position: fixed; left: 0; right: 0; bottom: 0` ([css/app.css:464](../../css/app.css#L464)). When the Android soft keyboard opens on any input (`room.name`, `room.area`, `installedOP`), the 64px footer rides directly on top of the keyboard, covering the focused room row and eating 64px of vertical viewport.
     - All viewport heights in [css/app.css:143,161,284,288,401,417](../../css/app.css#L143) use `100vh` instead of `100dvh`, so `.modal__box` does not shrink cleanly when the virtual keyboard appears.
   - **Fix (Native & Web)**: Add `android:windowSoftInputMode="adjustResize"` to `.MainActivity` in [native/android/app/src/main/AndroidManifest.xml:18](../../native/android/app/src/main/AndroidManifest.xml#L18). In `css/app.css`, replace `100vh` with `100dvh`, hide `.bar` while text/number inputs are focused on touch viewports, and call `scrollIntoView({ block: 'center' })` on focused inputs when `window.visualViewport` shrinks.

5. **Overscroll glow/bounce and background scroll chaining behind open modals**
   - **Evidence**: `overscroll-behavior` is not set anywhere in `css/app.css` ([css/app.css:50-53](../../css/app.css#L50-L53)). Scrolling to the ends of `.modal__box` ([css/app.css:401](../../css/app.css#L401)), `.menu__panel` ([css/app.css:143](../../css/app.css#L143)), `.lib__body` ([css/app.css:418](../../css/app.css#L418)), or `.bp__panel` ([css/app.css:297](../../css/app.css#L297)) chains scroll events to the underlying `body`, and `body` is never scroll-locked when `pdfDialog`, `bp`, `library`, or `menuOpen` is active.
   - **Fix (Web)**: Add `overscroll-behavior: none` to `html, body` and `overscroll-behavior: contain` to all modal/panel scroll containers.

---

### P1 — Native Bridges: PDF, Camera/File Picker, Share & Hardware Back

6. **PDF saving, opening, and sharing behaves like a browser download on Windows and traps files in private `CACHE` on Android**
   - **Evidence**:
     - Every primary CTA says **"Скачать PDF"** ("Download PDF" — [js/app.js:510,696,844](../../js/app.js#L510)), which is web-browser terminology.
     - **Android ([js/platform.js:49-62,79-84](../../js/platform.js#L49-L62))**: `savePdf` writes the PDF into `directory: 'CACHE'` (the app's private cache folder, inaccessible from the user's Files/Downloads app) and immediately invokes `Share.share`. There is **no way to preview/open the PDF** in a PDF viewer or save it directly to `Downloads`/`Documents` without sharing. If the inspector dismisses the share sheet, [js/app.js:1868](../../js/app.js#L1868) shows: `"PDF готов: <имя>. Чтобы отправить, нажмите «Скачать PDF» ещё раз"`, leaving the file stranded in `CACHE`.
     - **Windows ([js/platform.js:80](../../js/platform.js#L80), [native/desktop/main.js:74-76](../../native/desktop/main.js#L74-L76))**: `pdf.download(name, cb)` triggers a synthetic `<a download>` click. `pdfmake` invokes the callback as soon as the blob download begins—**before** the user chooses a folder or clicks Save/Cancel in Electron's `will-download` Save As dialog. As a result, [js/app.js:1866-1869](../../js/app.js#L1866-L1869) closes the modal and flashes `"PDF сохранён: <имя>"` **while the Windows Save dialog is still open, and even if the user clicks Cancel**. After saving, there is no button to open the PDF (`shell.openPath`) or reveal it in Explorer (`shell.showItemInFolder`).
   - **Fix (Native & Web)**:
     - Rename `"Скачать PDF"` to `"Сформировать PDF"` / `"Сохранить PDF"`.
     - **Windows**: Expose `firecalcDesktop.savePdf(name, base64)` via `ipcRenderer.invoke` in [native/desktop/preload.js](../../native/desktop/preload.js) using `dialog.showSaveDialog` + `fs.promises.writeFile` in [native/desktop/main.js](../../native/desktop/main.js), returning `{ saved, filePath }`, and provide an `"Открыть"` action calling `shell.openPath(filePath)`.
     - **Android**: Write to `Documents` or `CACHE` and offer two distinct actions: `"Открыть PDF"` (via native `Intent.ACTION_VIEW` with `FileProvider` URI) and `"Поделиться PDF"` (`Share.share`).

7. **Raw HTML `<input type="file">` instead of native camera / drag-and-drop, plus unnecessary `INTERNET` permission**
   - **Evidence**:
     - [js/app.js:739-740,760](../../js/app.js#L739-L740) uses `<input type="file" accept="image/*" capture="environment">`. In Android WebView, `capture="environment"` on a file input is inconsistent across OEM WebViews (often opening a generic file picker instead of the camera).
     - On Windows (Electron), `.bp__start` and `.bp__stage` ([js/app.js:723-744](../../js/app.js#L723-L744)) have no `@dragover.prevent` / `@drop.prevent` handlers—dragging an image file from Explorer onto the window is ignored.
     -Meanwhile, [native/android/app/src/main/AndroidManifest.xml:40](../../native/android/app/src/main/AndroidManifest.xml#L40) requests `android.permission.INTERNET` even though the app is strictly offline.
   - **Fix (Native & Web)**: Add `@dragover.prevent` / `@drop.prevent` on `.bp` in [js/app.js:716](../../js/app.js#L716) to accept dropped image files. On Android, use `@capacitor/camera` (or a small native `Intent(MediaStore.ACTION_IMAGE_CAPTURE)` bridge in `MainActivity.java`) for `"Сфотографировать план"`, and remove `android.permission.INTERNET` from [native/android/app/src/main/AndroidManifest.xml:40](../../native/android/app/src/main/AndroidManifest.xml#L40).

8. **Android Hardware / Gesture Back button drops Blueprint step 2 and minimizes the app during recognition**
   - **Evidence**:
     - In [js/app.js:1911-1919](../../js/app.js#L1911-L1919), `back()` checks `if (this.bp && !this.bp.busy) { this.closeBp(); return true; }`.
     - **Bug 1**: When `this.bp.busy === true` (vision worker is running), the condition is false, so pressing Back falls through to `return false` and **minimizes the entire Android app** ([js/platform.js:98](../../js/platform.js#L98)).
     - **Bug 2**: When `this.bp.rooms !== null` (Step 2 of the Blueprint modal: reviewing and naming detected rooms, [js/app.js:763-786](../../js/app.js#L763-L786)), pressing hardware Back calls `closeBp()` and **destroys all detected rooms**, whereas the UI button `"Изменить масштаб"` ([js/app.js:780](../../js/app.js#L780)) sets `bp.rooms = null` to step back to scale calibration.
     - **Bug 3**: When an inline room detail panel (`room.more === true`, [js/app.js:393](../../js/app.js#L393)) or floor scheme (`floor.plan.open === true`, [js/app.js:448](../../js/app.js#L448)) is open, Back minimizes the app instead of collapsing it.
     - **Bug 4**: In installed PWA mode (`PF.kind === 'web'`), `onBack` ([js/platform.js:94](../../js/platform.js#L94)) does nothing (`if (!cap) return;`), so Android Back closes the PWA immediately even when `bp`, `library`, or `pdfDialog` is open.
   - **Fix (Web)**: In `back()` ([js/app.js:1911-1919](../../js/app.js#L1911-L1919)): if `this.bp` is open, return `true` when `this.bp.busy`, and if `this.bp.rooms` is set, set `this.bp.rooms = null; return true;`. Also push a history state on modal open and listen to `window.onpopstate` when `PF.kind === 'web'`.

9. **Always-visible "Ссылка на этот расчёт" button fails with a configuration error in Android and Windows builds**
   - **Evidence**: [js/config.js:12](../../js/config.js#L12) sets `publicUrl: ''`. Unless `--public-url` is explicitly passed to [tools/native.js:88](../../tools/native.js#L88), `PF.publicBase()` ([js/platform.js:32-36](../../js/platform.js#L32-L36)) returns `''` in both the Android and Windows apps. Yet the `"Ссылка на этот расчёт"` button ([js/app.js:533](../../js/app.js#L533)) is always rendered and, when clicked, shows a broken-setup toast: `"Ссылка на расчёт появится, когда в настройках приложения будет указан адрес опубликованного сайта"` ([js/app.js:1787-1790](../../js/app.js#L1787-L1790)).
   - **Fix (Web)**: Hide the `"Ссылка на этот расчёт"` button when `!PF.publicBase()` (or replace it with offline JSON file export/import so an inspector can transfer an inspection file between Android and Windows without a web server).

---

### P2 — Desktop (Electron) Wrapper Leaks

10. **Electron exposes `F5` / `Ctrl+R` page reload, `Ctrl+Shift+I` Chrome DevTools, and full-page browser zoom in production**
    - **Evidence**: [native/desktop/main.js:37-44,72](../../native/desktop/main.js#L37-L44) registers an application menu with `role: 'reload'` (`Ctrl+R` / `F5`), `role: 'toggleDevTools'` (`Ctrl+Shift+I`), and `role: 'zoomIn'` / `'zoomOut'` / `'resetZoom'` (`Ctrl++`, `Ctrl+-`, `Ctrl+0`). Because `autoHideMenuBar: true` is set ([native/desktop/main.js:49](../../native/desktop/main.js#L49)), pressing `Alt` pops up a browser-style menu bar with `"Обновить"` and `"Инструменты разработчика"`, and pressing `Ctrl++` zooms the entire UI chrome instead of the floor plan.
    - **Fix (Native)**: Remove `reload`, `toggleDevTools`, `zoomIn`, `zoomOut`, and `resetZoom` from [native/desktop/main.js:39-43](../../native/desktop/main.js#L39-L43) in production builds (or replace menu items with app actions: `Новый расчёт`, `Загрузить план`, `Сохранить PDF`, `Нормы` via IPC), and call `win.webContents.setVisualZoomLevelLimits(1, 1)`.

11. **Electron window title is overwritten by HTML `<title>` and never reflects the active object; window size/state is not persisted**
    - **Evidence**:
      - [native/desktop/main.js:49](../../native/desktop/main.js#L49) sets `title: 'Огнетушители'`, but when [index.html:6](../../index.html#L6) loads, Chromium replaces the window title with `<title>Расчёт огнетушителей — СТ РК 1487-2006</title>`.
      - [native/desktop/main.js:48](../../native/desktop/main.js#L48) hardcodes `width: 1366, height: 900` on every startup without saving or restoring window position, dimensions, or maximized state.
    - **Fix (Native & Web)**: Update `document.title` dynamically in `js/app.js` to `(building.name ? building.name + ' — ' : '') + 'Огнетушители'`. In `native/desktop/main.js`, persist `{ x, y, width, height, isMaximized }` to `path.join(app.getPath('userData'), 'window-state.json')` on `close`.

12. **Electron "Открыть с помощью" (File Associations) and `second-instance` file arguments are unimplemented**
    - **Evidence**:
      - Comments in [js/app.js:1902,1954](../../js/app.js#L1902) and [js/platform.js:157-158,170-175](../../js/platform.js#L157-L158) state that `"Открыть с помощью" на компьютере` works via `window.launchQueue`. That API only triggers for browser-installed PWAs via [manifest.webmanifest:43-45](../../manifest.webmanifest#L43-L45)—it never runs in Electron.
      - [native/package.json:18-67](../../native/package.json#L18-L67) defines no `fileAssociations`.
      - [native/desktop/main.js:21](../../native/desktop/main.js#L21) calls `if (!app.requestSingleInstanceLock()) app.quit();` without wrapping the rest of the file in `else` (so `app.whenReady()` still runs before exit), and `app.on('second-instance', function () { ... })` ([native/desktop/main.js:84-88](../../native/desktop/main.js#L84-L88)) ignores the `(event, commandLine)` parameters.
    - **Fix (Native)**: Return early after `app.quit()` in [native/desktop/main.js:21](../../native/desktop/main.js#L21), read image/project file paths from `process.argv` and `second-instance` `commandLine`, and pass them to the renderer via `preload.js`.

---

### P3 — Micro-Interactions, Startup, Splash, Hover & Zoom

13. **Web/offline status indicators and native `<select>` popups inside native apps**
    - **Evidence**:
      - [js/app.js:281](../../js/app.js#L281) shows `<span class="net" v-if="offline">без сети</span>` in the top bar whenever Wi-Fi/mobile data is off—even though the Android and Windows apps have zero network features ([js/app.js:996-997](../../js/app.js#L996-L997)).
      - Room purpose selection ([js/app.js:363-367,771-775](../../js/app.js#L363-L367)) relies on a native `<select>` containing 6 `<optgroup>`s and 27 `<option>`s, which renders as an unsearchable browser popup on Windows and Android WebView.
    - **Fix (Web)**: Remove the `"без сети"` badge (`v-if="offline"` at [js/app.js:281](../../js/app.js#L281)) since the app has no network backend on any platform. Replace the 27-option `<select>` with an instant custom picker modal/popover with category tabs and search.

14. **Hover-only affordances, sticky hover on touch, `:focus-within` rings on touch, and missing `:active` states**
    - **Evidence**:
      - Above `760px`, `input.title` ([css/app.css:166-170](../../css/app.css#L166-L170)), `input.floor__name` ([css/app.css:186-187](../../css/app.css#L186-L187)), and `.norm__btn` ([css/app.css:206-212](../../css/app.css#L206-L212)) have `border-color: transparent` and only reveal their interactive border/background on `:hover` or `:focus`. `.norm__btn` has no chevron icon to show it expands `.room__more`.
      - Dozens of explanations live only in mouse-hover `title="..."` attributes ([js/app.js:323,375,381,383,403,453,462,474,488,547](../../js/app.js#L323)), which are unreachable on Android.
      - `:hover` rules ([css/app.css:76,92,96,98,106,117,119,127,131,149,179,212,266](../../css/app.css#L76)) are not gated by `@media (hover: hover) and (pointer: fine)`, leaving sticky hover backgrounds after touch taps.
      - `.seg__opt:focus-within` ([css/app.css:79](../../css/app.css#L79)) and `.tool:focus-within` ([css/app.css:267](../../css/app.css#L267)) trigger a `2px solid var(--ink)` outline on touch taps because tapping focuses the hidden `<input type="radio" class="sr">` inside the label.
      - Only `.btn:active` ([css/app.css:93](../../css/app.css#L93)) has an `:active` rule; `.chip`, `.tool`, `.icon`, `.seg__opt`, `.tab`, `.room__summary`, `.menu__open`, and `summary` have no `:active` feedback.
    - **Fix (Web)**: Wrap all `:hover` styles in `@media (hover: hover) and (pointer: fine)`; change `:focus-within` on `.seg__opt` and `.tool` to `:has(:focus-visible)`; add `:active` states to all interactive controls; add a chevron indicator to `.norm__btn`.

15. **No pinch-to-zoom or pan on the floor plan and blueprint SVGs**
    - **Evidence**: `.plan__svg` ([css/app.css:236-239](../../css/app.css#L236-L239)) and `.bp__svg` ([css/app.css:288](../../css/app.css#L288)) set `touch-action: manipulation` and bind `@click` / `@pointerdown` directly to coordinate placement ([js/app.js:469-470,724](../../js/app.js#L469-L470)) with no zoom/pan viewport transform. On a phone (`max-height: 55vh` at [css/app.css:517](../../css/app.css#L517)), accurately tapping two wall endpoints on a photographed floor plan or tapping small rooms is nearly impossible without zoom.
    - **Fix (Web)**: Implement two-finger pinch-zoom / pan (and mouse wheel zoom on desktop) via dynamic SVG `viewBox` manipulation on `.bp__svg` and `.plan__svg`, with a `"100%"` reset button.

16. **Startup `"Загрузка…"` text flash, font swap jump, and duplicate Android splash icon**
    - **Evidence**:
      - [index.html:25](../../index.html#L25) renders `<div class="boot">Загрузка…</div>` ([css/app.css:65](../../css/app.css#L65)) while 13 synchronous scripts ([index.html:29-41](../../index.html#L29-L41))—including 506 lines of legal reference text in `js/library.js`—parse and execute.
      - [css/app.css:17-28](../../css/app.css#L17-L28) uses `font-display: swap` without `<link rel="preload" as="font">` in `index.html`, causing an initial system-font render followed by a metric shift when `IBM Plex Sans`/`Mono` load from local files.
      - [native/android/app/src/main/res/values/styles.xml:23-28](../../native/android/app/src/main/res/values/styles.xml#L23-L28) sets both legacy `<item name="android:background">@drawable/splash</item>` (96dp icon at scale `0.9`, [tools/make-icons.js:133](../../tools/make-icons.js#L133)) and Android 12+ `<item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>` (108dp icon at scale `0.5`, [tools/make-icons.js:132](../../tools/make-icons.js#L132)), causing an icon size jump during Android cold start.
    - **Fix (Web & Native)**: Remove `<div class="boot">Загрузка…</div>` (or render the static top bar skeleton), preload Cyrillic/Latin 400/500 `.woff2` files in `index.html` with `font-display: block`, lazy-load `js/library.js` on demand, and remove `<item name="android:background">@drawable/splash</item>` from `AppTheme.NoActionBarLaunch` in [native/android/app/src/main/res/values/styles.xml:24](../../native/android/app/src/main/res/values/styles.xml#L24).

17. **Zero haptics and hard-cut view/modal mount transitions**
    - **Evidence**: There are no `navigator.vibrate` calls in `js/app.js` or `js/platform.js` when placing/removing marks on the scheme ([js/app.js:1525,1533](../../js/app.js#L1525)), snapping rooms ([js/app.js:1593](../../js/app.js#L1593)), or setting scale points ([js/app.js:1696](../../js/app.js#L1696)). Modals (`pdfDialog`, `bp`, `library`), dropdowns (`menuOpen`), and toasts (`notice`) mount/unmount abruptly via raw `v-if` with no CSS/Vue transition.
    - **Fix (Web)**: Add `120ms` CSS opacity/transform transitions on `.modal`, `.menu__panel`, and `.toast`, and add a subtle `navigator.vibrate(8)` helper in `js/platform.js` for scheme placement and snap events on Android.

---

## 2. Visual Design and Copy Audit (Eliminating the AI-Generated Look)

Although [css/app.css:4-14](../../css/app.css#L4-L14) establishes a solid baseline (light graphite palette, no CSS gradients, no emoji, no uppercase eyebrow labels, IBM Plex fonts), several concrete elements still look AI-generated or break the **"exact, official, terse government instrument"** direction:

### P0 — The App Icon (`icons/*.png`, `icons/favicon.svg`, `tools/make-icons.js`)

1. **The app icon looks like a medicine/nail-polish bottle made of two floating primitives**
   - **Evidence**: Inspecting [icons/icon-192.png](../../icons/icon-192.png), [icons/icon-512.png](../../icons/icon-512.png), [icons/icon-maskable-192.png](../../icons/icon-maskable-192.png), [icons/icon-maskable-512.png](../../icons/icon-maskable-512.png), [icons/icon-180.png](../../icons/icon-180.png), [icons/favicon.svg:1](../../icons/favicon.svg#L1), and [tools/make-icons.js:15-18](../../tools/make-icons.js#L15-L18):
     ```js
     const SHAPES = [
       { x: 11, y: 10, w: 10, h: 18, r: 3, color: RED },
       { x: 13, y: 4, w: 6, h: 5, r: 1, color: INK }
     ];
     ```
     The icon consists solely of a red rounded rectangle (`y: 10..28`) and a detached black rounded square (`y: 4..9`) floating `1px` above it with a white gap in between, with no neck, no operating lever, and no hose/horn. Visually it reads as a generic procedurally generated pill bottle or cosmetic bottle, not a fire extinguisher.
   - **Irony in the codebase**: [js/signs.js:43-47](../../js/signs.js#L43-L47) already defines the authentic **ГОСТ 12.4.026-2015 `F04` («Огнетушитель»)** vector silhouette (cylinder, neck collar, angled lever handle, curved hose, and discharge horn on a signal-red square).
   - **Fix**: Replace the two-rectangle shape in [icons/favicon.svg:1](../../icons/favicon.svg#L1) and [tools/make-icons.js:15-25](../../tools/make-icons.js#L15-L25) with the ГОСТ `F04` fire extinguisher geometry (white extinguisher silhouette on signal red `#C1121C`, or graphite `#171717` badge with red `F04` square).

---

### P1 — Copy, Tone, and Punctuation Telltales (LLM Style vs. Official Instrument)

2. **Marketing pitches, rhetorical questions, and "works without internet" boasts inside the work area**
   - **Evidence**:
     - **Permanent promo banner above floors** (`div.tip`, [js/app.js:333-336,936-945](../../js/app.js#L333-L336)): `"Есть план эвакуации или техпаспорт? Сфотографируйте план этажа — помещения и площади найдутся сами, прямо на телефоне, без интернета."` As noted in the comment at [js/app.js:934](../../js/app.js#L934), this banner never disappears even after rooms are entered.
     - **Rhetorical question on step calculator** ([js/app.js:410](../../js/app.js#L410)): `"Нет рулетки? Измерить шагами"` (should simply be `"Пересчёт из шагов"`).
     - **Benchmark brag in Blueprint modal** ([js/app.js:785](../../js/app.js#L785)): `"Распознано за {{ bp.ms }} мс на этом устройстве."` — remove completely.
     - **Repeated offline/device self-promotion in 5 places**: [js/app.js:736](../../js/app.js#L736) (`"Помещения и их площади найдутся сами — на этом устройстве, без интернета"`), [js/app.js:803](../../js/app.js#L803) (`"Справочник хранится в приложении и открывается без сети"`), [js/app.js:941](../../js/app.js#L941), and [js/app.js:996-998](../../js/app.js#L996-L998) (`"Приложение для Android: всё хранится на телефоне, сеть не нужна"`).
   - **Fix**: Delete `div.tip` ([js/app.js:333-336](../../js/app.js#L333-L336)), delete the `bp.ms` line ([js/app.js:785](../../js/app.js#L785)), delete the offline marketing sentences, and replace `"Нет рулетки? Измерить шагами"` with `"Замер шагами"`.

3. **Conversational first-person verbs and tutorial filler copy**
   - **Evidence**:
     - First-person verbs: `"Формирую…"` ([js/app.js:696,1982](../../js/app.js#L696)), `"Ищу помещения…"` ([js/app.js:758](../../js/app.js#L758)), `"Как считаем: правила и допущения"` ([js/app.js:666](../../js/app.js#L666)).
     - Chatty filler prompts: `"Введите площадь помещений — схема построится сама"` ([js/app.js:449](../../js/app.js#L449)), `"Введите площадь хотя бы одного помещения, и здесь появится расчёт"` ([js/app.js:514](../../js/app.js#L514)), `"Впишите, сколько огнетушителей установлено на этаже, или отметьте их на схеме этажа — здесь появится вывод"` ([js/app.js:569](../../js/app.js#L569)), `"пока нет данных"` ([js/app.js:1039](../../js/app.js#L1039)), `"Этот расчёт ещё пуст — можно начинать"` ([js/app.js:1121](../../js/app.js#L1121)).
   - **Fix**: Replace with terse, impersonal official wording: `"Формирование PDF…"`, `"Распознавание…"`, `"Методика расчёта и допущения"`, `"Нет помещений с указанной площадью"`, `"Фактическое наличие не указано"`, `"—"`.

4. **Pervasive LLM em-dash clauses (` — `) and middle-dot chains (` · `)**
   - **Evidence**:
     - **Em dashes (` — `)** used as conversational connectors across UI copy: [index.html:6](../../index.html#L6), [js/app.js:383,403,449,569,662,705,736,765,917,941,1121,1245,1340,1482,1484,1491,1494,1500,1518,1526,1708,1723,1749](../../js/app.js#L383).
     - **Middle dots (` · `)** used as a universal delimiter in 25+ places instead of structured columns or standard Russian punctuation (commas/semicolons): [js/app.js:341,572,623,718,729,764,1040,1050,1115,1275,1336,1351,1359,1360,1460-1461,1504](../../js/app.js#L341).
   - **Fix**: Replace conversational ` — ` connectors with colons, periods, or parentheses; replace ` · ` chains with structured table/grid cells or standard commas (`, `).

5. **Findings list text concatenation defect in the Result pane**
   - **Evidence**: In [js/app.js:573](../../js/app.js#L573) (and visible in [icons/screens/wide.png](../../icons/screens/wide.png)), `<span>{{ x.text }}<template v-if="x.action"> {{ x.action }}.</template></span>` runs the violation and the required remedial action together in a single paragraph (and in `wide.png`, renders without a visible space after the period: `"требуемых.Установить"`). By contrast, the PDF report ([js/report.js:173-180](../../js/report.js#L173-L180)) properly separates `Место`, `Выявлено`, `Необходимо`, and `Основание`.
   - **Fix**: Render `x.text` (`Выявлено`) and `x.action` (`Предписание / Мера`) on separate lines or columns in `.find`.

---

### P2 — Color Discipline, Typography & Grid Precision

6. **Non-semantic red and green in the Blueprint editor, plus two mismatched red hex values**
   - **Evidence**:
     - The design rule ([css/app.css:7](../../css/app.css#L7)) specifies: *"красный только там, где он что-то значит (порошковый огнетушитель, нехватка)"*.
     - Yet in the Blueprint editor ([css/app.css:289-295,305](../../css/app.css#L289-L295)):
       - Detected rooms are filled and stroked in **green** (`.bp__room { fill: rgba(21, 128, 61, .14); stroke: var(--green); }`).
       - The currently selected room polygon and its list item are highlighted in **alarm red / pink** (`.bp__room--sel { fill: rgba(196, 41, 28, .16); stroke: var(--red); }` and `.bp__item--sel { background: #fbecea; }`).
       - The scale ruler line and endpoints are drawn in **red** (`.bp__ruler { stroke: var(--red); }`, `.bp__pt { fill: var(--red); }`).
     - Additionally, `--red` in [css/app.css:40](../../css/app.css#L40) and [tools/make-icons.js:12](../../tools/make-icons.js#L12) is `#c4291c`, while `COLORS.red` in [js/signs.js:32](../../js/signs.js#L32) is `#C1121C`.
   - **Fix**: In `.bp__*` ([css/app.css:289-305](../../css/app.css#L289-L305)), use graphite neutrals (`var(--ink)` / `var(--raised)`) for detected rooms, selected rooms, and the scale ruler, reserving `--red` strictly for fire signs (`F04`, `F02`, etc.) and norm deficits/errors. Unify `--red` with `#C1121C`.

7. **Numbers and norm clauses rendered in `IBM Plex Sans` instead of `IBM Plex Mono`, plus synthesized bold (`700`)**
   - **Evidence**:
     - [css/app.css:8-9](../../css/app.css#L8-L9) states: *"веса 400 и 500; цифры и ссылки на пункты норм — моноширинным шрифтом"*.
     - `.total__n` ([css/app.css:323](../../css/app.css#L323))—the main 28px extinguisher count in the result ledger—omits `font-family: var(--mono)`.
     - `input[type="number"]` ([css/app.css:69-75](../../css/app.css#L69-L75)) omits `font-family: var(--mono)`, so room areas, counts, lengths, widths, and scale dimensions are typed in `IBM Plex Sans`.
     - `.bp__label` ([css/app.css:293](../../css/app.css#L293)) sets `font-family: var(--sans)` for `1 · 45,2 м²` on the floor plan.
     - [js/signs.js:119](../../js/signs.js#L119) sets `font-weight="bold"` (700) on the extinguisher badge text (`П`, `У`), causing faux-bold synthesis since only weights `400` and `500` are loaded ([css/app.css:17-28](../../css/app.css#L17-L28)).
   - **Fix**: Add `font-family: var(--mono)` to `.total__n`, `input[type="number"]` (and numeric inputs), and `.bp__label`. Change `font-weight="bold"` to `font-weight="500"` in [js/signs.js:119](../../js/signs.js#L119).

8. **Off-4px grid spacing and stacked clouds of rounded pill buttons**
   - **Evidence**:
     - Off-grid values in `css/app.css`: `margin-left: -9px` ([css/app.css:167,186](../../css/app.css#L167)), `height: 30px` ([css/app.css:176](../../css/app.css#L176)), `height: 26px; padding: 0 10px` ([css/app.css:235](../../css/app.css#L235)), `padding: 0 10px 0 6px; gap: 6px` ([css/app.css:262](../../css/app.css#L262)), `padding: 14px 20px` ([css/app.css:285](../../css/app.css#L285)), `padding-bottom: 10px` ([css/app.css:300](../../css/app.css#L300)), `padding: 4px 6px` ([css/app.css:303,334](../../css/app.css#L303)), `padding: 10px 0` ([css/app.css:431](../../css/app.css#L431)), `padding: 6px 8px` ([css/app.css:434](../../css/app.css#L434)), `width: calc(33.33% - 11px)` ([css/app.css:506](../../css/app.css#L506)).
     - As seen in [icons/screens/narrow.png](../../icons/screens/narrow.png), opening a floor scheme on mobile stacks 4 consecutive rows of floating `border-radius: 8px` pill buttons (`.plan__head`, `.plan__tools`, and two rows of `.tools`).
   - **Fix**: Snap all heights and paddings to the 4px grid (`28px` → `32px` / `40px` / `48px`; `6px`/`10px`/`14px` → `8px`/`12px`/`16px`), tighten control radii from `8px`/`12px` to `4px`/`6px`, and consolidate `.plan__tools` + `.tools` into a compact single-strip toolbar.

---

## 3. Field Ergonomics for Inspectors

### P0 — Risk of Data Loss & Destructive Actions

1. **Closing the Blueprint modal (`closeBp`) wipes all detected & named rooms without confirmation or undo**
   - **Evidence**: After an inspector photographs an evacuation plan, calibrates scale, runs detection, and names 15–30 rooms in `.bp__list` ([js/app.js:766-778](../../js/app.js#L766-L778)), tapping the modal backdrop (`@click.self="closeBp"`, [js/app.js:715](../../js/app.js#L715)), pressing `Escape` ([js/app.js:1926](../../js/app.js#L1926)), or pressing Android Back ([js/app.js:1912](../../js/app.js#L1912)) immediately calls `closeBp()` ([js/app.js:1624](../../js/app.js#L1624): `this.bp = null; this._bpPixels = null;`), losing all unapplied work.
   - **Fix**: Remove `@click.self="closeBp"` on `.modal--full` ([js/app.js:715](../../js/app.js#L715)), persist draft `bp` state in storage, and if `bp.rooms` has edits, either auto-save or provide an undo toast on close.

2. **Unpersisted `this.bp` state, 250ms debounced `save()` without lifecycle flush, and silent storage failures**
   - **Evidence**:
     - `save()` ([js/app.js:1085-1093](../../js/app.js#L1085-L1093)) debounces `localStorage.setItem` by `250ms` and is **not** flushed on `visibilitychange` or `pagehide`.
     - `this.bp` ([js/app.js:877](../../js/app.js#L877)) is excluded from `save()`. When Android launches the camera or the inspector switches apps mid-inspection and the OS reclaims the WebView process, the entire in-progress blueprint session is lost.
     - `catch (e)` in `save()` ([js/app.js:1091](../../js/app.js#L1091)) silently ignores `QuotaExceededError`.
     - `catch (e)` in `loadStore()` ([js/app.js:132](../../js/app.js#L132)) returns `null` on corrupted JSON, and the next `save()` overwrites `STORE_KEY` (`firecalc.store.v2`) without backing up the raw string.
     - `removeObject()` ([js/app.js:1134-1147](../../js/app.js#L1134-L1147)) never deletes the object's floor plan images from IndexedDB (`IMG` in [js/app.js:163-191](../../js/app.js#L163-L191) has no `del` method), leaking storage indefinitely.
   - **Fix**: Flush `save()` synchronously on `visibilitychange` (`hidden`) and `pagehide`; surface a persistent warning banner if `localStorage.setItem` throws; back up corrupt raw storage to `STORE_KEY + '.bak'` before resetting; and delete orphaned IndexedDB keys when an undo window expires.

3. **Single-slot Undo (`this.undoFn`) is overwritten by any subsequent informational toast**
   - **Evidence**: `say(text, undoFn)` ([js/app.js:1071-1077](../../js/app.js#L1071-L1077)) sets `this.undoFn = undoFn || null`. If an inspector accidentally deletes a room (`removeRoom`, [js/app.js:1221](../../js/app.js#L1221)) or an extinguisher mark (`removeExt`, [js/app.js:1528](../../js/app.js#L1528)) and then taps anywhere outside a room on the scheme (`this.say('Нажмите внутри помещения')`, [js/app.js:1524](../../js/app.js#L1524)), the informational toast overwrites `this.undoFn = null` and destroys the undo function.
   - **Fix**: Maintain a true undo stack (`undoStack.push(fn)`, up to 20 steps) independent of transient informational toasts, with a dedicated Undo button in the toolbar/header.

---

### P1 — Touch Targets, Gloves in Winter & One-Handed Use

4. **Sub-minimum touch targets (`16px` checkboxes, `28px` `.btn--sm`, `32px` SVG hit circles, `32px` `.fact` inputs)**
   - **Evidence**:
     - `--ctl` is `36px` on desktop/tablet ([css/app.css:45](../../css/app.css#L45)) and `40px` on phones ([css/app.css:473](../../css/app.css#L473))—below the `48px` minimum for gloved or one-handed field use.
     - `.btn--sm` ([css/app.css:99](../../css/app.css#L99)) is **`28px` tall** even on mobile (not overridden in `@media (max-width: 760px)`), affecting `"Объекты"`, `"Новый"`, `"Дублировать"`, `"Удалить"`, `"Схема этажа"`, `"Загрузить план этажа"`, `"Убрать все"`, and modal `"Закрыть"` buttons ([js/app.js:284,307,344,345,444,445,458,720,799](../../js/app.js#L284)).
     - Checkboxes and radios are **`16×16px`** ([css/app.css:109,304,395](../../css/app.css#L109)). In `.bp__item` ([js/app.js:768](../../js/app.js#L768)), the checkbox is a bare `<input type="checkbox">` with no expanding `<label>` hit area.
     - Floor scheme extinguisher marks have a hit circle of radius `16px` (`32×32px`, `<circle class="plan__hit" :r="px(floor, 16)">` at [js/app.js:482](../../js/app.js#L482)), and tapping an existing mark **immediately deletes it** ([js/app.js:1521](../../js/app.js#L1521)).
     - `input.fact` ([css/app.css:340,535](../../css/app.css#L340)) is `48×28px` (`44×32px` on mobile).
     - `.seg--sm .seg__opt` is `26px` (`32px` on mobile, [css/app.css:235,509](../../css/app.css#L235)).
   - **Fix**: Raise `--ctl` on coarse pointers (`@media (pointer: coarse)`) to `48px`, `.btn--sm` / `.chip--add` / `.tool` to `40px` minimum, checkbox/radio hit wrappers to `44×44px`, and `.plan__hit` radius to `px(floor, 22)` (`44px` diameter).

5. **Top-heavy navigation and uncollapsible active room card on mobile**
   - **Evidence**:
     - Primary navigation tabs (`Помещения` / `Результат`, [js/app.js:309-312](../../js/app.js#L309-L312)), object switcher (`Объекты`, [js/app.js:284](../../js/app.js#L284)), and modal close buttons (`Закрыть`, [js/app.js:720,799](../../js/app.js#L720)) are all at the top of the screen, out of one-handed thumb reach.
     - On phones (`<= 760px`), `.top__norms` is hidden ([css/app.css:477](../../css/app.css#L477)), burying the norms reference inside the top-right `"Объекты"` dropdown ([js/app.js:299](../../js/app.js#L299)).
     - When a room is expanded on mobile (`.room:not(.room--closed)`), [css/app.css:499](../../css/app.css#L499) hides `.room__summary` (`display: none`), leaving **no way to collapse the open room** without opening another room.
     - Inside `.room__tools` ([css/app.css:213](../../css/app.css#L213), [js/app.js:387-390](../../js/app.js#L387-L390)), Duplicate and Delete sit adjacent with `0px` gap.
   - **Fix**: Move primary view switching to a bottom navigation bar on mobile; keep `.room__summary` visible as a header to toggle the room closed; add `gap: 12px` between Duplicate and Delete buttons.

---

### P2 — Speed of Main Flow, Number Entry & Sunlight Contrast

6. **Slow number entry: no `−`/`+` steppers on room count or fact verification, and Chromium `<input type="number">` decimal comma friction**
   - **Evidence**:
     - `room.count` ([js/app.js:375](../../js/app.js#L375)) and `installedOP` / `installedOU` ([js/app.js:548,554](../../js/app.js#L548)) require tapping a small number box, opening the soft keyboard, deleting the digit, and typing a new integer instead of tapping `−` / `+` buttons.
     - All decimal fields (`room.area`, `room.length`, `room.width`, `bp.lenM`, `bp.areaM2` at [js/app.js:370,407,408,750,752](../../js/app.js#L370)) use `<input type="number" step="any" inputmode="decimal">`, which can reject or drop comma decimals (`,`) in Chromium depending on OS/keyboard locale before `toNum()` runs.
   - **Fix**: Add `−` / `+` stepper buttons for `installedOP`, `installedOU`, and `room.count`. Use `<input type="text" inputmode="decimal">` for decimal measurements so both `,` and `.` work reliably across all keyboards.

7. **Workflow friction: L×W inputs buried in `room.more`, fact counts separated from floor header, and object details hidden until PDF export**
   - **Evidence**:
     - Entering `Длина` and `Ширина` (or `шаги`) requires expanding `room.more` via `.norm__btn` on every single room ([js/app.js:383,393,407-415](../../js/app.js#L383)).
     - Actual extinguisher counts (`installedOP`, `installedOU`) can only be typed inside the `"Результат"` tab's `"Сверка с фактом"` table ([js/app.js:538-563](../../js/app.js#L538-L563)), not on the floor header while walking the floor.
     - Object metadata (`address`, `owner`, `inspector`, `date`) does not exist anywhere on the main screen—it only appears when clicking `"Скачать PDF"` ([js/app.js:683-699](../../js/app.js#L683-L699)).
   - **Fix**: Allow toggling `Площадь` vs `Длина × Ширина` inline in the room row; allow entering `Факт: ОП / ОУ` directly on each floor header (or via the floor scheme); and expose object passport fields (`Адрес`, `Организация`, `Инспектор`, `Дата`) in a collapsible header block on the Object screen.

8. **Low outdoor/sunlight contrast on borders, dividers, placeholders, and floor plan overlays**
   - **Evidence**:
     - `--hair: rgba(23, 23, 23, .08)` (1.17:1 contrast, [css/app.css:38](../../css/app.css#L38)) and `--line: rgba(23, 23, 23, .18)` (1.53:1 contrast, [css/app.css:39](../../css/app.css#L39)) fail WCAG 1.4.11 (`>= 3:1` for input/button borders) and wash out in sunlight.
     - Placeholders (`#a3a3a3`, 2.5:1 contrast, [css/app.css:77](../../css/app.css#L77)) and 12px `--ink-3` (`#737373`, [css/app.css:37](../../css/app.css#L37)) are hard to read outdoors.
     - On `.plan__svg`, `.plan__bg` (`opacity: .5`, [css/app.css:275](../../css/app.css#L275)), `.plan__reach` (`1px` dashed `#737373`, dropping to `stroke-opacity: .3` when `> 8` extinguishers, [css/app.css:245-247](../../css/app.css#L245-L247)), and `.plan__gap` (`fill-opacity: .28`, [css/app.css:244](../../css/app.css#L244)) lose visibility under glare.
   - **Fix**: Darken `--line` to `rgba(23, 23, 23, .32)` (or `#8a8a8a` on inputs), `--hair` to `rgba(23, 23, 23, .14)`, `--ink-3` to `#595959` (7:1 AAA contrast), increase `.plan__reach` stroke width to `1.5px`, and outline `.plan__gap` zones.

---

## 4. Proposed Target App Structure (Shared Offline PWA for Web, Android & Windows)

This architecture keeps a **single zero-bundler Vue 3 global-build codebase** (`index.html`, `css/app.css`, `js/*.js`) while eliminating the "website in a wrapper" feel on both mobile and desktop.

### 4.1 App Shell & Viewport Architecture

- **Fixed-viewport app frame (`100dvh`)**:
  - `html, body, #app` are locked to `height: 100dvh; overflow: hidden; overscroll-behavior: none; user-select: none; -webkit-tap-highlight-color: transparent;`.
  - No document-level scrolling and no `window.scrollTo(0, 0)`. Each screen has its own `<div class="screen__body">` with `overflow-y: auto; overscroll-behavior-y: contain`, preserving scroll position when switching views.
  - Safe-area aware: top bar uses `padding-top: env(safe-area-inset-top)` and bottom bar uses `padding-bottom: env(safe-area-inset-bottom)`.

### 4.2 Navigation & Screen Model: 4 Primary Screens

Instead of one long page with a floating dropdown menu and full-screen modals stacked on top, the app is organized into **4 peer screens** driven by a single reactive `screen` state (`'input' | 'plan' | 'report' | 'norms'`) plus an **Objects Drawer / Switcher**:

| Screen ID | Title | Purpose & Contents |
| :--- | :--- | :--- |
| **`input`** | **Объект** (Object & Rooms) | **Object Passport header** (Name, Building Kind `Общественное / Производственное / Складское`, АУПТ toggle, and collapsible `Реквизиты акта`: Address, Owner, Inspector, Date).<br>**Floor switcher strip** (`1 этаж`, `2 этаж`, `+ Этаж`) so only the active floor's room list is on screen at once (with an `"Все этажи"` toggle on desktop).<br>**Room list** with inline `Площадь` / `Длина × Ширина` toggle, searchable Purpose sheet, `−`/`+` count steppers, and **Floor Fact bar** (`Установлено на этаже: ОП [−][0][+]  ОУ [−][0][+]`). |
| **`plan`** | **Схема** (Floor Plan & Blueprint) | Dedicated full-height interactive canvas for the active floor (instead of an inline SVG buried below room rows).<br>**Two modes**:<br>1. **Схема размещения** (`Как есть` / `По нормам`): pan-and-zoom SVG canvas, compact bottom/side tool palette of ГОСТ 12.4.026-2015 signs (`ОП`, `ОУ`, `ПК`, `Кнопка`, `Телефон`, `Щит`, `Выход`, `Двигать`), live distance coverage & violations strip.<br>2. **План по фото (Blueprint wizard)**: integrated directly into the `Схема` screen as a 2-step flow (`1. Снимок и масштаб` → `2. Помещения (N)`), persisted in state so switching to the camera on Android never loses progress. |
| **`report`** | **Отчёт** (Calculation, Audit & PDF) | **Verdict & Summary banner** (`Соответствует` / `Не соответствует`, required totals by code in `IBM Plex Mono`).<br>**Fact Verification Table** (`нужно / есть / не хватает` per floor with `−`/`+` steppers when not taken from scheme).<br>**Structured Findings Table** (`№`, `Место`, `Нарушение и норма`, `Мера по устранению`).<br>**Per-floor calculation breakdown** (expandable Table 1 matrices & formulas) and calculation parameters.<br>**Primary actions**: `"Открыть PDF"` / `"Сохранить PDF"` and `"Поделиться PDF"` (plus offline file export/import `.json`). |
| **`norms`** | **Нормы** (Reference Library) | Instant full-text search and verbatim clauses (ППБ РК Прил. 2 и 3, ТР № 405 Прил. 16, СТ РК 1487-2006, ГОСТ 12.4.026-2015, ГОСТ 28130-89). Accessible in one tap from the main navigation bar instead of hidden in a dropdown on mobile. |

### 4.3 Responsive Layout: Mobile Bottom Bar vs. Desktop Master-Detail

One shared template adapts across breakpoints using CSS Grid:

- **Mobile & Portrait Tablet (`<= 960px`) — Bottom Navigation Bar**:
  - **Top Context Bar (`48px` + `safe-area-inset-top`)**: Current Object selector button on the left (opens the Objects bottom sheet/drawer to switch, create, duplicate, or import/export objects), active floor badge, and a persistent **Undo** icon button on the right (when `undoStack.length > 0`).
  - **Main Screen Area (`flex: 1; overflow-y: auto`)**: Shows the active screen (`Объект`, `Схема`, `Отчёт`, or `Нормы`).
  - **Bottom Navigation Bar (`56px` + `safe-area-inset-bottom`)**: 4 thumb-reachable tabs with live monospace badges:
    1. **Объект** (badge: room count, e.g. `8`)
    2. **Схема** (badge: marked extinguishers or `План`)
    3. **Отчёт** (badge: required total + red dot if deficit/violations exist)
    4. **Нормы**
  - *Keyboard behavior*: When an `<input>` is focused and `visualViewport` shrinks, the bottom bar hides automatically so 100% of the space above the keyboard is dedicated to data entry.

- **Windows Desktop & Landscape Tablet (`> 960px`) — 3-Zone Instrument Workspace**:
  - **Top Instrument Bar (`48px`)**: Object switcher drawer trigger, primary mode tabs (`Объект и схема`, `Расчёт по помещениям`, `Справочник норм`), Undo button, and `"Сохранить PDF (Ctrl+S)"`.
  - **Left/Center Workspace (`1fr`, independently scrollable)**: Floor tabs strip at top, room table, and toggleable/docked Floor Scheme (`Схема этажа` / `План по фото`).
  - **Right Inspector Dock (`460px–520px`, independently scrollable)**: Always-visible live **Отчёт** (Required Totals ledger, Fact Verification table, Verdict, Violations list, and PDF export actions).

### 4.4 Hardware Back & Keyboard Shortcut Map

- **Android Hardware / Gesture Back stack (`back()` + `popstate`)**:
  1. Open picker / Objects sheet / PDF requisites sheet → close sheet.
  2. `screen === 'plan'` with Blueprint wizard on Step 2 (`bp.rooms !== null`) → return to Step 1 (`bp.rooms = null`).
  3. `screen === 'plan'` with Blueprint wizard on Step 1 → close Blueprint wizard back to scheme.
  4. `room.more === true` on mobile → collapse `room.more`.
  5. `screen !== 'input'` on mobile → return to `'input'` (`Объект`).
  6. At root `'input'` screen → minimize app.
- **Windows (Electron) Keyboard Shortcuts**:
  - `Ctrl+N`: New object
  - `Ctrl+O`: Load floor plan image (or import calculation file)
  - `Ctrl+S` / `Ctrl+P`: Generate & Save PDF report via native Save dialog
  - `Ctrl+Z`: Trigger app `undo()` stack
  - `F1`: Open `Нормы` reference screen
