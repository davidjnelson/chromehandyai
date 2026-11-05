/*
 * In-page UI: a floating button and a panel, inside a closed-off shadow root
 * so the site's CSS can't break it. Touch-friendly (44 px targets) and
 * switches to a bottom sheet on narrow screens.
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.fab {
  position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom));
  z-index: 2147483647; width: 52px; height: 52px; border-radius: 50%; border: 0; cursor: pointer;
  background: #7c5cff; color: #fff; font: 700 13px/1 system-ui, sans-serif; letter-spacing: .02em;
  box-shadow: 0 4px 16px rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
.fab .dot { position: absolute; top: 4px; right: 4px; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid #7c5cff; background: #666; }
.fab .dot.on { background: #2fd27a; } .fab .dot.busy { background: #f5b83d; } .fab .dot.err { background: #ff5a5a; }
.panel {
  position: fixed; right: 16px; bottom: 80px; z-index: 2147483647; width: 340px; max-height: min(80vh, 640px);
  overflow-y: auto; overscroll-behavior: contain; background: #16161c; color: #ececf1; border-radius: 14px;
  box-shadow: 0 10px 40px rgba(0,0,0,.6); border: 1px solid #2c2c36; font-size: 14px; line-height: 1.35;
  padding: 12px 14px 14px; display: none;
}
.panel.open { display: block; }
@media (max-width: 520px) {
  .panel { left: 0; right: 0; bottom: 0; width: auto; max-height: 78vh; border-radius: 16px 16px 0 0;
    padding-bottom: max(14px, env(safe-area-inset-bottom)); }
}
header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
header h1 { font-size: 15px; font-weight: 700; margin: 0; flex: 1; color: #fff; }
.x { background: none; border: 0; color: #aaa; font-size: 22px; width: 44px; height: 36px; cursor: pointer; }
section { border-top: 1px solid #2a2a33; padding: 10px 0 4px; }
section:first-of-type { border-top: 0; padding-top: 0; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #9a9aab; margin: 0 0 6px; font-weight: 600; }
.status { color: #c9c9d4; margin: 4px 0 8px; min-height: 1.35em; word-wrap: break-word; }
.status.err { color: #ff7a7a; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
button.b {
  min-height: 40px; padding: 0 14px; border-radius: 9px; border: 1px solid #3a3a46; background: #23232c; color: #ececf1;
  font-size: 14px; font-weight: 600; cursor: pointer; touch-action: manipulation;
}
button.b:disabled { opacity: .45; cursor: default; }
button.primary { background: #7c5cff; border-color: #7c5cff; color: #fff; }
button.danger { color: #ff8a8a; }
.grow { flex: 1; }
.progress { height: 6px; border-radius: 3px; background: #2a2a33; overflow: hidden; display: none; }
.progress.show { display: block; }
.progress > i { display: block; height: 100%; width: 0; background: #7c5cff; transition: width .2s; }
canvas { width: 100%; display: block; border-radius: 8px; background: #0e0e12; }
canvas.graph { height: 72px; margin-top: 6px; }
canvas.heat { height: 10px; margin-top: 4px; }
label.f { display: grid; grid-template-columns: 100px 1fr 44px; align-items: center; gap: 8px; margin: 6px 0; color: #c9c9d4; }
label.f output { text-align: right; font-variant-numeric: tabular-nums; color: #fff; }
input[type=range] { width: 100%; accent-color: #7c5cff; height: 28px; }
input[type=text], input[type=password], select {
  min-height: 40px; border-radius: 9px; border: 1px solid #3a3a46; background: #0e0e12; color: #fff; padding: 0 10px; font-size: 15px;
}
input[type=text], input[type=password] { flex: 1; min-width: 0; }
label.c { display: flex; align-items: center; gap: 8px; min-height: 36px; color: #c9c9d4; }
input[type=checkbox] { width: 20px; height: 20px; accent-color: #7c5cff; }
details summary { cursor: pointer; color: #9a9aab; font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
  font-weight: 600; padding: 6px 0; list-style-position: inside; }
.hint { color: #8a8a99; font-size: 12px; margin: 4px 0; }
.preview:empty { display: none; }
.preview { margin-top: 6px; }
`;

  const HTML = `
<button class="fab" part="fab" aria-label="Handy AI scripts">H·AI<span class="dot"></span></button>
<div class="panel" role="dialog" aria-label="Handy AI scripts">
  <header><h1>Handy AI Scripts</h1><button class="x" data-a="close" aria-label="Close">×</button></header>

  <section>
    <h2>Script</h2>
    <div class="status" data-o="scriptStatus">Looking for the video…</div>
    <div class="progress"><i></i></div>
    <div class="preview"></div>
    <canvas class="graph" width="600" height="144"></canvas>
    <canvas class="heat" width="600" height="20"></canvas>
    <div class="row">
      <button class="b primary grow" data-a="scan">Generate AI script</button>
      <button class="b" data-a="cancel" hidden>Stop</button>
    </div>
    <div class="row">
      <button class="b grow" data-a="import">Import</button>
      <button class="b grow" data-a="export">Export</button>
      <button class="b danger" data-a="delete" aria-label="Delete script">Delete</button>
      <input type="file" accept=".funscript,application/json" hidden>
    </div>
  </section>

  <section>
    <h2>The Handy</h2>
    <div class="status" data-o="handyStatus">Not connected</div>
    <div class="row">
      <input type="password" data-s="connectionKey" placeholder="Connection key" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="b primary" data-a="connect">Connect</button>
    </div>
    <label class="f">Timing offset <input type="range" data-s="offsetMs" min="-500" max="500" step="10"><output></output></label>
    <div class="hint">Positive = strokes earlier. Use if the device lags the video.</div>
  </section>

  <details>
    <summary>Tuning</summary>
    <label class="f">Bottom <input type="range" data-s="minPos" min="0" max="100" step="1"><output></output></label>
    <label class="f">Top <input type="range" data-s="maxPos" min="0" max="100" step="1"><output></output></label>
    <label class="f">Sensitivity <input type="range" data-s="sensitivity" min="0" max="1" step="0.05"><output></output></label>
    <label class="f">Smoothing <input type="range" data-s="smoothing" min="0" max="1" step="0.05"><output></output></label>
    <label class="f">Max speed <input type="range" data-s="maxSpeed" min="100" max="800" step="25"><output></output></label>
    <label class="c"><input type="checkbox" data-s="invert"> Invert direction</label>
    <label class="f">Scan speed
      <select data-s="scanRate"><option value="1">1× (best)</option><option value="2">2×</option><option value="4">4×</option><option value="8">8× (fast)</option></select><output></output>
    </label>
    <div class="hint">Tuning changes apply instantly. No re-scan needed.</div>
  </details>
</div>`;

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function fmtSetting(key, v) {
    if (key === 'offsetMs') return (v > 0 ? '+' : '') + v;
    if (key === 'sensitivity' || key === 'smoothing') return Math.round(v * 100) + '%';
    return String(v);
  }

  /**
   * handlers: onScan, onCancel, onImport(text, name), onExport, onDelete,
   *           onConnect, onDisconnect, onSetting(key, value)
   */
  function createPanel(handlers) {
    const host = document.createElement('div');
    host.id = 'handy-ai-root';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = (sel) => shadow.querySelector(sel);
    const fab = $('.fab');
    const dot = $('.dot');
    const panel = $('.panel');
    const graph = $('canvas.graph');
    const heat = $('canvas.heat');
    const fileInput = $('input[type=file]');
    const progress = $('.progress');
    const btn = (a) => $(`[data-a="${a}"]`);

    const attach = () => {
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    };
    attach();
    // Some players move or rebuild the DOM; keep the UI attached.
    setInterval(attach, 2000);

    fab.addEventListener('click', () => panel.classList.toggle('open'));
    btn('close').addEventListener('click', () => panel.classList.remove('open'));
    btn('scan').addEventListener('click', () => handlers.onScan());
    btn('cancel').addEventListener('click', () => handlers.onCancel());
    btn('export').addEventListener('click', () => handlers.onExport());
    btn('delete').addEventListener('click', () => handlers.onDelete());
    btn('import').addEventListener('click', () => fileInput.click());
    btn('connect').addEventListener('click', () => (connected ? handlers.onDisconnect() : handlers.onConnect()));
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) handlers.onImport(await f.text(), f.name);
    });

    // Keep page hotkeys (space = play/pause, arrows = seek) out of our inputs.
    ['keydown', 'keyup', 'keypress'].forEach((t) => panel.addEventListener(t, (e) => e.stopPropagation()));

    // Settings controls
    const controls = Array.from(shadow.querySelectorAll('[data-s]'));
    for (const el of controls) {
      const key = el.dataset.s;
      const out = el.parentElement.querySelector('output');
      const read = () => {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'range' || el.tagName === 'SELECT') return Number(el.value);
        return el.value.trim();
      };
      el.addEventListener('input', () => {
        if (out && el.type === 'range') out.textContent = fmtSetting(key, read());
        if (el.type === 'range') handlers.onSetting(key, read(), { live: true });
      });
      el.addEventListener('change', () => handlers.onSetting(key, read(), { live: false }));
    }

    let connected = false;

    const ui = {
      host,
      cloneHost: $('.preview'),

      applySettings(s) {
        for (const el of controls) {
          const key = el.dataset.s;
          if (!(key in s)) continue;
          if (el.type === 'checkbox') el.checked = !!s[key];
          else el.value = String(s[key]);
          const out = el.parentElement.querySelector('output');
          if (out && el.type === 'range') out.textContent = fmtSetting(key, s[key]);
        }
      },

      setScriptStatus(text, isError) {
        const o = $('[data-o="scriptStatus"]');
        o.textContent = text;
        o.classList.toggle('err', !!isError);
      },

      setHandyStatus(text, state) {
        const o = $('[data-o="handyStatus"]');
        o.textContent = text;
        o.classList.toggle('err', state === 'err');
        dot.className = 'dot' + (state ? ' ' + state : '');
      },

      setConnected(on) {
        connected = on;
        btn('connect').textContent = on ? 'Disconnect' : 'Connect';
        btn('connect').classList.toggle('primary', !on);
      },

      setScanning(on) {
        btn('scan').hidden = on;
        btn('cancel').hidden = !on;
        btn('import').disabled = on;
        btn('delete').disabled = on;
        progress.classList.toggle('show', on);
        if (!on) progress.firstElementChild.style.width = '0';
      },

      setProgress(frac) {
        progress.firstElementChild.style.width = Math.round(frac * 100) + '%';
      },

      setHasScript(has, scannedAll) {
        btn('export').disabled = !has;
        btn('delete').disabled = !has;
        btn('scan').textContent = has ? (scannedAll ? 'Re-scan video' : 'Continue scan') : 'Generate AI script';
      },

      setVideoReady(ready) {
        btn('scan').disabled = !ready;
      },

      /** Zoomed graph around the playhead + whole-video speed heat strip. */
      draw(actions, timeMs, durationMs) {
        const g = graph.getContext('2d');
        const W = graph.width;
        const H = graph.height;
        g.clearRect(0, 0, W, H);
        const span = 12000;
        const t0 = timeMs - span / 2;
        g.strokeStyle = '#26262f';
        g.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          g.beginPath();
          g.moveTo(0, (H * i) / 4);
          g.lineTo(W, (H * i) / 4);
          g.stroke();
        }
        if (actions && actions.length) {
          const pad = 8;
          const y = (pos) => pad + (1 - pos / 100) * (H - 2 * pad);
          const x = (at) => ((at - t0) / span) * W;
          g.strokeStyle = '#9d86ff';
          g.lineWidth = 3;
          g.lineJoin = 'round';
          g.beginPath();
          let started = false;
          for (let i = 0; i < actions.length; i++) {
            const a = actions[i];
            const nx = actions[i + 1];
            if (nx && nx.at < t0) continue;
            if (a.at > t0 + span && started) {
              g.lineTo(x(a.at), y(a.pos));
              break;
            }
            if (!started) {
              g.moveTo(x(a.at), y(a.pos));
              started = true;
            } else g.lineTo(x(a.at), y(a.pos));
          }
          g.stroke();
          const p = HAI.funscript.positionAt(actions, timeMs);
          if (p != null) {
            g.fillStyle = '#fff';
            g.beginPath();
            g.arc(W / 2, y(p), 7, 0, Math.PI * 2);
            g.fill();
          }
        }
        g.strokeStyle = 'rgba(255,255,255,.35)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(W / 2, 0);
        g.lineTo(W / 2, H);
        g.stroke();

        // Heat strip
        const h = heat.getContext('2d');
        const HW = heat.width;
        const HH = heat.height;
        if (this._heatKey !== actions) {
          this._heatKey = actions;
          h.clearRect(0, 0, HW, HH);
          if (actions && actions.length > 1 && durationMs > 0) {
            const bins = new Float64Array(HW);
            const cnt = new Float64Array(HW);
            for (let i = 1; i < actions.length; i++) {
              const dt = (actions[i].at - actions[i - 1].at) / 1000;
              if (dt <= 0) continue;
              const sp = Math.abs(actions[i].pos - actions[i - 1].pos) / dt;
              const b = Math.min(HW - 1, Math.floor((actions[i].at / durationMs) * HW));
              bins[b] += sp;
              cnt[b]++;
            }
            for (let b = 0; b < HW; b++) {
              if (!cnt[b]) continue;
              const sp = Math.min(1, bins[b] / cnt[b] / 400);
              h.fillStyle = `hsl(${260 - sp * 260}, 85%, ${35 + sp * 25}%)`;
              h.fillRect(b, 0, 1, HH);
            }
          }
          this._heatBase = h.getImageData(0, 0, HW, HH);
        } else if (this._heatBase) {
          h.putImageData(this._heatBase, 0, 0);
        }
        if (durationMs > 0) {
          h.fillStyle = '#fff';
          h.fillRect(Math.round((timeMs / durationMs) * HW) - 1, 0, 3, HH);
        }
      },

      fmtTime,
      open() {
        panel.classList.add('open');
      },
    };
    return ui;
  }

  HAI.createPanel = createPanel;
})(typeof globalThis !== 'undefined' ? globalThis : this);
