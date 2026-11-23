> Разбор: работа без сети и безопасность. Модель Gemini 4 Neon (High) через agy, 23.11.2026, только чтение кода.
> Главные выводы сверены с кодом и вошли в docs/plan.md. Остальное не проверено.

# Air-Gapped Government Deployment Audit (`ДЧС` / Kazakhstan Fire-Safety Tool)

Read-only audit of the PWA, Android APK (Capacitor `8.6.2`), and Windows EXE (Electron `45.4.1`) targets. Findings within each section are prioritized by operational/security impact.

---

## 1. Network Requests, External Dependencies & Air-Gap Readiness

### Air-Gap Verdict
- **Android APK & Windows EXE**: **Work offline from first launch** for all core workflows (room calculation, floorplan computer vision in Web Worker, floor scheme editing, normative library, PDF export with embedded Tinos font and ГОСТ SVGs). All 38 precached assets (`sw.js:19-35`) are bundled inside `release/Ognetushiteli-1.0.0.apk` (`assets/public/`) and copied into `desktop/www/` (`tools/native.js:85-91`).
- **PWA**: **Cannot run offline on a plain-HTTP intranet or `file://`**. Requires **HTTPS** (with an organization-trusted CA certificate on all workstations/phones) or `http://localhost` for Secure Context APIs (`ServiceWorker`, `CacheStorage`, `navigator.storage.persist`, `navigator.clipboard`).

### Inventory of Network Surfaces & Dependencies (Prioritized)

1. **[High] No network-egress block in Electron or Android despite zero network need**
   - `native/desktop/main.js:70-82`: Does not register `session.defaultSession.webRequest.onBeforeRequest` to block outbound traffic, nor Chromium flags suppressing background networking (DNS probes, CRL/OCSP, component checks). `spellcheck: false` (`native/desktop/main.js:53`) already prevents dictionary downloads.
   - `native/desktop/main.js:58-66`: `setWindowOpenHandler` and `will-navigate` forward any `https?://` URL to `shell.openExternal()`, which can launch the OS browser on dual-homed PCs.
   - `native/android/app/src/main/AndroidManifest.xml:40`: Grants `<uses-permission android:name="android.permission.INTERNET" />` with no `networkSecurityConfig` or WebView request filter in `native/android/app/src/main/java/kz/firecalc/app/MainActivity.java:1-5`.
   - **Fix**: Block all non-local requests in Electron (`webRequest.onBeforeRequest` + `--disable-background-networking`), remove `shell.openExternal()`, and add `network_security_config` + `BridgeWebViewClient` host filtering on Android (details in Section 3).

2. **[High] Share links and PDF QR codes depend on an external HTTPS URL and carry full inspection records**
   - `js/config.js:12`, `js/platform.js:32-36`, `tools/build.js:99`: Native builds require `publicUrl` matching `^https://` to enable `"Ссылка на этот расчёт"` (`js/app.js:533,1785-1790`) and PDF QR codes (`js/app.js:1853-1855`, `js/report.js:327-340`). With default `publicUrl: ''`, the share button stays visible in APK/EXE (`js/app.js:533`) but fails with a toast (`js/app.js:1787-1790`).
   - `js/share.js:33-58`: Packs full object data (facility name, address, owner, inspector, rooms, extinguisher locations) into `#o=...`. Pointing `publicUrl` to a public host (e.g., Vercel) risks official inspection data leaving the agency via shared links, browser history, or scanned paper QR codes.
   - **Fix**: Hide the share-link button when `!PF.publicBase()` (`js/app.js:533`), disable QR/public URLs in air-gapped builds unless pointed to an internal agency HTTPS portal, and replace cross-device transfer with local file export/import (Section 2).

3. **[Medium] Manifest screenshots missing from Service Worker `ASSETS` and native `--dist`**
   - `manifest.webmanifest:24-27` references `icons/screens/wide.png` and `icons/screens/narrow.png`, which are omitted from `ASSETS` in `sw.js:19-35`. Requests for them fall through to `networkFirst()` (`sw.js:109`) and fail offline.
   - **Fix**: Add `icons/screens/wide.png` and `icons/screens/narrow.png` to `ASSETS` in `sw.js:19-35` and re-run `npm run build`.

