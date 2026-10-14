/* Drawing the picture frame.
 *
 * Where on the screen pictures go, and what shape they are given, marked out
 * the way a panel is blacked out: by dragging corners. The frame is drawn
 * over the whole screen because that is what it describes -- a corner put at
 * the top-left of the glass is the top-left of the glass when reading.
 *
 * Kept as fractions of the screen, {l, t, r, b}, so a frame means the same
 * on any phone. And kept the way up the phone is held upright, so it belongs
 * to the glass rather than to whichever way the picture happens to be shown:
 * turn the phone on its side and the frame turns with it, the same shape on
 * the same part of the screen, and the pictures inside it are shown the right
 * way up for a phone held sideways. A frame drawn with the phone sideways is
 * kept the same way, so it stands upright when the phone does.
 *
 * Corners drag the two edges that meet there; the dot in the middle of an
 * edge drags that edge alone; dragging inside moves the frame whole. A preset
 * shape -- 2:3 for a manga page, 3:4, 9:16 -- is the largest frame of that
 * shape the screen holds, centred, to be adjusted from there.
 */

const MIN = 0.15;              // no side shorter than this share of the screen
const REACH = 28;              // how near a finger has to be to take hold, in px

export const PRESETS = [
  ['2:3', 2 / 3], ['3:4', 3 / 4], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9],
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n * 10000) / 10000;

/* ── which way up ─────────────────────────────────────────────────────── */

/**
 * How far the screen is turned from the way the phone is held upright, in
 * degrees: 0, 90 (turned anticlockwise, its top to the left), 180 or 270
 * (clockwise, its top to the right).
 */
export function screenTurn() {
  const angle = typeof window !== 'undefined' ? window.screen?.orientation?.angle : undefined;
  if (Number.isFinite(angle)) return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  // Older WebViews: the deprecated window.orientation says -90 for 270.
  const legacy = typeof window !== 'undefined' ? window.orientation : undefined;
  if (Number.isFinite(legacy)) return ((legacy % 360) + 360) % 360;
  return 0;
}

/**
 * A frame kept upright, as it is on the screen at a turn: the same piece of
 * glass, described the way the screen now runs.
 *
 * Turned anticlockwise, the phone's top edge is the screen's left, and its
 * right edge the screen's top -- so across the screen now is down the phone,
 * and down the screen now is leftwards along it.
 */
export function toScreen(frame, turn = screenTurn()) {
  if (!frame) return null;
  const { l, t, r, b } = frame;
  const shape = {
    0: { l, t, r, b },
    90: { l: t, t: 1 - r, r: b, b: 1 - l },
    180: { l: 1 - r, t: 1 - b, r: 1 - l, b: 1 - t },
    270: { l: 1 - b, t: l, r: 1 - t, b: r },
  }[turn] || { l, t, r, b };
  return { l: round(shape.l), t: round(shape.t), r: round(shape.r), b: round(shape.b) };
}

/** The other way: a frame as it is on the screen now, kept upright. */
export function toUpright(frame, turn = screenTurn()) {
  return toScreen(frame, (360 - turn) % 360);
}

/** The largest frame of a shape (width over height) the screen holds, centred. */
export function presetFrame(ratio, screenW, screenH, inset = 0.03) {
  const roomW = screenW * (1 - 2 * inset);
  const roomH = screenH * (1 - 2 * inset);
  let w = roomW;
  let h = w / ratio;
  if (h > roomH) { h = roomH; w = h * ratio; }
  const l = (screenW - w) / 2 / screenW;
  const t = (screenH - h) / 2 / screenH;
  return { l: round(l), t: round(t), r: round(1 - l), b: round(1 - t) };
}

/** A frame kept inside the screen and no smaller than the minimum. */
export function tidy(frame) {
  let { l, t, r, b } = frame;
  l = clamp(l, 0, 1 - MIN); t = clamp(t, 0, 1 - MIN);
  r = clamp(r, l + MIN, 1); b = clamp(b, t + MIN, 1);
  return { l: round(l), t: round(t), r: round(r), b: round(b) };
}

/**
 * A frame with one part of it moved by (dx, dy), as fractions of the screen.
 *
 * @param part  'tl' 'tr' 'br' 'bl' for a corner, 't' 'r' 'b' 'l' for an
 *              edge, 'move' for the whole frame.
 */
export function dragFrame(frame, part, dx, dy) {
  let { l, t, r, b } = frame;
  if (part === 'move') {
    const w = r - l;
    const h = b - t;
    l = clamp(l + dx, 0, 1 - w); t = clamp(t + dy, 0, 1 - h);
    return { l: round(l), t: round(t), r: round(l + w), b: round(t + h) };
  }
  if (part.includes('l')) l = clamp(l + dx, 0, r - MIN);
  if (part.includes('r')) r = clamp(r + dx, l + MIN, 1);
  if (part.includes('t')) t = clamp(t + dy, 0, b - MIN);
  if (part.includes('b')) b = clamp(b + dy, t + MIN, 1);
  return { l: round(l), t: round(t), r: round(r), b: round(b) };
}

