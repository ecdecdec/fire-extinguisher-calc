// Снимки экрана для окна установки приложения (manifest.webmanifest, screenshots):
// широкий (компьютер) и узкий (телефон), на примере «бизнес-центр».
//   node tools/make-screens.js   → icons/screens/wide.png (1280 × 800), narrow.png (720 × 1280)
const fs = require('node:fs');
const path = require('node:path');
const C = require('./cdp.js');

(async function () {
  const port = 8900 + Math.floor(Math.random() * 90);
  const server = await C.serve(port);
  const browser = await C.launch({ port: 9500 + Math.floor(Math.random() * 90), width: 1400, height: 1400 });
  const dir = path.join(C.ROOT, 'icons', 'screens');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const shots = [
      { file: 'wide.png', width: 1280, height: 800, scale: 1, mobile: false, step: '' },
      { file: 'narrow.png', width: 360, height: 640, scale: 2, mobile: true, step: '' }
    ];
    for (const s of shots) {
      const t = await C.tab(browser, 'about:blank');
      await t.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: s.scale, mobile: s.mobile });
      if (s.mobile) await t.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await t.goto('http://127.0.0.1:' + port + '/index.html?ns=screens' + Date.now() + '&demo=business');
      await t.until("document.querySelector('[data-test=plan-svg] .plan__ext')");
      await t.eval("document.fonts.ready.then(() => true)");
      // схема — в поле зрения: на телефоне прокрутка к ней, на компьютере — к верху этажа
      await t.eval("(function () { const el = document.querySelector('" + (s.mobile ? '.plan__head' : '.floor') + "'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - " + (s.mobile ? 112 : 64) + "); return true; }())");
      await C.sleep(600);
      const out = path.join(dir, s.file);
      await t.shot(out);
      console.log(out);
      t.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
}()).catch(e => { console.error(e); process.exit(1); });
