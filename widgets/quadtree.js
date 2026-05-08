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
// To actually *show* that O(log n) win, the widget runs a continuous
// range query — a circle that either tracks your cursor (when you
// hover) or auto-orbits the canvas. The query traversal prunes
// subtrees whose bounds can't overlap the circle, so we only visit
// a handful of cells. Visited leaves are tinted, returned points
// glow accent. The counter at the top reads:
//
//     checked 6 cells · 9/60 points
//
// Compare to the naive sweep of all 60 points to see the speedup.
//
// Quadtree rules used here:
//   - capacity per leaf:    CAPACITY points
//   - max recursion depth:  MAX_DEPTH
//   - leaf splits into 4 equal-area quadrants (NW, NE, SW, SE)
//   - rebuilt every frame from the current point set (cheaper than
//     incremental updates for small N, and avoids stale state)

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W     = 320;
const MAX_W     = 480;
const N_POINTS  = 60;
const CAPACITY  = 4;
const MAX_DEPTH = 6;

export function quadtree({ side = 'left', top = 1340 } = {}) {
  let W = MIN_W, H = MIN_W;
  let points = [];
  let rafId = null;
  // Query state: x/y track mouse when hovering, otherwise orbit. r is
  // a fraction of canvas width × queryScale so it scales with the
  // gutter AND the user's [ + ]/[ - ] adjustments.
  const query = { x: MIN_W / 2, y: MIN_W / 2, r: 0, cursor: false };
  let queryScale = 1.0;
  const SCALE_MIN = 0.4, SCALE_MAX = 2.5, SCALE_STEP = 0.25;
  let orbitT = 0;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// quadtree · range query',
    controls: [
      { id: 'minus', text: '[ - ]', onClick: () => bumpScale(-SCALE_STEP) },
      { id: 'plus',  text: '[ + ]', onClick: () => bumpScale(+SCALE_STEP) },
    ],
  });

  function bumpScale(delta) {
    queryScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, queryScale + delta));
    query.r = W * 0.13 * queryScale;
  }

  function relayout() {
    W = H = responsiveWidth({ min: MIN_W, max: MAX_W });
    if (!place(wrap, { side, top, width: W })) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    query.r = W * 0.13 * queryScale;
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

  // ---- range query ------------------------------------------------
  // Recursively walks the tree, pruning subtrees whose bounds can't
  // intersect the query circle. Returns:
  //   { cells, found, leaves } — counts + the leaf nodes visited.

  function rectCircleOverlap(b, qx, qy, qr) {
    // Closest point on the rect to the circle center.
    const cx = qx < b.x ? b.x : qx > b.x + b.w ? b.x + b.w : qx;
    const cy = qy < b.y ? b.y : qy > b.y + b.h ? b.y + b.h : qy;
    const dx = qx - cx, dy = qy - cy;
    return dx * dx + dy * dy <= qr * qr;
  }

  function runQuery(root, q) {
    const out = { cells: 0, found: [], leaves: [] };
    (function walk(node) {
      out.cells++;
      if (!rectCircleOverlap(node.bounds, q.x, q.y, q.r)) return;
      if (node.children) {
        for (const c of node.children) walk(c);
      } else {
        out.leaves.push(node);
        const r2 = q.r * q.r;
        for (const p of node.points) {
          const dx = p.x - q.x, dy = p.y - q.y;
          if (dx * dx + dy * dy <= r2) out.found.push(p);
        }
      }
    })(root);
    return out;
  }

  // ---- frame ------------------------------------------------------

  function frame() {
    // Step the simulation: bounce points off the walls.
    for (const p of points) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0)      { p.x = 0;     p.vx = -p.vx; }
      else if (p.x > W) { p.x = W - 1; p.vx = -p.vx; }
      if (p.y < 0)      { p.y = 0;     p.vy = -p.vy; }
      else if (p.y > H) { p.y = H - 1; p.vy = -p.vy; }
    }

    // Auto-orbit when the cursor isn't over the canvas. Lissajous
    // because a plain circle felt mechanical — a 1:1.3 ratio drifts
    // so the path doesn't repeat for a while.
    if (!query.cursor) {
      orbitT += 0.012;
      query.x = W / 2 + W * 0.30 * Math.cos(orbitT);
      query.y = H / 2 + H * 0.30 * Math.sin(orbitT * 1.3);
    }

    const root = build({ x: 0, y: 0, w: W, h: H }, points);
    const result = runQuery(root, query);

    // ---- draw ------------------------------------------------------
    ctx.clearRect(0, 0, W, H);

    // Tint visited leaves so you can see exactly which cells the
    // query touched. Drawn before the wireframe so the wireframe still
    // reads on top.
    ctx.fillStyle = 'rgba(47, 106, 160, 0.10)';
    for (const leaf of result.leaves) {
      const b = leaf.bounds;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }

    // Quadtree wireframe.
    (function drawNode(n, d) {
      ctx.strokeStyle = `rgba(28, 31, 36, ${0.10 + d * 0.05})`;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(n.bounds.x, n.bounds.y, n.bounds.w, n.bounds.h);
      if (n.children) for (const c of n.children) drawNode(c, d + 1);
    })(root, 0);

    // Points: returned ones in accent + slightly larger; the rest
    // stay muted so the eye locks onto the query result.
    const foundSet = new Set(result.found);
    for (const p of points) {
      const hit = foundSet.has(p);
      ctx.fillStyle = hit ? 'rgba(47, 106, 160, 0.95)' : 'rgba(28, 31, 36, 0.45)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, hit ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Query circle on top.
    ctx.strokeStyle = 'rgba(47, 106, 160, 0.65)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(query.x, query.y, query.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Stats — top-left, italic serif to match the rest of the page.
    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    ctx.font = "italic 13px 'Instrument Serif', serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `checked ${result.cells} cells · ${result.found.length}/${N_POINTS} points`,
      10, 8,
    );

    rafId = requestAnimationFrame(frame);
  }

  // ---- interaction ------------------------------------------------

  function handleMove(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches && e.touches[0];
    query.x = (t ? t.clientX : e.clientX) - r.left;
    query.y = (t ? t.clientY : e.clientY) - r.top;
    query.cursor = true;
  }
  function handleLeave() { query.cursor = false; }

  canvas.addEventListener('mousemove',  handleMove);
  canvas.addEventListener('mouseleave', handleLeave);
  canvas.addEventListener('touchstart', handleMove, { passive: true });
  canvas.addEventListener('touchmove',  handleMove, { passive: true });
  canvas.addEventListener('touchend',   handleLeave);

  function start() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function stop()  { if (rafId)  { cancelAnimationFrame(rafId); rafId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(() => { relayout(); init(); });

  relayout();
  init();
  if (!reducedMotion()) start();
}
