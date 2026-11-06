/*
 * Real-time mode end-to-end test: extension in Chromium, synthetic 1.5 Hz
 * video, fake Handy API. No pre-scan: just play the video and check that
 * the device receives HDSP moves timed to arrive at each turning point,
 * and that it re-locks after a seek.
 * Run: npm run test:realtime
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const VIDEO = fs.readFileSync(path.join(__dirname, 'fixtures', 'stroke-1.5hz.webm'));
const F = 1.5;
const log = (...a) => console.log('[realtime]', ...a);

function fakeHandy() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'X-Connection-Key, X-Api-Key, Content-Type, Accept',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = req.url.replace(/^\/api\/handy-rest\/v3/, '');
      const e = { path: p, at: Date.now(), appId: req.headers['x-api-key'], key: req.headers['x-connection-key'] };
      try {
        e.body = JSON.parse(body);
      } catch (err) {
        /* not json */
      }
      calls.push(e);
      // API v3 response formats (official spec).
      let data = { result: 'ok' };
      if (p === '/connected') data = { result: { connected: true } };
      if (p === '/servertime') data = { server_time: Date.now() };
      if (p === '/mode2') data = { result: { mode: e.body && e.body.mode, mode_session_id: 1 } };
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, port: server.address().port })));
}

function fulfillVideo(route) {
  const range = route.request().headers()['range'];
  const total = VIDEO.length;
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  const base = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' };
  if (!m) return route.fulfill({ status: 200, headers: base, body: VIDEO });
  const s = Number(m[1]);
  const e = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  return route.fulfill({ status: 206, headers: Object.assign({ 'Content-Range': `bytes ${s}-${e}/${total}` }, base), body: VIDEO.subarray(s, e + 1) });
}

async function shadowText(page, oName) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  await cdp.detach();
  let node = null;
  const walk = (n) => {
    const a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'data-o' && a[i + 1] === oName) node = node || n;
    (n.children || []).forEach(walk);
    (n.shadowRoots || []).forEach(walk);
  };
  walk(root);
  const text = [];
  const collect = (x) => {
    if (x.nodeType === 3) text.push(x.nodeValue);
    (x.children || []).forEach(collect);
  };
  if (node) collect(node);
  return text.join('');
}

