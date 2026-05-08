// widgets/_helpers.js
//
// Shared utilities for gutter widgets. Tiny on purpose — a widget
// is just a function. These helpers handle the boring parts:
// building the wrapper DOM, anchoring it in a gutter, pausing
// when off-screen, and reacting to resize.
//
// Anything that's specific to a widget (Game of Life rules,
// sorting algorithms, etc.) lives in that widget's own file.

const MAIN_WIDTH = 620;     // matches main { max-width: 620px } in styles
const GUTTER_PAD = 36;

export function gutterWidth() {
  return (window.innerWidth - MAIN_WIDTH) / 2;
}

// Pick a width that scales with the gutter, clamped to a widget's range.
// Widgets call this in relayout() so they grow on wide screens and stay
// readable on smaller ones. fraction = how much of the gutter to occupy.
export function responsiveWidth({ min, max, fraction = 0.72 }) {
  const w = Math.floor(gutterWidth() * fraction);
  return Math.min(max, Math.max(min, w));
}

// Build a widget shell: container, optional <select>, optional label,
// optional control buttons. The widget supplies its own canvas (or any
// other content element) — we just wire it in at the top.
//
//   const { wrap, buttons, select } = mount({
//     content: canvas,
//     select:   { options: [...], value: 'x', onChange: (v) => ... },
//     label:    '// life · click to toggle',
//     controls: [{ id: 'clear', text: '[ clear ]', onClick: clear }],
//   });
export function mount({ content, select, label, controls = [] } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'widget';
  if (content) wrap.appendChild(content);

  let selectEl = null;
  if (select) {
    selectEl = document.createElement('select');
    selectEl.className = 'widget-select';
    for (const opt of select.options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    }
    if (select.value) selectEl.value = select.value;
    selectEl.addEventListener('change', () => select.onChange(selectEl.value));
    wrap.appendChild(selectEl);
  }

  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'widget-label';
    labelEl.textContent = label;
    wrap.appendChild(labelEl);
  }

  const buttons = {};
  if (controls.length) {
    const cEl = document.createElement('div');
    cEl.className = 'widget-controls';
    for (const c of controls) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'widget-btn';
      b.textContent = c.text;
      b.addEventListener('click', () => c.onClick(b));
      cEl.appendChild(b);
      buttons[c.id] = b;
    }
    wrap.appendChild(cEl);
  }

  document.body.appendChild(wrap);
  return { wrap, buttons, select: selectEl };
}

// Anchor the widget at a vertical scroll position in the chosen gutter.
// Returns true if the gutter is wide enough to hold the widget.
//
// Horizontal placement: we *center* the widget inside the gutter rather
// than pin it to the page edge. On wide browsers this keeps widgets
// visually close to the main column instead of stranded at the edge.
// On narrow-but-just-fits browsers it falls back gracefully.
//
// Vertical: position: absolute children don't reliably extend the
// document's scroll height, so we bump body.min-height to ensure the
// page can actually scroll far enough to show the widget.
export function place(wrap, { side, top, width }) {
  const g = gutterWidth();
  if (g < width + 50) {     // need breathing room or hide
    wrap.style.display = 'none';
    return false;
  }
  wrap.style.display = '';
  wrap.style.top = top + 'px';
  wrap.style.width = width + 'px';
  // Center within gutter, but never closer than GUTTER_PAD to the page edge.
  const offset = Math.max(GUTTER_PAD, (g - width) / 2);
  if (side === 'left')  { wrap.style.left  = offset + 'px'; wrap.style.right = ''; }
  else                  { wrap.style.right = offset + 'px'; wrap.style.left  = ''; }
  // After the canvas inside has been resized by the caller (next frame),
  // extend the document so this widget is reachable by scroll.
  requestAnimationFrame(() => {
    const h = wrap.getBoundingClientRect().height;
    if (h <= 0) return;
    extendDocumentTo(top + h + 40);
  });
  return true;
}

// Grow body.min-height so absolutely-positioned widgets aren't cut off.
// Only ever grows — multiple widgets compound.
function extendDocumentTo(px) {
  const cur = parseInt(document.body.style.minHeight, 10) || 0;
  if (px > cur) document.body.style.minHeight = px + 'px';
}

// Debounced resize via rAF. Returns an unsubscribe fn.
export function onResize(cb) {
  let pending = false;
  const handler = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; cb(); });
  };
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}

// Run start when the widget is both in the DOM/viewport AND the tab is
// visible; stop otherwise. Saves CPU for long pages and background tabs.
export function visibility(el, { onShow, onHide }) {
  let inDoc = !document.hidden;
  let inView = true;
  const update = () => { if (inDoc && inView) onShow(); else onHide(); };
  document.addEventListener('visibilitychange', () => {
    inDoc = !document.hidden; update();
  });
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver(([e]) => {
      inView = e.isIntersecting; update();
    }, { rootMargin: '200px' }).observe(el);
  }
}

export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
