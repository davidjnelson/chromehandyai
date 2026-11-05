/*
 * Motion analysis: turns video frames into a stroke signal, and the stroke
 * signal into funscript actions.
 *
 * Pipeline
 *   1. estimator.estimate(prevGray, curGray)
 *        Block matching on a small grayscale frame (default 128 px wide).
 *        Gives a (dx, dy) motion vector per 8x8 block, scaled by a confidence
 *        value, plus a scene-cut score.
 *   2. analyze(samples)
 *        Splits the scan at scene cuts, then runs PCA over sliding ~3 s
 *        windows of all block vectors. The first principal component is the
 *        strongest coherent back-and-forth movement in the shot (blocks moving
 *        in opposite directions reinforce each other instead of cancelling),
 *        which is the stroke. Windows are stitched with overlap-add and sign
 *        alignment. Output: a velocity signal { t, v, seg }.
 *   3. generateActions(signal, params)
 *        Integrates velocity to position, detrends, finds turning points with
 *        an adaptive zig-zag filter, maps them onto the user's stroke range
 *        and enforces a speed limit. Cheap, so tuning sliders re-run only this
 *        step and never re-scan the video.
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});

  // ---------------------------------------------------------------- frames --

  /** RGBA -> luma (Uint8Array). */
  function toGray(rgba, out) {
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    return out;
  }

  /**
   * @param {number} w frame width (multiple of block)
   * @param {number} h frame height (multiple of block)
   */
  function createMotionEstimator(w, h, opts) {
    const o = Object.assign({ block: 8, radius: 10, smoothness: 0.6 }, opts);
    const B = o.block;
    const R = o.radius;
    const bw = Math.floor(w / B);
    const bh = Math.floor(h / B);
    const nb = bw * bh;
    // Each block's previous motion vector: used as a prior so repetitive
    // textures (stripes, patterns) don't snap to an aliased match.
    const prior = new Float32Array(nb * 2);
    const lam = o.smoothness * B * B; // SAD units per pixel of deviation

    // SAD of the block at (x0,y0) in cur against prev displaced by (dx,dy):
    // "this block came from (x - dx, y - dy) in the previous frame".
    function sad(prev, cur, x0, y0, dx, dy, limit) {
      let s = 0;
      for (let j = 0; j < B; j++) {
        const rc = (y0 + j) * w + x0;
        const rp = (y0 + j - dy) * w + x0 - dx;
        for (let i = 0; i < B; i++) {
          const d = cur[rc + i] - prev[rp + i];
          s += d < 0 ? -d : d;
        }
        if (s > limit) return s;
      }
      return s;
    }

    function estimate(prev, cur) {
      const feat = new Float32Array(nb * 2);
      let diffSum = 0;
      for (let i = 0; i < cur.length; i += 3) {
        const d = cur[i] - prev[i];
        diffSum += d < 0 ? -d : d;
      }
      const meanDiff = diffSum / Math.ceil(cur.length / 3);
      if (meanDiff > 30) prior.fill(0); // scene cut: forget motion history

      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const x0 = bx * B;
          const y0 = by * B;
          // Valid displacement range so the reference block stays inside prev.
          const dxMin = Math.max(-R, x0 + B - w);
          const dxMax = Math.min(R, x0);
          const dyMin = Math.max(-R, y0 + B - h);
          const dyMax = Math.min(R, y0);

          // Texture: mean absolute deviation of the block. Flat areas give
          // meaningless vectors.
          let mean = 0;
          for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) mean += cur[(y0 + j) * w + x0 + i];
          mean /= B * B;
          let tex = 0;
          for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) tex += Math.abs(cur[(y0 + j) * w + x0 + i] - mean);
          tex /= B * B;

          const sad0 = sad(prev, cur, x0, y0, 0, 0, Infinity);
          if (sad0 < B * B * 1.5 || tex < 2) {
            // static or flat block
            const kk = (by * bw + bx) * 2;
            prior[kk] *= 0.5;
            prior[kk + 1] *= 0.5;
            continue;
          }

          // Coarse search on a step-2 grid, then refine +-1 around the best.
          // Cost = SAD + penalty for deviating from this block's last vector.
          const k = (by * bw + bx) * 2;
          const px = prior[k];
          const py = prior[k + 1];
          const pen = (dx, dy) => lam * (Math.abs(dx - px) + Math.abs(dy - py));
          let best = sad0;
          let bestCost = sad0 + pen(0, 0);
          let bdx = 0;
          let bdy = 0;
          const tryAt = (dx, dy) => {
            const p = pen(dx, dy);
            if (p >= bestCost) return;
            const s = sad(prev, cur, x0, y0, dx, dy, bestCost - p);
            if (s + p < bestCost) {
              bestCost = s + p;
              best = s;
              bdx = dx;
              bdy = dy;
            }
          };
          for (let dy = dyMin + ((dyMin & 1) ? 1 : 0); dy <= dyMax; dy += 2) {
            for (let dx = dxMin + ((dxMin & 1) ? 1 : 0); dx <= dxMax; dx += 2) tryAt(dx, dy);
          }
          // Also try the prior itself (rounded): smooth motion is the common case.
          const rpx = Math.max(dxMin, Math.min(dxMax, Math.round(px)));
          const rpy = Math.max(dyMin, Math.min(dyMax, Math.round(py)));
          tryAt(rpx, rpy);
          const cx = bdx;
          const cy = bdy;
          for (let dy = Math.max(dyMin, cy - 1); dy <= Math.min(dyMax, cy + 1); dy++) {
            for (let dx = Math.max(dxMin, cx - 1); dx <= Math.min(dxMax, cx + 1); dx++) tryAt(dx, dy);
          }

          // Sub-pixel refinement (parabola through the neighbours).
          let fx = bdx;
          let fy = bdy;
          if (bdx > dxMin && bdx < dxMax) {
            const l = sad(prev, cur, x0, y0, bdx - 1, bdy, Infinity);
            const r = sad(prev, cur, x0, y0, bdx + 1, bdy, Infinity);
            const den = l - 2 * best + r;
            if (den > 0) fx += Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den)));
          }
          if (bdy > dyMin && bdy < dyMax) {
            const u = sad(prev, cur, x0, y0, bdx, bdy - 1, Infinity);
            const d = sad(prev, cur, x0, y0, bdx, bdy + 1, Infinity);
            const den = u - 2 * best + d;
            if (den > 0) fy += Math.max(-0.5, Math.min(0.5, (u - d) / (2 * den)));
          }

          // Confidence: how much better the match is than "no motion", and
          // whether the block has enough texture to trust it.
          const gain = (sad0 - best) / sad0;
          const conf = Math.max(0, Math.min(1, gain * 1.5)) * Math.min(1, tex / 8);
          prior[k] = fx;
          prior[k + 1] = fy;
          feat[k] = fx * conf;
          feat[k + 1] = fy * conf;
        }
      }
      return { feat, meanDiff };
    }

    return { estimate, bw, bh, nb, w, h, block: B };
  }

  // -------------------------------------------------------------- analysis --

  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  /** Top eigenvector of a symmetric n x n matrix (row-major Float64Array). */
  function topEigen(G, n) {
    let u = new Float64Array(n);
    for (let i = 0; i < n; i++) u[i] = 1 + 0.01 * Math.sin(i * 1.7); // deterministic start
    let lambda = 0;
    for (let it = 0; it < 60; it++) {
      const nu = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const row = i * n;
        for (let j = 0; j < n; j++) s += G[row + j] * u[j];
        nu[i] = s;
      }
      let norm = 0;
      for (let i = 0; i < n; i++) norm += nu[i] * nu[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) return { u, lambda: 0 };
      for (let i = 0; i < n; i++) nu[i] /= norm;
      const prevLambda = lambda;
      lambda = norm;
      u = nu;
      if (it > 5 && Math.abs(lambda - prevLambda) < 1e-9 * lambda) break;
    }
    return { u, lambda };
  }

  /**
   * Strongest coherent motion in a window of feature vectors.
   * Returns per-sample velocity (px per sample, block-average), the sign
   * convention value, and the fraction of motion energy it explains.
   */
  function windowComponent(feat, a, b) {
    const n = b - a;
    const F = feat[a].length;
    // Column means over the window (removes steady pans / drift).
    const mean = new Float64Array(F);
    for (let i = a; i < b; i++) {
      const f = feat[i];
      for (let k = 0; k < F; k++) mean[k] += f[k];
    }
    for (let k = 0; k < F; k++) mean[k] /= n;
    // Only columns that move at all.
    const active = [];
    for (let k = 0; k < F; k++) {
      let e = 0;
      for (let i = a; i < b; i++) e += Math.abs(feat[i][k] - mean[k]);
      if (e > 1e-3) active.push(k);
    }
    const out = { v: new Float64Array(n), convention: 1, coherence: 0 };
    if (!active.length) return out;
    // rows: samples, cols: active features
    const rows = [];
    for (let i = a; i < b; i++) {
      const r = new Float64Array(active.length);
      for (let c = 0; c < active.length; c++) r[c] = feat[i][active[c]] - mean[active[c]];
      rows.push(r);
    }
    // Gram matrix (n x n) is much smaller than the covariance (F x F).
    const G = new Float64Array(n * n);
    let trace = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let s = 0;
        const ri = rows[i];
        const rj = rows[j];
        for (let c = 0; c < ri.length; c++) s += ri[c] * rj[c];
        G[i * n + j] = s;
        G[j * n + i] = s;
      }
      trace += G[i * n + i];
    }
    if (trace < 1e-9) return out;
    const { u, lambda } = topEigen(G, n);
    if (lambda <= 0) return out;
    const sq = Math.sqrt(lambda);
    // Loadings (unit vector over active features).
    const load = new Float64Array(active.length);
    for (let c = 0; c < active.length; c++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rows[i][c] * u[i];
      load[c] = s / sq;
    }
    // Per-block loading magnitude -> effective number of blocks involved, so
    // the output is a per-block velocity rather than growing with area.
    const mag = new Map();
    let sy = 0;
    let sx = 0;
    for (let c = 0; c < active.length; c++) {
      const k = active[c];
      const b2 = k >> 1;
      mag.set(b2, (mag.get(b2) || 0) + load[c] * load[c]);
      if (k & 1) sy += load[c] * Math.abs(load[c]);
      else sx += load[c] * Math.abs(load[c]);
    }
    let sumMag = 0;
    for (const m of mag.values()) sumMag += Math.sqrt(m);
    const kEff = Math.max(1, sumMag * sumMag);
    const scale = sq / Math.sqrt(kEff);
    // Convention: positive velocity = the moving area goes DOWN in the image
    // (or right, for mostly horizontal motion).
    const convention = Math.abs(sy) >= 0.5 * Math.abs(sx) ? Math.sign(sy) || 1 : Math.sign(sx) || 1;
    for (let i = 0; i < n; i++) out.v[i] = u[i] * scale * convention;
    out.convention = convention;
    out.coherence = lambda / trace;
    return out;
  }

  /**
   * @param {{t:number[], feat:Float32Array[], cut:boolean[]}} samples
   *   t: media time in seconds; feat[i]: motion between sample i-1 and i
   *   (feat[0] is ignored); cut[i]: scene cut between i-1 and i.
   * @returns {{t:number[], v:number[], q:number[], seg:number[]}}
   */
  function analyze(samples, opts) {
    const o = Object.assign({ windowSec: 3, gapSec: 0.6 }, opts);
    const { t, feat, cut } = samples;
    const N = t.length;
    const res = { t: [], v: [], q: [], seg: [] };
    if (N < 4) return res;

    // Segment boundaries: scene cuts and time gaps (seeks, stalls).
    const starts = [1];
    for (let i = 2; i < N; i++) {
      if (cut[i] || t[i] - t[i - 1] > o.gapSec || t[i] < t[i - 1]) starts.push(i + 1);
    }
    starts.push(N + 1);

    let segId = 0;
    for (let s = 0; s < starts.length - 1; s++) {
      const a = starts[s];
      const b = Math.min(starts[s + 1] - 1, N); // samples a..b-1 hold valid motion
      const n = b - a;
      if (n < 6) continue;
      const dts = [];
      for (let i = a; i < b; i++) dts.push(t[i] - t[i - 1]);
      const dt = Math.max(1e-3, median(dts));
      let W = Math.max(8, Math.round(o.windowSec / dt));
      if (W > n) W = n;
      const hop = Math.max(1, Math.floor(W / 2));
      const V = new Float64Array(n);
      const Q = new Float64Array(n);
      const Wt = new Float64Array(n);

      const winStarts = [];
      for (let w0 = 0; w0 + W <= n; w0 += hop) winStarts.push(w0);
      if (winStarts[winStarts.length - 1] + W < n) winStarts.push(n - W);

      for (const w0 of winStarts) {
        const comp = windowComponent(feat, a + w0, a + w0 + W);
        let sign = 1;
        // Align with what is already accumulated in the overlap.
        let dot = 0;
        let na = 0;
        let nbb = 0;
        for (let i = 0; i < W; i++) {
          if (Wt[w0 + i] > 0) {
            const acc = V[w0 + i] / Wt[w0 + i];
            dot += acc * comp.v[i];
            na += acc * acc;
            nbb += comp.v[i] * comp.v[i];
          }
        }
        if (na > 0 && nbb > 0) {
          const corr = dot / Math.sqrt(na * nbb);
          if (Math.abs(corr) > 0.3) sign = Math.sign(corr);
        }
        for (let i = 0; i < W; i++) {
          const wgt = 0.1 + 0.9 * Math.pow(Math.sin((Math.PI * (i + 0.5)) / W), 2);
          V[w0 + i] += wgt * sign * comp.v[i];
          Q[w0 + i] += wgt * comp.coherence;
          Wt[w0 + i] += wgt;
        }
      }
      for (let i = 0; i < n; i++) {
        if (!(Wt[i] > 0)) continue;
        res.t.push(t[a + i]);
        res.v.push(V[i] / Wt[i]);
        res.q.push(Q[i] / Wt[i]);
        res.seg.push(segId);
      }
      segId++;
    }
    return res;
  }

  // ---------------------------------------------------------- script gen --

  const DEFAULT_PARAMS = {
    minPos: 0,
    maxPos: 100,
    sensitivity: 0.5, // 0..1, higher = smaller movements become strokes
    smoothing: 0.4, // 0..1
    invert: false,
    maxSpeed: 500, // position units per second
    minStrokeMs: 110,
  };

  function movingAverage(x, half) {
    const n = x.length;
    const out = new Float64Array(n);
    if (half < 1) {
      out.set(x);
      return out;
    }
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n, i + half + 1);
      out[i] = (pre[hi] - pre[lo]) / (hi - lo);
    }
    return out;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[idx];
  }

  /** Turning points of one segment's position signal. */
  function extremaForSegment(t, x, params, dt) {
    const sens = params.sensitivity;
    const sq = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) sq[i] = x[i] * x[i];
    const rms = movingAverage(sq, Math.round(1.5 / dt)).map(Math.sqrt);
    const factor = 1.7 - 1.4 * sens; // reversal needed, in local RMS units
    const absMin = 0.25 + 1.0 * (1 - sens); // px; below this it's noise
    const minGap = params.minStrokeMs / 1000;

    const ext = [];
    let dir = 0; // +1 rising, -1 falling
    let hiI = 0;
    let loI = 0;
    for (let i = 1; i < x.length; i++) {
      const thr = Math.max(absMin, factor * rms[i]);
      if (x[i] > x[hiI]) hiI = i;
      if (x[i] < x[loI]) loI = i;
      if (dir >= 0 && x[hiI] - x[i] > thr) {
        if (dir === 0) ext.push({ i: loI, type: -1 });
        ext.push({ i: hiI, type: 1 });
        dir = -1;
        loI = i;
      } else if (dir <= 0 && x[i] - x[loI] > thr) {
        if (dir === 0) ext.push({ i: hiI, type: 1 });
        ext.push({ i: loI, type: -1 });
        dir = 1;
        hiI = i;
      }
    }
    // Close the final half stroke.
    if (dir === 1) ext.push({ i: hiI, type: 1 });
    else if (dir === -1) ext.push({ i: loI, type: -1 });

    // Sort (the initial pair can be out of order) and enforce alternation and
    // a minimum stroke duration.
    ext.sort((p, q) => p.i - q.i);
    const clean = [];
    for (const e of ext) {
      const last = clean[clean.length - 1];
      if (last && last.type === e.type) {
        if ((e.type === 1 && x[e.i] > x[last.i]) || (e.type === -1 && x[e.i] < x[last.i])) clean[clean.length - 1] = e;
        continue;
      }
      if (last && t[e.i] - t[last.i] < minGap) {
        // Too quick: drop this pair if it is a tiny wiggle.
        const prev = clean[clean.length - 2];
        if (prev) {
          clean.pop();
          if ((prev.type === 1 && x[e.i] > x[prev.i]) || (prev.type === -1 && x[e.i] < x[prev.i])) {
            clean[clean.length - 1] = { i: e.i, type: e.type };
          }
          continue;
        }
      }
      clean.push(e);
    }
    return clean.map((e) => ({ t: t[e.i], x: x[e.i], type: e.type }));
  }

  /**
   * @param {{t:number[], v:number[], seg:number[]}} signal from analyze()
   * @returns {{at:number,pos:number}[]}
   */
  function generateActions(signal, userParams) {
    const p = Object.assign({}, DEFAULT_PARAMS, userParams);
    const fs = HAI.funscript || (typeof require === 'function' ? require('./funscript.js') : null);
    const lo = Math.min(p.minPos, p.maxPos);
    const hi = Math.max(p.minPos, p.maxPos);
    const actions = [];
    const n = signal.t.length;
    let s0 = 0;
    while (s0 < n) {
      let s1 = s0;
      while (s1 < n && signal.seg[s1] === signal.seg[s0]) s1++;
      const t = signal.t.slice(s0, s1);
      const v = signal.v.slice(s0, s1);
      s0 = s1;
      if (t.length < 6) continue;
      const dts = [];
      for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
      const dt = Math.max(1e-3, median(dts));

      // Position = integrated velocity. Image-down motion means stroke down,
      // i.e. a lower funscript position.
      const sign = p.invert ? 1 : -1;
      const x0 = new Float64Array(t.length);
      let acc = 0;
      for (let i = 0; i < t.length; i++) {
        acc += sign * v[i];
        x0[i] = acc;
      }
      const smoothHalf = Math.round((p.smoothing * 0.12) / dt);
      const xs = movingAverage(x0, smoothHalf);
      const trend = movingAverage(xs, Math.round(1.0 / dt));
      const x = xs.map((val, i) => val - trend[i]);

      const ext = extremaForSegment(t, x, p, dt);
      if (ext.length < 2) continue;

      // Map turning points onto the stroke range using the local extent of
      // nearby strokes, so quiet passages still use most of the range but
      // relative depth inside a passage is kept.
      for (let k = 0; k < ext.length; k++) {
        const e = ext[k];
        const peaks = [];
        const valleys = [];
        for (let j = Math.max(0, k - 8); j < Math.min(ext.length, k + 9); j++) {
          if (Math.abs(ext[j].t - e.t) > 4) continue;
          (ext[j].type === 1 ? peaks : valleys).push(ext[j].x);
        }
        const top = peaks.length ? percentile(peaks, 0.8) : e.x;
        const bot = valleys.length ? percentile(valleys, 0.2) : e.x;
        let rel;
        if (top - bot < 1e-6) rel = e.type === 1 ? 1 : 0;
        else rel = (e.x - bot) / (top - bot);
        // Keep turning points on their side of the range.
        rel = e.type === 1 ? Math.max(0.55, Math.min(1, rel)) : Math.max(0, Math.min(0.45, rel));
        actions.push({ at: Math.round(e.t * 1000), pos: lo + rel * (hi - lo) });
      }
      // Hold the last position until the next segment rather than drifting.
    }

    // Long pauses between strokes: hold position, then move.
    const held = [];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const prev = held[held.length - 1];
      if (prev && a.at - prev.at > 2000) held.push({ at: a.at - 600, pos: prev.pos });
      held.push(a);
    }
    const limited = fs ? fs.limitSpeed(held, p.maxSpeed) : held;
    return fs ? fs.normalizeActions(limited) : limited;
  }

  /** Compact JSON-friendly copy of a signal for storage. */
  function packSignal(sig) {
    return {
      t: sig.t.map((x) => Math.round(x * 1000)),
      v: sig.v.map((x) => Math.round(x * 1000) / 1000),
      seg: sig.seg.slice(),
    };
  }
  function unpackSignal(p) {
    return { t: p.t.map((x) => x / 1000), v: p.v.slice(), seg: p.seg.slice(), q: [] };
  }

  const api = {
    toGray,
    createMotionEstimator,
    analyze,
    generateActions,
    packSignal,
    unpackSignal,
    DEFAULT_PARAMS,
    _internal: { windowComponent, topEigen, movingAverage, extremaForSegment },
  };
  HAI.motion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
