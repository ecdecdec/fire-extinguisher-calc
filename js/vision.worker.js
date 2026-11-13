/*
 * Фоновый поток распознавания плана этажа: интерфейс не замирает, пока ищутся
 * помещения. Работает без сети: js/vision.js лежит в памяти приложения.
 * Сообщение: { id, w, h, buffer (RGBA), opts } → { id, ok, out | error }.
 */
importScripts('vision.js');

self.onmessage = function (e) {
  const d = e.data || {};
  try {
    const out = self.FireVision.findRooms(new Uint8ClampedArray(d.buffer), d.w, d.h, d.opts || {});
    self.postMessage({ id: d.id, ok: true, out: out });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
