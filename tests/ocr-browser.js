// Общая часть проверки чтения надписей в браузере: рисует синтетический план БТИ,
// читает площади и считает масштаб. Подключается страницей и фоновым потоком.
// Возвращает Promise с итогом; адреса файлов только свои (тот же сервер).
(function (root) {
  'use strict';
  root.ocrBrowserRun = function (origin) {
    const t0 = Date.now();
    const plan = root.FireSynthPlans.make('hollow', 1);
    const rooms = plan.rooms.map(function (r, i) { return { id: i + 1, poly: r.poly, px: r.area * plan.scale * plan.scale }; });
    return root.FireVisionOcr.readLabels(plan.rgba, plan.w, plan.h, rooms, {
      base: origin + '/vendor/tesseract/', guessPurpose: root.FirePresets.guessPurpose, timeoutMs: 55000
    }).then(function (labels) {
      const sc = root.FireVisionOcr.scaleFromLabels(rooms, labels);
      const okRead = labels.filter(function (l, i) { return l.area !== null && l.area.toFixed(1) === plan.rooms[i].area.toFixed(1); }).length;
      return {
        ms: Date.now() - t0, rooms: rooms.length, read: labels.filter(function (l) { return l.area !== null; }).length, okRead: okRead,
        scale: sc && sc.scale, trueScale: plan.scale, scaleErrPct: sc ? (sc.scale / plan.scale - 1) * 100 : null,
        inliers: sc && sc.inliers, info: root.FireVisionOcr.info(),
        areas: labels.map(function (l) { return l.area; })
      };
    }).then(function (res) { return root.FireVisionOcr.dispose().then(function () { return res; }); });
  };
}(typeof self !== 'undefined' ? self : this));