/** What is under a finger at (x, y) px: a corner, an edge, inside, or nothing. */
export function partAt(frame, x, y, screenW, screenH, reach = REACH) {
  const L = frame.l * screenW; const R = frame.r * screenW;
  const T = frame.t * screenH; const B = frame.b * screenH;
  const near = (px, py) => Math.hypot(x - px, y - py) <= reach;
  for (const [name, px, py] of [['tl', L, T], ['tr', R, T], ['br', R, B], ['bl', L, B]]) {
    if (near(px, py)) return name;
  }
  for (const [name, px, py] of [['t', (L + R) / 2, T], ['r', R, (T + B) / 2], ['b', (L + R) / 2, B], ['l', L, (T + B) / 2]]) {
    if (near(px, py)) return name;
  }
  if (x > L && x < R && y > T && y < B) return 'move';
  return null;
}

/** The frame's shape in words: "2:3", or the nearest plain ratio. */
export function describe(frame, screenW, screenH) {
  if (!frame) return 'Whole page';
  const ratio = frame.shape || ((frame.r - frame.l) * screenW) / ((frame.b - frame.t) * screenH);
  const near = (value) => Math.abs(value - ratio) / value < 0.015;
  const named = PRESETS.find(([, value]) => near(value));
  if (named) return named[0];
  // A preset turned on its side is named that way round: 16:9 lying down
  // stood up is 9:16, and 2:3 turned is 3:2.
  const turned = PRESETS.find(([, value]) => near(1 / value));
  if (turned) return turned[0].split(':').reverse().join(':');
  return `${ratio.toFixed(2)} : 1`;
}

/**
 * The shape of a frame, width over height in pixels, as it stands upright.
 * Kept with the frame, so turning the screen gives exactly the shape turned
 * -- 16:9 lying down is 9:16 standing up, not "about" -- even though the
 * screen itself is not exactly the same size both ways round (the navigation
 * bar moves to the side).
 */
export function shapeOf(frame, screenW, screenH, turn = 0) {
  const ratio = ((frame.r - frame.l) * screenW) / ((frame.b - frame.t) * screenH);
  return Math.round((turn % 180 ? 1 / ratio : ratio) * 10000) / 10000;
}

/** A kept frame's shape in words, the way round the screen is now. */
export function describeKept(frame, turn = screenTurn()) {
  if (!frame) return 'Whole page';
  const W = window.innerWidth || 360;
  const H = window.innerHeight || 640;
  const shape = frame.ratio ? (turn % 180 ? 1 / frame.ratio : frame.ratio) : 0;
  return describe({ ...toScreen(frame, turn), shape }, W, H);
}

/**
 * A box held to a shape: the longer way shrunk, about its middle, until the
 * box is exactly that shape. The corners stay the corners of the shape.
 */
export function holdShape(box, ratio) {
  if (!ratio) return box;
  let { left, top, right, bottom } = box;
  const w = right - left;
  const h = bottom - top;
  if (!w || !h || Math.abs(w / h - ratio) / ratio < 0.001) return box;
  if (w / h > ratio) {
    const cx = (left + right) / 2;
    left = cx - (h * ratio) / 2; right = cx + (h * ratio) / 2;
  } else {
    const cy = (top + bottom) / 2;
    top = cy - (w / ratio) / 2; bottom = cy + (w / ratio) / 2;
  }
  return { left, top, right, bottom };
}

/**
 * Open the editor over everything.
 *
 * @param initial  the frame in use, kept upright (see toScreen), or null
 * @param options.sample  a picture to show inside the frame, so its effect
 *                        can be seen rather than imagined
 * @param options.fit     how pictures are fitted, so the sample is shown that way
 * @returns a promise of the new frame, kept upright, null for "no frame", or
 *          undefined if the editor was cancelled.
 */
