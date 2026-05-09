// widgets/force-graph.js
//
// A small graph laid out by force-directed physics:
//   - every pair of nodes repels (Coulomb-like, F ∝ 1/d²)
//   - every edge is a spring pulling its endpoints toward a rest length
//   - a weak attraction toward the canvas center keeps the cloud bounded
//   - velocities are damped each frame so it settles instead of orbiting
//
// Drag any node with the mouse (or finger). While held, the node is
// pinned to the cursor — the rest of the graph reorganizes around it
// in real time. Release and it rejoins the simulation.
//
// [ shuffle ] regenerates a fresh random graph (always connected: a
// random spanning tree, plus a handful of extra edges).

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W   = 320;
const MAX_W   = 520;
const N_NODES = 14;        // initial size; mutator grows/shrinks within bounds
const N_MIN   = 10;
const N_MAX   = 20;
const EXTRA_EDGES = 7;     // beyond the spanning tree (initial graph)
// BFS-wave timing. STEP_MS is the per-edge travel time of the
// animated pulses; together with the graph's BFS radius it sets the
// overall length of one wave.
const STEP_MS  = 320;
const FLASH_MS = 380;
// Random topology mutation: every ~MUTATE_EVERY_MS we add a node and
// connect it, or kill a random one. Long-ish pauses keep the graph
// from feeling churny — the user gets time to read each state.
const MUTATE_EVERY_MS = 3500;
const FADE_MS         = 600;
// Premonition glow before the actual mutation lands — the spot
// pulses for PREMONITION_MS, and *then* the node appears /
// disappears. A full second so the eye actually catches it.
const PREMONITION_MS  = 1000;

