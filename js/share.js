/*
 * Расчёт в ссылке: объект целиком упаковывается в адрес (#o=…). Такая ссылка
 * печатается QR-кодом в отчёте — камера любого телефона открывает по ней
 * тот же расчёт. Сервера нет: данные лежат в самой ссылке.
 *
 * pack / unpack — компактная запись объекта (массивы вместо имён полей);
 * encode / decode — сжатие (deflate, если браузер умеет) и base64url.
 * Помещения в упаковке адресуются номером в этаже, поэтому после unpack у них
 * временные id вида «s<этаж>_<номер>».
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FireShare = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const KINDS = ['public', 'industrial', 'warehouse'];
  const TYPES = ['op', 'ou', 'x'];
  const MAX_CODE = 12000; // знаков в ссылке; больше не читаем

  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : ''; }
  function numOrEmpty(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) && n >= 0 ? n : '';
  }
  function r3(v) { const n = Number(v); return isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000 : 0.5; }
  function r2(v) { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; }
  function splitKey(k) { const m = /^(.*):(\d+)$/.exec(String(k)); return m ? [m[1], parseInt(m[2], 10)] : null; }

  function pack(object) {
    const o = object || {};
    const b = o.building || {};
    return [VERSION,
      [str(b.name), str(b.address), str(b.owner), str(b.inspector), str(b.date, 10), Math.max(0, KINDS.indexOf(b.kind)), b.autoSuppressionAll ? 1 : 0],
      (o.floors || []).map(function (f) {
        const index = {};
        (f.rooms || []).forEach(function (r, i) { if (r.id) index[r.id] = i; });
        function ref(k) { const s = splitKey(k); return s && index[s[0]] !== undefined ? [index[s[0]], s[1]] : null; }
        const plan = f.plan || {};
        const ext = (plan.ext || []).map(function (e) {
          const k = ref(e.k);
          return k ? [k[0], k[1], r3(e.u), r3(e.v), Math.max(0, TYPES.indexOf(e.t)), str(e.code, 12)] : null;
        }).filter(Boolean);
        const pos = plan.pos ? Object.keys(plan.pos).map(function (key) {
          const k = ref(key);
          return k ? [k[0], k[1], r2(plan.pos[key][0]), r2(plan.pos[key][1])] : null;
        }).filter(Boolean) : 0;
        return [str(f.name), numOrEmpty(f.installedOP), numOrEmpty(f.installedOU),
          (f.rooms || []).map(function (r) {
            return [str(r.name), str(r.purpose, 24), numOrEmpty(r.area), numOrEmpty(r.count) || 1, str(r.category, 4), (r.classes || []).join(''),
              (r.sensitive ? 1 : 0) + (r.autoSuppression ? 2 : 0) + (r.t5Alt ? 4 : 0), numOrEmpty(r.length), numOrEmpty(r.width), str(r.forceType, 5)];
          }),
          plan.open ? 1 : 0, pos, ext];
      })];
  }

  // Данные из ссылки приходят извне — каждое поле проверяется.
  function unpack(data) {
    if (!Array.isArray(data) || data[0] !== VERSION || !Array.isArray(data[1]) || !Array.isArray(data[2])) throw new Error('неизвестный формат');
    const b = data[1];
    const building = {
      name: str(b[0]), address: str(b[1]), owner: str(b[2]), inspector: str(b[3]),
      date: /^\d{4}-\d{2}-\d{2}$/.test(b[4]) ? b[4] : '', kind: KINDS[b[5]] || 'public', autoSuppressionAll: !!b[6]
    };
    const floors = data[2].slice(0, 200).map(function (f, fi) {
      if (!Array.isArray(f)) throw new Error('неизвестный формат');
      const rooms = (Array.isArray(f[3]) ? f[3] : []).slice(0, 500).map(function (r, ri) {
        const a = Array.isArray(r) ? r : [];
        const flags = Number(a[6]) || 0;
        return {
          id: 's' + fi + '_' + ri, name: str(a[0]), purpose: str(a[1], 24) || 'custom', area: numOrEmpty(a[2]),
          count: Math.min(999, Math.max(1, Math.round(Number(a[3]) || 1))),
          category: /^(PUB|CA|CB|CV[1-4]|CG|CD)$/.test(a[4]) ? a[4] : 'PUB',
          classes: str(a[5], 5).split('').filter(function (k, i, all) { return 'ABCDE'.indexOf(k) >= 0 && all.indexOf(k) === i; }),
          sensitive: !!(flags & 1), autoSuppression: !!(flags & 2), t5Alt: flags & 4 ? 1 : 0,
          length: numOrEmpty(a[7]), width: numOrEmpty(a[8]), forceType: /^[A-Z][A-Z0-9]{1,4}$/.test(a[9]) ? a[9] : ''
        };
      });
      function key(i, copy) {
        const ri = Math.round(Number(i)), c = Math.round(Number(copy));
        return rooms[ri] && c >= 0 && c < rooms[ri].count ? rooms[ri].id + ':' + c : null;
      }
      const plan = { open: !!f[4], pos: null, ext: [] };
      if (Array.isArray(f[5])) {
        plan.pos = {};
        f[5].slice(0, 1000).forEach(function (p) { const k = Array.isArray(p) && key(p[0], p[1]); if (k) plan.pos[k] = [r2(p[2]), r2(p[3])]; });
      }
      (Array.isArray(f[6]) ? f[6] : []).slice(0, 1000).forEach(function (e) {
        const k = Array.isArray(e) && key(e[0], e[1]);
        if (k) plan.ext.push({ k: k, u: r3(e[2]), v: r3(e[3]), t: TYPES[e[4]] || 'x', code: str(e[5], 12) });
      });
      return { name: str(f[0]), installedOP: numOrEmpty(f[1]), installedOU: numOrEmpty(f[2]), rooms: rooms, plan: plan };
    });
    return { building: building, floors: floors };
  }

  // ---------- сжатие и запись в адрес ----------

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(text) {
    const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }
  function through(bytes, stream) {
    const w = stream.writable.getWriter();
    w.write(bytes).catch(function () {});
    w.close().catch(function () {});
    return new Response(stream.readable).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // Код объекта для ссылки: «z…» — сжатый, «j…» — без сжатия (старые браузеры).
  function encode(object) {
    const raw = new TextEncoder().encode(JSON.stringify(pack(object)));
    if (typeof CompressionStream !== 'function') return Promise.resolve('j' + toB64(raw));
    return through(raw, new CompressionStream('deflate-raw'))
      .then(function (z) { return 'z' + toB64(z); })
      .catch(function () { return 'j' + toB64(raw); });
  }

  function decode(code) {
    return Promise.resolve().then(function () {
      const text = String(code || '');
      if (text.length < 2 || text.length > MAX_CODE) throw new Error('ссылка повреждена');
      const bytes = fromB64(text.slice(1));
      if (text[0] === 'j') return bytes;
      if (text[0] === 'z' && typeof DecompressionStream === 'function') return through(bytes, new DecompressionStream('deflate-raw'));
      throw new Error('этот браузер не читает сжатые ссылки');
    }).then(function (raw) { return unpack(JSON.parse(new TextDecoder().decode(raw))); });
  }

  // Код объекта из адреса страницы (#o=…) или пустая строка.
  function codeFromHash(hash) {
    const m = /^#o=([A-Za-z0-9_-]+)$/.exec(String(hash || ''));
    return m ? m[1] : '';
  }

  return { pack: pack, unpack: unpack, encode: encode, decode: decode, codeFromHash: codeFromHash };
}));
