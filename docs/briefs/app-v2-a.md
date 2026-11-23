# Задание: новое приложение 2.0, фаза A (каркас и основной ход работы)

Model: Gemini 4 Neon (XHigh). Branch: app-v2. Read docs/briefs/common.md, AGENTS.md, docs/plan.md (sections В, 3, И), docs/design.md and docs/style.md first. Rules 2 and 3 of common.md are changed for this job: you may run `npm install` (network allowed for npm only) and add dev and runtime dependencies listed below; do not run `npm run build` of the old app.

## Why

The current app is one 2000-line file (js/app.js) with a string template, rendered as a long web page. The customer says it looks AI-made and feels like a website inside an app. Version 2.0 is a real mobile and desktop app on the same offline web code, built at the engineering level of Thoughtworks or Vention. This job builds the new app next to the old one (the old app at the repository root keeps working for the pilot until phase C switches over).

## Stack (exact, pin versions with save-exact, commit package-lock.json)

- Vite (current stable), Vue 3.5 with `<script setup lang="ts">`, TypeScript strict.
- Ionic Vue 8 (`@ionic/vue`, `@ionic/vue-router`), mode `md` on every platform. Ionicons only where Ionic needs them; prefer Material Symbols SVGs (copy the few SVGs you need into the repo, Apache-2.0, keep the licence file).
- Pinia for state, vue-i18n for texts (ru is the default and complete; kk has the same keys, values copied from ru and marked for translation in a comment at the top of the file).
- ESLint flat config with eslint-plugin-vue and typescript-eslint, Prettier.
- Vitest with @vue/test-utils and jsdom for unit and component tests.
- Playwright using the installed Microsoft Edge (`channel: 'msedge'`, do not download browsers), two projects: phone (412 x 915, touch, isMobile) and desktop (1366 x 900).

## Layout

- `app/` is the Vite root: `app/index.html`, `app/src/main.ts`, `App.vue`, `router.ts`, `stores/`, `screens/`, `components/`, `engine/`, `i18n/`, `theme/`. Build output `dist/` (gitignored). Do not create files at the repository root except package.json changes, config files the tools need (eslint.config.js, .prettierrc, playwright.config.ts, vitest config if not inside vite config), and docs.
- The calculation code stays where it is and is not modified: js/norms.js, js/engine.js, js/presets.js, js/plan.js, js/signs.js, js/report.js, js/share.js, js/library.js, js/vision.js. They are UMD modules (globals in the browser, CommonJS in Node). Import them through a typed wrapper `app/src/engine/` (either configure Vite's CommonJS handling for `../js/*.js` or import them for their side effect and read the globals; choose one, explain it in the ADR). Write `.d.ts` types for what the app uses.
- Existing `npm test` (node --test over tests/) must keep passing and must not pick up Vitest or Playwright files (name them `*.spec.ts`).
- package.json scripts to add: `app:dev`, `app:build`, `app:preview`, `lint`, `format`, `typecheck`, `test:unit`, `test:e2e`, `check` (lint + typecheck + test + test:unit).

## Data

The Pinia store reads and writes the same localStorage key and format as js/app.js (`firecalc.store.v2`, see `loadStore`, `adoptObject`, `blankObject`, `newRoom`, `newFloor` in js/app.js) so the inspector's existing objects open in the new app. Saving is debounced but flushed on `visibilitychange` (hidden) and `pagehide`; a failed save shows a persistent message. Keep the data model the same; do not invent new fields except where needed, and document them.

## Screens in this phase (Russian texts per docs/style.md, all strings through vue-i18n)

1. Объекты: list of objects (name or «Без названия», address if any, date, rooms count, verdict «Соответствует» / «Нарушений: N» computed with the engine), button «Новый объект» (FAB), delete with undo (toast with «Отменить»), search when there are more than 8 objects.
2. Объект: name and address fields, building kind (Общественное, Производственное, Складское; segment), automatic fire suppression switch, list of floors (name, rooms, area, required extinguishers), «Добавить этаж», button to the result.
3. Этаж: segment «Помещения» and «Схема». Помещения: list rows (name or purpose, area, count) with «Добавить помещение» and quick-add chips (the quick purposes of the building kind from js/presets.js). Tapping a row opens a sheet (ion-modal with breakpoints) to edit: name (with purpose guessing as in js/app.js `onName`), purpose (searchable list, grouped as in presets), area (text field with decimal keyboard, accepts comma and dot), count (stepper with − and +), category and fire classes for non-public buildings, «Дорогая электроника», «Автоматическое пожаротушение», delete with undo. Схема: in this phase a plain notice that the scheme comes in phase B, but render the floor's rooms with js/plan.js scene geometry read-only if it is quick.
4. Итог: required extinguishers by type with the sign icon from js/signs.js `icon()`, installed counts per floor (steppers), verdict, list of violations from js/plan.js `audit` (place, finding, measure, reference to the norm on separate lines), per-floor breakdown with the calculation steps (collapsible). Button «Сформировать отчёт» can be disabled in this phase.
5. Нормы: the reference from js/library.js with search, as in the old app.
6. Настройки: language «Русский» / «Қазақша» (switches all UI texts instantly and is saved), inspector profile (ФИО, должность, подразделение; filled into new objects), «О программе» (version from package.json).

Navigation: phone: top toolbar with title and back arrow on inner screens, main action at the bottom; hardware Back goes up one level (Ionic router). Desktop (width 1024 and more): Ionic split pane with the objects list on the left and the selected object on the right; result visible next to the rooms on wide screens.

## Look (docs/design.md)

System font stack, body text 16 px, controls and list rows at least 48 px on touch, one red #C1121C only for shortages, prohibitions and fire safety signs, green #008351 for «Соответствует» and evacuation, neutral grays elsewhere, contrast WCAG AA (borders at least 3:1). No gradients, no shadows beyond Ionic defaults, no emoji, no decorative badges, no uppercase labels, no monospace except number tables. Light and dark theme (Ionic dark palette), respects prefers-color-scheme.

## Quality gates (all must pass, report the commands and results)

- `npm run lint` and `npm run typecheck`: 0 errors.
- Unit tests (Vitest): store load/save including old-format data, debounced save flush, engine wrapper gives the same totals as js/engine.js for every example in js/presets.js EXAMPLES, i18n ru and kk have identical key sets, room sheet decimal parsing (comma and dot).
- E2E (Playwright, both projects): create an object, add three rooms with areas, see the correct required totals; open the «business» example (js/presets.js) and see the same totals as the old app shows for it; language switch to Қазақша and back; hardware Back (Escape on desktop) closes the sheet and goes up; no network requests to anything but localhost during the whole run (fail the test otherwise); full-page screenshots of every screen in both projects saved to app/e2e/screenshots/ and committed (they are the visual baseline the owner reviews).
- Old app untouched: `npm test` passes, `git diff main -- index.html js/ css/ sw.js native/ tools/ tests/` is empty.

## Docs

- docs/adr/0001-app-stack.md: context, decision, consequences (why Vite, TypeScript, Ionic md, Pinia, vue-i18n; how the UMD modules are imported; how old WebViews are handled: build target and what it means).
- docs/architecture.md: the parts of the app and how data flows (store, engine, screens), short.
- app/README.md: how to run, test and build.

Commit in logical steps with short Russian messages. Final report: what was built, screenshots list, gate results, open questions for phase B.