4. **[Medium] Dead Google Services Gradle plugin and AndroidX `EmojiCompatInitializer` in Android build**
   - `native/android/build.gradle:11`: Declares `classpath 'com.google.gms:google-services:4.4.4'`; `native/android/app/build.gradle:70-77` conditionally applies it only if `google-services.json` exists. Inspection of `release/Ognetushiteli-1.0.0.apk` confirms **no GMS/Firebase classes are bundled in `classes.dex`**, only `com/google/common/util/concurrent/ListenableFuture`. However, keeping the classpath dependency pulls Google Maven artifacts at build time and risks accidental inclusion.
   - Merged `AndroidManifest.xml` inside `release/Ognetushiteli-1.0.0.apk` includes `androidx.emoji2.text.EmojiCompatInitializer` (via `androidx.appcompat:1.7.1`), which attempts to query Play Services font provider on startup (fails silently offline).
   - **Fix**: Remove `classpath 'com.google.gms:google-services:4.4.4'` (`native/android/build.gradle:11`) and lines `70-77` of `native/android/app/build.gradle`. Disable `EmojiCompatInitializer` via `tools:node="remove"` in `AndroidManifest.xml`.

5. **[Low] Clean assets, vendor bundles, analytics, and update checks**
   - **Fonts**: 12 local WOFF2 files (`css/app.css:17-28`) + local base64 Tinos TTF in `vendor/vfs_report.js` (`js/report.js:31`). Zero CDN fonts.
   - **Scripts**: All local (`index.html:21,29-41`, `js/app.js:227,267-268`, `js/vision.worker.js:6`). `vendor/pdfmake.min.js` contains unused `XMLHttpRequest` helpers for remote images/FileSaver that are never reached because all PDF graphics are inline SVGs (`js/plan.js:652-715`) and VFS fonts.
   - **Analytics / Auto-update**: None. Electron has no `electron-updater` and builds with `--publish never` (`tools/native.js:157`). PWA SW update checks (`js/platform.js:106,109,122-124`) run only when `hosted === true` (`kind === 'web' && /^https?:$/`), never in APK/EXE.
   - **PWA requirements**: Intranet server must serve over **HTTPS** (org CA), replicate `vercel.json:1-28` headers (`Cache-Control: no-cache` on `sw.js`, `index.html`, `manifest.webmanifest`), and never be run from `file://` (breaks SW, Web Worker at `js/app.js:227`, and canvas read of `examples/plan-school.png` at `js/app.js:209`).

---

## 2. Data Durability & Loss Risks

### Storage Architecture
- **Inspection objects, rooms, placements, options, UI state, and blueprint polygon arrays**: Single JSON string in `localStorage` under `firecalc.store.v2` (`js/app.js:25,1090`).
- **Floorplan raster images**: Base64 Data URLs (max 1600 px side, `js/app.js:159,211`) in IndexedDB database `firecalc`, object store `img` (`js/app.js:163-191`).
- **Android PWA Share Target inbox**: Temporary `CacheStorage` bucket `firecalc-inbox` (`sw.js:18,78-82`, `js/platform.js:161-168`).

### Findings (Prioritized)

1. **[Critical] No local backup, export, or import of inspections (files / USB)**
   - Nowhere in `js/app.js` or `js/platform.js` can an inspector export/import inspection data (single object or full backup archive with floorplan images) to a file or USB stick.
   - The only export is PDF (`js/app.js:1849-1876`, non-reimportable) and `#o=` share link (`js/share.js:33-58`), which requires `publicUrl`, caps at 12,000 chars (`js/share.js:21`), and strips all floorplan images and `blueprint` polygons.
   - **Fix**: Add JSON / `.firecalc.json` (or ZIP) export/import for single objects and full database backup (embedding referenced IndexedDB images), using `PF.saveFile()` (`js/platform.js:49-76`) and `<input type="file">`.

2. **[Critical] Windows Portable EXE writes data to host `%APPDATA%`, not the USB drive**
   - `native/package.json:20,47-51,65-67` uses `electron-builder`'s `portable` target without overriding `app.setPath('userData', ...)` in `native/desktop/main.js`.
   - `Ognetushiteli-1.0.0-portable.exe` extracts to `%TEMP%` and stores all Chromium `localStorage` / `IndexedDB` data in `%APPDATA%\Огнетушители\` on the host PC (`README.md:26` promises running directly from USB). Moving the USB drive to another workstation **loses access to all saved inspections** AND **leaves official ДЧС data behind on the host PC** (OPSEC breach on shared workstations).
   - **Fix**: When `process.env.PORTABLE_EXECUTABLE_DIR` is set (provided by `electron-builder` portable launcher), call `app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'))` before `app.whenReady()` (falling back with a warning if the directory is read-only).

