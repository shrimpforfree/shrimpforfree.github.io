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

const MIN_W   = 360;
const MAX_W   = 520;
const N_NODES = 12;
const EXTRA_EDGES = 5;     // beyond the spanning tree

export function forceGraph({ side = 'right', top = 1820 } = {}) {
  let W = MIN_W, H = MIN_W;
  let nodes = [];
  let edges = [];
  let dragging = null;
  let hover = null;
  let rafId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// force graph · drag any node',
    controls: [
      { id: 'shuffle', text: '[ shuffle ]', onClick: regenerate },
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

  function regenerate() {
    nodes = [];
    for (let i = 0; i < N_NODES; i++) {
      nodes.push({
        id: i,
        x: W / 2 + (Math.random() - 0.5) * W * 0.6,
        y: H / 2 + (Math.random() - 0.5) * H * 0.6,
        vx: 0, vy: 0,
        fixed: false,
      });
    }
    // Spanning tree (guarantees connectivity).
    edges = [];
    const edgeKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
    const used = new Set();
    for (let i = 1; i < N_NODES; i++) {
      const j = Math.floor(Math.random() * i);
      edges.push([i, j]);
      used.add(edgeKey(i, j));
    }
    // Sprinkle a few extra edges so the layout isn't tree-shaped.
    let added = 0;
    while (added < EXTRA_EDGES) {
      const a = Math.floor(Math.random() * N_NODES);
      const b = Math.floor(Math.random() * N_NODES);
      if (a === b) continue;
      const k = edgeKey(a, b);
      if (used.has(k)) continue;
      used.add(k);
      edges.push([a, b]);
      added++;
    }
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
    for (const [i, j] of edges) {
      const a = nodes[i], b = nodes[j];
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

    // Integrate (semi-implicit Euler), damp, bounce off walls.
    for (const n of nodes) {
      if (n.fixed) continue;
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
    draw();
    rafId = requestAnimationFrame(frame);
  }

  // ---- drawing ---------------------------------------------------

  function draw() {
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(28, 31, 36, 0.30)';
    ctx.lineWidth = 1;
    for (const [i, j] of edges) {
      ctx.beginPath();
      ctx.moveTo(nodes[i].x, nodes[i].y);
      ctx.lineTo(nodes[j].x, nodes[j].y);
      ctx.stroke();
    }

    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const isDrag  = n === dragging;
      const isHover = n === hover;
      const active  = isDrag || isHover;
      ctx.fillStyle   = active ? 'rgba(47, 106, 160, 0.92)' : 'rgba(243, 239, 230, 1)';
      ctx.strokeStyle = isDrag ? 'rgba(194, 83, 43, 0.95)'  : 'rgba(47, 106, 160, 0.85)';
      ctx.lineWidth   = isDrag ? 2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = active ? 'white' : 'rgba(28, 31, 36, 0.85)';
      ctx.fillText(String(n.id), n.x, n.y);
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

  function start() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function stop()  { if (rafId)  { cancelAnimationFrame(rafId); rafId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  regenerate();
  relayout();
  if (!reducedMotion()) start();
}
