/*
 * Scans a <video> by playing it fast and muted, sampling frames with
 * requestVideoFrameCallback, and feeding them to the motion estimator.
 *
 * Frame pixels can only be read if the video is not "tainted" (cross-origin
 * without CORS). Pornhub normally streams through Media Source Extensions,
 * which is readable. If the page's player is tainted we scan a hidden copy
 * loaded with crossOrigin="anonymous"; a declarativeNetRequest rule adds the
 * CORS header for Pornhub's CDN so that copy is readable.
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});
  const motion = HAI.motion;

  const FRAME_W = 128;
  const MIN_SAMPLE_GAP = 1 / 32; // seconds of media time
  const CUT_DIFF = 30; // mean abs luma difference that counts as a scene cut
  const TARGET_DT = 1 / 14; // want at least ~14 samples per second of video

  class TaintedError extends Error {}
  class CancelledError extends Error {}

  function frameLoop(video, cb) {
    let stopped = false;
    if (typeof video.requestVideoFrameCallback === 'function') {
      let id = 0;
      const step = (now, meta) => {
        if (stopped) return;
        cb(meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : video.currentTime);
        if (!stopped) id = video.requestVideoFrameCallback(step);
      };
      id = video.requestVideoFrameCallback(step);
      return () => {
        stopped = true;
        video.cancelVideoFrameCallback(id);
      };
    }
    let last = -1;
    let raf = 0;
    const tick = () => {
      if (stopped) return;
      if (video.currentTime !== last) {
        last = video.currentTime;
        cb(last);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }

  function once(target, events, timeoutMs) {
    return new Promise((resolve, reject) => {
      const list = [].concat(events);
      let timer = 0;
      const done = (e) => {
        list.forEach((ev) => target.removeEventListener(ev, done));
        clearTimeout(timer);
        if (e && e.type === 'error') reject(new Error('Video failed to load'));
        else resolve(e);
      };
      list.forEach((ev) => target.addEventListener(ev, done));
      if (timeoutMs) timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  /**
   * Core loop over one video element.
   * @returns {Promise<{t:number[], feat:Float32Array[], cut:boolean[]}>}
   */
  function runScan(video, { rate, from, to, onProgress, abort }) {
    return new Promise((resolve, reject) => {
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      const h = Math.max(32, Math.round((FRAME_W * vh) / vw / 8) * 8);
      const canvas = document.createElement('canvas');
      canvas.width = FRAME_W;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const est = motion.createMotionEstimator(FRAME_W, h);
      const samples = { t: [], feat: [], cut: [] };
      let prev = null;
      let lastT = -1;
      let lastProgressAt = Date.now();
      let finished = false;
      const recentDt = [];
      let reseeking = false;

      const finish = (err) => {
        if (finished) return;
        finished = true;
        stopLoop();
        clearInterval(watchdog);
        document.removeEventListener('visibilitychange', onVis);
        video.removeEventListener('ended', onEnded);
        abort.removeEventListener('abort', onAbort);
        video.pause();
        if (err) reject(err);
        else resolve(samples);
      };

      const onFrame = (t) => {
        if (finished) return;
        if (t < from - 0.05) return;
        if (t >= to) return finish();
        if (lastT >= 0 && t - lastT < MIN_SAMPLE_GAP && t >= lastT - 0.001) return;
        if (lastT >= 0 && t < lastT && t > lastT - 0.25) return; // re-seek landed a frame early
        if (reseeking) return;
        let img;
        try {
          ctx.drawImage(video, 0, 0, FRAME_W, h);
          img = ctx.getImageData(0, 0, FRAME_W, h);
        } catch (e) {
          if (e && e.name === 'SecurityError') return finish(new TaintedError('tainted'));
          return finish(e);
        }
        const gray = motion.toGray(img.data, new Uint8Array(FRAME_W * h));
        if (prev) {
          const r = est.estimate(prev, gray);
          if (r.meanDiff < 0.05) return; // repeated frame: no new information
          samples.t.push(t);
          samples.feat.push(r.feat);
          samples.cut.push(r.meanDiff > CUT_DIFF || t < lastT);
        } else {
          samples.t.push(t);
          samples.feat.push(new Float32Array(est.nb * 2));
          samples.cut.push(true);
        }
        // Adaptive speed: if the device can't present enough frames at this
        // rate (slow phone, dropped frames), halve it. Changing rate makes
        // Chromium briefly deliver frames out of order, so let it settle and
        // start a new segment afterwards.
        if (lastT >= 0 && t > lastT) {
          recentDt.push(t - lastT);
          if (recentDt.length >= 24) {
            const med = recentDt.slice().sort((x, y) => x - y)[12];
            recentDt.length = 0;
            if (med > TARGET_DT * 1.3 && video.playbackRate > 1) {
              // Pause, slow down, step back to the last sampled frame and
              // resume, so motion stays continuous across the switch.
              reseeking = true;
              video.pause();
              video.playbackRate = Math.max(1, video.playbackRate / 2);
              const resume = () => {
                video.removeEventListener('seeked', resume);
                reseeking = false;
                lastProgressAt = Date.now();
                if (!finished && !document.hidden) video.play().catch(() => {});
              };
              video.addEventListener('seeked', resume);
              video.currentTime = lastT;
              return;
            }
          }
        }
        prev = gray;
        lastT = t;
        lastProgressAt = Date.now();
        onProgress && onProgress(Math.min(1, (t - from) / Math.max(0.1, to - from)), t);
        // Stop just before the end so the site's "autoplay next video" never fires.
        if (t >= to - 0.25) finish();
      };

      const onEnded = () => finish();
      const onAbort = () => {
        // Keep what was scanned so far if it is worth anything.
        const err = new CancelledError('cancelled');
        err.partial = samples.t.length > 30 ? samples : null;
        finish(err);
      };
      // Frame callbacks stop in background tabs; pause instead of skipping.
      const onVis = () => {
        if (document.hidden) video.pause();
        else video.play().catch(() => {});
      };
      const watchdog = setInterval(() => {
        if (!document.hidden && !video.paused && Date.now() - lastProgressAt > 25000) {
          finish(new Error('Video stopped loading during the scan. Try a lower scan speed.'));
        } else if (!document.hidden && video.paused && !finished && !reseeking) {
          video.play().catch(() => {});
        }
      }, 1000);

      video.addEventListener('ended', onEnded);
      document.addEventListener('visibilitychange', onVis);
      abort.addEventListener('abort', onAbort);
      const stopLoop = frameLoop(video, onFrame);
      video.playbackRate = rate;
      video.play().catch((e) => finish(new Error('Could not play the video: ' + e.message)));
    });
  }

  /** Display refresh rate, to pick a scan speed the screen can keep up with. */
  function measureFps(ms) {
    return new Promise((resolve) => {
      let n = 0;
      const start = performance.now();
      const tick = (now) => {
        n++;
        if (now - start < ms) requestAnimationFrame(tick);
        else resolve((n * 1000) / (now - start));
      };
      requestAnimationFrame(tick);
      setTimeout(() => resolve(Math.max(n, 1) * (1000 / ms)), ms + 300);
    });
  }

  /** Fastest rate (power of two, <= max) that still gives TARGET_DT sampling. */
  function pickRate(maxRate, fps, videoFps) {
    const presentable = Math.min(fps, 240);
    let rate = 1;
    while (rate * 2 <= maxRate && (rate * 2) / Math.min(presentable, videoFps * rate * 2) <= TARGET_DT) rate *= 2;
    return rate;
  }

  async function seek(video, t) {
    if (Math.abs(video.currentTime - t) < 0.01) return;
    const p = once(video, ['seeked', 'error'], 8000);
    video.currentTime = t;
    await p;
  }

  /** Hidden CORS copy of the video, for when the page's player is tainted. */
  async function makeClone(video, host) {
    const src = video.currentSrc || video.src;
    if (!/^https?:/i.test(src)) throw new Error('This video cannot be analysed (protected stream).');
    const clone = document.createElement('video');
    clone.crossOrigin = 'anonymous';
    clone.muted = true;
    clone.playsInline = true;
    clone.preload = 'auto';
    clone.setAttribute('playsinline', '');
    clone.style.cssText = 'width:100%;max-height:90px;display:block;border-radius:6px;background:#000';
    (host || document.body).appendChild(clone);
    const ready = once(clone, ['loadeddata', 'error'], 20000);
    clone.src = src;
    try {
      await ready;
    } catch (e) {
      clone.remove();
      throw new Error('This video cannot be analysed: its server blocks frame access.');
    }
    if (clone.readyState < 2) {
      clone.remove();
      throw new Error('Timed out loading the video for analysis.');
    }
    return clone;
  }

  /**
   * Scan [from, to) of the video. Restores the player afterwards.
   * opts: { rate, from, to, onProgress(fraction, t), abort: AbortSignal, cloneHost }
   */
  async function scan(video, opts) {
    const o = Object.assign({ rate: 4, from: 0 }, opts);
    const abort = o.abort || new AbortController().signal;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video is not ready yet. Press play once, then try again.');
    const to = Math.min(o.to || duration, duration);

    const saved = {
      time: video.currentTime,
      paused: video.paused,
      muted: video.muted,
      rate: video.playbackRate,
      loop: video.loop,
    };
    const restore = async () => {
      video.pause();
      video.playbackRate = saved.rate;
      video.loop = saved.loop;
      try {
        await seek(video, saved.time);
      } catch (e) {
        /* ignore */
      }
      video.muted = saved.muted;
      if (!saved.paused) video.play().catch(() => {});
    };

    video.muted = true;
    video.loop = false;
    const fps = await measureFps(400);
    const rate = pickRate(o.rate, fps, 30);
    try {
      await seek(video, o.from);
      const samples = await runScan(video, { rate, from: o.from, to, onProgress: o.onProgress, abort });
      await restore();
      return samples;
    } catch (e) {
      await restore();
      if (!(e instanceof TaintedError)) throw e;
    }

    // Fallback: scan a CORS-enabled copy.
    const clone = await makeClone(video, o.cloneHost);
    try {
      await seek(clone, o.from);
      return await runScan(clone, { rate, from: o.from, to, onProgress: o.onProgress, abort });
    } catch (e) {
      if (e instanceof TaintedError) throw new Error('This video cannot be analysed: its server blocks frame access.');
      throw e;
    } finally {
      clone.removeAttribute('src');
      clone.load();
      clone.remove();
    }
  }

  HAI.scanner = { scan, CancelledError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
