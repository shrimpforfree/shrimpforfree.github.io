// widgets/life.js
//
// Conway's Game of Life — interactive gutter widget.
//
// Rules (1970, John Conway):
//   1. A live cell with 2 or 3 live neighbors stays alive.
//   2. A live cell with fewer than 2 OR more than 3 dies.
//   3. A dead cell with exactly 3 live neighbors comes alive.
//
// Layout: a fixed grid (COLS × ROWS). Cell pixel size is computed
// from gutter width, so the canvas grows on wide browsers without
// resizing the simulation itself — the same population just renders
// at a chunkier scale.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const COLS = 40;        // wide
const ROWS = 22;        // shorter — landscape
const MIN_W = 400;      // smallest rendered width
const MAX_W = 600;      // largest rendered width

export function life({ side = 'right', top = 60 } = {}) {
  // ---- simulation state (independent of pixel size) ----
  const idx = (x, y) => y * COLS + x;
  let grid = new Uint8Array(COLS * ROWS);
  let next = new Uint8Array(COLS * ROWS);
  let stepId = null;
  let dragging = false, dragValue = 1;
  // History of the last 3 grid hashes — used to detect when the
  // simulation has settled into a still life (period 1) or short
  // oscillator (period 2 or 3) so we can re-seed instead of staring
  // at a frozen blinker forever.
  let history = [];
  let stagnant = 0;
  const STAGNANT_LIMIT = 28;   // ~3.4s at 120ms/step

  // ---- pixel state (set by relayout) ----
  let CELL = 10;
  let W = COLS * CELL;
  let H = ROWS * CELL;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label:   '// life · click to toggle cells',
    controls: [
      { id: 'clear', text: '[ clear ]', onClick: clear },
      { id: 'seed',  text: '[ seed ]',  onClick: seed },
    ],
  });

  function relayout() {
    // Pick a target width based on the gutter, then snap to an integer
    // cell size so cells render crisp.
    const target = responsiveWidth({ min: MIN_W, max: MAX_W });
    CELL = Math.max(8, Math.floor(target / COLS));
    W = CELL * COLS;
    H = CELL * ROWS;
    if (!place(wrap, { side, top, width: W })) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function seed() {
    // ~22% density — busy enough to be interesting, sparse enough that
    // recognizable structures emerge instead of insta-dying.
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random() < 0.22 ? 1 : 0;
    history = [];
    stagnant = 0;
    draw();
  }
  function clear() { grid.fill(0); history = []; stagnant = 0; draw(); }

  // FNV-1a-ish hash over the grid bytes — fast, collision-free enough
  // for the grids of interest (still lifes, blinkers, gliders).
  function gridHash() {
    let h = 0x811c9dc5;
    for (let i = 0; i < grid.length; i++) {
      h ^= grid[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h;
  }

  function step() {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        // Toroidal wrap: edges connect to the opposite side.
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = (x + dx + COLS) % COLS;
          const ny = (y + dy + ROWS) % ROWS;
          n += grid[idx(nx, ny)];
        }
        const a = grid[idx(x, y)];
        next[idx(x, y)] = (a && (n === 2 || n === 3)) || (!a && n === 3) ? 1 : 0;
      }
    }
    [grid, next] = [next, grid];   // swap buffers — no allocation per step

    // Cycle detection: if this generation matches any of the last 3,
    // we've hit a still life (period 1) or a short oscillator (period
    // 2 or 3). Hold the pattern briefly, then re-seed.
    const h = gridHash();
    if (history.includes(h)) stagnant++;
    else                     stagnant = 0;
    history.push(h);
    if (history.length > 3) history.shift();
    if (stagnant > STAGNANT_LIMIT) seed();

    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(47, 106, 160, 0.80)';
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (grid[idx(x, y)]) ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
    }
  }

  function cellAt(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches && e.touches[0];
    const px = (t ? t.clientX : e.clientX) - r.left;
    const py = (t ? t.clientY : e.clientY) - r.top;
    const x = Math.floor(px / CELL), y = Math.floor(py / CELL);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null;
    return { x, y };
  }

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const c = cellAt(e); if (!c) return;
    dragging = true;
    dragValue = grid[idx(c.x, c.y)] ? 0 : 1;
    grid[idx(c.x, c.y)] = dragValue;
    draw();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const c = cellAt(e); if (!c) return;
    grid[idx(c.x, c.y)] = dragValue; draw();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const c = cellAt(e); if (!c) return;
    dragging = true;
    dragValue = grid[idx(c.x, c.y)] ? 0 : 1;
    grid[idx(c.x, c.y)] = dragValue; draw();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!dragging) return;
    const c = cellAt(e); if (!c) return;
    grid[idx(c.x, c.y)] = dragValue; draw();
  }, { passive: false });
  canvas.addEventListener('touchend', () => { dragging = false; });

  function start() { if (!stepId) stepId = setInterval(step, 120); }
  function stop()  { if (stepId)  { clearInterval(stepId); stepId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  relayout();
  seed();
  if (!reducedMotion()) start();
}
