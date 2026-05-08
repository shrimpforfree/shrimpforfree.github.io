// widgets/fibonacci.js
//
// A Fibonacci heap, animated. The cycle runs forever:
//
//   insert × N   →   extract-min × M   →   decrease-key × K   →   reset
//
// Why this is interesting:
//   - The heap is a FOREST of heap-ordered trees (parent ≤ children).
//     Inserts are O(1) — just drop a singleton into the root list.
//   - extract-min does the real work: remove the min, dump its
//     children into the root list, then CONSOLIDATE — repeatedly
//     merge any two roots of equal degree (smaller key becomes
//     parent) until every degree appears at most once. After this,
//     a heap of size n has at most O(log n) roots.
//   - decrease-key cuts the node free if heap order is violated. If
//     its parent had already lost a child (its 'mark' was set), the
//     parent is cut too — cascading-cut. That bookkeeping is why
//     decrease-key is O(1) amortized.
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
const MAX_NODES = 15;     // more nodes ⇒ deeper trees after consolidate
const TICK_MS = 650;      // pace of the cycle

export function fibonacci({ side = 'right', top = 740 } = {}) {
  let W = MIN_W, H = Math.round(MIN_W * ASPECT);
  let heap = newHeap();
  let phase = 'insert';      // 'insert' | 'extract' | 'decrease' | 'reset'
  let phaseTicks = 0;
  let lastOp = 'fibonacci heap';
  let highlight = null;
  let tickId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// fibonacci heap · auto-cycling',
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

  function fhExtractMin() {
    if (!heap.min) return null;
    const z = heap.min;
    for (const child of z.children) {
      child.parent = null;
      child.mark = false;
      heap.roots.push(child);
    }
    heap.roots = heap.roots.filter(r => r !== z);
    heap.n--;
    if (heap.roots.length === 0) heap.min = null;
    else                          consolidate();
    return z.key;
  }

  // Repeatedly merge any two roots of equal degree until all degrees
  // are distinct. Smaller key wins and the other becomes its child.
  function consolidate() {
    const A = [];   // A[d] = current root of degree d, or undefined
    for (const root of [...heap.roots]) {
      let x = root;
      let d = x.children.length;
      while (A[d]) {
        let y = A[d];
        if (y.key < x.key) [x, y] = [y, x];
        // Make y a child of x.
        heap.roots = heap.roots.filter(r => r !== y);
        x.children.push(y);
        y.parent = x;
        y.mark = false;
        A[d] = null;
        d++;
      }
      A[d] = x;
    }
    // Recompute min from surviving roots.
    heap.min = null;
    for (const r of heap.roots) {
      if (!heap.min || r.key < heap.min.key) heap.min = r;
    }
  }

  function fhDecreaseKey(node, newKey) {
    if (newKey >= node.key) return;
    node.key = newKey;
    const parent = node.parent;
    if (parent && node.key < parent.key) {
      cut(node, parent);
      cascadingCut(parent);
    }
    if (heap.min && node.key < heap.min.key) heap.min = node;
  }

  function cut(x, y) {
    y.children = y.children.filter(c => c !== x);
    heap.roots.push(x);
    x.parent = null;
    x.mark = false;
  }
  function cascadingCut(y) {
    const z = y.parent;
    if (!z) return;
    if (!y.mark) y.mark = true;
    else        { cut(y, z); cascadingCut(z); }
  }

  function allNodes() {
    const out = [];
    function walk(n) { out.push(n); for (const c of n.children) walk(c); }
    for (const r of heap.roots) walk(r);
    return out;
  }

  // ---- the cycle --------------------------------------------------

  function randomKey() { return Math.floor(Math.random() * 99) + 1; }

  function tick() {
    phaseTicks++;
    highlight = null;

    if (phase === 'insert') {
      const v = randomKey();
      highlight = fhInsert(v);
      lastOp = 'insert(' + v + ')';
      if (heap.n >= MAX_NODES) { phase = 'extract'; phaseTicks = 0; }
    }
    else if (phase === 'extract') {
      const k = fhExtractMin();
      lastOp = 'extract-min · ' + (k != null ? k : '∅');
      if (phaseTicks >= 3 || heap.n === 0) { phase = 'decrease'; phaseTicks = 0; }
    }
    else if (phase === 'decrease') {
      const cands = allNodes().filter(n => n.parent !== null);
      if (cands.length === 0 || phaseTicks > 2) {
        phase = 'reset'; phaseTicks = 0;
      } else {
        const t = cands[Math.floor(Math.random() * cands.length)];
        const newK = Math.max(1, (heap.min ? heap.min.key : t.key) - 1);
        fhDecreaseKey(t, newK);
        highlight = t;
        lastOp = 'decrease-key → ' + newK;
      }
    }
    else { // reset
      heap = newHeap();
      phase = 'insert';
      lastOp = 'reset';
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

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Edges (under nodes).
    ctx.strokeStyle = 'rgba(28, 31, 36, 0.30)';
    ctx.lineWidth = 1;
    function edges(n) {
      for (const c of n.children) {
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        edges(c);
      }
    }
    for (const r of heap.roots) edges(r);

    // Nodes.
    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    function nodes(n) {
      const isMin       = n === heap.min;
      const isHighlight = n === highlight;
      ctx.fillStyle   = isMin ? 'rgba(47, 106, 160, 0.92)'
                              : 'rgba(243, 239, 230, 1)';
      ctx.strokeStyle = isHighlight ? 'rgba(194, 83, 43, 0.95)'
                                    : 'rgba(47, 106, 160, 0.85)';
      ctx.lineWidth   = isHighlight ? 2 : 1;
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
      ctx.fillStyle = isMin ? 'white' : 'rgba(28, 31, 36, 0.85)';
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
  }

  function start() { if (!tickId) tickId = setInterval(tick, TICK_MS); }
  function stop()  { if (tickId)  { clearInterval(tickId); tickId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  // Pre-seed so the first frame isn't empty.
  fhInsert(randomKey());
  fhInsert(randomKey());
  relayout();
  if (!reducedMotion()) start();
}
