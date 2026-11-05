/*
 * Minimal client for The Handy's cloud REST API (v2), HSSP mode.
 *
 * HSSP = "Handy Synchronized Script Player": the device downloads a CSV
 * script from a URL, and we tell it "at server time T, be at script time S".
 * The device then runs on its own clock, so we only talk to it when the video
 * starts, stops, seeks or stalls.
 *
 * Every endpoint path lives here so it is easy to update if the API changes.
 * `fetch` and `now` are injected so the client can be unit tested.
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});

  const DEFAULTS = {
    apiBase: 'https://www.handyfeeling.com/api/handy/v2',
    uploadUrl: 'https://www.handyfeeling.com/api/hosting/v2/upload',
  };
  const MODE_HSSP = 1;
  const MODE_HDSP = 2; // direct position streaming (real-time mode)

  class HandyError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'HandyError';
      this.status = status;
    }
  }

  function createHandyClient(opts) {
    const fetchFn = opts.fetch;
    const now = opts.now || (() => Date.now());
    const apiBase = (opts.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
    const uploadUrl = opts.uploadUrl || DEFAULTS.uploadUrl;
    let key = opts.connectionKey || '';
    let offset = opts.serverOffset || 0; // serverTime - localTime, ms
    let offsetAt = opts.serverOffsetAt || 0;
    let mode = null; // last mode we set, to avoid a request per stroke

    async function call(method, path, body) {
      if (!key) throw new HandyError('Enter your Handy connection key first');
      let res;
      try {
        res = await fetchFn(apiBase + path, {
          method,
          headers: Object.assign(
            { 'X-Connection-Key': key, Accept: 'application/json' },
            body ? { 'Content-Type': 'application/json' } : {}
          ),
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new HandyError('Cannot reach the Handy servers (' + (e && e.message) + ')');
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        /* empty body */
      }
      if (!res.ok || (data && data.error)) {
        const err = data && data.error;
        const msg = (err && (err.message || err.name)) || 'HTTP ' + res.status;
        if (err && err.connected === false) throw new HandyError('Handy is offline. Check its Wi-Fi and the connection key.', res.status);
        throw new HandyError('Handy API: ' + msg, res.status);
      }
      return data || {};
    }

    async function syncTime(rounds) {
      const n = rounds || 8;
      const results = [];
      for (let i = 0; i < n; i++) {
        const t0 = now();
        const d = await call('GET', '/servertime');
        const t1 = now();
        if (typeof d.serverTime !== 'number') throw new HandyError('Unexpected /servertime reply');
        const rtt = t1 - t0;
        results.push({ rtt, offset: d.serverTime + rtt / 2 - t1 });
      }
      // Use the faster half of the round trips (least queueing noise).
      results.sort((a, b) => a.rtt - b.rtt);
      const best = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
      offset = best.reduce((s, r) => s + r.offset, 0) / best.length;
      offsetAt = now();
      return { offset, rtt: best[0].rtt };
    }

    return {
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
        const d = await call('GET', '/connected');
        return !!d.connected;
      },

      syncTime,

      /** Check the device is online and sync clocks. */
      async connect() {
        if (!(await this.isConnected())) {
          throw new HandyError('Handy is offline. Check its Wi-Fi and the connection key.');
        }
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
          data = await res.json();
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
        await call('PUT', '/mode', { mode: MODE_HSSP });
        mode = MODE_HSSP;
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
        const d = await call('PUT', '/hssp/play', {
          estimatedServerTime: Math.round(atLocal + offset),
          startTime: Math.max(0, Math.round(startTime)),
        });
        if (typeof d.result === 'number' && d.result < 0) {
          throw new HandyError('Handy refused to play (code ' + d.result + ')');
        }
        return d;
      },

      async stop() {
        return call('PUT', '/hssp/stop');
      },

      /**
       * Real-time mode: move to `position` (0-100 %) taking `duration` ms.
       * Uses HDSP; switches the device into that mode on first use.
       */
      async moveTo(position, duration) {
        if (mode !== MODE_HDSP) {
          await call('PUT', '/mode', { mode: MODE_HDSP });
          mode = MODE_HDSP;
        }
        return call('PUT', '/hdsp/xpt', {
          stopOnTarget: true,
          immediateResponse: true,
          position: Math.max(0, Math.min(100, Math.round(position))),
          duration: Math.max(1, Math.round(duration)),
        });
      },
    };
  }

  const api = { createHandyClient, HandyError, DEFAULTS, MODE_HSSP, MODE_HDSP };
  HAI.handy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