3. **[Critical] `localStorage` 5 MiB limit with silent save failure and corruption overwrite**
   - `js/app.js:1085-1093`: All objects and all `floor.blueprint.rooms[].poly` polygon arrays are written to one `localStorage` key (`firecalc.store.v2`), capped at ~5 MiB in Chromium. `catch (e) {}` at `js/app.js:1091` **silently swallows `QuotaExceededError`** — the UI continues updating in memory while every change is lost on restart.
   - `js/app.js:1088-1092`: 250 ms debounce has no `pagehide` / `visibilitychange` / `beforeunload` flush; closing the app or OS killing the Android activity within 250 ms of an edit drops it.
   - `js/app.js:118-134`: On `JSON.parse` failure in `loadStore()`, the app silently initializes a blank object; the next `save()` overwrites and destroys the corrupt JSON.
   - **Fix**: Move object records (and polygon arrays) into IndexedDB (leaving only tiny prefs in `localStorage`), flush pending saves synchronously on `pagehide`/`visibilitychange`, surface write errors via persistent warning banner, and preserve corrupt raw JSON under a recovery key instead of overwriting.

4. **[High] Unbounded IndexedDB leak (plan photos are never deleted) & Base64 size bloat**
   - `js/app.js:187-190`: `IMG` only implements `put` and `get` — **no `delete`**. Deleting an object (`js/app.js:1134-1147`), deleting a floor (`js/app.js:1178-1183`), replacing a floorplan (`js/app.js:1747-1749`), or undoing `applyBp` (`js/app.js:1771-1775`) leaks orphaned image entries forever.
   - `js/app.js:210-211`: Stores images as Base64 Data URLs (instead of binary `Blob`s, adding ~33% Base64 + UTF-16 overhead) and encodes any PNG/SVG/GIF input as lossless `image/png` (often 2–5 MB per 1600 px plan).
   - No `navigator.storage.estimate()` monitoring or quota warning exists.
   - **Fix**: Store compressed `Blob`s (JPEG/WebP 0.82) in IndexedDB, run reference-counted garbage collection of unreferenced `img` keys (remembering `duplicateFloor` at `js/app.js:1185` shares keys across floors), and display storage usage via `navigator.storage.estimate()`.

5. **[High] `navigator.storage.persist()` skipped in native apps & delayed in browser tabs; Android PDF saved to `CACHE`**
   - `js/app.js:1899`: `if (PF.kind !== 'web' || this.persisted) return;` skips `PF.persist()` in Electron even though `native/desktop/main.js:79` explicitly permits `'persistent-storage'`. On web tabs (not yet installed), `keepData()` is only called after `applyBp` (`js/app.js:1770`) or `downloadPdf` (`js/app.js:1870`), leaving manually entered drafts unpersisted and subject to browser eviction (especially 7-day eviction in Safari/iOS when not added to Home Screen).
   - `js/platform.js:52`: Android writes PDFs to `directory: 'CACHE'` (`getCacheDir()`). If the user dismisses the Share sheet (`js/platform.js:55-58`), the PDF is inaccessible from the Android Files app and subject to OS cache cleanup; repeated exports also accumulate in `CACHE`.
   - **Update/reinstall behavior**:
     - **Android**: Private WebView storage (`/data/data/kz.firecalc.app/app_webview/Default/`) survives in-place APK upgrades **only if** `applicationId`, signing key, and Capacitor origin (`https://localhost`) remain identical. Uninstall/reinstall or key mismatch wipes all data.
     - **Windows (NSIS)**: `%APPDATA%\Огнетушители\` survives in-place Setup upgrades (`deleteAppDataOnUninstall` defaults to `false`), and is isolated per Windows user account. Note that non-ASCII Cyrillic `productName` (`native/package.json:20`) puts `%APPDATA%` on a Cyrillic path; changing `ORIGIN` (`app://firecalc/`, `native/desktop/main.js:12`) would orphan existing storage.
   - **Fix**: Call `PF.persist()` on first data save across all platforms; on Android, offer saving PDFs to `Documents` (or MediaStore) and clean temporary `CACHE` files after sharing.

