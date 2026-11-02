/* Blacking out part of a picture.
 *
 * The promise this makes is that the edit is in the picture, not over it:
 * the book's own copy is replaced, so whatever is written out of the app
 * carries it. That, and that the original can always come back, are the
 * things proved here. jsdom has no canvas, so the painting is checked against
 * a context that records what it was told to draw -- the drawing code is the
 * same one the phone runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:stub/0';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

/* IndexedDB stores Blobs as they are. The fake one here clones with Node's
 * structuredClone, which turns a jsdom Blob into an empty object -- so every
 * picture read back would be nothing, and this file is about what is in the
 * pictures. Blobs are immutable; passing them through untouched is what a
 * browser's clone amounts to. */
const nodeClone = globalThis.structuredClone;
const keepBlobs = (value) => {
  if (value instanceof window.Blob) return value;
  if (Array.isArray(value)) return value.map(keepBlobs);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keepBlobs(v)]));
  }
  return nodeClone(value);
};
globalThis.structuredClone = keepBlobs;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('app/src/main/assets/www/index.html');
const css = read('app/src/main/assets/www/css/app.css');

const www = (file) => new URL(`../app/src/main/assets/www/js/${file}`, import.meta.url).href;
const store = await import(www('store.js'));
const redact = await import(www('redact.js'));
const epub = await import(www('epub.js'));
const build = await import(www('build.js'));

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

const el = (id) => document.getElementById(id);
const tap = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const blobs = await import(www('blobs.js'));
const text = async (blob) => new TextDecoder().decode(await blobs.readArrayBuffer(blob));

/* A 2D context that writes down what it is asked to do. */
function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); };
    },
    set(target, key, value) {
      calls.push([`${String(key)}=`, value]);
      target[key] = value;
      return true;
    },
  });
  return { ctx, calls };
}

/* The canvas the painter uses, faked: decode, draw, encode. What comes out is
 * a blob that names the shapes painted into it, so a test can see they got
 * there. */
let painted = [];
globalThis.createImageBitmap = window.createImageBitmap = async (blob) => ({
  width: 400, height: 600, close() {}, from: blob,
});
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const { ctx, calls } = recorder();
  this.calls = calls;
  painted.push(calls);
  return ctx;
};
window.HTMLCanvasElement.prototype.toBlob = function toBlob(done, type) {
  const fills = this.calls.filter((c) => c[0] === 'fillRect' || c[0] === 'fill');
  setTimeout(() => done(new window.Blob([`painted:${this.width}x${this.height}:${fills.length}`], { type })), 0);
};

let seed = 0;

/** A comic of a few pages, the first of which is also its cover. */
async function comic(pages = 3, { type = 'image/jpeg', ext = 'jpg' } = {}) {
  const first = new window.Blob([`page-1-original-bytes`], { type });
  const id = await store.add('books', {
    title: `Comic ${++seed}`, fingerprint: `redact:${seed}`, addedAt: seed,
    chapters: 1, coverBlob: first,
  });
  const markup = [];
  for (let i = 0; i < pages; i++) {
    const href = `p${i + 1}.${ext}`;
    markup.push(`<img data-img="${href}" alt=""/>`);
    await store.put('images', {
      bookId: id, href, order: i, chapterIndex: 0,
      blob: i === 0 ? first : new window.Blob([`page-${i + 1}`], { type }),
      width: 400, height: 600,
    });
  }
  await store.put('chapters', { bookId: id, index: 0, title: 'One', words: 0, html: markup.join('') });
  return id;
}

const Q = (...points) => redact.poly(points);

const fakeBake = async (original, shapes) =>
  new window.Blob([`baked:${shapes.length}`], { type: original.type || 'image/png' });

/* ── shapes ──────────────────────────────────────────────────────────── */

console.log('shapes');

await t('a shape is its points, in the order they were tapped, however many', () => {
  // Three spaced unevenly: an uneven triangle.
  const triangle = Q([10, 10], [200, 40], [60, 150]);
  assert.deepEqual(triangle, { type: 'poly', colour: 'black', points: [[10, 10], [200, 40], [60, 150]] });
  // Six: a six-sided shape with exactly those six points.
  const six = Q([0, 0], [50, -0], [90, 30], [80, 90], [20, 100], [-0, 40]);
  assert.equal(six.points.length, 6);
  // Traced round an L, it keeps its dent: the order is the outline.
  const ell = Q([0, 0], [40, 0], [40, 60], [100, 60], [100, 100], [0, 100]);
  assert.deepEqual(ell.points[2], [40, 60]);
});

await t('fewer than three points, or points on top of each other, are not a shape', () => {
  assert.ok(redact.isTiny(Q([0, 0], [50, 50])));
  assert.ok(redact.isTiny(Q([5, 5], [6, 5], [6, 6], [5, 6])));
  assert.ok(!redact.isTiny(Q([0, 0], [60, 0], [30, 40])));
  assert.equal(redact.area([[0, 0], [60, 0], [60, 40], [0, 40]]), 2400);
});

await t('boxes and four-cornered panels saved by earlier versions open as shapes', () => {
  const [box] = redact.normalise([{ type: 'box', colour: 'white', x: 10, y: 20, w: 30, h: 40 }]);
  assert.deepEqual(box, { type: 'poly', colour: 'white', points: [[10, 20], [40, 20], [40, 60], [10, 60]] });
  const [panel] = redact.normalise([{ type: 'quad', colour: 'black', points: [[0, 0], [9, 0], [9, 9], [0, 9]] }]);
  assert.equal(panel.type, 'poly');
  assert.deepEqual(panel.points, [[0, 0], [9, 0], [9, 9], [0, 9]]);
  // And still paint.
  const { ctx, calls } = recorder();
  redact.paintShapes(ctx, [{ type: 'quad', colour: 'black', points: [[0, 0], [9, 0], [9, 9], [0, 9]] }]);
  assert.ok(calls.some((c) => c[0] === 'fill'));
});

await t('a point on the screen lands on the same place in the picture at any zoom', () => {
  const picture = { width: 2000, height: 3000 };
  // Shown at 400×600 from (10, 50): the middle of the screen box is the
  // middle of the picture.
  const shown = { left: 10, top: 50, width: 400, height: 600 };
  assert.deepEqual(redact.toPicture(210, 350, shown, picture.width, picture.height), { x: 1000, y: 1500 });
  // Zoomed in three times and scrolled: still the picture's own pixels.
  const zoomed = { left: -300, top: -800, width: 1200, height: 1800 };
  assert.deepEqual(redact.toPicture(300, 100, zoomed, picture.width, picture.height), { x: 1000, y: 1500 });
  // A drag that runs off the edge stops at the edge.
  assert.deepEqual(redact.toPicture(-50, 9999, shown, picture.width, picture.height), { x: 0, y: 3000 });
});

await t('a point, the middle of an edge, or nothing is under the finger', () => {
  const panel = Q([0, 0], [100, 0], [100, 100], [0, 100]);
  assert.deepEqual(redact.handleAt(panel, { x: 96, y: 4 }, 10), { kind: 'corner', at: 1 });
  assert.deepEqual(redact.handleAt(panel, { x: 100, y: 52 }, 10), { kind: 'edge', at: 1 });
  assert.deepEqual(redact.handleAt(panel, { x: 50, y: 97 }, 10), { kind: 'edge', at: 2 });
  assert.equal(redact.handleAt(panel, { x: 50, y: 50 }, 10), null);
  // On a panel so small the two overlap, the corner wins.
  const small = Q([0, 0], [12, 0], [12, 12], [0, 12]);
  assert.equal(redact.handleAt(small, { x: 3, y: 1 }, 10).kind, 'corner');
});

