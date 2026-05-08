// widgets/hashring.js
//
// Consistent hashing on a ring — production-grade variant with
// VIRTUAL NODES. Each physical server hashes to several positions on
// the ring (vnodes), all in the same colour; ownership of an arc
// goes to the first vnode clockwise from the key. The original
// "naïve" version (one ring position per server) suffered from
// uneven load — random angles cluster — so every real system
// (Cassandra, DynamoDB, Riak, etc.) uses vnodes for better balance.
//
// Why this matters:
//   - Naïve sharding hashes a key with `key % N` and routes it to
//     shard N. When N changes, *every* key potentially moves.
//   - Consistent hashing places nodes on a 1D ring. When a node
//     joins or leaves, only keys in that slice of the ring move —
//     about K/N of them, not all K.
//   - Virtual nodes give each physical server multiple ring slots,
//     so the random-cluster variance averages out and each server
//     ends up with a roughly equal share of keys. Same migration
//     guarantee, much smoother load.
//
// The educational payoff is the *migration*: after a server joins
// or leaves we snapshot which keys changed owner, then animate just
// those keys (pulsing halo + colour crossfade) so you can literally
// see "only K/N keys moved" instead of having to take it on faith.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W      = 360;
const MAX_W      = 520;
const MIN_PHYS   = 3;        // physical nodes (servers)
const MAX_PHYS   = 6;
const VNODES_PER = 4;        // ring positions per physical node
const N_KEYS     = 48;
const TICK_MS    = 1500;
const MIGRATE_MS = 900;      // duration of the per-key migration animation

// Muted palette — distinct enough to read, calm enough to fit the page.
const PALETTE_RGB = [
  [ 76, 121, 166],   // steel blue
  [188,  98,  68],   // rust
  [ 86, 134,  98],   // forest
  [180, 152,  74],   // ochre
  [142, 109, 168],   // muted purple
  [ 76,  98, 116],   // slate
  [165,  84,  84],   // muted red
];
const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpRgb = (a, b, t, alpha = 1) =>
  `rgba(${Math.round(lerp(a[0], b[0], t))}, ${Math.round(lerp(a[1], b[1], t))}, ${Math.round(lerp(a[2], b[2], t))}, ${alpha})`;

