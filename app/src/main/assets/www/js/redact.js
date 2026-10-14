/* Blacking out part of a picture.
 *
 * A panel you would rather not see again, a watermark across a page, a
 * translator's note pasted over the art, a spoiler in a colour insert. Each
 * is marked by pressing points round its outline, as many as it needs, in
 * black or white, and saving paints them into the picture itself.
 *
 * Into the picture, not over it. The pixels the book stores are replaced, so
 * the reader, the reel and anything written out of the app -- an EPUB, a
 * smaller copy, a book built onto this one -- all carry the edit. A mask laid
 * over the page at reading time would vanish the moment the book left the
 * app, which is exactly when it was wanted.
 *
 * The original is kept beside it, with the panels that were marked, so the
 * edit can be changed later or taken back. That is a copy of one picture
 * per edited picture, held only inside the app; nothing exported carries it.
 */

import * as store from './store.js';

export const COLOURS = { black: '#000000', white: '#ffffff' };

/* The most a phone is asked to hold in one canvas.
 *
 * A canvas is four bytes a pixel. A webtoon strip of 800 by 30,000 is
 * ninety-six megabytes before anything is drawn on it, and the browser either
 * refuses or the system kills the app for it. Twenty-five million pixels is a
 * hundred megabytes and is where this stops and says so, rather than
 * producing a blank picture or taking the app down. */
const MAX_PIXELS = 25_000_000;
const MAX_SIDE = 32_000;

/* ── panels ──────────────────────────────────────────────────────────── */

/* A panel is its corners, not a box.
 *
 * Comic panels are cut at angles as often as not -- a slanted gutter, a
 * trapezoid for an action beat -- and a rectangle either misses the corner
 * of one or eats into the next. Points pressed round the outline follow its
 * edges exactly -- three for a triangle, six for a hexagon, as many as the
 * shape needs -- and each point, or a whole edge, can be dragged afterwards
 * to fit.
 *
 * Coordinates are the picture's own pixels, so a panel means the same thing
 * at every zoom and on every screen. */

const round = (n) => Math.round(n * 10) / 10;

/**
 * Four corners in the order that goes round the shape.
 *
 * Pressed in any order -- top-left, top-right, bottom-left, bottom-right is
 * the natural reading order and, joined up as pressed, a bow tie. Sorted by
 * angle around their middle they are a panel again.
 */