await t('a point goes where it is dragged; an edge moves as a whole and keeps its angle', () => {
  const panel = Q([0, 0], [100, 10], [100, 110], [0, 100]);
  const corner = redact.moveHandle(panel, { kind: 'corner', at: 2 }, { x: 100, y: 110 }, { x: 130, y: 140 }, 400, 600);
  assert.deepEqual(corner.points, [[0, 0], [100, 10], [130, 140], [0, 100]]);

  // The right edge, out by 20: both its corners, the left ones untouched.
  const edge = redact.moveHandle(panel, { kind: 'edge', at: 1 }, { x: 100, y: 60 }, { x: 120, y: 60 }, 400, 600);
  assert.deepEqual(edge.points, [[0, 0], [120, 10], [120, 110], [0, 100]]);

  const whole = redact.moveHandle(panel, { kind: 'whole' }, { x: 50, y: 50 }, { x: 60, y: 70 }, 400, 600);
  assert.deepEqual(whole.points, [[10, 20], [110, 30], [110, 130], [10, 120]]);

  // Nothing leaves the picture, and a panel pushed against its edge keeps
  // its shape rather than being squashed.
  const pushed = redact.moveHandle(panel, { kind: 'whole' }, { x: 50, y: 50 }, { x: 0, y: 0 }, 400, 600);
  assert.deepEqual(pushed.points, panel.points);
  const far = redact.moveHandle(panel, { kind: 'corner', at: 0 }, { x: 0, y: 0 }, { x: -40, y: 900 }, 400, 600);
  assert.deepEqual(far.points[0], [0, 600]);
});

await t('a shape is painted through its points, in its colour, in the picture\'s own pixels', () => {
  const { ctx, calls } = recorder();
  redact.paintShapes(ctx, [
    Q([10, 20], [90, 25], [85, 70], [12, 66]),
    { ...Q([0, 0], [5, 0], [5, 5], [0, 5]), colour: 'white' },
  ]);
  assert.deepEqual(calls.find((c) => c[0] === 'moveTo'), ['moveTo', 10, 20]);
  assert.deepEqual(calls.filter((c) => c[0] === 'lineTo').slice(0, 3).map((c) => c.slice(1)),
    [[90, 25], [85, 70], [12, 66]]);
  assert.ok(calls.some((c) => c[0] === 'closePath'));
  assert.ok(calls.some((c) => c[0] === 'fill'));
  assert.ok(calls.some((c) => c[0] === 'fillStyle=' && c[1] === '#ffffff'), 'white was never used');

  // Six points: five lines from the first, then closed.
  const six = recorder();
  redact.paintShapes(six.ctx, [Q([0, 0], [50, 0], [90, 30], [80, 90], [20, 100], [0, 40])]);
  assert.equal(six.calls.filter((c) => c[0] === 'lineTo').length, 5);
  assert.ok(six.calls.some((c) => c[0] === 'closePath'));
});

await t('what is drawn while editing is what is painted on save', () => {
  assert.match(redact.svgFor(Q([1, 2], [30, 2], [30, 40], [1, 40])),
    /<polygon points="1,2 30,2 30,40 1,40" fill="#000000"\/>/);
});

await t('pressing inside a shape finds it -- the one on top where two overlap', () => {
  const shapes = [
    Q([0, 0], [100, 0], [100, 100], [0, 100]),
    Q([40, 40], [60, 40], [60, 60], [40, 60]),
    // A slanted one: its bounding box is not the panel.
    Q([200, 0], [300, 0], [250, 100], [200, 100]),
  ];
  assert.equal(redact.shapeAt(shapes, { x: 50, y: 50 }), 1, 'not the topmost');
  assert.equal(redact.shapeAt(shapes, { x: 5, y: 5 }), 0);
  assert.equal(redact.shapeAt(shapes, { x: 210, y: 50 }), 2);
  assert.equal(redact.shapeAt(shapes, { x: 290, y: 90 }), -1, 'the slant was ignored');
  assert.equal(redact.shapeAt(shapes, { x: 500, y: 500 }), -1);
});

await t('a JPEG stays a JPEG; a GIF becomes a still PNG', () => {
  assert.equal(redact.outputType(new window.Blob([], { type: 'image/jpeg' })), 'image/jpeg');
  assert.equal(redact.outputType(new window.Blob([], { type: 'image/webp' })), 'image/webp');
  assert.equal(redact.outputType(new window.Blob([], { type: 'image/gif' })), 'image/png');
  assert.equal(redact.outputType(new window.Blob([])), 'image/png');
});

await t('a picture too big for a phone canvas is refused before one is made', () => {
  assert.ok(!redact.tooLarge(1200, 1800));
  assert.ok(!redact.tooLarge(800, 30000));
  assert.ok(redact.tooLarge(800, 40000), 'taller than a canvas can be');
  assert.ok(redact.tooLarge(6000, 6000), 'more pixels than a phone should be asked to hold');
});

await t('the painter draws the picture at full size, then the shapes over it', async () => {
  painted = [];
  const out = await redact.bake(new window.Blob(['x'], { type: 'image/jpeg' }), [
    Q([1, 1], [51, 1], [51, 51], [1, 51]),
  ]);
  const calls = painted[0];
  const draw = calls.findIndex((c) => c[0] === 'drawImage');
  const fill = calls.findIndex((c) => c[0] === 'fill');
  assert.ok(draw >= 0 && fill > draw, 'the shapes were not painted over the picture');
  assert.deepEqual(calls[draw].slice(2), [0, 0, 400, 600]);
  assert.equal(out.type, 'image/jpeg');
  assert.match(await text(out), /^painted:400x600:1$/);
});

/* ── in the book ─────────────────────────────────────────────────────── */

console.log('\nin the book');

await t('saving replaces the book\'s copy and keeps the original beside it', async () => {
  const id = await comic();
  const before = await store.get('images', [id, 'p2.jpg']);
  const shapes = [Q([0, 0], [40, 0], [40, 40], [0, 40])];
  await redact.saveEdits(id, 'p2.jpg', shapes, { bakeWith: fakeBake });

  const after = await store.get('images', [id, 'p2.jpg']);
  assert.equal(await text(after.blob), 'baked:1');
  assert.equal(await text(after.original), await text(before.blob));
  assert.deepEqual(after.edits, shapes);
  assert.ok(redact.isEdited(after));
  // Nothing else about the page moved.
  assert.equal(after.order, before.order);
  assert.equal(after.chapterIndex, before.chapterIndex);
});

