/*
 * Userscript build test: injects userscript/handy-ai-scripts.user.js into a
 * mocked video page with a fake GM API (as the iPhone "Userscripts" app
 * provides), then checks scan -> script -> fake Handy upload/setup/play.
 * Run: npm run test:userscript (after npm run build:userscript)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const VIDEO = fs.readFileSync(path.join(__dirname, 'fixtures', 'stroke-1.5hz.webm'));
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'userscript', 'handy-ai-scripts.user.js'), 'utf8');

function fakeHandy() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = req.url.replace(/^\/api\/handy\/v2/, '');
      calls.push({ method: req.method, path: p, key: req.headers['x-connection-key'], ctype: req.headers['content-type'], body });
      let data = { result: 0 };
      if (p === '/connected') data = { connected: true };
      if (p === '/servertime') data = { serverTime: Date.now() };
      if (p === '/upload') data = { url: 'https://scripts.example/x.csv' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, port: server.address().port })));
}

function fulfillVideo(route) {
  const range = route.request().headers()['range'];
  const total = VIDEO.length;
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return route.fulfill({ status: 200, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' }, body: VIDEO });
  const s = Number(m[1]);
  const e = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  return route.fulfill({ status: 206, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${total}` }, body: VIDEO.subarray(s, e + 1) });
}

async function clickShadow(page, attrName, value) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let found = null;
  const walk = (n) => {
    const a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === attrName && a[i + 1] === value) found = found || n;
    (n.children || []).forEach(walk);
    (n.shadowRoots || []).forEach(walk);
  };
  walk(root);
  if (!found) throw new Error('not found ' + value);
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: found.backendNodeId });
  const q = model.content;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
  await cdp.detach();
}

(async () => {
  const fake = await fakeHandy();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let ok = false;
  try {
    // Fake GM API backed by a node-side store and node-side HTTP (like the app's native side).
    const store = {
      'handyai:settings': JSON.stringify({ connectionKey: 'IPHONEKEY', autoConnect: true, scanRate: 4,
        apiBase: `http://127.0.0.1:${fake.port}/api/handy/v2`, uploadUrl: `http://127.0.0.1:${fake.port}/upload` }),
    };
    await page.exposeFunction('__gmGet', (k) => store[k]);
    await page.exposeFunction('__gmSet', (k, v) => { store[k] = v; });
    await page.exposeFunction('__gmDel', (k) => { delete store[k]; });
    await page.exposeFunction('__gmList', () => Object.keys(store));
    await page.exposeFunction('__gmXhr', async (d) => {
      const r = await fetch(d.url, { method: d.method, headers: d.headers, body: d.data });
      return { status: r.status, responseText: await r.text() };
    });
    await page.route('https://www.pornhub.com/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/e2e/video.webm') return fulfillVideo(route);
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name=viewport content="width=device-width"><video id=player src="/e2e/video.webm" preload=auto controls muted playsinline style="width:100%"></video>' });
    });
    await page.goto('https://www.pornhub.com/view_video.php?viewkey=ios1');
    await page.evaluate(() => {
      window.GM = {
        getValue: (k) => window.__gmGet(k),
        setValue: (k, v) => window.__gmSet(k, v),
        deleteValue: (k) => window.__gmDel(k),
        listValues: () => window.__gmList(),
        xmlHttpRequest: (d) => window.__gmXhr({ url: d.url, method: d.method, headers: d.headers, data: d.data }).then(d.onload, d.onerror),
      };
    });
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForFunction(() => document.getElementById('handy-ai-root'));
    await page.waitForFunction(() => document.getElementById('player').readyState >= 1);
    const until = async (fn, ms, what) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
      throw new Error('timeout: ' + what);
    };
    await until(() => fake.calls.find((c) => c.path === '/connected'), 10000, 'connect via GM.xmlHttpRequest');
    await clickShadow(page, 'class', 'fab');
    await clickShadow(page, 'data-a', 'scan');
    await until(() => store['handyai:video:ios1'], 60000, 'scan saved via GM.setValue');
    const rec = JSON.parse(store['handyai:video:ios1']);
    console.log('[userscript] scanned to', rec.scannedTo.toFixed(1), 's,', rec.signal.t.length, 'samples');
    const up = await until(() => fake.calls.find((c) => c.path === '/upload'), 10000, 'upload');
    assert.match(up.ctype, /^multipart\/form-data; boundary=/);
    assert.match(up.body, /filename="[0-9a-f]+\.csv"[\s\S]*\r\n\d+,\d+\n/);
    await until(() => fake.calls.find((c) => c.path === '/hssp/setup'), 10000, 'setup');
    await page.evaluate(() => document.getElementById('player').play());
    const play = await until(() => fake.calls.find((c) => c.path === '/hssp/play'), 8000, 'play');
    assert.equal(play.key, 'IPHONEKEY');
    await page.screenshot({ path: path.join(__dirname, 'out', 'userscript-mobile.png') });
    const motion = require('../../src/shared/motion.js');
    const acts = motion.generateActions(motion.unpackSignal(rec.signal), {});
    const peaks = acts.filter((a, i) => i > 0 && i < acts.length - 1 && a.pos > acts[i - 1].pos && a.pos >= acts[i + 1].pos).length;
    console.log('[userscript] peaks', peaks, '(expected ≈ 45)');
    assert.ok(Math.abs(peaks - 45) <= 5);
    ok = true;
    console.log('[userscript] ALL CHECKS PASSED');
  } catch (e) {
    console.error('[userscript] FAILED:', e);
  } finally {
    await browser.close();
    fake.server.close();
  }
  process.exit(ok ? 0 : 1);
})();
