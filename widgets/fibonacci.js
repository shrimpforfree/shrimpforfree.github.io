// widgets/fibonacci.js
//
// A Fibonacci heap, animated. Operations are picked at random in a
// continuous mix:
//
//   ~50% insert · ~30% extract-min · ~20% decrease-key
//
// (with insert forced when the heap is empty and skipped when full)
// so the structure stays in a realistic steady state instead of
// cycling through phases.
//
// The two visually interesting moments — consolidate and cascading
// cut — get explicit air time:
//
//   - extract-min returns the min and dumps its children into the
//     root list. Then *consolidate* runs ONE MERGE PER FRAME: each
//     tick picks a pair of equal-degree roots, lights them up, and
//     makes the smaller-key one the parent. Watch the binomial-like
//     trees emerge from the flat root list.
//
//   - decrease-key cuts the node free if heap order is violated.
//     If its parent had already lost a child (its 'mark' was set),
//     the parent is cut too — *cascading cut*. The whole chain of
//     freshly-cut nodes flashes rust for one frame so the chain
//     reaction is visible. That bookkeeping is why decrease-key is
//     O(1) amortized.
//
// Famous because: Fibonacci heaps cut the asymptotic cost of
// Dijkstra and Prim from O(E log V) to O(E + V log V). In practice
// the constants are nasty and binary heaps usually win, but the
// theory is gorgeous.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W   = 360;
const MAX_W   = 520;
const ASPECT  = 0.78;
const MAX_NODES = 24;     // bigger heap ⇒ deeper trees, more cascades
const TICK_MS = 320;      // pace of the cycle — fast enough to feel alive