await t('editing again starts from the original, not from the last edit', async () => {
  const id = await comic();
  let seen = null;
  const watching = async (original, shapes) => { seen = await text(original); return fakeBake(original, shapes); };
  await redact.saveEdits(id, 'p3.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: watching });
  await redact.saveEdits(id, 'p3.jpg', [{ ...Q([2, 2], [9, 2], [9, 9], [2, 9]), colour: 'white' }], { bakeWith: watching });
  assert.equal(seen, 'page-3', 'the second edit was painted onto the first');
  const image = await store.get('images', [id, 'p3.jpg']);
  assert.equal(image.edits.length, 1);
  assert.equal(image.edits[0].colour, 'white');
});

await t('the original can always be put back', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p2.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  await redact.restoreOriginal(id, 'p2.jpg');
  const image = await store.get('images', [id, 'p2.jpg']);
  assert.equal(await text(image.blob), 'page-2');
  assert.ok(!redact.isEdited(image));
  assert.equal(image.edits, undefined);

  // Clearing every shape and saving is the same thing.
  await redact.saveEdits(id, 'p2.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  await redact.saveEdits(id, 'p2.jpg', [], { bakeWith: fakeBake });
  assert.equal(await text((await store.get('images', [id, 'p2.jpg'])).blob), 'page-2');
});

await t('a cover that is the edited page follows it; one picked by hand does not', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p1.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  let book = await store.get('books', id);
  assert.equal(await text(book.coverBlob), 'baked:1', 'the shelf still shows what was blacked out');

  await redact.restoreOriginal(id, 'p1.jpg');
  book = await store.get('books', id);
  assert.equal(await text(book.coverBlob), 'page-1-original-bytes');

  const chosen = await comic();
  const picked = await store.get('books', chosen);
  picked.coverCustom = true;
  await store.put('books', picked);
  await redact.saveEdits(chosen, 'p1.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  assert.equal(await text((await store.get('books', chosen)).coverBlob), 'page-1-original-bytes',
    'a cover chosen by hand was replaced');

  // And a different picture's edit leaves the cover alone.
  const other = await comic();
  await redact.saveEdits(other, 'p2.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  assert.equal(await text((await store.get('books', other)).coverBlob), 'page-1-original-bytes');
});

await t('a blacked-out animation is marked still, and moves again when put back', async () => {
  const id = await comic(2, { type: 'image/gif', ext: 'gif' });
  const row = await store.get('images', [id, 'p2.gif']);
  row.animated = true;
  await store.put('images', row);
  await redact.saveEdits(id, 'p2.gif', [Q([0, 0], [9, 0], [9, 9], [0, 9])],
    { bakeWith: async (o, s) => new window.Blob([`baked:${s.length}`], { type: 'image/png' }) });
  assert.equal((await store.get('images', [id, 'p2.gif'])).animated, false);
  await redact.restoreOriginal(id, 'p2.gif');
  assert.equal((await store.get('images', [id, 'p2.gif'])).animated, true);
});

/* ── on the way out ──────────────────────────────────────────────────── */

console.log('\non the way out');

const JSZip = (await import('jszip')).default;

await t('an exported EPUB carries the edited picture, not the original', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p2.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  const out = await epub.buildEpub(id);
  const blob = out?.blob || out;
  const zip = await JSZip.loadAsync(await blobs.readArrayBuffer(blob));
  const pictures = await Promise.all(Object.keys(zip.files)
    .filter((name) => /OEBPS\/images\/./.test(name) && !zip.files[name].dir)
    .map((name) => zip.file(name).async('string')));
  assert.ok(pictures.includes('baked:1'), `the edit did not leave the app: ${pictures.join(' | ')}`);
  assert.ok(!pictures.includes('page-2'), 'the original went out with it');
});

await t('every chapter written out is XHTML a strict reader will open', async () => {
  /* Chapters are kept as HTML, where "<br>" closes nothing, and were written
   * into the .xhtml files as they were: Not A Regressor went out with 442
   * unclosed line breaks, which is not XML at all. */
  const id = await store.add('books', { title: 'Breaks', fingerprint: `breaks:${++seed}`, addedAt: seed, chapters: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'One & Two', words: 6,
    html: '<p>Chapter 1 <br>Regression</p><hr><p>Fish &amp; chips&nbsp;here, 1 < 2</p>',
  });
  const out = await epub.buildEpub(id);
  const zip = await JSZip.loadAsync(await blobs.readArrayBuffer(out.blob || out));
  const name = Object.keys(zip.files).find((n) => /text\/ch0001\.xhtml$/.test(n));
  const xhtml = await zip.file(name).async('string');
  const doc = new window.DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, `not well-formed: ${xhtml}`);
  assert.match(xhtml, /<br\s*\/>/);
  assert.ok(!/<br>/.test(xhtml) && !/<hr>/.test(xhtml));
  // Declared once, on <html>, not on every paragraph.
  assert.equal((xhtml.match(/xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g) || []).length, 1);
  assert.match(doc.body?.textContent || doc.documentElement.textContent, /Fish & chips/);
});

await t('an edited GIF is written out as the PNG it now is', async () => {
  assert.equal(epub.extensionFor(new window.Blob([], { type: 'image/png' }), 'p2.gif'), 'png');
  assert.equal(epub.extensionFor(new window.Blob([], { type: 'image/jpeg' }), 'p2.jpeg'), 'jpg');
  // A picture that does not say what it is keeps the name it came with.
  assert.equal(epub.extensionFor(new window.Blob([]), 'p2.webp'), 'webp');
});

await t('a book built onto another takes its pictures as they are now', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p3.jpg', [Q([0, 0], [9, 0], [9, 9], [0, 9])], { bakeWith: fakeBake });
  const source = read('app/src/main/assets/www/js/build.js');
  assert.match(source, /blob: image\.blob,/, 'build copies something other than the current picture');
  assert.ok(typeof build.readShelfBook === 'function' || /readShelfBook/.test(source));
});

await t('the outline never crosses itself, and a shape traced in order keeps its order', () => {
  // Four dots round a small panel, placed top left, top right, bottom left,
  // bottom right: joined as placed, a bow tie. Joined to fit, the panel.
  const bowTie = [[100, 100], [101, 100], [100, 101], [101, 101]];
  assert.ok(redact.crosses(bowTie));
  assert.deepEqual(redact.outline(bowTie), [[100, 100], [101, 100], [101, 101], [100, 101]]);
  assert.deepEqual(redact.poly(bowTie).points, [[100, 100], [101, 100], [101, 101], [100, 101]]);
  // Traced round the edge, dents and notches are kept exactly as placed.
  for (const traced of [
    [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100]],
    [[0, 0], [30, 0], [30, 70], [70, 70], [70, 0], [100, 0], [100, 100], [0, 100]],
    [[50, 0], [60, 35], [100, 40], [70, 60], [80, 100], [50, 75], [20, 100], [30, 60], [0, 40], [40, 35]],
  ]) {
    assert.deepEqual(redact.outline(traced), traced);
  }
  // Placed any old how, it still comes out uncrossed.
  for (let seed = 1; seed < 40; seed++) {
    let x = seed * 9301 % 233280;
    const next = () => { x = (x * 9301 + 49297) % 233280; return Math.round((x / 233280) * 200); };
    const points = Array.from({ length: 4 + (seed % 7) }, () => [next(), next()]);
    const shape = redact.outline(points);
    assert.equal(shape.length, points.length, 'a point was lost');
    assert.ok(!redact.crosses(shape), `crossed: ${JSON.stringify(points)}`);
  }
});

/* ── the editor ──────────────────────────────────────────────────────── */

console.log('\nthe editor');