---

## 3. Security Hardening (Government Tool)

### 3A. Electron (`native/desktop/main.js`, `native/desktop/preload.js`, `native/package.json`)
Good baseline: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `spellcheck: false` (`native/desktop/main.js:53`), minimal `preload.js` (`native/desktop/preload.js:4-6`), `asar: true` (`native/package.json:33`), no auto-updater (`tools/native.js:157`).

1. **[High] DevTools enabled in production builds**
   - `native/desktop/main.js:42`: Menu includes `{ role: 'toggleDevTools' }` unconditionally; `webPreferences.devTools` is not disabled (`native/desktop/main.js:51-54`). Allows trivial tampering with norm tables/calculations prior to official PDF generation.
   - **Fix**: Set `devTools: !app.isPackaged` in `webPreferences` and omit `toggleDevTools` from `menu()` when `app.isPackaged`.

2. **[High] No `session.webRequest` network block and no CSP**
   - `native/desktop/main.js:26-34,70-82`: No `webRequest.onBeforeRequest` deny-all filter; no `Content-Security-Policy` response headers.
   - Note: `vendor/vue.global.prod.js` compiles `TEMPLATE` (`js/app.js:277,866`) at runtime via `Function(...)`, so CSP requires `'unsafe-eval'` until templates are precompiled at build time.
   - **Fix**:
     - Add `session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(app:\/\/firecalc\/|data:|blob:)/.test(d.url) }))`.
     - Add `app.commandLine.appendSwitch('disable-background-networking')`.
     - Inject CSP headers in `serveFiles()` (`native/desktop/main.js:26-34`) with `connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';` (and precompile Vue templates during `tools/build.js` to drop `'unsafe-eval'`).

3. **[High] Electron Fuses unconfigured (`ELECTRON_RUN_AS_NODE` LOLBin risk)**
   - `native/package.json` / `tools/native.js` do not flip Electron Fuses (`@electron/fuses` is already in `native/package-lock.json`). Running `ELECTRON_RUN_AS_NODE=1 Ognetushiteli.exe evil.js` executes arbitrary Node.js code using a whitelisted government binary.
   - **Fix**: Apply `@electron/fuses` in `afterPack` hook: `RunAsNode: false`, `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false`, `OnlyLoadAppFromAsar: true`, `EnableEmbeddedAsarIntegrityValidation: true`.

