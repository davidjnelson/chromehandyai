/*
 * Real-time mode controller: analyses the video while it plays at normal
 * speed and drives the device ahead of time from the predicted rhythm.
 * No pre-scan; seeking anywhere just re-locks within a couple of seconds.
 *
 * createLiveEngine({ onMove(position, durationMs), onStatus(text), cloneHost,
 *                    getParams() -> {minPos, maxPos, sensitivity, maxSpeed},
 *                    getLatencyMs() -> ms from sending a command to the device moving })
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});
  const { motion, live, scanner } = HAI;

  const FRAME_W = 128;
  const MIN_GAP = 1 / 24; // analyse at most ~24 frames per second of video
  const CUT_DIFF = 30;

  function createLiveEngine(hooks) {
    let video = null; // the page's player (clock + controls)
    let src = null; // what we read pixels from (player, or a CORS copy)
    let clone = null;
    let cloneTimer = 0;
    let stopLoop = null;
    let canvas = null;
    let ctx = null;
    let est = null;
    let prev = null;
    let lastT = -1;
    let enabled = false;
    let failed = '';
    let timer = 0;
    let lastSent = null;
    let lastPos = 50;
    let history = []; // recent turning points {at, pos} for the graph
    let statusAt = 0;
    // Diagnostics: are frames arriving, and do they contain a picture?
    let lastFrameWall = 0;
    let goodFrames = 0;
    let blankFrames = 0;
    let watchdog = 0;
    const tracker = live.createLiveTracker();
    const rhythm = live.createRhythm();

    function status(text, force) {
      const now = Date.now();
      if (!force && now - statusAt < 700) return;
      statusAt = now;
      hooks.onStatus && hooks.onStatus(text);
    }

    function resetTracking() {
      tracker.reset();
      rhythm.reset();
      prev = null;
      lastT = -1;
      lastSent = null;
      history = [];
      clearTimeout(timer);
    }

    function setupCanvas(v) {
      const vw = v.videoWidth || 16;
      const vh = v.videoHeight || 9;
      const h = Math.max(32, Math.round((FRAME_W * vh) / vw / 8) * 8);
      if (canvas && canvas.height === h) return;
      canvas = document.createElement('canvas');
      canvas.width = FRAME_W;
      canvas.height = h;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      est = motion.createMotionEstimator(FRAME_W, h);
      prev = null;
    }

    function onFrame(t) {
      if (!enabled || !src) return;
      if (lastT >= 0 && t >= lastT && t - lastT < MIN_GAP) return;
      if (!src.videoWidth) return;
      setupCanvas(src);
      let img;
      try {
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
        img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (e) {
        if (e && e.name === 'SecurityError' && src === video) return useClone();
        return;
      }
      const gray = motion.toGray(img.data, new Uint8Array(canvas.width * canvas.height));
      lastFrameWall = Date.now();
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < gray.length; i += 7) {
        if (gray[i] < lo) lo = gray[i];
        if (gray[i] > hi) hi = gray[i];
      }
      if (hi - lo < 6) {
        // Browser handed us an empty (black/flat) picture.
        blankFrames++;
        if (!goodFrames && blankFrames > 40) {
          failed = 'Real-time · this browser gives a blank video picture, so motion can’t be seen. Pre-scan won’t work either; try Import.';
          status(failed, true);
        }
        return;
      }
      goodFrames++;
      if (!prev) {
        prev = gray;
        lastT = t;
        tracker.push(t, new Float32Array(est.nb * 2), true);
        return;
      }
      const r = est.estimate(prev, gray);
      if (r.meanDiff < 0.05) return; // repeated frame
      prev = gray;
      const cut = r.meanDiff > CUT_DIFF;
      if (cut) rhythm.reset();
      lastT = t;
      const p = hooks.getParams();
      tracker.setSensitivity(p.sensitivity);
      rhythm.setRange(p.minPos, p.maxPos);
      const out = tracker.push(t, r.feat, cut);
      if (out.extreme) {
        rhythm.onExtreme(out.extreme);
        history.push({ at: Math.round(out.extreme.t * 1000), pos: rhythm.posFor(out.extreme.type) });
        if (history.length > 40) history.shift();
        plan(false);
      }
      const H = rhythm.halfPeriod();
      if (H && rhythm.predict(t)) status('Real-time · tracking ' + (1 / (2 * H)).toFixed(1) + ' strokes/s');
      else status(out.warm ? 'Real-time · looking for a rhythm…' : 'Real-time · warming up…');
    }

    /**
     * Send the device toward the next predicted turning point so that it
     * arrives when the video does. Re-runs when each one is reached and
     * whenever a new turning point refines the prediction.
     */
    function plan(fromTimer) {
      clearTimeout(timer);
      if (!enabled || !video || video.paused || video.seeking) return;
      const rate = video.playbackRate || 1;
      const now = video.currentTime;
      const L = Math.max(0, hooks.getLatencyMs());
      let after = now + (L / 1000) * rate;
      if (fromTimer && lastSent) after = Math.max(after, lastSent.t + 0.01);
      const p = rhythm.predict(after);
      if (!p) {
        lastSent = null;
        return;
      }
      const untilMs = ((p.t - now) / rate) * 1000;
      const same = lastSent && lastSent.type === p.type && Math.abs(lastSent.t - p.t) < 0.12;
      if (!same) {
        const params = hooks.getParams();
        let duration = untilMs - L;
        const travel = Math.abs(p.pos - lastPos);
        duration = Math.max(duration, 60, (travel / Math.max(50, params.maxSpeed)) * 1000);
        hooks.onMove && hooks.onMove(p.pos, duration);
        lastSent = p;
        lastPos = p.pos;
      }
      // Next decision just before the device reaches this target.
      timer = setTimeout(() => plan(true), Math.max(30, untilMs - L));
    }

    function startLoop() {
      if (stopLoop || !src) return;
      stopLoop = scanner.frameLoop(src, onFrame);
    }
    function stopLoopNow() {
      if (stopLoop) stopLoop();
      stopLoop = null;
    }

    /** Page player can't be read (cross-origin): follow it with a CORS copy. */
    function useClone() {
      stopLoopNow();
      const url = video.currentSrc || video.src;
      if (!/^https?:/i.test(url)) {
        failed = 'Real-time: this video can’t be analysed (protected stream).';
        status(failed, true);
        return;
      }
      clone = document.createElement('video');
      clone.crossOrigin = 'anonymous';
      clone.muted = true;
      clone.playsInline = true;
      clone.setAttribute('playsinline', '');
      clone.preload = 'auto';
      clone.style.cssText = 'width:100%;max-height:90px;display:block;border-radius:6px;background:#000';
      clone.addEventListener('error', () => {
        failed = 'Real-time: the video server blocks frame access. Try Import instead.';
        status(failed, true);
        dropClone();
      });
      (hooks.cloneHost || document.body).appendChild(clone);
      clone.src = url;
      src = clone;
      followClone();
      cloneTimer = setInterval(followClone, 1000);
      startLoop();
    }
    function followClone() {
      if (!clone || !video) return;
      if (Math.abs(clone.playbackRate - video.playbackRate) > 0.01) clone.playbackRate = video.playbackRate;
      if (Math.abs(clone.currentTime - video.currentTime) > 0.3) {
        clone.currentTime = video.currentTime;
        resetTracking();
      }
      if (video.paused && !clone.paused) clone.pause();
      if (!video.paused && clone.paused && enabled) clone.play().catch(() => {});
    }
    function dropClone() {
      clearInterval(cloneTimer);
      if (clone) {
        clone.removeAttribute('src');
        clone.load();
        clone.remove();
      }
      clone = null;
      src = video;
    }

    function onEvent(e) {
      if (!enabled) return;
      switch (e.type) {
        case 'seeking':
          resetTracking();
          if (clone) followClone();
          status('Real-time · re-locking…', true);
          break;
        case 'pause':
        case 'ended':
        case 'waiting':
          clearTimeout(timer);
          lastSent = null;
          if (clone) followClone();
          break;
        case 'playing':
        case 'play':
          if (clone) followClone();
          startLoop();
          plan(false);
          break;
        case 'ratechange':
          if (clone) followClone();
          plan(false);
          break;
        default:
      }
    }
    const EVENTS = ['seeking', 'pause', 'ended', 'waiting', 'playing', 'play', 'ratechange'];

    return {
      attach(v) {
        this.detach();
        clearInterval(watchdog);
        watchdog = setInterval(() => {
          if (!enabled || !video || video.paused || video.seeking || failed) return;
          if (Date.now() - lastFrameWall > 4000 && video.currentTime > 1) {
            status('Real-time · not receiving video frames from the browser (' + (goodFrames + blankFrames) + ' so far).', true);
          }
        }, 2000);
        video = v;
        src = v;
        failed = '';
        resetTracking();
        if (v) EVENTS.forEach((ev) => v.addEventListener(ev, onEvent));
        if (enabled && v) startLoop();
      },
      detach() {
        stopLoopNow();
        dropClone();
        if (video) EVENTS.forEach((ev) => video.removeEventListener(ev, onEvent));
        video = null;
        src = null;
        resetTracking();
      },
      setEnabled(on) {
        if (on === enabled) return;
        enabled = on;
        if (on && video) {
          resetTracking();
          startLoop();
          if (clone) followClone();
          status(failed || (video.paused ? 'Real-time · press play' : 'Real-time · warming up…'), true);
        } else {
          stopLoopNow();
          clearTimeout(timer);
          if (clone) clone.pause();
        }
      },
      get enabled() {
        return enabled;
      },
      get failed() {
        return failed;
      },
      /** Recent and upcoming turning points, for the graph. */
      actions() {
        const out = history.slice();
        if (lastSent) out.push({ at: Math.round(lastSent.t * 1000), pos: lastSent.pos });
        return out;
      },
    };
  }

  HAI.createLiveEngine = createLiveEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
