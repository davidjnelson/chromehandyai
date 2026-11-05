'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandyClient } = require('../../src/shared/handy.js');

/** Fake Handy cloud: records calls, server clock = local clock + 5000 ms. */
function fakeServer({ connected = true, latency = 20 } = {}) {
  const calls = [];
  let local = 1_000_000;
  const now = () => local;
  const fetch = async (url, init) => {
    local += latency / 2;
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method, headers: init.headers || {}, body });
    const path = url.replace('https://www.handyfeeling.com/api/handy/v2', '');
    let status = 200;
    let data;
    if (url.endsWith('/hosting/v2/upload')) data = { url: 'https://scripts.example/abc.csv' };
    else if (!init.headers['X-Connection-Key']) {
      status = 400;
      data = { error: { message: 'missing key' } };
    } else if (path === '/connected') data = { connected };
    else if (path === '/servertime') data = { serverTime: local + 5000 };
    else if (path === '/mode') data = { result: 0 };
    else if (path === '/hssp/setup') data = { result: 0 };
    else if (path === '/hssp/play') data = { result: 0 };
    else if (path === '/hssp/stop') data = { result: 0 };
    else {
      status = 404;
      data = { error: { message: 'not found' } };
    }
    local += latency / 2;
    return { ok: status < 300, status, json: async () => data };
  };
  return { fetch, now, calls };
}

test('connect checks the device and estimates the server clock offset', async () => {
  const srv = fakeServer();
  const c = createHandyClient({ fetch: srv.fetch, now: srv.now, connectionKey: 'KEY' });
  const r = await c.connect();
  assert.ok(Math.abs(r.offset - 5000) < 1, 'offset ' + r.offset);
  assert.equal(srv.calls[0].headers['X-Connection-Key'], 'KEY');
});

test('offline device gives a clear error', async () => {
  const srv = fakeServer({ connected: false });
  const c = createHandyClient({ fetch: srv.fetch, now: srv.now, connectionKey: 'KEY' });
  await assert.rejects(c.connect(), /offline/);
});

test('missing key is reported before any request', async () => {
  const srv = fakeServer();
  const c = createHandyClient({ fetch: srv.fetch, now: srv.now });
  await assert.rejects(c.isConnected(), /connection key/);
  assert.equal(srv.calls.length, 0);
});

test('upload, setup and play send the HSSP sequence', async () => {
  const srv = fakeServer();
  const c = createHandyClient({ fetch: srv.fetch, now: srv.now, connectionKey: 'KEY' });
  await c.syncTime(2);
  const url = await c.upload('0,0\n500,100\n', 'x.csv');
  assert.equal(url, 'https://scripts.example/abc.csv');
  assert.ok(srv.calls.find((x) => x.url.endsWith('/upload')).body instanceof FormData);
  await c.setupScript(url);
  await c.play(2_000_000, 12345.6);
  await c.stop();
  const seq = srv.calls.filter((x) => !x.url.endsWith('/servertime')).map((x) => x.method + ' ' + x.url.split('/v2')[1]);
  assert.deepEqual(seq, ['POST /upload', 'PUT /mode', 'PUT /hssp/setup', 'PUT /hssp/play', 'PUT /hssp/stop']);
  const mode = srv.calls.find((x) => x.url.endsWith('/mode'));
  assert.deepEqual(mode.body, { mode: 1 });
  const setup = srv.calls.find((x) => x.url.endsWith('/hssp/setup'));
  assert.deepEqual(setup.body, { url });
  const play = srv.calls.find((x) => x.url.endsWith('/hssp/play'));
  assert.equal(play.body.startTime, 12346);
  assert.ok(Math.abs(play.body.estimatedServerTime - 2_005_000) <= 1);
});

test('API errors are surfaced', async () => {
  const fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Bad thing' } }) });
  const c = createHandyClient({ fetch, connectionKey: 'K' });
  await assert.rejects(c.stop(), /Bad thing/);
});
