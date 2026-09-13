import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { boot } from './harness.mjs';

const window = await boot();

/* A blob: URL is scoped to the document that created it. Persist one and it
 * resolves fine for the rest of the session and never again — which is why
 * covers came back blank after the app was closed and reopened while the text
 * was still there.
 *
 * These tests make that failure mode impossible to reintroduce quietly: they
 * count URL creation and assert that what reaches storage is Blob data. */

let created = 0;
let revoked = 0;
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => `blob:stub/${++created}`;
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => { revoked++; };
globalThis.Image = class {
  set src(v) { this.naturalWidth = 600; this.naturalHeight = 900;
    setTimeout(() => this.onload && this.onload(), 0); }
};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);
const blobs = await import(new URL('../app/src/main/assets/www/js/blobs.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function epubWithCover() {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('c.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Pictured</dc:title></metadata>
<manifest>
<item id="c1" href="a.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="cover.png" media-type="image/png" properties="cover-image"/>
</manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file('a.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>Pictured</h1><p>Text.</p><img src="cover.png" alt="plate"/></body></html>`);
  zip.file('cover.png', PNG);
  return new File([await zip.generateAsync({ type: 'nodebuffer' })], 'pictured.epub');
}

console.log('what reaches storage');

const parsed = await parse.parse(await epubWithCover());

await t('the cover is stored as a Blob, not a URL', () => {
  assert.ok(parsed.coverBlob, 'no cover extracted');
  assert.equal(typeof parsed.coverBlob, 'object');
  assert.ok(!('cover' in parsed), 'a cover URL field is back');
  assert.ok(typeof parsed.coverBlob !== 'string',
    'the cover is a string — almost certainly a blob: URL that will not survive a restart');
});

await t('images are stored as Blobs, keyed by href', () => {
  assert.equal(parsed.images.length, 1);
  const image = parsed.images[0];
  assert.ok(image.blob, 'image has no blob');
  assert.equal(image.url, undefined, 'an image URL field is back');
  assert.equal(image.href, 'cover.png');
});

await t('chapter HTML references an href, never a blob URL', () => {
  const html = parse.chapterHtml(parsed.chapters[0]);
  assert.ok(!/blob:/.test(html), 'a blob: URL was baked into the chapter markup');
  assert.match(html, /data-img="cover\.png"/);
  assert.ok(!/<img[^>]*\ssrc=/.test(html), 'chapter markup carries a src that will dangle');
});

await t('dimensions are deferred, not measured at import', () => {
  // Measuring means decoding, and decoding a whole library's artwork at
  // import is minutes of work for numbers only the image reel reads.
  assert.equal(parsed.images[0].width, 0);
  assert.equal(parsed.images[0].height, 0);
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /images\.filter\(\(i\) => i\.blob && !i\.width\)/,
    'the reel does not fill them in either');
  assert.match(screens, /store\.putAll\('images', unmeasured\)/,
    'measured sizes are not written back, so it re-measures every time');
});

console.log('URL lifetime');

await t('parsing mints no object URLs at all', () => {
  // Stronger than balancing them: the parsers now deal only in blobs, so
  // there is nothing to leak and nothing that can be persisted by mistake.
  assert.equal(created, 0, `parsing created ${created} object URL(s)`);
  assert.equal(created, revoked);
});

await t('the pool releases everything it handed out', () => {
  const before = revoked;
  const p = blobs.pool();
  p.url(new Blob(['a']));
  p.url(new Blob(['b']));
  assert.equal(p.size, 2);
  p.release();
  assert.equal(p.size, 0);
  assert.equal(revoked - before, 2);
});

await t('the pool ignores a missing blob rather than minting a dead URL', () => {
  const p = blobs.pool();
  assert.equal(p.url(null), null);
  assert.equal(p.url(undefined), null);
  assert.equal(p.size, 0);
});

console.log('no persisted URLs anywhere');

await t('no module writes a blob: URL into storage', () => {
  // The parsers hand back blobs; only the render layer makes URLs, and only
  // through the pool, which can release them.
  const parseSrc = read('app/src/main/assets/www/js/parse.js');
  assert.ok(!/createObjectURL/.test(parseSrc),
    'parse.js mints object URLs again — those cannot be persisted');

  for (const file of ['library.js', 'reader.js', 'screens.js']) {
    const src = read(`app/src/main/assets/www/js/${file}`);
    assert.ok(!/createObjectURL/.test(src),
      `${file} mints object URLs directly; use pool() so they can be released`);
  }
});

await t('every rendered chapter releases its URLs when dropped', () => {
  const src = read('app/src/main/assets/www/js/reader.js');
  // Endless scroll drops chapters off the far end; without a per-chapter
  // release those URLs accumulate for as long as the app is open.
  assert.match(src, /releaseSection/);
  assert.match(src, /sectionPools/);
  const trim = src.slice(src.indexOf('function trimWindow'));
  assert.equal((trim.slice(0, 700).match(/releaseSection/g) || []).length, 2,
    'both trim directions must release');
});

await t('the schema migrates rather than leaving dead references', () => {
  const src = read('app/src/main/assets/www/js/store.js');
  assert.match(src, /DB_VERSION = \d+/);
  assert.match(src, /oldVersion === 1/);
  assert.match(src, /imagesLost/);
});

console.log('cover images');

await t('the picker offers every image type, by MIME and by extension', () => {
  // SAF hands plenty of files over as octet-stream, so the extensions matter
  // as much as the types.
  assert.match(blobs.COVER_ACCEPT, /image\/\*/);
  for (const type of ['image/webp', 'image/avif', 'image/heic', 'image/svg\\+xml']) {
    assert.ok(new RegExp(type).test(blobs.COVER_ACCEPT), `${type} is not offered`);
  }
  for (const ext of ['.avif', '.heic', '.tiff', '.apng', '.jfif']) {
    assert.ok(blobs.COVER_ACCEPT.includes(ext), `${ext} is not offered`);
  }
});

await t('an image that cannot be decoded is refused, not stored blank', async () => {
  // Being offered by the picker is not the same as being drawable: a HEIC off
  // a phone camera renders as nothing.
  const before = globalThis.Image;
  globalThis.Image = class { set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); } };
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = undefined;
  await assert.rejects(
    blobs.normaliseCover(new File([new Uint8Array([1])], 'x.heic', { type: 'image/heic' })),
    (e) => /could not be read/.test(e.message) && /JPEG/.test(e.message));
  globalThis.Image = before;
  globalThis.createImageBitmap = previousBitmap;
});

