'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('../../src/shared/funscript.js');
const motion = require('../../src/shared/motion.js');
const { rng, texture, render } = require('./synthetic.js');

const W = 128;
const H = 72;

/** Simulate a scan: frames sampled every dt seconds, patches moving per motionFn(t). */
function simulate({ duration, dt, patches, cutAt = [], noise = 6 }) {
  const r = rng(7);
  let bg = texture(W, H, 1);
  const est = motion.createMotionEstimator(W, H);
  const samples = { t: [], feat: [], cut: [] };
  let prev = null;
  for (let t = 0; t <= duration; t += dt) {
    if (cutAt.some((c) => Math.abs(c - t) < dt / 2)) bg = texture(W, H, Math.round(t * 100) + 3);
    const frame = render(
      W,
      H,
      bg,
      patches.map((p) => ({ ...p, dy: p.motion(t) })),
      noise,
      r
    );
    if (prev) {
      const { feat, meanDiff } = est.estimate(prev, frame);
      samples.t.push(t);
      samples.feat.push(feat);
      samples.cut.push(meanDiff > 30);
    } else {
      samples.t.push(t);
      samples.feat.push(new Float32Array(est.nb * 2));
      samples.cut.push(false);
    }
    prev = frame;
  }
  return samples;
}

function peaksOf(actions) {
  const peaks = [];
  for (let i = 1; i < actions.length - 1; i++) {
    if (actions[i].pos > actions[i - 1].pos && actions[i].pos >= actions[i + 1].pos) peaks.push(actions[i]);
  }
  return peaks;
}

test('block matching recovers a known shift', () => {
  const tex = texture(W, H, 42);
  const est = motion.createMotionEstimator(W, H);
  const a = new Uint8Array(W * H);
  const b = new Uint8Array(W * H);
  // b(x, y) = a(x - 3, y - 5): content moved right 3, down 5
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = tex[y * W + x];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - 3));
      const sy = Math.min(H - 1, Math.max(0, y - 5));
      b[y * W + x] = a[sy * W + sx];
    }
  }
  const { feat } = est.estimate(a, b);
  // Interior blocks (the frame edge has no real content to match after the shift).
  const dxs = [];
  const dys = [];
  for (let by = 1; by < est.bh; by++) {
    for (let bx = 1; bx < est.bw; bx++) {
      const k = by * est.bw + bx;
      dxs.push(feat[2 * k]);
      dys.push(feat[2 * k + 1]);
    }
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  assert.ok(Math.abs(med(dxs) - 3) < 0.3, 'dx ' + med(dxs));
  assert.ok(Math.abs(med(dys) - 5) < 0.3, 'dy ' + med(dys));
  const good = dxs.filter((x, i) => Math.abs(x - 3) < 0.5 && Math.abs(dys[i] - 5) < 0.5).length;
  assert.ok(good > dxs.length * 0.85, 'consistent blocks ' + good + '/' + dxs.length);
});

test('a vertically oscillating patch becomes strokes at the right tempo', () => {
  const f = 1.5; // Hz
  const duration = 20;
  const patchTex = texture(32, 32, 99);
  const samples = simulate({
    duration,
    dt: 1 / 15,
    patches: [{ x: 48, y: 20, w: 32, h: 32, tex: patchTex, motion: (t) => 8 * Math.sin(2 * Math.PI * f * t) }],
  });
  const sig = motion.analyze(samples);
  const actions = motion.generateActions(sig, {});
  const peaks = peaksOf(actions);
  const expected = f * duration;
  assert.ok(Math.abs(peaks.length - expected) <= 3, `peaks ${peaks.length} vs ${expected}`);

  // Patch moves UP in the image (dy negative) when sin goes negative, i.e. at
  // t = (0.75 + k) / f it is highest -> funscript peaks (pos high) there.
  let err = 0;
  for (const p of peaks.slice(2, -2)) {
    const phase = ((p.at / 1000) * f) % 1;
    err += Math.min(Math.abs(phase - 0.75), 1 - Math.abs(phase - 0.75));
  }
  err /= Math.max(1, peaks.length - 4);
  assert.ok(err < 0.12, 'peak phase error ' + err.toFixed(3));

  const st = fs.stats(actions);
  assert.ok(st.maxSpeed <= 500 + 15, 'speed limited: ' + st.maxSpeed);
  assert.ok(actions.every((a) => a.pos >= 0 && a.pos <= 100));
});

test('opposite-moving regions reinforce instead of cancelling', () => {
  const f = 1;
  const duration = 16;
  const samples = simulate({
    duration,
    dt: 1 / 15,
    patches: [
      { x: 10, y: 20, w: 32, h: 32, tex: texture(32, 32, 5), motion: (t) => 6 * Math.sin(2 * Math.PI * f * t) },
      { x: 80, y: 20, w: 32, h: 32, tex: texture(32, 32, 6), motion: (t) => -6 * Math.sin(2 * Math.PI * f * t) },
    ],
  });
  const sig = motion.analyze(samples);
  const peaks = peaksOf(motion.generateActions(sig, {}));
  assert.ok(Math.abs(peaks.length - f * duration) <= 3, 'peaks ' + peaks.length);
});

test('still footage produces no strokes', () => {
  const samples = simulate({
    duration: 10,
    dt: 1 / 15,
    patches: [{ x: 48, y: 20, w: 32, h: 32, tex: texture(32, 32, 9), motion: () => 0 }],
  });
  const actions = motion.generateActions(motion.analyze(samples), {});
  assert.ok(peaksOf(actions).length <= 1, 'got ' + actions.length + ' actions');
});

test('scene cuts split segments and strokes continue after the cut', () => {
  const f = 1.2;
  const samples = simulate({
    duration: 20,
    dt: 1 / 15,
    cutAt: [10],
    patches: [{ x: 48, y: 20, w: 32, h: 32, tex: texture(32, 32, 11), motion: (t) => 7 * Math.sin(2 * Math.PI * f * t) }],
  });
  assert.ok(samples.cut.some(Boolean), 'cut detected');
  const sig = motion.analyze(samples);
  assert.equal(new Set(sig.seg).size, 2);
  const peaks = peaksOf(motion.generateActions(sig, {}));
  const after = peaks.filter((p) => p.at > 10500).length;
  assert.ok(after >= 9, 'strokes after cut: ' + after);
});

test('range, invert and sensitivity params are respected', () => {
  const samples = simulate({
    duration: 12,
    dt: 1 / 15,
    patches: [{ x: 48, y: 20, w: 32, h: 32, tex: texture(32, 32, 13), motion: (t) => 6 * Math.sin(2 * Math.PI * t) }],
  });
  const sig = motion.analyze(samples);
  const ranged = motion.generateActions(sig, { minPos: 20, maxPos: 70 });
  assert.ok(ranged.every((a) => a.pos >= 20 && a.pos <= 70));

  const normal = peaksOf(motion.generateActions(sig, {}));
  const inverted = peaksOf(motion.generateActions(sig, { invert: true }));
  // Inverted peaks sit half a period away from normal peaks.
  const pn = (normal[3].at / 1000) % 1;
  const pi = (inverted[3].at / 1000) % 1;
  const d = Math.abs(pn - pi);
  assert.ok(Math.abs(Math.min(d, 1 - d) - 0.5) < 0.15, 'phase difference ' + d);

  // Packing round-trips well enough to regenerate the same script.
  const again = motion.generateActions(motion.unpackSignal(JSON.parse(JSON.stringify(motion.packSignal(sig)))), {});
  const orig = motion.generateActions(sig, {});
  assert.ok(Math.abs(again.length - orig.length) <= 2);
});
