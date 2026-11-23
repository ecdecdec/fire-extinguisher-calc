# Задание: проверка работы другой модели (шаблон)

Model: Gemini 4 Argon (High), read-only (`--sandbox`). The owner fills in BRANCH, BRIEF and BASE below.

READ-ONLY review. Do not create, modify or delete files, do not commit.

You review the work done on git branch BRANCH (in this directory) against its brief BRIEF, compared with BASE (`git diff BASE...HEAD`). Read docs/briefs/common.md, AGENTS.md and the brief first.

Check and report, with file:line for every finding:
1. Brief compliance: every requirement of the brief done or not done (a table: requirement, status, evidence).
2. Correctness: bugs, edge cases, wrong results; run the tests the brief names and report the output (`node --test tests/`, and for the new app `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:e2e` if present; if a command needs network or fails for environment reasons, say so).
3. Code quality at the level of a senior engineer at Thoughtworks: structure, naming, duplication, dead code, files that are too large, missing types, tests that do not test anything.
4. Project rules: offline (no network calls), no `?.`/`??` in the old app code, Russian comments, no em dash or middle dot characters in new comments, strings or commit messages, texts per docs/style.md, look per docs/design.md, no secrets, no real building plans.
5. Risks for the owner when merging (conflicts with main, performance, memory on phones).

Finish with a verdict: MERGE, MERGE AFTER FIXES (list them, most important first), or REJECT (why). No padding.