4. **[Medium] `shell.openExternal()` allows external URL launch; missing `setPermissionCheckHandler` and explicit `webPreferences`**
   - `native/desktop/main.js:58-66`: Calls `shell.openExternal()` for any `https?://` URL in `setWindowOpenHandler` and `will-navigate`.
   - `native/desktop/main.js:51-54,78-80`: Missing `setPermissionCheckHandler`, and `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `navigateOnDragDrop: false` rely on defaults instead of explicit hardening.
   - `native/desktop/main.js:28,32`: `decodeURIComponent(url.pathname)` can throw uncaught `URIError`; `file === WEB` passes the traversal guard.
   - **Fix**: Remove `shell.openExternal()` (deny all non-`ORIGIN` navigation/popups), set `setPermissionCheckHandler`, explicitly set the `webPreferences` flags, and wrap `serveFiles()` in `try/catch` rejecting `file === WEB` or non-files.

5. **[Medium] Unsigned Windows EXEs**
   - `tools/native.js:157`: `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` produces unsigned installers/portables (`README.md:29`), triggering SmartScreen and failing AppLocker/WDAC policies in government networks.
   - **Fix**: Sign EXEs with an agency-trusted Authenticode certificate and publish SHA-256 hashes.

### 3B. Android (`native/android/`, `native/capacitor.config.json`, `tools/native.js`)
Good baseline: `allowMixedContent: false`, `webContentsDebuggingEnabled: false` (`native/capacitor.config.json:6-7`), `FileProvider` `exported="false"` (`AndroidManifest.xml:30`), only `MainActivity` exported (`AndroidManifest.xml:18`), `targetSdkVersion = 36` (`variables.gradle:4`).

1. **[Critical] `android:allowBackup="true"` exposes all inspections and floorplans**
   - `native/android/app/src/main/AndroidManifest.xml:5` (confirmed in compiled `release/Ognetushiteli-1.0.0.apk`): Enables Android Auto Backup (Google Drive) and `adb backup`, allowing full extraction of WebView `localStorage` and `IndexedDB` (facility addresses, vulnerabilities, floorplans).
   - **Fix**: Set `android:allowBackup="false"`, `android:fullBackupContent="false"`, and add `android:dataExtractionRules="@xml/data_extraction_rules"` disallowing `<cloud-backup>` and `<device-transfer>` (API 31+).

2. **[High] Overly broad `FileProvider` root exposure**
   - `native/android/app/src/main/res/xml/file_paths.xml:3`: Exposes `<external-path name="my_images" path="." />` (entire external storage) plus `<cache-path name="my_cache_images" path="." />`, while `js/platform.js:52` only writes to `CACHE`.
   - **Fix**: Remove `<external-path>` and narrow `<cache-path>` to a dedicated `exports/` subdirectory.

3. **[High] Cleartext traffic allowed on Android 7–8.1 + `INTERNET` permission with no egress lock**
   - `native/android/app/src/main/AndroidManifest.xml:4-10,40`: `android:usesCleartextTraffic` is omitted (defaults to **`true`** on API 24–27, covered by `minSdkVersion = 24`), `INTERNET` permission is requested, and `MainActivity.java:1-5` adds no `networkSecurityConfig` or WebView URL blocking.
   - Capacitor defaults `setAllowFileAccess(true)` and Android defaults `setAllowContentAccess(true)` and `setSafeBrowsingEnabled(true)` (which tries to contact Google Safe Browsing).
   - **Fix**:
     - Set `android:usesCleartextTraffic="false"` and `android:networkSecurityConfig="@xml/network_security_config"` (`cleartextTrafficPermitted="false"`, empty trust anchors).
     - In `MainActivity.java`, configure `WebSettings` (`setAllowFileAccess(false)`, `setAllowContentAccess(false)`, `setGeolocationEnabled(false)`, `setSafeBrowsingEnabled(false)`) and override `BridgeWebViewClient` to block any request/navigation whose host is not `localhost`.
     - Verify whether `<uses-permission android:name="android.permission.INTERNET" />` can be removed on target API 24–36 WebViews (keep only if older WebViews require it to init local `https://localhost`, relying on the blocks above).
     - Consider `FLAG_SECURE` on `MainActivity` if ДЧС policy prohibits screenshots/task-switcher previews of sensitive facility plans.

4. **[High] Release signing silently falls back to debug key; local plaintext keystore; `minifyEnabled false`**
   - `native/android/app/build.gradle:45`: `signingConfig keystoreProperties['storeFile'] ? signingConfigs.release : signingConfigs.debug` silently produces a debug-signed release APK if `keystore.properties` is absent.
   - `tools/native.js:119-123`: Generates the release keystore locally in `%LOCALAPPDATA%\firecalc-build\keys` with plaintext password in `keystore.properties`.
   - `native/android/app/build.gradle:43`: `minifyEnabled false` ships unshrunk classes (including unused Cordova/AndroidX code).
   - **Fix**: Fail the build when release signing credentials are missing; manage a single escrowed agency PKCS12 keystore via secure CI/vault env vars; enable `minifyEnabled true` and `shrinkResources true`.

### 3C. PWA (`index.html`, `sw.js`, `vercel.json`, `js/app.js`, `js/share.js`)
Good baseline: all `v-html`/`insertAdjacentHTML` usages (`js/app.js:291,388,389,464,492,524,807,2002`) render only static/allowlisted SVGs from `js/signs.js`; `sw.js` does not cache runtime responses.

1. **[High] Cross-cache lookup in `sw.js` allows same-origin serving of untrusted `share_target` files (Stored XSS vector)**
   - `sw.js:74-86`: `receiveShare()` caches uploaded `form.get('plan')` into `INBOX` (`firecalc-inbox`) under `inbox/plan` with sender-supplied `Content-Type: file.type || 'image/jpeg'` (`sw.js:80`) and **no MIME allowlist or size cap**.
   - `sw.js:69`: `networkFirst()` calls global `caches.match(keyOf(new URL(request.url)))` instead of `caches.open(CACHE).then(c => c.match(...))`. Offline (or on server 404/failure), navigating to `./inbox/plan` serves the cached `INBOX` entry with its raw `Content-Type` (e.g., `image/svg+xml` or `text/html`) on the app's origin.
   - **Fix**:
     - In `sw.js:76-82`, enforce an explicit raster allowlist (`image/jpeg`, `image/png`, `image/webp`) and max byte limit (e.g., 25 MB), and store with `Content-Type: application/octet-stream` + `X-Content-Type-Options: nosniff`.
     - In `sw.js:69`, replace global `caches.match(...)` with `fromCache(keyOf(new URL(request.url)))` so `INBOX` is never served to fetch/navigation requests.

