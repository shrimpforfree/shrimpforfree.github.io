// widgets/quadtree.js
//
// A swarm of points drifting around a square. On each frame the
// quadtree is rebuilt from scratch and its boundaries drawn beneath
// the points. Where points cluster, the tree subdivides; where the
// region clears out, deeper boxes disappear.
//
// (This is the data structure I refactored geofence checks onto at
// Hopscotch — same shape, same job: spatially partition 2D points so
// "find everything near this query" is O(log n) instead of O(n).)
//
// Quadtree rules used here:
//   - capacity per leaf:    CAPACITY points
//   - max recursion depth:  MAX_DEPTH
//   - leaf splits into 4 equal-area quadrants (NW, NE, SW, SE)
//   - rebuilt every frame from the current point set (cheaper than
//     incremental updates for small N, and avoids stale state)

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W = 320;
const MAX_W = 480;
const N_POINTS = 60;
const CAPACITY = 4;
const MAX_DEPTH = 6;

export function quadtree({ side = 'left', top = 1340 } = {}) {
  let W = MIN_W, H = MIN_W;
  let points = [];
  let rafId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// quadtree · spatial partition',
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
  }

  function init() {
    points = [];
    for (let i = 0; i < N_POINTS; i++) {
      points.push({
        x:  Math.random() * W,
        y:  Math.random() * H,
        vx: (Math.random() - 0.5) * 0.7,
        vy: (Math.random() - 0.5) * 0.7,
      });
    }
  }

  // Build a quadtree from a flat list of points + a bounds rect.
  // Returns the root node.
  function build(bounds, pts, depth = 0) {
    const node = { bounds, points: pts, children: null };
    if (pts.length > CAPACITY && depth < MAX_DEPTH) {
      const { x, y, w, h } = bounds;
      const hw = w / 2, hh = h / 2;
      const quads = [
        { x,        y,        w: hw, h: hh },   // NW
        { x: x+hw,  y,        w: hw, h: hh },   // NE
        { x,        y: y+hh,  w: hw, h: hh },   // SW
        { x: x+hw,  y: y+hh,  w: hw, h: hh },   // SE
      ];
      node.children = quads.map(b => {
        const inside = pts.filter(p =>
          p.x >= b.x && p.x < b.x + b.w &&
          p.y >= b.y && p.y < b.y + b.h);
        return build(b, inside, depth + 1);
      });
      node.points = [];   // interior nodes hold no points directly
    }
    return node;
  }

  function frame() {
    // Step the simulation: bounce points off the walls.
    for (const p of points) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0)      { p.x = 0;     p.vx = -p.vx; }
      else if (p.x > W) { p.x = W - 1; p.vx = -p.vx; }
      if (p.y < 0)      { p.y = 0;     p.vy = -p.vy; }
      else if (p.y > H) { p.y = H - 1; p.vy = -p.vy; }
    }
    const root = build({ x: 0, y: 0, w: W, h: H }, points);

    // Draw.
    ctx.clearRect(0, 0, W, H);
    (function drawNode(n, d) {
      // Deeper boxes draw a touch darker — gives the tree a sense of depth.
      ctx.strokeStyle = `rgba(28, 31, 36, ${0.10 + d * 0.05})`;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(n.bounds.x, n.bounds.y, n.bounds.w, n.bounds.h);
      if (n.children) for (const c of n.children) drawNode(c, d + 1);
    })(root, 0);

    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    rafId = requestAnimationFrame(frame);
  }

  function start() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function stop()  { if (rafId)  { cancelAnimationFrame(rafId); rafId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(() => { relayout(); init(); });

  relayout();
  init();
  if (!reducedMotion()) start();
}