export function orderCorners(points) {
  const cx = points.reduce((n, [x]) => n + x, 0) / points.length;
  const cy = points.reduce((n, [, y]) => n + y, 0) / points.length;
  const sorted = [...points].sort((a, b) =>
    Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Started from the top-left-most corner, so the same panel always reads
  // the same, however it was pressed.
  let first = 0;
  sorted.forEach(([x, y], at) => {
    if (x + y < sorted[first][0] + sorted[first][1]) first = at;
  });
  return [...sorted.slice(first), ...sorted.slice(0, first)];
}

/** A panel from four pressed corners. */
export function quad(points, colour = 'black') {
  return {
    type: 'quad',
    colour,
    points: orderCorners(points).map(([x, y]) => [round(x), round(y)]),
  };
}

/**
 * A shape from points pressed one after another, joined in the order they
 * were pressed: three points spaced unevenly are an uneven triangle, six are
 * a six-sided shape with those six corners. Traced round the outline of
 * what is to be covered, which is how anyone marks a shape by hand -- so
 * the order is kept, and a shape that dents inward stays dented.
 */
export function poly(points, colour = 'black') {
  return {
    type: 'poly',
    colour,
    points: points.map(([x, y]) => [round(x), round(y)]),
  };
}

/** A shape drawn with corners: what this version draws, and the panels before it. */
export const isPolygon = (shape) => shape?.type === 'poly' || shape?.type === 'quad';

/** The area a panel covers, for telling a panel from four taps in one spot. */
export function area(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** A shape too small to have been meant. */
export function isTiny(shape) {
  if (isPolygon(shape)) return (shape.points?.length || 0) < 3 || area(shape.points) < 16;
  if (shape.type === 'brush') return !shape.points?.length;
  return shape.w < 3 || shape.h < 3;
}

/**
 * Shapes as this version draws them.
 *
 * The first version of this drew boxes; a box is a panel whose corners
 * happen to be square, so one saved then opens as a panel that can be
 * reshaped like any other. */
export function normalise(shapes) {
  return (shapes || []).map((shape) => {
    if (shape.type === 'box') {
      return poly([[shape.x, shape.y], [shape.x + shape.w, shape.y],
        [shape.x + shape.w, shape.y + shape.h], [shape.x, shape.y + shape.h]], shape.colour);
    }
    // A four-cornered panel from the version before is a shape of four points.
    if (shape.type === 'quad') return { ...shape, type: 'poly' };
    return shape;
  });
}

/** A point on the picture, from a point on the screen. */
export function toPicture(clientX, clientY, rect, width, height) {
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  return {
    x: Math.max(0, Math.min(width, ((clientX - rect.left) / rect.width) * width)),
    y: Math.max(0, Math.min(height, ((clientY - rect.top) / rect.height) * height)),
  };
}

/** The middle of each edge, where an edge is taken hold of. */
export function edgeMiddles(points) {
  return points.map(([x1, y1], i) => {
    const [x2, y2] = points[(i + 1) % points.length];
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  });
}

/**
 * Which part of a panel is under a finger: a corner, the middle of an edge,
 * or nothing. Corners first -- on a small panel the two overlap, and a corner
 * is the finer adjustment.
 */
export function handleAt(shape, { x, y }, reach) {
  if (!isPolygon(shape)) return null;
  const nearest = (kind, points) => {
    let best = null;
    points.forEach(([hx, hy], at) => {
      const d = Math.hypot(x - hx, y - hy);
      if (d <= reach && (!best || d < best.d)) best = { kind, at, d };
    });
    return best && { kind: best.kind, at: best.at };
  };
  return nearest('corner', shape.points) || nearest('edge', edgeMiddles(shape.points));
}

/**
 * A panel with one part of it moved.
 *
 * A corner goes where the finger is. An edge moves both its corners by how
 * far the finger has come, so it stays the angle it was. The whole panel
 * moves the same way. Nothing leaves the picture.
 */
export function moveHandle(shape, handle, from, to, width, height) {
  const clampX = (n) => round(Math.max(0, Math.min(width, n)));
  const clampY = (n) => round(Math.max(0, Math.min(height, n)));
  const points = shape.points.map((p) => [...p]);
  if (handle.kind === 'corner') {
    points[handle.at] = [clampX(to.x), clampY(to.y)];
  } else {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    const moving = handle.kind === 'edge'
      ? [handle.at, (handle.at + 1) % points.length]
      : points.map((_, at) => at);
    // Held at the edge of the picture as a whole, not squashed against it.
    for (const at of moving) {
      const [px, py] = shape.points[at];
      dx = Math.max(-px, Math.min(width - px, dx));
      dy = Math.max(-py, Math.min(height - py, dy));
    }
    for (const at of moving) {
      points[at] = [clampX(shape.points[at][0] + dx), clampY(shape.points[at][1] + dy)];
    }
  }
  return { ...shape, points };
}

/**
 * Paint shapes onto a 2D context whose coordinates are the picture's pixels.
 *
 * Kept apart from everything else so the same drawing serves the saved
 * picture and the test that checks it. Ovals and brush strokes are from the
 * first version of this; they are no longer drawn, but one already saved
 * still paints as it was.
 */
export function paintShapes(ctx, shapes) {
  for (const shape of normalise(shapes)) {
    const colour = COLOURS[shape.colour] || COLOURS.black;
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;

    if (shape.type === 'poly' && shape.points?.length >= 3) {
      ctx.beginPath();
      const [[x0, y0], ...rest] = shape.points;
      ctx.moveTo(x0, y0);
      for (const [x, y] of rest) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
      // A hairline of the same colour round it: a filled edge is
      // anti-aliased, and on a black panel border that is a faint grey seam
      // of the picture showing through.
      ctx.lineWidth = 1;
      ctx.lineJoin = 'miter';
      ctx.stroke();
    } else if (shape.type === 'oval') {
      ctx.beginPath();
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2,
        Math.max(0.5, shape.w / 2), Math.max(0.5, shape.h / 2), 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape.type === 'brush' && shape.points?.length) {
      ctx.lineWidth = shape.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const [[x0, y0], ...rest] = shape.points;
      if (!rest.length) {
        ctx.arc(x0, y0, shape.size / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.moveTo(x0, y0);
      for (const [x, y] of rest) ctx.lineTo(x, y);
      ctx.stroke();
    }
  }
}

/** The same shapes as SVG, for drawing them over the picture while editing. */
export function svgFor(shape) {
  const fill = COLOURS[shape.colour] || COLOURS.black;
  if (isPolygon(shape)) {
    return `<polygon points="${shape.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${fill}"/>`;
  }
  if (shape.type === 'box') return svgFor(normalise([shape])[0]);
  if (shape.type === 'oval') {
    return `<ellipse cx="${shape.x + shape.w / 2}" cy="${shape.y + shape.h / 2}" `
      + `rx="${shape.w / 2}" ry="${shape.h / 2}" fill="${fill}"/>`;
  }
  if (shape.type === 'brush' && shape.points?.length) {
    if (shape.points.length === 1) {
      const [[x, y]] = shape.points;
      return `<circle cx="${x}" cy="${y}" r="${shape.size / 2}" fill="${fill}"/>`;
    }
    const d = shape.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${fill}" stroke-width="${shape.size}" `
      + 'stroke-linecap="round" stroke-linejoin="round"/>';
  }
  return '';
}

/**
 * The topmost shape under a point; -1 for none.
 *
 * Topmost, because that is the one you can see: two panels overlapping, and
 * a tap on the overlap takes the one on top. `slack` is how far outside a
 * shape still counts -- a finger is wider than a thin line.
 */
export function shapeAt(shapes, point, slack = 0) {
  for (let at = shapes.length - 1; at >= 0; at -= 1) {
    if (covers(shapes[at], point, slack)) return at;
  }
  return -1;
}

function covers(shape, { x, y }, slack) {
  if (isPolygon(shape)) {
    if (inside(shape.points, x, y)) return true;
    const { points } = shape;
    return points.some((p, i) => toSegment(x, y, p, points[(i + 1) % points.length]) <= slack);
  }
  if (shape.type === 'box') {
    return x >= shape.x - slack && x <= shape.x + shape.w + slack
      && y >= shape.y - slack && y <= shape.y + shape.h + slack;
  }
  if (shape.type === 'oval') {
    const rx = shape.w / 2 + slack;
    const ry = shape.h / 2 + slack;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (x - (shape.x + shape.w / 2)) / rx;
    const dy = (y - (shape.y + shape.h / 2)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (shape.type === 'brush' && shape.points?.length) {
    const reach = shape.size / 2 + slack;
    const points = shape.points;
    if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= reach;
    for (let i = 1; i < points.length; i += 1) {
      if (toSegment(x, y, points[i - 1], points[i]) <= reach) return true;
    }
  }
  return false;
}

/** Whether a point is inside a polygon: count the edges a ray to the right crosses. */
function inside(points, x, y) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function toSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Whether two lists of shapes say the same thing, so an unchanged edit is not saved. */
export function sameShapes(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

/* ── the picture itself ──────────────────────────────────────────────── */

/**
 * What format a picture is saved back in.
 *
 * The one it came in, where a canvas can write it: a JPEG stays a JPEG, so a
 * photograph does not balloon into a PNG three times the size. A GIF or
 * anything unusual becomes a PNG, which loses nothing.
 */
export function outputType(blob) {
  const type = String(blob?.type || '').toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/webp') return 'image/webp';
  return 'image/png';
}

/** Whether a picture is too large to be held in a canvas on a phone. */
export function tooLarge(width, height) {
  return width * height > MAX_PIXELS || width > MAX_SIDE || height > MAX_SIDE;
}

function decode(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({
      width: image.naturalWidth,
      height: image.naturalHeight,
      source: image,
      close: () => URL.revokeObjectURL(url),
    });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be opened.')); };
    image.src = url;
  });
}

/**
 * The picture with the shapes painted into it.
 *
 * Painted at the picture's full size: the shapes are in its pixels, so
 * nothing is scaled and nothing is lost but what was covered.
 */
export async function bake(original, shapes) {
  const picture = await decode(original);
  const { width, height } = picture;
  try {
    if (!width || !height) throw new Error('That picture could not be opened.');
    if (tooLarge(width, height)) {
      throw new Error(`That picture is ${width}×${height} — too large for a phone to edit in one piece.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This phone would not make room to edit that picture.');

    ctx.drawImage(picture.source || picture, 0, 0, width, height);
    paintShapes(ctx, shapes);

    const type = outputType(original);
    const out = await new Promise((resolve) => {
      if (canvas.toBlob) canvas.toBlob(resolve, type, 0.92);
      else resolve(null);
    });
    if (!out || !out.size) throw new Error('The edited picture could not be written.');
    return out;
  } finally {
    picture.close?.();
  }
}

/* ── in the book ─────────────────────────────────────────────────────── */

/**
 * Paint the shapes into the book's copy of the picture.
 *
 * Always painted onto the original, never onto the last edit -- so shapes
 * can be moved or taken away and the result is what they say, not an edit of
 * an edit with the old black boxes still underneath.
 *
 * @param bakeWith  the painter, replaceable so the bookkeeping can be tested
 *                  where there is no canvas.
 */
export async function saveEdits(bookId, href, shapes, { bakeWith = bake } = {}) {
  const image = await store.get('images', [bookId, href]);
  if (!image) throw new Error('That picture is no longer in the book.');
  const original = image.original || image.blob;

  if (!shapes.length) return restoreOriginal(bookId, href);

  const blob = await bakeWith(original, shapes);
  const next = {
    ...image,
    blob,
    original,
    edits: shapes,
    editedAt: Date.now(),
    /* A blacked-out animation is one still frame: the canvas holds only the
       first. Marked as such, so the reel stops labelling it a GIF, and what
       it was is kept for when it is put back. */
    animated: false,
    wasAnimated: image.original ? image.wasAnimated : !!image.animated,
  };
  await store.put('images', next);
  await carryToCover(bookId, image, blob);
  return next;
}

/** Put the picture back as it was, and forget the shapes. */
export async function restoreOriginal(bookId, href) {
  const image = await store.get('images', [bookId, href]);
  if (!image) throw new Error('That picture is no longer in the book.');
  if (!image.original) return image;

  const { original, edits, editedAt, wasAnimated, ...rest } = image;
  const next = { ...rest, blob: original, animated: !!wasAnimated };
  await store.put('images', next);
  await carryToCover(bookId, image, original);
  return next;
}

/**
 * The cover is often one of the pictures, kept as a separate copy.
 *
 * A comic's cover is its first page, so blacking out something on page one
 * left it showing on the shelf. Where the cover is this very picture -- the
 * same bytes as its original, or as the edit being replaced -- and was not
 * picked by hand, it follows. An EPUB whose cover is a different picture is
 * left alone.
 */
async function carryToCover(bookId, image, blob) {
  const book = await store.get('books', bookId);
  if (!book || book.coverCustom || !book.coverBlob) return;
  const cover = book.coverBlob;
  const same = (candidate) => candidate && cover.size === candidate.size
    && (cover.type || '') === (candidate.type || '');
  if (!same(image.original) && !same(image.blob)) return;
  book.coverBlob = blob;
  book.coverBytes = blob?.size ?? null;
  await store.put('books', book);
}

/** Whether a picture has been edited, and so can be restored. */
export const isEdited = (image) => !!image?.original;
