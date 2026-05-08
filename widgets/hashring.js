// widgets/hashring.js
//
// Consistent hashing on a ring. Nodes are placed at random positions
// on a circle (their "hash"), and each key is owned by the FIRST
// node clockwise from the key's position. The colored segments show
// which node owns which arc; the small dots inside the ring are
// keys, colored by their current owner.
//
// Why this matters:
//   - Naïve sharding hashes a key with `key % N` and routes it to
//     shard N. When N changes, *every* key potentially moves.
//   - Consistent hashing places nodes on a 1D ring. When a node
//     joins or leaves, only keys in that slice of the ring move —
//     about K/N of them, not all K.
//   - That's why every CDN, DynamoDB, Cassandra, memcached client,
//     and load balancer that wants graceful scale-out uses some
//     variation of this idea. (Production systems also use *virtual
//     nodes* — each physical node hashes to many ring positions —
//     for better balance. Skipped here for clarity.)
//
// The educational payoff is the *migration*: after a node joins or
// leaves we snapshot which keys changed owner, then animate just
// those keys (pulsing halo + colour crossfade) so you can literally
// see "only K/N keys moved" instead of having to take it on faith.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W      = 360;
const MAX_W      = 520;
const MIN_NODES  = 3;
const MAX_NODES  = 7;
const N_KEYS     = 32;
const TICK_MS    = 1400;     // a touch slower so the migration animation can finish
const MIGRATE_MS = 900;      // duration of the per-key migration animation

