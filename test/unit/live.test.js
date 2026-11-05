'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const motion = require('../../src/shared/motion.js');
const live = require('../../src/shared/live.js');
const { rng, texture, render } = require('./synthetic.js');

const W = 128;
const H = 72;

/** Feed frames to the live tracker as if playing in real time. */
function runLive({ duration, dt, f, cutAt = [], seekAt = null }) {
  const r = rng(3);
  let bg = texture(W, H, 1);
  const patch = texture(32, 32, 99);
  const est = motion.createMotionEstimator(W, H);
  const tracker = live.createLiveTracker();
  const rhythm = live.createRhythm();
  const extremes = [];
  const predictions = [];
  let prev = null;
  let t = 0;
  let wall = 0;
  while (wall <= duration) {
    if (seekAt && Math.abs(wall - seekAt.at) < dt / 2) {
      t = seekAt.to; // jump in media time
      prev = null;
    }
    if (cutAt.some((c) => Math.abs(c - t) < dt / 2)) bg = texture(W, H, Math.round(t * 100) + 5);
    const frame = render(W, H, bg, [{ x: 48, y: 20, w: 32, h: 32, tex: patch, dy: 8 * Math.sin(2 * Math.PI * f * t) }], 6, r);
    if (prev) {
      const e = est.estimate(prev, frame);
      const out = tracker.push(t, e.feat, e.meanDiff > 30);
      if (e.meanDiff > 30) rhythm.reset();
      if (out.extreme) {
        extremes.push(out.extreme);
        rhythm.onExtreme(out.extreme);
      }
      const p = rhythm.predict(t + 0.25); // 250 ms latency lookahead
      if (p) predictions.push({ madeAt: t, ...p });
    } else {
      tracker.push(t, new Float32Array(est.nb * 2), true);
      rhythm.reset();
    }
    prev = frame;
    t += dt;
    wall += dt;
  }
  return { extremes, predictions };
}

/** Patch highest in image (funscript top) at phase 0.75, lowest at 0.25. */
function phaseError(time, type, f) {
  const target = type === 1 ? 0.75 : 0.25;
  const ph = (time * f) % 1;
  const d = Math.abs(ph - target);
  return Math.min(d, 1 - d) / f; // seconds
}

test('live tracker finds turning points with little delay', () => {
  const f = 1.5;
  const { extremes } = runLive({ duration: 15, dt: 1 / 20, f });
  const after = extremes.filter((e) => e.t > 3);
  // 2 turning points per cycle
  assert.ok(Math.abs(after.length - 2 * f * 12) <= 4, 'extremes ' + after.length);
  const err = after.reduce((s, e) => s + phaseError(e.t, e.type, f), 0) / after.length;
  assert.ok(err < 0.06, 'turning point timing error ' + (err * 1000).toFixed(0) + ' ms');
});

test('rhythm predicts upcoming turning points ahead of time', () => {
  const f = 1.2;
  const { predictions } = runLive({ duration: 15, dt: 1 / 20, f });
  const late = predictions.filter((p) => p.madeAt > 4);
  assert.ok(late.length > 100);
  const err = late.reduce((s, p) => s + phaseError(p.t, p.type, f), 0) / late.length;
  assert.ok(err < 0.08, 'prediction error ' + (err * 1000).toFixed(0) + ' ms');
  // positions alternate between the two ends of the range
  assert.ok(late.every((p) => (p.type === 1 ? p.pos >= 60 : p.pos <= 40)));
});

test('re-locks quickly after a seek', () => {
  const f = 1.5;
  const { extremes } = runLive({ duration: 14, dt: 1 / 20, f, seekAt: { at: 6, to: 40 } });
  const afterSeek = extremes.filter((e) => e.t >= 40);
  assert.ok(afterSeek.length > 4, 'strokes after seek: ' + afterSeek.length);
  const first = afterSeek[0].t - 40;
  assert.ok(first < 2.0, 'first stroke after seek at +' + first.toFixed(2) + ' s');
});

test('no rhythm on still footage', () => {
  const tracker = live.createLiveTracker();
  const rhythm = live.createRhythm();
  const feat = new Float32Array(9 * 16 * 2);
  for (let i = 0; i < 200; i++) {
    const out = tracker.push(i / 20, feat, false);
    if (out.extreme) rhythm.onExtreme(out.extreme);
  }
  assert.equal(rhythm.predict(10), null);
});