export function fibonacci({ side = 'right', top = 740 } = {}) {
  let W = MIN_W, H = Math.round(MIN_W * ASPECT);
  let heap = newHeap();
  let lastOp = 'fibonacci heap';
  let highlight = null;       // single node accent (insert / decrease-key target)
  let mergePair = null;       // [x, y] currently merging during consolidate
  let cutFlash = [];          // nodes freshly cut this tick — rust ring
  let consolidator = null;    // active consolidate generator, if any
  let tickId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// fibonacci heap · mixed ops',
  });

  function relayout() {
    W = responsiveWidth({ min: MIN_W, max: MAX_W });
    H = Math.round(W * ASPECT);
    if (!place(wrap, { side, top, width: W })) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout();
    draw();
  }

  // ---- heap state + operations ------------------------------------

  function newHeap() { return { roots: [], min: null, n: 0 }; }
  function makeNode(key) {
    return { key, children: [], parent: null, mark: false, x: 0, y: 0 };
  }

  function fhInsert(key) {
    const node = makeNode(key);
    heap.roots.push(node);
    if (!heap.min || key < heap.min.key) heap.min = node;
    heap.n++;
    return node;
  }

  // Begin extract-min: yank the min, expose its children to the root
  // list, return the consolidate-step generator. The animation loop
  // advances that generator one step per frame so the merging is
  // actually visible.
  function fhBeginExtractMin() {
    if (!heap.min) return null;
    const z = heap.min;
    for (const child of z.children) {
      child.parent = null;
      child.mark = false;
      heap.roots.push(child);
    }
    heap.roots = heap.roots.filter(r => r !== z);
    heap.n--;
    if (heap.roots.length === 0) {
      heap.min = null;
      return { key: z.key, gen: null };
    }
    return { key: z.key, gen: consolidateSteps() };
  }

  // Generator: each yield happens *before* a single merge is applied.
  // The widget paints the pair lit up, then resumes the generator on
  // the next tick to actually perform the merge. After the loop, we
  // recompute min and yield once more so the final settled frame is
  // also visible.
  function* consolidateSteps() {
    const A = [];
    for (const root of [...heap.roots]) {
      let x = root;
      let d = x.children.length;
      while (A[d]) {
        let y = A[d];
        if (y.key < x.key) [x, y] = [y, x];
        yield { x, y };                    // pause: both nodes lit
        // Apply: make y a child of x.
        heap.roots = heap.roots.filter(r => r !== y);
        x.children.push(y);
        y.parent = x;
        y.mark = false;
        A[d] = null;
        d++;
      }
      A[d] = x;
    }
    // Recompute min.
    heap.min = null;
    for (const r of heap.roots) {
      if (!heap.min || r.key < heap.min.key) heap.min = r;
    }
  }

  // decrease-key with a CHAIN return — cut/cascadingCut iterative so
  // we can collect every freshly-cut node and flash them all on the
  // same frame.
  function fhDecreaseKey(node, newKey) {
    const cuts = [];
    if (newKey >= node.key) return cuts;
    node.key = newKey;
    let parent = node.parent;
    if (parent && node.key < parent.key) {
      cut(node, parent); cuts.push(node);
      // Cascading cut, iterative.
      let y = parent;
      while (y) {
        const z = y.parent;
        if (!z) break;
        if (!y.mark) { y.mark = true; break; }
        cut(y, z); cuts.push(y);
        y = z;
      }
    }
    if (heap.min && node.key < heap.min.key) heap.min = node;
    return cuts;
  }

  function cut(x, y) {
    y.children = y.children.filter(c => c !== x);
    heap.roots.push(x);
    x.parent = null;
    x.mark = false;
  }

  function allNodes() {
    const out = [];
    function walk(n) { out.push(n); for (const c of n.children) walk(c); }
    for (const r of heap.roots) walk(r);
    return out;
  }

  function maxDegree() {
    let m = 0;
    for (const r of heap.roots) if (r.children.length > m) m = r.children.length;
    return m;
  }

  // ---- the cycle --------------------------------------------------

  function randomKey() { return Math.floor(Math.random() * 99) + 1; }

  // Pick the next operation with weighted probability — but prefer
  // insert when nearly empty and prefer extract/decrease when nearly
  // full, so the heap doesn't bounce off either extreme.
  function pickOp() {
    if (heap.n === 0)            return 'insert';
    if (heap.n >= MAX_NODES)     return Math.random() < 0.6 ? 'extract' : 'decrease';
    const r = Math.random();
    if (heap.n < 4)              return r < 0.7 ? 'insert' : 'extract';
    if (r < 0.50) return 'insert';
    if (r < 0.80) return 'extract';
    return 'decrease';
  }

  function tick() {
    // Per-tick reset of one-frame highlights.
    highlight = null;
    mergePair = null;
    cutFlash = [];

    // If a consolidate is in progress, advance it one step instead of
    // launching a new op. That way each merge gets its own frame.
    if (consolidator) {
      const { value, done } = consolidator.next();
      if (done) {
        consolidator = null;
      } else {
        mergePair = [value.x, value.y];
        lastOp = `consolidate · merge`;
      }
      layout();
      draw();
      return;
    }

    const op = pickOp();
    if (op === 'insert') {
      const v = randomKey();
      highlight = fhInsert(v);
      lastOp = `insert(${v})`;
    }
    else if (op === 'extract') {
      const r = fhBeginExtractMin();
      lastOp = `extract-min · ${r && r.key != null ? r.key : '∅'}`;
      if (r && r.gen) consolidator = r.gen;
    }
    else if (op === 'decrease') {
      // Pick a non-root node so the operation actually has bite. If
      // all nodes are roots, fall back to inserting.
      const cands = allNodes().filter(n => n.parent !== null);
      if (cands.length === 0) {
        const v = randomKey();
        highlight = fhInsert(v);
        lastOp = `insert(${v})`;
      } else {
        const t = cands[Math.floor(Math.random() * cands.length)];
        // Drop new key just below current min so the cut definitely
        // fires — that's the visually interesting case.
        const newK = Math.max(1, (heap.min ? heap.min.key : t.key) - 1);
        cutFlash = fhDecreaseKey(t, newK);
        highlight = t;
        lastOp = cutFlash.length > 1
          ? `decrease-key → ${newK} · cascade ×${cutFlash.length}`
          : `decrease-key → ${newK}`;
      }
    }

    layout();
    draw();
  }

  // ---- layout: lay trees side-by-side, recursively place children -

  function subtreeWidth(n) {
    if (n.children.length === 0) return 1;
    return n.children.reduce((s, c) => s + subtreeWidth(c), 0);
  }

  function layout() {
    if (heap.roots.length === 0) return;
    const widths = heap.roots.map(subtreeWidth);
    const total  = widths.reduce((a, b) => a + b, 0);
    const padX = 24, padY = 36, stepY = 38;
    const unit = (W - 2 * padX) / Math.max(1, total);
    let cursor = padX;
    for (let i = 0; i < heap.roots.length; i++) {
      placeTree(heap.roots[i], cursor, padY, unit, stepY);
      cursor += widths[i] * unit;
    }
  }

  function placeTree(node, x, y, unit, stepY) {
    const w = subtreeWidth(node);
    node.x = x + (w * unit) / 2;
    node.y = y;
    let cx = x;
    for (const c of node.children) {
      placeTree(c, cx, y + stepY, unit, stepY);
      cx += subtreeWidth(c) * unit;
    }
  }

  // ---- drawing ----------------------------------------------------

  // Three-stop gradient: light cool → steel blue → rust. Mirrors the
  // distance gradient in the maze widget so the page reads as one
  // coherent visual language.
  function keyFill(t) {
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
    return `rgba(${r|0},${g|0},${b|0},0.92)`;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Edges (under nodes). Edges between the merging pair light up
    // accent so the pending merge reads.
    ctx.lineWidth = 1;
    function edges(n) {
      for (const c of n.children) {
        ctx.strokeStyle = 'rgba(28, 31, 36, 0.30)';
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        edges(c);
      }
    }
    for (const r of heap.roots) edges(r);

    // Pending-merge bridge: dashed accent line connecting the two
    // roots about to be merged.
    if (mergePair) {
      const [x, y] = mergePair;
      ctx.strokeStyle = 'rgba(47, 106, 160, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x.x, x.y);
      ctx.lineTo(y.x, y.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const cutSet = new Set(cutFlash);
    const mergeSet = mergePair ? new Set(mergePair) : null;

    // Nodes — coloured by key on a cool → warm gradient. Cheap small
    // keys read as cold blue; expensive large keys glow rust. The
    // heap's min lights up bright accent without a special case.
    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    function nodes(n) {
      const isMin       = n === heap.min;
      const isHighlight = n === highlight;
      const isMerging   = mergeSet && mergeSet.has(n);
      const isCut       = cutSet.has(n);
      const t = (n.key - 1) / 98;        // keys are 1..99
      ctx.fillStyle   = isMin ? 'rgba(47, 106, 160, 0.95)' : keyFill(t);
      let stroke = 'rgba(28, 31, 36, 0.55)';
      let lw = 1;
      if (isMin) { stroke = 'rgba(47, 106, 160, 0.95)'; }
      if (isMerging || isCut || isHighlight) {
        stroke = 'rgba(194, 83, 43, 0.95)'; lw = 2.2;
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = lw;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Mark dot — visible signal that this node has lost a child.
      if (n.mark) {
        ctx.fillStyle = 'rgba(194, 83, 43, 0.7)';
        ctx.beginPath();
        ctx.arc(n.x + 9, n.y - 9, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Pick a label colour with enough contrast against whichever
      // gradient stop we landed on.
      ctx.fillStyle = isMin || t > 0.55 ? 'white' : 'rgba(28, 31, 36, 0.85)';
      ctx.fillText(String(n.key), n.x, n.y);
      for (const c of n.children) nodes(c);
    }
    for (const r of heap.roots) nodes(r);

    // Last operation, top-left corner.
    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    ctx.font = "italic 13px 'Instrument Serif', serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(lastOp, 10, 8);

    // Live stats, top-right — shape of the heap at a glance.
    ctx.fillStyle = 'rgba(28, 31, 36, 0.55)';
    ctx.font = "italic 11.5px 'Instrument Serif', serif";
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `n=${heap.n} · roots=${heap.roots.length} · max°=${maxDegree()}`,
      W - 10, 10,
    );
  }

  function start() { if (!tickId) tickId = setInterval(tick, TICK_MS); }
  function stop()  { if (tickId)  { clearInterval(tickId); tickId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  // Pre-seed so the first frame isn't empty.
  for (let i = 0; i < 4; i++) fhInsert(randomKey());
  relayout();
  if (!reducedMotion()) start();
}
