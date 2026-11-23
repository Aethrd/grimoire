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

/** A JPEG carrying EXIF orientation `turn`, before its frame header (as a phone's photo does). */
const exif = (turn, le = false) => {
  const s16 = (n) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const s32 = (n) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...s16(42), ...s32(8), ...s16(1), ...s16(0x0112), ...s16(3), ...s32(1), ...s16(turn), 0, 0, ...s32(0)];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return [0xff, 0xe1, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
};
const turnedJpeg = (width, height, turn, bytes = 2_000_000, le = false) => {
  const head = [0xff, 0xd8, ...exif(turn, le), 0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3];
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
const decodedAs = [];   // each decode: the size asked for, or 'whole'
let slow = null;   // a decode that takes longer than the export waits
globalThis.createImageBitmap = window.createImageBitmap = async (blob, options) => {
  decodes += 1;
  decodedAs.push(options?.resizeWidth ? [options.resizeWidth, options.resizeHeight] : 'whole');
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

await t('kept smaller by the same rule as a Smart export: either screen, held either way; a strip by its width alone', () => {
  // A page: as tall as the Boox shows it whole (1872), which is as large as either screen ever does.
  assert.equal(shrink.keptScale(2000, 2900).toFixed(3), (1872 / 2900).toFixed(3));
  assert.equal(shrink.keptScale(2000, 2900), shrink.smartScale(2000, 2900));
  // A spread: 1872 across.
  assert.equal(shrink.keptScale(3000, 2000).toFixed(3), (1872 / 3000).toFixed(3));
  // A strip within the phone held on its side (2340 across): left whatever its length.
  assert.equal(shrink.keptScale(800, 12000), 1);
  assert.equal(shrink.keptScale(2000, 60000), 1);
  // Wider than that: its width limited, its length in the same measure.
  assert.equal(shrink.keptScale(3000, 30000).toFixed(2), '0.78');
  // Already within what either screen shows; or less than a tenth to gain.
  assert.equal(shrink.keptScale(1000, 1400), 1);
  assert.equal(shrink.keptScale(1400, 2000), 1);
  // Unknown size: left.
  assert.equal(shrink.keptScale(0, 0), 1);
  // One size offered, Smart; a choice made before (room to zoom, fits the screen) is taken as Smart.
  assert.deepEqual(Object.keys(shrink.KEEP_SIZES), ['smart']);
  assert.equal(shrink.KEEP_SIZES.smart.quality, shrink.SIZES.smart.quality);
});

await t('a smaller export: a strip limited by its width, not squeezed to a sliver', async () => {
  drawn.length = 0;
  const strip = png(1600, 12000);
  const out = await shrink.shrinkPicture(strip, shrink.sizeFor('screen'));
  assert.notEqual(out, strip);
  // As wide as a phone-shaped page 1400 tall: 630. (By its long edge it was 187 across.)
  assert.equal(last().width, 630);
  assert.equal(last().height, 4725);
  // A page as before: its long edge to 1400.
  await shrink.shrinkPicture(png(2000, 2900), shrink.sizeFor('screen'));
  assert.deepEqual([last().width, last().height], [966, 1400]);
  // A strip already that narrow: untouched.
  const narrow = png(600, 12000);
  const count = drawn.length;
  assert.equal(await shrink.shrinkPicture(narrow, shrink.sizeFor('screen')), narrow);
  assert.equal(drawn.length, count);
});

await t('a smaller export: a picture already within the size is not decoded at all, and is left byte for byte', async () => {
  const page = jpeg(900, 1300);
  const strip = png(600, 20000);
  const before = decodes;
  assert.equal(await shrink.shrinkPicture(page, shrink.sizeFor('screen')), page);
  assert.equal(await shrink.shrinkPicture(strip, shrink.sizeFor('screen')), strip);
  assert.equal(decodes, before, 'decoded only to learn it was small enough');
  // One whose header cannot be read is decoded as before, to know.
  const odd = new window.Blob([new Uint8Array(3000)], { type: 'image/jpeg' });
  await shrink.shrinkPicture(odd, shrink.sizeFor('screen'));
  assert.equal(decodes, before + 1);
});

await t('too big to make smaller safely on a phone: kept as it is, found from its header -- never decoded to find out', async () => {
  // By the numbers: too many pixels, or too long for a canvas once made smaller.
  assert.equal(shrink.tooBigToShrink(2000, 24000, 2000), true, '48 million pixels');
  assert.equal(shrink.tooBigToShrink(800, 30000, 1400), false, '630 wide would make it 23,625 long: brought to 16,384 instead');
  const longStrip = shrink.scaleFor(800, 30000, { edge: 1000 });
  assert.deepEqual([Math.round(800 * longStrip), Math.round(30000 * longStrip)], [437, 16384], 'Small: a strip too long for 450 wide is made narrower still, its shape kept');
  assert.equal(shrink.tooBigToShrink(3000, 60000, shrink.SIZES.small), true, '180 million pixels: never decoded');
  assert.equal(shrink.tooBigToShrink(1200, 16000, 1400), false, '630 by 8,400: fine');
  assert.equal(shrink.tooBigToShrink(3000, 4300, 1000), false, 'a big page');
  assert.equal(shrink.tooBigToShrink(0, 0, 1400), false, 'no size known');
  // Exported smaller: left byte for byte, and not decoded at all.
  for (const [w, h, size] of [[2000, 24000, 'large'], [2000, 24000, 'small'], [3000, 60000, 'smart']]) {
    const strip = jpeg(w, h);
    const before = decodes;
    assert.equal(await shrink.shrinkPicture(strip, shrink.sizeFor(size)), strip, `${w}x${h} at ${size}`);
    assert.equal(decodes, before, `${w}x${h} decoded to find it too big`);
  }
  // One within reach is made smaller as ever.
  const mid = jpeg(1200, 16000);
  assert.notEqual(await shrink.shrinkPicture(mid, shrink.sizeFor('screen')), mid);
  // And one too long for its width limit, at Small: within the longest canvas.
  const long = jpeg(800, 30000);
  assert.notEqual(await shrink.shrinkPicture(long, shrink.SIZES.small), long);
  assert.deepEqual([last().width, last().height], [437, 16384]);
  // Kept smaller in the book: the same, left alone and undecoded.
  const before = decodes;
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2400, 20000) }), null);
  assert.equal(decodes, before);
});

