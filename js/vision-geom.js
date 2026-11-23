/*
 * Геометрия плана на снимке: поиск углов листа или рамки, выделение области
 * здания, оценка пропорций, гомография и выпрямление. Чистые функции над RGBA
 * без DOM: работают в браузере, в фоновом потоке (Web Worker) и в Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FireVisionGeom = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_OUT_SIDE = 1600;
  const WORK_SIDE = 440;
  const PLAN_SIDE = 360;

  // ---------- геометрия четырехугольника ----------

  function fullQuad(w, h) {
    return [[0, 0], [w, 0], [w, h], [0, h]];
  }

  function cross2(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  // Упорядочивает 4 угла по часовой стрелке: верхний-левый, верхний-правый, нижний-правый, нижний-левый.
  function orderQuad(pts) {
    let cx = 0, cy = 0;
    for (let i = 0; i < 4; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx *= 0.25; cy *= 0.25;
    const arr = pts.map(function (p) {
      return { p: [p[0], p[1]], a: Math.atan2(p[1] - cy, p[0] - cx) };
    });
    arr.sort(function (u, v) { return u.a - v.a; });
    let best = 0, bestSum = Infinity;
    for (let i = 0; i < 4; i++) {
      const s = arr[i].p[0] + arr[i].p[1];
      if (s < bestSum) { bestSum = s; best = i; }
    }
    const out = [];
    for (let i = 0; i < 4; i++) out.push(arr[(best + i) & 3].p);
    return out;
  }

  function quadArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) & 3];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) * 0.5;
  }

  // Проверяет выпуклость (по часовой стрелке в координатах картинки) и углы при вершинах.
  function validConvexQuad(q, maxAbsCos) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) & 3], b = q[i], c = q[(i + 1) & 3];
      const ux = a[0] - b[0], uy = a[1] - b[1];
      const vx = c[0] - b[0], vy = c[1] - b[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-6 || lv < 1e-6) return false;
      const cr = cross2(vx, vy, ux, uy);
      if (Math.abs(cr) < 1e-6) return false;
      if (!sign) sign = cr > 0 ? 1 : -1;
      else if ((cr > 0 ? 1 : -1) !== sign) return false;
      if (maxAbsCos !== undefined) {
        const cs = (ux * vx + uy * vy) / (lu * lv);
        if (Math.abs(cs) > maxAbsCos) return false;
      }
    }
    return true;
  }

  function intersectLines(a, b) {
    const det = a.nx * b.ny - a.ny * b.nx;
    if (Math.abs(det) < 1e-8) return null;
    return [
      (a.d * b.ny - a.ny * b.d) / det,
      (a.nx * b.d - a.d * b.nx) / det
    ];
  }

  // ---------- гомография (DLT с нормализацией Хартли) ----------

  function normTransform(pts) {
    let mx = 0, my = 0;
    for (let i = 0; i < 4; i++) { mx += pts[i][0]; my += pts[i][1]; }
    mx *= 0.25; my *= 0.25;
    let dist = 0;
    for (let i = 0; i < 4; i++) dist += Math.hypot(pts[i][0] - mx, pts[i][1] - my);
    dist *= 0.25;
    const s = dist > 1e-9 ? Math.SQRT2 / dist : 1;
    const out = new Array(4);
    for (let i = 0; i < 4; i++) out[i] = [(pts[i][0] - mx) * s, (pts[i][1] - my) * s];
    return { pts: out, s: s, mx: mx, my: my };
  }

  function mul3(A, B) {
    const C = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      const r3 = r * 3;
      for (let c = 0; c < 3; c++) {
        C[r3 + c] = A[r3] * B[c] + A[r3 + 1] * B[3 + c] + A[r3 + 2] * B[6 + c];
      }
    }
    return C;
  }

  // Гомография 3x3 (Float64Array из 9 чисел), переводящая src4 в dst4.
  function homography(src4, dst4) {
    if (!src4 || !dst4 || src4.length !== 4 || dst4.length !== 4) return null;
    const ns = normTransform(src4);
    const nd = normTransform(dst4);
    // Матрица 8x9 однородной системы A * h = 0.
    const M = new Float64Array(8 * 9);
    for (let i = 0; i < 4; i++) {
      const x = ns.pts[i][0], y = ns.pts[i][1];
      const u = nd.pts[i][0], v = nd.pts[i][1];
      const r0 = (i * 2) * 9, r1 = r0 + 9;
      M[r0] = x; M[r0 + 1] = y; M[r0 + 2] = 1;
      M[r0 + 6] = -u * x; M[r0 + 7] = -u * y; M[r0 + 8] = -u;
      M[r1 + 3] = x; M[r1 + 4] = y; M[r1 + 5] = 1;
      M[r1 + 6] = -v * x; M[r1 + 7] = -v * y; M[r1 + 8] = -v;
    }
    // Метод Гаусса с полным выбором ведущего элемента: устойчив даже при h8 = 0.
    const perm = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    for (let k = 0; k < 8; k++) {
      let pr = k, pc = k, best = 0;
      for (let r = k; r < 8; r++) {
        const ro = r * 9;
        for (let c = k; c < 9; c++) {
          const v = Math.abs(M[ro + c]);
          if (v > best) { best = v; pr = r; pc = c; }
        }
      }
      if (best < 1e-12) return null;
      if (pr !== k) {
        for (let c = k; c < 9; c++) {
          const t = M[k * 9 + c]; M[k * 9 + c] = M[pr * 9 + c]; M[pr * 9 + c] = t;
        }
      }
      if (pc !== k) {
        const tp = perm[k]; perm[k] = perm[pc]; perm[pc] = tp;
        for (let r = 0; r < 8; r++) {
          const t = M[r * 9 + k]; M[r * 9 + k] = M[r * 9 + pc]; M[r * 9 + pc] = t;
        }
      }
      const piv = M[k * 9 + k];
      for (let r = k + 1; r < 8; r++) {
        const f = M[r * 9 + k] / piv;
        if (!f) continue;
        M[r * 9 + k] = 0;
        for (let c = k + 1; c < 9; c++) M[r * 9 + c] -= f * M[k * 9 + c];
      }
    }
    const sol = new Float64Array(9);
    sol[8] = 1;
    for (let k = 7; k >= 0; k--) {
      let s = 0;
      for (let c = k + 1; c < 9; c++) s += M[k * 9 + c] * sol[c];
      sol[k] = -s / M[k * 9 + k];
    }
    const Hn = new Float64Array(9);
    for (let i = 0; i < 9; i++) Hn[perm[i]] = sol[i];
    // Проверяем невырожденность матрицы (3 точки на одной прямой дают det = 0).
    const detH = Hn[0] * (Hn[4] * Hn[8] - Hn[5] * Hn[7]) -
                 Hn[1] * (Hn[3] * Hn[8] - Hn[5] * Hn[6]) +
                 Hn[2] * (Hn[3] * Hn[7] - Hn[4] * Hn[6]);
    if (Math.abs(detH) < 1e-8) return null;

    const Ts = new Float64Array([ns.s, 0, -ns.s * ns.mx, 0, ns.s, -ns.s * ns.my, 0, 0, 1]);
    const invSd = 1 / nd.s;
    const TdInv = new Float64Array([invSd, 0, nd.mx, 0, invSd, nd.my, 0, 0, 1]);
    const H = mul3(TdInv, mul3(Hn, Ts));

    let norm = H[8];
    if (Math.abs(norm) < 1e-12) {
      norm = 0;
      for (let i = 0; i < 9; i++) if (Math.abs(H[i]) > Math.abs(norm)) norm = H[i];
      if (Math.abs(norm) < 1e-15) return null;
    }
    for (let i = 0; i < 9; i++) H[i] /= norm;
    return H;
  }

  function applyH(H, x, y) {
    let w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < 1e-15) w = w < 0 ? -1e-15 : 1e-15;
    return [
      (H[0] * x + H[1] * y + H[2]) / w,
      (H[3] * x + H[4] * y + H[5]) / w
    ];
  }

  // ---------- оценка пропорций и размера выпрямленной картинки ----------

  function det3(a, b, c) {
    return a[0] * (b[1] * c[2] - b[2] * c[1]) -
           a[1] * (b[0] * c[2] - b[2] * c[0]) +
           a[2] * (b[0] * c[1] - b[1] * c[0]);
  }

  // Оценка соотношения сторон прямоугольника по точкам схода (Чжан и Хэ, 2007).
  function estimateAspect(q, w, h) {
    const top = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const bot = Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]);
    const left = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
    const right = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    const avgW = 0.5 * (top + bot);
    const avgH = 0.5 * (left + right);
    const fallback = avgH > 1e-6 ? avgW / avgH : 1;

    const cx = w > 0 ? w * 0.5 : 0.25 * (q[0][0] + q[1][0] + q[2][0] + q[3][0]);
    const cy = h > 0 ? h * 0.5 : 0.25 * (q[0][1] + q[1][1] + q[2][1] + q[3][1]);
    const m1 = [q[0][0] - cx, q[0][1] - cy, 1];
    const m2 = [q[1][0] - cx, q[1][1] - cy, 1];
    const m3 = [q[3][0] - cx, q[3][1] - cy, 1]; // нижний-левый
    const m4 = [q[2][0] - cx, q[2][1] - cy, 1]; // нижний-правый

    const den = det3(m2, m3, m4);
    if (Math.abs(den) < 1e-6) return fallback;
    const k2 = det3(m1, m3, m4) / den;
    const k3 = det3(m2, m1, m4) / den;
    if (!(k2 > 0.1 && k2 < 10 && k3 > 0.1 && k3 < 10)) return fallback;

    const a2 = k2 * m2[0] - m1[0], b2 = k2 * m2[1] - m1[1], c2 = k2 - 1;
    const a3 = k3 * m3[0] - m1[0], b3 = k3 * m3[1] - m1[1], c3 = k3 - 1;
    const refSide = w > 0 && h > 0 ? Math.max(w, h) : Math.max(top, bot, left, right);
    const diag = w > 0 && h > 0 ? Math.hypot(w, h) : refSide * 1.25;

    let f2 = refSide * refSide;
    const c23 = c2 * c3;
    if (Math.abs(c2) > 0.015 && Math.abs(c3) > 0.015 && Math.abs(c23) > 1e-4) {
      const est = -(a2 * a3 + b2 * b3) / c23;
      if (est > 0.16 * diag * diag && est < 9.0 * diag * diag) f2 = est;
    }

    const num = a2 * a2 + b2 * b2 + c2 * c2 * f2;
    const d2 = a3 * a3 + b3 * b3 + c3 * c3 * f2;
    if (!(num > 0 && d2 > 0)) return fallback;
    const ar = Math.sqrt(num / d2);
    if (!(ar > 0.1 && ar < 10)) return fallback;
    return ar;
  }

  function rectifiedSize(quad, w, h) {
    const q = orderQuad(quad);
    const top = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const bot = Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]);
    const left = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
    const right = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    const baseW = Math.max(top, bot);
    const baseH = Math.max(left, right);
    if (baseW < 1 || baseH < 1) return { w: 1, h: 1 };

    let ar = estimateAspect(q, w, h);
    if (ar < 0.1) ar = 0.1;
    if (ar > 10) ar = 10;

    // Сохраняем плотность точек по ближнему краю без лишнего растяжения.
    let outW = Math.max(baseW, baseH * ar);
    let outH = outW / ar;
    const longSide = Math.max(outW, outH);
    if (longSide > MAX_OUT_SIDE) {
      const sc = MAX_OUT_SIDE / longSide;
      outW *= sc;
      outH *= sc;
    }
    return {
      w: Math.max(1, Math.min(MAX_OUT_SIDE, Math.round(outW))),
      h: Math.max(1, Math.min(MAX_OUT_SIDE, Math.round(outH)))
    };
  }

  // ---------- выпрямление (warp) ----------

  // Быстрое уменьшение в 2 раза с усреднением 2x2: при сильном сжатии тонкие линии сохраняются.
  function halfRgba(rgba, w, h) {
    const nw = w >> 1, nh = h >> 1;
    const out = new Uint8ClampedArray(nw * nh * 4);
    const stride = w * 4;
    for (let y = 0; y < nh; y++) {
      const r0 = (y * 2) * stride, r1 = r0 + stride;
      let dst = y * nw * 4;
      for (let x = 0; x < nw; x++) {
        const i0 = r0 + x * 8, i1 = r1 + x * 8;
        out[dst]     = (rgba[i0]     + rgba[i0 + 4] + rgba[i1]     + rgba[i1 + 4] + 2) >> 2;
        out[dst + 1] = (rgba[i0 + 1] + rgba[i0 + 5] + rgba[i1 + 1] + rgba[i1 + 5] + 2) >> 2;
        out[dst + 2] = (rgba[i0 + 2] + rgba[i0 + 6] + rgba[i1 + 2] + rgba[i1 + 6] + 2) >> 2;
        out[dst + 3] = (rgba[i0 + 3] + rgba[i0 + 7] + rgba[i1 + 3] + rgba[i1 + 7] + 2) >> 2;
        dst += 4;
      }
    }
    return { rgba: out, w: nw, h: nh };
  }

  function cornerScales(H, outW, outH) {
    const h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7], h8 = H[8];
    const pts = [[0.5, 0.5], [outW - 0.5, 0.5], [outW - 0.5, outH - 0.5], [0.5, outH - 0.5], [outW * 0.5, outH * 0.5]];
    let mn = Infinity, mx = 0;
    for (let i = 0; i < pts.length; i++) {
      const u = pts[i][0], v = pts[i][1];
      const den = h6 * u + h7 * v + h8;
      if (Math.abs(den) < 1e-12) continue;
      const inv = 1 / den;
      const sx = (h0 * u + h1 * v + h2) * inv;
      const sy = (h3 * u + h4 * v + h5) * inv;
      const du = Math.hypot((h0 - sx * h6) * inv, (h3 - sy * h6) * inv);
      const dv = Math.hypot((h1 - sx * h7) * inv, (h4 - sy * h7) * inv);
      const sMin = du < dv ? du : dv;
      const sMax = du > dv ? du : dv;
      if (sMin < mn) mn = sMin;
      if (sMax > mx) mx = sMax;
    }
    return { min: mn, max: mx };
  }

  function warp(rgba, w, h, quad, outW, outH) {
    outW = Math.max(1, outW | 0);
    outH = Math.max(1, outH | 0);
    let src = rgba, sw = w, sh = h;
    let q = [
      [quad[0][0], quad[0][1]],
      [quad[1][0], quad[1][1]],
      [quad[2][0], quad[2][1]],
      [quad[3][0], quad[3][1]]
    ];
    const dst4 = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
    let H = homography(dst4, q);
    if (!H) return new Uint8ClampedArray(outW * outH * 4).fill(255);

    // Если картинка сжимается в 2 и более раз по всей площади, сперва мягко усредняем исходник.
    let sc = cornerScales(H, outW, outH);
    while (sc.min >= 2.0 && sw >= 8 && sh >= 8) {
      const nxt = halfRgba(src, sw, sh);
      const sx = nxt.w / sw, sy = nxt.h / sh;
      src = nxt.rgba; sw = nxt.w; sh = nxt.h;
      for (let i = 0; i < 4; i++) { q[i][0] *= sx; q[i][1] *= sy; }
      H = homography(dst4, q);
      if (!H) break;
      sc = cornerScales(H, outW, outH);
    }

    const out = new Uint8ClampedArray(outW * outH * 4);
    const h0 = H[0], h1 = H[1], h2 = H[2];
    const h3 = H[3], h4 = H[4], h5 = H[5];
    const h6 = H[6], h7 = H[7], h8 = H[8];
    const wm1 = sw - 1, hm1 = sh - 1, stride = sw * 4;

    // Быстрый путь: без сильного сжатия достаточно одной билинейной выборки.
    if (sc.max <= 1.35) {
      let o = 0;
      for (let v = 0; v < outH; v++) {
        const vc = v + 0.5;
        let nx = h0 * 0.5 + h1 * vc + h2;
        let ny = h3 * 0.5 + h4 * vc + h5;
        let dn = h6 * 0.5 + h7 * vc + h8;
        for (let u = 0; u < outW; u++) {
          const inv = 1 / dn;
          let sx = nx * inv - 0.5;
          let sy = ny * inv - 0.5;
          nx += h0; ny += h3; dn += h6;
          if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) {
            out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
            o += 4; continue;
          }
          if (sx < 0) sx = 0; else if (sx > wm1) sx = wm1;
          if (sy < 0) sy = 0; else if (sy > hm1) sy = hm1;
          const x0 = sx | 0, y0 = sy | 0;
          const x1 = x0 < wm1 ? x0 + 1 : wm1;
          const y1 = y0 < hm1 ? y0 + 1 : hm1;
          const fx = sx - x0, fy = sy - y0;
          const ifx = 1 - fx, ify = 1 - fy;
          const w00 = ifx * ify, w10 = fx * ify, w01 = ifx * fy, w11 = fx * fy;
          const p00 = y0 * stride + x0 * 4;
          const p10 = y0 * stride + x1 * 4;
          const p01 = y1 * stride + x0 * 4;
          const p11 = y1 * stride + x1 * 4;
          out[o]     = src[p00]     * w00 + src[p10]     * w10 + src[p01]     * w01 + src[p11]     * w11 + 0.5;
          out[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11 + 0.5;
          out[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11 + 0.5;
          out[o + 3] = src[p00 + 3] * w00 + src[p10 + 3] * w10 + src[p01 + 3] * w01 + src[p11 + 3] * w11 + 0.5;
          o += 4;
        }
      }
      return out;
    }

    // Адаптивное сглаживание 2x2 (или 3x3 при очень сильном сжатии) на сжатых участках.
    const subN = sc.max > 2.7 ? 3 : 2;
    const offs = subN === 3 ? [-1 / 3, 0, 1 / 3] : [-0.25, 0.25];
    const invCount = 1 / (subN * subN);
    let o = 0;
    for (let v = 0; v < outH; v++) {
      const vc = v + 0.5;
      for (let u = 0; u < outW; u++) {
        const uc = u + 0.5;
        let rr = 0, gg = 0, bb = 0, aa = 0;
        for (let oy = 0; oy < subN; oy++) {
          const vv = vc + offs[oy];
          const bnx = h1 * vv + h2, bny = h4 * vv + h5, bdn = h7 * vv + h8;
          for (let ox = 0; ox < subN; ox++) {
            const uu = uc + offs[ox];
            const inv = 1 / (h6 * uu + bdn);
            let sx = (h0 * uu + bnx) * inv - 0.5;
            let sy = (h3 * uu + bny) * inv - 0.5;
            if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) {
              rr += 255; gg += 255; bb += 255; aa += 255;
              continue;
            }
            if (sx < 0) sx = 0; else if (sx > wm1) sx = wm1;
            if (sy < 0) sy = 0; else if (sy > hm1) sy = hm1;
            const x0 = sx | 0, y0 = sy | 0;
            const x1 = x0 < wm1 ? x0 + 1 : wm1;
            const y1 = y0 < hm1 ? y0 + 1 : hm1;
            const fx = sx - x0, fy = sy - y0;
            const ifx = 1 - fx, ify = 1 - fy;
            const w00 = ifx * ify, w10 = fx * ify, w01 = ifx * fy, w11 = fx * fy;
            const p00 = y0 * stride + x0 * 4;
            const p10 = y0 * stride + x1 * 4;
            const p01 = y1 * stride + x0 * 4;
            const p11 = y1 * stride + x1 * 4;
            rr += src[p00]     * w00 + src[p10]     * w10 + src[p01]     * w01 + src[p11]     * w11;
            gg += src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
            bb += src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
            aa += src[p00 + 3] * w00 + src[p10 + 3] * w10 + src[p01 + 3] * w01 + src[p11 + 3] * w11;
          }
        }
        out[o]     = rr * invCount + 0.5;
        out[o + 1] = gg * invCount + 0.5;
        out[o + 2] = bb * invCount + 0.5;
        out[o + 3] = aa * invCount + 0.5;
        o += 4;
      }
    }
    return out;
  }

  // ---------- уменьшение и градиенты для поиска углов ----------

  // Уменьшение с усреднением блока и сохранением самой темной точки (minL) для тонких рамок.
  function downscaleWork(rgba, w, h, maxSide) {
    const big = w > h ? w : h;
    const scale = big > maxSide ? maxSide / big : 1;
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    const n = dw * dh;
    const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
    const gray = new Uint8Array(n), minL = new Uint8Array(n);
    const stride = w * 4;
    if (dw === w && dh === h) {
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const rv = rgba[o], gv = rgba[o + 1], bv = rgba[o + 2];
        r[i] = rv; g[i] = gv; b[i] = bv;
        const l = (rv * 77 + gv * 150 + bv * 29) >> 8;
        gray[i] = l; minL[i] = l;
      }
      return { w: dw, h: dh, sx: 1, sy: 1, r: r, g: g, b: b, gray: gray, minL: minL };
    }
    const xs = new Int32Array(dw + 1), ys = new Int32Array(dh + 1);
    for (let dx = 0; dx <= dw; dx++) xs[dx] = Math.floor(dx * w / dw);
    for (let dy = 0; dy <= dh; dy++) ys[dy] = Math.floor(dy * h / dh);
    for (let dy = 0; dy < dh; dy++) {
      const y0 = ys[dy];
      const y1 = ys[dy + 1] > y0 ? ys[dy + 1] : Math.min(h, y0 + 1);
      const rowOff = dy * dw;
      for (let dx = 0; dx < dw; dx++) {
        const x0 = xs[dx];
        const x1 = xs[dx + 1] > x0 ? xs[dx + 1] : Math.min(w, x0 + 1);
        let sr = 0, sg = 0, sb = 0, cnt = 0, mn = 255;
        for (let y = y0; y < y1; y++) {
          let o = y * stride + x0 * 4;
          for (let x = x0; x < x1; x++, o += 4) {
            const rv = rgba[o], gv = rgba[o + 1], bv = rgba[o + 2];
            sr += rv; sg += gv; sb += bv; cnt += 1;
            const l = (rv * 77 + gv * 150 + bv * 29) >> 8;
            if (l < mn) mn = l;
          }
        }
        const idx = rowOff + dx;
        const rv = (sr / cnt + 0.5) | 0;
        const gv = (sg / cnt + 0.5) | 0;
        const bv = (sb / cnt + 0.5) | 0;
        r[idx] = rv; g[idx] = gv; b[idx] = bv;
        gray[idx] = (rv * 77 + gv * 150 + bv * 29) >> 8;
        minL[idx] = mn;
      }
    }
    return { w: dw, h: dh, sx: dw / w, sy: dh / h, r: r, g: g, b: b, gray: gray, minL: minL };
  }

  // Разделимый фильтр Гаусса [1, 4, 6, 4, 1] / 16.
  function blur5(src, w, h, tmp, dst) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const xm2 = x > 1 ? x - 2 : 0, xm1 = x > 0 ? x - 1 : 0;
        const xp1 = x + 1 < w ? x + 1 : w - 1, xp2 = x + 2 < w ? x + 2 : w - 1;
        tmp[o + x] = (src[o + xm2] + (src[o + xm1] << 2) + src[o + x] * 6 + (src[o + xp1] << 2) + src[o + xp2] + 8) >> 4;
      }
    }
    for (let y = 0; y < h; y++) {
      const ym2 = (y > 1 ? y - 2 : 0) * w, ym1 = (y > 0 ? y - 1 : 0) * w;
      const y0 = y * w;
      const yp1 = (y + 1 < h ? y + 1 : h - 1) * w, yp2 = (y + 2 < h ? y + 2 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        dst[y0 + x] = (tmp[ym2 + x] + (tmp[ym1 + x] << 2) + tmp[y0 + x] * 6 + (tmp[yp1 + x] << 2) + tmp[yp2 + x] + 8) >> 4;
      }
    }
  }

  // Цветной градиент Собеля по самому контрастному каналу + подавление немаксимумов.
  function computeEdges(work) {
    const w = work.w, h = work.h, n = w * h;
    const tmp = new Uint8Array(n);
    const br = new Uint8Array(n), bg = new Uint8Array(n), bb = new Uint8Array(n);
    blur5(work.r, w, h, tmp, br);
    blur5(work.g, w, h, tmp, bg);
    blur5(work.b, w, h, tmp, bb);

    const gx = new Int16Array(n), gy = new Int16Array(n);
    const mag = new Uint16Array(n);
    const hist = new Int32Array(1449);

    for (let y = 1; y < h - 1; y++) {
      const ym = (y - 1) * w, y0 = y * w, yp = (y + 1) * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = y0 + x;
        const rGx = -br[ym + x - 1] + br[ym + x + 1] - (br[y0 + x - 1] << 1) + (br[y0 + x + 1] << 1) - br[yp + x - 1] + br[yp + x + 1];
        const rGy = -br[ym + x - 1] - (br[ym + x] << 1) - br[ym + x + 1] + br[yp + x - 1] + (br[yp + x] << 1) + br[yp + x + 1];
        const gGx = -bg[ym + x - 1] + bg[ym + x + 1] - (bg[y0 + x - 1] << 1) + (bg[y0 + x + 1] << 1) - bg[yp + x - 1] + bg[yp + x + 1];
        const gGy = -bg[ym + x - 1] - (bg[ym + x] << 1) - bg[ym + x + 1] + bg[yp + x - 1] + (bg[yp + x] << 1) + bg[yp + x + 1];
        const bGx = -bb[ym + x - 1] + bb[ym + x + 1] - (bb[y0 + x - 1] << 1) + (bb[y0 + x + 1] << 1) - bb[yp + x - 1] + bb[yp + x + 1];
        const bGy = -bb[ym + x - 1] - (bb[ym + x] << 1) - bb[ym + x + 1] + bb[yp + x - 1] + (bb[yp + x] << 1) + bb[yp + x + 1];

        const rm = rGx * rGx + rGy * rGy;
        const gm = gGx * gGx + gGy * gGy;
        const bm = bGx * bGx + bGy * bGy;
        let cx = rGx, cy = rGy, cm = rm;
        if (gm > cm) { cx = gGx; cy = gGy; cm = gm; }
        if (bm > cm) { cx = bGx; cy = bGy; cm = bm; }

        gx[idx] = cx;
        gy[idx] = cy;
        const m = Math.sqrt(cm) + 0.5 | 0;
        mag[idx] = m;
        hist[m < 1448 ? m : 1448] += 1;
      }
    }

    // Адаптивный порог по 80-му и 91-му перцентилям градиента.
    const total = (w - 2) * (h - 2);
    let acc = 0, p80 = 24, p91 = 55;
    for (let m = 0; m < 1449; m++) {
      acc += hist[m];
      if (acc < total * 0.80) p80 = m;
      if (acc < total * 0.91) p91 = m;
    }
    const tLow = Math.max(15, Math.min(72, p80));
    const tHigh = Math.max(26, Math.min(120, p91));

    // Подавление немаксимумов вдоль направления градиента.
    const nms = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) {
      const y0 = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = y0 + x, m = mag[idx];
        if (m < tLow) continue;
        const vx = gx[idx], vy = gy[idx];
        const ax = vx < 0 ? -vx : vx, ay = vy < 0 ? -vy : vy;
        let m1, m2;
        if (ax * 2.4142 < ay) {
          m1 = mag[idx - w]; m2 = mag[idx + w];
        } else if (ay * 2.4142 < ax) {
          m1 = mag[idx - 1]; m2 = mag[idx + 1];
        } else if ((vx > 0) === (vy > 0)) {
          m1 = mag[idx - w - 1]; m2 = mag[idx + w + 1];
        } else {
          m1 = mag[idx - w + 1]; m2 = mag[idx + w - 1];
        }
        if (m >= m1 && m >= m2) nms[idx] = m >= tHigh ? 2 : 1;
      }
    }
    return { br: br, bg: bg, bb: bb, gx: gx, gy: gy, mag: mag, nms: nms, tLow: tLow, tHigh: tHigh };
  }

  // ---------- поиск отрезков прямых ----------

  // Подгонка прямой методом ортогональной регрессии по взвешенным точкам.
  function fitLine(pts, wts, start, end) {
    let sw = 0, mx = 0, my = 0;
    for (let i = start; i < end; i++) {
      const wi = wts[i];
      sw += wi;
      mx += wi * pts[i * 2];
      my += wi * pts[i * 2 + 1];
    }
    if (sw <= 0) return null;
    mx /= sw; my /= sw;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = start; i < end; i++) {
      const wi = wts[i], dx = pts[i * 2] - mx, dy = pts[i * 2 + 1] - my;
      sxx += wi * dx * dx;
      sxy += wi * dx * dy;
      syy += wi * dy * dy;
    }
    // Собственный вектор с меньшим собственным значением -> нормаль.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // Касательная (cos, sin), нормаль (-sin, cos).
    const tx = Math.cos(theta), ty = Math.sin(theta);
    let nx = -ty, ny = tx;
    let tMin = Infinity, tMax = -Infinity;
    for (let i = start; i < end; i++) {
      const t = (pts[i * 2] - mx) * tx + (pts[i * 2 + 1] - my) * ty;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    const len = tMax - tMin;
    const x1 = mx + tMin * tx, y1 = my + tMin * ty;
    const x2 = mx + tMax * tx, y2 = my + tMax * ty;
    const d = nx * mx + ny * my;
    return {
      nx: nx, ny: ny, d: d, tx: tx, ty: ty,
      x1: x1, y1: y1, x2: x2, y2: y2,
      mx: 0.5 * (x1 + x2), my: 0.5 * (y1 + y2),
      len: len, weight: sw, avgMag: sw / (end - start)
    };
  }

  function extractSegments(edges, w, h) {
    const n = w * h, nms = edges.nms, gx = edges.gx, gy = edges.gy, mag = edges.mag;
    const vis = new Uint8Array(n);
    const minLen = Math.max(14, Math.round(Math.min(w, h) * 0.065));
    const segments = [];
    const queue = new Int32Array(2048);
    const pts = new Float32Array(4096);
    const wts = new Float32Array(2048);

    // Сортируем сильные краевые точки по убыванию градиента (подсчетом по корзинам).
    const buckets = new Int32Array(256);
    let strongCount = 0;
    for (let i = 0; i < n; i++) {
      if (nms[i] === 2) {
        const b = mag[i] >> 3;
        buckets[b < 255 ? b : 255] += 1;
        strongCount += 1;
      }
    }
    const order = new Int32Array(strongCount);
    const offs = new Int32Array(256);
    let acc = 0;
    for (let b = 255; b >= 0; b--) { offs[b] = acc; acc += buckets[b]; }
    for (let i = 0; i < n; i++) {
      if (nms[i] === 2) {
        const b = mag[i] >> 3;
        const bk = b < 255 ? b : 255;
        order[offs[bk]++] = i;
      }
    }

    const COS_MIN = 0.91; // около 24 градусов
    for (let k = 0; k < strongCount; k++) {
      const seed = order[k];
      if (vis[seed]) continue;
      // Выращиваем связную область согласованного градиента (как в LSD).
      let qh = 0, qt = 0, pCount = 0;
      vis[seed] = 1;
      queue[qt++] = seed;
      let sumGx = gx[seed], sumGy = gy[seed];
      let regLen = Math.hypot(sumGx, sumGy);
      if (regLen < 1) continue;

      while (qh < qt && pCount < 2000) {
        const idx = queue[qh++];
        const x = idx % w, y = (idx - x) / w;
        pts[pCount * 2] = x;
        pts[pCount * 2 + 1] = y;
        wts[pCount] = mag[idx];
        pCount += 1;

        const rnx = sumGx / regLen, rny = sumGy / regLen;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 1 || ny >= h - 1) continue;
          const ro = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            if (nx < 1 || nx >= w - 1) continue;
            const j = ro + nx;
            if (vis[j] || !nms[j]) continue;
            const mj = mag[j];
            const dot = gx[j] * rnx + gy[j] * rny;
            if (dot > COS_MIN * mj) {
              vis[j] = 1;
              if (qt < queue.length) queue[qt++] = j;
              sumGx += gx[j]; sumGy += gy[j];
              regLen = Math.hypot(sumGx, sumGy);
            }
          }
        }
      }

      if (pCount < minLen * 0.7) continue;
      const seg = fitLine(pts, wts, 0, pCount);
      if (!seg || seg.len < minLen) continue;
      // Согласуем знак нормали со средним градиентом региона.
      if (seg.nx * sumGx + seg.ny * sumGy < 0) {
        seg.nx = -seg.nx; seg.ny = -seg.ny; seg.d = -seg.d;
      }
      // Проверяем прямолинейность: доля точек в пределах 2.2 px от прямой.
      let inl = 0;
      for (let i = 0; i < pCount; i++) {
        const err = Math.abs(seg.nx * pts[i * 2] + seg.ny * pts[i * 2 + 1] - seg.d);
        if (err <= 2.2) inl += 1;
      }
      if (inl < pCount * 0.72) continue;
      seg.support = pCount;
      segments.push(seg);
    }
    return segments;
  }

  // Объединяет коллинеарные отрезки в длинные прямые (мосты через блики и пересечения).
  function mergeCollinear(segments, w, h) {
    const diag = Math.hypot(w, h);
    const maxDist = Math.max(3.0, diag * 0.0085);
    const maxGap = diag * 0.35;
    const minCos = 0.992; // около 7 градусов
    const list = segments.slice().sort(function (a, b) { return b.len - a.len; });
    const merged = [];

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let target = null;
      for (let j = 0; j < merged.length; j++) {
        const m = merged[j];
        const dot = m.nx * s.nx + m.ny * s.ny;
        // Склеиваем только отрезки одной полярности (внешний край листа не смешивается с внутренним).
        if (dot < minCos) continue;
        const d1 = Math.abs(m.nx * s.x1 + m.ny * s.y1 - m.d);
        const d2 = Math.abs(m.nx * s.x2 + m.ny * s.y2 - m.d);
        if (d1 > maxDist || d2 > maxDist) continue;
        // Проверяем разрыв вдоль прямой.
        const tA1 = m.tx * m.x1 + m.ty * m.y1, tA2 = m.tx * m.x2 + m.ty * m.y2;
        const aLo = tA1 < tA2 ? tA1 : tA2, aHi = tA1 < tA2 ? tA2 : tA1;
        const tB1 = m.tx * s.x1 + m.ty * s.y1, tB2 = m.tx * s.x2 + m.ty * s.y2;
        const bLo = tB1 < tB2 ? tB1 : tB2, bHi = tB1 < tB2 ? tB2 : tB1;
        const gap = Math.max(aLo, bLo) - Math.min(aHi, bHi);
        if (gap <= maxGap) { target = m; break; }
      }
      if (!target) {
        merged.push({
          nx: s.nx, ny: s.ny, d: s.d, tx: s.tx, ty: s.ty,
          x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
          mx: s.mx, my: s.my, len: s.len, coverLen: s.len,
          weight: s.weight, avgMag: s.avgMag,
          spans: [[s.tx * s.x1 + s.ty * s.y1, s.tx * s.x2 + s.ty * s.y2]]
        });
      } else {
        // Обновляем прямую как средневзвешенную по двум парам концов.
        const pts = new Float32Array([
          target.x1, target.y1, target.x2, target.y2,
          s.x1, s.y1, s.x2, s.y2
        ]);
        const wt1 = target.weight, wt2 = s.weight;
        const wts = new Float32Array([wt1 * 0.5, wt1 * 0.5, wt2 * 0.5, wt2 * 0.5]);
        const nf = fitLine(pts, wts, 0, 4);
        if (nf) {
          if (nf.nx * target.nx + nf.ny * target.ny < 0) {
            nf.nx = -nf.nx; nf.ny = -nf.ny; nf.d = -nf.d;
          }
          target.nx = nf.nx; target.ny = nf.ny; target.d = nf.d;
          target.tx = -nf.ny; target.ty = nf.nx;
          target.x1 = nf.x1; target.y1 = nf.y1; target.x2 = nf.x2; target.y2 = nf.y2;
          target.mx = nf.mx; target.my = nf.my; target.len = nf.len;
          target.coverLen += s.len;
          target.weight += s.weight;
          target.avgMag = (target.avgMag * wt1 + s.avgMag * wt2) / (wt1 + wt2);
        }
      }
    }
    return merged;
  }

  // ---------- кандидаты из контуров/областей ----------

  function convexHull(pts) {
    if (pts.length <= 3) return pts.slice();
    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    const lo = [], hi = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      while (lo.length >= 2) {
        const a = lo[lo.length - 2], b = lo[lo.length - 1];
        if (cross2(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]) <= 0) lo.pop();
        else break;
      }
      lo.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (hi.length >= 2) {
        const a = hi[hi.length - 2], b = hi[hi.length - 1];
        if (cross2(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]) <= 0) hi.pop();
        else break;
      }
      hi.push(p);
    }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  }

  // Сжимает выпуклую оболочку до 4 вершин, поочередно убирая вершину с наименьшим треугольником.
  function hullToQuad(hull) {
    if (hull.length < 4) return null;
    const p = hull.slice();
    while (p.length > 4) {
      let bestIdx = 0, bestArea = Infinity;
      const m = p.length;
      for (let i = 0; i < m; i++) {
        const a = p[(i + m - 1) % m], b = p[i], c = p[(i + 1) % m];
        const area = Math.abs(cross2(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]));
        if (area < bestArea) { bestArea = area; bestIdx = i; }
      }
      p.splice(bestIdx, 1);
    }
    return orderQuad(p);
  }

  function otsuThreshold(arr) {
    const hist = new Int32Array(256);
    const n = arr.length;
    for (let i = 0; i < n; i++) hist[arr[i]] += 1;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = -1, th = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = t; }
    }
    return th;
  }

  // Находит крупнейшую область в маске (не заполняющую всю картинку) и строит по ней четырехугольник.
  function quadFromMask(mask, w, h) {
    const n = w * h;
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    let bestId = 0, bestCount = 0;
    const minArea = n * 0.06, maxArea = n * 0.94;
    let curId = 0;

    for (let s = 0; s < n; s++) {
      if (!mask[s] || labels[s]) continue;
      curId += 1;
      let top = 0, cnt = 0, touchT = 0, touchB = 0, touchL = 0, touchR = 0;
      stack[top++] = s;
      labels[s] = curId;
      while (top) {
        const i = stack[--top];
        const x = i % w, y = (i - x) / w;
        cnt += 1;
        if (y === 0) touchT = 1;
        if (y === h - 1) touchB = 1;
        if (x === 0) touchL = 1;
        if (x === w - 1) touchR = 1;
        if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = curId; stack[top++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = curId; stack[top++] = i + 1; }
        if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = curId; stack[top++] = i - w; }
        if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = curId; stack[top++] = i + w; }
      }
      if (cnt >= minArea && cnt <= maxArea && (touchT + touchB + touchL + touchR) <= 2 && cnt > bestCount) {
        bestCount = cnt;
        bestId = curId;
      }
    }
    if (!bestId) return null;

    // Собираем крайние точки по строкам: их выпуклая оболочка совпадает с оболочкой всей области.
    const pts = [];
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let xMin = -1, xMax = -1;
      for (let x = 0; x < w; x++) {
        if (labels[o + x] === bestId) {
          if (xMin < 0) xMin = x;
          xMax = x;
        }
      }
      if (xMin >= 0) {
        pts.push([xMin, y]);
        if (xMax !== xMin) pts.push([xMax, y]);
      }
    }
    const hull = convexHull(pts);
    const q = hullToQuad(hull);
    if (!q || !validConvexQuad(q, 0.72)) return null;
    const qa = quadArea(q);
    if (qa < minArea || bestCount / qa < 0.72) return null;
    return q;
  }

  function regionProposals(work, edges) {
    const w = work.w, h = work.h, n = w * h;
    const out = [];
    const br = edges.br, bg = edges.bg, bb = edges.bb;

    // 1. Расстояние от медианного цвета рамки кадра (стена, стол, дверь).
    const bR = [], bG = [], bB = [];
    const stepX = Math.max(1, (w / 40) | 0), stepY = Math.max(1, (h / 40) | 0);
    for (let x = 0; x < w; x += stepX) {
      bR.push(br[x], br[(h - 1) * w + x]);
      bG.push(bg[x], bg[(h - 1) * w + x]);
      bB.push(bb[x], bb[(h - 1) * w + x]);
    }
    for (let y = 0; y < h; y += stepY) {
      bR.push(br[y * w], br[y * w + w - 1]);
      bG.push(bg[y * w], bg[y * w + w - 1]);
      bB.push(bb[y * w], bb[y * w + w - 1]);
    }
    bR.sort(function (a, b) { return a - b; });
    bG.sort(function (a, b) { return a - b; });
    bB.sort(function (a, b) { return a - b; });
    const mid = bR.length >> 1;
    const mr = bR[mid], mg = bG[mid], mb = bB[mid];

    const dist = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const dr = br[i] - mr, dg = bg[i] - mg, db = bb[i] - mb;
      const d = Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
      dist[i] = d > 255 ? 255 : d;
    }
    const thD = Math.max(22, otsuThreshold(dist));
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (dist[i] >= thD) mask[i] = 1;
    const q1 = quadFromMask(mask, w, h);
    if (q1) out.push(q1);

    // 2. Яркий лист на темном фоне и темная табличка на светлом фоне (по Оцу).
    const thL = otsuThreshold(work.gray);
    mask.fill(0);
    for (let i = 0; i < n; i++) if (work.gray[i] >= thL) mask[i] = 1;
    const q2 = quadFromMask(mask, w, h);
    if (q2) out.push(q2);

    mask.fill(0);
    for (let i = 0; i < n; i++) if (work.gray[i] < thL) mask[i] = 1;
    const q3 = quadFromMask(mask, w, h);
    if (q3) out.push(q3);

    return out;
  }

  // ---------- поиск печатной рамки листа на скане (проекции по minL) ----------

  function frameProposals(work) {
    const w = work.w, h = work.h, minL = work.minL, gray = work.gray;
    // Оцениваем яркость бумаги по 75-му перцентилю яркости.
    const hist = new Int32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;
    let acc = 0, paperL = 240;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= gray.length * 0.75) { paperL = v; break; }
    }
    if (paperL < 140) return [];
    const darkTh = Math.min(175, paperL - 45);

    const maxY = Math.min(h >> 2, Math.max(8, Math.round(h * 0.22)));
    const maxX = Math.min(w >> 2, Math.max(8, Math.round(w * 0.22)));

    function rowDarkFrac(y, x0, x1) {
      let c = 0;
      const yA = y > 0 ? y - 1 : 0, yB = y + 1 < h ? y + 1 : h - 1;
      const yA2 = y > 1 ? y - 2 : 0, yB2 = y + 2 < h ? y + 2 : h - 1;
      for (let x = x0; x <= x1; x++) {
        if (minL[y * w + x] < darkTh || minL[yA * w + x] < darkTh || minL[yB * w + x] < darkTh ||
            minL[yA2 * w + x] < darkTh || minL[yB2 * w + x] < darkTh) c += 1;
      }
      return c / Math.max(1, x1 - x0 + 1);
    }

    function colDarkFrac(x, y0, y1) {
      let c = 0;
      const xA = x > 0 ? x - 1 : 0, xB = x + 1 < w ? x + 1 : w - 1;
      const xA2 = x > 1 ? x - 2 : 0, xB2 = x + 2 < w ? x + 2 : w - 1;
      for (let y = y0; y <= y1; y++) {
        const ro = y * w;
        if (minL[ro + x] < darkTh || minL[ro + xA] < darkTh || minL[ro + xB] < darkTh ||
            minL[ro + xA2] < darkTh || minL[ro + xB2] < darkTh) c += 1;
      }
      return c / Math.max(1, y1 - y0 + 1);
    }

    // Ищем пики темных горизонтальных и вертикальных линий у краев картинки.
    function findEdgePeaks(limit, isHoriz, fromEnd) {
      const peaks = [];
      const vals = new Float32Array(limit + 1);
      for (let k = 0; k < limit; k++) {
        const pos = fromEnd ? (isHoriz ? h - 1 - k : w - 1 - k) : k;
        vals[k] = isHoriz ? rowDarkFrac(pos, maxX >> 1, w - 1 - (maxX >> 1)) : colDarkFrac(pos, maxY >> 1, h - 1 - (maxY >> 1));
      }
      for (let k = 1; k < limit - 1; k++) {
        if (vals[k] < 0.45) continue;
        if (vals[k] >= vals[k - 1] && vals[k] >= vals[k + 1]) {
          if (peaks.length && Math.abs(peaks[peaks.length - 1].k - k) <= 3) {
            if (vals[k] > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { k: k, pos: fromEnd ? (isHoriz ? h - 1 - k : w - 1 - k) : k, v: vals[k] };
            continue;
          }
          const pos = fromEnd ? (isHoriz ? h - 1 - k : w - 1 - k) : k;
          peaks.push({ k: k, pos: pos, v: vals[k] });
        }
      }
      // Если рамка проходит вплотную к самому краю (k = 1, как на сканах HABS), добавляем ее отдельно.
      if (vals[1] >= 0.72 && !peaks.some(function (p) { return p.k <= 2; })) {
        const pos1 = fromEnd ? (isHoriz ? h - 2 : w - 2) : 1;
        peaks.push({ k: 1, pos: pos1, v: vals[1] });
      }
      peaks.sort(function (a, b) { return b.v - a.v; });
      return peaks.slice(0, 3);
    }

    const tops = findEdgePeaks(maxY, true, false);
    const bots = findEdgePeaks(maxY, true, true);
    const lefts = findEdgePeaks(maxX, false, false);
    const rights = findEdgePeaks(maxX, false, true);
    const cands = [];
    for (let it = 0; it < tops.length; it++) {
      for (let ib = 0; ib < bots.length; ib++) {
        const y0 = tops[it].pos, y1 = bots[ib].pos;
        if (y1 - y0 < h * 0.55) continue;
        for (let il = 0; il < lefts.length; il++) {
          for (let ir = 0; ir < rights.length; ir++) {
            const x0 = lefts[il].pos, x1 = rights[ir].pos;
            if (x1 - x0 < w * 0.55) continue;
            const ft = rowDarkFrac(y0, x0, x1), fb = rowDarkFrac(y1, x0, x1);
            const fl = colDarkFrac(x0, y0, y1), fr = colDarkFrac(x1, y0, y1);
            if (ft < 0.72 || fb < 0.72 || fl < 0.72 || fr < 0.72) continue;
            cands.push({ q: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], sc: ft + fb + fl + fr });
          }
        }
      }
    }
    cands.sort(function (a, b) { return b.sc - a.sc; });
    return cands.slice(0, 12).map(function (c) { return c.q; });
  }

  // ---------- кандидаты из четверок прямых ----------

  function lineProposals(lines, w, h) {
    if (lines.length < 4) return [];
    const diag = Math.hypot(w, h);
    // Отбираем до 30 лучших линий: длинные + ближайшие к краям с каждой стороны.
    const ranked = lines.map(function (ln, idx) {
      const cappedMag = ln.avgMag < 65 ? ln.avgMag : 65;
      return { ln: ln, idx: idx, sc: ln.coverLen * Math.sqrt(cappedMag) };
    });
    ranked.sort(function (a, b) { return b.sc - a.sc; });

    const picked = [];
    const used = new Uint8Array(lines.length);
    function addLine(item) {
      if (used[item.idx]) return;
      // Не добавляем почти дублирующую прямую.
      for (let i = 0; i < picked.length; i++) {
        const p = picked[i];
        const dot = Math.abs(p.nx * item.ln.nx + p.ny * item.ln.ny);
        if (dot > 0.996) {
          const dist = Math.abs(p.nx * item.ln.mx + p.ny * item.ln.my - p.d);
          if (dist < 4) return;
        }
      }
      used[item.idx] = 1;
      picked.push(item.ln);
    }

    for (let i = 0; i < ranked.length && picked.length < 22; i++) addLine(ranked[i]);
    // Добавляем крайние горизонтальные и вертикальные линии (у краев листа контраст бывает ниже стен).
    const hor = ranked.filter(function (it) { return Math.abs(it.ln.ny) > 0.7 && it.ln.len > w * 0.14; });
    const ver = ranked.filter(function (it) { return Math.abs(it.ln.nx) > 0.7 && it.ln.len > h * 0.14; });
    hor.sort(function (a, b) { return a.ln.my - b.ln.my; });
    for (let i = 0; i < Math.min(4, hor.length); i++) addLine(hor[i]);
    for (let i = Math.max(0, hor.length - 4); i < hor.length; i++) addLine(hor[i]);
    ver.sort(function (a, b) { return a.ln.mx - b.ln.mx; });
    for (let i = 0; i < Math.min(4, ver.length); i++) addLine(ver[i]);
    for (let i = Math.max(0, ver.length - 4); i < ver.length; i++) addLine(ver[i]);

    const L = picked.length;
    if (L < 4) return [];

    // Предвычисляем пересечения всех пар линий.
    const inter = new Array(L * L);
    const padX = w * 0.08, padY = h * 0.08;
    for (let i = 0; i < L; i++) {
      for (let j = i + 1; j < L; j++) {
        const dot = Math.abs(picked[i].nx * picked[j].nx + picked[i].ny * picked[j].ny);
        if (dot > 0.78) continue; // почти параллельные не пересекаются как смежные стороны
        const pt = intersectLines(picked[i], picked[j]);
        if (!pt) continue;
        if (pt[0] < -padX || pt[0] > w + padX || pt[1] < -padY || pt[1] > h + padY) continue;
        inter[i * L + j] = pt;
        inter[j * L + i] = pt;
      }
    }

    // Пары "противоположных" сторон: угол до 36 градусов, разнесены хотя бы на 15% стороны.
    const minSep = Math.min(w, h) * 0.15;
    const pairs = [];
    for (let i = 0; i < L; i++) {
      for (let j = i + 1; j < L; j++) {
        const dot = Math.abs(picked[i].nx * picked[j].nx + picked[i].ny * picked[j].ny);
        if (dot < 0.80) continue; // угол больше 37 градусов
        const sep = Math.abs(picked[i].nx * picked[j].mx + picked[i].ny * picked[j].my - picked[i].d);
        if (sep < minSep) continue;
        const ax = picked[i].tx, ay = picked[i].ty;
        const sgn = (picked[i].tx * picked[j].tx + picked[i].ty * picked[j].ty) >= 0 ? 1 : -1;
        let dx = ax + sgn * picked[j].tx, dy = ay + sgn * picked[j].ty;
        const dl = Math.hypot(dx, dy) || 1;
        pairs.push({ i: i, j: j, dx: dx / dl, dy: dy / dl, sc: picked[i].coverLen + picked[j].coverLen });
      }
    }
    pairs.sort(function (a, b) { return b.sc - a.sc; });
    const P = Math.min(pairs.length, 90);

    function segOverlapFrac(ln, pA, pB) {
      const vx = pB[0] - pA[0], vy = pB[1] - pA[1];
      const sideLen = Math.hypot(vx, vy);
      if (sideLen < 1) return 0;
      const ux = vx / sideLen, uy = vy / sideLen;
      const t1 = (ln.x1 - pA[0]) * ux + (ln.y1 - pA[1]) * uy;
      const t2 = (ln.x2 - pA[0]) * ux + (ln.y2 - pA[1]) * uy;
      const lo = Math.max(0, t1 < t2 ? t1 : t2);
      const hi = Math.min(sideLen, t1 < t2 ? t2 : t1);
      return hi > lo ? (hi - lo) / sideLen : 0;
    }

    const minArea = w * h * 0.05;
    const cands = [];
    for (let u = 0; u < P; u++) {
      const A = pairs[u];
      for (let v = u + 1; v < P; v++) {
        const B = pairs[v];
        if (A.i === B.i || A.i === B.j || A.j === B.i || A.j === B.j) continue;
        if (Math.abs(A.dx * B.dx + A.dy * B.dy) > 0.72) continue;
        const p00 = inter[A.i * L + B.i];
        const p01 = inter[A.i * L + B.j];
        const p11 = inter[A.j * L + B.j];
        const p10 = inter[A.j * L + B.i];
        if (!p00 || !p01 || !p11 || !p10) continue;

        const q = orderQuad([p00, p01, p11, p10]);
        if (!validConvexQuad(q, 0.72)) continue;
        const area = quadArea(q);
        if (area < minArea) continue;

        // Быстрая проверка: каждая из 4 сторон должна иметь подтверждение своим отрезком.
        const c1 = segOverlapFrac(picked[A.i], p00, p01);
        const c2 = segOverlapFrac(picked[A.j], p10, p11);
        const c3 = segOverlapFrac(picked[B.i], p00, p10);
        const c4 = segOverlapFrac(picked[B.j], p01, p11);
        const minC = Math.min(c1, c2, c3, c4);
        const meanC = 0.25 * (c1 + c2 + c3 + c4);
        if (minC < 0.18 || meanC < 0.35) continue;

        cands.push({ q: q, pre: meanC * Math.pow(area / (w * h), 0.35) * (0.4 + 0.6 * minC) });
      }
    }
    cands.sort(function (a, b) { return b.pre - a.pre; });
    const out = [];
    for (let i = 0; i < cands.length && out.length < 40; i++) {
      // Отбрасываем почти совпадающие кандидаты.
      const q = cands[i].q;
      let dup = false;
      for (let j = 0; j < out.length; j++) {
        let d = 0;
        for (let k = 0; k < 4; k++) d += Math.hypot(q[k][0] - out[j][k][0], q[k][1] - out[j][k][1]);
        if (d < diag * 0.025) { dup = true; break; }
      }
      if (!dup) out.push(q);
    }
    return out;
  }

  // ---------- единая оценка кандидатов (sheet vs frame vs full) ----------

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Сетка плотности рисунка и признак чистого бумажного поля по краям кадра.
  function buildSceneStats(work, edges, paperL) {
    const w = work.w, h = work.h;
    const gw = 32, gh = 24;
    const grid = new Int32Array(gw * gh);
    const darkTh = Math.min(165, paperL - 50);
    const edgeTh = Math.max(48, edges.tHigh);
    let totalContent = 0;

    for (let y = 2; y < h - 2; y++) {
      const gy = (y * gh / h) | 0;
      const ro = y * w, go = gy * gw;
      for (let x = 2; x < w - 2; x++) {
        const idx = ro + x;
        if (work.gray[idx] < darkTh || edges.mag[idx] >= edgeTh) {
          grid[go + ((x * gw / w) | 0)] += 1;
          totalContent += 1;
        }
      }
    }

    // Проверяем внешнюю кромку картинки: на сканах и скриншотах она ровно светлая и однородная.
    let bSum = 0, bSum2 = 0, bCnt = 0, bLight = 0;
    const bandX = Math.max(2, Math.round(w * 0.015));
    const bandY = Math.max(2, Math.round(h * 0.015));
    function sampleBorder(idx) {
      const l = work.gray[idx];
      const r = work.r[idx], g = work.g[idx], b = work.b[idx];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      bSum += l; bSum2 += l * l; bCnt += 1;
      if (l >= 225 && (mx - mn) <= 20) bLight += 1;
    }
    for (let y = 0; y < bandY; y++) {
      for (let x = 0; x < w; x += 2) { sampleBorder(y * w + x); sampleBorder((h - 1 - y) * w + x); }
    }
    for (let y = bandY; y < h - bandY; y += 2) {
      for (let x = 0; x < bandX; x++) { sampleBorder(y * w + x); sampleBorder(y * w + (w - 1 - x)); }
    }
    const bMean = bCnt > 0 ? bSum / bCnt : 0;
    const bVar = bCnt > 0 ? Math.max(0, bSum2 / bCnt - bMean * bMean) : 999;
    const bStd = Math.sqrt(bVar);
    // Чистая белая или однотонная светлая страница (скан, чертеж, скриншот).
    const borderCleanWhite = bCnt > 0 && (((bLight / bCnt) >= 0.78 && bStd <= 16) || (bMean >= 210 && bStd <= 6));

    return {
      gw: gw, gh: gh, grid: grid, totalContent: totalContent,
      borderCleanWhite: borderCleanWhite, borderMean: bMean, borderStd: bStd,
      vis: new Uint8Array(w * h), stack: new Int32Array(w * h)
    };
  }

  // Доля сильного содержимого картинки (стен, надписей), попадающая внутрь четырехугольника q.
  function quadContainment(q, w, h, stats) {
    if (stats.totalContent < 20) return 1;
    const gw = stats.gw, gh = stats.gh, grid = stats.grid;
    // Вычисляем полуплоскости 4 сторон (по часовой стрелке: внутренняя нормаль (-dy, dx)).
    const ax = new Float64Array(4), ay = new Float64Array(4), ac = new Float64Array(4);
    for (let e = 0; e < 4; e++) {
      const p0 = q[e], p1 = q[(e + 1) & 3];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy) || 1;
      const inx = -dy / len, iny = dx / len;
      ax[e] = inx; ay[e] = iny;
      // Допускаем небольшое расширение на полторы ячейки, чтобы края самого листа засчитались внутрь.
      ac[e] = inx * p0[0] + iny * p0[1] - Math.max(w / gw, h / gh) * 1.2;
    }
    let inside = 0;
    const sx = w / gw, sy = h / gh;
    for (let gy = 0; gy < gh; gy++) {
      const py = (gy + 0.5) * sy;
      const go = gy * gw;
      for (let gx = 0; gx < gw; gx++) {
        const val = grid[go + gx];
        if (!val) continue;
        const px = (gx + 0.5) * sx;
        if (ax[0] * px + ay[0] * py >= ac[0] &&
            ax[1] * px + ay[1] * py >= ac[1] &&
            ax[2] * px + ay[2] * py >= ac[2] &&
            ax[3] * px + ay[3] * py >= ac[3]) {
          inside += val;
        }
      }
    }
    return inside / stats.totalContent;
  }

  // Проверка, является ли тонкая темная рамка именно печатной рамкой листа, а не стеной здания.
  function frameIsNotBuilding(work, q, darkTh, stats) {
    const w = work.w, h = work.h, minL = work.minL;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let i = 0; i < 4; i++) {
      if (q[i][0] < x0) x0 = q[i][0];
      if (q[i][0] > x1) x1 = q[i][0];
      if (q[i][1] < y0) y0 = q[i][1];
      if (q[i][1] > y1) y1 = q[i][1];
    }
    const rx0 = Math.max(0, Math.floor(x0) - 2), ry0 = Math.max(0, Math.floor(y0) - 2);
    const rx1 = Math.min(w - 1, Math.ceil(x1) + 2), ry1 = Math.min(h - 1, Math.ceil(y1) + 2);
    const bw = x1 - x0, bh = y1 - y0;

    // 1. Внутренняя полоса сразу внутри 4 сторон рамки: у рамки листа хотя бы 2 стороны с пустым полем.
    let clearSides = 0;
    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) & 3];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 10) continue;
      const inx = -dy / len, iny = dx / len;
      const samples = 36;
      let darkCnt = 0;
      for (let s = 0; s < samples; s++) {
        const t = 0.08 + 0.84 * s / (samples - 1);
        const px = a[0] + dx * t, py = a[1] + dy * t;
        let hit = false;
        for (let off = 4; off <= 8; off += 2) {
          const sx = Math.round(px + inx * off), sy = Math.round(py + iny * off);
          if (sx >= 0 && sx < w && sy >= 0 && sy < h && minL[sy * w + sx] < darkTh) { hit = true; break; }
        }
        if (hit) darkCnt += 1;
      }
      if (darkCnt / samples < 0.25) clearSides += 1;
    }

    // 2. Связность рамки с серединой по усредненной яркости gray (тонкие размерные выноски не связывают рамку со зданием, а стены здания связывают).
    const gray = work.gray;
    const grayTh = Math.min(185, darkTh + 25);
    const vis = stats.vis, stack = stats.stack;
    vis.fill(0);
    let top = 0;
    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) & 3];
      const steps = Math.max(10, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = Math.round(a[0] + (b[0] - a[0]) * t), cy = Math.round(a[1] + (b[1] - a[1]) * t);
        for (let oy = -1; oy <= 1; oy++) {
          const ny = cy + oy;
          if (ny < ry0 || ny > ry1) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = cx + ox;
            if (nx < rx0 || nx > rx1) continue;
            const idx = ny * w + nx;
            if (!vis[idx] && minL[idx] < darkTh) { vis[idx] = 1; stack[top++] = idx; }
          }
        }
      }
    }
    const coreX0 = x0 + bw * 0.18, coreX1 = x1 - bw * 0.18;
    const coreY0 = y0 + bh * 0.18, coreY1 = y1 - bh * 0.18;
    let totalComp = 0, coreComp = 0;
    while (top) {
      const idx = stack[--top];
      const x = idx % w, y = (idx - x) / w;
      totalComp += 1;
      if (x > coreX0 && x < coreX1 && y > coreY0 && y < coreY1) coreComp += 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < ry0 || ny > ry1) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < rx0 || nx > rx1) continue;
          const j = ny * w + nx;
          if (!vis[j] && gray[j] < grayTh) { vis[j] = 1; stack[top++] = j; }
        }
      }
    }
    const coreFrac = totalComp > 0 ? coreComp / totalComp : 1;
    return coreFrac < 0.12 && clearSides >= 2;
  }

  function evaluateCandidate(q, work, edges, paperL, stats, bestFrameScore) {
    const w = work.w, h = work.h;
    const gx = edges.gx, gy = edges.gy, br = edges.br, bg = edges.bg, bb = edges.bb;
    const minL = work.minL, gray = work.gray;
    const area = quadArea(q);
    const areaFrac = area / (w * h);
    if (areaFrac < 0.05) return null;

    // Проверка пропорций противоположных сторон.
    const L0 = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const L1 = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    const L2 = Math.hypot(q[3][0] - q[2][0], q[3][1] - q[2][1]);
    const L3 = Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1]);
    const minSide = Math.min(L0, L1, L2, L3);
    if (minSide < Math.min(w, h) * 0.12) return null;
    const oppRatio = Math.min(Math.min(L0, L2) / Math.max(L0, L2), Math.min(L1, L3) / Math.max(L1, L3));
    if (oppRatio < 0.38) return null;

    // Если все 4 угла буквально в углах картинки (< 0.8 px от краев), это 'full'.
    let exactBorderCorners = 0;
    for (let i = 0; i < 4; i++) {
      const px = q[i][0], py = q[i][1];
      if ((px <= 0.8 || px >= w - 1.8) && (py <= 0.8 || py >= h - 1.8)) exactBorderCorners += 1;
    }
    if (exactBorderCorners === 4) return null;

    const darkTh = Math.min(175, paperL - 42);
    const edgeTh = Math.max(18, edges.tLow * 0.85);
    const strongTh = Math.max(65, edges.tHigh * 1.4);

    let minEdgeCov = 1, meanEdgeCov = 0, meanStr = 0, meanPol = 0;
    let minDarkCov = 1, meanDarkCov = 0;
    let meanColorDiff = 0, contrastSides = 0, frameLikeSides = 0;
    let borderSides = 0, nearEdgeSides = 0, insetOk = 0;
    let outLightFrac = 0, outDarkLineFrac = 0;
    let inOutSamples = 0;

    const SAMPLES = 40;
    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) & 3];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      const outX = dy / len, outY = -dx / len;
      const inX = -outX, inY = -outY;

      const onImageEdge = (Math.abs(a[0]) < 0.6 && Math.abs(b[0]) < 0.6) ||
                          (Math.abs(a[0] - (w - 1)) < 0.6 && Math.abs(b[0] - (w - 1)) < 0.6) ||
                          (Math.abs(a[1]) < 0.6 && Math.abs(b[1]) < 0.6) ||
                          (Math.abs(a[1] - (h - 1)) < 0.6 && Math.abs(b[1] - (h - 1)) < 0.6);
      const closeToEdge = (Math.max(a[0], b[0]) < 3.5) ||
                          (Math.min(a[0], b[0]) > w - 4.5) ||
                          (Math.max(a[1], b[1]) < 3.5) ||
                          (Math.min(a[1], b[1]) > h - 4.5);
      if (onImageEdge) borderSides += 1;
      else insetOk += 1;
      if (closeToEdge) nearEdgeSides += 1;

      let eHit = 0, dHit = 0, strSum = 0, polPos = 0, polNeg = 0;
      let sInNR = 0, sInNG = 0, sInNB = 0, sInNL = 0, nInN = 0;
      let sInFR = 0, sInFG = 0, sInFB = 0, nInF = 0;
      let sOutNR = 0, sOutNG = 0, sOutNB = 0, sOutNL = 0, nOutN = 0;
      let sOutFR = 0, sOutFG = 0, sOutFB = 0, nOutF = 0;
      let outDark = 0, outPaper = 0;
      let validS = 0;

      const nearIn = Math.max(4, Math.min(6, Math.round(minSide * 0.10)));
      const farIn = Math.max(10, Math.min(15, Math.round(minSide * 0.22)));

      for (let s = 0; s < SAMPLES; s++) {
        const t = 0.05 + 0.90 * s / (SAMPLES - 1);
        const px = a[0] + dx * t, py = a[1] + dy * t;
        const ix = Math.round(px), iy = Math.round(py);
        if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
        validS += 1;

        let bestAbs = 0, bestSign = 0, minOn = 255;
        for (let off = -2; off <= 2; off++) {
          const sx = Math.round(px + outX * off), sy = Math.round(py + outY * off);
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const idx = sy * w + sx;
          if (sx >= 1 && sx < w - 1 && sy >= 1 && sy < h - 1) {
            const proj = gx[idx] * outX + gy[idx] * outY;
            const ap = proj < 0 ? -proj : proj;
            if (ap > bestAbs) { bestAbs = ap; bestSign = proj; }
          }
          if (minL[idx] < minOn) minOn = minL[idx];
        }
        if (bestAbs >= edgeTh) {
          eHit += 1;
          strSum += bestAbs < strongTh ? bestAbs / strongTh : 1;
          if (bestSign > 0) polPos += bestAbs; else polNeg += bestAbs;
        }
        if (minOn < darkTh) dHit += 1;

        // Ближняя и дальняя пробы внутри: ближняя для рамки ('frame'), дальняя защищает от толстых стен плана.
        const jnx = Math.round(px + inX * nearIn), jny = Math.round(py + inY * nearIn);
        if (jnx >= 0 && jnx < w && jny >= 0 && jny < h) {
          const j = jny * w + jnx;
          sInNR += br[j]; sInNG += bg[j]; sInNB += bb[j]; sInNL += gray[j]; nInN += 1;
        }
        const jfx = Math.round(px + inX * farIn), jfy = Math.round(py + inY * farIn);
        if (jfx >= 0 && jfx < w && jfy >= 0 && jfy < h) {
          const j = jfy * w + jfx;
          sInFR += br[j]; sInFG += bg[j]; sInFB += bb[j]; nInF += 1;
        }

        // Ближняя (5 px или до кромки) и дальняя (13 px или до кромки) пробы снаружи.
        const nearOuts = [5, 3, 1];
        for (let oi = 0; oi < nearOuts.length; oi++) {
          const off = nearOuts[oi];
          const kx = Math.round(px + outX * off), ky = Math.round(py + outY * off);
          if (kx >= 0 && kx < w && ky >= 0 && ky < h) {
            const k = ky * w + kx;
            sOutNR += br[k]; sOutNG += bg[k]; sOutNB += bb[k]; sOutNL += gray[k]; nOutN += 1;
            if (minL[k] < darkTh) outDark += 1;
            if (gray[k] > paperL - 35) outPaper += 1;
            break;
          }
        }
        const farOuts = [13, 9, 5, 2];
        for (let oi = 0; oi < farOuts.length; oi++) {
          const off = farOuts[oi];
          const kx = Math.round(px + outX * off), ky = Math.round(py + outY * off);
          if (kx >= 0 && kx < w && ky >= 0 && ky < h) {
            const k = ky * w + kx;
            sOutFR += br[k]; sOutFG += bg[k]; sOutFB += bb[k]; nOutF += 1;
            break;
          }
        }
      }

      const cov = onImageEdge ? 0.50 : (validS > 0 ? eHit / validS : 0);
      const dCov = validS > 0 ? dHit / validS : 0;
      const str = validS > 0 ? strSum / validS : 0;
      const pol = (polPos + polNeg) > 0 ? Math.abs(polPos - polNeg) / (polPos + polNeg) : 0;

      if (cov < minEdgeCov) minEdgeCov = cov;
      meanEdgeCov += cov * 0.25;
      meanStr += str * 0.25;
      meanPol += (onImageEdge ? 0.5 : pol) * 0.25;

      if (dCov < minDarkCov) minDarkCov = dCov;
      meanDarkCov += dCov * 0.25;

      if (nInN > 0 && nOutN > 0) {
        const cNear = Math.max(
          Math.abs(sInNR / nInN - sOutNR / nOutN),
          Math.abs(sInNG / nInN - sOutNG / nOutN),
          Math.abs(sInNB / nInN - sOutNB / nOutN)
        );
        const cFar = (nInF > 0 && nOutF > 0) ? Math.max(
          Math.abs(sInFR / nInF - sOutFR / nOutF),
          Math.abs(sInFG / nInF - sOutFG / nOutF),
          Math.abs(sInFB / nInF - sOutFB / nOutF)
        ) : cNear;
        // Настоящий край листа контрастирует с фоном и вблизи, и вдали; толстая стена плана дает cFar ~ 0.
        const cDiff = cNear < cFar ? cNear : cFar;
        meanColorDiff += cDiff;
        inOutSamples += 1;
        if (cDiff >= 15) contrastSides += 1;
        const mInL = sInNL / nInN, mOutL = sOutNL / nOutN;
        if (dCov >= 0.72 && Math.abs(mInL - mOutL) < 34 && mOutL > 150 && cNear < 34 && (outDark / nOutN) < 0.28) {
          frameLikeSides += 1;
        }
        outLightFrac += outPaper / nOutN;
        outDarkLineFrac += outDark / nOutN;
      } else if (dCov >= 0.80 && closeToEdge && paperL >= 180) {
        // Рамка вплотную к краю белого скана (меньше 1 рабочей точки до кромки).
        frameLikeSides += 1;
      }
    }

    if (borderSides > 1) return null;
    if (inOutSamples > 0) {
      meanColorDiff /= inOutSamples;
      outLightFrac /= inOutSamples;
      outDarkLineFrac /= inOutSamples;
    }

    let maxTiltSin = 0;
    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) & 3];
      const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
      const len = Math.hypot(dx, dy) || 1;
      const s = Math.min(dx, dy) / len;
      if (s > maxTiltSin) maxTiltSin = s;
    }

    const containment = quadContainment(q, w, h, stats);

    // Оценка как 'frame' (печатная рамка на скане/чертеже).
    let frameScore = 0;
    if (areaFrac >= 0.42 && insetOk >= 3 && minDarkCov >= 0.72 && meanDarkCov >= 0.82 &&
        frameLikeSides >= 3 && maxTiltSin < 0.14 && outDarkLineFrac < 0.24 && paperL >= 150 && containment >= 0.75) {
      const preFrame = clamp(
        0.45 * meanDarkCov + 0.30 * minDarkCov + 0.15 * Math.sqrt(areaFrac) + 0.10 * (1 - outDarkLineFrac),
        0, 0.98
      );
      // Тяжелую проверку связности вызываем только если кандидат лучше текущего лидера.
      if (preFrame >= 0.58 && preFrame > bestFrameScore && frameIsNotBuilding(work, q, darkTh, stats)) {
        frameScore = preFrame;
      }
    }

    // Оценка как 'sheet' (лист бумаги или рамка на фоне стены/стола/двери).
    // Лист на фоне не может прижиматься 2 и более сторонами вплотную к краям кадра.
    let sheetScore = 0;
    if (nearEdgeSides < 2 && minEdgeCov >= 0.36 && meanEdgeCov >= 0.54) {
      const contrastNorm = clamp(meanColorDiff / 52, 0, 1);
      const areaBonus = Math.pow(areaFrac, 0.32);
      const polBonus = 0.35 + 0.65 * meanPol;
      const contBonus = 0.48 + 0.52 * Math.min(1, containment / 0.88);
      const hasSheetContrast = (contrastSides >= 3 && meanColorDiff >= 15) ||
                               (contrastSides >= 3 && meanColorDiff >= 11 && areaFrac >= 0.55 && containment >= 0.85 && !stats.borderCleanWhite) ||
                               (contrastSides >= 2 && meanColorDiff >= 24 && (maxTiltSin > 0.04 || outLightFrac < 0.65));

      // На чистых белых чертежах/скринах не принимаем отдельные комнаты за 'sheet'.
      const rejectedClean = stats.borderCleanWhite && (areaFrac < 0.35 || containment < 0.78 || meanColorDiff < 25);
      // Даже на фото не принимаем мелкую внутреннюю комнату, когда большая часть рисунка снаружи.
      const rejectedPartial = !stats.borderCleanWhite && containment < 0.32;
      const looksLikeInteriorRoom = areaFrac < 0.72 && outLightFrac > 0.72 && outDarkLineFrac > 0.10 && meanColorDiff < 38;

      if (hasSheetContrast && !rejectedClean && !rejectedPartial && !looksLikeInteriorRoom) {
        const raw = (0.34 * meanEdgeCov + 0.24 * minEdgeCov + 0.20 * meanStr + 0.22 * contrastNorm) *
                    polBonus * contBonus * (0.55 + 0.45 * areaBonus);
        sheetScore = clamp(borderSides > 0 ? raw * 0.88 : raw, 0, 0.99);
      }
    }

    if (frameScore > sheetScore && frameScore >= 0.58) {
      return { q: q, score: frameScore, kind: 'frame' };
    }
    if (sheetScore >= 0.54) {
      return { q: q, score: sheetScore, kind: 'sheet' };
    }
    const bestLow = Math.max(frameScore, sheetScore);
    return { q: q, score: bestLow, kind: 'low' };
  }

  // ---------- уточнение углов в полном разрешении ----------

  function refineQuadFullRes(rgba, w, h, quad, kind, workScale) {
    const rad = Math.min(14, Math.max(4, Math.ceil(2.5 / workScale)));
    const M = 44;
    const stride = w * 4;
    const lines = [];

    for (let e = 0; e < 4; e++) {
      const a = quad[e], b = quad[(e + 1) & 3];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 20) return quad;
      const outX = dy / len, outY = -dx / len;

      // Если сторона на краю картинки, оставляем ее как есть.
      if ((Math.abs(a[0]) < 3 && Math.abs(b[0]) < 3) ||
          (Math.abs(a[0] - w) < 3 && Math.abs(b[0] - w) < 3) ||
          (Math.abs(a[1]) < 3 && Math.abs(b[1]) < 3) ||
          (Math.abs(a[1] - h) < 3 && Math.abs(b[1] - h) < 3)) {
        const nx = outX, ny = outY, d = nx * a[0] + ny * a[1];
        lines.push({ nx: nx, ny: ny, d: d });
        continue;
      }

      // Оцениваем ожидаемый знак градиента для 'sheet' (внутренний цвет минус внешний).
      let expSign = 0;
      if (kind === 'sheet') {
        let sDiff = 0;
        for (let s = 0; s < 12; s++) {
          const t = 0.15 + 0.70 * s / 11;
          const px = a[0] + dx * t, py = a[1] + dy * t;
          const ix = Math.round(px - outX * rad), iy = Math.round(py - outY * rad);
          const ox = Math.round(px + outX * rad), oy = Math.round(py + outY * rad);
          if (ix >= 0 && ix < w && iy >= 0 && iy < h && ox >= 0 && ox < w && oy >= 0 && oy < h) {
            const ii = iy * stride + ix * 4, oi = oy * stride + ox * 4;
            const li = rgba[ii] * 0.3 + rgba[ii + 1] * 0.59 + rgba[ii + 2] * 0.11;
            const lo = rgba[oi] * 0.3 + rgba[oi + 1] * 0.59 + rgba[oi + 2] * 0.11;
            sDiff += lo - li;
          }
        }
        expSign = sDiff >= 0 ? 1 : -1;
      }

      const profLen = rad * 2 + 1;
      const profR = new Float32Array(profLen);
      const profG = new Float32Array(profLen);
      const profB = new Float32Array(profLen);
      const profL = new Float32Array(profLen);
      const detX = [], detY = [], detW = [];

      for (let s = 0; s < M; s++) {
        const t = 0.08 + 0.84 * s / (M - 1);
        const px = a[0] + dx * t, py = a[1] + dy * t;
        let ok = true;
        for (let k = -rad; k <= rad; k++) {
          const sx = Math.round(px + outX * k), sy = Math.round(py + outY * k);
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) { ok = false; break; }
          const o = sy * stride + sx * 4;
          const rv = rgba[o], gv = rgba[o + 1], bv = rgba[o + 2];
          const idx = k + rad;
          profR[idx] = rv; profG[idx] = gv; profB[idx] = bv;
          profL[idx] = rv * 0.299 + gv * 0.587 + bv * 0.114;
        }
        if (!ok) continue;

        let bestK = 0, bestVal = -1;
        if (kind === 'frame') {
          // Для печатной рамки ищем самую темную точку профиля.
          let minVal = 256, maxVal = 0;
          for (let i = 0; i < profLen; i++) {
            if (profL[i] < minVal) { minVal = profL[i]; bestK = i; }
            if (profL[i] > maxVal) maxVal = profL[i];
          }
          bestVal = maxVal - minVal;
          if (bestVal < 35) continue;
          let sub = bestK;
          if (bestK > 0 && bestK < profLen - 1) {
            const y0 = profL[bestK - 1], y1 = profL[bestK], y2 = profL[bestK + 1];
            const denom = y0 - 2 * y1 + y2;
            if (denom > 1e-3) sub += clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5);
          }
          const off = sub - rad;
          detX.push(px + outX * off); detY.push(py + outY * off); detW.push(bestVal);
        } else {
          // Для края листа ищем пик сглаженной производной вдоль нормали.
          const resp = new Float32Array(profLen);
          for (let i = 2; i < profLen - 2; i++) {
            const gR = (profR[i + 2] + profR[i + 1]) - (profR[i - 1] + profR[i - 2]);
            const gG = (profG[i + 2] + profG[i + 1]) - (profG[i - 1] + profG[i - 2]);
            const gB = (profB[i + 2] + profB[i + 1]) - (profB[i - 1] + profB[i - 2]);
            const gL = (profL[i + 2] + profL[i + 1]) - (profL[i - 1] + profL[i - 2]);
            // Сильнейший скачок канала с приоритетом согласованной полярности.
            const aR = Math.abs(gR), aG = Math.abs(gG), aB = Math.abs(gB);
            let v = aR > aG ? (aR > aB ? aR : aB) : (aG > aB ? aG : aB);
            if (Math.abs(gL) > 20 && (gL * expSign) < 0) v *= 0.25;
            resp[i] = v;
            if (v > bestVal) { bestVal = v; bestK = i; }
          }
          if (bestVal < 28) continue;
          let sub = bestK;
          if (bestK > 2 && bestK < profLen - 3) {
            const y0 = resp[bestK - 1], y1 = resp[bestK], y2 = resp[bestK + 1];
            const denom = y0 - 2 * y1 + y2;
            if (denom < -1e-3) sub += clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5);
          }
          const off = sub - rad;
          detX.push(px + outX * off); detY.push(py + outY * off); detW.push(bestVal);
        }
      }

      if (detX.length < 10) {
        lines.push({ nx: outX, ny: outY, d: outX * a[0] + outY * a[1] });
        continue;
      }

      // Устойчивая подгонка прямой: два прохода с отсечением выбросов по медиане невязок.
      const nP = detX.length;
      const pts = new Float32Array(nP * 2);
      const wts = new Float32Array(nP);
      for (let i = 0; i < nP; i++) { pts[i * 2] = detX[i]; pts[i * 2 + 1] = detY[i]; wts[i] = detW[i]; }
      let ln = fitLine(pts, wts, 0, nP);
      if (ln) {
        const errs = new Float32Array(nP);
        for (let i = 0; i < nP; i++) errs[i] = Math.abs(ln.nx * detX[i] + ln.ny * detY[i] - ln.d);
        const sorted = Array.from(errs).sort(function (u, v) { return u - v; });
        const med = sorted[nP >> 1];
        const cut = Math.max(1.5, med * 2.5);
        let kept = 0;
        for (let i = 0; i < nP; i++) {
          if (errs[i] <= cut) { wts[i] = detW[i]; kept += 1; } else wts[i] = 0;
        }
        if (kept >= 8) {
          const ln2 = fitLine(pts, wts, 0, nP);
          if (ln2) ln = ln2;
        }
      }
      if (!ln) lines.push({ nx: outX, ny: outY, d: outX * a[0] + outY * a[1] });
      else lines.push({ nx: ln.nx, ny: ln.ny, d: ln.d });
    }

    const refined = [];
    const maxShift = Math.max(8, 4.0 / workScale);
    for (let i = 0; i < 4; i++) {
      const pt = intersectLines(lines[(i + 3) & 3], lines[i]);
      if (!pt || Math.hypot(pt[0] - quad[i][0], pt[1] - quad[i][1]) > maxShift) return quad;
      refined.push([clamp(pt[0], 0, w), clamp(pt[1], 0, h)]);
    }
    const ordered = orderQuad(refined);
    return validConvexQuad(ordered, 0.78) ? ordered : quad;
  }

  // ---------- главная функция detectQuad ----------

  function detectQuad(rgba, w, h) {
    if (!rgba || w < 32 || h < 32) {
      return { quad: fullQuad(w || 0, h || 0), score: 0, kind: 'full' };
    }
    const work = downscaleWork(rgba, w, h, WORK_SIDE);
    const dw = work.w, dh = work.h;

    // 75-й перцентиль яркости (фон бумаги на сканах).
    const hist = new Int32Array(256);
    for (let i = 0; i < work.gray.length; i++) hist[work.gray[i]] += 1;
    let acc = 0, paperL = 220;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= work.gray.length * 0.75) { paperL = v; break; }
    }

    const edges = computeEdges(work);
    const stats = buildSceneStats(work, edges, paperL);
    const rawSegs = extractSegments(edges, dw, dh);
    const mergedLines = mergeCollinear(rawSegs, dw, dh);

    // Собираем кандидатов из трех источников: линии, области и печатная рамка.
    const candQuads = [];
    const lp = lineProposals(mergedLines, dw, dh);
    for (let i = 0; i < lp.length; i++) candQuads.push(lp[i]);
    const rp = regionProposals(work, edges);
    for (let i = 0; i < rp.length; i++) candQuads.push(rp[i]);
    const fp = frameProposals(work);
    for (let i = 0; i < fp.length; i++) candQuads.push(fp[i]);

    let bestSheet = null, bestFrame = null, bestLow = 0;
    for (let i = 0; i < candQuads.length; i++) {
      const ev = evaluateCandidate(candQuads[i], work, edges, paperL, stats, bestFrame ? bestFrame.score : 0);
      if (!ev) continue;
      if (ev.kind === 'sheet') {
        if (!bestSheet || ev.score > bestSheet.score) bestSheet = ev;
      } else if (ev.kind === 'frame') {
        if (!bestFrame || ev.score > bestFrame.score) bestFrame = ev;
      } else if (ev.score > bestLow) {
        bestLow = ev.score;
      }
    }

    let winner = null;
    if (bestSheet && bestFrame) {
      // Если есть уверенный лист на фоне (снимки со стеной/столом), он главнее внутренней рамки.
      winner = bestSheet.score >= bestFrame.score - 0.12 ? bestSheet : bestFrame;
    } else {
      winner = bestSheet || bestFrame;
    }

    if (!winner) {
      return { quad: fullQuad(w, h), score: Math.round(bestLow * 1000) / 1000, kind: 'full' };
    }

    // Переводим в координаты исходной картинки и уточняем углы в полном разрешении.
    const invX = w / dw, invY = h / dh;
    const fullQ = winner.q.map(function (p) {
      return [clamp(p[0] * invX, 0, w), clamp(p[1] * invY, 0, h)];
    });
    const refined = refineQuadFullRes(rgba, w, h, orderQuad(fullQ), winner.kind, Math.min(work.sx, work.sy));
    return {
      quad: refined,
      score: Math.round(winner.score * 1000) / 1000,
      kind: winner.kind
    };
  }

  // ---------- выделение области плана внутри листа (planBox) ----------

  // Скользящий максимум 1D за линейное время (монотонный дек).
  function slidingMax1D(src, len, rad, dst, deq) {
    let head = 0, tail = 0;
    for (let i = 0; i < Math.min(len, rad); i++) {
      const v = src[i];
      while (tail > head && src[deq[tail - 1]] <= v) tail -= 1;
      deq[tail++] = i;
    }
    for (let i = 0; i < len; i++) {
      const add = i + rad;
      if (add < len) {
        const v = src[add];
        while (tail > head && src[deq[tail - 1]] <= v) tail -= 1;
        deq[tail++] = add;
      }
      if (deq[head] < i - rad) head += 1;
      dst[i] = src[deq[head]];
    }
  }

  function localMax2D(gray, w, h, rad) {
    const n = w * h;
    const tmp = new Uint8Array(n), out = new Uint8Array(n);
    const maxDim = w > h ? w : h;
    const line = new Uint8Array(maxDim), dst = new Uint8Array(maxDim), deq = new Int32Array(maxDim + 2);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) line[x] = gray[o + x];
      slidingMax1D(line, w, rad, dst, deq);
      for (let x = 0; x < w; x++) tmp[o + x] = dst[x];
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = tmp[y * w + x];
      slidingMax1D(line, h, rad, dst, deq);
      for (let y = 0; y < h; y++) out[y * w + x] = dst[y];
    }
    return out;
  }

  // Быстрый перенос quad в рабочую сетку planBox с сохранением тонких темных линий.
  function warpPlanWork(rgba, w, h, q, pw, ph) {
    const dst4 = [[0, 0], [pw, 0], [pw, ph], [0, ph]];
    const H = homography(dst4, q);
    const n = pw * ph;
    const gray = new Uint8Array(n);
    const minGray = new Uint8Array(n);
    const sat = new Uint8Array(n);
    if (!H) return { gray: gray, minGray: minGray, sat: sat };

    const sc = cornerScales(H, pw, ph);
    const sub = sc.max > 1.25 ? 2 : 1;
    const offs = sub === 2 ? [-0.25, 0.25] : [0];
    const invN = 1 / (sub * sub);
    const h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7], h8 = H[8];
    const stride = w * 4;

    for (let v = 0; v < ph; v++) {
      const vc = v + 0.5, ro = v * pw;
      for (let u = 0; u < pw; u++) {
        const uc = u + 0.5;
        let sl = 0, ss = 0, mn = 255, mnSat = 255;
        for (let oy = 0; oy < sub; oy++) {
          const vv = vc + offs[oy];
          const bnx = h1 * vv + h2, bny = h4 * vv + h5, bdn = h7 * vv + h8;
          for (let ox = 0; ox < sub; ox++) {
            const uu = uc + offs[ox];
            const inv = 1 / (h6 * uu + bdn);
            const sx = Math.round((h0 * uu + bnx) * inv - 0.5);
            const sy = Math.round((h3 * uu + bny) * inv - 0.5);
            if (sx < 0 || sx >= w || sy < 0 || sy >= h) { sl += 255; continue; }
            const o = sy * stride + sx * 4;
            const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
            const l = (r * 77 + g * 150 + b * 29) >> 8;
            const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
            const ch = mx - lo;
            sl += l; ss += ch;
            if (l < mn) { mn = l; mnSat = ch; }
          }
        }
        gray[ro + u] = (sl * invN + 0.5) | 0;
        minGray[ro + u] = mn;
        sat[ro + u] = mnSat < (ss * invN) ? mnSat : ((ss * invN + 0.5) | 0);
      }
    }
    return { gray: gray, minGray: minGray, sat: sat };
  }

  // Обрезка плана этажа внутри quad: крупнейшая связная структура длинных толстых линий.
  function planBox(rgba, w, h, quad) {
    if (!rgba || w < 32 || h < 32) return null;
    const q = quad && quad.length === 4 ? orderQuad(quad) : fullQuad(w, h);
    const sz = rectifiedSize(q, w, h);
    const big = Math.max(sz.w, sz.h);
    const sc = big > PLAN_SIDE ? PLAN_SIDE / big : 1;
    const pw = Math.max(24, Math.round(sz.w * sc));
    const ph = Math.max(24, Math.round(sz.h * sc));
    const pwData = warpPlanWork(rgba, w, h, q, pw, ph);
    const gray = pwData.gray, minGray = pwData.minGray, sat = pwData.sat;
    const n = pw * ph;

    const longS = Math.max(pw, ph);
    const bgRad = Math.max(8, Math.round(longS / 24));
    const bg = localMax2D(gray, pw, ph, bgRad);

    // Выделяем нейтральные темные штрихи (исключаем цветные стрелки/баннеры и сплошной темный фон).
    const diff = new Uint8Array(n);
    const dHist = new Int32Array(256);
    const padX = Math.max(3, Math.round(pw * 0.03));
    const padY = Math.max(3, Math.round(ph * 0.03));
    for (let y = padY; y < ph - padY; y++) {
      const o = y * pw;
      for (let x = padX; x < pw - padX; x++) {
        const i = o + x;
        if (bg[i] < 85) continue;
        if (sat[i] > 55 && minGray[i] > 55) continue;
        const d = bg[i] - minGray[i];
        if (d > 15) {
          diff[i] = d;
          dHist[d] += 1;
        }
      }
    }

    let inkTotal = 0;
    for (let d = 16; d < 256; d++) inkTotal += dHist[d];
    if (inkTotal < n * 0.004) return null;
    let acc = 0, dTh = 32;
    for (let d = 255; d >= 16; d--) {
      acc += dHist[d];
      if (acc >= Math.min(n * 0.18, inkTotal * 0.68)) { dTh = d; break; }
    }
    if (dTh < 22) dTh = 22;
    if (dTh > 48) dTh = 48;

    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (diff[i] >= dTh) ink[i] = 1;

    // Убираем широкие сплошные темные полосы и панели (толще ~12 px), чтобы черный фон табличек не стал "стеной".
    const rSolid = Math.max(4, Math.round(longS * 0.016));
    const invInk = new Uint8Array(n);
    for (let i = 0; i < n; i++) invInk[i] = ink[i] ? 0 : 1;
    const nearLight = localMax2D(invInk, pw, ph, rSolid);
    const solidCore = new Uint8Array(n);
    let hasSolid = false;
    for (let i = 0; i < n; i++) {
      if (ink[i] && !nearLight[i]) { solidCore[i] = 1; hasSolid = true; }
    }
    if (hasSolid) {
      const solidBand = localMax2D(solidCore, pw, ph, rSolid + 2);
      for (let i = 0; i < n; i++) if (solidBand[i]) ink[i] = 0;
    }

    // Отбираем длинные линии (0/90/45/135 градусов) и крупные 2D-связные каркасы стен (для косых и круглых зданий).
    const minRun = Math.max(8, Math.round(longS * 0.032));
    const dirMask = new Uint8Array(n); // бит 1: гориз, бит 2: верт, бит 4: диаг/сеть

    for (let y = padY; y < ph - padY; y++) {
      const o = y * pw;
      let run = 0;
      for (let x = padX; x <= pw - padX; x++) {
        if (x < pw - padX && ink[o + x]) run += 1;
        else {
          if (run >= minRun) for (let k = x - run; k < x; k++) dirMask[o + k] |= 1;
          run = 0;
        }
      }
    }
    for (let x = padX; x < pw - padX; x++) {
      let run = 0;
      for (let y = padY; y <= ph - padY; y++) {
        if (y < ph - padY && ink[y * pw + x]) run += 1;
        else {
          if (run >= minRun) for (let k = y - run; k < y; k++) dirMask[k * pw + x] |= 2;
          run = 0;
        }
      }
    }
    const minDiag = Math.max(7, Math.round(minRun * 0.85));
    const dirs = [[1, 1], [1, -1]];
    for (let di = 0; di < 2; di++) {
      const dx = dirs[di][0], dy = dirs[di][1];
      for (let s = -ph; s < pw; s++) {
        let x = s < 0 ? 0 : s;
        let y = dy > 0 ? (s < 0 ? -s : 0) : (s < 0 ? ph - 1 + s : ph - 1);
        let run = 0;
        while (x >= 0 && x < pw && y >= 0 && y < ph) {
          if (ink[y * pw + x]) run += 1;
          else {
            if (run >= minDiag) for (let k = 1; k <= run; k++) dirMask[(y - dy * k) * pw + (x - dx * k)] |= 4;
            run = 0;
          }
          x += dx; y += dy;
        }
        if (run >= minDiag) for (let k = 1; k <= run; k++) dirMask[(y - dy * k) * pw + (x - dx * k)] |= 4;
      }
    }

    // Сохраняем связные каркасы стен под произвольным углом (размах >= minRun * 1.4 по обеим осям).
    const preLbl = new Int32Array(n), stack = new Int32Array(n);
    const minSpan = Math.max(12, Math.round(minRun * 1.4));
    let preId = 0;
    for (let s = 0; s < n; s++) {
      if (!ink[s] || preLbl[s]) continue;
      preId += 1;
      let top = 0, x0 = pw, y0 = ph, x1 = -1, y1 = -1, cnt = 0;
      stack[top++] = s; preLbl[s] = preId;
      const pts = [];
      while (top) {
        const i = stack[--top];
        const x = i % pw, y = (i - x) / pw;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        cnt += 1; pts.push(i);
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < padY || ny >= ph - padY) continue;
          const ro = ny * pw;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx; if (nx < padX || nx >= pw - padX) continue;
            const j = ro + nx;
            if (ink[j] && !preLbl[j]) { preLbl[j] = preId; stack[top++] = j; }
          }
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw >= minSpan && bh >= minSpan && cnt >= minSpan * 2) {
        for (let k = 0; k < pts.length; k++) dirMask[pts[k]] |= 4;
      }
    }

    // Оценка толщины стены (толстые стены здания весят больше тонких рамок таблиц).
    const thick = new Uint8Array(n);
    for (let y = padY; y < ph - padY; y++) {
      const o = y * pw;
      for (let x = padX; x < pw - padX; x++) {
        const i = o + x;
        const dm = dirMask[i];
        if (!dm) continue;
        let t = 1;
        if (dm & 1) {
          let c = 1;
          for (let k = 1; k <= 5 && y - k >= 0 && ink[(y - k) * pw + x]; k++) c += 1;
          for (let k = 1; k <= 5 && y + k < ph && ink[(y + k) * pw + x]; k++) c += 1;
          if (c > t) t = c;
        }
        if (dm & 2) {
          let c = 1;
          for (let k = 1; k <= 5 && x - k >= 0 && ink[o + x - k]; k++) c += 1;
          for (let k = 1; k <= 5 && x + k < pw && ink[o + x + k]; k++) c += 1;
          if (c > t) t = c;
        }
        thick[i] = t > 6 ? 6 : t;
      }
    }

    // Небольшое расширение соединяет стены здания через дверные проемы.
    const rJoin = Math.max(1, Math.round(longS * 0.005));
    const joined = new Uint8Array(n);
    for (let y = padY; y < ph - padY; y++) {
      const o = y * pw;
      for (let x = padX; x < pw - padX; x++) {
        if (!dirMask[o + x]) continue;
        const y0 = y - rJoin < 0 ? 0 : y - rJoin, y1 = y + rJoin >= ph ? ph - 1 : y + rJoin;
        const x0 = x - rJoin < 0 ? 0 : x - rJoin, x1 = x + rJoin >= pw ? pw - 1 : x + rJoin;
        for (let yy = y0; yy <= y1; yy++) {
          const ro = yy * pw;
          for (let xx = x0; xx <= x1; xx++) joined[ro + xx] = 1;
        }
      }
    }

    const labels = preLbl;
    labels.fill(0);
    const comps = [];
    let compId = 0;

    for (let s = 0; s < n; s++) {
      if (!joined[s] || labels[s]) continue;
      compId += 1;
      let top = 0;
      stack[top++] = s;
      labels[s] = compId;
      let x0 = pw, y0 = ph, x1 = -1, y1 = -1;
      let hCnt = 0, vCnt = 0, dCnt = 0, linePx = 0, wMass = 0, thickSum = 0;
      const compPixels = [];

      while (top) {
        const i = stack[--top];
        const x = i % pw, y = (i - x) / pw;
        const dm = dirMask[i];
        if (dm) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (dm & 1) hCnt += 1;
          if (dm & 2) vCnt += 1;
          if (dm & 4) dCnt += 1;
          linePx += 1;
          thickSum += thick[i];
          const tCap = thick[i] > 3 ? 3 : thick[i];
          wMass += Math.sqrt(diff[i] / 255) * (0.75 + 0.25 * tCap);
          compPixels.push(i);
        }
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= ph) continue;
          const ro = ny * pw;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= pw) continue;
            const j = ro + nx;
            if (joined[j] && !labels[j]) { labels[j] = compId; stack[top++] = j; }
          }
        }
      }

      if (linePx < minRun * 2 || x1 <= x0 || y1 <= y0) continue;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw < pw * 0.06 || bh < ph * 0.06) continue;
      const bboxArea = bw * bh;
      if (bboxArea < n * 0.02) continue;

      // Доля линий внутри рамки (отсеивает любые пустые рамки, паспарту и границы табличек).
      const ix0 = x0 + bw * 0.14, ix1 = x1 - bw * 0.14;
      const iy0 = y0 + bh * 0.14, iy1 = y1 - bh * 0.14;
      let innerPx = 0;
      for (let k = 0; k < compPixels.length; k++) {
        const idx = compPixels[k];
        const px = idx % pw, py = (idx - px) / pw;
        if (px > ix0 && px < ix1 && py > iy0 && py < iy1) innerPx += 1;
      }
      const innerFrac = innerPx / linePx;
      if (innerFrac < 0.06) continue;

      const hEff = hCnt + dCnt * 0.5, vEff = vCnt + dCnt * 0.5;
      const balance = Math.min(hEff, vEff) / Math.max(1, hEff + vEff);
      if (balance < 0.07) continue;

      const avgThick = thickSum / linePx;
      // Штрафуем небольшие штампы, прижатые к нижнему углу листа.
      const cornerStamp = (bboxArea < n * 0.14) && (y1 > ph * 0.88) && (x1 > pw * 0.88 || x0 < pw * 0.12);
      const score = wMass *
        (0.25 + 0.75 * Math.min(1, balance * 3.0)) *
        (0.30 + 0.70 * Math.min(1, innerFrac * 2.5)) *
        (0.65 + 0.35 * Math.min(2, avgThick)) *
        (cornerStamp ? 0.45 : 1.0);

      comps.push({
        x0: x0, y0: y0, x1: x1, y1: y1, bw: bw, bh: bh,
        score: score, wMass: wMass, avgThick: avgThick, innerFrac: innerFrac, cornerStamp: cornerStamp
      });
    }

    if (!comps.length) return null;
    comps.sort(function (a, b) { return b.score - a.score; });
    const best = comps[0];
    if (best.wMass < minRun * 2.5) return null;

    // Присоединяем соседнее крыло того же здания, если оно отделено широким проходом или коридором.
    let bx0 = best.x0, by0 = best.y0, bx1 = best.x1, by1 = best.y1;
    const nearGap = Math.max(8, Math.round(longS * 0.04));
    const corrGap = Math.max(16, Math.round(longS * 0.10));
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.cornerStamp || c.score < best.score * 0.15) continue;
      if (c.avgThick < best.avgThick * 0.72) continue;
      const gx = Math.max(0, Math.max(c.x0 - bx1, bx0 - c.x1));
      const gy = Math.max(0, Math.max(c.y0 - by1, by0 - c.y1));
      const ovX = Math.max(0, Math.min(bx1, c.x1) - Math.max(bx0, c.x0)) / Math.max(1, Math.min(bx1 - bx0, c.bw));
      const ovY = Math.max(0, Math.min(by1, c.y1) - Math.max(by0, c.y0)) / Math.max(1, Math.min(by1 - by0, c.bh));
      const acrossCorridor = c.score >= best.score * 0.28 &&
        ((gx === 0 && gy <= corrGap && ovX >= 0.45) || (gy === 0 && gx <= corrGap && ovY >= 0.45));
      if ((gx <= nearGap && gy <= nearGap) || acrossCorridor) {
        if (c.x0 < bx0) bx0 = c.x0;
        if (c.y0 < by0) by0 = c.y0;
        if (c.x1 > bx1) bx1 = c.x1;
        if (c.y1 > by1) by1 = c.y1;
      }
    }

    // Расширяем рамку на небольшой запас.
    const margin = Math.max(6, Math.round(Math.max(bx1 - bx0, by1 - by0) * 0.045));
    const ux0 = clamp((bx0 - margin) / pw, 0, 1);
    const uy0 = clamp((by0 - margin) / ph, 0, 1);
    const ux1 = clamp((bx1 + 1 + margin) / pw, 0, 1);
    const uy1 = clamp((by1 + 1 + margin) / ph, 0, 1);
    if (ux1 - ux0 < 0.05 || uy1 - uy0 < 0.05) return null;

    const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
    if (!H) return null;
    const subQuad = [
      applyH(H, ux0, uy0),
      applyH(H, ux1, uy0),
      applyH(H, ux1, uy1),
      applyH(H, ux0, uy1)
    ];
    let ox0 = w, oy0 = h, ox1 = 0, oy1 = 0;
    for (let i = 0; i < 4; i++) {
      subQuad[i][0] = clamp(subQuad[i][0], 0, w);
      subQuad[i][1] = clamp(subQuad[i][1], 0, h);
      if (subQuad[i][0] < ox0) ox0 = subQuad[i][0];
      if (subQuad[i][0] > ox1) ox1 = subQuad[i][0];
      if (subQuad[i][1] < oy0) oy0 = subQuad[i][1];
      if (subQuad[i][1] > oy1) oy1 = subQuad[i][1];
    }
    return {
      quad: subQuad,
      uv: [ux0, uy0, ux1, uy1],
      bbox: [ox0, oy0, ox1, oy1]
    };
  }

  return {
    detectQuad: detectQuad,
    planBox: planBox,
    rectifiedSize: rectifiedSize,
    homography: homography,
    applyH: applyH,
    warp: warp,
    _orderQuad: orderQuad
  };
}));
