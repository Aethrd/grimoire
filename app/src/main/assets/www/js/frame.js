/* Drawing the picture frame.
 *
 * Where on the screen pictures go, and what shape they are given, marked out
 * the way a panel is blacked out: by dragging corners. The frame is drawn
 * over the whole screen because that is what it describes -- a corner put at
 * the top-left of the glass is the top-left of the glass when reading.
 *
 * Kept as fractions of the screen, {l, t, r, b}, so a frame means the same
 * on any phone and survives the phone being turned round.
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
  const ratio = ((frame.r - frame.l) * screenW) / ((frame.b - frame.t) * screenH);
  const named = PRESETS.find(([, value]) => Math.abs(value - ratio) / value < 0.015);
  return named ? named[0] : `${ratio.toFixed(2)} : 1`;
}

/**
 * Open the editor over everything.
 *
 * @param initial  the frame in use, or null for none
 * @param options.sample  a picture to show inside the frame, so its effect
 *                        can be seen rather than imagined
 * @param options.fit     how pictures are fitted, so the sample is shown that way
 * @returns a promise of the new frame, null for "no frame", or undefined if
 *          the editor was cancelled.
 */
export function editFrame(initial, { sample = null, fit = 'screen' } = {}) {
  return new Promise((resolve) => {
    const W = () => window.innerWidth || 360;
    const H = () => window.innerHeight || 640;
    let frame = tidy(initial || presetFrame(2 / 3, W(), H()));
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

    function finish(value) {
      window.removeEventListener('resize', paint);
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
      paint();
    };
    host.querySelector('.frame-edit-flip').onclick = () => { barAtTop = !barAtTop; paint(); };
    host.querySelector('[data-act="cancel"]').onclick = () => finish(undefined);
    host.querySelector('[data-act="none"]').onclick = () => finish(null);
    host.querySelector('[data-act="save"]').onclick = () => finish(frame);
    // Back, or anything else that wants the screen, cancels.
    host.cancel = () => finish(undefined);

    window.addEventListener('resize', paint);
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