await t('Smart: every picture as large as the phone or the Boox shows it, held either way -- and no larger', async () => {
  // A page: the Boox upright shows it 1872 tall -- the most either screen does.
  assert.equal(shrink.smartScale(2000, 2900).toFixed(4), (1872 / 2900).toFixed(4));
  // A spread: the Boox on its side, 1872 wide.
  assert.equal(shrink.smartScale(2900, 2000).toFixed(4), (1872 / 2900).toFixed(4));
  // A strip, read across: the phone on its side shows it 2340 wide. 800 across is left.
  assert.equal(shrink.smartScale(800, 30000), 1);
  assert.equal(shrink.smartScale(3000, 30000).toFixed(3), (2340 / 3000).toFixed(3));
  // Under a tenth too big: not worth a generation, left.
  assert.equal(shrink.smartScale(1400, 2000), 1);
  assert.equal(shrink.smartScale(0, 0), 1);
  // Made so: the page 1291 by 1872, as JPEG at 88%; the strip not decoded at all.
  drawn.length = 0;
  const page = await shrink.shrinkPicture(jpeg(2000, 2900), shrink.SIZES.smart);
  assert.deepEqual([last().width, last().height, last().quality], [1291, 1872, 0.88]);
  assert.equal(page.type, 'image/jpeg');
  const strip = jpeg(800, 30000);
  const before = decodes;
  assert.equal(await shrink.shrinkPicture(strip, shrink.SIZES.smart), strip);
  assert.equal(decodes, before);
  // Shape kept, whatever comes out.
  await shrink.shrinkPicture(jpeg(3000, 9000), shrink.SIZES.smart);
  assert.ok(Math.abs(last().width / last().height - 3000 / 9000) < 0.002, 'its shape changed');
  // Small: anything over its limit brought within it, shape kept.
  await shrink.shrinkPicture(jpeg(3000, 4300), shrink.SIZES.small);
  assert.deepEqual([last().width, last().height], [698, 1000]);
  await shrink.shrinkPicture(png(1600, 12000), shrink.SIZES.small);
  assert.deepEqual([last().width, last().height], [450, 3375]);
});

await t('the sizes offered: Full, Smart, Small -- and an export begun at Large or Screen carries on at it', () => {
  assert.deepEqual(Object.keys(shrink.SIZES), ['full', 'smart', 'small']);
  assert.equal(shrink.offeredSize('screen'), 'smart');
  assert.equal(shrink.offeredSize('large'), 'smart');
  assert.equal(shrink.offeredSize('small'), 'small');
  assert.equal(shrink.offeredSize('nonsense'), 'full');
  assert.equal(shrink.sizeFor('screen').edge, 1400);
  assert.equal(shrink.sizeFor('large').edge, 2000);
  assert.equal(shrink.sizeFor('nonsense'), null);
  assert.equal(shrink.describeSize('smart'), 'smart size');
  assert.match(shrink.describeSize('screen'), /1400/);
});

