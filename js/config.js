/*
 * Настройки приложения.
 *   version   — номер версии (его ставит tools/build.js из package.json);
 *   publicUrl — адрес опубликованного сайта, например https://firecalc.example.kz/.
 *               На него ведут «Ссылка на расчёт» и QR-код в PDF, сформированные в приложениях
 *               для Android и Windows. На сайте ссылка всегда ведёт на сам сайт.
 *               Пусто — в приложениях ссылки и QR-кода нет (расчёт всё равно работает).
 */
window.FIRECALC_CONFIG = {
  version: '1.0.1',
  build: 'da2fa912d3',
  publicUrl: ''
};
