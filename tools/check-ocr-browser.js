// Проверка чтения надписей в настоящем браузере (Edge или Chrome без окна) без сети:
//   - tesseract.js стартует из vendor/tesseract (ядро с SIMD или запасное);
//   - ни одного запроса не на локальный сервер (проверка по событиям сети);
//   - масштаб по надписям синтетического плана в пределах 2 %, уложились в 60 с;
//   - то же из фонового потока (вложенный поток tesseract).
//   node tools/check-ocr-browser.js
const C = require('./cdp.js');

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('PASS  ' + name);
  else { failed += 1; console.log('FAIL  ' + name + (detail ? ' (' + detail + ')' : '')); }
}

async function run(browser, base, host, mode) {
  const t = await C.tab(browser, 'about:blank');
  const foreign = [], errors = [];
  await t.send('Network.enable');
  await t.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(function () {});
  t.on('Network.requestWillBeSent', function (p) {
    if (!/^(data|blob|about):/.test(p.request.url) && new URL(p.request.url).host !== host) foreign.push(p.request.url);
  });
  t.on('Runtime.exceptionThrown', function (p) { errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text); });
  const t0 = Date.now();
  await t.goto(base + 'tests/ocr-browser.html' + (mode === 'worker' ? '?mode=worker' : ''));
  let res;
  try { res = JSON.parse(await t.until('window.__ocr && JSON.stringify(window.__ocr)', 60000)); } catch (e) { res = { ok: false, error: e.message }; }
  const wall = Date.now() - t0;
  t.close();
  const r = res.result || {};
  console.log('  ' + mode + ': ' + wall + ' мс, ядро ' + (r.info && r.info.core) + ', прочитано ' + r.read + '/' + r.rooms + ' (верно ' + r.okRead + '), масштаб ' + (r.scaleErrPct !== null && r.scaleErrPct !== undefined ? r.scaleErrPct.toFixed(2) + ' %' : 'нет') + ', чтение ' + r.ms + ' мс');
  ok(mode + ': чтение выполнено', res.ok === true, (res.error || '') + ' ' + errors.join(' | '));
  ok(mode + ': запросов на чужие адреса нет', foreign.length === 0, foreign.slice(0, 3).join(' '));
  ok(mode + ': ядро запустилось', !!(r.info && r.info.core), '');
  ok(mode + ': масштаб в пределах 2 %', r.scaleErrPct !== null && r.scaleErrPct !== undefined && Math.abs(r.scaleErrPct) <= 2, String(r.scaleErrPct));
  ok(mode + ': уложились в 60 с', wall < 60000, wall + ' мс');
  return wall;
}

// Одна повторная попытка: запуск браузера или вкладки изредка срывается, пока на машине идут другие проверки.
async function once(browser, base, host, mode) {
  try { return await run(browser, base, host, mode); } catch (e) {
    console.log('  повтор после сбоя: ' + e.message);
    return run(browser, base, host, mode);
  }
}

(async function () {
  const port = 8900 + Math.floor(Math.random() * 90);
  const server = await C.serve(port);
  const browser = await C.launch({ port: 9700 + Math.floor(Math.random() * 90), width: 900, height: 700 });
  try {
    const base = 'http://127.0.0.1:' + port + '/';
    await once(browser, base, '127.0.0.1:' + port, 'main');
    await once(browser, base, '127.0.0.1:' + port, 'worker');
  } catch (e) {
    failed += 1;
    console.log('FAIL  ' + e.message);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failed ? 'Не пройдено: ' + failed : 'Все проверки пройдены');
  process.exit(failed ? 1 : 0);
}());