await t('a decodable image is kept even where it cannot be re-encoded', async () => {
  // jsdom has no canvas. The image decoded, so it will display; keeping it is
  // better than refusing it.
  const before = globalThis.Image;
  globalThis.Image = class { set src(v) { this.naturalWidth = 60; this.naturalHeight = 90;
    setTimeout(() => this.onload && this.onload(), 0); } };
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = undefined;
  const file = new File([new Uint8Array([1, 2, 3])], 'c.webp', { type: 'image/webp' });
  assert.equal(await blobs.normaliseCover(file), file);
  globalThis.Image = before;
  globalThis.createImageBitmap = previousBitmap;
});

await t('the background picker goes through the same check', () => {
  const panels = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/panels.js', import.meta.url), 'utf8');
  assert.match(panels, /blobs\.COVER_ACCEPT/);
  assert.match(panels, /blobs\.normaliseCover/);
});

await t('a keyed cache reuses a URL until the data changes', async () => {
  // A pool is for things rebuilt wholesale; this is for things redrawn often
  // from the same data. Re-minting a shelf's covers on every render made the
  // browser decode every image again, and until they landed each tile was an
  // empty placeholder.
  const before = created;
  const cache = blobs.urlCache();
  const first = new Blob(['a']);

  const url = cache.url(7, first, 100);
  assert.equal(cache.url(7, new Blob(['a']), 100), url, 'a redraw minted a new URL');
  assert.equal(created - before, 1);

  // A different signature is a different picture.
  const changed = cache.url(7, new Blob(['bb']), 200);
  assert.notEqual(changed, url);

  // And keys that have gone are released.
  const releasedBefore = revoked;
  cache.forget(new Set([7]));
  assert.equal(revoked - releasedBefore, 0);
  cache.forget(new Set());
  assert.equal(revoked - releasedBefore, 1);
  assert.equal(cache.size, 0);
});

