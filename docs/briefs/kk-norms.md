# Задание: официальные казахские тексты норм для справочника

Model: Gemini 4 Argon (High). Branch: kk-norms (from main). Read docs/briefs/common.md, AGENTS.md, docs/plan.md items А3 and 4.3, and js/library.js first. Network is required (web reading).

The app gets a language switch (Русский / Қазақша). The norms reference (js/library.js) holds verbatim Russian texts of the items the calculation relies on. In Kazakh mode the inspector must see the official Kazakh texts of the same items, never a machine translation.

1. For every document and item in js/library.js find the official Kazakh text on adilet.zan.kz (the Kazakh version of the same act, URLs like https://adilet.zan.kz/kaz/docs/V2200026867 for the Fire Safety Rules, order № 55; https://adilet.zan.kz/kaz/docs/V2100024045 for the technical regulation № 405; others by the same document number). Copy the text of the same item verbatim, including tables.
2. Interstate and national standards (ГОСТ, СТ РК) usually have no official Kazakh text: keep the Russian text and mark the item `lang: 'ru'` with a short Kazakh note that the official text exists only in Russian.
3. Create js/library-kk.js with exactly the same structure, document ids and item refs as js/library.js (UMD, global FireLibraryKk), plus a `sources` list of the URLs you used with the edition date shown on each page.
4. tests/library-kk.test.js: same document ids and item refs as library.js, no empty texts, every Kazakh item has a source URL; Kazakh letters (Ә Ғ Қ Ң Ө Ұ Ү Һ І) are present in Kazakh items.
5. Do not change js/library.js or anything else.

If a page cannot be opened or an item cannot be found, leave that item as Russian with `lang: 'ru'` and list it in the report. Report: per document, items found in Kazakh, URLs and editions, items left in Russian and why.