await t('a smaller export: a see-through picture is left as it is, not turned black where it was clear', async () => {
  const count = drawn.length;
  const clear = png(3000, 4000, { colour: 6 });
  assert.equal(await shrink.shrinkPicture(clear, shrink.sizeFor('screen')), clear);
  const byTrns = png(3000, 4000, { trns: true });
  assert.equal(await shrink.shrinkPicture(byTrns, shrink.sizeFor('screen')), byTrns);
  assert.equal(drawn.length, count, 'drawn into a JPEG');
  // An opaque one of the same size: made smaller, as ever.
  assert.notEqual(await shrink.shrinkPicture(png(3000, 4000), shrink.sizeFor('screen')), null);
  assert.equal(drawn.length, count + 1);
});

await t('a smaller export: each canvas let go of at once; a decode given up on let go of when it comes', async () => {
  // The canvas: emptied once its picture is written.
  const made = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = (name, ...rest) => { const node = create(name, ...rest); if (name === 'canvas') made.push(node); return node; };
  try {
    await shrink.shrinkPicture(png(2000, 2900), shrink.sizeFor('screen'));
  } finally { window.document.createElement = create; }
  assert.ok(made.length >= 1);
  assert.ok(made.every((canvas) => canvas.width === 0 && canvas.height === 0), 'a canvas left holding its pixels');
  // A decode slower than the export waits (8 s): the original kept, and the late picture closed when it comes.
  let closed = false;
  slow = () => new Promise((resolve) => setTimeout(() => resolve({ width: 2000, height: 2900, close() { closed = true; } }), 8600));
  const big = png(2000, 2900);
  try {
    assert.equal(await shrink.shrinkPicture(big, shrink.sizeFor('screen')), big);
    assert.ok(!closed);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok(closed, 'the late picture held');
  } finally { slow = null; }
});

await t('kept smaller: pages and wide strips made smaller, as JPEG, to Smart', async () => {
  drawn.length = 0;
  const page = await shrink.keptSmaller({ blob: jpeg(2000, 2900) });
  assert.ok(page);
  // Smart's size and quality: so a Smart export of it copies it as it is.
  assert.deepEqual([page.width, page.height], [1291, 1872]);
  assert.equal(last().type, 'image/jpeg');
  assert.equal(last().quality, 0.88);
  assert.equal(shrink.smartScale(page.width, page.height), 1, 'a picture kept smaller would be made smaller again by a Smart export');
  assert.equal(page.blob.type, 'image/jpeg');
  // An older choice (room to zoom, fits the screen) is taken as Smart.
  for (const size of ['screen', 'zoom']) {
    const before = await shrink.keptSmaller({ blob: png(2000, 2900) }, { size });
    assert.deepEqual([before.width, before.height], [1291, 1872], size);
  }
  // A strip wider than the screen allows: narrower, its length in the same measure.
  const wide = await shrink.keptSmaller({ blob: png(3000, 13000) });
  assert.deepEqual([wide.width, wide.height], [2340, 10140]);
  // As wide as the phone held on its side already: left whatever its length.
  assert.equal(await shrink.keptSmaller({ blob: png(2000, 18000) }), null);
});

await t('kept smaller: left alone wherever smaller would be worse', async () => {
  const left = async (image, why) => {
    const count = drawn.length;
    assert.equal(await shrink.keptSmaller(image), null, why);
    return drawn.length === count;
  };
  assert.ok(await left({ blob: png(800, 12000) }, 'a strip within the width'));
  assert.ok(await left({ blob: png(1000, 1400) }, 'a page already within the screen'));
  assert.ok(await left({ blob: png(1450, 2050) }, 'barely smaller: not worth a generation'));
  assert.ok(await left({ blob: turnedJpeg(2000, 2900, 6) }, 'a photo marked to be shown turned'));
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
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }), null, 'a blank picture written over a page');
  blank = false;
  // Or a picture not the size asked for.
  header = () => [10, 10];
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }), null, 'a picture of the wrong size kept');
  header = (canvas) => [canvas.width, canvas.height];
  assert.ok(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }), 'a good one refused');
  // Came out less than a tenth smaller: the original kept.
  written = () => 1_900_000;
  assert.equal(await shrink.keptSmaller({ blob: jpeg(2000, 2900) }), null);
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

