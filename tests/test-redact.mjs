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
  const fills = this.calls.filter((c) => c[0] === 'fillRect' || c[0] === 'fill' || c[0] === 'stroke');
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

const fakeBake = async (original, shapes) =>
  new window.Blob([`baked:${shapes.length}`], { type: original.type || 'image/png' });

/* ── shapes ──────────────────────────────────────────────────────────── */

console.log('shapes');

await t('a box is the same box whichever way it was dragged', () => {
  const a = redact.fromDrag('box', { x: 10, y: 20 }, { x: 110, y: 70 });
  const b = redact.fromDrag('box', { x: 110, y: 70 }, { x: 10, y: 20 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { type: 'box', colour: 'black', x: 10, y: 20, w: 100, h: 50 });
});

await t('a tap is not a shape, a drag is', () => {
  assert.ok(redact.isTiny(redact.fromDrag('box', { x: 5, y: 5 }, { x: 6, y: 6 })));
  assert.ok(!redact.isTiny(redact.fromDrag('oval', { x: 5, y: 5 }, { x: 60, y: 40 })));
  // One dab of the brush is a dot, and a dot was meant.
  assert.ok(!redact.isTiny({ type: 'brush', size: 10, points: [[3, 3]] }));
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

await t('every shape is painted, in its colour, in the picture\'s own pixels', () => {
  const { ctx, calls } = recorder();
  redact.paintShapes(ctx, [
    { type: 'box', colour: 'black', x: 10, y: 20, w: 30, h: 40 },
    { type: 'oval', colour: 'white', x: 100, y: 100, w: 50, h: 20 },
    { type: 'brush', colour: 'black', size: 12, points: [[0, 0], [10, 10], [20, 5]] },
    { type: 'brush', colour: 'white', size: 8, points: [[50, 50]] },
  ]);
  assert.deepEqual(calls.find((c) => c[0] === 'fillRect'), ['fillRect', 10, 20, 30, 40]);
  const ellipse = calls.find((c) => c[0] === 'ellipse');
  assert.deepEqual(ellipse.slice(1, 5), [125, 110, 25, 10]);
  assert.ok(calls.some((c) => c[0] === 'fillStyle=' && c[1] === '#ffffff'), 'white was never used');
  assert.deepEqual(calls.filter((c) => c[0] === 'lineTo').map((c) => c.slice(1)), [[10, 10], [20, 5]]);
  assert.ok(calls.some((c) => c[0] === 'lineWidth=' && c[1] === 12));
  // A single dab is a filled dot, not a stroke of nothing.
  assert.deepEqual(calls.find((c) => c[0] === 'arc').slice(1, 4), [50, 50, 4]);
});

await t('what is drawn while editing is what is painted on save', () => {
  assert.match(redact.svgFor({ type: 'box', colour: 'black', x: 1, y: 2, w: 3, h: 4 }),
    /<rect x="1" y="2" width="3" height="4" fill="#000000"\/>/);
  assert.match(redact.svgFor({ type: 'oval', colour: 'white', x: 0, y: 0, w: 10, h: 6 }),
    /<ellipse cx="5" cy="3" rx="5" ry="3" fill="#ffffff"\/>/);
  assert.match(redact.svgFor({ type: 'brush', colour: 'black', size: 9, points: [[0, 0], [5, 5]] }),
    /d="M0 0 L5 5"[^>]*stroke-width="9"/);
});

await t('the eraser takes the shape on top, and a near miss on a thin line still counts', () => {
  const shapes = [
    { type: 'box', colour: 'black', x: 0, y: 0, w: 100, h: 100 },
    { type: 'oval', colour: 'black', x: 40, y: 40, w: 20, h: 20 },
    { type: 'brush', colour: 'black', size: 2, points: [[200, 0], [200, 100]] },
  ];
  assert.equal(redact.shapeAt(shapes, { x: 50, y: 50 }), 1, 'not the topmost');
  assert.equal(redact.shapeAt(shapes, { x: 5, y: 5 }), 0);
  assert.equal(redact.shapeAt(shapes, { x: 300, y: 300 }), -1);
  assert.equal(redact.shapeAt(shapes, { x: 208, y: 50 }), -1);
  assert.equal(redact.shapeAt(shapes, { x: 208, y: 50 }, 10), 2);
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
    { type: 'box', colour: 'black', x: 1, y: 1, w: 50, h: 50 },
  ]);
  const calls = painted[0];
  const draw = calls.findIndex((c) => c[0] === 'drawImage');
  const fill = calls.findIndex((c) => c[0] === 'fillRect');
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
  const shapes = [{ type: 'box', colour: 'black', x: 0, y: 0, w: 40, h: 40 }];
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
  await redact.saveEdits(id, 'p3.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: watching });
  await redact.saveEdits(id, 'p3.jpg', [{ type: 'oval', colour: 'white', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: watching });
  assert.equal(seen, 'page-3', 'the second edit was painted onto the first');
  const image = await store.get('images', [id, 'p3.jpg']);
  assert.equal(image.edits.length, 1);
  assert.equal(image.edits[0].type, 'oval');
});

await t('the original can always be put back', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p2.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  await redact.restoreOriginal(id, 'p2.jpg');
  const image = await store.get('images', [id, 'p2.jpg']);
  assert.equal(await text(image.blob), 'page-2');
  assert.ok(!redact.isEdited(image));
  assert.equal(image.edits, undefined);

  // Clearing every shape and saving is the same thing.
  await redact.saveEdits(id, 'p2.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  await redact.saveEdits(id, 'p2.jpg', [], { bakeWith: fakeBake });
  assert.equal(await text((await store.get('images', [id, 'p2.jpg'])).blob), 'page-2');
});

await t('a cover that is the edited page follows it; one picked by hand does not', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p1.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  let book = await store.get('books', id);
  assert.equal(await text(book.coverBlob), 'baked:1', 'the shelf still shows what was blacked out');

  await redact.restoreOriginal(id, 'p1.jpg');
  book = await store.get('books', id);
  assert.equal(await text(book.coverBlob), 'page-1-original-bytes');

  const chosen = await comic();
  const picked = await store.get('books', chosen);
  picked.coverCustom = true;
  await store.put('books', picked);
  await redact.saveEdits(chosen, 'p1.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  assert.equal(await text((await store.get('books', chosen)).coverBlob), 'page-1-original-bytes',
    'a cover chosen by hand was replaced');

  // And a different picture's edit leaves the cover alone.
  const other = await comic();
  await redact.saveEdits(other, 'p2.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  assert.equal(await text((await store.get('books', other)).coverBlob), 'page-1-original-bytes');
});

await t('a blacked-out animation is marked still, and moves again when put back', async () => {
  const id = await comic(2, { type: 'image/gif', ext: 'gif' });
  const row = await store.get('images', [id, 'p2.gif']);
  row.animated = true;
  await store.put('images', row);
  await redact.saveEdits(id, 'p2.gif', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }],
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
  await redact.saveEdits(id, 'p2.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  const out = await epub.buildEpub(id);
  const blob = out?.blob || out;
  const zip = await JSZip.loadAsync(await blobs.readArrayBuffer(blob));
  const pictures = await Promise.all(Object.keys(zip.files)
    .filter((name) => /OEBPS\/images\/./.test(name) && !zip.files[name].dir)
    .map((name) => zip.file(name).async('string')));
  assert.ok(pictures.includes('baked:1'), `the edit did not leave the app: ${pictures.join(' | ')}`);
  assert.ok(!pictures.includes('page-2'), 'the original went out with it');
});

await t('an edited GIF is written out as the PNG it now is', async () => {
  assert.equal(epub.extensionFor(new window.Blob([], { type: 'image/png' }), 'p2.gif'), 'png');
  assert.equal(epub.extensionFor(new window.Blob([], { type: 'image/jpeg' }), 'p2.jpeg'), 'jpg');
  // A picture that does not say what it is keeps the name it came with.
  assert.equal(epub.extensionFor(new window.Blob([]), 'p2.webp'), 'webp');
});

await t('a book built onto another takes its pictures as they are now', async () => {
  const id = await comic();
  await redact.saveEdits(id, 'p3.jpg', [{ type: 'box', colour: 'black', x: 0, y: 0, w: 9, h: 9 }], { bakeWith: fakeBake });
  const source = read('app/src/main/assets/www/js/build.js');
  assert.match(source, /blob: image\.blob,/, 'build copies something other than the current picture');
  assert.ok(typeof build.readShelfBook === 'function' || /readShelfBook/.test(source));
});

/* ── the editor ──────────────────────────────────────────────────────── */

console.log('\nthe editor');

await t('the editor is drawn on, not scrolled, and stays light on black in either theme', () => {
  assert.match(html, /id="redact"[^>]*hidden/);
  for (const tool of ['box', 'oval', 'brush', 'erase', 'move']) {
    assert.match(html, new RegExp(`data-tool="${tool}"`), `no ${tool} tool`);
  }
  assert.match(css, /#redact-svg \{[^}]*touch-action: none/);
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

await t('from the reel: open a picture, drag a box, save, and the book has it', async () => {
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

  // Shown at 200×300: half the picture's own size.
  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 300, right: 200, bottom: 300 });
  svg.dispatchEvent(pointer('pointerdown', 10, 20));
  svg.dispatchEvent(pointer('pointermove', 60, 70));
  // A second finger mid-stroke is not a second shape.
  svg.dispatchEvent(pointer('pointerdown', 150, 150, 2));
  svg.dispatchEvent(pointer('pointerup', 110, 120));
  assert.equal(svg.querySelectorAll('rect').length, 1, 'the box was not drawn');
  assert.match(el('redact-caption').textContent, /1 shape/);

  // Undo, redo.
  tap(el('redact-undo'));
  assert.equal(svg.querySelectorAll('rect').length, 0);
  tap(el('redact-redo'));
  assert.equal(svg.querySelectorAll('rect').length, 1);

  tap(el('redact-save'));
  await settle(300);
  assert.equal(el('redact').hidden, true, 'the editor did not close after saving');

  const image = await store.get('images', [id, 'p2.jpg']);
  assert.deepEqual(image.edits, [{ type: 'box', colour: 'black', x: 20, y: 40, w: 200, h: 200 }],
    'the box was not saved in the picture\'s own pixels');
  assert.match(await text(image.blob), /^painted:400x600:1$/);
  assert.equal(await text(image.original), 'page-2');
  assert.equal(reader.state.images.get('p2.jpg'), image.blob, 'the open book still shows the old picture');
  assert.match(el('toast').textContent, /Blacked out/);
});

await t('the eraser, the brush, and leaving without saving', async () => {
  const reader = await import(www('reader.js'));
  const id = reader.state.book.id;
  tap(document.querySelectorAll('#reel-grid img')[1]);
  tap(document.querySelector('.viewer [data-redact]'));
  await settle(100);

  const svg = el('redact-svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 });
  // The saved box comes back to be changed.
  assert.equal(svg.querySelectorAll('rect').length, 1, 'the earlier edit was not reopened');
  assert.equal(el('redact-restore').hidden, false, 'an edited picture offers no way back');

  tap(el('redact-tool').querySelector('[data-tool="erase"]'));
  svg.dispatchEvent(pointer('pointerdown', 50, 50));
  svg.dispatchEvent(pointer('pointerup', 50, 50));
  assert.equal(svg.querySelectorAll('rect').length, 0, 'the eraser did not take the box');

  tap(el('redact-tool').querySelector('[data-tool="brush"]'));
  assert.equal(el('redact-size-row').hidden, false);
  svg.dispatchEvent(pointer('pointerdown', 10, 10));
  svg.dispatchEvent(pointer('pointermove', 100, 10));
  svg.dispatchEvent(pointer('pointermove', 200, 30));
  svg.dispatchEvent(pointer('pointerup', 200, 30));
  assert.equal(svg.querySelectorAll('path').length, 1, 'the brush stroke was not drawn');

  // Moving does not draw.
  tap(el('redact-tool').querySelector('[data-tool="move"]'));
  svg.dispatchEvent(pointer('pointerdown', 10, 10));
  svg.dispatchEvent(pointer('pointerup', 300, 300));
  assert.equal(svg.children.length, 1);

  // Cancel with something drawn asks first; back closes the question first.
  tap(el('redact-cancel'));
  assert.equal(el('redact-leave').hidden, false, 'unsaved shapes were thrown away without asking');
  assert.equal(window.Grimoire.onBack(), true);
  assert.equal(el('redact-leave').hidden, true);
  assert.equal(el('redact').hidden, false);
  tap(el('redact-cancel'));
  tap(el('redact-leave-yes'));
  assert.equal(el('redact').hidden, true);

  const image = await store.get('images', [id, 'p2.jpg']);
  assert.equal(image.edits.length, 1, 'leaving without saving changed the book');
  assert.equal(image.edits[0].type, 'box');
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
  tap(el('redact-tool').querySelector('[data-tool="oval"]'));
  svg.dispatchEvent(pointer('pointerdown', 100, 100));
  svg.dispatchEvent(pointer('pointerup', 200, 160));
  tap(el('redact-save'));
  await settle(300);

  const image = await store.get('images', [id, 'p3.jpg']);
  assert.deepEqual(image.edits, [{ type: 'oval', colour: 'black', x: 100, y: 100, w: 100, h: 60 }]);
  // Still looking at the same page, now showing the edit, and nothing picked.
  assert.equal(el('remove-look').hidden, false, 'saving threw away the page being looked at');
  assert.equal(el('remove-look-pick').textContent, 'Take this out');
});

console.log(`\n${pass} assertions passed`);
process.exit(0);
