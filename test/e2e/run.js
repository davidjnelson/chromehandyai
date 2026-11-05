/*
 * End-to-end test: loads the unpacked extension in Chromium, serves a fake
 * Pornhub video page (Playwright routing) with a synthetic 1.5 Hz "stroke"
 * video, and a fake Handy cloud API on localhost. Checks that:
 *   - the panel appears and a scan produces a script with the right tempo,
 *   - the script is uploaded and set up on the (fake) Handy,
 *   - play / seek / pause on the video drive /hssp/play and /hssp/stop,
 *   - the clone fallback works for a cross-origin (tainted) video,
 *   - the mobile layout renders.
 *
 * Run: npm run test:e2e   (screenshots go to test/e2e/out/)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const motion = require('../../src/shared/motion.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const VIDEO = fs.readFileSync(path.join(__dirname, 'fixtures', 'stroke-1.5hz.webm'));
const FREQ = 1.5;

function log(...a) {
  console.log('[e2e]', ...a);
}

// ------------------------------------------------------------ fake Handy --
function startFakeHandy() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'X-Connection-Key, Content-Type, Accept',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = req.url.replace(/^\/api\/handy\/v2/, '');
      const entry = { method: req.method, path: p, key: req.headers['x-connection-key'], at: Date.now() };
      try {
        entry.body = JSON.parse(body);
      } catch (e) {
        entry.raw = body.slice(0, 300);
      }
      calls.push(entry);
      let data = { result: 0 };
      if (p === '/connected') data = { connected: true };
      if (p === '/servertime') data = { serverTime: Date.now() + 1234 };
      if (p === '/upload') data = { url: 'https://scripts.example/' + calls.length + '.csv' };
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

/** Serve the video with HTTP Range support so the player can seek. */
function fulfillVideo(route, extraHeaders) {
  const range = route.request().headers()['range'];
  const total = VIDEO.length;
  const base = Object.assign({ 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' }, extraHeaders || {});
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return route.fulfill({ status: 200, headers: Object.assign({ 'Content-Length': String(total) }, base), body: VIDEO });
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  return route.fulfill({
    status: 206,
    headers: Object.assign({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }, base),
    body: VIDEO.subarray(start, end + 1),
  });
}

function pageHtml(videoUrl) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>E2E test video - Pornhub.com</title>
<style>body{margin:0;background:#111;color:#eee;font:14px sans-serif} video{width:100%;max-width:960px;display:block}</style></head>
<body><h3 style="padding:8px">Synthetic test page</h3><video id="player" src="${videoUrl}" preload="auto" controls muted playsinline></video></body></html>`;
}

// CDP helpers to reach into the extension's closed shadow root.
async function shadowNodes(page) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const found = [];
  const walk = (n) => {
    found.push(n);
    (n.children || []).forEach(walk);
    (n.shadowRoots || []).forEach(walk);
  };
  walk(root);
  return { cdp, nodes: found };
}
function attr(n, name) {
  const a = n.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return null;
}
async function clickShadow(page, predicate) {
  const { cdp, nodes } = await shadowNodes(page);
  const n = nodes.find(predicate);
  if (!n) throw new Error('shadow node not found');
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
  const q = model.content;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
  await cdp.detach();
}
async function shadowText(page, oName) {
  const { cdp, nodes } = await shadowNodes(page);
  const n = nodes.find((x) => attr(x, 'data-o') === oName);
  await cdp.detach();
  const text = [];
  const walk = (x) => {
    if (x.nodeType === 3) text.push(x.nodeValue);
    (x.children || []).forEach(walk);
  };
  if (n) walk(n);
  return text.join('');
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for ' + what);
}

function peaks(actions) {
  const out = [];
  for (let i = 1; i < actions.length - 1; i++) {
    if (actions[i].pos > actions[i - 1].pos && actions[i].pos >= actions[i + 1].pos) out.push(actions[i]);
  }
  return out;
}

function checkScript(rec, label) {
  assert.ok(rec && rec.signal, label + ': no signal stored');
  fs.writeFileSync(path.join(OUT, label.replace(/\W+/g, '-') + '-record.json'), JSON.stringify(rec));
  const actions = motion.generateActions(motion.unpackSignal(rec.signal), {});
  const pk = peaks(actions);
  const expected = FREQ * rec.scannedTo;
  log(`${label}: ${actions.length} actions, ${pk.length} peaks (expected ≈ ${expected.toFixed(1)}), scanned to ${rec.scannedTo.toFixed(1)} s`);
  assert.ok(Math.abs(pk.length - expected) <= Math.max(3, expected * 0.1), label + ': stroke count off');
  // Patch is highest in the image at sin = -1 -> t = 0.75/f; funscript peak there.
  let err = 0;
  const inner = pk.slice(2, -2);
  for (const p of inner) {
    const ph = ((p.at / 1000) * FREQ) % 1;
    err += Math.min(Math.abs(ph - 0.75), 1 - Math.abs(ph - 0.75));
  }
  err /= Math.max(1, inner.length);
  log(`${label}: mean peak phase error ${(err / FREQ * 1000).toFixed(0)} ms`);
  assert.ok(err < 0.12, label + ': peaks are out of phase');
  return actions;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fake = await startFakeHandy();
  const apiBase = `http://127.0.0.1:${fake.port}/api/handy/v2`;
  log('fake Handy API on', apiBase);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handy-ai-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--autoplay-policy=no-user-gesture-required'],
  });
  let failed = false;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    log('extension id', sw.url().split('/')[2]);
    await sw.evaluate(
      (s) => chrome.storage.local.set({ settings: s }),
      { connectionKey: 'TESTKEY', autoConnect: true, apiBase, uploadUrl: `http://127.0.0.1:${fake.port}/upload`, scanRate: 4 }
    );
    const getRec = (id) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k] || null), 'video:' + id);

    // Same-origin video (like Pornhub's MSE player): readable directly.
    await context.route('https://www.pornhub.com/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/view_video.php') {
        return route.fulfill({ contentType: 'text/html', body: pageHtml('/e2e/video.webm') });
      }
      if (u.pathname === '/e2e/video.webm') return fulfillVideo(route);
      return route.fulfill({ status: 404, body: '' });
    });

    const page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && log('page console:', m.text()));
    await page.goto('https://www.pornhub.com/view_video.php?viewkey=e2e1');
    await page.waitForFunction(() => document.getElementById('handy-ai-root'));
    await page.waitForFunction(() => document.getElementById('player').readyState >= 1);

    // Auto-connect should have checked the device.
    await waitFor(() => fake.calls.find((c) => c.path === '/connected'), 10000, 'auto-connect');
    assert.equal(fake.calls.find((c) => c.path === '/connected').key, 'TESTKEY');

    // Open the panel and generate.
    await clickShadow(page, (n) => attr(n, 'class') === 'fab');
    await clickShadow(page, (n) => attr(n, 'data-a') === 'scan');
    const t0 = Date.now();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, 'desktop-scanning.png') });
    log('status while scanning:', await shadowText(page, 'scriptStatus'));
    const rec = await waitFor(() => getRec('e2e1'), 60000, 'scan result');
    log(`scan took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const actions = checkScript(rec, 'same-origin');

    // Script should be pushed to the Handy.
    await waitFor(() => fake.calls.find((c) => c.path === '/hssp/setup'), 10000, 'hssp setup');
    const upload = fake.calls.find((c) => c.path === '/upload');
    assert.ok(upload && /filename="[0-9a-f]+\.csv"/.test(upload.raw || ''), 'CSV uploaded as multipart');
    assert.deepEqual(fake.calls.find((c) => c.path === '/mode').body, { mode: 1 });
    log('status after scan:', await shadowText(page, 'scriptStatus'), '|', await shadowText(page, 'handyStatus'));

    // Playback sync.
    const before = fake.calls.length;
    await page.evaluate(() => {
      const v = document.getElementById('player');
      v.currentTime = 5;
      return v.play();
    });
    const play = await waitFor(() => fake.calls.slice(before).find((c) => c.path === '/hssp/play'), 8000, 'hssp play');
    log('play body', JSON.stringify(play.body));
    assert.ok(Math.abs(play.body.startTime - 5000) < 600, 'startTime matches video time');
    assert.ok(Math.abs(play.body.estimatedServerTime - (play.at + 1234)) < 1500, 'server time estimate');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'desktop-playing.png') });
    const b2 = fake.calls.length;
    await page.evaluate(() => {
      document.getElementById('player').currentTime = 15;
    });
    const replay = await waitFor(() => fake.calls.slice(b2).find((c) => c.path === '/hssp/play'), 8000, 'replay after seek');
    assert.ok(Math.abs(replay.body.startTime - 15000) < 800, 'seek re-syncs');
    const b3 = fake.calls.length;
    await page.evaluate(() => document.getElementById('player').pause());
    await waitFor(() => fake.calls.slice(b3).find((c) => c.path === '/hssp/stop'), 8000, 'hssp stop');
    log('play / seek / pause sync OK');

    // Funscript export format sanity.
    const exported = JSON.parse(require('../../src/shared/funscript.js').serialize(actions));
    assert.ok(exported.actions.length > 40);

    // Mobile layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'mobile-panel.png') });

    // Cross-origin (tainted) video -> hidden CORS clone fallback.
    let sawCors = null;
    await context.route('https://ev.phncdn.com/**', (route) => {
      const req = route.request();
      const cors = req.headers()['origin'] ? { 'Access-Control-Allow-Origin': '*' } : {};
      if (req.headers()['origin']) sawCors = true;
      return fulfillVideo(route, cors);
    });
    await context.route('https://www.pornhub.com/view_video.php?viewkey=e2e2', (route) =>
      route.fulfill({ contentType: 'text/html', body: pageHtml('https://ev.phncdn.com/e2e/video.webm') })
    );
    const page2 = await context.newPage();
    await page2.setViewportSize({ width: 1280, height: 800 });
    await page2.goto('https://www.pornhub.com/view_video.php?viewkey=e2e2');
    await page2.waitForFunction(() => document.getElementById('handy-ai-root'));
    await page2.waitForFunction(() => document.getElementById('player').readyState >= 1);
    const tainted = await page2.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('2d');
      const v = document.getElementById('player');
      return new Promise((r) => {
        v.addEventListener('loadeddata', () => {
          g.drawImage(v, 0, 0, 10, 10);
          try {
            g.getImageData(0, 0, 1, 1);
            r(false);
          } catch (e) {
            r(true);
          }
        }, { once: true });
        if (v.readyState >= 2) v.dispatchEvent(new Event('loadeddata'));
      });
    });
    log('cross-origin player tainted:', tainted);
    await clickShadow(page2, (n) => attr(n, 'class') === 'fab');
    await clickShadow(page2, (n) => attr(n, 'data-a') === 'scan');
    const rec2 = await waitFor(() => getRec('e2e2'), 60000, 'clone scan result');
    log('clone used a CORS request:', !!sawCors);
    checkScript(rec2, 'cross-origin clone');

    log('ALL E2E CHECKS PASSED');
  } catch (e) {
    failed = true;
    console.error('[e2e] FAILED:', e);
  } finally {
    await context.close();
    fake.server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