await t('a photo marked to be shown turned, told from its bytes; anything that cannot be read is taken as turned', () => {
  const bytesOf = async (blob) => new Uint8Array(await blobs.readArrayBuffer(blob));
  return (async () => {
    for (const [turn, turned] of [[1, false], [3, true], [6, true], [8, true]]) {
      assert.equal(shrink.mayBeTurned(await bytesOf(turnedJpeg(100, 50, turn, 4000))), turned, `orientation ${turn}`);
      assert.equal(shrink.mayBeTurned(await bytesOf(turnedJpeg(100, 50, turn, 4000, true))), turned, `orientation ${turn}, little-endian`);
    }
    assert.equal(shrink.mayBeTurned(await bytesOf(jpeg(100, 50, 4000))), false, 'a JPEG with no EXIF');
    assert.equal(shrink.mayBeTurned(await bytesOf(png(100, 50, { bytes: 4000 }))), false, 'a PNG');
    // A PNG with an eXIf chunk before its pixels; a WebP saying it carries EXIF.
    const pngExif = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', new Array(13).fill(0)), ...chunk('eXIf', [1, 2]), ...chunk('IDAT', [1])]);
    assert.equal(shrink.mayBeTurned(pngExif), true);
    const webp = (flags) => new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8X'].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(shrink.mayBeTurned(webp(0x08)), true);
    assert.equal(shrink.mayBeTurned(webp(0)), false);
    // Cut short, or not a picture: cannot say, so as if it were.
    assert.equal(shrink.mayBeTurned(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 40, 0x45, 0x78])), true);
    assert.equal(shrink.mayBeTurned(new Uint8Array(10)), true);
    assert.equal(shrink.mayBeTurned(null), true);
  })();
});

await t('an export made smaller decodes each picture straight to its size -- a turned photo whole, as before', async () => {
  decodedAs.length = 0;
  drawn.length = 0;
  const page = jpeg(2000, 2900);
  const out = await shrink.shrinkPicture(page, shrink.SIZES.smart);
  assert.notEqual(out, page);
  // Asked for at the size it is going to be; then looked at (a tiny decode) before it is trusted.
  assert.deepEqual(decodedAs[0], [1291, 1872]);
  assert.deepEqual([last().width, last().height], [1291, 1872]);
  assert.ok(decodedAs.slice(1).every((d) => Array.isArray(d) && d[0] <= 24), 'only the look at it after');
  // A photo marked turned: decoded whole, its size as it is shown -- never squashed to its header's.
  decodedAs.length = 0;
  const photo = turnedJpeg(2900, 2000, 6);
  await shrink.shrinkPicture(photo, shrink.SIZES.smart);
  assert.equal(decodedAs[0], 'whole');
  // A picture kept smaller in the book: within Smart, so copied byte for byte, never decoded.
  const before = decodes;
  const kept = jpeg(1291, 1872);
  assert.equal(await shrink.shrinkPicture(kept, shrink.SIZES.smart), kept);
  assert.equal(decodes, before);
});

await t('an export made smaller: Smart takes a tenth smaller or nothing; Small any saving; a blank result never goes in the file', async () => {
  const page = () => jpeg(3000, 4300, 2_000_000);
  // Came out only 5% smaller: Smart keeps the original; Small takes it (Small is a limit).
  written = () => 1_900_000;
  const smart = page();
  assert.equal(await shrink.shrinkPicture(smart, shrink.SIZES.smart), smart);
  const small = page();
  assert.notEqual(await shrink.shrinkPicture(small, shrink.SIZES.small), small);
  // Bigger: neither.
  written = () => 2_100_000;
  const bigger = page();
  assert.equal(await shrink.shrinkPicture(bigger, shrink.SIZES.small), bigger);
  written = (canvas) => Math.round((canvas.width * canvas.height) / 20);
  // The canvas gave back a blank picture, or one of the wrong size: the original goes in the file.
  blank = true;
  const one = page();
  assert.equal(await shrink.shrinkPicture(one, shrink.SIZES.smart), one, 'a blank page exported');
  assert.equal(await shrink.shrinkPicture(one, shrink.SIZES.small), one, 'a blank page exported');
  blank = false;
  header = () => [10, 10];
  assert.equal(await shrink.shrinkPicture(one, shrink.SIZES.small), one, 'a page of the wrong size exported');
  header = (canvas) => [canvas.width, canvas.height];
  assert.notEqual(await shrink.shrinkPicture(one, shrink.SIZES.small), one, 'a good one refused');
});

console.log(`\n${pass} checks passed`);
process.exit(0);
