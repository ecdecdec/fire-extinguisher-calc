/*
 * Стенд проверки распознавания планов (js/vision.js): синтетика и реальные планы.
 *
 * Запуск:
 *   node tools/bench-vision.js                  весь стенд (синтетика + реальные)
 *   node tools/bench-vision.js --synth          только синтетика
 *   node tools/bench-vision.js --real           только реальные планы
 *   node tools/bench-vision.js --only hollow    один вариант, вид или id плана
 *   node tools/bench-vision.js --by-area        синтетика в режиме площади (2 прохода)
 *   node tools/bench-vision.js --save-baseline  сохранить результат в bench/vision/baseline.json
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const V = require('../js/vision.js');
const Synth = require('./synth-plans.js');
const { readPng } = require('../tests/helpers.js');

const BENCH_DIR = path.join(__dirname, '..', 'bench', 'vision');
const OUT_DIR = path.join(BENCH_DIR, 'out');
const BENCH_OUT = path.join(OUT_DIR, 'bench.json');
const BASELINE_PATH = path.join(BENCH_DIR, 'baseline.json');

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 10000) / 10000; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// ---------- запуск распознавания, как runBp в js/app.js ----------

function recognize(rgba, w, h, hint) {
  const hnt = hint || {};
  const t0 = performance.now();
  if (hnt.scale > 0) {
    const out = V.findRooms(rgba, w, h, { scale: hnt.scale });
    return { scale: hnt.scale, out: out, passes: 1, ms: Math.round(performance.now() - t0) };
  }
  if (hnt.areaM2 > 0) {
    const first = V.findRooms(rgba, w, h, { areaM2: hnt.areaM2 });
    const s1 = V.scaleFromArea(first.rooms, hnt.areaM2);
    if (!(s1 > 0)) {
      return { scale: 0, out: first, passes: 1, ms: Math.round(performance.now() - t0) };
    }
    const out = V.findRooms(rgba, w, h, { scale: s1 });
    const scale = V.scaleFromArea(out.rooms, hnt.areaM2) || s1;
    return { scale: scale, out: out, passes: 2, ms: Math.round(performance.now() - t0) };
  }
  const out = V.findRooms(rgba, w, h, {});
  return { scale: 0, out: out, passes: 1, ms: Math.round(performance.now() - t0) };
}

// ---------- растеризация полигонов и сопоставление помещений ----------

// Построчная растеризация полигона по центрам пикселей (x + 0.5, y + 0.5).
// Возвращает компактный список отрезков [x0, x1) для каждой строки.
function rasterizePoly(poly, w, h) {
  if (!poly || poly.length < 3 || w <= 0 || h <= 0) {
    return { minX: 0, minY: 0, maxX: -1, maxY: -1, y0: 0, rows: [], px: 0 };
  }
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < poly.length; i++) {
    const x = poly[i][0], y = poly[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(h - 1, Math.ceil(maxY) - 1);
  if (yStart > yEnd || maxX <= 0 || minX >= w) {
    return { minX: 0, minY: 0, maxX: -1, maxY: -1, y0: 0, rows: [], px: 0 };
  }
  const rows = new Array(yEnd - yStart + 1);
  const xs = [];
  let px = 0;
  let rMinX = w, rMaxX = -1;
  const n = poly.length;
  for (let y = yStart; y <= yEnd; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ay = poly[i][1], by = poly[j][1];
      if ((ay > yc) !== (by > yc)) {
        const ax = poly[i][0], bx = poly[j][0];
        xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
      }
    }
    if (xs.length < 2) { rows[y - yStart] = null; continue; }
    xs.sort(function (a, b) { return a - b; });
    const spans = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let ix0 = Math.ceil(xs[k] - 0.5);
      let ix1 = Math.ceil(xs[k + 1] - 0.5);
      if (ix0 < 0) ix0 = 0;
      if (ix1 > w) ix1 = w;
      if (ix1 > ix0) {
        spans.push(ix0, ix1);
        px += ix1 - ix0;
        if (ix0 < rMinX) rMinX = ix0;
        if (ix1 > rMaxX) rMaxX = ix1;
      }
    }
    rows[y - yStart] = spans.length ? spans : null;
  }
  return { minX: rMinX, minY: yStart, maxX: rMaxX, maxY: yEnd, y0: yStart, rows: rows, px: px };
}

function intersectRasters(a, b) {
  if (!a.px || !b.px) return 0;
  if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY < b.minY || b.maxY < a.minY) return 0;
  const yStart = a.minY > b.minY ? a.minY : b.minY;
  const yEnd = a.maxY < b.maxY ? a.maxY : b.maxY;
  let inter = 0;
  for (let y = yStart; y <= yEnd; y++) {
    const ra = a.rows[y - a.y0], rb = b.rows[y - b.y0];
    if (!ra || !rb) continue;
    let ia = 0, ib = 0;
    while (ia < ra.length && ib < rb.length) {
      const a0 = ra[ia], a1 = ra[ia + 1], b0 = rb[ib], b1 = rb[ib + 1];
      const lo = a0 > b0 ? a0 : b0;
      const hi = a1 < b1 ? a1 : b1;
      if (hi > lo) inter += hi - lo;
      if (a1 < b1) ia += 2; else ib += 2;
    }
  }
  return inter;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Сопоставляет эталонные и найденные помещения по IoU >= 0.5, считает разрезы, слияния и ошибки площади.
function matchRooms(gtRooms, predRooms, w, h, scale) {
  const G = gtRooms.length, P = predRooms.length;
  const gtRast = gtRooms.map(function (r) { return rasterizePoly(r.poly, w, h); });
  const predRast = predRooms.map(function (r) { return rasterizePoly(r.poly, w, h); });

  const inter = new Int32Array(G * P);
  const candidates = [];
  for (let g = 0; g < G; g++) {
    const gr = gtRast[g];
    for (let p = 0; p < P; p++) {
      const ov = intersectRasters(gr, predRast[p]);
      if (!ov) continue;
      inter[g * P + p] = ov;
      const uni = gr.px + predRast[p].px - ov;
      const iou = uni > 0 ? ov / uni : 0;
      if (iou >= 0.5) candidates.push({ g: g, p: p, iou: iou });
    }
  }
  candidates.sort(function (a, b) { return (b.iou - a.iou) || (a.g - b.g) || (a.p - b.p); });

  const gtUsed = new Uint8Array(G), predUsed = new Uint8Array(P);
  const matches = [];
  const absErrsPct = [];
  let under10Count = 0;
  let iouSum = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (gtUsed[c.g] || predUsed[c.p]) continue;
    gtUsed[c.g] = 1;
    predUsed[c.p] = 1;
    const trueArea = gtRooms[c.g].area;
    const predArea = scale > 0 ? predRooms[c.p].px / (scale * scale) : 0;
    const rel = trueArea > 0 ? (predArea - trueArea) / trueArea : 0;
    const errPct = Math.abs(rel) * 100;
    const under10 = rel < -0.10;
    if (under10) under10Count += 1;
    absErrsPct.push(errPct);
    iouSum += c.iou;
    matches.push({
      g: c.g, p: c.p, iou: round4(c.iou),
      trueArea: round2(trueArea), predArea: round2(predArea),
      errPct: round2(errPct), under10: under10
    });
  }

  // Разрезы: эталонное помещение покрыто >= 2 найденными областями, каждая >= 20% его площади.
  let splits = 0;
  for (let g = 0; g < G; g++) {
    const gPx = gtRast[g].px;
    if (!gPx) continue;
    let parts = 0;
    for (let p = 0; p < P; p++) {
      if (inter[g * P + p] >= 0.20 * gPx) parts += 1;
    }
    if (parts >= 2) splits += 1;
  }

  // Слияния: найденная область покрывает >= 2 эталонных помещений (>= 20% каждого).
  let mergeEvents = 0;
  const mergedGtFlags = new Uint8Array(G);
  for (let p = 0; p < P; p++) {
    const covered = [];
    for (let g = 0; g < G; g++) {
      const gPx = gtRast[g].px;
      if (gPx && inter[g * P + p] >= 0.20 * gPx) covered.push(g);
    }
    if (covered.length >= 2) {
      mergeEvents += 1;
      for (let k = 0; k < covered.length; k++) mergedGtFlags[covered[k]] = 1;
    }
  }
  let merged = 0;
  for (let g = 0; g < G; g++) if (mergedGtFlags[g]) merged += 1;

  const tp = matches.length;
  const precision = P > 0 ? tp / P : (G === 0 ? 1 : 0);
  const recall = G > 0 ? tp / G : (P === 0 ? 1 : 0);
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return {
    gtCount: G,
    predCount: P,
    tp: tp,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    splits: splits,
    merged: merged,
    mergeEvents: mergeEvents,
    absErrsPct: absErrsPct,
    medErrPct: absErrsPct.length ? round2(percentile(absErrsPct, 0.5)) : null,
    p90ErrPct: absErrsPct.length ? round2(percentile(absErrsPct, 0.9)) : null,
    under10Count: under10Count,
    under10Share: tp > 0 ? round4(under10Count / tp) : null,
    meanIou: tp > 0 ? round4(iouSum / tp) : null,
    matches: matches
  };
}

// ---------- оценка реального плана из expect.json ----------

function evalRealPlan(rooms, w, h, entry) {
  const found = rooms.length;
  const expected = entry.rooms || 0;
  const range = Array.isArray(entry.roomsRange) && entry.roomsRange.length === 2
    ? [entry.roomsRange[0], entry.roomsRange[1]]
    : [expected, expected];
  const box = entry.box || entry.main_plan_box || [0, 0, 1, 1];
  const ex0 = (box[0] - 0.03) * w;
  const ey0 = (box[1] - 0.03) * h;
  const ex1 = (box[2] + 0.03) * w;
  const ey1 = (box[3] + 0.03) * h;
  let junk = 0;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (r.lx < ex0 || r.lx > ex1 || r.ly < ey0 || r.ly > ey1) junk += 1;
  }
  const validFound = found - junk;
  const inRange = validFound >= range[0] && validFound <= range[1];
  let countAcc = 0;
  if (validFound >= range[0] && validFound <= range[1]) countAcc = 1;
  else if (validFound < range[0]) countAcc = range[0] > 0 ? validFound / range[0] : 0;
  else countAcc = validFound > 0 ? range[1] / validFound : 0;
  const cleanFrac = found > 0 ? validFound / found : 0;
  const score = countAcc * cleanFrac;
  return {
    found: found,
    expected: expected,
    range: range,
    inRange: inRange,
    junk: junk,
    junkShare: found > 0 ? round4(junk / found) : 0,
    validFound: validFound,
    score: round4(score)
  };
}

// ---------- прогон синтетики и реального набора ----------

function runSynthetic(variants, seeds, byArea) {
  const byVariant = {};
  const details = [];
  let totGt = 0, totPred = 0, totTp = 0, totSplits = 0, totMerged = 0, totMergeEv = 0;
  let totUnder = 0, totMs = 0, totPlans = 0;
  const totErrs = [];
  let f1Sum = 0;

  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi];
    let vGt = 0, vPred = 0, vTp = 0, vSplits = 0, vMerged = 0, vMergeEv = 0;
    let vUnder = 0, vMs = 0;
    const vErrs = [];
    const seedRuns = [];

    for (let si = 0; si < seeds.length; si++) {
      const seed = seeds[si];
      const plan = Synth.make(variant, seed);
      const hint = byArea ? { areaM2: plan.meta.totalArea } : { scale: plan.scale };
      const res = recognize(plan.rgba, plan.w, plan.h, hint);
      const m = matchRooms(plan.rooms, res.out.rooms, plan.w, plan.h, res.scale);

      vGt += m.gtCount; vPred += m.predCount; vTp += m.tp;
      vSplits += m.splits; vMerged += m.merged; vMergeEv += m.mergeEvents;
      vUnder += m.under10Count; vMs += res.ms;
      for (let k = 0; k < m.absErrsPct.length; k++) {
        vErrs.push(m.absErrsPct[k]);
        totErrs.push(m.absErrsPct[k]);
      }
      seedRuns.push({
        seed: seed, w: plan.w, h: plan.h, scale: plan.scale, passes: res.passes, ms: res.ms,
        gtCount: m.gtCount, predCount: m.predCount, tp: m.tp,
        precision: m.precision, recall: m.recall, f1: m.f1,
        splits: m.splits, merged: m.merged, mergeEvents: m.mergeEvents,
        medErrPct: m.medErrPct, p90ErrPct: m.p90ErrPct,
        under10Count: m.under10Count, under10Share: m.under10Share
      });
    }

    const vP = vPred > 0 ? vTp / vPred : (vGt === 0 ? 1 : 0);
    const vR = vGt > 0 ? vTp / vGt : (vPred === 0 ? 1 : 0);
    const vF1 = (vP + vR) > 0 ? 2 * vP * vR / (vP + vR) : 0;
    const summary = {
      variant: variant,
      plans: seeds.length,
      gtCount: vGt,
      predCount: vPred,
      tp: vTp,
      precision: round4(vP),
      recall: round4(vR),
      f1: round4(vF1),
      splits: vSplits,
      merged: vMerged,
      mergeEvents: vMergeEv,
      medErrPct: vErrs.length ? round2(percentile(vErrs, 0.5)) : null,
      p90ErrPct: vErrs.length ? round2(percentile(vErrs, 0.9)) : null,
      under10Count: vUnder,
      under10Share: vTp > 0 ? round4(vUnder / vTp) : null,
      ms: Math.round(vMs / seeds.length)
    };
    byVariant[variant] = summary;
    details.push({ variant: variant, summary: summary, seeds: seedRuns });

    totGt += vGt; totPred += vPred; totTp += vTp;
    totSplits += vSplits; totMerged += vMerged; totMergeEv += vMergeEv;
    totUnder += vUnder; totMs += vMs; totPlans += seeds.length;
    f1Sum += vF1;
  }

  const tP = totPred > 0 ? totTp / totPred : 0;
  const tR = totGt > 0 ? totTp / totGt : 0;
  const tF1 = (tP + tR) > 0 ? 2 * tP * tR / (tP + tR) : 0;
  const macroF1 = variants.length > 0 ? f1Sum / variants.length : 0;

  return {
    mode: byArea ? 'areaM2' : 'scale',
    seeds: seeds,
    variants: byVariant,
    details: details,
    total: {
      variants: variants.length,
      plans: totPlans,
      gtCount: totGt,
      predCount: totPred,
      tp: totTp,
      precision: round4(tP),
      recall: round4(tR),
      f1: round4(tF1),
      macroF1: round4(macroF1),
      splits: totSplits,
      merged: totMerged,
      mergeEvents: totMergeEv,
      medErrPct: totErrs.length ? round2(percentile(totErrs, 0.5)) : null,
      p90ErrPct: totErrs.length ? round2(percentile(totErrs, 0.9)) : null,
      under10Count: totUnder,
      under10Share: totTp > 0 ? round4(totUnder / totTp) : null,
      ms: totPlans > 0 ? Math.round(totMs / totPlans) : 0
    }
  };
}

function runReal(onlySet) {
  const expect = readJson(path.join(BENCH_DIR, 'expect.json'), {});
  const ids = Object.keys(expect).filter(function (id) {
    const e = expect[id];
    if (!e || e.plan === false) return false;
    if (onlySet && onlySet.size > 0) {
      return onlySet.has(id) || (e.kind && onlySet.has(e.kind));
    }
    return true;
  });

  const plans = {};
  const byKind = {};
  let totPlans = 0, totInRange = 0, totFound = 0, totExpected = 0, totJunk = 0;
  let totScoreSum = 0, totMs = 0, missing = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const entry = expect[id];
    const imgPath = path.join(BENCH_DIR, 'img', id + '.png');
    if (!fs.existsSync(imgPath)) {
      missing += 1;
      continue;
    }
    const pic = readPng(imgPath);
    const res = recognize(pic.rgba, pic.w, pic.h, entry);
    const ev = evalRealPlan(res.out.rooms, pic.w, pic.h, entry);
    const kind = entry.kind || 'other';
    const rec = {
      id: id, kind: kind, w: pic.w, h: pic.h, passes: res.passes, ms: res.ms,
      found: ev.found, expected: ev.expected, range: ev.range, inRange: ev.inRange,
      junk: ev.junk, junkShare: ev.junkShare, validFound: ev.validFound, score: ev.score
    };
    plans[id] = rec;

    if (!byKind[kind]) {
      byKind[kind] = { kind: kind, plans: 0, inRange: 0, found: 0, expected: 0, junk: 0, scoreSum: 0, msSum: 0 };
    }
    const k = byKind[kind];
    k.plans += 1;
    if (ev.inRange) k.inRange += 1;
    k.found += ev.found;
    k.expected += ev.expected;
    k.junk += ev.junk;
    k.scoreSum += ev.score;
    k.msSum += res.ms;

    totPlans += 1;
    if (ev.inRange) totInRange += 1;
    totFound += ev.found;
    totExpected += ev.expected;
    totJunk += ev.junk;
    totScoreSum += ev.score;
    totMs += res.ms;
  }

  const kindsOut = {};
  Object.keys(byKind).sort().forEach(function (kind) {
    const k = byKind[kind];
    kindsOut[kind] = {
      kind: kind,
      plans: k.plans,
      inRange: k.inRange,
      inRangeShare: k.plans > 0 ? round4(k.inRange / k.plans) : 0,
      found: k.found,
      expected: k.expected,
      junk: k.junk,
      junkShare: k.found > 0 ? round4(k.junk / k.found) : 0,
      score: k.plans > 0 ? round4(k.scoreSum / k.plans) : 0,
      ms: k.plans > 0 ? Math.round(k.msSum / k.plans) : 0
    };
  });

  return {
    plans: plans,
    kinds: kindsOut,
    missing: missing,
    total: {
      plans: totPlans,
      inRange: totInRange,
      inRangeShare: totPlans > 0 ? round4(totInRange / totPlans) : 0,
      found: totFound,
      expected: totExpected,
      junk: totJunk,
      junkShare: totFound > 0 ? round4(totJunk / totFound) : 0,
      score: totPlans > 0 ? round4(totScoreSum / totPlans) : 0,
      ms: totPlans > 0 ? Math.round(totMs / totPlans) : 0
    }
  };
}

// ---------- форматирование таблиц и сравнение с baseline ----------

function padL(s, n) { const t = String(s); return t.length >= n ? t : ' '.repeat(n - t.length) + t; }
function padR(s, n) { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); }
function fmtPct(v) { return v === null || v === undefined ? '-' : (v * 100).toFixed(1) + '%'; }
function fmtNum(v, d) { return v === null || v === undefined ? '-' : Number(v).toFixed(d); }
function fmtDelta(cur, prev, mult, dec) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return '';
  const diff = (cur - prev) * (mult || 1);
  const d = dec === undefined ? 1 : dec;
  if (Math.abs(diff) < 0.5 * Math.pow(10, -d)) return ' (0)';
  return ' (' + (diff > 0 ? '+' : '') + diff.toFixed(d) + ')';
}

function printSynthTable(synth, baseSynth) {
  const hasBase = !!(baseSynth && baseSynth.variants);
  console.log('\n=== СИНТЕТИЧЕСКИЕ ПЛАНЫ (' + synth.total.variants + ' вариантов x ' + synth.seeds.length + ' сида, режим: ' + synth.mode + ') ===');
  const head = padR('variant', 15) + padL('gt', 4) + padL('pr', 4) + padL('P', 7) + padL('R', 7) + padL('F1', 7) +
    (hasBase ? padL('dF1', 8) : '') + padL('spl', 5) + padL('mrg', 5) + padL('med%', 7) + padL('p90%', 7) + padL('<-10%', 7) + padL('ms', 6);
  console.log(head);
  console.log('-'.repeat(head.length));

  Object.keys(synth.variants).forEach(function (name) {
    const r = synth.variants[name];
    const b = hasBase ? baseSynth.variants[name] : null;
    const dStr = hasBase ? (b ? fmtDelta(r.f1, b.f1, 100, 1) : '') : '';
    console.log(
      padR(name, 15) +
      padL(r.gtCount, 4) +
      padL(r.predCount, 4) +
      padL(fmtPct(r.precision), 7) +
      padL(fmtPct(r.recall), 7) +
      padL(fmtPct(r.f1), 7) +
      (hasBase ? padL(dStr.trim() || '-', 8) : '') +
      padL(r.splits, 5) +
      padL(r.merged, 5) +
      padL(fmtNum(r.medErrPct, 1), 7) +
      padL(fmtNum(r.p90ErrPct, 1), 7) +
      padL(fmtPct(r.under10Share), 7) +
      padL(r.ms, 6)
    );
  });

  console.log('-'.repeat(head.length));
  const t = synth.total;
  const vKeys = Object.keys(synth.variants);
  let baseMacro = null, baseMicro = null;
  if (hasBase && vKeys.length) {
    let bF1Sum = 0, bGt = 0, bPred = 0, bTp = 0, bSeen = 0;
    vKeys.forEach(function (name) {
      const b = baseSynth.variants[name];
      if (!b) return;
      bSeen += 1; bF1Sum += b.f1;
      bGt += b.gtCount; bPred += b.predCount; bTp += b.tp;
    });
    if (bSeen === vKeys.length) {
      baseMacro = bF1Sum / bSeen;
      const bp = bPred > 0 ? bTp / bPred : 0, br = bGt > 0 ? bTp / bGt : 0;
      baseMicro = (bp + br) > 0 ? 2 * bp * br / (bp + br) : 0;
    }
  }
  const dMacro = hasBase && baseMacro !== null ? fmtDelta(t.macroF1, baseMacro, 100, 1).trim() : '';
  console.log(
    padR('TOTAL (macro)', 15) +
    padL(t.gtCount, 4) +
    padL(t.predCount, 4) +
    padL(fmtPct(t.precision), 7) +
    padL(fmtPct(t.recall), 7) +
    padL(fmtPct(t.macroF1), 7) +
    (hasBase ? padL(dMacro || '-', 8) : '') +
    padL(t.splits, 5) +
    padL(t.merged, 5) +
    padL(fmtNum(t.medErrPct, 1), 7) +
    padL(fmtNum(t.p90ErrPct, 1), 7) +
    padL(fmtPct(t.under10Share), 7) +
    padL(t.ms, 6)
  );
  console.log('Micro F1: ' + fmtPct(t.f1) + (baseMicro !== null ? fmtDelta(t.f1, baseMicro, 100, 1) : '') +
    ' | Macro F1: ' + fmtPct(t.macroF1) + (baseMacro !== null ? fmtDelta(t.macroF1, baseMacro, 100, 1) : ''));
  return baseMacro;
}

function printRealTables(real, baseReal) {
  const hasBase = !!(baseReal && baseReal.plans);
  console.log('\n=== РЕАЛЬНЫЕ ПЛАНЫ (' + real.total.plans + ' планов' + (real.missing ? ', нет файлов: ' + real.missing : '') + ') ===');
  const head = padR('id', 28) + padR('kind', 23) + padL('fnd', 5) + padL('exp', 5) + padL('range', 12) +
    padL('ok', 4) + padL('junk', 5) + padL('score', 7) + (hasBase ? padL('dSc', 8) : '') + padL('ms', 6);
  console.log(head);
  console.log('-'.repeat(head.length));

  Object.keys(real.plans).forEach(function (id) {
    const r = real.plans[id];
    const b = hasBase ? baseReal.plans[id] : null;
    const rng = '[' + r.range[0] + '..' + r.range[1] + ']';
    const dSc = hasBase && b ? fmtDelta(r.score, b.score, 100, 1).trim() : '';
    console.log(
      padR(id, 28) +
      padR(r.kind, 23) +
      padL(r.found, 5) +
      padL(r.expected, 5) +
      padL(rng, 12) +
      padL(r.inRange ? 'yes' : 'no', 4) +
      padL(r.junk, 5) +
      padL(fmtPct(r.score), 7) +
      (hasBase ? padL(dSc || '-', 8) : '') +
      padL(r.ms, 6)
    );
  });

  console.log('\n--- Итого по видам реальных планов ---');
  const kh = padR('kind', 24) + padL('n', 4) + padL('inRng', 8) + padL('fnd/exp', 11) +
    padL('junk', 6) + padL('junk%', 7) + padL('score', 7) + (hasBase ? padL('dSc', 8) : '') + padL('ms', 6);
  console.log(kh);
  console.log('-'.repeat(kh.length));

  Object.keys(real.kinds).forEach(function (kind) {
    const k = real.kinds[kind];
    let bkScore = null;
    if (hasBase) {
      let sSum = 0, sN = 0;
      Object.keys(real.plans).forEach(function (id) {
        if (real.plans[id].kind === kind && baseReal.plans[id]) {
          sSum += baseReal.plans[id].score; sN += 1;
        }
      });
      if (sN === k.plans && sN > 0) bkScore = sSum / sN;
    }
    const dSc = hasBase && bkScore !== null ? fmtDelta(k.score, bkScore, 100, 1).trim() : '';
    console.log(
      padR(kind, 24) +
      padL(k.plans, 4) +
      padL(k.inRange + '/' + k.plans, 8) +
      padL(k.found + '/' + k.expected, 11) +
      padL(k.junk, 6) +
      padL(fmtPct(k.junkShare), 7) +
      padL(fmtPct(k.score), 7) +
      (hasBase ? padL(dSc || '-', 8) : '') +
      padL(k.ms, 6)
    );
  });

  console.log('-'.repeat(kh.length));
  const t = real.total;
  let baseRealScore = null;
  if (hasBase && t.plans > 0) {
    let sSum = 0, sN = 0;
    Object.keys(real.plans).forEach(function (id) {
      if (baseReal.plans[id]) { sSum += baseReal.plans[id].score; sN += 1; }
    });
    if (sN === t.plans) baseRealScore = sSum / sN;
  }
  const dTot = hasBase && baseRealScore !== null ? fmtDelta(t.score, baseRealScore, 100, 1).trim() : '';
  console.log(
    padR('TOTAL', 24) +
    padL(t.plans, 4) +
    padL(t.inRange + '/' + t.plans, 8) +
    padL(t.found + '/' + t.expected, 11) +
    padL(t.junk, 6) +
    padL(fmtPct(t.junkShare), 7) +
    padL(fmtPct(t.score), 7) +
    (hasBase ? padL(dTot || '-', 8) : '') +
    padL(t.ms, 6)
  );
  return baseRealScore;
}

// ---------- разбор аргументов командной строки ----------

function parseArgs(argv) {
  const args = { synth: false, real: false, only: [], saveBaseline: false, byArea: false, seedCount: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--synth') args.synth = true;
    else if (a === '--real') args.real = true;
    else if (a === '--save-baseline') args.saveBaseline = true;
    else if (a === '--by-area') args.byArea = true;
    else if (a === '--only' && i + 1 < argv.length) {
      argv[++i].split(',').forEach(function (item) {
        const t = item.trim();
        if (t) args.only.push(t);
      });
    } else if (a.indexOf('--only=') === 0) {
      a.slice(7).split(',').forEach(function (item) {
        const t = item.trim();
        if (t) args.only.push(t);
      });
    } else if (a === '--seeds' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (n > 0) args.seedCount = n;
    } else {
      throw new Error('Неизвестный аргумент: ' + a);
    }
  }
  return args;
}

function buildBaselinePayload(report) {
  // Компактный JSON для хранения в git (без подробных полигонов и массивов по каждому сиду).
  const out = {
    version: 1,
    overall: report.overall
  };
  if (report.synth) {
    out.synth = {
      mode: report.synth.mode,
      seeds: report.synth.seeds,
      variants: report.synth.variants,
      total: report.synth.total
    };
  }
  if (report.real) {
    out.real = {
      kinds: report.real.kinds,
      total: report.real.total,
      plans: report.real.plans
    };
  }
  return out;
}

function main() {
  const tStart = performance.now();
  const args = parseArgs(process.argv.slice(2));
  const expect = readJson(path.join(BENCH_DIR, 'expect.json'), {});
  const allRealIds = new Set(Object.keys(expect).filter(function (id) { return expect[id] && expect[id].plan !== false; }));
  const allRealKinds = new Set();
  allRealIds.forEach(function (id) { if (expect[id].kind) allRealKinds.add(expect[id].kind); });
  const allVariants = new Set(Synth.VARIANTS);

  let runS = args.synth;
  let runR = args.real;
  let synthVariants = Synth.VARIANTS.slice();
  let realFilter = null;

  if (args.only.length > 0 && args.saveBaseline) {
    console.error('--only вместе с --save-baseline не сохраняет базу: частичный прогон затёр бы полную. Уберите --only.');
    process.exit(1);
  }
  if (args.only.length > 0) {
    const matchedVariants = args.only.filter(function (x) { return allVariants.has(x); });
    const matchedReal = args.only.filter(function (x) { return allRealIds.has(x) || allRealKinds.has(x); });
    if (!matchedVariants.length && !matchedReal.length) {
      console.error('Не найдено в --only: ' + args.only.join(', '));
      console.error('Варианты синтетики: ' + Synth.VARIANTS.join(', '));
      console.error('Виды реальных планов: ' + Array.from(allRealKinds).sort().join(', '));
      process.exit(1);
    }
    if (!args.synth && !args.real) {
      runS = matchedVariants.length > 0;
      runR = matchedReal.length > 0;
    }
    if (runS) synthVariants = matchedVariants.length ? matchedVariants : [];
    if (runR) realFilter = matchedReal.length ? new Set(matchedReal) : new Set();
  } else if (!runS && !runR) {
    runS = true;
    runR = true;
  }

  const seeds = [];
  for (let s = 1; s <= args.seedCount; s++) seeds.push(s);

  const baseline = readJson(BASELINE_PATH, null);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    synth: null,
    real: null,
    overall: null
  };

  let baseSynthMacro = null, baseRealScore = null;
  if (runS && synthVariants.length > 0) {
    report.synth = runSynthetic(synthVariants, seeds, args.byArea);
    baseSynthMacro = printSynthTable(report.synth, baseline ? baseline.synth : null);
  }
  if (runR && (!realFilter || realFilter.size > 0)) {
    report.real = runReal(realFilter);
    baseRealScore = printRealTables(report.real, baseline ? baseline.real : null);
  }

  // Общий балл (0..100): 50% синтетика (macro F1) + 50% реальные планы (средний score).
  let overallScore = 0, baseOverallScore = null;
  if (report.synth && report.real) {
    overallScore = round2(50 * report.synth.total.macroF1 + 50 * report.real.total.score);
    if (baseSynthMacro !== null && baseRealScore !== null) {
      baseOverallScore = round2(50 * baseSynthMacro + 50 * baseRealScore);
    }
  } else if (report.synth) {
    overallScore = round2(100 * report.synth.total.macroF1);
    if (baseSynthMacro !== null) baseOverallScore = round2(100 * baseSynthMacro);
  } else if (report.real) {
    overallScore = round2(100 * report.real.total.score);
    if (baseRealScore !== null) baseOverallScore = round2(100 * baseRealScore);
  }
  const elapsedMs = Math.round(performance.now() - tStart);
  report.overall = {
    score: overallScore,
    synthMacroF1: report.synth ? report.synth.total.macroF1 : null,
    realScore: report.real ? report.real.total.score : null,
    elapsedMs: elapsedMs
  };

  console.log('\n=== ОБЩИЙ ИТОГ ===');
  if (report.synth) {
    console.log('Синтетика (macro F1): ' + fmtPct(report.synth.total.macroF1) +
      (baseSynthMacro !== null ? fmtDelta(report.synth.total.macroF1, baseSynthMacro, 100, 1) : '') +
      ' | занижение >10%: ' + fmtPct(report.synth.total.under10Share));
  }
  if (report.real) {
    console.log('Реальные (score):     ' + fmtPct(report.real.total.score) +
      (baseRealScore !== null ? fmtDelta(report.real.total.score, baseRealScore, 100, 1) : '') +
      ' | в диапазоне: ' + report.real.total.inRange + '/' + report.real.total.plans +
      ' (' + fmtPct(report.real.total.inRangeShare) + ') | мусор: ' +
      report.real.total.junk + ' (' + fmtPct(report.real.total.junkShare) + ')');
  }
  console.log('Общий балл:           ' + overallScore.toFixed(2) + ' / 100' +
    (baseOverallScore !== null ? fmtDelta(overallScore, baseOverallScore, 1, 2) : ''));
  console.log('Время прогона:        ' + (elapsedMs / 1000).toFixed(2) + ' с');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(BENCH_OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('Отчет: ' + BENCH_OUT);

  if (args.saveBaseline) {
    const payload = buildBaselinePayload(report);
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
    console.log('Базовый замер сохранен: ' + BASELINE_PATH);
  }
}

module.exports = {
  recognize: recognize,
  rasterizePoly: rasterizePoly,
  intersectRasters: intersectRasters,
  matchRooms: matchRooms,
  evalRealPlan: evalRealPlan,
  runSynthetic: runSynthetic,
  runReal: runReal
};

if (require.main === module) {
  main();
}
