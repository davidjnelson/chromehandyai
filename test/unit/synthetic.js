// Synthetic grayscale frames for testing the motion pipeline without a browser.
'use strict';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Smooth random texture (w x h), values 0..255. */
function texture(w, h, seed) {
  const r = rng(seed);
  const coarse = [];
  const cw = Math.ceil(w / 4) + 2;
  const ch = Math.ceil(h / 4) + 2;
  for (let i = 0; i < cw * ch; i++) coarse.push(r() * 255);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / 4;
      const gy = y / 4;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const v00 = coarse[y0 * cw + x0];
      const v10 = coarse[y0 * cw + x0 + 1];
      const v01 = coarse[(y0 + 1) * cw + x0];
      const v11 = coarse[(y0 + 1) * cw + x0 + 1];
      out[y * w + x] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }
  return out;
}

/**
 * Render a frame: static background, plus patches whose y offset is given.
 * patches: [{x, y, w, h, tex, dy}]
 */
function render(w, h, bg, patches, noise, r) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = bg[i];
  for (const p of patches) {
    for (let y = 0; y < p.h; y++) {
      const fy = p.y + y + p.dy; // fractional
      const iy = Math.floor(fy);
      const a = fy - iy;
      for (let x = 0; x < p.w; x++) {
        const X = p.x + x;
        if (X < 0 || X >= w) continue;
        // bilinear "splat" along y for sub-pixel motion
        const val = p.tex[y * p.w + x];
        if (iy >= 0 && iy < h) out[iy * w + X] = Math.round(out[iy * w + X] * a + val * (1 - a));
        if (iy + 1 >= 0 && iy + 1 < h) out[(iy + 1) * w + X] = Math.round(out[(iy + 1) * w + X] * (1 - a) + val * a);
      }
    }
  }
  if (noise) for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, out[i] + (r() - 0.5) * noise));
  return out;
}

module.exports = { rng, texture, render };
