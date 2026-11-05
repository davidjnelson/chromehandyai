/*
 * Real-time tracking: turns frame-by-frame motion into strokes while the
 * video plays, with no pre-scan.
 *
 *   tracker = createLiveTracker()
 *     push(t, feat, cut) for every analysed frame (causal: only past frames).
 *     Runs the same PCA as the offline analysis over a trailing ~2 s window,
 *     integrates velocity to a position, high-passes it and detects turning
 *     points with an adaptive zig-zag. Returns { x, extreme } where extreme
 *     is a confirmed turning point (time of the actual extreme, not of its
 *     confirmation).
 *
 *   rhythm = createRhythm()
 *     onExtreme(e) with each confirmed turning point; predict(t) gives the
 *     next turning point after media time t, from the recent stroke tempo.
 *     The device is driven from these predictions so it arrives at each end
 *     of the stroke together with the video despite network latency.
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});
  const motion = HAI.motion || (typeof require === 'function' ? require('./motion.js') : null);
  const { windowComponent } = motion._internal;

  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[s.length >> 1];
  }

  function createLiveTracker(opts) {
    const o = Object.assign({ windowSec: 2, sensitivity: 0.5, hpSec: 1.0, rmsSec: 2.0 }, opts);
    let buf; // [{t, feat}]
    let outV; // latest velocity estimate for each buffered sample (sign-aligned)
    let x;
    let ema;
    let rms2;
    let dir;
    let hi;
    let lo;
    let lastT;
    let started;

    function reset() {
      buf = [];
      outV = [];
      x = 0;
      ema = 0;
      rms2 = 0;
      dir = 0;
      hi = null;
      lo = null;
      lastT = -1;
      started = 0;
    }
    reset();

    function push(t, feat, cut) {
      if (cut || lastT < 0 || t < lastT || t - lastT > 0.6) {
        reset();
        started = t;
      }
      const dt = lastT < 0 ? 0 : t - lastT;
      lastT = t;
      buf.push({ t, feat });
      while (buf.length && t - buf[0].t > o.windowSec) {
        buf.shift();
        outV.shift();
      }
      const n = buf.length;
      if (n < 8) {
        outV.push(0);
        return { x: 0, extreme: null, warm: false };
      }
      const feats = buf.map((b) => b.feat);
      const comp = windowComponent(feats, 0, n);
      // Keep the sign consistent with what was output for the same frames.
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < n - 1; i++) {
        dot += outV[i] * comp.v[i];
        na += outV[i] * outV[i];
        nb += comp.v[i] * comp.v[i];
      }
      let sign = 1;
      if (na > 0 && nb > 0 && Math.abs(dot / Math.sqrt(na * nb)) > 0.2) sign = Math.sign(dot);
      outV = Array.from(comp.v, (v) => v * sign);
      const v = outV[n - 1];

      // Position (funscript direction: image-down = lower position).
      x -= v;
      if (dt > 0) {
        ema += (x - ema) * Math.min(1, dt / o.hpSec);
      }
      const xh = x - ema;
      if (dt > 0) rms2 += (xh * xh - rms2) * Math.min(1, dt / o.rmsSec);
      const rms = Math.sqrt(rms2);

      // Adaptive zig-zag, same thresholds as the offline generator.
      const sens = o.sensitivity;
      const thr = Math.max(0.25 + 1.0 * (1 - sens), (1.7 - 1.4 * sens) * rms);
      let extreme = null;
      if (!hi || xh > hi.x) hi = { t, x: xh };
      if (!lo || xh < lo.x) lo = { t, x: xh };
      if (t - started > 0.8) {
        if (dir >= 0 && hi.x - xh > thr) {
          extreme = { t: hi.t, x: hi.x, type: 1 };
          dir = -1;
          lo = { t, x: xh };
        } else if (dir <= 0 && xh - lo.x > thr) {
          extreme = { t: lo.t, x: lo.x, type: -1 };
          dir = 1;
          hi = { t, x: xh };
        }
      }
      return { x: xh, rms, extreme, warm: true };
    }

    return {
      push,
      reset,
      setSensitivity(s) {
        o.sensitivity = s;
      },
    };
  }

  /**
   * Stroke rhythm from confirmed turning points.
   * opts: minPos, maxPos (device range)
   */
  function createRhythm(opts) {
    const o = Object.assign({ minPos: 0, maxPos: 100, minHalf: 0.09, maxHalf: 2.5 }, opts);
    let ext = [];
    let refDepth = 0;

    function reset() {
      ext = [];
    }

    function onExtreme(e) {
      const last = ext[ext.length - 1];
      if (last && last.type === e.type) {
        // Same side twice (missed one): keep the more extreme.
        if ((e.type === 1 && e.x > last.x) || (e.type === -1 && e.x < last.x)) ext[ext.length - 1] = e;
        return;
      }
      if (last && e.t - last.t < o.minHalf) return;
      ext.push(e);
      if (ext.length > 12) ext.shift();
      const d = depth();
      if (d > 0) refDepth = Math.max(d, refDepth * 0.97);
    }

    /**
     * Half a stroke cycle, from full cycles (top->top, bottom->bottom) so a
     * detection bias on one side cancels out; trimmed mean because frame
     * timing quantises individual intervals.
     */
    function halfPeriod() {
      const iv = [];
      for (let i = 2; i < ext.length; i++) {
        const d = (ext[i].t - ext[i - 2].t) / 2;
        if (d >= o.minHalf && d <= o.maxHalf) iv.push(d);
      }
      if (iv.length < 2) {
        for (let i = 1; i < ext.length; i++) {
          const d = ext[i].t - ext[i - 1].t;
          if (d >= o.minHalf && d <= o.maxHalf) iv.push(d);
        }
      }
      if (iv.length < 2) return 0;
      const recent = iv.slice(-8).sort((a, b) => a - b);
      const trimmed = recent.length >= 4 ? recent.slice(1, -1) : recent;
      return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    }

    function depth() {
      const ds = [];
      for (let i = 1; i < ext.length; i++) ds.push(Math.abs(ext[i].x - ext[i - 1].x));
      return median(ds.slice(-6));
    }

    function posFor(type) {
      const lo = Math.min(o.minPos, o.maxPos);
      const hi = Math.max(o.minPos, o.maxPos);
      const mid = (lo + hi) / 2;
      const half = (hi - lo) / 2;
      const rel = refDepth > 0 ? Math.max(0.4, Math.min(1, depth() / refDepth)) : 1;
      return Math.round(type === 1 ? mid + rel * half : mid - rel * half);
    }

    /** Next turning point strictly after media time t, or null if no rhythm. */
    function predict(t) {
      const H = halfPeriod();
      const last = ext[ext.length - 1];
      if (!H || !last) return null;
      if (t - last.t > 2.5 * H + 0.6) return null; // motion stopped
      let k = Math.max(1, Math.ceil((t - last.t) / H + 1e-9));
      let at = last.t + k * H;
      if (at <= t) {
        k++;
        at += H;
      }
      const type = k % 2 === 1 ? -last.type : last.type;
      return { t: at, type, pos: posFor(type), halfPeriod: H };
    }

    return {
      onExtreme,
      predict,
      reset,
      halfPeriod,
      posFor,
      get extremes() {
        return ext;
      },
      setRange(minPos, maxPos) {
        o.minPos = minPos;
        o.maxPos = maxPos;
      },
    };
  }

  const api = { createLiveTracker, createRhythm };
  HAI.live = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