await t('the editor draws shapes, does not scroll while drawing, and stays light on black', () => {
  assert.match(html, /id="redact"[^>]*hidden/);
  assert.match(html, /data-tool="panel"[^>]*>Draw shapes/);
  assert.match(html, /id="redact-confirm"[^>]*>Black out shape/);
  assert.match(html, /data-tool="move"/);
  // The first version's drag-a-box, oval, brush and eraser are gone.
  for (const tool of ['box', 'oval', 'brush', 'erase']) {
    assert.ok(!new RegExp(`data-tool="${tool}"`).test(html), `the ${tool} tool is still there`);
  }
  assert.match(html, /id="redact-delete"[^>]*>Delete shape/);
  assert.match(html, /id="redact-loupe"/);
  assert.match(css, /#redact-svg \{[^}]*touch-action: none/);
  /* Nothing under the picture changes height while a shape is drawn: the
   * picture is fitted to what is left, so a row appearing after the first
   * tap -- or a hint wrapping to another line -- moved it, and every later
   * point landed somewhere other than where it was tapped. The app's
   * [hidden] rule takes things out of the layout, so the shape row must not
   * use it. */
  assert.ok(!/id="redact-shape"[^>]*hidden/.test(html), 'the shape row leaves the layout when idle');
  assert.match(css, /\.redact-shape\.idle \{ visibility: hidden; \}/);
  assert.match(css, /\.redact-hint \{[^}]*height: calc\(4px \+ 3 \* 1\.45em\)/);
  assert.match(css, /\.redact\[data-tool="move"\] #redact-svg \{ pointer-events: none; \}/);
  // Nothing in it loops.
  const block = css.slice(css.indexOf('blacking out part of a picture'));
  assert.ok(!/animation:|infinite/.test(block.slice(0, block.indexOf('.viewer .viewer-bar'))));
});

const pointer = (type, x, y, id = 1) => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  return event;
};
const press = (svg, x, y) => {
  svg.dispatchEvent(pointer('pointerdown', x, y));
  svg.dispatchEvent(pointer('pointerup', x, y));
};
const drag = (svg, from, to) => {
  svg.dispatchEvent(pointer('pointerdown', ...from));
  svg.dispatchEvent(pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  svg.dispatchEvent(pointer('pointermove', ...to));
  svg.dispatchEvent(pointer('pointerup', ...to));
};
const panels = () => el('redact-svg').querySelectorAll('polygon.panel');

await t('from the reel: tap out a triangle and a hexagon, fit them, save, and the book has them', async () => {
  await import(www('app.js'));
  const reader = await import(www('reader.js'));

  const id = await comic(3);
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'folders'));
  await settle();
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(300);
  tap(document.querySelector(`[data-book="${id}"]`));
  await settle(500);
  assert.equal(reader.state.book?.id, id);

  tap(document.querySelector('[data-go="reel"]'));
  await settle(300);
  const figure = [...document.querySelectorAll('#reel-grid img')][1];
  assert.ok(figure, 'the reel has no pictures');
  tap(figure);
  const blackOut = document.querySelector('.viewer [data-redact]');
  assert.ok(blackOut, 'the full-size viewer has no way to black anything out');
  tap(blackOut);
  await settle(100);

  assert.equal(document.querySelector('.viewer'), null, 'the viewer stayed open under the editor');
  assert.equal(el('redact').hidden, false, 'the editor never opened');
  assert.match(el('redact-hint').textContent, /as many as the shape needs/);

  // Shown at 200×300: half the picture's own size.
  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 300, right: 200, bottom: 300 });

  // A triangle, spaced unevenly.
  press(svg, 10, 20);
  assert.equal(svg.querySelectorAll('circle.placed').length, 1);
  assert.equal(el('redact-shape').classList.contains('idle'), false, 'nothing says a shape is being drawn');
  assert.equal(el('redact-confirm').disabled, true, 'one point can be filled in');
  // A second finger landing while a point is aimed moves the picture: the
  // point is let go of, and nothing is placed by either finger.
  svg.dispatchEvent(pointer('pointerdown', 150, 30));
  svg.dispatchEvent(pointer('pointerdown', 150, 150, 2));
  svg.dispatchEvent(pointer('pointerup', 150, 30));
  svg.dispatchEvent(pointer('pointerup', 150, 150, 2));
  assert.equal(svg.querySelectorAll('circle.placed').length, 1, 'two fingers placed a point');
  press(svg, 150, 30);
  assert.equal(svg.querySelectorAll('circle.placed').length, 2);
  assert.equal(el('redact-confirm').disabled, true, 'two points can be filled in');
  press(svg, 40, 120);
  assert.equal(el('redact-confirm').disabled, false);
  assert.ok(svg.querySelector('polygon.preview'), 'no preview of what it will cover');
  assert.match(el('redact-shape-count').textContent, /3 points/);
  assert.equal(panels().length, 0, 'filled in before it was confirmed');
  tap(el('redact-confirm'));

  assert.equal(panels().length, 1, 'confirming did not fill the shape');
  assert.equal(el('redact-shape').classList.contains('idle'), true);
  assert.equal(svg.querySelectorAll('circle.corner').length, 3, 'the new shape has no points to adjust');
  assert.equal(svg.querySelectorAll('circle.edge').length, 3, 'the new shape has no edges to adjust');
  assert.match(el('redact-caption').textContent, /1 shape/);
  assert.equal(el('redact-delete').disabled, false);

  // A six-sided one. A point lands wherever the finger lets go, however
  // near another: pressed right beside the first point, it is a seventh
  // point, not the shape closing or the first point moving.
  for (const [x, y] of [[120, 160], [170, 165], [190, 200], [175, 260], [130, 270], [110, 220]]) press(svg, x, y);
  assert.match(el('redact-shape-count').textContent, /6 points/);
  press(svg, 121, 161);
  assert.match(el('redact-shape-count').textContent, /7 points/, 'a point close to another was not placed');
  assert.equal(panels().length, 1);
  // Undo takes it back, Redo puts it back, Undo again.
  tap(el('redact-undo'));
  assert.match(el('redact-shape-count').textContent, /6 points/);
  tap(el('redact-redo'));
  assert.match(el('redact-shape-count').textContent, /7 points/, 'Redo did not put the point back');
  tap(el('redact-undo'));
  tap(el('redact-confirm'));
  assert.equal(panels().length, 2, 'Black out shape did not fill it');

  // A corner dragged off the picture and let go there stays on its edge,
  // and the editor goes on working; Undo puts it back.
  svg.dispatchEvent(pointer('pointerdown', 40, 120));
  document.body.dispatchEvent(pointer('pointermove', -60, 140));
  document.body.dispatchEvent(pointer('pointerup', -60, 140));
  assert.match(panels()[0].getAttribute('points'), /^20,40 300,60 0,280$/, 'the corner did not hold at the edge');
  tap(el('redact-undo'));
  assert.match(panels()[0].getAttribute('points'), /^20,40 300,60 80,240$/);

  // The triangle's last point, out a little; then its first edge, down.
  drag(svg, [40, 120], [50, 130]);
  drag(svg, [80, 25], [80, 31]);
  // Undo takes back the edge, as one step however many moves it took.
  tap(el('redact-undo'));
  tap(el('redact-redo'));

  tap(el('redact-save'));
  await settle(300);
  assert.equal(el('redact').hidden, true, 'the editor did not close after saving');

  const image = await store.get('images', [id, 'p2.jpg']);
  assert.deepEqual(image.edits, [
    { type: 'poly', colour: 'black', points: [[20, 52], [300, 72], [100, 260]] },
    { type: 'poly', colour: 'black', points: [[240, 320], [340, 330], [380, 400], [350, 520], [260, 540], [220, 440]] },
  ], 'the shapes were not saved in the picture\'s own pixels, or as adjusted');
  assert.match(await text(image.blob), /^painted:400x600:2$/);
  assert.equal(await text(image.original), 'page-2');
  assert.equal(reader.state.images.get('p2.jpg'), image.blob, 'the open book still shows the old picture');
  assert.match(el('toast').textContent, /Blacked out/);
});

