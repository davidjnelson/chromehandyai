/*
 * Minimal client for The Handy's cloud REST API.
 *
 * Two API versions:
 *   v3  https://www.handyfeeling.com/api/handy-rest/v3  (firmware 4 devices)
 *       Every request needs an Application ID (X-Api-Key), free from
 *       https://user.handyfeeling.com, plus the device's X-Connection-Key.
 *   v2  https://www.handyfeeling.com/api/handy/v2       (firmware 3 devices)
 *       Connection key only.
 * The client uses v3 whenever an Application ID is set, otherwise v2.
 *
 * Protocols used:
 *   HSSP  the device downloads a CSV script and plays it in sync with the
 *         server clock (pre-scanned or imported scripts).
 *   HDSP  "move to position p in t ms" commands (real-time mode).
 *
 * Request/response formats follow the v3 OpenAPI spec (servertime ->
 * {server_time}, connected -> {result:{connected}}, errors ->
 * {error:{code,name,message,connected}}) and the v2 docs.
 * `fetch` and `now` are injected so the client can be unit tested.
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});

  const DEFAULTS = {
    apiBaseV2: 'https://www.handyfeeling.com/api/handy/v2',
    apiBaseV3: 'https://www.handyfeeling.com/api/handy-rest/v3',
    uploadUrl: 'https://www.handyfeeling.com/api/hosting/v2/upload',
    appIdUrl: 'https://user.handyfeeling.com',
  };
  DEFAULTS.apiBase = DEFAULTS.apiBaseV2; // backwards compatible name
  const MODE_HSSP = 1;
  const MODE_HDSP = 2;

  /** Per-version paths and body formats. */
  const PROTOCOL = {
    v2: {
      modePath: '/mode',
      connected: (d) => !!d.connected,
      serverTime: (d) => d.serverTime,
      playBody: (serverTime, startTime) => ({ estimatedServerTime: serverTime, startTime }),
      xptBody: (position, duration) => ({ stopOnTarget: true, immediateResponse: true, position, duration }),
    },
    v3: {
      modePath: '/mode2',
      connected: (d) => !!(d.result && d.result.connected),
      serverTime: (d) => d.server_time,
      playBody: (serverTime, startTime) => ({ server_time: serverTime, start_time: startTime, playback_rate: 1, loop: false }),
      xptBody: (position, duration) => ({ xp: position, t: duration, stop_on_target: true, immediate_rsp: true }),
    },
  };

  class HandyError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'HandyError';
      this.status = status;
      this.code = code;
    }
  }

  function createHandyClient(opts) {
    const fetchFn = opts.fetch;
    const now = opts.now || (() => Date.now());
    const appId = (opts.appId || '').trim();
    const version = appId ? 'v3' : 'v2';
    const P = PROTOCOL[version];
    const apiBase = (opts.apiBase || (version === 'v3' ? DEFAULTS.apiBaseV3 : DEFAULTS.apiBaseV2)).replace(/\/+$/, '');
    const uploadUrl = opts.uploadUrl || DEFAULTS.uploadUrl;
    let key = (opts.connectionKey || '').trim();
    let offset = opts.serverOffset || 0; // serverTime - localTime, ms
    let offsetAt = opts.serverOffsetAt || 0;
    let mode = null; // last mode we set, to avoid a request per stroke

    const offlineMsg = () =>
      version === 'v3'
        ? 'The Handy says this device is offline. Check that it is on Wi-Fi (solid light) and the connection key is right.'
        : 'Handy says offline. If your Handy has firmware 4, it needs a free Application ID: add it under the connection key.';

    async function call(method, path, body) {
      if (!key) throw new HandyError('Enter your Handy connection key first');
      const headers = { 'X-Connection-Key': key, Accept: 'application/json' };
      if (appId) headers['X-Api-Key'] = appId;
      if (body) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetchFn(apiBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        throw new HandyError('Cannot reach the Handy servers (' + (e && e.message) + ')');
      }
      let data = null;
      let text = '';
      try {
        if (typeof res.text === 'function') {
          text = await res.text();
          data = text ? JSON.parse(text) : {};
        } else {
          data = await res.json();
        }
      } catch (e) {
        data = null;
      }
      if (res.status === 401 || res.status === 403) {
        throw new HandyError(
          version === 'v3' ? 'The Handy rejected the Application ID. Copy it again from user.handyfeeling.com.' : 'The Handy rejected the request (HTTP ' + res.status + ').',
          res.status
        );
      }
      if (!res.ok || (data && data.error)) {
        const err = data && data.error;
        if (err && err.connected === false) throw new HandyError(offlineMsg(), res.status, err.code);
        const msg = (err && (err.message || err.name)) || 'HTTP ' + res.status + (text ? ': ' + text.slice(0, 120) : '');
        throw new HandyError('Handy API: ' + msg, res.status, err && err.code);
      }
      if (data === null) throw new HandyError('Unexpected reply from the Handy servers' + (text ? ': ' + text.slice(0, 80) : ''));
      return data;
    }

    async function syncTime(rounds) {
      const n = rounds || 8;
      const results = [];
      for (let i = 0; i < n; i++) {
        const t0 = now();
        const d = await call('GET', '/servertime');
        const t1 = now();
        const st = P.serverTime(d);
        if (typeof st !== 'number') throw new HandyError('Unexpected /servertime reply');
        const rtt = t1 - t0;
        results.push({ rtt, offset: st + rtt / 2 - t1 });
      }
      // Use the faster half of the round trips (least queueing noise).
      results.sort((a, b) => a.rtt - b.rtt);
      const best = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
      offset = best.reduce((s, r) => s + r.offset, 0) / best.length;
      offsetAt = now();
      return { offset, rtt: best[0].rtt };
    }

    async function setMode(m) {
      await call('PUT', P.modePath, { mode: m });
      mode = m;
    }

    return {
      version,
      get connectionKey() {
        return key;
      },
      set connectionKey(k) {
        key = (k || '').trim();
      },
      get serverOffset() {
        return offset;
      },
      get serverOffsetAt() {
        return offsetAt;
      },

      async isConnected() {
        return P.connected(await call('GET', '/connected'));
      },

      syncTime,

      /** Check the device is online and sync clocks. */
      async connect() {
        if (!(await this.isConnected())) throw new HandyError(offlineMsg());
        return syncTime();
      },

      /** Upload a CSV script to Handy's script hosting; returns its URL. */
      async upload(csv, filename) {
        const form = new FormData();
        form.append('file', new Blob([csv], { type: 'text/csv' }), filename || 'script.csv');
        let res;
        try {
          res = await fetchFn(uploadUrl, { method: 'POST', body: form });
        } catch (e) {
          throw new HandyError('Script upload failed (' + (e && e.message) + ')');
        }
        let data = null;
        try {
          data = typeof res.text === 'function' ? JSON.parse(await res.text()) : await res.json();
        } catch (e) {
          /* ignore */
        }
        if (!res.ok || !data || !data.url) {
          throw new HandyError('Script upload failed: ' + ((data && data.error && data.error.message) || 'HTTP ' + res.status));
        }
        return data.url;
      },

      /** Put the device in HSSP mode and have it download the script. */
      async setupScript(url) {
        await setMode(MODE_HSSP);
        const d = await call('PUT', '/hssp/setup', { url });
        if (typeof d.result === 'number' && d.result < 0) {
          throw new HandyError('Handy could not load the script (code ' + d.result + ')');
        }
        return d;
      },

      /**
       * Start playing: at local time `atLocal` (ms, Date.now() clock) the
       * video was at `startTime` ms.
       */
      async play(atLocal, startTime) {
        const d = await call('PUT', '/hssp/play', P.playBody(Math.round(atLocal + offset), Math.max(0, Math.round(startTime))));
        if (typeof d.result === 'number' && d.result < 0) {
          throw new HandyError('Handy refused to play (code ' + d.result + ')');
        }
        return d;
      },

      async stop() {
        return call('PUT', '/hssp/stop');
      },

      /** Real-time mode: move to `position` (0-100 %) taking `duration` ms (HDSP). */
      async moveTo(position, duration) {
        if (mode !== MODE_HDSP) await setMode(MODE_HDSP);
        return call('PUT', '/hdsp/xpt', P.xptBody(Math.max(0, Math.min(100, Math.round(position))), Math.max(1, Math.round(duration))));
      },
    };
  }

  const api = { createHandyClient, HandyError, DEFAULTS, MODE_HSSP, MODE_HDSP, PROTOCOL };
  HAI.handy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
