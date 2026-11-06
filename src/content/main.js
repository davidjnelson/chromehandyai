/*
 * Content script entry: finds the video, wires the panel, the scanner and
 * the Handy sync together.
 */
(function () {
  'use strict';
  const HAI = globalThis.HAI;
  if (!HAI || window.top !== window || window.__handyAiLoaded) return;
  window.__handyAiLoaded = true;
  const { funscript: fs, motion, scanner, store } = HAI;

  let settings = null;
  let ui = null;
  const cur = {
    id: null,
    video: null,
    rec: null, // stored record
    actions: null,
    scanning: false,
    abort: null,
  };
  const handy = { connected: false, loadedHash: null, loading: null, playing: false, lastError: '', rtt: 0 };
  let liveEngine = null;
  let liveStatus = '';

  // ------------------------------------------------------------ helpers --

  function bg(op, data) {
    return chrome.runtime.sendMessage(Object.assign({ ns: 'handy', op }, data)).then((r) => {
      if (!r) throw new Error('Extension background did not answer. Reload the page.');
      if (!r.ok) throw new Error(r.error || 'Unknown error');
      return r;
    });
  }

  function debounce(fn, ms) {
    let t = 0;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function videoIdFromUrl() {
    const u = new URL(location.href);
    const vk = u.searchParams.get('viewkey');
    if (vk) return vk;
    const m = u.pathname.match(/\/embed\/([^/?#]+)/);
    if (m) return m[1];
    return u.pathname + u.search;
  }

  /** The main player: the largest video element with real media. */
  function findVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      if (ui && ui.cloneHost.contains(v)) continue;
      const r = v.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      const hasMedia = v.currentSrc || v.src || v.querySelector('source');
      if (!hasMedia && v.readyState === 0) continue;
      const score = area * (Number.isFinite(v.duration) && v.duration > 15 ? 2 : 1);
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  function params() {
    return {
      minPos: settings.minPos,
      maxPos: settings.maxPos,
      sensitivity: settings.sensitivity,
      smoothing: settings.smoothing,
      invert: settings.invert,
      maxSpeed: settings.maxSpeed,
    };
  }

  function durationOf(v) {
    return v && Number.isFinite(v.duration) ? v.duration : 0;
  }

  // ------------------------------------------------------------ modes --

  /** A finished script (full scan or import) uses HSSP; otherwise real-time. */
  function hasFullScript() {
    const rec = cur.rec;
    if (!rec || !cur.actions || !cur.actions.length) return false;
    if (rec.imported) return true;
    const dur = durationOf(cur.video) || rec.duration || 0;
    return (rec.scannedTo || 0) >= dur - 1;
  }

  function isLive() {
    return !hasFullScript();
  }

  function updateMode() {
    if (!liveEngine) return;
    liveEngine.setEnabled(!!cur.video && !cur.scanning && isLive());
  }

  // Real-time moves: one request in flight, newer commands replace queued ones.
  let moveBusy = false;
  let moveNext = null;
  function sendMove(m) {
    if (!handy.connected || !isLive()) return;
    if (moveBusy) {
      moveNext = m;
      return;
    }
    const duration = m.duration - (Date.now() - m.created);
    if (duration < 40) return;
    moveBusy = true;
    bg('move', { position: m.position, duration })
      .then(() => {
        handy.moves = (handy.moves || 0) + 1;
        if (handy.lastError || handy.moves === 1) {
          handy.lastError = '';
          ui.setHandyStatus('Moving with the video (real-time)', 'on');
        }
      })
      .catch((e) => {
        handy.lastError = e.message;
        ui.setHandyStatus(e.message, 'err');
      })
      .finally(() => {
        moveBusy = false;
        if (moveNext) {
          const n = moveNext;
          moveNext = null;
          sendMove(n);
        }
      });
  }

  // ------------------------------------------------------------ script --

  function recompute() {
    const rec = cur.rec;
    if (rec && rec.imported) cur.actions = rec.imported;
    else if (rec && rec.signal) cur.actions = motion.generateActions(motion.unpackSignal(rec.signal), params());
    else cur.actions = null;
    updateMode();
    refreshScriptStatus();
    scheduleHandyLoad();
  }

  function refreshScriptStatus() {
    const v = cur.video;
    const dur = durationOf(v) || (cur.rec && cur.rec.duration) || 0;
    const rec = cur.rec;
    const has = !!(cur.actions && cur.actions.length);
    const scannedAll = !!(rec && (rec.imported || (rec.scannedTo || 0) >= dur - 1));
    ui.setHasScript(has, scannedAll);
    ui.setVideoReady(!!v && !cur.scanning);
    if (cur.scanning) return;
    if (!v) return ui.setScriptStatus('Looking for the video…');
    if (isLive()) {
      ui.setScriptStatus((liveEngine && liveEngine.failed) || liveStatus || 'Real-time · press play');
      return;
    }
    if (!has) {
      if (rec && rec.signal) return ui.setScriptStatus('No clear motion found. Try higher sensitivity.');
      return ui.setScriptStatus(
        dur ? 'No script yet. Press play for real-time, or pre-scan ('  + ui.fmtTime(dur / (settings.scanRate || 4)) + ' at ' + settings.scanRate + '×).' : 'Press play once so the video loads, then generate.'
      );
    }
    const st = fs.stats(cur.actions);
    let txt = (rec.imported ? 'Imported "' + (rec.importedName || 'script') + '"' : 'AI script') + ' · ' + st.strokes + ' strokes · avg ' + st.avgSpeed + '/s';
    if (!rec.imported && dur && !scannedAll) txt += ' · covers ' + ui.fmtTime(rec.scannedFrom || 0) + '–' + ui.fmtTime(rec.scannedTo || 0) + ' of ' + ui.fmtTime(dur);
    ui.setScriptStatus(txt);
  }

  async function doScan() {
    const v = cur.video;
    if (!v || cur.scanning) return;
    const dur = durationOf(v);
    if (!dur) {
      ui.setScriptStatus('Press play once so the video loads, then try again.', true);
      return;
    }
    const rec = cur.rec && cur.rec.signal && !cur.rec.imported ? cur.rec : null;
    const resume = rec && (rec.scannedTo || 0) < dur - 1 && (rec.scannedFrom || 0) <= 0.5;
    const from = resume ? rec.scannedTo : 0;
    cur.scanning = true;
    updateMode();
    cur.abort = new AbortController();
    ui.setScanning(true);
    ui.setVideoReady(false);
    if (handy.playing) stopHandy();
    const started = Date.now();
    try {
      const samples = await scanner.scan(v, {
        rate: settings.scanRate || 4,
        from,
        to: dur,
        abort: cur.abort.signal,
        cloneHost: ui.cloneHost,
        onProgress: (frac, t) => {
          ui.setProgress(t / dur);
          const el = (Date.now() - started) / 1000;
          const eta = frac > 0.02 ? (el / frac) * (1 - frac) : 0;
          ui.setScriptStatus('Analysing motion… ' + Math.round((t / dur) * 100) + '%' + (eta ? ' · ' + ui.fmtTime(eta) + ' left' : ''));
        },
      }).catch((e) => {
        if (e instanceof scanner.CancelledError) return e.partial || null;
        throw e;
      });
      if (!samples) {
        ui.setScriptStatus('Scan stopped.');
        return;
      }
      await saveScan(samples, from, resume ? rec : null, dur);
    } catch (e) {
      ui.setScriptStatus(e.message || String(e), true);
    } finally {
      cur.scanning = false;
      cur.abort = null;
      ui.setScanning(false);
      updateMode();
      refreshScriptStatus();
      syncPlayback();
    }
  }

  async function saveScan(samples, from, prevRec, dur) {
    ui.setScriptStatus('Building script…');
    await new Promise((r) => setTimeout(r, 0));
    const sig = motion.analyze(samples);
    let packed = motion.packSignal(sig);
    if (prevRec && prevRec.signal) {
      const p = prevRec.signal;
      const segOff = p.seg.length ? p.seg[p.seg.length - 1] + 1 : 0;
      packed = { t: p.t.concat(packed.t), v: p.v.concat(packed.v), seg: p.seg.concat(packed.seg.map((s) => s + segOff)) };
    }
    const lastT = samples.t.length ? samples.t[samples.t.length - 1] : from;
    cur.rec = {
      signal: packed,
      imported: null,
      scannedFrom: prevRec ? prevRec.scannedFrom || 0 : from,
      scannedTo: Math.max(lastT, prevRec ? prevRec.scannedTo : 0),
      duration: dur,
      createdAt: Date.now(),
    };
    await store.saveVideo(cur.id, cur.rec);
    recompute();
  }

  async function doImport(text, name) {
    try {
      const { actions } = fs.parse(text);
      cur.rec = Object.assign({}, cur.rec || {}, { imported: actions, importedName: name.replace(/\.funscript$/i, '') });
      await store.saveVideo(cur.id, cur.rec);
      recompute();
    } catch (e) {
      ui.setScriptStatus(e.message, true);
    }
  }

  function doExport() {
    if (!cur.actions) return;
    const title = (document.title || 'video').replace(/\s*-\s*Pornhub\.com\s*$/i, '').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'video';
    const text = fs.serialize(cur.actions, {
      creator: 'Handy AI Scripts',
      title,
      description: cur.rec && cur.rec.imported ? 'Imported' : 'Generated by motion analysis',
      notes: location.href,
      duration: Math.round(durationOf(cur.video)),
    });
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title + '.funscript';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function doDelete() {
    if (!cur.rec) return;
    if (!confirm('Delete the script for this video?')) return;
    if (cur.rec.imported && cur.rec.signal) {
      cur.rec = Object.assign({}, cur.rec, { imported: null, importedName: null });
      await store.saveVideo(cur.id, cur.rec);
    } else {
      cur.rec = null;
      await store.deleteVideo(cur.id);
    }
    recompute();
  }

  // ------------------------------------------------------------ handy --

  async function connectHandy(quiet) {
    if (!settings.connectionKey) {
      ui.setHandyStatus('Enter your connection key (Handy app → settings).', quiet ? '' : 'err');
      return;
    }
    ui.setHandyStatus('Connecting…', 'busy');
    try {
      const r = await bg('connect');
      handy.rtt = r.rtt || 0;
      handy.connected = true;
      handy.loadedHash = null;
      ui.setConnected(true);
      ui.setHandyStatus('Connected · ' + r.rtt + ' ms round trip', 'on');
      await handyLoad();
      syncPlayback();
    } catch (e) {
      handy.connected = false;
      ui.setConnected(false);
      ui.setHandyStatus(e.message, 'err');
    }
  }

  /** Move the device directly, without any video: tells device problems apart from video problems. */
  async function testHandy() {
    if (!handy.connected) return;
    if (handy.playing) stopHandy();
    ui.setHandyStatus('Test: moving the Handy…', 'busy');
    try {
      for (const position of [90, 10, 90, 10, 50]) {
        await bg('move', { position, duration: 450 });
        await new Promise((r) => setTimeout(r, 500));
      }
      handy.loadedHash = null; // device left script mode; reload if needed
      ui.setHandyStatus('Test sent. Did it move? If yes, the device works; check the Script line above.', 'on');
      scheduleHandyLoad();
    } catch (e) {
      ui.setHandyStatus('Test failed: ' + e.message, 'err');
    }
  }

  function disconnectHandy() {
    if (handy.playing) stopHandy();
    handy.connected = false;
    handy.loadedHash = null;
    ui.setConnected(false);
    ui.setHandyStatus('Disconnected', '');
  }

  function currentHash() {
    return cur.actions && cur.actions.length ? fs.hash(fs.toCsv(cur.actions)) : null;
  }

  async function handyLoad() {
    if (!handy.connected) return;
    if (isLive()) {
      handy.loadedHash = null;
      ui.setHandyStatus('Connected · real-time mode. Press play.', 'on');
      return;
    }
    const actions = cur.actions;
    if (!actions || !actions.length) {
      ui.setHandyStatus('Connected · waiting for a script', 'on');
      return;
    }
    const csv = fs.toCsv(actions);
    const h = fs.hash(csv);
    if (h === handy.loadedHash) return;
    if (handy.loading && handy.loading.hash === h) return handy.loading.p;
    if (handy.playing) stopHandy();
    ui.setHandyStatus('Sending script to the Handy…', 'busy');
    const p = bg('load', { csv })
      .then(() => {
        handy.loadedHash = h;
        ui.setHandyStatus('Ready · script loaded. Press play.', 'on');
      })
      .catch((e) => {
        ui.setHandyStatus(e.message, 'err');
      });
    handy.loading = { hash: h, p };
    try {
      await p;
    } finally {
      if (handy.loading && handy.loading.p === p) handy.loading = null;
    }
    syncPlayback();
  }
  const scheduleHandyLoad = debounce(() => handyLoad(), 700);

  function stopHandy() {
    handy.playing = false;
    bg('stop').catch(() => {});
  }

  let playSeq = 0;
  const syncPlayback = debounce(() => {
    const v = cur.video;
    if (!handy.connected || cur.scanning || !v) return;
    if (isLive()) {
      if (handy.playing) stopHandy();
      return;
    }
    const ready = handy.loadedHash && handy.loadedHash === currentHash();
    const rateOk = Math.abs(v.playbackRate - 1) < 0.01;
    const shouldPlay = ready && rateOk && !v.paused && !v.ended && !v.seeking && v.readyState >= 3;
    if (!rateOk && !v.paused) ui.setHandyStatus('Paused: The Handy only syncs at 1× playback speed.', 'busy');
    if (shouldPlay) {
      const seq = ++playSeq;
      handy.playing = true;
      bg('play', { atLocal: Date.now(), startTime: v.currentTime * 1000 + (settings.offsetMs || 0) })
        .then(() => {
          if (seq === playSeq) ui.setHandyStatus('Playing in sync', 'on');
        })
        .catch((e) => ui.setHandyStatus(e.message, 'err'));
    } else if (handy.playing) {
      playSeq++;
      stopHandy();
      if (ready && rateOk) ui.setHandyStatus('Ready · paused', 'on');
    }
  }, 120);

  // ------------------------------------------------------------ video --

  const VIDEO_EVENTS = ['play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ratechange', 'ended', 'stalled', 'loadedmetadata', 'durationchange'];
  function onVideoEvent(e) {
    if (cur.scanning) return;
    if (e.type === 'loadedmetadata' || e.type === 'durationchange') refreshScriptStatus();
    syncPlayback();
  }

  async function attach(video, id) {
    if (cur.video) VIDEO_EVENTS.forEach((ev) => cur.video.removeEventListener(ev, onVideoEvent));
    if (cur.abort) cur.abort.abort();
    if (handy.playing) stopHandy();
    cur.video = video;
    cur.id = id;
    cur.rec = video ? await store.getVideo(id) : null;
    liveStatus = '';
    if (liveEngine) liveEngine.attach(video);
    if (video) VIDEO_EVENTS.forEach((ev) => video.addEventListener(ev, onVideoEvent));
    recompute();
    syncPlayback();
  }

  // ------------------------------------------------------------ boot --

  async function init() {
    settings = await store.getSettings();
    ui = HAI.createPanel({
      onScan: doScan,
      onCancel: () => cur.abort && cur.abort.abort(),
      onImport: doImport,
      onExport: doExport,
      onDelete: doDelete,
      onConnect: () => connectHandy(false),
      onTest: testHandy,
      onDisconnect: disconnectHandy,
      onSetting: async (key, value, { live }) => {
        settings[key] = value;
        if (key === 'connectionKey' || key === 'appId') {
          if (!live) {
            await store.saveSettings({ [key]: value });
            if (handy.connected) disconnectHandy();
          }
          return;
        }
        if (key === 'offsetMs') {
          if (!live) {
            await store.saveSettings({ offsetMs: value });
            syncPlayback();
          }
          return;
        }
        if (key === 'scanRate') {
          await store.saveSettings({ scanRate: value });
          refreshScriptStatus();
          return;
        }
        recompute();
        if (!live) await store.saveSettings({ [key]: value });
      },
    });
    ui.applySettings(settings);

    liveEngine = HAI.createLiveEngine({
      cloneHost: ui.cloneHost,
      getParams: () => params(),
      // Command -> server -> device, plus the user's offset (+ = earlier).
      getLatencyMs: () => (handy.connected ? handy.rtt + 40 : 0) + (settings.offsetMs || 0),
      onMove: (position, duration) => sendMove({ position, duration, created: Date.now() }),
      onStatus: (text) => {
        liveStatus = text;
        if (isLive() && !cur.scanning) ui.setScriptStatus(text);
      },
    });

    // Settings changed elsewhere (options page / another tab).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = Object.assign({}, store.DEFAULT_SETTINGS, changes.settings.newValue || {});
      const keyChanged = next.connectionKey !== settings.connectionKey || next.appId !== settings.appId;
      settings = next;
      ui.applySettings(settings);
      if (keyChanged && handy.connected) disconnectHandy();
    });

    // Find the player; re-check for SPA navigation and late-loading players.
    let lastUrl = '';
    const scanPage = async () => {
      if (cur.scanning) return;
      const v = findVideo();
      const id = videoIdFromUrl();
      if (v !== cur.video || id !== cur.id || location.href !== lastUrl) {
        lastUrl = location.href;
        await attach(v, id);
      }
    };
    await scanPage();
    setInterval(scanPage, 1500);

    // Playhead graph.
    setInterval(() => {
      if (document.hidden || !cur.video) return;
      const acts = isLive() && liveEngine ? liveEngine.actions() : cur.actions;
      ui.draw(acts, cur.video.currentTime * 1000, durationOf(cur.video) * 1000);
    }, 100);

    if (settings.autoConnect && settings.connectionKey) connectHandy(true);
    else if (!settings.connectionKey) ui.setHandyStatus('Enter your connection key to sync a Handy.', '');
  }

  init().catch((e) => console.error('[Handy AI]', e));
})();