// Muted palette — distinct enough to read, calm enough to fit the page.
// Stored as RGB triples so we can lerp between them during migration.
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
  let nodes = [];           // sorted by angle: [{ id, angle, color }]
  let keys = [];            // [{ angle, ownerId, prevColor, migrateAt }]
  let phase = 'grow';       // 'grow' | 'shrink'
  let highlight = null;
  let nextId = 1;
  let lastOp = '';
  let migrating = 0;        // count of keys currently in a migration animation
  let nextTickAt = 0;
  let rafId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// consistent hashing · auto-cycling',
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

  function addNode() {
    const id = nextId++;
    const angle = Math.random() * Math.PI * 2;
    const color = PALETTE_RGB[(id - 1) % PALETTE_RGB.length];
    const node = { id, angle, color };
    nodes.push(node);
    nodes.sort((a, b) => a.angle - b.angle);
    return node;
  }

  function removeRandomNode() {
    if (nodes.length === 0) return null;
    const i = Math.floor(Math.random() * nodes.length);
    return nodes.splice(i, 1)[0];
  }

  // First node clockwise from `a`. Wraps around if no node has
  // angle >= a (i.e., all nodes are "behind" the key).
  function ownerForAngle(a) {
    for (const n of nodes) if (n.angle >= a) return n;
    return nodes[0];
  }

  function nodeById(id) {
    for (const n of nodes) if (n.id === id) return n;
    return null;
  }

  function init() {
    nodes = [];
    keys = [];
    nextId = 1;
    for (let i = 0; i < MIN_NODES; i++) addNode();
    for (let i = 0; i < N_KEYS; i++) {
      keys.push({ angle: Math.random() * Math.PI * 2,
                  ownerId: null, prevColor: null, migrateAt: 0 });
    }
    // Initial assignment — no migration animation on first paint.
    for (const k of keys) {
      const o = ownerForAngle(k.angle);
      k.ownerId = o ? o.id : null;
    }
  }

  // Diff key ownership before/after a mutation and start animations
  // on the keys whose owner changed.
  function applyMutation(mutate, now) {
    const before = new Map();
    for (const k of keys) before.set(k, nodeById(k.ownerId));

    mutate();

    let changed = 0;
    for (const k of keys) {
      const newOwner = ownerForAngle(k.angle);
      const oldOwner = before.get(k);
      const oldId = oldOwner ? oldOwner.id : null;
      const newId = newOwner ? newOwner.id : null;
      if (newId !== oldId) {
        k.prevColor = oldOwner ? oldOwner.color : null;
        k.ownerId   = newId;
        k.migrateAt = now;
        changed++;
      }
    }
    return changed;
  }

  // ---- cycle ----------------------------------------------------

  function tick(now) {
    highlight = null;
    if (phase === 'grow') {
      let added;
      const moved = applyMutation(() => { added = addNode(); }, now);
      highlight = added;
      lastOp = `+ node ${added.id} · ${moved}/${keys.length} keys move`;
      if (nodes.length >= MAX_NODES) phase = 'shrink';
    } else {
      let removed;
      const moved = applyMutation(() => { removed = removeRandomNode(); }, now);
      lastOp = `– node ${removed ? removed.id : '?'} · ${moved}/${keys.length} keys move`;
      if (nodes.length <= MIN_NODES) phase = 'grow';
    }
  }

  // ---- drawing --------------------------------------------------

  // ease-out cubic — animation starts fast and settles.
  function ease(t) { return 1 - Math.pow(1 - t, 3); }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    if (nodes.length === 0) return;

    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) * 0.36;

    // Ownership arcs — thick coloured strokes. Each node owns the arc
    // from the previous node's angle to its own (going clockwise).
    ctx.lineWidth = 16;
    ctx.lineCap = 'butt';
    for (let i = 0; i < nodes.length; i++) {
      const curr = nodes[i];
      const prev = nodes[(i - 1 + nodes.length) % nodes.length];
      ctx.strokeStyle = rgb(curr.color, 0.85);
      ctx.beginPath();
      ctx.arc(cx, cy, R, prev.angle, curr.angle);
      ctx.stroke();
    }

    // Thin outline on top so the ring reads cleanly.
    ctx.strokeStyle = 'rgba(28, 31, 36, 0.20)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Keys — small dots inside the ring at their hash angle. Migrating
    // keys cross-fade colour and grow a brief halo so the eye is drawn
    // to *exactly* the slice that changed hands.
    migrating = 0;
    const keyR = R - 18;
    for (const k of keys) {
      const x = cx + keyR * Math.cos(k.angle);
      const y = cy + keyR * Math.sin(k.angle);

      const owner = nodeById(k.ownerId);
      const ownerCol = owner ? owner.color : [120, 120, 120];

      const t = k.migrateAt ? Math.min(1, (now - k.migrateAt) / MIGRATE_MS) : 1;
      const animating = t < 1;
      if (animating) migrating++;

      // Halo: starts at radius 3, expands to 12, fades from 0.55 → 0.
      if (animating && k.prevColor) {
        const e = ease(t);
        const haloR = 3 + e * 9;
        ctx.fillStyle = lerpRgb(k.prevColor, ownerCol, e, 0.55 * (1 - e));
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, Math.PI * 2);
        ctx.fill();
      }

      // The dot itself crossfades old → new colour.
      const dotR = animating ? 2.2 + (1 - t) * 1.6 : 2.2;
      ctx.fillStyle = (animating && k.prevColor)
        ? lerpRgb(k.prevColor, ownerCol, ease(t), 1)
        : rgb(ownerCol, 1);
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Node markers — sit on the ring, label = id.
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const x = cx + R * Math.cos(n.angle);
      const y = cy + R * Math.sin(n.angle);
      const isHi = n === highlight;
      ctx.fillStyle = rgb(n.color, 1);
      ctx.strokeStyle = isHi ? 'rgba(243, 239, 230, 1)' : 'rgba(28, 31, 36, 0.55)';
      ctx.lineWidth = isHi ? 2.4 : 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.fillText(String(n.id), x, y);
    }

    // Op label, top-left.
    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    ctx.font = "italic 13px 'Instrument Serif', serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(lastOp || (nodes.length + ' nodes · ' + N_KEYS + ' keys'), 10, 8);
  }

  // Single rAF loop drives both the tick cadence and the migration
  // animation. setInterval would have made the keys "snap" between
  // ticks; this way the halos breathe smoothly even between events.
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
