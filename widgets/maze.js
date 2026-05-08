// widgets/maze.js
//
// Random maze generation + BFS solving, animated.
//
// Generation: recursive backtracker (DFS). Carves a perfect maze
// (exactly one path between any two cells, no loops).
// Solving:    breadth-first search from top-left to bottom-right.
//             Visited cells fade in; the final path draws bold once
//             the goal is reached.
// Cycle:      after the path is shown, a short pause, then a fresh
//             maze is generated and the solve restarts.

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const COLS = 24;
const ROWS = 16;
const MIN_W = 320;
const MAX_W = 480;
const TICK_MS = 35;
const STEPS_PER_TICK = 2;

// Solver picker — each is a (state, neighbors) → step function. Pull
// strategy differs (FIFO / LIFO / min-f) and shapes the visited
// region: BFS spreads as a wave, DFS sends thin tendrils, A* heads
// straight at the goal.
const SOLVERS = ['bfs', 'dfs', 'a*'];

export function maze({ side = 'left', top = 720 } = {}) {
  let CELL = 14;
  let W = COLS * CELL, H = ROWS * CELL;
  let cells = [];
  let bfsState = null;
  let algo = 'bfs';
  let pauseFrames = 0;
  let tickId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    select: {
      options: SOLVERS.map(v => ({ value: v, label: v })),
      value: 'bfs',
      onChange: (v) => { algo = v; regenerate(); },
    },
    label: '// maze · pick a solver',
    controls: [
      { id: 'regen', text: '[ regenerate ]', onClick: regenerate },
    ],
  });

  // Stats live in their own element, above the canvas — putting them
  // on-canvas at the bottom-right placed them right where the path
  // ends and made them hard to read. Italic serif accent matches the
  // on-canvas labels used in hashring / raft / sorting.
  const statsEl = document.createElement('div');
  statsEl.style.cssText =
    "margin-bottom: 6px; font-family: 'Instrument Serif', serif; " +
    "font-style: italic; font-size: 12.5px; color: rgba(47, 106, 160, 0.85);";
  wrap.insertBefore(statsEl, canvas);

  function relayout() {
    const target = responsiveWidth({ min: MIN_W, max: MAX_W });
    CELL = Math.max(10, Math.floor(target / COLS));
    W = CELL * COLS; H = CELL * ROWS;
    if (!place(wrap, { side, top, width: W })) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // ---- generation: recursive backtracker (iterative w/ stack) ----
  function generate() {
    cells = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => ({
        walls: { n: true, e: true, s: true, w: true },
        gen: false,
      })));
    const DIRS = [['n', 0, -1, 's'], ['e', 1, 0, 'w'], ['s', 0, 1, 'n'], ['w', -1, 0, 'e']];
    const stack = [[0, 0]];
    cells[0][0].gen = true;
    while (stack.length) {
      const [x, y] = stack[stack.length - 1];
      const dirs = [...DIRS].sort(() => Math.random() - 0.5);
      let moved = false;
      for (const [dir, dx, dy, opp] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        if (cells[ny][nx].gen) continue;
        cells[y][x].walls[dir] = false;
        cells[ny][nx].walls[opp] = false;
        cells[ny][nx].gen = true;
        stack.push([nx, ny]);
        moved = true;
        break;
      }
      if (!moved) stack.pop();
    }
  }

  // ---- solver state -----------------------------------------------
  // The struct is shared across all algorithms; only the pull strategy
  // (and what we put in `open`) varies. `dist` holds the cost from
  // start (BFS depth / DFS depth / A*'s g) and drives the gradient.
  const key = ({ x, y }) => y * COLS + x;
  const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  function startSolver() {
    const start = { x: 0, y: 0 };
    const end   = { x: COLS - 1, y: ROWS - 1 };
    const startNode = { x: 0, y: 0, g: 0, f: manhattan({ x: 0, y: 0 }, end) };
    bfsState = {
      open:    [startNode],
      dist:    new Map([[key(start), 0]]),
      maxDist: 0,
      parent:  new Map(),
      end,
      done:    false,
      path:    null,
    };
  }

  function neighbors(c) {
    const out = [];
    const w = cells[c.y][c.x].walls;
    if (!w.n) out.push({ x: c.x,     y: c.y - 1 });
    if (!w.e) out.push({ x: c.x + 1, y: c.y     });
    if (!w.s) out.push({ x: c.x,     y: c.y + 1 });
    if (!w.w) out.push({ x: c.x - 1, y: c.y     });
    return out;
  }

  // Pull the next cell to expand, depending on algorithm:
  //   bfs → FIFO (head)         · uniform wavefront
  //   dfs → LIFO (tail)         · long tendrils, often non-optimal path
  //   a*  → lowest f = g + h    · elongated toward the goal
  function pullNext() {
    const open = bfsState.open;
    if (!open.length) return null;
    if (algo === 'bfs')   return open.shift();
    if (algo === 'dfs')   return open.pop();
    // A*: linear scan is fine for ≤384 cells.
    let mi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[mi].f) mi = i;
    return open.splice(mi, 1)[0];
  }

  function tick() {
    if (!bfsState) return;
    if (bfsState.done) {
      // Hold the finished path on screen briefly, then regenerate.
      pauseFrames++;
      if (pauseFrames > 50) { pauseFrames = 0; regenerate(); }
      return;
    }
    for (let i = 0; i < STEPS_PER_TICK; i++) {
      const cell = pullNext();
      if (!cell) { bfsState.done = true; break; }
      if (cell.x === bfsState.end.x && cell.y === bfsState.end.y) {
        // Reconstruct path back to start.
        const path = [];
        let cur = cell;
        while (cur) { path.unshift(cur); cur = bfsState.parent.get(key(cur)); }
        bfsState.path = path;
        bfsState.done = true;
        break;
      }
      const g = bfsState.dist.get(key(cell));
      for (const n of neighbors(cell)) {
        const nk = key(n);
        if (!bfsState.dist.has(nk)) {
          bfsState.dist.set(nk, g + 1);
          if (g + 1 > bfsState.maxDist) bfsState.maxDist = g + 1;
          bfsState.parent.set(nk, cell);
          bfsState.open.push({
            x: n.x, y: n.y,
            g: g + 1,
            f: (g + 1) + manhattan(n, bfsState.end),
          });
        }
      }
    }
    draw();
  }

  function regenerate() {
    generate();
    startSolver();
    pauseFrames = 0;
    draw();
  }

  // ---- drawing ----

  // BFS-distance gradient: cool & light at the start, cool & deep
  // mid-range, warm at the deepest cells. Reads as a heat wave moving
  // outward from the source.
  const C_NEAR = [120, 170, 200];   // light steel
  const C_MID  = [ 47, 106, 160];   // accent steel blue
  const C_FAR  = [194,  83,  43];   // rust
  const lerp = (a, b, t) => a + (b - a) * t;
  function distColor(t) {
    let r, g, b, a;
    if (t < 0.5) {
      const u = t * 2;
      r = lerp(C_NEAR[0], C_MID[0], u);
      g = lerp(C_NEAR[1], C_MID[1], u);
      b = lerp(C_NEAR[2], C_MID[2], u);
      a = lerp(0.18, 0.55, u);
    } else {
      const u = (t - 0.5) * 2;
      r = lerp(C_MID[0], C_FAR[0], u);
      g = lerp(C_MID[1], C_FAR[1], u);
      b = lerp(C_MID[2], C_FAR[2], u);
      a = 0.55;
    }
    return `rgba(${r|0}, ${g|0}, ${b|0}, ${a})`;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Distance gradient — every reached cell tinted by its BFS depth.
    if (bfsState && bfsState.dist.size) {
      const max = Math.max(1, bfsState.maxDist);
      for (const [k, d] of bfsState.dist) {
        const x = k % COLS, y = (k - x) / COLS;
        ctx.fillStyle = distColor(d / max);
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    // Walls.
    ctx.strokeStyle = 'rgba(28, 31, 36, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const w  = cells[y][x].walls;
        const px = x * CELL, py = y * CELL;
        if (w.n) { ctx.moveTo(px,        py);        ctx.lineTo(px + CELL, py);        }
        if (w.e) { ctx.moveTo(px + CELL, py);        ctx.lineTo(px + CELL, py + CELL); }
        if (w.s) { ctx.moveTo(px,        py + CELL); ctx.lineTo(px + CELL, py + CELL); }
        if (w.w) { ctx.moveTo(px,        py);        ctx.lineTo(px,        py + CELL); }
      }
    }
    ctx.stroke();

    // Final path — draw with a paper halo behind it so it pops over
    // whatever gradient color happens to live underneath.
    if (bfsState && bfsState.path) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < bfsState.path.length; i++) {
        const p = bfsState.path[i];
        const x = p.x * CELL + CELL / 2;
        const y = p.y * CELL + CELL / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(243, 239, 230, 0.85)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(28, 31, 36, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    if (bfsState) {
      const visited = bfsState.dist.size;
      statsEl.textContent = bfsState.path
        ? `visited ${visited} · path ${bfsState.path.length}`
        : `visited ${visited}`;
    }
  }

  function start() { if (!tickId) tickId = setInterval(tick, TICK_MS); }
  function stop()  { if (tickId)  { clearInterval(tickId); tickId = null; } }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  // Order matters: relayout() calls draw(), and draw() reads `cells`,
  // so the maze must be generated before the first layout pass.
  generate();
  startSolver();
  relayout();
  if (!reducedMotion()) start();
}