2. **[High] No Content Security Policy or security headers for on-prem intranet hosting**
   - `index.html`: No `<meta http-equiv="Content-Security-Policy">`.
   - `vercel.json:22-27`: Only sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` (and applies only to Vercel, not intranet Nginx/IIS/Apache). Missing `CSP`, `X-Frame-Options: DENY`, `Permissions-Policy`, and `HSTS`.
   - **Fix**: Add `<meta http-equiv="Content-Security-Policy">` to `index.html` (protecting PWA, APK, and EXE simultaneously) and ship a sample Nginx/IIS config with `CSP`, `X-Frame-Options: DENY`, `Permissions-Policy: geolocation=(), microphone=()`, `Strict-Transport-Security`, and `Cache-Control: no-cache` for `sw.js`/`index.html`/`manifest.webmanifest`.

3. **[Medium] Over-broad `Service-Worker-Allowed: /`, decompression bomb in `#o=z...`, and `?ns=` query switch**
   - `vercel.json:7`: Sets `Service-Worker-Allowed: /`, which is overly broad if deployed under a subpath of a shared government portal. Keep scope restricted to `./`.
   - `js/share.js:135`: `DecompressionStream('deflate-raw')` has no output byte limit — a 12 KB compressed `#o=z...` payload can expand to tens of MB and crash the WebView/tab. Stream-read with a 512 KB cap before `JSON.parse`.
   - `js/app.js:23-25`: `?ns=` switches `localStorage`/IndexedDB namespaces in production, allowing accidental or spoofed links to hide user data or pollute storage. Gate behind a test flag or remove in production.

---

## 4. Update & Versioning Without Internet

### Current Distribution & Versioning Mechanics
- **Single source of truth**: `package.json:3` (`"version": "1.0.0"`). `tools/build.js:39-50,75-87` computes a 10-char SHA-256 content hash (`f8c279d73e`) across `ASSETS + sw.js` and stamps `sw.js:16`, `index.html:21,29-41`, and `js/config.js:10-11`.
- **Android APK (`tools/native.js:93-96,133-151`)**: `versionCode = major*10000 + minor*100 + patch` (`10000`), `versionName = pkg.version`. Delivered as `release/Ognetushiteli-<version>.apk` over USB/LAN and sideloaded over the prior install.
- **Windows EXE (`tools/native.js:153-165`)**: NSIS (`perMachine: false`, `oneClick: false`) and Portable EXE (`native/package.json:56-67`). Delivered over USB/LAN; NSIS upgrades in place per user.
- **Intranet PWA (`sw.js:41-57`, `js/platform.js:105-127`, `js/app.js:830-833`)**: Background-installs new SW on next intranet connection (HTTPS required), prompts `"Вышла новая версия приложения — Обновить"`, activates via `SKIP_WAITING`, prunes old `firecalc-*` caches, and reloads.

### Findings (Prioritized)

1. **[High] Unbumped `package.json` version blocks Android upgrades; signing key loss breaks in-place updates**
   - `tools/native.js:93-96,144`: Android `versionCode` derives exclusively from `package.json.version`, ignoring the `tools/build.js` content hash. Hotfixes without incrementing `package.json.version` produce identical `versionCode: 10000` (causing upgrade/version confusion); `minor` or `patch >= 100` also overflows the `*100` formula.
   - `tools/native.js:113-131`: Losing `%LOCALAPPDATA%\firecalc-build\keys` forces uninstalling old APKs and wiping all stored inspections.
   - **Fix**: Enforce semver bump (`version` + optional monotonic `buildNumber`) in `tools/native.js` before release packaging, validate `minor < 100 && patch < 100`, and centrally escrow the Android signing keystore.