console.log('backup');

await t('a backup carries everything except the books', async () => {
  // The text and pictures are gigabytes and already exist as the files they
  // came from. What cannot be re-created is what you did afterwards.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const a = await store.add('books', { title: 'A', fingerprint: 'a:1', addedAt: 1, folder: 'Fic', status: 'onHold' });
  const b = await store.add('books', { title: 'B', fingerprint: 'b:2', addedAt: 2 });
  for (const id of [a, b]) {
    const book = await store.get('books', id);
    book.bundleId = a;
    await store.put('books', book);
  }
  await store.put('chapters', { bookId: a, index: 0, title: 'One', html: '<p>secret</p>', words: 1 });
  await store.put('positions', { bookId: a, chapterIndex: 12, anchor: 340, percent: 0.4 });
  await store.add('marks', { bookId: a, kind: 'bookmark', chapterIndex: 12, anchor: 340 });

  const backup = await store.exportBackup();
  assert.equal(backup.format, 'grimoire-backup');
  // Its own two, not every book an earlier test left on the shelf.
  const mine = backup.books.filter((x) => ['a:1', 'b:2'].includes(x.fingerprint));
  assert.equal(mine.length, 2);
  assert.ok(!JSON.stringify(backup).includes('secret'), 'chapter text is in the backup');
  // Bundles are ids, which do not survive a re-import; the leader is recorded
  // by fingerprint instead.
  assert.equal(backup.books.find((x) => x.fingerprint === 'b:2').bundleLeader, 'a:1');
});

await t('restoring matches books by file, not by id', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const backup = await store.exportBackup();

  for (const book of await store.all('books')) await store.deleteBook(book.id);
  // The same files imported again, with new ids.
  const a = await store.add('books', { title: 'A', fingerprint: 'a:1', addedAt: 9 });
  const b = await store.add('books', { title: 'B', fingerprint: 'b:2', addedAt: 9 });

  const report = await store.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(report.books, 2);
  assert.equal(report.missing, 0);

  const restored = await store.get('books', a);
  assert.equal(restored.folder, 'Fic');
  assert.equal(restored.status, 'onHold');
  assert.equal((await store.get('books', b)).bundleId, a, 'the bundle was not rebuilt');
  assert.equal((await store.get('positions', a)).chapterIndex, 12);
});

await t('a cover chosen by hand is carried in the backup', async () => {
  // The rest of a book comes back by re-importing the file. A cover someone
  // went and found does not -- it exists nowhere else.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const id = await store.add('books', {
    title: 'Replaced', fingerprint: 'cover:1', addedAt: 1, coverBytes: 8, coverCustom: true,
  });

  const report = await store.importBackup({
    format: 'grimoire-backup', version: 1,
    covers: [{ fingerprint: 'cover:1', dataUrl: 'data:image/webp;base64,AQIDBAUGBwg=' }],
  });
  assert.equal(report.covers, 1);

  const restored = await store.get('books', id);
  assert.equal(restored.coverBytes, 8);
  assert.equal(restored.coverCustom, true);
  // Not the Blob's own type: this test database does not round-trip a Blob,
  // it hands back a plain object. The size recorded on the book is the thing
  // that survives here, and it comes from the decoded picture.
  assert.ok(restored.coverBlob);
});