export function hashring({ side = 'right', top = 1820 } = {}) {
  let W = MIN_W, H = MIN_W;
  // Each entry is one VIRTUAL node: { pid, angle, color }. Sorted by
  // angle so owner-lookup is a single linear scan.
  let vnodes = [];
  let keys = [];            // [{ angle, ownerPid, prevColor, migrateAt }]
  let phase = 'grow';
  let highlightPid = null;
  let nextPid = 1;
  let lastOp = '';
  let nextTickAt = 0;
  let rafId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// consistent hashing · virtual nodes',
  });

  function relayout() {
    W = H = responsiveWidth({ min: MIN_W, max: MAX_W });
    if (!place(wrap, { side, top, width: W })) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(performance.now());
  }

  // ---- ring operations ------------------------------------------

  // Add one physical node — that means VNODES_PER vnodes at random
  // angles, all sharing the same colour and pid.
  function addPhysical() {
    const pid   = nextPid++;
    const color = PALETTE_RGB[(pid - 1) % PALETTE_RGB.length];
    const added = [];
    for (let i = 0; i < VNODES_PER; i++) {
      const v = { pid, angle: Math.random() * Math.PI * 2, color };
      vnodes.push(v);
      added.push(v);
    }
    vnodes.sort((a, b) => a.angle - b.angle);
    return pid;
  }

  // Remove one physical node — yanks all of its vnodes off the ring
  // at once.
  function removeRandomPhysical() {
    const pids = uniquePids();
    if (pids.length === 0) return null;
    const pid = pids[Math.floor(Math.random() * pids.length)];
    vnodes = vnodes.filter(v => v.pid !== pid);
    return pid;
  }

  function uniquePids() {
    const s = new Set();
    for (const v of vnodes) s.add(v.pid);
    return [...s];
  }

  function physCount() { return uniquePids().length; }

  // First vnode clockwise from `a`. Wraps around the ring.
  function ownerForAngle(a) {
    for (const v of vnodes) if (v.angle >= a) return v;
    return vnodes[0];
  }

  // Per-physical key counts — drives the load-balance display.
  function keyCounts() {
    const counts = new Map();
    for (const k of keys) {
      counts.set(k.ownerPid, (counts.get(k.ownerPid) || 0) + 1);
    }
    return counts;
  }

  // Lookup the colour of a vnode for a given pid (first match — all
  // vnodes of a pid share colour, so any will do).
  function colorForPid(pid) {
    for (const v of vnodes) if (v.pid === pid) return v.color;
    return [120, 120, 120];
  }

  function init() {
    vnodes = [];
    keys = [];
    nextPid = 1;
    for (let i = 0; i < MIN_PHYS; i++) addPhysical();
    for (let i = 0; i < N_KEYS; i++) {
      keys.push({ angle: Math.random() * Math.PI * 2,
                  ownerPid: null, prevColor: null, migrateAt: 0 });
    }
    for (const k of keys) {
      const o = ownerForAngle(k.angle);
      k.ownerPid = o ? o.pid : null;
    }
  }

  // Diff key ownership before/after a mutation and start animations
  // on the keys whose owner changed.
  function applyMutation(mutate, now) {
    const beforePid = new Map();
    for (const k of keys) beforePid.set(k, k.ownerPid);

    mutate();

    let changed = 0;
    for (const k of keys) {
      const newOwner = ownerForAngle(k.angle);
      const oldPid = beforePid.get(k);
      const newPid = newOwner ? newOwner.pid : null;
      if (newPid !== oldPid) {
        k.prevColor = oldPid != null ? colorForPid(oldPid) : null;
        k.ownerPid  = newPid;
        k.migrateAt = now;
        changed++;
      }
    }
    return changed;
  }

  // ---- cycle ----------------------------------------------------

  function tick(now) {
    highlightPid = null;
    if (phase === 'grow') {
      let added;
      const moved = applyMutation(() => { added = addPhysical(); }, now);
      highlightPid = added;
      lastOp = `+ server ${added} · ${moved}/${keys.length} keys move`;
      if (physCount() >= MAX_PHYS) phase = 'shrink';
    } else {
      let removed;
      const moved = applyMutation(() => { removed = removeRandomPhysical(); }, now);
      lastOp = `– server ${removed} · ${moved}/${keys.length} keys move`;
      if (physCount() <= MIN_PHYS) phase = 'grow';
    }
  }

  // ---- drawing --------------------------------------------------

  function ease(t) { return 1 - Math.pow(1 - t, 3); }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    if (vnodes.length === 0) return;

    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) * 0.36;

    // Ownership arcs — many short coloured strokes now (one per
    // vnode), so colours interleave around the ring instead of
    // sitting in 5 fat slabs. Each arc extends ~0.01 rad past its
    // boundary on both sides so adjacent colours overlap and the
    // ring reads as continuous (no anti-aliasing seams).
    ctx.lineWidth = 14;
    ctx.lineCap = 'butt';
    const overlap = 0.012;
    for (let i = 0; i < vnodes.length; i++) {
      const curr = vnodes[i];
      const prev = vnodes[(i - 1 + vnodes.length) % vnodes.length];
      ctx.strokeStyle = rgb(curr.color, 0.85);
      ctx.beginPath();
      ctx.arc(cx, cy, R, prev.angle - overlap, curr.angle + overlap);
      ctx.stroke();
    }

    // Thin outline on top so the ring reads cleanly.
    ctx.strokeStyle = 'rgba(28, 31, 36, 0.20)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Keys — small dots inside the ring at their hash angle.
    const keyR = R - 18;
    for (const k of keys) {
      const x = cx + keyR * Math.cos(k.angle);
      const y = cy + keyR * Math.sin(k.angle);
      const ownerCol = k.ownerPid != null ? colorForPid(k.ownerPid) : [120, 120, 120];

      const t = k.migrateAt ? Math.min(1, (now - k.migrateAt) / MIGRATE_MS) : 1;
      const animating = t < 1;

      if (animating && k.prevColor) {
        const e = ease(t);
        const haloR = 3 + e * 9;
        ctx.fillStyle = lerpRgb(k.prevColor, ownerCol, e, 0.55 * (1 - e));
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, Math.PI * 2);
        ctx.fill();
      }

      const dotR = animating ? 2.2 + (1 - t) * 1.6 : 2.2;
      ctx.fillStyle = (animating && k.prevColor)
        ? lerpRgb(k.prevColor, ownerCol, ease(t), 1)
        : rgb(ownerCol, 1);
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Vnode markers — smaller circles, label is the pid (so a
    // server's 4 vnodes share a number and a colour). Highlight all
    // vnodes of the most-recently-changed pid.
    ctx.font = "8px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const v of vnodes) {
      const x = cx + R * Math.cos(v.angle);
      const y = cy + R * Math.sin(v.angle);
      const isHi = v.pid === highlightPid;
      ctx.fillStyle = rgb(v.color, 1);
      ctx.strokeStyle = isHi ? 'rgba(243, 239, 230, 1)' : 'rgba(28, 31, 36, 0.55)';
      ctx.lineWidth = isHi ? 2 : 1;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.fillText(String(v.pid), x, y);
    }

    // Centre stack: per-server load, sorted by pid. Each row is a
    // tiny coloured tag + the key count. Lets the eye verify that
    // load is roughly even across servers — the entire point of
    // virtual nodes.
    const counts = keyCounts();
    const pids = uniquePids().sort((a, b) => a - b);
    const rowH = 12;
    const totalH = rowH * pids.length;
    let ry = cy - totalH / 2 + rowH / 2;
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const pid of pids) {
      const c = counts.get(pid) || 0;
      const col = colorForPid(pid);
      // Coloured tag.
      ctx.fillStyle = rgb(col, 0.92);
      ctx.fillRect(cx - 26, ry - 4, 8, 8);
      // Label "n3  12".
      ctx.fillStyle = 'rgba(28, 31, 36, 0.80)';
      ctx.fillText(`n${pid}  ${c}`, cx - 14, ry);
      ry += rowH;
    }

    // Op label, top-left.
    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    ctx.font = "italic 13px 'Instrument Serif', serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(lastOp || `${pids.length} servers · ${vnodes.length} vnodes · ${N_KEYS} keys`, 10, 8);
  }

  function frame() {
    const now = performance.now();
    if (now >= nextTickAt) {
      tick(now);
      nextTickAt = now + TICK_MS;
    }
    draw(now);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (rafId) return;
    nextTickAt = performance.now() + TICK_MS;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  init();
  relayout();
  if (!reducedMotion()) start();
  else                   draw(performance.now());
}
