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
  await assert.rejects(c.connect(), /offline/i);
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

/** Fake v3 server per the official OpenAPI spec formats. */
function fakeV3({ connected = true, appIdOk = true } = {}) {
  const calls = [];
  let local = 5_000_000;
  const now = () => local;
  const fetch = async (url, init) => {
    local += 10;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body });
    const p = url.replace('https://www.handyfeeling.com/api/handy-rest/v3', '');
    let status = 200;
    let data;
    if (!appIdOk) {
      status = 401;
      data = { error: { code: 401, name: 'Unauthorized', message: 'bad key' } };
    } else if (p === '/connected') data = { result: { connected } };
    else if (p === '/servertime') data = { server_time: local + 777 };
    else if (p === '/mode2') data = { result: { mode: body.mode, mode_session_id: 1 } };
    else if (p === '/hssp/setup' || p === '/hssp/play') data = { result: { play_state: 0 } };
    else if (p === '/hssp/stop' || p === '/hdsp/xpt') data = { result: 'ok' };
    else {
      status = 404;
      data = { error: { message: 'nope' } };
    }
    local += 10;
    const text = JSON.stringify(data);
    return { ok: status < 300, status, text: async () => text };
  };
  return { fetch, now, calls };
}

test('v3: Application ID switches to API v3 with its formats', async () => {
  const srv = fakeV3();
  const c = createHandyClient({ fetch: srv.fetch, now: srv.now, connectionKey: 'KEY1', appId: 'APPID' });
  assert.equal(c.version, 'v3');
  const r = await c.connect();
  assert.ok(Math.abs(r.offset - 777) < 1, 'offset ' + r.offset);
  assert.equal(srv.calls[0].url, 'https://www.handyfeeling.com/api/handy-rest/v3/connected');
  assert.equal(srv.calls[0].headers['X-Api-Key'], 'APPID');
  assert.equal(srv.calls[0].headers['X-Connection-Key'], 'KEY1');

  await c.setupScript('https://scripts.example/a.csv');
  await c.play(6_000_000, 4321);
  await c.moveTo(80, 300);
  await c.moveTo(20, 300);
  const sent = srv.calls.filter((x) => !/servertime|connected/.test(x.url)).map((x) => [x.url.split('/v3')[1], x.body]);
  assert.deepEqual(sent[0], ['/mode2', { mode: 1 }]);
  assert.deepEqual(sent[1], ['/hssp/setup', { url: 'https://scripts.example/a.csv' }]);
  assert.equal(sent[2][0], '/hssp/play');
  assert.equal(sent[2][1].start_time, 4321);
  assert.ok(Math.abs(sent[2][1].server_time - 6_000_777) <= 1);
  assert.deepEqual(sent[3], ['/mode2', { mode: 2 }]);
  assert.deepEqual(sent[4], ['/hdsp/xpt', { xp: 80, t: 300, stop_on_target: true, immediate_rsp: true }]);
  assert.deepEqual(sent[5], ['/hdsp/xpt', { xp: 20, t: 300, stop_on_target: true, immediate_rsp: true }]);
});

test('v3: offline device and bad Application ID give clear messages', async () => {
  const off = fakeV3({ connected: false });
  await assert.rejects(createHandyClient({ fetch: off.fetch, now: off.now, connectionKey: 'K1234', appId: 'A' }).connect(), /offline.*Wi-Fi/);
  const bad = fakeV3({ appIdOk: false });
  await assert.rejects(createHandyClient({ fetch: bad.fetch, now: bad.now, connectionKey: 'K1234', appId: 'A' }).connect(), /Application ID/);
});

test('v2: offline hints at the Application ID for firmware 4', async () => {
  const srv = fakeServer({ connected: false });
  const c = createHandyClient({ fetch: srv.fetch, now: srv.now, connectionKey: 'KEY' });
  assert.equal(c.version, 'v2');
  await assert.rejects(c.connect(), /firmware 4.*Application ID/);
});
