// Проверка интерфейса в настоящем браузере одной командой: запускает локальный сервер и
// Edge (или Chrome) без окна, открывает tests/ui-smoke.html и печатает результат.
//   node tools/check-ui.js        (npm run check:ui)
const C = require('./cdp.js');

(async function () {
  const port = 8800 + Math.floor(Math.random() * 100);
  const server = await C.serve(port);
  const browser = await C.launch({ port: 9400 + Math.floor(Math.random() * 100), width: 1400, height: 1000 });
  let code = 1;
  try {
    const t = await C.tab(browser, 'http://127.0.0.1:' + port + '/tests/ui-smoke.html');
    const errors = [];
    t.on('Runtime.exceptionThrown', p => errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text));
    await t.until("document.getElementById('summary') && !/Выполняется/.test(document.getElementById('summary').textContent)", 240000);
    const out = await t.eval("({ summary: document.getElementById('summary').textContent, rows: [...document.querySelectorAll('#report div')].map(d => d.textContent) })");
    out.rows.filter(r => r.startsWith('FAIL')).forEach(r => console.log(r));
    console.log(out.summary);
    if (errors.length) console.log('Ошибки на странице:\n' + errors.join('\n'));
    const m = /не пройдено (\d+)/.exec(out.summary);
    code = !m || Number(m[1]) > 0 || out.rows.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0;
    t.close();
  } catch (e) {
    console.error(e.message);
  } finally {
    await browser.close();
    server.kill();
  }
  process.exit(code);
}());