await t('a shape is chosen by pressing inside it, recoloured, deleted; points can be undone', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  tap(document.querySelectorAll('#reel-grid img')[1]);
  tap(document.querySelector('.viewer [data-redact]'));
  await settle(100);

  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 });
  // The saved shapes come back to be changed.
  assert.equal(panels().length, 2, 'the earlier edit was not reopened');
  assert.equal(el('redact-restore').hidden, false, 'an edited picture offers no way back');
  assert.equal(el('redact-delete').disabled, true, 'something is chosen before anything was pressed');

  press(svg, 100, 150);
  assert.equal(el('redact-delete').disabled, false, 'pressing inside did not choose the panel');
  tap(el('redact-colour').querySelector('[data-colour="white"]'));
  assert.match(panels()[0].getAttribute('fill'), /#ffffff/i, 'the chosen panel kept its colour');
  tap(el('redact-undo'));
  assert.match(panels()[0].getAttribute('fill'), /#000000/);

  press(svg, 100, 150);
  tap(el('redact-delete'));
  assert.equal(panels().length, 1, 'Delete shape left it there');

  // Two points of a new one; Undo takes the last point, not a shape.
  press(svg, 20, 560);
  press(svg, 380, 580);
  tap(el('redact-undo'));
  assert.equal(svg.querySelectorAll('circle.placed').length, 1);
  assert.equal(panels().length, 1);

  // Saving with one point is not a shape, and says so rather than guessing.
  tap(el('redact-save'));
  await settle(50);
  assert.equal(el('redact').hidden, false, 'saved a shape of one point');
  assert.match(el('redact-hint').textContent, /only 1 point/);
  tap(el('redact-shape-cancel'));
  assert.equal(svg.querySelectorAll('circle.placed').length, 0);
  press(svg, 20, 560);

  // Moving does not mark.
  tap(el('redact-tool').querySelector('[data-tool="move"]'));
  press(svg, 50, 50);
  assert.equal(svg.querySelectorAll('circle.placed').length, 1);

  // Cancel with something changed asks first; back closes the question first.
  tap(el('redact-cancel'));
  assert.equal(el('redact-leave').hidden, false, 'unsaved changes were thrown away without asking');
  assert.equal(window.Grimoire.onBack(), true);
  assert.equal(el('redact-leave').hidden, true);
  assert.equal(el('redact').hidden, false);
  tap(el('redact-cancel'));
  tap(el('redact-leave-yes'));
  assert.equal(el('redact').hidden, true);

  const image = await store.get('images', [id, 'p2.jpg']);
  assert.equal(image.edits.length, 2, 'leaving without saving changed the book');
  assert.equal(image.edits[0].colour, 'black');
});

await t('restore from the editor puts the page back as it was', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  tap(document.querySelectorAll('#reel-grid img')[1]);
  tap(document.querySelector('.viewer [data-redact]'));
  await settle(100);
  tap(el('redact-restore'));
  await settle(200);
  assert.equal(el('redact').hidden, true);
  const image = await store.get('images', [id, 'p2.jpg']);
  assert.equal(await text(image.blob), 'page-2');
  assert.ok(!redact.isEdited(image));
  assert.equal(await text(reader.state.images.get('p2.jpg')), 'page-2');
});

await t('nothing drawn, nothing saved', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  const before = await store.get('images', [id, 'p3.jpg']);
  tap(document.querySelectorAll('#reel-grid img')[2]);
  tap(document.querySelector('.viewer [data-redact]'));
  await settle(100);
  tap(el('redact-save'));
  await settle(100);
  assert.equal(el('redact').hidden, true);
  const after = await store.get('images', [id, 'p3.jpg']);
  assert.ok(!redact.isEdited(after), 'an empty edit was saved');
  assert.equal(await text(after.blob), await text(before.blob));
});

await t('a point lands where the finger lifts, and every step undoes and redoes', async () => {
  const reader = await import(www('reader.js'));
  tap(document.querySelectorAll('#reel-grid img')[2]);
  tap(document.querySelector('.viewer [data-redact]'));
  await settle(100);
  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 });
  // The loupe is placed against the frame the picture is drawn in.
  el('redact-frame').getBoundingClientRect = svg.getBoundingClientRect;
  el('redact-stage').getBoundingClientRect = svg.getBoundingClientRect;
  const placed = () => [...svg.querySelectorAll('circle.placed')].map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);

  // Pressed at one place, slid while the loupe shows where it is, let go
  // at another: the point is where it was let go.
  svg.dispatchEvent(pointer('pointerdown', 100, 100));
  assert.equal(el('redact-loupe').hidden, false, 'no loupe to aim with');
  assert.ok(svg.querySelector('.aim'), 'nothing shows where the point will land');
  assert.deepEqual(placed(), [], 'the point was placed on pressing, not on letting go');
  svg.dispatchEvent(pointer('pointermove', 104, 103));
  svg.dispatchEvent(pointer('pointermove', 110, 105));
  svg.dispatchEvent(pointer('pointerup', 110, 105));
  assert.deepEqual(placed(), [[110, 105]]);
  assert.equal(el('redact-loupe').hidden, true);
  // And one a pixel away is another point, not the first moved.
  press(svg, 111, 105);
  assert.deepEqual(placed(), [[110, 105], [111, 105]]);
  // Carried off the picture -- past its corner, to see along its edge -- the
  // point holds at the edge, and letting go out there still lets go.
  svg.dispatchEvent(pointer('pointerdown', 300, 300));
  document.body.dispatchEvent(pointer('pointermove', -80, 650));
  document.body.dispatchEvent(pointer('pointermove', -120, 900));
  assert.equal(el('redact-loupe').hidden, false, 'the loupe went when the finger left the picture');
  document.body.dispatchEvent(pointer('pointerup', -120, 900));
  assert.deepEqual(placed().at(-1), [0, 600], 'the point left the picture');
  press(svg, 50, 50);
  assert.equal(placed().length, 4, 'after a finger let go off the picture, nothing more could be marked');
  tap(el('redact-undo'));
  tap(el('redact-undo'));
  // A cancelled touch places nothing.
  svg.dispatchEvent(pointer('pointerdown', 200, 200));
  svg.dispatchEvent(pointer('pointercancel', 200, 200));
  assert.equal(placed().length, 2);

  // Zoomed in, two fingers move the picture in any tool -- and a corner the
  // first finger had hold of is let go as it was.
  const stage = el('redact-stage');
  let scrolled = { left: 0, top: 0 };
  Object.defineProperty(stage, 'scrollLeft', { configurable: true, get: () => scrolled.left, set: (v) => { scrolled.left = v; } });
  Object.defineProperty(stage, 'scrollTop', { configurable: true, get: () => scrolled.top, set: (v) => { scrolled.top = v; } });
  scrolled = { left: 300, top: 400 };
  const before = placed();
  svg.dispatchEvent(pointer('pointerdown', 200, 200, 5));
  svg.dispatchEvent(pointer('pointermove', 205, 204, 5));
  svg.dispatchEvent(pointer('pointerdown', 260, 200, 6));
  assert.equal(el('redact-loupe').hidden, true, 'the first finger was still aiming');
  document.body.dispatchEvent(pointer('pointermove', 180, 160, 5));
  document.body.dispatchEvent(pointer('pointermove', 240, 160, 6));
  // The middle went from (232.5, 202) to (210, 160): the picture follows it.
  assert.deepEqual(scrolled, { left: 322.5, top: 442 }, 'the picture did not follow the fingers');
  document.body.dispatchEvent(pointer('pointerup', 240, 160, 6));
  document.body.dispatchEvent(pointer('pointermove', 100, 100, 5));
  document.body.dispatchEvent(pointer('pointerup', 100, 100, 5));
  assert.deepEqual(placed(), before, 'moving the picture placed a point');
  assert.deepEqual(scrolled, { left: 322.5, top: 442 }, 'the finger left behind moved the picture');
  delete stage.scrollLeft;
  delete stage.scrollTop;
  tap(el('redact-undo'));
  assert.deepEqual(placed(), [[110, 105]]);
  tap(el('redact-redo'));
  assert.deepEqual(placed(), [[110, 105], [111, 105]]);
  // Cancel shape is a step too.
  tap(el('redact-shape-cancel'));
  assert.equal(placed().length, 0);
  tap(el('redact-undo'));
  assert.equal(placed().length, 2, 'Cancel shape could not be undone');
  tap(el('redact-shape-cancel'));
  assert.equal(el('redact-redo').disabled, true, 'something undone is still offered after a new step');
  void reader;
});

