/*
 * Где запущено приложение и что от этого зависит.
 *
 *   web     — сайт в браузере; по адресу http(s) он же устанавливаемое приложение (PWA):
 *             работа без сети (sw.js), установка на экран, обновление по кнопке,
 *             приём фото плана через «Поделиться» (Android) и открытие картинки (компьютер);
 *   android — приложение для телефона (Capacitor): файлы лежат внутри APK, сеть не нужна,
 *             PDF сохраняется через системное меню «Поделиться», кнопка «Назад» закрывает окна;
 *   desktop — приложение для Windows (Electron): PDF сохраняется через окно «Сохранить как».
 *
 * Ссылка на расчёт и QR-код в PDF должны вести на опубликованный сайт. Из приложений адрес
 * сайта берётся из js/config.js (publicUrl); пока он пуст, ссылки и QR-кода в приложениях нет.
 */
(function () {
  'use strict';

  const config = window.FIRECALC_CONFIG || {};
  const cap = window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform() ? window.Capacitor : null;
  const desktop = window.firecalcDesktop || null; // задаётся в Electron (native/desktop/preload.js)
  const kind = cap ? 'android' : (desktop ? 'desktop' : 'web');
  const hosted = kind === 'web' && /^https?:$/.test(window.location.protocol);
  const ua = navigator.userAgent || '';
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  function standalone() {
    return kind !== 'web' || navigator.standalone === true ||
      !!(window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches));
  }

  // Адрес, на который ведёт ссылка на расчёт (и QR-код в PDF). Пусто — ссылки нет.
  function publicBase() {
    if (hosted) return window.location.href.split('#')[0].split('?')[0];
    const url = String(config.publicUrl || '').trim();
    return /^https:\/\/[^\s]+$/.test(url) ? url.replace(/\/?$/, '/') : '';
  }

  // ---------- Android: вызовы плагинов Capacitor без сборщика ----------
  function native(plugin, method, options) {
    return cap.nativePromise(plugin, method, options || {});
  }

  // Имя файла без знаков, которые не любят файловые системы и мессенджеры.
  function safeName(name) { return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_'); }

  // Сохранить или отправить файл. base64 — содержимое, mime — тип.
  // web: обычное скачивание;
  // desktop: системное окно «Сохранить как»; ответ { how: 'dialog', cancelled, path, open };
  // android: файл кладётся в память приложения и открывается меню «Поделиться».
  function saveFile(name, base64, mime) {
    name = safeName(name);
    if (desktop && typeof desktop.saveFile === 'function') {
      return desktop.saveFile(name, base64).then(function (r) {
        if (!r || !r.saved) return { how: 'dialog', cancelled: true };
        return { how: 'dialog', cancelled: false, path: r.path, open: typeof desktop.openFile === 'function' ? function () { desktop.openFile(r.path); } : null };
      });
    }
    if (cap) {
      return native('Filesystem', 'writeFile', { path: name, data: base64, directory: 'CACHE', recursive: true })
        .then(function (res) {
          return native('Share', 'share', { title: name, files: [res.uri], dialogTitle: name })
            .catch(function (e) {
              // пользователь закрыл меню — файл всё равно сохранён в памяти приложения
              if (e && /cancel/i.test(String(e.message || e))) return { cancelled: true };
              throw e;
            });
        })
        .then(function (r) { return { how: 'share', cancelled: !!(r && r.cancelled) }; });
    }
    return new Promise(function (resolve) {
      const bytes = atob(base64), buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([buf], { type: mime || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
      resolve({ how: 'download' });
    });
  }

  // PDF из pdfmake: на телефоне-приложении — через «Поделиться», в приложении для Windows — окном
  // «Сохранить как», на сайте — скачивание.
  function savePdf(pdf, name) {
    const viaFile = cap || (desktop && typeof desktop.saveFile === 'function');
    if (!viaFile) return new Promise(function (resolve) { pdf.download(name, function () { resolve({ how: 'download' }); }); });
    return new Promise(function (resolve, reject) {
      try { pdf.getBase64(function (b64) { saveFile(name, b64, 'application/pdf').then(resolve, reject); }); } catch (e) { reject(e); }
    });
  }

  // Отправить ссылку: в приложении для Android и на телефоне — системным меню, иначе — false (вызывающий копирует сам).
  function shareLink(title, url) {
    if (cap) return native('Share', 'share', { title: title, text: title, url: url, dialogTitle: title }).then(function () { return true; }, function () { return true; });
    if (touch && navigator.share) return navigator.share({ title: title, url: url }).then(function () { return true; }, function (e) { return !!(e && e.name === 'AbortError'); });
    return Promise.resolve(false);
  }

  // Кнопка «Назад» на Android: handler() возвращает true, если что-то закрыл; иначе приложение сворачивается.
  function onBack(handler) {
    if (!cap) return;
    try {
      cap.nativeCallback('App', 'addListener', { eventName: 'backButton' }, function () {
        if (!handler()) native('App', 'minimizeApp').catch(function () {});
      });
    } catch (e) { /* без плагина «Назад» работает как обычно */ }
  }

  // ---------- сайт: работа без сети и обновление ----------
  // onUpdate(apply) вызывается, когда новая версия скачана и ждёт; apply() перезапускает страницу с ней.
  function registerServiceWorker(onUpdate, onReady) {
    if (!hosted || !('serviceWorker' in navigator)) return;
    let asked = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (asked) window.location.reload(); });
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      function offer(worker) {
        onUpdate(function apply() { asked = true; worker.postMessage({ type: 'SKIP_WAITING' }); });
      }
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', function () {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      // вернулись в приложение — проверить, не вышла ли новая версия
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && navigator.onLine !== false) reg.update().catch(function () {});
      });
    }).catch(function () { /* без него приложение работает как обычный сайт */ });
    navigator.serviceWorker.ready.then(function () { if (onReady) onReady(); }).catch(function () {});
  }

  // ---------- установка на устройство ----------
  let deferred = null;
  const installWatchers = [];
  function tellInstall() { installWatchers.forEach(function (fn) { try { fn(); } catch (e) { /* не мешает остальным */ } }); }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; tellInstall(); });
  window.addEventListener('appinstalled', function () { deferred = null; tellInstall(); });
  function canInstall() { return !!deferred; }
  function install() {
    if (!deferred) return Promise.resolve(false);
    const d = deferred;
    deferred = null;
    tellInstall();
    d.prompt();
    return d.userChoice.then(function (c) { return !!c && c.outcome === 'accepted'; }, function () { return false; });
  }
  function onInstallChange(fn) { installWatchers.push(fn); }

  // Просьба к браузеру не удалять сохранённые объекты и картинки планов при нехватке места.
  function persist() {
    if (!(navigator.storage && navigator.storage.persist)) return Promise.resolve(false);
    return navigator.storage.persisted().then(function (p) { return p || navigator.storage.persist(); }).catch(function () { return false; });
  }
  function persisted() {
    if (!(navigator.storage && navigator.storage.persisted)) return Promise.resolve(false);
    return navigator.storage.persisted().catch(function () { return false; });
  }

  // ---------- картинка плана, переданная извне ----------
  // «Поделиться → Огнетушители» на Android (sw.js кладёт файл в кэш «firecalc-inbox») или
  // «Открыть с помощью» на компьютере (launchQueue). Вызывает fn(file) один раз на файл.
  function onIncomingPicture(fn) {
    const q = new URLSearchParams(window.location.search);
    if (q.get('inbox') === 'share' && window.caches) {
      window.caches.open('firecalc-inbox').then(function (c) {
        return c.match('inbox/plan').then(function (res) {
          if (!res) return null;
          const name = decodeURIComponent(res.headers.get('X-File-Name') || 'plan.jpg');
          return res.blob().then(function (b) { c.delete('inbox/plan'); return new File([b], name, { type: b.type || 'image/jpeg' }); });
        });
      }).then(function (file) { if (file) fn(file); }).catch(function () {});
    }
    if ('launchQueue' in window && window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
      window.launchQueue.setConsumer(function (params) {
        const h = params && params.files && params.files[0];
        if (h && h.getFile) h.getFile().then(fn).catch(function () {});
      });
    }
  }

  window.FirePlatform = {
    kind: kind, hosted: hosted, ios: ios, touch: touch, version: config.version || '',
    standalone: standalone, publicBase: publicBase,
    saveFile: saveFile, savePdf: savePdf, shareLink: shareLink, onBack: onBack,
    registerServiceWorker: registerServiceWorker,
    canInstall: canInstall, install: install, onInstallChange: onInstallChange,
    persist: persist, persisted: persisted, onIncomingPicture: onIncomingPicture
  };
}());
