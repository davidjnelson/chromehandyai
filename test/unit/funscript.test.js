'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('../../src/shared/funscript.js');

test('parse normalises, sorts and handles inverted scripts', () => {
  const text = JSON.stringify({ inverted: true, actions: [{ at: 500, pos: 90 }, { at: 0, pos: 10 }, { at: 500, pos: 80 }, { at: 'x', pos: 1 }] });
  const { actions } = fs.parse(text);
  assert.deepEqual(actions, [{ at: 0, pos: 90 }, { at: 500, pos: 20 }]);
});

test('parse rejects junk', () => {
  assert.throws(() => fs.parse('nope'), /JSON/);
  assert.throws(() => fs.parse('{}'), /actions/);
  assert.throws(() => fs.parse('{"actions":[]}'), /no actions/);
});

test('serialize round-trips and CSV is at,pos per line', () => {
  const acts = [{ at: 0, pos: 0 }, { at: 400, pos: 100 }];
  assert.deepEqual(fs.parse(fs.serialize(acts)).actions, acts);
  assert.equal(fs.toCsv(acts), '0,0\n400,100\n');
});

test('limitSpeed keeps strokes centred and under the limit', () => {
  const acts = [];
  for (let i = 0; i < 20; i++) acts.push({ at: i * 100, pos: i % 2 ? 100 : 0 });
  const out = fs.limitSpeed(acts, 400);
  for (let i = 1; i < out.length; i++) {
    const sp = Math.abs(out[i].pos - out[i - 1].pos) / ((out[i].at - out[i - 1].at) / 1000);
    assert.ok(sp <= 400 + 15, 'speed ' + sp);
  }
  const mid = out.slice(2, -2).reduce((s, a) => s + a.pos, 0) / (out.length - 4);
  assert.ok(Math.abs(mid - 50) < 5, 'centred around ' + mid);
});

test('positionAt interpolates', () => {
  const acts = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
  assert.equal(fs.positionAt(acts, 250), 25);
  assert.equal(fs.positionAt(acts, 5000), 100);
});