export function editFrame(initial, { sample = null, fit = 'screen' } = {}) {
  return new Promise((resolve) => {
    const W = () => window.innerWidth || 360;
    const H = () => window.innerHeight || 640;
    // Drawn as the screen runs now; turned back upright when it is kept.
    let turn = screenTurn();
    // A kept frame, turned to the screen as it is now and held to exactly
    // its shape -- what reading will show, so what is dragged is that.
    const shown = (kept, now) => {
      const f = toScreen(kept, now);
      if (!kept.ratio) return f;
      const w = W(); const h = H();
      const box = holdShape({ left: f.l * w, top: f.t * h, right: f.r * w, bottom: f.b * h },
        now % 180 ? 1 / kept.ratio : kept.ratio);
      return { l: box.left / w, t: box.top / h, r: box.right / w, b: box.bottom / h };
    };
    let frame = tidy(initial ? shown(initial, turn) : presetFrame(2 / 3, W(), H()));
    // The screen's size the frame was last drawn at, for its shape once the
    // screen has turned and changed size underneath it.
    let drawnAt = { w: W(), h: H() };
    let drag = null;
    let barAtTop = false;

    const host = document.createElement('div');
    host.className = 'frame-edit';
    host.innerHTML = `
      ${sample ? `<img class="frame-edit-sample" alt="" src="${sample}" data-fit="${fit}">` : '<span class="frame-edit-sample blank">Pictures go here</span>'}
      <svg class="frame-edit-svg" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="frame-edit-bar">
        <div class="frame-edit-row">
          <b class="frame-edit-caption"></b>
          <button class="icon-btn frame-edit-flip" title="Move this bar"><svg viewBox="0 0 24 24"><path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/></svg></button>
        </div>
        <p class="frame-edit-hint">Drag a corner or an edge to shape where pictures go. Drag inside to move it.</p>
        <div class="chip-row wrap frame-edit-presets">
          ${PRESETS.map(([name]) => `<button class="chip" data-preset="${name}">${name}</button>`).join('')}
        </div>
        <div class="frame-edit-actions">
          <button class="btn ghost" data-act="cancel">Cancel</button>
          <button class="btn ghost" data-act="none">Whole page</button>
          <button class="btn primary" data-act="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(host);

    const svg = host.querySelector('.frame-edit-svg');
    const bar = host.querySelector('.frame-edit-bar');
    const preview = host.querySelector('.frame-edit-sample');

    function paint() {
      const w = W(); const h = H();
      const L = frame.l * w; const R = frame.r * w; const T = frame.t * h; const B = frame.b * h;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const corners = [[L, T], [R, T], [R, B], [L, B]];
      const edges = [[(L + R) / 2, T], [R, (T + B) / 2], [(L + R) / 2, B], [L, (T + B) / 2]];
      svg.innerHTML = `<path class="shade" fill-rule="evenodd" d="M0 0H${w}V${h}H0Z M${L} ${T}V${B}H${R}V${T}Z"/>`
        + `<rect class="outline" x="${L}" y="${T}" width="${R - L}" height="${B - T}"/>`
        + edges.map(([x, y]) => `<circle class="edge" cx="${x}" cy="${y}" r="7"/>`).join('')
        + corners.map(([x, y]) => `<circle class="corner" cx="${x}" cy="${y}" r="12"/>`).join('');
      Object.assign(preview.style, {
        left: `${L}px`, top: `${T}px`, width: `${R - L}px`, height: `${B - T}px`,
      });
      host.querySelector('.frame-edit-caption').textContent = `Picture frame · ${describe(frame, w, h)}`;
      bar.classList.toggle('top', barAtTop);
    }

    // Turned while drawing: the frame turns with the phone, as it will when
    // reading, rather than being stretched to the new shape of the screen.
    function turned() {
      const now = screenTurn();
      if (now !== turn) {
        if (drag) { drag = null; host.classList.remove('dragging'); }
        frame = tidy(shown({ ...toUpright(frame, turn), ratio: shapeOf(frame, drawnAt.w, drawnAt.h, turn) }, now));
        turn = now;
        drawnAt = { w: W(), h: H() };
      }
      paint();
    }

    function finish(value) {
      window.removeEventListener('resize', turned);
      window.screen?.orientation?.removeEventListener?.('change', turned);
      host.remove();
      resolve(value);
    }

    svg.addEventListener('pointerdown', (event) => {
      if (drag) return;
      const part = partAt(frame, event.clientX, event.clientY, W(), H());
      if (!part) return;
      event.preventDefault();
      try { svg.setPointerCapture?.(event.pointerId); } catch { /* not every target can */ }
      drag = { pointer: event.pointerId, part, x: event.clientX, y: event.clientY, from: frame };
      host.classList.add('dragging');
    });
    svg.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      event.preventDefault();
      frame = dragFrame(drag.from, drag.part, (event.clientX - drag.x) / W(), (event.clientY - drag.y) / H());
      drawnAt = { w: W(), h: H() };
      paint();
    });
    const end = (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      drag = null;
      host.classList.remove('dragging');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    host.querySelector('.frame-edit-presets').onclick = (event) => {
      const chip = event.target.closest('[data-preset]');
      if (!chip) return;
      const ratio = PRESETS.find(([name]) => name === chip.dataset.preset)[1];
      frame = presetFrame(ratio, W(), H());
      drawnAt = { w: W(), h: H() };
      paint();
    };
    host.querySelector('.frame-edit-flip').onclick = () => { barAtTop = !barAtTop; paint(); };
    host.querySelector('[data-act="cancel"]').onclick = () => finish(undefined);
    host.querySelector('[data-act="none"]').onclick = () => finish(null);
    host.querySelector('[data-act="save"]').onclick = () => {
      const now = screenTurn();
      finish({ ...toUpright(frame, now), ratio: shapeOf(frame, W(), H(), now) });
    };
    // Back, or anything else that wants the screen, cancels.
    host.cancel = () => finish(undefined);

    window.addEventListener('resize', turned);
    // Straight from one side to the other the screen keeps its size, so no
    // resize says anything happened.
    window.screen?.orientation?.addEventListener?.('change', turned);
    paint();
  });
}

/** Whether the editor is open, and closing it: for the back gesture. */
export function closeFrameEditor() {
  const open = document.querySelector('.frame-edit');
  if (!open) return false;
  open.cancel?.();
  return true;
}