export function forceGraph({ side = 'right', top = 1820 } = {}) {
  let W = MIN_W, H = MIN_W;
  let nodes = [];          // [{ id, x, y, vx, vy, fixed, birth, dyingAt }]
  let edges = [];          // [[id1, id2]]  — stable IDs, not array indices
  let nextId = 0;
  let dragging = null;
  let hover = null;
  let rafId = null;
  let nextMutateAt = 0;
  // Each entry { x, y, anchorId, t0 } is a future-spawn point that's
  // currently glowing. When PREMONITION_MS elapses we promote it to
  // a real node. Kills use the per-node `markedAt` field instead.
  let pendingSpawns = [];
  // BFS-wave state. A wave is a one-shot animation that fires off a
  // pulse from the root and propagates outward along the BFS tree at
  // STEP_MS per layer; nodes light up the moment the pulse arrives,
  // and pulses keep travelling along the tree edges between layers
  // so you can literally watch the BFS spread.
  let wave = null;            // { rootId, dist:Map, parent:Map, children:Map, maxDist, t0 }

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// force graph · click a node to start a bfs',
    controls: [
      { id: 'shuffle', text: '[ shuffle ]', onClick: () => { regenerate(); startWave(0); } },
    ],
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
    // Clamp existing nodes back into the new bounds.
    for (const n of nodes) {
      n.x = clamp(n.x, 16, W - 16);
      n.y = clamp(n.y, 16, H - 16);
    }
    draw();
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function nodeById(id) { for (const n of nodes) if (n.id === id) return n; return null; }
  const edgeKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;

  function regenerate() {
    nodes = [];
    edges = [];
    nextId = 0;
    const ids = [];
    for (let i = 0; i < N_NODES; i++) {
      const id = nextId++;
      nodes.push({
        id,
        x: W / 2 + (Math.random() - 0.5) * W * 0.6,
        y: H / 2 + (Math.random() - 0.5) * H * 0.6,
        vx: 0, vy: 0,
        fixed: false,
        birth: 0,         // 0 = "already settled" — no fade-in for initial set
        dyingAt: null,
        markedAt: null,   // set when scheduled for kill (premonition phase)
      });
      ids.push(id);
    }
    // Spanning tree (guarantees connectivity).
    const used = new Set();
    for (let i = 1; i < N_NODES; i++) {
      const j = Math.floor(Math.random() * i);
      edges.push([ids[i], ids[j]]);
      used.add(edgeKey(ids[i], ids[j]));
    }
    // Sprinkle a few extra edges so the layout isn't tree-shaped.
    let added = 0;
    while (added < EXTRA_EDGES) {
      const a = ids[Math.floor(Math.random() * N_NODES)];
      const b = ids[Math.floor(Math.random() * N_NODES)];
      if (a === b) continue;
      const k = edgeKey(a, b);
      if (used.has(k)) continue;
      used.add(k);
      edges.push([a, b]);
      added++;
    }
  }

  // ---- random topology mutation ---------------------------------

  // Queue a future spawn. We store an OFFSET from the anchor (not an
  // absolute position) because the anchor keeps moving under the
  // physics for the duration of the premonition; the glow needs to
  // follow it so the spawn appears exactly where the glow was.
  function queueSpawn(now) {
    const anchor = nodes[Math.floor(Math.random() * nodes.length)];
    pendingSpawns.push({
      dx: (Math.random() - 0.5) * 40,
      dy: (Math.random() - 0.5) * 40,
      anchorId: anchor.id,
      t0: now,
    });
  }

  // Resolve a pending spawn's current screen position based on its
  // (live) anchor. Returns null if the anchor disappeared mid-glow.
  function pendingPos(p) {
    const a = nodeById(p.anchorId);
    if (!a) return null;
    return { x: a.x + p.dx, y: a.y + p.dy };
  }

  // Mark a random node for death — it'll glow rust for PREMONITION_MS,
  // then transition into the regular fade-out (dyingAt) and finally
  // be reaped.
  function queueKill(now) {
    const candidates = nodes.filter(n => !n.dyingAt && !n.markedAt);
    if (!candidates.length) return;
    const victim = candidates[Math.floor(Math.random() * candidates.length)];
    victim.markedAt = now;
  }

  // Promote a pending spawn to a real node, wired up with edges.
  // Position is anchor-relative so the new node materialises right
  // where the gold halo was glowing. We also freeze it for a few
  // frames so the user sees it appear *before* the springs yank it
  // around — without that, the node teleports mid-flight.
  function commitSpawn(now, p) {
    const pos = pendingPos(p);
    if (!pos) return;          // anchor was killed mid-premonition
    const id = nextId++;
    const node = {
      id,
      x: pos.x, y: pos.y,
      vx: 0, vy: 0,
      fixed: false,
      freezeUntil: now + 90,    // ≈5 frames @60Hz — visible "appear" beat
      birth: now,
      dyingAt: null,
      markedAt: null,
    };
    nodes.push(node);
    const used = new Set();
    const anchor = nodeById(p.anchorId);
    if (anchor) { edges.push([id, anchor.id]); used.add(anchor.id); }
    const extras = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < extras; k++) {
      const cand = nodes[Math.floor(Math.random() * nodes.length)];
      if (cand.id === id || used.has(cand.id)) continue;
      used.add(cand.id);
      edges.push([id, cand.id]);
    }
  }

  function maybeMutate(now) {
    if (now < nextMutateAt) return;
    nextMutateAt = now + MUTATE_EVERY_MS * (0.7 + Math.random() * 0.6);
    // Choose add vs remove based on bounds + a small bias. Live count
    // excludes both dying *and* already-marked nodes so we don't pile
    // up several pending kills on top of each other.
    const liveN = nodes.filter(n => !n.dyingAt && !n.markedAt).length;
    if (liveN >= N_MAX)      queueKill(now);
    else if (liveN <= N_MIN) queueSpawn(now);
    else                     (Math.random() < 0.5 ? queueSpawn : queueKill)(now);
  }

  // Resolve any premonitions whose time is up. If something actually
  // mutated, fire one BFS wave so the new topology ripples outward.
  function resolvePending(now) {
    let mutated = false;
    for (let i = pendingSpawns.length - 1; i >= 0; i--) {
      const p = pendingSpawns[i];
      if (now - p.t0 >= PREMONITION_MS) {
        pendingSpawns.splice(i, 1);
        commitSpawn(now, p);
        mutated = true;
      }
    }
    for (const n of nodes) {
      if (n.markedAt && now - n.markedAt >= PREMONITION_MS) {
        n.markedAt = null;
        n.dyingAt = now;
        mutated = true;
      }
    }
    if (mutated) startWaveFromRandom();
  }

  // Reap fully-faded nodes and any edges that lost an endpoint.
  // Doesn't relaunch a wave — the wave that fired when the kill was
  // requested has already been running through the dying node's
  // last visible frames.
  function reapDead(now) {
    let changed = false;
    nodes = nodes.filter(n => {
      if (n.dyingAt && now - n.dyingAt >= FADE_MS) { changed = true; return false; }
      return true;
    });
    if (changed) {
      const live = new Set(nodes.map(n => n.id));
      edges = edges.filter(([a, b]) => live.has(a) && live.has(b));
    }
  }

  // 0..1 visual scale for a node — drives a soft pop-in / pop-out.
  function nodeScale(n, now) {
    if (n.dyingAt) return Math.max(0, 1 - (now - n.dyingAt) / FADE_MS);
    if (n.birth === 0) return 1;
    return Math.min(1, (now - n.birth) / FADE_MS);
  }

  // ---- physics ---------------------------------------------------

  function step() {
    const minDim = Math.min(W, H);
    const REST     = minDim * 0.18;     // edge target length
    const SPRING_K = 0.04;
    const REPULSE  = minDim * 6;        // F = REPULSE / d²
    const CENTER   = 0.0008;            // mild pull toward middle
    const DAMP     = 0.82;

    for (const n of nodes) { n.fx = 0; n.fy = 0; }

    // All-pairs repulsion. N=12 → 66 pairs/frame, trivial.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d  = Math.sqrt(d2);
        const f  = REPULSE / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.fx -= fx; a.fy -= fy;
        b.fx += fx; b.fy += fy;
      }
    }

    // Springs along edges. Hooke's law: F = -k (d − rest).
    for (const [aId, bId] of edges) {
      const a = nodeById(aId), b = nodeById(bId);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f  = SPRING_K * (d - REST);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.fx += fx; a.fy += fy;
      b.fx -= fx; b.fy -= fy;
    }

    // Weak attraction to canvas center — keeps the cloud bounded.
    const cx = W / 2, cy = H / 2;
    for (const n of nodes) {
      n.fx += (cx - n.x) * CENTER;
      n.fy += (cy - n.y) * CENTER;
    }

    // Integrate (semi-implicit Euler), damp, bounce off walls. Skip
    // freshly-spawned nodes still inside their `freezeUntil` window
    // so they hold position for a beat after appearing.
    const now = performance.now();
    for (const n of nodes) {
      if (n.fixed) continue;
      if (n.freezeUntil && now < n.freezeUntil) { n.vx = 0; n.vy = 0; continue; }
      n.vx = (n.vx + n.fx) * DAMP;
      n.vy = (n.vy + n.fy) * DAMP;
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 14)        { n.x = 14;        n.vx = -n.vx * 0.4; }
      if (n.x > W - 14)    { n.x = W - 14;    n.vx = -n.vx * 0.4; }
      if (n.y < 14)        { n.y = 14;        n.vy = -n.vy * 0.4; }
      if (n.y > H - 14)    { n.y = H - 14;    n.vy = -n.vy * 0.4; }
    }
  }

  function frame() {
    step();
    const now = performance.now();
    // Three-stage mutation pipeline:
    //   1. maybeMutate     — schedules a future spawn or kill
    //   2. resolvePending  — turns premonitions into real changes
    //                        once their PREMONITION_MS has elapsed,
    //                        and fires a BFS wave on real change
    //   3. reapDead        — removes faded-out nodes from the array
    maybeMutate(now);
    resolvePending(now);
    reapDead(now);
    draw();
    rafId = requestAnimationFrame(frame);
  }

  // Pick a random surviving (non-dying) node id and start a wave
  // from it. Used by mutator + reaper hooks so the wave runs exactly
  // once per topology event.
  function startWaveFromRandom() {
    const live = nodes.filter(n => !n.dyingAt);
    if (!live.length) { wave = null; return; }
    let next;
    do { next = live[Math.floor(Math.random() * live.length)].id; }
    while (live.length > 1 && wave && next === wave.rootId);
    startWave(next);
  }

  // ---- BFS wave --------------------------------------------------

  // Build adjacency keyed by node id — resilient to nodes being
  // added/removed mid-frame.
  function buildAdjacency() {
    const adj = new Map();
    for (const n of nodes) adj.set(n.id, []);
    for (const [a, b] of edges) {
      if (adj.has(a) && adj.has(b)) {
        adj.get(a).push(b);
        adj.get(b).push(a);
      }
    }
    return adj;
  }

  function startWave(rootId) {
    if (rootId == null || !nodeById(rootId)) return;
    const adj = buildAdjacency();
    const dist = new Map([[rootId, 0]]);
    const parent = new Map();
    const children = new Map();
    const queue = [rootId];
    let maxDist = 0;
    while (queue.length) {
      const u = queue.shift();
      const d = dist.get(u);
      for (const v of (adj.get(u) || [])) {
        if (dist.has(v)) continue;
        dist.set(v, d + 1);
        parent.set(v, u);
        if (!children.has(u)) children.set(u, []);
        children.get(u).push(v);
        if (d + 1 > maxDist) maxDist = d + 1;
        queue.push(v);
      }
    }
    wave = { rootId, dist, parent, children, maxDist, t0: performance.now() };
  }

  // When does node `id` light up? The pulse leaves the root at t0,
  // travels for STEP_MS along each tree edge, and arrives after
  // dist[id] hops.
  function revealAt(id) {
    if (!wave) return Infinity;
    return wave.t0 + wave.dist.get(id) * STEP_MS;
  }

  // ---- drawing ---------------------------------------------------

  // Three-stop gradient mirroring the maze's distance gradient so
  // depth in the graph reads as the same visual language as depth
  // through a maze. t in 0..1.
  function distFill(t, alpha = 1) {
    const lerp = (a, b, u) => a + (b - a) * u;
    let r, g, b;
    if (t < 0.5) {
      const u = t * 2;
      r = lerp(170, 47,  u);
      g = lerp(195, 106, u);
      b = lerp(215, 160, u);
    } else {
      const u = (t - 0.5) * 2;
      r = lerp(47,  194, u);
      g = lerp(106, 83,  u);
      b = lerp(160, 43,  u);
    }
    return `rgba(${r|0},${g|0},${b|0},${0.92 * alpha})`;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    const now = performance.now();
    // A node is revealed once the pulse has reached it; we also
    // compute a 0..1 flash intensity that decays over FLASH_MS so
    // newly-lit nodes briefly pop.
    const isRevealed = (id) => wave && now >= revealAt(id);
    const flashAt = (id) => {
      if (!wave) return 0;
      const since = now - revealAt(id);
      if (since < 0 || since > FLASH_MS) return 0;
      return 1 - since / FLASH_MS;
    };

    // When a node is focused (hovered or dragged) we want its local
    // neighborhood to pop. Build a quick "is this neighbor of focus?"
    // set once per frame so the loops below stay flat.
    const focus = dragging || hover;
    const neighbors = new Set();
    if (focus) {
      const f = focus.id;
      for (const [a, b] of edges) {
        if      (a === f) neighbors.add(b);
        else if (b === f) neighbors.add(a);
      }
    }

    ctx.lineWidth = 1;
    for (const [aId, bId] of edges) {
      const a = nodeById(aId), b = nodeById(bId);
      if (!a || !b) continue;
      const incident = focus && (a === focus || b === focus);
      // Edge is part of the BFS tree if one endpoint is the parent of
      // the other in `wave.parent`.
      const treeEdge = wave &&
        ((wave.parent.get(aId) === bId && isRevealed(aId)) ||
         (wave.parent.get(bId) === aId && isRevealed(bId)));
      // Edge alpha fades with the weakest endpoint scale so newborn
      // and dying edges ease in/out.
      const edgeAlpha = Math.min(nodeScale(a, now), nodeScale(b, now));
      let stroke, lw;
      if (incident)        { stroke = `rgba(47, 106, 160, ${0.85 * edgeAlpha})`; lw = 1.6; }
      else if (treeEdge)   { stroke = `rgba(47, 106, 160, ${0.65 * edgeAlpha})`; lw = 1.4; }
      else if (focus)      { stroke = `rgba(28, 31, 36, ${0.10 * edgeAlpha})`;  lw = 1; }
      else                 { stroke = `rgba(28, 31, 36, ${0.20 * edgeAlpha})`;  lw = 1; }
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = lw;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Travelling pulses: each tree edge carries one steel-blue dot
    // from parent to child during the [parent.revealAt,
    // child.revealAt] window. Steel blue (not rust) because rust is
    // reserved for the kill warning — keeping the BFS in the cool
    // half of the palette stops it from competing with the
    // premonition glow.
    if (wave) {
      for (const [parentId, kids] of wave.children) {
        const ta = revealAt(parentId);
        if (now < ta) continue;
        const tb = ta + STEP_MS;
        if (now > tb) continue;
        const p = (now - ta) / STEP_MS;
        const a = nodeById(parentId);
        if (!a) continue;
        for (const childId of kids) {
          const b = nodeById(childId);
          if (!b) continue;
          const x = a.x + (b.x - a.x) * p;
          const y = a.y + (b.y - a.y) * p;
          ctx.fillStyle = 'rgba(47, 106, 160, 0.95)';
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          // Faint trailing ring so the pulse leaves a wake.
          ctx.strokeStyle = `rgba(47, 106, 160, ${0.35 * (1 - p)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Premonition glows. Two distinct treatments:
    //   - Spawn warning  → gold halo on the *anchor* (the existing
    //     neighbour the new node will attach to).
    //   - Kill warning   → rust halo around the condemned node.
    // Both use the same 3-layer recipe (inner filled glow + leader
    // expanding ring + echo ring) so they read as deliberate beacons
    // rather than faint pulses.
    const PI2 = Math.PI * 2;
    function drawBeacon(x, y, t, r, g, b) {
      // Intensity ramps in fast, holds, peaks near commit.
      const intensity = Math.pow(t, 0.45);
      const breathe   = 0.65 + 0.35 * Math.sin(t * Math.PI * 4);
      // Inner filled glow on/around the node.
      ctx.fillStyle   = `rgba(${r},${g},${b},${0.45 * intensity * breathe})`;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, PI2);
      ctx.fill();
      // Leader ring — biggest, expands fastest.
      ctx.strokeStyle = `rgba(${r},${g},${b},${0.95 * intensity})`;
      ctx.lineWidth   = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 14 + 22 * t, 0, PI2);
      ctx.stroke();
      // Echo ring — lags 0.35s behind, fainter, gives the beacon a
      // double-pulse rhythm so the eye keeps catching new motion.
      const tEcho = t - 0.35;
      if (tEcho > 0) {
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.55 * intensity})`;
        ctx.lineWidth   = 1.6;
        ctx.beginPath();
        ctx.arc(x, y, 14 + 22 * tEcho, 0, PI2);
        ctx.stroke();
      }
    }

    for (const p of pendingSpawns) {
      const anchor = nodeById(p.anchorId);
      if (!anchor) continue;
      const t = Math.min(1, (now - p.t0) / PREMONITION_MS);
      drawBeacon(anchor.x, anchor.y, t, 200, 155, 60);   // gold
    }
    for (const n of nodes) {
      if (!n.markedAt) continue;
      const t = Math.min(1, (now - n.markedAt) / PREMONITION_MS);
      drawBeacon(n.x, n.y, t, 194, 83, 43);              // rust
    }

    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const isFocus    = n === focus;
      const isNeighbor = focus && neighbors.has(n.id);
      const isRoot     = wave && n.id === wave.rootId;
      const revealed   = isRevealed(n.id);
      const flash      = flashAt(n.id);
      const scale      = nodeScale(n, now);
      if (scale <= 0) continue;
      const baseR      = (isRoot && revealed ? 12 : 11) * scale;

      // Expanding ring on freshly-lit nodes — fades out over FLASH_MS
      // so the pulse arrival reads as an impact. Steel-blue too, so
      // it can't be confused with the rust kill warning.
      if (flash > 0) {
        ctx.strokeStyle = `rgba(47, 106, 160, ${0.85 * flash * scale})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(n.x, n.y, baseR + (1 - flash) * 10, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Fill priority: focus > revealed-by-wave > paper. Scale also
      // dims alpha so dying nodes don't suddenly punch a colour hole.
      let fill;
      if (isFocus || isNeighbor)        fill = `rgba(47, 106, 160, ${0.92 * scale})`;
      else if (revealed && wave) {
        const d = wave.dist.get(n.id);
        const m = Math.max(1, wave.maxDist);
        fill = distFill(d / m, scale);
      }
      else if (focus)                   fill = `rgba(243, 239, 230, ${0.85 * scale})`;
      else                              fill = `rgba(243, 239, 230, ${scale})`;
      ctx.fillStyle = fill;

      // Stroke: rust on drag, accent ring on the BFS root, otherwise
      // a soft outline.
      if (n === dragging)               ctx.strokeStyle = `rgba(194, 83, 43, ${0.95 * scale})`;
      else if (isRoot && revealed)      ctx.strokeStyle = `rgba(194, 83, 43, ${0.85 * scale})`;
      else                              ctx.strokeStyle = `rgba(47, 106, 160, ${0.65 * scale})`;
      ctx.lineWidth   = (n === dragging) ? 2 : (isRoot && revealed ? 2 : 1);

      ctx.beginPath();
      ctx.arc(n.x, n.y, baseR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Label colour: white on saturated fills, dark otherwise.
      const labelLight = (isFocus || isNeighbor) ||
        (revealed && wave && (wave.dist.get(n.id) / Math.max(1, wave.maxDist)) > 0.55);
      ctx.fillStyle = labelLight
        ? `rgba(255, 255, 255, ${scale})`
        : `rgba(28, 31, 36, ${0.85 * scale})`;
      ctx.fillText(String(n.id), n.x, n.y);
    }

    // Stats — top-left, italic serif.
    if (wave) {
      ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
      ctx.font = "italic 13px 'Instrument Serif', serif";
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`bfs from N${wave.rootId} · radius ${wave.maxDist}`, 10, 8);
    }
  }

  // ---- interaction ----------------------------------------------

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches && e.touches[0];
    return {
      x: (t ? t.clientX : e.clientX) - r.left,
      y: (t ? t.clientY : e.clientY) - r.top,
    };
  }

  function nodeAt(x, y) {
    // Slightly larger hit radius than visual radius — easier to grab.
    const R2 = 16 * 16;
    for (const n of nodes) {
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy < R2) return n;
    }
    return null;
  }

  function startDrag(e) {
    const p = pointerPos(e);
    const n = nodeAt(p.x, p.y);
    if (!n) return;
    e.preventDefault();
    dragging = n;
    n.fixed  = true;
    n.x = p.x; n.y = p.y;
    n.vx = 0;  n.vy = 0;
    // Clicking a node also (re)launches a BFS wave from it. Drags
    // count too — the wave starts immediately and runs alongside the
    // physics interaction.
    startWave(n.id);
  }
  function moveDrag(e) {
    if (dragging) {
      e.preventDefault();
      const p = pointerPos(e);
      dragging.x = p.x; dragging.y = p.y;
      dragging.vx = 0;  dragging.vy = 0;
    } else {
      const p = pointerPos(e);
      hover = nodeAt(p.x, p.y);
      canvas.style.cursor = hover ? 'grab' : 'crosshair';
    }
  }
  function endDrag() {
    if (!dragging) return;
    dragging.fixed = false;
    dragging = null;
  }

  canvas.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup',   endDrag);
  canvas.addEventListener('touchstart', startDrag, { passive: false });
  canvas.addEventListener('touchmove',  moveDrag,  { passive: false });
  canvas.addEventListener('touchend',   endDrag);
  canvas.addEventListener('touchcancel', endDrag);

  function start() {
    if (rafId) return;
    // Delay the first mutation so the initial graph gets a moment to
    // settle before things start mutating around the user.
    nextMutateAt = performance.now() + MUTATE_EVERY_MS * 2;
    rafId = requestAnimationFrame(frame);
  }
  function stop()  { if (rafId)  { cancelAnimationFrame(rafId); rafId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  regenerate();
  relayout();
  startWave(0);
  if (!reducedMotion()) start();
}
