// Проверка устанавливаемого приложения (PWA) в настоящем браузере:
//   — манифест разобран без ошибок, браузер считает приложение устанавливаемым;
//   — служба работы без сети (sw.js) установилась и сохранила все файлы;
//   — без сети приложение открывается, считает и формирует PDF;
//   — новая версия sw.js приводит к кнопке «Обновить», после нажатия страница на новой версии.
//   node tools/check-pwa.js
const fs = require('node:fs');
const path = require('node:path');
const C = require('./cdp.js');

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('PASS  ' + name);
  else { failed += 1; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

let dump = null;
(async function () {
  const port = 8700 + Math.floor(Math.random() * 90);
  const server = await C.serve(port);
  const browser = await C.launch({ port: 9600 + Math.floor(Math.random() * 90), width: 1280, height: 900 });
  const base = 'http://127.0.0.1:' + port + '/';
  const swFile = path.join(C.ROOT, 'sw.js');
  const swText = fs.readFileSync(swFile, 'utf8');
  try {
    const t = await C.tab(browser, 'about:blank');
    dump = async function () {
      try { console.log('  страница: ' + await t.eval("location.href + ' | ' + document.title + ' | ' + document.body.innerText.slice(0, 200).replace(/\s+/g, ' ')")); } catch (e) { console.log('  страница недоступна: ' + e.message); }
      if (errors.length) console.log('  ошибки: ' + errors.join(' | '));
    };
    const errors = [];
    t.on('Runtime.exceptionThrown', p => errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text));
    await t.goto(base + 'index.html?ns=pwacheck&demo=business');
    await t.until("document.querySelector('[data-test=plan-svg]')", 45000); // первый запуск браузера бывает долгим

    // манифест и возможность установки
    const man = await t.send('Page.getAppManifest');
    ok('манифест разобран без ошибок', man.errors.length === 0, JSON.stringify(man.errors));
    await t.until("navigator.serviceWorker && navigator.serviceWorker.controller", 20000);
    const inst = await t.send('Page.getInstallabilityErrors');
    ok('браузер считает приложение устанавливаемым', inst.installabilityErrors.length === 0, JSON.stringify(inst.installabilityErrors));

    // все файлы сохранены
    const cached = await t.eval("caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('firecalc-') && k !== 'firecalc-inbox').map(k => caches.open(k).then(c => c.keys()).then(r => r.length))))");
    const assets = require('./build.js').assets();
    ok('сохранены все файлы приложения (' + assets.length + ')', cached.length === 1 && cached[0] === assets.length, JSON.stringify(cached));

    // без сети: открывается, считает, PDF
    await t.send('Network.enable');
    await t.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await t.goto(base + 'index.html?ns=pwacheck2&demo=factory&selfcheck=1');
    await t.until("document.querySelector('.total')", 15000);
    ok('без сети приложение открывается и считает', await t.eval("document.querySelectorAll('.total').length > 0"));
    ok('без сети видна пометка «без сети»', await t.eval("!!document.querySelector('[data-test=offline]')"));
    const self = await t.until("(document.getElementById('selfcheck') || {}).textContent && !/формирую/.test(document.getElementById('selfcheck').textContent) && document.getElementById('selfcheck').textContent", 30000);
    ok('без сети формируется PDF', /PDF сформирован/.test(self), self);
    await t.goto(base + 'index.html?ns=pwacheck2&demo=business');
    await t.until("document.querySelector('[data-test=plan-svg]')", 15000);
    await t.eval("document.querySelector('[data-test=norms]').click(), true");
    await t.until("document.querySelector('[data-test=library]')", 5000);
    ok('без сети открывается справочник норм', await t.eval("document.querySelectorAll('.lib__doc').length >= 8"));
    await t.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    // новая версия: другой VERSION в sw.js → кнопка «Обновить» → страница на новой версии
    const v1 = await t.eval("caches.keys().then(ks => ks.find(k => k.startsWith('firecalc-') && k !== 'firecalc-inbox'))");
    fs.writeFileSync(swFile, swText.replace(/const VERSION = '([^']*)';/, "const VERSION = '$1-check';"));
    await t.goto(base + 'index.html?ns=pwacheck&demo=business');
    await t.until("document.querySelector('[data-test=plan-svg]')", 15000);
    await t.eval("navigator.serviceWorker.getRegistration().then(r => r && r.update()).then(() => true)");
    await t.until("document.querySelector('[data-test=update]')", 20000);
    ok('новая версия: показана кнопка «Обновить»', true);
    await t.eval("document.querySelector('[data-test=update-apply]').click(), true");
    await C.sleep(1500);
    await t.until("document.querySelector('[data-test=plan-svg]')", 15000);
    const v2 = await t.eval("caches.keys().then(ks => ks.filter(k => k.startsWith('firecalc-') && k !== 'firecalc-inbox'))");
    ok('после «Обновить» работает новая версия, старая удалена', v2.length === 1 && v2[0] === v1 + '-check', JSON.stringify([v1, v2]));
    ok('на странице нет ошибок', errors.length === 0, errors.join(' | '));
    t.close();
  } catch (e) {
    failed += 1;
    console.log('FAIL  ' + e.message);
    if (typeof dump === 'function') await dump();
  } finally {
    fs.writeFileSync(swFile, swText);
    await browser.close();
    server.kill();
  }
  console.log(failed ? 'Не пройдено: ' + failed : 'Все проверки PWA пройдены');
  process.exit(failed ? 1 : 0);
}());
