// widgets/decision-tree.js
//
// A decision tree classifier visualized over a 2D feature space.
//
// What you're watching:
//   - 60 synthetic points in two overlapping Gaussian clusters
//     (steel blue = class 0, rust = class 1).
//   - The classifier finds the best axis-aligned split (lowest
//     weighted Gini), recurses, and tints each leaf region by its
//     majority class.
//   - The tree's max depth grows over time:  1 → 2 → 3 → 4 → 5 →
//     hold → reset with fresh data. As depth increases you can see
//     the decision boundary refine — and eventually overfit, picking
//     out tiny pockets around individual training points.
//
// Algorithm: vanilla CART, no pruning. At each node, scan midpoints
// between sorted unique values per feature; pick the (feature,
// threshold) with the lowest weighted Gini impurity.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W     = 320;
const MAX_W     = 480;
const N_POINTS  = 140;        // denser cloud — patterns read more clearly
const MAX_DEPTH = 5;
const HOLD_TICKS = 2;
const TICK_MS   = 700;

export function decisionTree({ side = 'right', top = 1280 } = {}) {
  let W = MIN_W, H = MIN_W;
  let points = [];
  let tree = null;
  let depth = 1;
  let holdTicks = 0;
  let tickId = null;
  // Cycle through dataset shapes — each one stresses an axis-aligned
  // tree differently. Gaussians fit cleanly; XOR needs depth ≥ 2;
  // circles & moons reveal the staircase artefacts trees produce
  // when the true boundary is curved/diagonal.
  let datasetIdx = 0;
  const DATASETS = [
    'gaussians', 'xor', 'circles', 'moons',
    'spirals', 'checker', 'diagonal',
  ];

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// decision tree · depth grows on a loop',
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
    points = generateData();   // points are in canvas pixel coords
    tree = build(points, { x1: 0, y1: 0, x2: W, y2: H }, 0, depth);
    draw();
  }

  // ---- data ------------------------------------------------------

  function generateData() {
    const name = DATASETS[datasetIdx];
    const pts =
      name === 'gaussians' ? genGaussians() :
      name === 'xor'       ? genXor()       :
      name === 'circles'   ? genCircles()   :
      name === 'moons'     ? genMoons()     :
      name === 'spirals'   ? genSpirals()   :
      name === 'checker'   ? genCheckerboard() :
                             genDiagonal();
    return pts.filter(p => p.x >= 4 && p.x < W - 4 && p.y >= 4 && p.y < H - 4);
  }

  function genGaussians() {
    const pts = [];
    // Cluster centers closer + larger sigma ⇒ much more overlap, so
    // shallow trees can't classify cleanly and depth actually matters.
    const cx0 = W * 0.38, cy0 = H * 0.42;
    const cx1 = W * 0.62, cy1 = H * 0.60;
    const sigma = W * 0.22;
    for (let i = 0; i < N_POINTS / 2; i++) {
      const [dx, dy] = boxMuller(sigma);
      pts.push({ x: cx0 + dx, y: cy0 + dy, cls: 0 });
    }
    for (let i = 0; i < N_POINTS / 2; i++) {
      const [dx, dy] = boxMuller(sigma);
      pts.push({ x: cx1 + dx, y: cy1 + dy, cls: 1 });
    }
    return pts;
  }

  // XOR — class flips with each quadrant. A single axis-aligned split
  // can't separate them; the tree needs depth ≥ 2 to reach 100%.
  function genXor() {
    const pts = [];
    const cx = W / 2, cy = H / 2;
    const margin = W * 0.08;
    for (let i = 0; i < N_POINTS; i++) {
      const x = margin + Math.random() * (W - 2 * margin);
      const y = margin + Math.random() * (H - 2 * margin);
      const cls = ((x < cx) === (y < cy)) ? 0 : 1;
      // Push points away from the axes so the boundary is unambiguous.
      const px = (x < cx) ? x - W * 0.04 : x + W * 0.04;
      const py = (y < cy) ? y - W * 0.04 : y + W * 0.04;
      pts.push({ x: px, y: py, cls });
    }
    return pts;
  }

  // Concentric — inner blob, outer ring. The boundary is a circle, so
  // axis-aligned splits build a staircase approximation that needs
  // many splits to look round.
  function genCircles() {
    const pts = [];
    const cx = W / 2, cy = H / 2;
    const r1 = W * 0.13;       // inner-cluster radius
    const r2 = W * 0.34;       // outer-ring radius
    const sigma = W * 0.025;
    for (let i = 0; i < N_POINTS / 2; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * r1;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), cls: 0 });
    }
    for (let i = 0; i < N_POINTS / 2; i++) {
      const a = Math.random() * Math.PI * 2;
      const [dx, dy] = boxMuller(sigma);
      pts.push({
        x: cx + r2 * Math.cos(a) + dx,
        y: cy + r2 * Math.sin(a) + dy,
        cls: 1,
      });
    }
    return pts;
  }

  // Two interleaved crescents — the classic non-linear classification
  // toy. Tree carves them apart with diagonal-staircase boundaries.
  function genMoons() {
    const pts = [];
    const cx = W / 2, cy = H * 0.52;
    const R = W * 0.26;
    const sigma = W * 0.025;
    for (let i = 0; i < N_POINTS / 2; i++) {
      const t = Math.random() * Math.PI;
      const [dx, dy] = boxMuller(sigma);
      pts.push({
        x: cx - R * 0.5 + R * Math.cos(t) + dx,
        y: cy - R * Math.sin(t) + dy,
        cls: 0,
      });
    }
    for (let i = 0; i < N_POINTS / 2; i++) {
      const t = Math.random() * Math.PI;
      const [dx, dy] = boxMuller(sigma);
      pts.push({
        x: cx + R * 0.5 + R * Math.cos(t + Math.PI) + dx,
        y: cy + R * Math.sin(t) + dy,
        cls: 1,
      });
    }
    return pts;
  }

  // Two interleaved Archimedean spirals. The class boundary winds
  // around itself, so even at depth 5 you see a long staircase
  // ribbon trying to follow each curve.
  function genSpirals() {
    const pts = [];
    const cx = W / 2, cy = H / 2;
    const Rmax = W * 0.36;
    const turns = 1.6;
    const sigma = W * 0.018;
    const half = Math.floor(N_POINTS / 2);
    for (let i = 0; i < half; i++) {
      const u = i / half;
      const t = u * Math.PI * 2 * turns;
      const r = u * Rmax;
      const [dx, dy] = boxMuller(sigma);
      pts.push({ x: cx + r * Math.cos(t) + dx,
                 y: cy + r * Math.sin(t) + dy, cls: 0 });
    }
    for (let i = 0; i < half; i++) {
      const u = i / half;
      const t = u * Math.PI * 2 * turns + Math.PI;
      const r = u * Rmax;
      const [dx, dy] = boxMuller(sigma);
      pts.push({ x: cx + r * Math.cos(t) + dx,
                 y: cy + r * Math.sin(t) + dy, cls: 1 });
    }
    return pts;
  }

  // 4×4 checkerboard — generalised XOR. Tree needs depth ≥ 4 to
  // separate every cell; lower depths produce stripes that get
  // progressively finer.
  function genCheckerboard() {
    const pts = [];
    const margin = W * 0.06;
    const inner = W - 2 * margin;
    const cellW = inner / 4;
    for (let i = 0; i < N_POINTS; i++) {
      const x = margin + Math.random() * inner;
      const y = margin + Math.random() * inner;
      const ci = Math.floor((x - margin) / cellW);
      const ri = Math.floor((y - margin) / cellW);
      pts.push({ x, y, cls: (ci + ri) & 1 });
    }
    return pts;
  }

  // Diagonal — class is determined by which side of y = x the point
  // sits on. The boundary is a single line, but axis-aligned splits
  // can only approximate it as a staircase — depth 5 produces a
  // jagged five-step approximation.
  function genDiagonal() {
    const pts = [];
    const margin = W * 0.06;
    const span = W - 2 * margin;
    const halfBand = W * 0.04;     // exclusion zone around y=x
    let safety = 0;
    while (pts.length < N_POINTS && safety++ < N_POINTS * 4) {
      const x = margin + Math.random() * span;
      const y = margin + Math.random() * span;
      const signed = (y - margin) - (x - margin);
      if (Math.abs(signed) < halfBand) continue;
      pts.push({ x, y, cls: signed > 0 ? 1 : 0 });
    }
    return pts;
  }

  function boxMuller(s) {
    // Two independent N(0, s) deviates.
    const u1 = Math.max(1e-9, Math.random()), u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    return [s * r * Math.cos(2 * Math.PI * u2),
            s * r * Math.sin(2 * Math.PI * u2)];
  }

  // ---- impurity / split ------------------------------------------

  function gini(pts) {
    if (pts.length === 0) return 0;
    let n0 = 0, n1 = 0;
    for (const p of pts) (p.cls === 0) ? n0++ : n1++;
    const t = pts.length;
    return 1 - (n0 / t) ** 2 - (n1 / t) ** 2;
  }

  function majority(pts) {
    let n0 = 0, n1 = 0;
    for (const p of pts) (p.cls === 0) ? n0++ : n1++;
    return n0 >= n1 ? 0 : 1;
  }

  // Try every (feature, midpoint) and return the one minimizing
  // the weighted Gini impurity of the two resulting halves.
  function bestSplit(pts) {
    let best = null;
    let bestImpurity = Infinity;
    for (const feature of ['x', 'y']) {
      const vals = pts.map(p => p[feature]).sort((a, b) => a - b);
      for (let i = 0; i < vals.length - 1; i++) {
        if (vals[i] === vals[i + 1]) continue;
        const t = (vals[i] + vals[i + 1]) / 2;
        let l0 = 0, l1 = 0, r0 = 0, r1 = 0;
        for (const p of pts) {
          if (p[feature] < t) (p.cls === 0) ? l0++ : l1++;
          else                 (p.cls === 0) ? r0++ : r1++;
        }
        const left = l0 + l1, right = r0 + r1;
        if (left === 0 || right === 0) continue;
        const lg = 1 - (l0 / left)  ** 2 - (l1 / left)  ** 2;
        const rg = 1 - (r0 / right) ** 2 - (r1 / right) ** 2;
        const w  = (left * lg + right * rg) / pts.length;
        if (w < bestImpurity) {
          bestImpurity = w;
          best = { feature, threshold: t };
        }
      }
    }
    return best;
  }

  // ---- tree build ------------------------------------------------

  function build(pts, bounds, d, maxD) {
    if (pts.length === 0) return { leaf: true, cls: 0, bounds };
    if (d >= maxD || gini(pts) < 0.02) {
      return { leaf: true, cls: majority(pts), bounds };
    }
    const split = bestSplit(pts);
    if (!split) return { leaf: true, cls: majority(pts), bounds };
    const lp = pts.filter(p => p[split.feature] <  split.threshold);
    const rp = pts.filter(p => p[split.feature] >= split.threshold);
    const lb = { ...bounds }, rb = { ...bounds };
    if (split.feature === 'x') { lb.x2 = split.threshold; rb.x1 = split.threshold; }
    else                       { lb.y2 = split.threshold; rb.y1 = split.threshold; }
    return {
      leaf: false,
      feature: split.feature,
      threshold: split.threshold,
      bounds,
      left:  build(lp, lb, d + 1, maxD),
      right: build(rp, rb, d + 1, maxD),
    };
  }

  // ---- cycle -----------------------------------------------------

  function tick() {
    if (depth < MAX_DEPTH) {
      depth++;
    } else if (holdTicks < HOLD_TICKS) {
      holdTicks++;
      return;   // skip rebuild + redraw — the picture is the same
    } else {
      depth = 1;
      holdTicks = 0;
      // Advance to the next dataset shape every full depth cycle so
      // the widget showcases the tree's strengths and weaknesses
      // across distinct geometries.
      datasetIdx = (datasetIdx + 1) % DATASETS.length;
      points = generateData();
    }
    tree = build(points, { x1: 0, y1: 0, x2: W, y2: H }, 0, depth);
    draw();
  }

  // ---- drawing ---------------------------------------------------

  const COL0_FILL = 'rgba(47, 106, 160, 0.16)';
  const COL1_FILL = 'rgba(194, 83, 43, 0.16)';
  const COL0_DOT  = 'rgba(47, 106, 160, 0.92)';
  const COL1_DOT  = 'rgba(194, 83, 43, 0.92)';

  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (!tree) return;

    // Tinted leaf regions.
    (function fillLeaves(node) {
      if (!node) return;
      if (node.leaf) {
        ctx.fillStyle = node.cls === 0 ? COL0_FILL : COL1_FILL;
        const b = node.bounds;
        ctx.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      } else {
        fillLeaves(node.left); fillLeaves(node.right);
      }
    })(tree);

    // Split lines on top of regions.
    ctx.strokeStyle = 'rgba(28, 31, 36, 0.45)';
    ctx.lineWidth = 0.6;
    (function drawSplits(node) {
      if (!node || node.leaf) return;
      const b = node.bounds;
      ctx.beginPath();
      if (node.feature === 'x') {
        ctx.moveTo(node.threshold, b.y1);
        ctx.lineTo(node.threshold, b.y2);
      } else {
        ctx.moveTo(b.x1, node.threshold);
        ctx.lineTo(b.x2, node.threshold);
      }
      ctx.stroke();
      drawSplits(node.left); drawSplits(node.right);
    })(tree);

    // Points last so they sit on top.
    for (const p of points) {
      ctx.fillStyle = p.cls === 0 ? COL0_DOT : COL1_DOT;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Depth + training accuracy, top-left. Accuracy climbing toward
    // 100% as depth grows is exactly the "...and now it overfits"
    // story — at max depth the tree memorizes individual points. The
    // dataset name shows which shape the tree is currently fitting.
    let correct = 0;
    for (const p of points) if (predict(tree, p) === p.cls) correct++;
    const acc = points.length ? Math.round((correct / points.length) * 100) : 0;
    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    ctx.font = "italic 14px 'Instrument Serif', serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${DATASETS[datasetIdx]} · depth ${depth} · acc ${acc}%`, 10, 8);
  }

  function predict(node, p) {
    while (node && !node.leaf) {
      node = (p[node.feature] < node.threshold) ? node.left : node.right;
    }
    return node ? node.cls : 0;
  }

  function start() { if (!tickId) tickId = setInterval(tick, TICK_MS); }
  function stop()  { if (tickId)  { clearInterval(tickId); tickId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  relayout();
  if (!reducedMotion()) start();
}