2. **[High] IndexedDB `onupgradeneeded` will crash on any future DB version bump; `localStorage` ignores `d.version`**
   - `js/app.js:169-170`: `req.onupgradeneeded = function () { req.result.createObjectStore('img'); };` — incrementing DB version from `1` to `2` will throw `ConstraintError` on existing devices because `'img'` already exists.
   - `js/app.js:122-125`: `loadStore()` never inspects `d.version` (`2`, written at `js/app.js:1090`), so there is no migration dispatch or downgrade protection beyond the v1→v2 fallback (`js/app.js:127-131`) and field normalization in `adoptObject()` (`js/app.js:89-116`).
   - `js/app.js:1891-1895`: Clicking `"Обновить"` in PWA triggers `SKIP_WAITING` + `location.reload()` without flushing the 250 ms `save()` timer (`js/app.js:1088-1092`).
   - **Fix**: Guard store creation with `if (!db.objectStoreNames.contains('img')) db.createObjectStore('img');`; add explicit `if (d.version > CURRENT_SCHEMA)` guard and step-wise migrator in `loadStore()`; flush pending save inside `applyUpdate()` before posting `SKIP_WAITING`.

3. **[Medium] Incomplete version visibility and missing version/norms stamp in official PDFs**
   - `js/platform.js:179`: Exposes only `config.version` (`1.0.0`), dropping `config.build` (`f8c279d73e`, `js/config.js:11`).
   - `js/app.js:303,991-999`: Version is shown only inside the `"Объекты"` dropdown (`appNote`), and is completely hidden on web when SW isn't ready and storage isn't persisted (`js/app.js:998`).
   - `js/report.js:324,435-440`: Generated PDFs omit app version, build hash, and normative revision (`FireNorms.VERSION` — ППБ РК changes up to 25.08.2026, `js/norms.js:21`).
   - **Fix**: Expose `config.build` in `FirePlatform`, always display `v1.0.0 (f8c279d73e)` + norms edition in the app menu, and print `версия <version> (<build>), нормы: ППБ РК ред. 25.08.2026` in the PDF footer/metadata (`js/report.js:324,439`).

4. **[Low] `native/package.json:3` version drift & NSIS per-user vs per-machine rollout**
   - `tools/native.js:68-70` only updates `WORK/package.json`, leaving `native/package.json:3` at `1.0.0`.
   - `native/package.json:58` (`perMachine: false`) is convenient without admin rights, but if IT admins deploy via GPO/SCCM or admin accounts on shared ДЧС workstations, consider also shipping an MSI / `perMachine: true` installer.

---

## 5. Compatibility with Government Office Platforms (Kazakhstan)

### 5A. Windows Compatibility (`native/package.json:15,39-53`)

1. **[Critical] Electron `45.4.1` drops Windows 7, 8, and 8.1**
   - `native/package.json:15` pins `"electron": "45.4.1"`. Electron removed Windows 7 / 8 / 8.1 support in **Electron 23** (Chromium 109 was the last version supporting Win 7/8/8.1).
   - Both `Ognetushiteli-Setup-1.0.0.exe` and `Ognetushiteli-1.0.0-portable.exe` **will fail to launch on Windows 7 / 8 / 8.1**, which remain prevalent on legacy air-gapped government PCs.
   - **Fix**: Document **Windows 10/11 (64-bit)** as hard minimum for the EXE. For remaining Windows 7 workstations, serve the PWA over intranet HTTPS (works on **Chrome 109 / Edge 109** or **Firefox 115 ESR**, all of which support every CSS/JS API used here) — or maintain a separate Electron 22.3.x legacy build if strictly required (noting Electron 22 is EOL and acceptable only on fully air-gapped machines).

2. **[High] 64-bit (`x64`) only — no 32-bit (`ia32`) Windows binary**
   - `native/package.json:43-50` and `tools/native.js:157` build `--x64` exclusively; 32-bit Windows 10 machines cannot run the EXE.
   - **Fix**: Audit target ДЧС workstation architectures; if 32-bit Windows 10 exists, provide PWA over intranet HTTPS (or an `ia32` build on an Electron version that supports `ia32`).

### 5B. Android & WebView Compatibility (`native/android/variables.gradle:2`)

