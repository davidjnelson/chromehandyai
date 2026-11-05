/*
 * Funscript helpers: parse, serialize, CSV export (what The Handy's HSSP mode
 * consumes), speed limiting and a few stats.
 *
 * Plain script (no modules) so it can be loaded as a content script, from the
 * options page, and from Node tests (via module.exports).
 */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Sort by time, round, clamp to 0..100 and drop duplicate timestamps (last wins). */
  function normalizeActions(actions) {
    const sorted = (actions || [])
      .map((a) => ({ at: Math.round(Number(a.at)), pos: Math.round(clamp(Number(a.pos), 0, 100)) }))
      .filter((a) => Number.isFinite(a.at) && Number.isFinite(a.pos) && a.at >= 0)
      .sort((a, b) => a.at - b.at);
    const out = [];
    for (const a of sorted) {
      if (out.length && out[out.length - 1].at === a.at) out[out.length - 1] = a;
      else out.push(a);
    }
    return out;
  }

  function parse(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Not a valid .funscript file (bad JSON)');
    }
    if (!data || !Array.isArray(data.actions)) throw new Error('Funscript has no "actions" list');
    let actions = normalizeActions(data.actions);
    if (data.inverted === true) actions = actions.map((a) => ({ at: a.at, pos: 100 - a.pos }));
    if (!actions.length) throw new Error('Funscript contains no actions');
    return { actions, metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {} };
  }

  function serialize(actions, metadata) {
    return JSON.stringify({
      version: '1.0',
      inverted: false,
      range: 100,
      actions: normalizeActions(actions),
      metadata: metadata || {},
    });
  }

  /** "at,pos" lines, the format The Handy firmware downloads in HSSP mode. */
  function toCsv(actions) {
    return normalizeActions(actions).map((a) => a.at + ',' + a.pos).join('\n') + '\n';
  }

  /**
   * Make every segment respect maxSpeed (position units per second) by pulling
   * both endpoints of a too-fast segment towards each other. Iterating keeps
   * strokes centred instead of letting them drift to one end of the range.
   */
  function limitSpeed(actions, maxSpeed) {
    const a = actions.map((x) => ({ at: x.at, pos: x.pos }));
    if (!(maxSpeed > 0) || a.length < 2) return a;
    for (let pass = 0; pass < 30; pass++) {
      let changed = false;
      for (let i = 1; i < a.length; i++) {
        const dt = (a[i].at - a[i - 1].at) / 1000;
        const allowed = maxSpeed * dt;
        const d = a[i].pos - a[i - 1].pos;
        if (Math.abs(d) > allowed + 0.5) {
          const excess = (Math.abs(d) - allowed) / 2;
          const s = Math.sign(d);
          a[i].pos -= s * excess;
          a[i - 1].pos += s * excess;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return a.map((x) => ({ at: x.at, pos: Math.round(clamp(x.pos, 0, 100)) }));
  }

  /** Interpolated position at time ms (for drawing). */
  function positionAt(actions, ms) {
    if (!actions.length) return null;
    if (ms <= actions[0].at) return actions[0].pos;
    const last = actions[actions.length - 1];
    if (ms >= last.at) return last.pos;
    let lo = 0;
    let hi = actions.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (actions[mid].at <= ms) lo = mid;
      else hi = mid;
    }
    const p = actions[lo];
    const n = actions[hi];
    return p.pos + ((n.pos - p.pos) * (ms - p.at)) / (n.at - p.at);
  }

  function stats(actions) {
    if (actions.length < 2) return { strokes: 0, avgSpeed: 0, maxSpeed: 0, start: 0, end: 0 };
    let dist = 0;
    let moving = 0;
    let maxSpeed = 0;
    let strokes = 0;
    for (let i = 1; i < actions.length; i++) {
      const d = Math.abs(actions[i].pos - actions[i - 1].pos);
      const dt = (actions[i].at - actions[i - 1].at) / 1000;
      if (d > 0 && dt > 0) {
        dist += d;
        moving += dt;
        maxSpeed = Math.max(maxSpeed, d / dt);
        strokes++;
      }
    }
    return {
      strokes: Math.round(strokes / 2),
      avgSpeed: moving ? Math.round(dist / moving) : 0,
      maxSpeed: Math.round(maxSpeed),
      start: actions[0].at,
      end: actions[actions.length - 1].at,
    };
  }

  /** Short stable hash of a string (FNV-1a), used to tell scripts apart. */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  const api = { normalizeActions, parse, serialize, toCsv, limitSpeed, positionAt, stats, hash, clamp };
  HAI.funscript = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
