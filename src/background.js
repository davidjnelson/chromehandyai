/*
 * Background worker: owns all network traffic to The Handy (content scripts
 * on pornhub.com would be subject to the page's CORS/CSP rules).
 *
 * Chrome runs this as a service worker (shared code via importScripts);
 * Firefox loads it as an event page with the shared file listed first in
 * manifest "background.scripts".
 */
/* global importScripts */
if (typeof importScripts === 'function' && !(self.HAI && self.HAI.handy)) {
  importScripts('shared/handy.js');
}

const { createHandyClient } = self.HAI.handy;

// Service workers are stopped when idle, so state that must survive lives in
// storage.session (clock offset) and storage.local (settings, upload cache).
let client = null;
let clientConfig = '';

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || {};
}

async function getClient() {
  const s = await getSettings();
  const cfg = JSON.stringify([s.connectionKey || '', s.apiBase || '', s.uploadUrl || '']);
  if (!client || cfg !== clientConfig) {
    let session = {};
    try {
      session = (await chrome.storage.session.get('handyClock')).handyClock || {};
    } catch (e) {
      /* storage.session unavailable: re-sync instead */
    }
    client = createHandyClient({
      fetch: (...a) => fetch(...a),
      connectionKey: s.connectionKey,
      apiBase: s.apiBase || undefined,
      uploadUrl: s.uploadUrl || undefined,
      serverOffset: session.key === s.connectionKey ? session.offset : 0,
      serverOffsetAt: session.key === s.connectionKey ? session.at : 0,
    });
    clientConfig = cfg;
  }
  return client;
}

async function saveClock(c) {
  try {
    await chrome.storage.session.set({
      handyClock: { key: c.connectionKey, offset: c.serverOffset, at: c.serverOffsetAt },
    });
  } catch (e) {
    /* ignore */
  }
}

async function ensureClock(c) {
  // Re-sync if never synced or older than 10 minutes (clock drift).
  if (!c.serverOffsetAt || Date.now() - c.serverOffsetAt > 10 * 60 * 1000) {
    await c.syncTime();
    await saveClock(c);
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Upload once per distinct script; Handy hosting URLs are reused. */
async function uploadCached(c, csv) {
  const digest = await sha256(csv);
  const cacheKey = 'upload:' + digest;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.at < 12 * 60 * 60 * 1000) return cached.url;
  const url = await c.upload(csv, digest.slice(0, 16) + '.csv');
  await chrome.storage.local.set({ [cacheKey]: { url, at: Date.now() } });
  return url;
}

const handlers = {
  async connect() {
    const c = await getClient();
    const r = await c.connect();
    await saveClock(c);
    return { rtt: Math.round(r.rtt), offset: Math.round(r.offset) };
  },
  async status() {
    const c = await getClient();
    return { connected: await c.isConnected() };
  },
  async load(msg) {
    const c = await getClient();
    await ensureClock(c);
    const url = await uploadCached(c, msg.csv);
    await c.setupScript(url);
    return { url };
  },
  async play(msg) {
    const c = await getClient();
    await ensureClock(c);
    await c.play(msg.atLocal, msg.startTime);
    return {};
  },
  async stop() {
    const c = await getClient();
    await c.stop();
    return {};
  },
  async move(msg) {
    const c = await getClient();
    await c.moveTo(msg.position, msg.duration);
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.ns !== 'handy' || !handlers[msg.op]) return false;
  handlers[msg.op](msg).then(
    (r) => sendResponse(Object.assign({ ok: true }, r)),
    (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) })
  );
  return true; // async response
});

// Clean old upload cache entries now and then.
chrome.runtime.onStartup &&
  chrome.runtime.onStartup.addListener(async () => {
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith('upload:') && Date.now() - all[k].at > 24 * 3600 * 1000);
    if (stale.length) await chrome.storage.local.remove(stale);
  });
