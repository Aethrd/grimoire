/* Pictures made smaller: for an export (shrinkPicture) and kept that way in
 * the book (keptSmaller, keepSmaller). The phone's decoder and canvas are
 * stood in for -- jsdom has neither -- by ones that say what size each picture
 * would be drawn at, and what it would be written as. */
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const window = await boot();
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;
const shrink = await import(www('shrink.js'));
const store = await import(www('store.js'));
const blobs = await import(www('blobs.js'));

/* ── pictures, by their headers ─────────────────────────────────────── */

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type, data = []) => [...be32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
/** A PNG of this size: colour type 2 (colour) or 6 (colour and see-through), tRNS if asked. */
const png = (width, height, { colour = 2, trns = false, bytes = 3_000_000 } = {}) => {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, colour, 0, 0, 0]),
    ...(trns ? chunk('tRNS', [0, 0, 0, 0, 0, 0]) : []),
    ...chunk('IDAT', [1, 2, 3])];
  const body = new Uint8Array(Math.max(bytes, head.length));
  body.set(head);
  return new window.Blob([body], { type: 'image/png' });
};
const jpeg = (width, height, bytes = 2_000_000) => {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3];
  const body = new Uint8Array(bytes);
  body.set(head);
  return new window.Blob([body], { type: 'image/jpeg' });
};

/* ── the decoder and canvas, stood in for ───────────────────────────── */

const drawn = [];
let written = (canvas) => Math.round((canvas.width * canvas.height) / 20);
// What the canvas gives back when looked at: a page (light and dark), or -- short of memory -- all one colour.
let blank = false;
// A picture written out: a JPEG of the size drawn, unless told otherwise.
let header = (canvas) => [canvas.width, canvas.height];
let decodes = 0;
let slow = null;   // a decode that takes longer than the export waits
globalThis.createImageBitmap = window.createImageBitmap = async (blob, options) => {
  decodes += 1;
  if (slow) return slow();
  if (options?.resizeWidth) return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
  const { width, height } = await blobs.pictureSize(blob, { decode: false });
  return { width, height, close() {} };
};
window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage() {},
    getImageData: (x, y, w, h) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (blank ? 0 : (i * 37) % 256)) }),
  };
};
window.HTMLCanvasElement.prototype.toBlob = function (done, type, quality) {
  drawn.push({ width: this.width, height: this.height, type, quality });
  const [w, h] = header(this);
  done(jpeg(w, h, Math.max(16, written(this))));
};
const last = () => drawn.at(-1);

const S23 = { short: 1080, long: 2340 };

await t('sized for the phone held either way; a strip by its width alone, never its length', () => {
  // A page, upright: as wide as the screen, and half again for zooming.
  assert.equal(shrink.keptScale(2000, 2900, S23).toFixed(2), '0.81');
  assert.equal(shrink.keptScale(2000, 2900, S23, 1).toFixed(2), '0.54');
  // A spread is seen biggest with the phone on its side.
  assert.equal(shrink.keptScale(3000, 2000, S23).toFixed(2), '0.81');
  // A strip 800 across is already within the width: left whatever its length.
  assert.equal(shrink.keptScale(800, 12000, S23), 1);
  assert.equal(shrink.keptScale(800, 60000, S23), 1);
  // A strip wider than that: its width limited, its length in the same measure.
  assert.equal(shrink.keptScale(2000, 30000, S23).toFixed(2), '0.81');
  // Already within what the screen shows.
  assert.equal(shrink.keptScale(1000, 1400, S23), 1);
  // Unknown size: left.
  assert.equal(shrink.keptScale(0, 0, S23), 1);
  // This phone's own screen, or an S23's when it cannot be told.
  assert.deepEqual(shrink.readingScreen(), S23);
});

await t('a smaller export: a strip limited by its width, not squeezed to a sliver', async () => {
  drawn.length = 0;
  const strip = png(1600, 12000);
  const out = await shrink.shrinkPicture(strip, shrink.SIZES.screen);
  assert.notEqual(out, strip);
  // As wide as a phone-shaped page 1400 tall: 630. (By its long edge it was 187 across.)
  assert.equal(last().width, 630);
  assert.equal(last().height, 4725);
  // A page as before: its long edge to 1400.
  await shrink.shrinkPicture(png(2000, 2900), shrink.SIZES.screen);
  assert.deepEqual([last().width, last().height], [966, 1400]);
  // A strip already that narrow: untouched.
  const narrow = png(600, 12000);
  const count = drawn.length;
  assert.equal(await shrink.shrinkPicture(narrow, shrink.SIZES.screen), narrow);
  assert.equal(drawn.length, count);
});