await t('an unreadable cover costs the cover, not the backup', async () => {
  // A backup that throws part-way through is everything lost, which is not a
  // trade worth making for one picture.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  await store.add('books', {
    title: 'Broken cover', fingerprint: 'cover:2', addedAt: 1,
    coverCustom: true, coverBlob: { notABlob: true },
  });
  const backup = await store.exportBackup();
  assert.ok(Array.isArray(backup.covers), 'the export gave up');

  const report = await store.importBackup({
    format: 'grimoire-backup', version: 1,
    covers: [{ fingerprint: 'cover:2', dataUrl: 'not a data url at all' }],
  });
  assert.equal(report.covers, 0);
});

await t('a book not back on the shelf is reported, not invented', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const report = await store.importBackup({
    format: 'grimoire-backup', version: 1,
    books: [{ fingerprint: 'not-here:1', folder: 'Ghost' }],
  });
  assert.equal(report.books, 0);
  assert.equal(report.missing, 1);
  assert.ok(!(await store.all('books')).some((x) => x.folder === 'Ghost'));
});

await t('something that is not a backup is refused', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  await assert.rejects(store.importBackup({ hello: true }), /not a Grimoire backup/);
  await assert.rejects(
    store.importBackup({ format: 'grimoire-backup', version: 99 }), /newer version/);
});

console.log('joining volumes');

await t('volumes sort the way they are numbered, not the way they spell', async () => {
  // A serial arrives as volume 1, 2, 10 — and plain text sorting puts 10
  // second, which is the difference between a readable serial and a shuffled
  // one.
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const titles = ['Witch City Vol. 10', 'Witch City Vol. 2', 'Witch City Vol. 1'];
  assert.deepEqual(titles.sort(library.naturalOrder),
    ['Witch City Vol. 1', 'Witch City Vol. 2', 'Witch City Vol. 10']);
});

await t('joined volumes keep their own pictures', async () => {
  /* Two volumes of a serial almost always name their pictures the same way —
   * OEBPS/images/001.jpg in both — so without a per-volume prefix the second
   * volume's pictures quietly replace the first's. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  const bytes = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  await library.importFiles([
    new File([bytes], 'Serial Vol. 1.epub'),
    new File([bytes], 'Serial Vol. 2.epub'),
  ], {});

  const volumes = (await store.all('books'))
    .filter((b) => /^Serial Vol/.test(b.title || '') || /^Serial Vol/.test(b.fingerprint || ''))
    .sort((a, b) => library.naturalOrder(a.fingerprint, b.fingerprint));
  assert.equal(volumes.length, 2, `found ${volumes.length} volumes to join`);

  const made = await library.mergeBooks(volumes.map((b) => b.id), { title: 'Serial' });
  assert.equal(made.title, 'Serial');

  const chapters = (await store.byIndex('chapters', 'bookId', made.id))
    .sort((a, b) => a.index - b.index);
  const images = await store.byIndex('images', 'bookId', made.id);

  // Both volumes' chapters, in order, and every picture reference still
  // pointing at a picture that exists.
  // However many chapters a volume has, the join keeps all of both.
  const perVolume = (await store.byIndex('chapters', 'bookId', volumes[0].id)).length;
  assert.equal(chapters.length, perVolume * 2);
  const refs = chapters.flatMap((c) =>
    [...parse.chapterHtml(c).matchAll(/data-img="([^"]*)"/g)].map((m) => m[1]));
  assert.ok(refs.length >= 2, 'the pictures went missing');
  assert.equal(new Set(refs).size, refs.length, 'two volumes share a picture reference');
  assert.ok(refs.every((r) => images.some((i) => i.href === r)),
    'a chapter points at a picture that is not there');

  // The volumes are left alone: a join that turns out badly costs a delete
  // rather than a re-import.
  assert.ok(await store.get('books', volumes[0].id));
  assert.ok(await store.get('books', volumes[1].id));
});

await t('joining needs more than one book', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const lone = await store.add('books', { title: 'Alone', fingerprint: 'alone', addedAt: 1 });
  await assert.rejects(library.mergeBooks([lone], {}), /two or more/);
});

console.log(`\n${pass} assertions passed`);