await t('text is typed onto the picture, as small as a bubble needs, moved, undone and saved', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  const svg = el('redact-svg');
  const letters = () => [...svg.querySelectorAll('.lettering text')].map((n) => n.textContent);
  assert.match(html, /data-tool="text"[^>]*>Text</);

  tap(el('redact-tool').querySelector('[data-tool="text"]'));
  assert.match(el('redact-hint').textContent, /Tap where the text goes/);
  press(svg, 200, 300);
  assert.equal(el('redact-text').hidden, false, 'nothing to type into');
  const input = el('redact-text-input');
  input.value = 'HELLO\nYOU';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(letters(), ['HELLO', 'YOU'], 'the text is not on the picture as typed, line for line');
  // Down to the smallest there is, for the narrowest bubble.
  for (let i = 0; i < 80; i++) tap(el('redact-text-smaller'));
  assert.equal(el('redact-text-size-n').textContent, '4px');
  assert.equal(svg.querySelector('.lettering').getAttribute('font-size'), '4');
  tap(el('redact-text-larger'));
  assert.equal(el('redact-text-size-n').textContent, '4.5px', 'small text does not step finely');
  tap(el('redact-text-smaller'));
  tap(el('redact-text-done'));
  assert.equal(el('redact-text').hidden, true);
  assert.deepEqual(letters(), ['HELLO', 'YOU']);

  // Tapped again, it opens to be changed; dragged, it moves.
  press(svg, 200, 300);
  assert.equal(el('redact-text').hidden, false, 'tapping the text did not open it');
  assert.equal(input.value, 'HELLO\nYOU');
  drag(svg, [200, 300], [220, 310]);
  tap(el('redact-text-done'));
  const moved = svg.querySelector('.lettering text');
  assert.equal(moved.getAttribute('x'), '220', 'the text did not move with the finger');

  // Undo: the move, then the text. Redo: both back.
  tap(el('redact-undo'));
  assert.equal(svg.querySelector('.lettering text').getAttribute('x'), '200');
  tap(el('redact-undo'));
  assert.deepEqual(letters(), [], 'the text could not be undone');
  tap(el('redact-redo'));
  tap(el('redact-redo'));
  assert.equal(svg.querySelector('.lettering text').getAttribute('x'), '220');

  // Text that says nothing is not kept.
  press(svg, 50, 50);
  tap(el('redact-text-done'));
  assert.equal(svg.querySelectorAll('.lettering').length, 1, 'an empty piece of text was kept');

  painted = [];
  tap(el('redact-save'));
  await settle(300);
  assert.equal(el('redact').hidden, true);
  const image = await store.get('images', [id, 'p3.jpg']);
  const [lettered] = image.edits.filter((shape) => shape.type === 'text');
  assert.equal(lettered.text, 'HELLO\nYOU');
  assert.equal(lettered.size, 4);
  assert.deepEqual([lettered.x, lettered.y], [220, 310]);
  const calls = painted.flat();
  const written = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepEqual(written, ['HELLO', 'YOU'], 'the text was not painted into the picture');
  assert.ok(calls.some((c) => c[0] === 'font=' && /^600 4px /.test(c[1])), 'painted at another size');
});

await t('a page looked at in Take out can be blacked out instead of taken out', async () => {
  assert.match(html, /id="remove-look-redact"[^>]*>Black out…/);
  const screensMod = await import(www('screens.js'));

  const id = await comic(3);
  const book = await store.get('books', id);
  book.title = 'Covered up';
  await store.put('books', book);
  await settle();

  screensMod.initFind(() => {}, false);
  el('find-input').value = 'Covered up';
  el('find-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  const tile = el('find-results').querySelector(`[data-book="${id}"]`);
  tile.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
  await settle(620);
  tap([...el('folder-actions-list').children].find((b) => b.textContent.includes('Take pages out')));
  await settle(300);

  const cells = [...el('remove-body').querySelectorAll('.remove-cell')];
  tap(cells[2].querySelector('.remove-look-btn'));
  await settle(200);
  assert.equal(el('remove-look-redact').hidden, false, 'a picture page offers no black out');
  tap(el('remove-look-redact'));
  await settle(150);
  assert.equal(el('redact').hidden, false);

  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 });
  // A slanted four-sided one -- saved without pressing Black out shape:
  // enough points to be a shape is what was meant.
  press(svg, 100, 100);
  press(svg, 200, 110);
  press(svg, 190, 170);
  press(svg, 95, 160);
  tap(el('redact-save'));
  await settle(300);

  const image = await store.get('images', [id, 'p3.jpg']);
  assert.deepEqual(image.edits, [{ type: 'poly', colour: 'black', points: [[100, 100], [200, 110], [190, 170], [95, 160]] }]);
  // Still looking at the same page, now showing the edit, and nothing picked.
  assert.equal(el('remove-look').hidden, false, 'saving threw away the page being looked at');
  assert.equal(el('remove-look-pick').textContent, 'Take this out');
});

/* ── finding it ──────────────────────────────────────────────────────── */

console.log('\nfinding it');

await t('a book\'s menu has "Black out panels", which lists its pictures to pick from', async () => {
  const screensMod = await import(www('screens.js'));
  const id = await comic(4);
  const book = await store.get('books', id);
  book.title = 'Pick from me';
  await store.put('books', book);
  await settle();

  screensMod.initFind(() => {}, false);
  el('find-input').value = 'Pick from me';
  el('find-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  el('find-results').querySelector(`[data-book="${id}"]`)
    .dispatchEvent(new window.Event('touchstart', { bubbles: true }));
  await settle(620);
  const entry = [...el('folder-actions-list').children].find((b) => b.textContent.includes('Black out panels'));
  assert.ok(entry, 'the book menu has no Black out panels');
  tap(entry);
  await settle(200);

  assert.equal(el('redact-pick').hidden, false, 'nothing opened to pick a picture from');
  const pictures = el('redact-pick-body').querySelectorAll('.reel-item');
  assert.equal(pictures.length, 4);
  assert.equal(el('redact-pick-body').querySelectorAll('.edited').length, 0);

  // Picked, marked, saved -- and back to the list, which now says so.
  tap(pictures[2]);
  await settle(150);
  assert.equal(el('redact').hidden, false, 'tapping a picture did not open the editor');
  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 });
  press(svg, 10, 10); press(svg, 100, 10); press(svg, 100, 100); press(svg, 10, 100);
  tap(el('redact-confirm'));
  tap(el('redact-save'));
  await settle(300);
  assert.equal(el('redact').hidden, true);
  assert.equal(el('redact-pick').hidden, false, 'saving lost the list of pictures');
  const marked = el('redact-pick-body').querySelectorAll('.reel-item')[2];
  assert.ok(marked.querySelector('.edited'), 'the list does not show which pictures are done');
  assert.ok(redact.isEdited(await store.get('images', [id, 'p3.jpg'])));

  // Back leaves the list.
  assert.equal(window.Grimoire.onBack(), true);
  assert.equal(el('redact-pick').hidden, true);
});