await t('a smaller export: a picture already within the size is not decoded at all, and is left byte for byte', async () => {
  const page = jpeg(900, 1300);
  const strip = png(600, 20000);
  const before = decodes;
  assert.equal(await shrink.shrinkPicture(page, shrink.SIZES.screen), page);
  assert.equal(await shrink.shrinkPicture(strip, shrink.SIZES.screen), strip);
  assert.equal(decodes, before, 'decoded only to learn it was small enough');
  // One whose header cannot be read is decoded as before, to know.
  const odd = new window.Blob([new Uint8Array(3000)], { type: 'image/jpeg' });
  await shrink.shrinkPicture(odd, shrink.SIZES.screen);
  assert.equal(decodes, before + 1);
});

await t('a smaller export: a see-through picture is left as it is, not turned black where it was clear', async () => {
  const count = drawn.length;
  const clear = png(3000, 4000, { colour: 6 });
  assert.equal(await shrink.shrinkPicture(clear, shrink.SIZES.screen), clear);
  const byTrns = png(3000, 4000, { trns: true });
  assert.equal(await shrink.shrinkPicture(byTrns, shrink.SIZES.screen), byTrns);
  assert.equal(drawn.length, count, 'drawn into a JPEG');
  // An opaque one of the same size: made smaller, as ever.
  assert.notEqual(await shrink.shrinkPicture(png(3000, 4000), shrink.SIZES.screen), null);
  assert.equal(drawn.length, count + 1);
});

await t('a smaller export: each canvas let go of at once; a decode given up on let go of when it comes', async () => {
  // The canvas: emptied once its picture is written.
  const made = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = (name, ...rest) => { const node = create(name, ...rest); if (name === 'canvas') made.push(node); return node; };
  try {
    await shrink.shrinkPicture(png(2000, 2900), shrink.SIZES.screen);
  } finally { window.document.createElement = create; }
  assert.ok(made.length >= 1);
  assert.ok(made.every((canvas) => canvas.width === 0 && canvas.height === 0), 'a canvas left holding its pixels');
  // A decode slower than the export waits (8 s): the original kept, and the late picture closed when it comes.
  let closed = false;
  slow = () => new Promise((resolve) => setTimeout(() => resolve({ width: 2000, height: 2900, close() { closed = true; } }), 8600));
  const big = png(2000, 2900);
  try {
    assert.equal(await shrink.shrinkPicture(big, shrink.SIZES.screen), big);
    assert.ok(!closed);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok(closed, 'the late picture held');
  } finally { slow = null; }
});

await t('kept smaller: pages and wide strips made smaller, as JPEG, to the screen and room to zoom', async () => {
  drawn.length = 0;
  const page = await shrink.keptSmaller({ blob: jpeg(2000, 2900) }, { screen: S23 });
  assert.ok(page);
  assert.deepEqual([page.width, page.height], [1620, 2349]);
  assert.equal(last().type, 'image/jpeg');
  assert.equal(last().quality, 0.9);
  assert.equal(page.blob.type, 'image/jpeg');
  const fits = await shrink.keptSmaller({ blob: png(2000, 2900) }, { size: 'screen', screen: S23 });
  assert.deepEqual([fits.width, fits.height], [1080, 1566]);
  // A strip wider than the screen allows: narrower, its length in the same measure.
  const wide = await shrink.keptSmaller({ blob: png(2000, 18000) }, { screen: S23 });
  assert.deepEqual([wide.width, wide.height], [1620, 14580]);
});

await t('kept smaller: left alone wherever smaller would be worse', async () => {
  const left = async (image, why) => {
    const count = drawn.length;
    assert.equal(await shrink.keptSmaller(image, { screen: S23 }), null, why);
    return drawn.length === count;
  };
  assert.ok(await left({ blob: png(800, 12000) }, 'a strip within the width'));
  assert.ok(await left({ blob: png(1000, 1400) }, 'a page already within the screen'));
  assert.ok(await left({ blob: png(1700, 2400) }, 'barely smaller: not worth a generation'));
  assert.ok(await left({ blob: png(2000, 2900, { colour: 6 }) }, 'see-through'));
  assert.ok(await left({ blob: png(2000, 2900, { trns: true }) }, 'see-through by tRNS'));
  assert.ok(await left({ blob: png(2000, 2900), original: png(2000, 2900) }, 'blacked out: its original kept to undo'));
  assert.ok(await left({ blob: png(2000, 2900), animated: true }, 'an animation'));
  const gif = new window.Blob([new Uint8Array(2_000_000)], { type: 'image/gif' });
  assert.ok(await left({ blob: gif }, 'a GIF'));
  assert.ok(await left({ blob: new window.Blob([new Uint8Array(5000)], { type: 'image/png' }) }, 'not a PNG inside'));
  // Past what a phone's canvas holds: kept, not lost.
  assert.ok(await left({ blob: png(2000, 60000) }, 'too long to draw'));
  // The phone's canvas, short of memory, gave back a blank picture: the original kept.
  blank = true;
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }, { screen: S23 }), null, 'a blank picture written over a page');
  blank = false;
  // Or a picture not the size asked for.
  header = () => [10, 10];
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }, { screen: S23 }), null, 'a picture of the wrong size kept');
  header = (canvas) => [canvas.width, canvas.height];
  assert.ok(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }, { screen: S23 }), 'a good one refused');
  // Came out less than a tenth smaller: the original kept.
  written = () => 1_900_000;
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }, { screen: S23 }), null);
  written = (canvas) => Math.round((canvas.width * canvas.height) / 20);
});