/** Error (s) between a target media time and the nearest true turning point of that type. */
function phaseErr(t, isTop) {
  const target = isTop ? 0.75 : 0.25;
  const ph = (t * F) % 1;
  const d = Math.abs(ph - target);
  return Math.min(d, 1 - d) / F;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fake = await fakeHandy();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handy-rt-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--autoplay-policy=no-user-gesture-required'],
  });
  let ok = false;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
      connectionKey: 'RTKEY',
      appId: 'TESTAPPID',
      autoConnect: true,
      apiBase: `http://127.0.0.1:${fake.port}/api/handy-rest/v3`,
      uploadUrl: `http://127.0.0.1:${fake.port}/upload`,
    });
    await context.route('https://www.pornhub.com/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/e2e/video.webm') return fulfillVideo(route);
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta name=viewport content="width=device-width"><title>RT</title><video id=player src="/e2e/video.webm" preload=auto controls muted playsinline style="width:100%;max-width:960px"></video>',
      });
    });
    const page = await context.newPage();
    await page.goto('https://www.pornhub.com/view_video.php?viewkey=rt1');
    await page.waitForFunction(() => document.getElementById('handy-ai-root') && document.getElementById('player').readyState >= 2);
    const connected = Date.now() + 10000;
    while (!fake.calls.find((c) => c.path === '/servertime') && Date.now() < connected) await page.waitForTimeout(200);
    await page.waitForTimeout(1500); // let connect finish
    log('status before play:', await shadowText(page, 'scriptStatus'), '|', await shadowText(page, 'handyStatus'));

    // Clock map: wall time -> media time, sampled while playing.
    const clock = [];
    const sample = async () => clock.push(await page.evaluate(() => [Date.now(), document.getElementById('player').currentTime]));
    const mediaAt = (wall) => {
      let best = clock[0];
      for (const c of clock) if (Math.abs(c[0] - wall) < Math.abs(best[0] - wall)) best = c;
      return best[1] + (wall - best[0]) / 1000;
    };

    const playAt = Date.now();
    await page.evaluate(() => document.getElementById('player').play());
    for (let i = 0; i < 50; i++) {
      await sample();
      await page.waitForTimeout(200);
    }
    log('status while playing:', await shadowText(page, 'scriptStatus'));
    await page.screenshot({ path: path.join(OUT, 'realtime-playing.png') });

    const moves = fake.calls.filter((c) => c.path === '/hdsp/xpt' && c.at > playAt);
    assert.ok(fake.calls.some((c) => c.path === '/mode2' && c.body && c.body.mode === 2), 'switched device to HDSP (v3 /mode2)');
    assert.ok(fake.calls.every((c) => c.appId === 'TESTAPPID' && c.key === 'RTKEY'), 'v3 auth headers on every call');
    assert.ok(!fake.calls.some((c) => c.path === '/hssp/setup' || c.path === '/upload'), 'no pre-scan upload needed');
    log('moves received:', moves.length);
    const firstMove = moves[0] ? mediaAt(moves[0].at) : NaN;
    log('first move at video time', firstMove.toFixed(2), 's');
    assert.ok(firstMove < 3.0, 'starts within 3 s of pressing play');

    // When does each move arrive? receipt + duration + the engine's latency
    // allowance (rtt + 40 ms; rtt is ~0 on localhost).
    const steady = moves.filter((m) => mediaAt(m.at) > 3);
    fs.writeFileSync(path.join(OUT, 'realtime-moves.json'), JSON.stringify(moves.map((m) => ({ media: +mediaAt(m.at).toFixed(3), arrive: +(mediaAt(m.at) + (m.body.t + 40) / 1000).toFixed(3), pos: m.body.xp, dur: m.body.t }))));
    const errs = steady.map((m) => phaseErr(mediaAt(m.at) + (m.body.t + 40) / 1000, m.body.xp >= 50));
    const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
    const alternating = steady.filter((m, i) => i > 0 && (m.body.xp >= 50) !== (steady[i - 1].body.xp >= 50)).length / Math.max(1, steady.length - 1);
    log(`steady moves ${steady.length} (expected ≈ ${(2 * F * (mediaAt(Date.now()) - 3)).toFixed(0)}), mean arrival error ${(mean * 1000).toFixed(0)} ms, alternating ${(alternating * 100).toFixed(0)}%`);
    assert.ok(steady.length >= 2 * F * 5, 'enough strokes');
    assert.ok(mean < 0.1, 'moves arrive at the turning points');
    assert.ok(alternating > 0.85, 'moves alternate top/bottom');

    // Seek somewhere else: should re-lock quickly with no waiting.
    const seekWall = Date.now();
    await page.evaluate(() => {
      document.getElementById('player').currentTime = 20;
    });
    clock.length = 0;
    for (let i = 0; i < 20; i++) {
      await sample();
      await page.waitForTimeout(200);
    }
    const after = fake.calls.filter((c) => c.path === '/hdsp/xpt' && c.at > seekWall + 150);
    const relock = after.length ? mediaAt(after[0].at) - 20 : Infinity;
    log(`after seek to 0:20: first move +${relock.toFixed(2)} s, ${after.length} moves in ~4 s`);
    assert.ok(relock < 2.5, 're-locks within 2.5 s of a seek');

    // Pause stops commands.
    await page.evaluate(() => document.getElementById('player').pause());
    await page.waitForTimeout(600);
    const pausedAt = Date.now();
    await page.waitForTimeout(1500);
    assert.equal(fake.calls.filter((c) => c.path === '/hdsp/xpt' && c.at > pausedAt).length, 0, 'no moves while paused');

    ok = true;
    log('ALL REAL-TIME CHECKS PASSED');
  } catch (e) {
    console.error('[realtime] FAILED:', e);
  } finally {
    await context.close();
    fake.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
})();