await t('the shelf\'s selection actions and the image reel both have it too', async () => {
  const html2 = read('app/src/main/assets/www/index.html');
  assert.match(html2, /data-act="redact">[\s\S]*?<span>Black out<\/span>/);
  assert.match(html2, /id="reel-redact"[^>]*>Black out…/);

  const reader = await import(www('reader.js'));
  tap(document.querySelector('[data-go="reel"]'));
  await settle(300);
  tap(el('reel-redact'));
  await settle(200);
  assert.equal(el('redact-pick').hidden, false);
  assert.equal(el('redact-pick-of').textContent, (await store.get('books', reader.state.book.id)).title);
  tap(el('redact-pick-close'));
  assert.equal(el('redact-pick').hidden, true);
});

/* ── while reading ───────────────────────────────────────────────────── */

console.log('\nwhile reading');

const touch = (target, type, x, y) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y, target };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  target.dispatchEvent(event);
};

/** Lay the reader's pictures out: these hrefs on screen, the rest off it. */
const onScreen = (...hrefs) => {
  el('page-viewport').getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 });
  let y = 0;
  for (const img of el('page-flow').querySelectorAll('img[data-img]')) {
    const shown = hrefs.includes(img.getAttribute('data-img'));
    const top = shown ? y : 5000;
    if (shown) y += 200;
    img.getBoundingClientRect = () => ({ left: 0, top, right: 400, bottom: top + 200, width: 400, height: 200 });
  }
};

await t('the reader\'s toolbar button opens the picture on screen', async () => {
  const reader = await import(www('reader.js'));
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(300);
  const id = await comic(3);
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'folders'));
  await settle();
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(300);
  tap(document.querySelector(`[data-book="${id}"]`));
  await settle(500);
  assert.equal(reader.state.book?.id, id);
  assert.ok(el('redact-here'), 'the reader has no black-out button');

  onScreen('p2.jpg');
  assert.deepEqual(reader.picturesInView(), ['p2.jpg']);
  tap(el('redact-here'));
  await settle(150);
  assert.equal(el('redact').hidden, false, 'one picture on screen did not open the editor');
  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 });
  press(svg, 10, 10); press(svg, 100, 10); press(svg, 100, 100); press(svg, 10, 100);
  tap(el('redact-confirm'));
  tap(el('redact-save'));
  await settle(300);
  assert.equal(el('redact').hidden, true);
  assert.ok(redact.isEdited(await store.get('images', [id, 'p2.jpg'])), 'the picture on screen was not the one edited');
  // Back in the book, showing the edit where it stands.
  assert.equal(document.body.dataset.view, 'reader');
  assert.equal(reader.state.images.get('p2.jpg'), (await store.get('images', [id, 'p2.jpg'])).blob);
});

await t('several on screen are a choice of just those; none is the whole book', async () => {
  const reader = await import(www('reader.js'));
  onScreen('p1.jpg', 'p3.jpg');
  tap(el('redact-here'));
  await settle(200);
  assert.equal(el('redact-pick').hidden, false);
  assert.deepEqual([...el('redact-pick-body').querySelectorAll('.reel-item')].map((f) => f.dataset.href),
    ['p1.jpg', 'p3.jpg']);
  assert.match(el('redact-pick-of').textContent, /on this page/);
  tap(el('redact-pick-close'));

  onScreen();
  tap(el('redact-here'));
  await settle(200);
  assert.equal(el('redact-pick').hidden, false);
  assert.equal(el('redact-pick-body').querySelectorAll('.reel-item').length, 3);
  tap(el('redact-pick-close'));
  void reader;
});

await t('holding a picture while reading offers to black it out or take it out; moving does not', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  const img = el('page-flow').querySelector('img[data-img="p3.jpg"]');
  assert.ok(img);

  // A drag across it is scrolling, not holding.
  touch(img, 'touchstart', 100, 300);
  touch(img, 'touchmove', 100, 360);
  await settle(650);
  assert.equal(el('redact-chip').hidden, true, 'a scroll offered the editor');
  touch(img, 'touchend', 100, 360);

  // A quick tap is a tap.
  touch(img, 'touchstart', 100, 300);
  touch(img, 'touchend', 100, 300);
  await settle(650);
  assert.equal(el('redact-chip').hidden, true, 'a tap offered the editor');

  // A hold offers it -- and only offers it.
  touch(img, 'touchstart', 100, 300);
  await settle(650);
  assert.equal(el('redact-chip').hidden, false, 'holding a picture offered nothing');
  assert.ok(el('chip-remove'), 'holding a picture does not offer taking the page out');
  assert.equal(el('redact').hidden, true, 'a hold went straight into the editor');
  touch(img, 'touchend', 100, 300);
  tap(el('chip-redact'));
  await settle(150);
  assert.equal(el('redact').hidden, false);
  assert.equal(el('redact-chip').hidden, true);
  tap(el('redact-cancel'));
  assert.equal(el('redact').hidden, true);
  void id;
});

/* ── taking pages out while reading ──────────────────────────────────── */

console.log('\ntaking pages out while reading');

const trim = await import(www('trim.js'));

await t('a held page can be taken out from the page, and reading carries on there', async () => {
  const reader = await import(www('reader.js'));
  const id = await comic(4);
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'folders'));
  await settle();
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(300);
  tap(document.querySelector(`[data-book="${id}"]`));
  await settle(500);
  assert.equal(reader.state.book?.id, id);

  const img = el('page-flow').querySelector('img[data-img="p2.jpg"]');
  touch(img, 'touchstart', 100, 300);
  await settle(650);
  touch(img, 'touchend', 100, 300);
  tap(el('chip-remove'));
  await settle(250);

  // The same confirmation as Take out, over the book rather than instead of it.
  assert.equal(el('remove-confirm').hidden, false, 'nothing asked before taking the page out');
  assert.equal(document.body.dataset.view, 'reader');
  assert.match(el('remove-confirm-what').textContent, /1 page/);
  // There is no "this screen" to put it back from, here.
  assert.match(el('remove-confirm-note').textContent, /Take out in the reader’s toolbar/);
  tap(el('remove-confirm-go'));
  await settle(500);

  assert.equal(document.body.dataset.view, 'reader', 'taking a page out left the book');
  assert.equal(el('page-flow').querySelector('img[data-img="p2.jpg"]'), null, 'the page is still on screen');
  assert.ok(el('page-flow').querySelector('img[data-img="p3.jpg"]'), 'the book was not reopened');
  const row = await store.get('images', [id, 'p2.jpg']);
  assert.equal(row.removed, true);
  assert.equal((await store.get('books', id)).trimmed.length, 1, 'it cannot be put back');
  // Said once the book is back on screen, which waits on its pictures.
  for (let i = 0; i < 60 && !/taken out/.test(el('toast').textContent); i++) await settle(100);
  assert.match(el('toast').textContent, /taken out/);
});

