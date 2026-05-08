// widgets/sorting.js
//
// Sorting visualizer. One canvas, one dropdown, six algorithms.
// Each algorithm is a generator that yields the indices being
// touched at that step — the draw loop highlights them.
//
// To add a new algorithm: write a generator below, then add it
// to the ALGOS map at the top.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const N = 48;          // array length
const MIN_W = 320;     // smallest rendered width
const MAX_W = 480;     // largest rendered width
const ASPECT = 0.85;   // height / width
const TICK_MS = 18;    // step interval — lower = faster

const ALGOS = {
  bubble:    bubbleSort,
  insertion: insertionSort,
  selection: selectionSort,
  merge:     mergeSort,
  quick:     quickSort,
  heap:      heapSort,
};

export function sorting({ side = 'left', top = 60 } = {}) {
  let W = MIN_W, H = Math.round(MIN_W * ASPECT);
  let arr = shuffled(N);
  let active = [];      // indices to highlight this frame
  let gen = null;
  let tickId = null;
  let algo = 'bubble';
  let paused = false;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap, buttons } = mount({
    content: canvas,
    select: {
      options: Object.keys(ALGOS).map(k => ({ value: k, label: k })),
      value:   'bubble',
      onChange: (v) => { algo = v; restart(); },
    },
    label: '// sort · pick an algorithm',
    controls: [
      { id: 'shuffle', text: '[ shuffle ]', onClick: () => { arr = shuffled(N); restart(); } },
      { id: 'pause',   text: '[ pause ]',   onClick: togglePause },
    ],
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
    draw();
  }

  function restart() {
    gen = ALGOS[algo](arr);
    active = [];
    draw();
  }

  function tick() {
    if (!gen) {
      // Sort finished — auto-shuffle and start a new pass.
      arr = shuffled(N);
      restart();
      return;
    }
    const { value, done } = gen.next();
    if (done) { gen = null; active = []; draw(); return; }
    active = value || [];
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const w = W / arr.length;
    for (let i = 0; i < arr.length; i++) {
      const h = (arr[i] / arr.length) * (H - 8);
      ctx.fillStyle = active.includes(i)
        ? 'rgba(47, 106, 160, 0.90)'
        : 'rgba(28, 31, 36, 0.55)';
      ctx.fillRect(i * w + 0.5, H - h, w - 1, h);
    }
  }

  function start() {
    if (paused) return;
    if (!tickId) tickId = setInterval(tick, TICK_MS);
  }
  function stop() {
    if (tickId) { clearInterval(tickId); tickId = null; }
  }
  function togglePause() {
    paused = !paused;
    buttons.pause.textContent = paused ? '[ play ]' : '[ pause ]';
    if (paused) stop(); else start();
  }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  relayout();
  restart();
  if (!reducedMotion()) start();
}

// ---- helpers ----------------------------------------------------

function shuffled(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i + 1;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- algorithms -------------------------------------------------
// Each is a generator. It mutates `a` in place and yields, after
// every meaningful operation, the indices currently being touched
// (so the renderer can highlight them).

function* bubbleSort(a) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length - i - 1; j++) {
      yield [j, j + 1];
      if (a[j] > a[j + 1]) {
        [a[j], a[j + 1]] = [a[j + 1], a[j]];
        yield [j, j + 1];
      }
    }
  }
}

function* insertionSort(a) {
  for (let i = 1; i < a.length; i++) {
    let j = i;
    while (j > 0 && a[j - 1] > a[j]) {
      yield [j - 1, j];
      [a[j - 1], a[j]] = [a[j], a[j - 1]];
      j--;
    }
  }
}

function* selectionSort(a) {
  for (let i = 0; i < a.length - 1; i++) {
    let m = i;
    for (let j = i + 1; j < a.length; j++) {
      yield [m, j];
      if (a[j] < a[m]) m = j;
    }
    if (m !== i) {
      [a[i], a[m]] = [a[m], a[i]];
      yield [i, m];
    }
  }
}

function* mergeSort(a, lo = 0, hi = a.length) {
  if (hi - lo <= 1) return;
  const mid = (lo + hi) >> 1;
  yield* mergeSort(a, lo, mid);
  yield* mergeSort(a, mid, hi);
  // Merge a[lo..mid) with a[mid..hi) using a small aux buffer.
  const aux = a.slice(lo, hi);
  let i = 0, j = mid - lo;
  for (let k = lo; k < hi; k++) {
    yield [k];
    if      (i >= mid - lo)       a[k] = aux[j++];
    else if (j >= hi - lo)        a[k] = aux[i++];
    else if (aux[j] < aux[i])     a[k] = aux[j++];
    else                          a[k] = aux[i++];
  }
}

function* quickSort(a, lo = 0, hi = a.length - 1) {
  if (lo >= hi) return;
  // Lomuto partition: pivot is the last element.
  const pivot = a[hi];
  let i = lo;
  for (let j = lo; j < hi; j++) {
    yield [j, hi];
    if (a[j] < pivot) {
      [a[i], a[j]] = [a[j], a[i]];
      yield [i, j];
      i++;
    }
  }
  [a[i], a[hi]] = [a[hi], a[i]];
  yield [i, hi];
  yield* quickSort(a, lo, i - 1);
  yield* quickSort(a, i + 1, hi);
}

function* heapSort(a) {
  const n = a.length;
  function* siftDown(start, end) {
    let r = start;
    while (r * 2 + 1 <= end) {
      let c = r * 2 + 1;
      if (c + 1 <= end && a[c] < a[c + 1]) c++;
      yield [r, c];
      if (a[r] < a[c]) {
        [a[r], a[c]] = [a[c], a[r]];
        r = c;
      } else return;
    }
  }
  // Build the max-heap, then repeatedly extract the root.
  for (let s = (n - 2) >> 1; s >= 0; s--) yield* siftDown(s, n - 1);
  for (let e = n - 1; e > 0; e--) {
    [a[0], a[e]] = [a[e], a[0]];
    yield [0, e];
    yield* siftDown(0, e - 1);
  }
}