await t('kept smaller, a book at a time: written where it stands, never onto a book still landing, and it stops when asked', async () => {
  const id = await store.add('books', { title: 'Pages', fingerprint: 'keep:1', addedAt: 1 });
  const landing = await store.add('books', { title: 'Landing', fingerprint: 'keep:2', addedAt: 2, importing: true });
  for (const [bookId, n] of [[id, 3], [landing, 2]]) {
    for (let i = 0; i < n; i += 1) {
      await store.put('images', { bookId, href: `p${i}.png`, chapterIndex: 0, order: i, width: 2000, height: 2900, blob: png(2000, 2900) });
    }
  }
  const made = async () => ({ blob: new window.Blob([new Uint8Array(10)], { type: 'image/jpeg' }), width: 1620, height: 2349 });
  // A picture blacked out while its smaller copy was being made: left as it was then.
  let n = 0;
  const meanwhile = async (image, how) => {
    n += 1;
    if (n === 2) await store.put('images', { ...(await store.get('images', [image.bookId, image.href])), original: 'kept', edits: [1] });
    return made(image, how);
  };
  const seen = [];
  const done = await shrink.keepSmaller([id, landing], { make: meanwhile, onProgress: (p) => seen.push(p) });
  assert.equal(done.pictures, 2);
  assert.equal(done.books, 1);
  const after = await store.byIndex('images', 'bookId', id);
  assert.deepEqual(after.map((i) => i.width), [1620, 2000, 1620]);
  assert.equal(after[1].original, 'kept');
  assert.ok(after.every((i) => i.chapterIndex === 0 && i.href));
  assert.ok((await store.byIndex('images', 'bookId', landing)).every((i) => i.width === 2000), 'a book still landing changed');
  assert.equal(seen.at(-1).title, 'Pages');
  // Asked to stop: stopped before the next picture.
  await store.put('images', { bookId: id, href: 'p9.png', chapterIndex: 0, order: 9, width: 2000, height: 2900, blob: png(2000, 2900) });
  const stopped = await shrink.keepSmaller([id], { make: made, shouldStop: () => true });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pictures, 0);
});

await t('a picture kept smaller keeps its name in the book; an export names it for what it is now', async () => {
  const epub = await import(www('epub.js'));
  const now = new window.Blob([new Uint8Array(10)], { type: 'image/jpeg' });
  assert.equal(epub.extensionFor(now, 'images/p001.png'), 'jpg');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../app/src/main/assets/www/js/epub.js', import.meta.url), 'utf8');
  assert.match(src, /const extension = extensionFor\(written, written === image\.blob \? image\.href : 'x\.jpg'\);/);
  assert.match(src, /media-type="\$\{mediaFor\(name\)\}"/);
});

await t('asked for from the selection and from a folder, saying what it does first', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-act="shrink">[\s\S]{0,400}<span>Smaller<\/span>/);
  assert.match(app, /shrink: async \(\) => \{\s*const books = await selectedBooks\(\);\s*askKeepSmaller\(/);
  assert.match(app, /choice\('Keep its pictures smaller'[\s\S]{0,120}askKeepSmaller\(await library\.booksInFolder\(folder\)/);
  const ask = app.slice(app.indexOf('function askKeepSmaller'), app.indexOf('async function keepSmaller'));
  assert.match(ask, /the originals are not kept, and exports carry the smaller ones/);
  assert.match(ask, /Long strips keep their full length/);
  assert.match(ask, /Sure\? \$\{escapeText\(size\.label\)\}, for good/);
  assert.match(app, /finish\.controls\(\{ cancel: \(\) => \{ stopped = true; \} \}\);\s*try \{\s*const done = await shrink\.keepSmaller/);
});

console.log(`\n${pass} checks passed`);
process.exit(0);