await t('the toolbar\'s Take out opens at the page on screen, nothing picked, and comes back to the book', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  assert.ok(el('remove-here'), 'the reader has no Take out');
  onScreen('p3.jpg');
  tap(el('remove-here'));
  await settle(400);
  assert.equal(document.body.dataset.view, 'remove');
  // The page you are on is where you are, not what you want gone.
  assert.equal(el('remove-body').querySelectorAll('.remove-cell[aria-pressed="true"]').length, 0,
    'a page was picked before anything was tapped');
  const look = await trim.inspect(id);
  const at = look.pages.findIndex((page) => page.picture === 'p3.jpg');
  const cell = el('remove-body').querySelector(`.remove-cell[data-at="${at}"]`);
  assert.ok(cell, 'the page on screen is not shown');
  tap(cell);
  await settle(50);
  const picked = [...el('remove-body').querySelectorAll('.remove-cell[aria-pressed="true"]')];
  assert.equal(picked.length, 1);
  assert.equal(look.pages[Number(picked[0].dataset.at)].picture, 'p3.jpg');

  tap(el('remove-go'));
  await settle(250);
  tap(el('remove-confirm-go'));
  await settle(600);
  assert.equal(document.body.dataset.view, 'reader', 'finishing went somewhere other than the book');
  assert.equal(el('page-flow').querySelector('img[data-img="p3.jpg"]'), null);
  assert.ok(el('page-flow').querySelector('img[data-img="p4.jpg"]'));
});

await t('backing out of Take out into the book shows what was put back', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  tap(el('remove-here'));
  await settle(400);
  assert.equal(document.body.dataset.view, 'remove');
  // Put the last one back from the screen, then back into the book.
  const putBack = [...el('remove-body').querySelectorAll('button')].find((b) => /Put the last one back/.test(b.textContent));
  assert.ok(putBack, 'no way to put it back from Take out');
  tap(putBack);
  await settle(600);
  window.Grimoire.onBack();
  await settle(500);
  assert.equal(document.body.dataset.view, 'reader');
  assert.ok(el('page-flow').querySelector('img[data-img="p3.jpg"]'), 'the page put back is not in the book on screen');
  void id;
});

/* ── not out to the shelf ────────────────────────────────────────────── */

console.log('\nnot out to the shelf');

await t('a finished build opens the book it made, not the shelf', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const go = app.slice(app.indexOf("el('build-go').onclick"), app.indexOf("el('build-go').onclick") + 4500);
  assert.ok(!/show\('library'\)/.test(go), 'building still ends on the shelf');
  assert.match(go, /openBook\(made\)/);
  const divide = app.slice(app.indexOf("el('divide-go').onclick"), app.indexOf("el('divide-go').onclick") + 1500);
  assert.ok(!/show\('library'\)/.test(divide), 'dividing still ends on the shelf');
});

console.log('saving a picture');

await t('holding a picture while reading also offers to save it', async () => {
  const reader = await import(www('reader.js'));
  const img = el('page-flow').querySelector('img[data-img]');
  assert.ok(img);
  const href = img.getAttribute('data-img');
  touch(img, 'touchstart', 100, 300);
  await settle(650);
  assert.equal(el('redact-chip').hidden, false);
  touch(img, 'touchend', 100, 300);

  // Saved through the same native calls as a book, but into Pictures.
  const calls = [];
  const sent = [];
  window.GrimoireNative = {
    ...(window.GrimoireNative || {}),
    beginExport: (name) => { calls.push(['begin', name]); return name; },
    appendExport: (handle, b64) => { sent.push(b64); return true; },
    finishExport: (...args) => calls.push(['finish', ...args]),
    saveToPictures: (...args) => calls.push(['pictures', ...args]),
  };
  try {
    tap(el('chip-save'));
    await settle(200);
    assert.equal(el('picture-sheet').hidden, false, 'Save offered nothing');
    const choices = [...el('picture-list').querySelectorAll('button')].map((b) => b.firstElementChild.textContent);
    assert.deepEqual(choices, ['Save to Pictures', 'Save as…', 'Share']);
    assert.match(el('picture-name').textContent, new RegExp(`${reader.state.book.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    tap(el('picture-list').querySelector('button'));
    await settle(300);
    assert.equal(el('picture-sheet').hidden, true);
    const begin = calls.find((c) => c[0] === 'begin');
    const done = calls.find((c) => c[0] === 'pictures');
    assert.ok(begin && done, `not saved to Pictures: ${JSON.stringify(calls)}`);
    assert.match(done[2], /^image\//);
    // Every byte of the picture the book holds.
    const bytes = Buffer.concat(sent.map((b) => Buffer.from(b, 'base64')));
    const { readArrayBuffer } = await import(www('blobs.js'));
    const held = Buffer.from(await readArrayBuffer(reader.state.images.get(href)));
    assert.ok(bytes.equals(held), 'what was saved is not the picture');

    // Share hands over the picture itself.
    calls.length = 0;
    touch(img, 'touchstart', 100, 300);
    await settle(650);
    touch(img, 'touchend', 100, 300);
    tap(el('chip-save'));
    await settle(200);
    tap([...el('picture-list').querySelectorAll('button')].find((b) => /Share/.test(b.textContent)));
    await settle(300);
    const shared = calls.find((c) => c[0] === 'finish');
    assert.ok(shared && shared[3] === true, `Share did not share: ${JSON.stringify(calls)}`);
  } finally {
    delete window.GrimoireNative.saveToPictures;
  }
});

await t('a picture is named and typed by what it is, not what it is called', async () => {
  const { pictureType, pictureName } = await import(www('picturesave.js'));
  const blob = (bytes, type = '') => new window.Blob([new Uint8Array(bytes)], { type });
  assert.equal(await pictureType(blob([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'x.jpg'), 'image/gif');
  assert.equal(await pictureType(blob([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10])), 'image/png');
  assert.equal(await pictureType(blob([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
  assert.equal(await pictureType(blob([...Buffer.from('RIFF\0\0\0\0WEBPVP8 ')])), 'image/webp');
  assert.equal(await pictureType(blob([1, 2, 3]), 'images/pic.png'), 'image/png');
  assert.equal(pictureName('My: Book?', 'OEBPS/images/p%2003.gif', 'image/gif'), 'My Book - p 03.gif');
  assert.equal(pictureName('Book', 'grimoire-cover/1712.jpg', 'image/jpeg'), 'Book - cover.jpg');
  assert.equal(pictureName('', 'a/b.png', 'image/png'), 'b.png');
});

await t('the reel holds to save, and the viewer saves the picture rather than its name', async () => {
  const screens = fs.readFileSync(new URL(www('screens.js')), 'utf8');
  assert.match(screens, /holdPicture\(grid, 'img\[data-reel\]'/);
  assert.match(screens, /data-save>Save…/);
  assert.ok(!/shareText\?\.\(`Image from/.test(screens), 'the viewer still shares only words');
  const java = fs.readFileSync(new URL('../app/src/main/java/com/grimoire/ereader/GrimoireBridge.java', import.meta.url), 'utf8');
  assert.match(java, /public void saveToPictures\(String handle, String mimeType\)/);
  assert.match(java, /Environment\.DIRECTORY_PICTURES \+ File\.separator \+ "Grimoire"/);
  // No storage permission is asked for: before Android 10 it asks where.
  assert.match(java, /SDK_INT < Build\.VERSION_CODES\.Q\) \{\s*main\.offerExport\(file, mimeType, false\)/);
});

console.log(`\n${pass} assertions passed`);
process.exit(0);
