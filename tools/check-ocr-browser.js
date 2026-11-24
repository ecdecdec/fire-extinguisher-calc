// Проверка чтения надписей в настоящем браузере (Edge или Chrome без окна) без сети:
//   - tesseract.js стартует из vendor/tesseract (ядро с SIMD или запасное);
//   - ни одного запроса не на локальный сервер (проверка по событиям сети);
//   - масштаб по надписям синтетического плана в пределах 2 %, уложились в 60 с;
//   - то же из фонового потока (вложенный поток tesseract).
// Перед каждым шагом печатается строка хода работы; общий предел 150 с (код выхода 2).
//   node tools/check-ocr-browser.js
const C = require('./cdp.js');

let failed = 0, step = 'запуск', browserRef = null, serverRef = null;
const T0 = Date.now();
function say(s) { step = s; console.log('  [' + Math.round((Date.now() - T0) / 100) / 10 + ' с] ' + s); }
function ok(name, cond, detail) {
  if (cond) console.log('PASS  ' + name);
  else { failed += 1; console.log('FAIL  ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const watchdog = setTimeout(function () {
  console.log('FAIL  общий предел 150 с, остановились на шаге: ' + step);
  try { if (browserRef) browserRef.close(); } catch (e) { /* уже закрыт */ }
  try { if (serverRef) serverRef.kill(); } catch (e) { /* уже остановлен */ }
  setTimeout(function () { process.exit(2); }, 500);
}, 150000);

async function run(browser, base, host, mode) {
  say(mode + ': вкладка');
  const t = await C.tab(browser, 'about:blank');
  try {
    const foreign = [], errors = [];
    await t.send('Network.enable');
    await t.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 5000).catch(function () {});
    t.on('Network.requestWillBeSent', function (p) {
      if (!/^(data|blob|about):/.test(p.request.url) && new URL(p.request.url).host !== host) foreign.push(p.request.url);
    });
    t.on('Runtime.exceptionThrown', function (p) { errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text); });
    const t0 = Date.now();
    say(mode + ': загрузка страницы');
    await t.goto(base + 'tests/ocr-browser.html' + (mode === 'worker' ? '?mode=worker' : ''));
    say(mode + ': ожидание результата');
    let res;
    try { res = JSON.parse(await t.until('window.__ocr && JSON.stringify(window.__ocr)', 60000)); } catch (e) { res = { ok: false, error: e.message }; }
    const wall = Date.now() - t0;
    const r = res.result || {};
    console.log('  ' + mode + ': ' + wall + ' мс, ядро ' + (r.info && r.info.core) + ', прочитано ' + r.read + '/' + r.rooms + ' (верно ' + r.okRead + '), масштаб ' + (r.scaleErrPct !== null && r.scaleErrPct !== undefined ? r.scaleErrPct.toFixed(2) + ' %' : 'нет') + ', чтение ' + r.ms + ' мс');
    ok(mode + ': чтение выполнено', res.ok === true, (res.error || '') + ' ' + errors.join(' | '));
    ok(mode + ': запросов на чужие адреса нет', foreign.length === 0, foreign.slice(0, 3).join(' '));
    ok(mode + ': ядро запустилось', !!(r.info && r.info.core), '');
    ok(mode + ': масштаб в пределах 2 %', r.scaleErrPct !== null && r.scaleErrPct !== undefined && Math.abs(r.scaleErrPct) <= 2, String(r.scaleErrPct));
    ok(mode + ': уложились в 60 с', wall < 60000, wall + ' мс');
    return res.ok === true;
  } finally {
    t.close();
  }
}

// Одна повторная попытка при сбое или таймауте: на занятой машине браузер изредка срывается.
async function once(browser, base, host, mode) {
  const before = failed;
  let good = false;
  try { good = await run(browser, base, host, mode); } catch (e) { console.log('  сбой на шаге «' + step + '»: ' + e.message); }
  if (good) return;
  failed = before;
  console.log('  повтор: ' + mode);
  try { await run(browser, base, host, mode); } catch (e) { failed += 1; console.log('FAIL  ' + mode + ': ' + e.message + ' (шаг «' + step + '»)'); }
}

(async function () {
  try {
    say('сервер');
    const port = 8900 + Math.floor(Math.random() * 90);
    serverRef = await C.serve(port);
    say('браузер');
    browserRef = await C.launch({ port: 9700 + Math.floor(Math.random() * 90), width: 900, height: 700 });
    const base = 'http://127.0.0.1:' + port + '/';
    await once(browserRef, base, '127.0.0.1:' + port, 'main');
    await once(browserRef, base, '127.0.0.1:' + port, 'worker');
  } catch (e) {
    failed += 1;
    console.log('FAIL  ' + e.message + ' (шаг «' + step + '»)');
  } finally {
    try { if (browserRef) await browserRef.close(); } catch (e) { /* уже закрыт */ }
    try { if (serverRef) serverRef.kill(); } catch (e) { /* уже остановлен */ }
  }
  clearTimeout(watchdog);
  console.log(failed ? 'Не пройдено: ' + failed : 'Все проверки пройдены');
  process.exit(failed ? 1 : 0);
}());
