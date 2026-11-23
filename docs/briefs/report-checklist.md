# Задание: отчёт по форме проверочного листа (этапы 5.5 и 5.7 плана)

Branch: report-checklist. Read docs/briefs/common.md, AGENTS.md, docs/plan.md (section А2, items 5.5 and 5.7), docs/style.md first, then js/report.js, tests/report.test.js, the PDF dialog in js/app.js (search «Данные для отчёта») and js/share.js. Change only js/report.js, the PDF dialog and object defaults in js/app.js (`blankObject`, `adoptObject`), js/share.js if the link format needs the new fields, and tests. Network allowed for reading the law texts.

The inspector attaches the result to the official check documents. The PDF must speak the language of the checklist (joint order МВД РК № 758 and МНЭ РК № 31 of 30.10.2018, current text at https://zakon.uchet.kz/rus/docs/V1800017647 or https://adilet.zan.kz/rus/docs/V1800017647).

1. New object fields (optional, empty by default, kept in storage and in the link): государственный орган, номер и дата акта о назначении проверки (или профилактического контроля), ИИН/БИН субъекта контроля. Inputs in the PDF dialog of the old app, in the same style as the existing fields. Old saved objects load without errors.
2. PDF header: those fields in the order of the checklist header (государственный орган; акт о назначении проверки, номер и дата; наименование субъекта; ИИН/БИН; адрес). Empty fields print as a blank line for handwriting, not as a dash.
3. Conclusion per requirement: «Приложение 3 к совместному приказу …, п. 51: Наличие требуемого количества исправных и прошедших техническое обслуживание первичных средств пожаротушения: соответствует / не соответствует». Verify the item number and wording against the current text of the order; quote it exactly. If the building kind maps clearly to one of the specialised checklists (for example education, medical, trade, storage), add that checklist's matching item only if you can verify its number in the current text; otherwise do not invent it.
4. Degree of violation (грубое, значительное, незначительное) from Appendix 1 of the same order for the п. 51 requirement, only if you find and verify it; otherwise leave it out and say so in the report.
5. Signature block as in the checklist form: «Должностное лицо» (должность, подпись, фамилия, имя, отчество при наличии) and «Руководитель субъекта контроля» with the same fields.
6. Footer or metadata on every page: application version (window.FIRECALC_CONFIG.version and build) and the norms edition (FireNorms.VERSION or the source list in js/norms.js).
7. Keep the strict document look (Tinos, black text, colour only inside sign drawings) and every rule tests/report.test.js already enforces (no em dashes, no middle dots, no fills, page 1 holds a typical object). Add tests for the new header, conclusion and footer.
8. Check: `npm test`, `npm run check:ui`, `node tools/sample-pdf.js`; render page 1 of the sample PDF to PNG with PyMuPDF (`python -I -c "import fitz; ..."`) and look at it; describe it in the report.

Commit with short Russian messages. Final report: what changed, the exact quotes and sources you verified, what you could not verify, test output.