1. **[Critical] Severe mismatch between `minSdkVersion = 24` (Android 7.0) and actual WebView floor (Chromium 88–105)**
   - `native/android/variables.gradle:2` declares `minSdkVersion = 24` (Android 7.0; `README.md:24`: *"Android 7 и новее"*), with **no `android.minWebViewVersion`** check in `native/capacitor.config.json`.
   - On **air-gapped / offline Android devices** without Google Play updates, Android System WebView stays frozen at the factory OS version: Android 7.0 ≈ **WebView 51–55**, Android 8 ≈ **58–61**, Android 9 ≈ **66–69**, Android 10 ≈ **74–76**, Android 11 ≈ **83**, Android 12 ≈ **91**.
   - **Breaking features on older WebViews**:

| Feature | Location | Min Chromium / WebView | Failure mode on older WebViews |
|---|---|---:|---|
| Capacitor 8 runtime (`native-bridge.js` `async/await`, bridge check) | `native/package.json:9`, `classes.dex` | **60** (hard minimum) | App refuses to start / blank screen on stock Android 7.0 (WebView 51–55). |
| SVG2 `<image :href>` without `xlink:href` | `js/app.js:471,725` | **79** | **Uploaded floorplan image is completely invisible** in both wizard and floor scheme on stock Android 7–10. |
| CSS `min(...)` | `css/app.css:167,237,284,401,417,510` | **79** | **Modals (PDF, Floorplan wizard, Norms) and title input break layout/width** on WebView < 79. |
| Flexbox `gap` | `css/app.css:83,87,108,135,171,285,301,404` (+30 rules) | **84** | All flexbox spacing collapses to `0` on stock Android 7–11 (WebView < 84). |
| CSS `inset: 0` | `css/app.css:400` | **87** | **All `.modal` overlays collapse/misposition** (`top/right/bottom/left` unset) on WebView < 87 (stock Android 7–11). |
| CSS `aspect-ratio` | `js/app.js:468,724` | **88** | Floor scheme and blueprint SVGs mis-size or collapse on WebView < 88 (stock Android 7–11). |
| `DecompressionStream('deflate-raw')` | `js/share.js:135-136` | **103** | Cannot open `#o=z...` links/QR codes created by newer devices on stock Android 7–12 (WebView < 103); `encode()` falls back cleanly to `'j'`, `decode()` throws. |
| `:focus-visible` grouped with `:focus-within` | `css/app.css:79` | **86** | Entire selector rule dropped on WebView < 86 (minor: focus ring missing). |
| `overflow-wrap: anywhere` / `accent-color` / `:has()` | `css/app.css:361`, `109,304,395`, `269` | **80 / 93 / 105** | Graceful degradation (cosmetic only). |
| Vue 3 (`Proxy`, `Symbol`), App JS (`PointerEvent`, `URLSearchParams`, `TextEncoder`, `scrollIntoView({block})`), `pdfmake.min.js` (`BigInt` is feature-guarded by `defineBigIntMethod`) | `vendor/vue.global.prod.js`, `js/app.js:1570,1689`, `vendor/pdfmake.min.js` | **49–61** | Clean ES2015 codebase; no unguarded ES2020+ syntax (`?.`, `??`, `Object.hasOwn`, `globalThis` are absent or polyfilled/guarded). |

   - **Concrete fixes (lowers working Android WebView floor from 88 → 61 with ~25 lines of CSS/HTML)**:
     1. Replace `inset: 0` (`css/app.css:400`) with `top: 0; right: 0; bottom: 0; left: 0;`.
     2. Replace `width: min(100%, Xpx)` (`css/app.css:167,284,401,417`) with `width: 100%; max-width: Xpx;`, and `max-height: min(64vh, 440px)` (`css/app.css:237,510`) with `max-height: 440px; max-height: min(64vh, 440px);`.
     3. Add `:xlink:href` alongside `:href` on `<image>` and `<use>` (`js/app.js:471,483,725`).
     4. Split `:focus-visible` from `.seg__opt:focus-within` (`css/app.css:79`).
     5. Add explicit SVG height fallback (or `padding-top` wrapper) when `CSS.supports('aspect-ratio', '1 / 1')` is false, and margin fallbacks (or `@supports not (gap: 1px)`) for flex containers.
     6. Set `"minWebViewVersion": 61` (or `88` if CSS is not backported) in `native/capacitor.config.json` + a friendly Russian startup check/warning (`errorPath`) instructing IT to sideload an updated Android System WebView APK on un-updated Android 7–11 devices.
     7. In `js/share.js:121-138`, either bundle a ~3 KB pure-JS raw-inflate fallback for `'z'` payloads or emit `'j'` when compatibility with WebView < 103 is required.
