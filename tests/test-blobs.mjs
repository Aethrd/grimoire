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

await t('a joined book can be taken apart again', async () => {
  // Usually the volumes are still on the shelf, because joining copies rather
  // than consumes -- then splitting is removing the joined copy, and
  // recreating them would leave two of everything.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const bytes = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  await library.importFiles([
    new File([bytes], 'Split Vol. 1.epub'),
    new File([bytes], 'Split Vol. 2.epub'),
  ], {});
  const volumes = (await store.all('books'))
    .filter((b) => /^Split Vol/.test(b.fingerprint || ''))
    .sort((a, b) => library.naturalOrder(a.fingerprint, b.fingerprint));

  const joined = await library.mergeBooks(volumes.map((b) => b.id), { title: 'Split Serial' });
  assert.ok(library.wasJoined(joined));

  const out = await library.splitBook(joined.id);
  assert.equal(out.kept, 2);
  assert.equal(out.restored.length, 0, 'it rebuilt volumes that were never gone');
  assert.equal(await store.get('books', joined.id), undefined);
  assert.ok(await store.get('books', volumes[0].id));
});

await t('a joined book rebuilds volumes that were deleted', async () => {
  // Every chapter still carries the volume it came from and the per-volume
  // prefix on its paths, which is exactly what is needed to undo the join.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  const bytes = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  await library.importFiles([
    new File([bytes], 'Gone Vol. 1.epub'),
    new File([bytes], 'Gone Vol. 2.epub'),
  ], {});
  const volumes = (await store.all('books'))
    .filter((b) => /^Gone Vol/.test(b.fingerprint || ''))
    .sort((a, b) => library.naturalOrder(a.fingerprint, b.fingerprint));

  const joined = await library.mergeBooks(volumes.map((b) => b.id), { title: 'Gone Serial' });
  for (const v of volumes) await store.deleteBook(v.id);

  const out = await library.splitBook(joined.id);
  assert.equal(out.restored.length, 2);

  const rebuilt = (await store.all('books')).filter((b) => /^Gone Vol/.test(b.fingerprint || ''));
  assert.equal(rebuilt.length, 2);

  for (const book of rebuilt) {
    const chapters = (await store.byIndex('chapters', 'bookId', book.id))
      .sort((a, b) => a.index - b.index);
    const images = await store.byIndex('images', 'bookId', book.id);
    assert.ok(chapters.length > 0);
    // Numbered from the beginning again, and the joined book's volume marker
    // is gone from the first chapter's name.
    assert.equal(chapters[0].index, 0);
    assert.ok(!chapters[0].title.includes(' — '));
    // And the paths no longer carry the per-volume prefix.
    assert.ok(!(chapters[0].base || '').startsWith('v'), chapters[0].base);
    const refs = chapters.flatMap((c) =>
      [...parse.chapterHtml(c).matchAll(/data-img="([^"]*)"/g)].map((m) => m[1]));
    assert.ok(refs.every((r) => images.some((i) => i.href === r)),
      'a rebuilt chapter points at a picture that is not there');
  }
});

await t('joining needs more than one book', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const lone = await store.add('books', { title: 'Alone', fingerprint: 'alone', addedAt: 1 });
  await assert.rejects(library.mergeBooks([lone], {}), /two or more/);
});

console.log('the workshop');

await t('a mix of files becomes one book, in the order shown', async () => {
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  const epub = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  const cbz = fs.readFileSync(new URL('./fixtures/comic.cbz', import.meta.url));

  // A zip of volumes is how a serial usually arrives; its contents become
  // parts rather than one part joined to itself.
  const bundle = new JSZip();
  bundle.file('Serial Vol. 2.epub', epub);
  bundle.file('Serial Vol. 10.epub', epub);

  build.clear();
  await build.add([
    new File([await bundle.generateAsync({ type: 'nodebuffer' })], 'volumes.zip'),
    new File([epub], 'Serial Vol. 1.epub'),
    new File([cbz], 'Serial colour pages.cbz'),
  ]);

  // Numbered parts in numbered order: 1, 2, 10 — not 1, 10, 2.
  const names = build.contents().map((p) => p.name);
  assert.equal(names.length, 4);
  assert.deepEqual(
    names.filter((n) => n.endsWith('.epub')),
    ['Serial Vol. 1.epub', 'Serial Vol. 2.epub', 'Serial Vol. 10.epub']);
  assert.equal(build.commonName(names), 'Serial');

  const { book, failed } = await build.build({});
  assert.equal(failed.length, 0);
  assert.ok(book.chapters >= 7);

  const chapters = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index);
  const images = await store.byIndex('images', 'bookId', book.id);

  // Each part's name above its first chapter, so the seams are findable in a
  // book that is now very long.
  assert.equal(chapters.filter((c) => c.title.includes(' — ')).length, 4);

  /* Parts of a serial name their pictures identically, so without a
     per-part prefix the later ones quietly replace the earlier. A comic's
     chapters arrive as finished markup with references already resolved, and
     those need the prefix applying too. */
  const refs = chapters.flatMap((c) =>
    [...parse.chapterHtml(c).matchAll(/data-img="([^"]*)"/g)].map((m) => m[1]));
  assert.ok(refs.length > 0);
  assert.equal(new Set(refs).size, refs.length, 'two parts share a picture reference');
  assert.ok(refs.every((r) => images.some((i) => i.href === r)),
    'a chapter points at a picture that is not there');
});

await t('loose pictures become one chapter of pages', async () => {
  // Manga and manhwa are downloaded as a folder of numbered images. A hundred
  // and eighty separate parts is not a workshop anyone can use.
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const pages = [1, 2, 10, 11].map((n) => new File([png], `Ch 5 page ${n}.png`));

  build.clear();
  await build.add([
    ...pages,
    new File([fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))],
      'Volume 2.epub'),
  ]);

  // One part for the pictures, one for the book.
  assert.equal(build.contents().length, 2);
  assert.equal(build.contents()[0].pictures.length, 4);
  assert.match(build.describe(build.contents()[0]), /4 pages/);

  const { book } = await build.build({ title: 'Manhwa' });
  const images = await store.byIndex('images', 'bookId', book.id);

  // Numbered order, which is not the order a file system gives them: page 10
  // sorts before page 2.
  const order = images.map((i) => i.href).filter((h) => h.includes('Ch 5'));
  assert.deepEqual(order.map((h) => h.split(' page ').pop()),
    ['1.png', '2.png', '10.png', '11.png']);

  const chapters = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index);
  const refs = chapters.flatMap((c) =>
    [...parse.chapterHtml(c).matchAll(/data-img="([^"]*)"/g)].map((m) => m[1]));
  assert.ok(refs.every((r) => images.some((i) => i.href === r)));
  // The first page stands in as the cover.
  assert.ok(book.coverBlob);
});

await t('restoring a backup twice does not double anything', async () => {
  /* Marks and log entries were added outright, so a second restore -- after a
   * failed one, or simply to be sure -- doubled every bookmark and every
   * reading session. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  await library.importFiles([new File(
    [fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))],
    'Twice.epub')], {});
  const book = (await store.all('books')).find((b) => b.fingerprint?.startsWith('Twice'));

  await store.add('marks', { bookId: book.id, kind: 'bookmark', chapterIndex: 1, anchor: 10, at: 1 });
  await store.recordEvent({ bookId: book.id, words: 500, chapters: 1 });

  const backup = await store.exportBackup();
  const marksBefore = (await store.all('marks')).length;
  const eventsBefore = (await store.all('events')).length;

  for (let round = 0; round < 3; round++) {
    await store.importBackup(JSON.parse(JSON.stringify(backup)));
  }

  assert.equal((await store.all('marks')).length, marksBefore);
  assert.equal((await store.all('events')).length, eventsBefore);

  // A mark that really is new still comes back.
  for (const mark of await store.all('marks')) await store.del('marks', mark.id);
  await store.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal((await store.all('marks')).length, marksBefore);
});

await t('one book finishes before the next begins', async () => {
  /* Sorting everything added together by name is what made a build read
   * Chapter 1 of book one, Chapter 1 of book two, Chapter 2 of book one --
   * two volumes whose chapters are both numbered from one interleave
   * perfectly. */
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);

  const page = (label) => [
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="----B"',
    '', '------B', 'Content-Type: text/html', '',
    `<html><head><title>${label}</title></head><body><article><h1>${label}</h1>`
    + '<p>Prose long enough to count as the body of a chapter here.</p></article></body></html>',
    '', '------B--',
  ].join('\r\n');

  const volume = async (n) => {
    const zip = new JSZip();
    for (const chapter of [1, 2, 10]) {
      zip.file(`Chapter ${chapter}.mht`, page(`Book ${n} Chapter ${chapter}`));
    }
    return new File([await zip.generateAsync({ type: 'nodebuffer' })], `Book ${n}.zip`);
  };

  build.clear();
  await build.add([await volume(1), await volume(2)]);

  const { book } = await build.build({ title: 'Two Books' });
  const titles = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index)
    .map((c) => c.title);

  // All of book one, then all of book two — and 10 after 2 within each.
  assert.ok(titles[0].includes('Book 1 Chapter 1'), titles[0]);
  assert.ok(titles[1].includes('Book 1 Chapter 2'), titles[1]);
  assert.ok(titles[2].includes('Book 1 Chapter 10'), titles[2]);
  assert.ok(titles[3].includes('Book 2 Chapter 1'), titles[3]);
  assert.ok(titles[5].includes('Book 2 Chapter 10'), titles[5]);
});

await t('loose volumes are numbered, and later additions go after', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const epub = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));

  build.clear();
  await build.add([
    new File([epub], 'Volume 10.epub'),
    new File([epub], 'Volume 2.epub'),
    new File([epub], 'Volume 1.epub'),
  ]);
  assert.deepEqual(build.contents().map((p) => p.name),
    ['Volume 1.epub', 'Volume 2.epub', 'Volume 10.epub']);

  // A second armful goes after the first, rather than being mixed into it.
  await build.add([new File([epub], 'Volume 3.epub')]);
  assert.equal(build.contents()[3].name, 'Volume 3.epub');
});

await t('a zip of pictures builds as a comic', async () => {
  // Kept under its .zip name it went to the parser as an archive, and the
  // parser refuses those outright: it expects them expanded. So every part
  // failed and the build had nothing to show for itself.
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const chapter = async (n) => {
    const zip = new JSZip();
    for (const page of [1, 2, 10]) zip.file(`${String(page).padStart(3, '0')}.png`, png);
    return new File([await zip.generateAsync({ type: 'nodebuffer' })], `Chapter ${n}.zip`);
  };

  build.clear();
  await build.add([await chapter(1), await chapter(2)]);
  // Named for what the expander decided it is, not for what it arrived as.
  assert.deepEqual(build.contents().map((p) => p.name), ['Chapter 1.cbz', 'Chapter 2.cbz']);

  const { book, failed } = await build.build({ title: 'Manga' });
  assert.equal(failed.length, 0);
  assert.ok(book.chapters >= 2);
  assert.ok((await store.byIndex('images', 'bookId', book.id)).length >= 6);
});

await t('a build that fails says which part and why', async () => {
  // "None of those parts could be read" is true and useless: every part had a
  // reason, and throwing them away left nothing to act on.
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  await build.add([
    new File(['not a book'], 'a.docx'),
    new File(['also not'], 'b.docx'),
  ]);
  await assert.rejects(build.build({}), /a\.docx: DOCX/);
});

await t('the reel is organised by volume, not by chapter number', async () => {
  /* The question anyone asks of a reel is "what was in volume four", not
   * "what was in chapter ninety-one". */
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const volume = async (n) => {
    const zip = new JSZip();
    for (const page of [1, 2, 3]) zip.file(`${page}.png`, png);
    return new File([await zip.generateAsync({ type: 'nodebuffer' })], `Volume ${n}.zip`);
  };

  build.clear();
  await build.add([await volume(1), await volume(2), await volume(3)]);
  const { book } = await build.build({ title: 'Manhwa' });

  const images = (await store.byIndex('images', 'bookId', book.id))
    .sort((a, b) => a.order - b.order);

  // Each picture knows which volume it came from.
  assert.deepEqual([...new Set(images.map((i) => i.volume))],
    ['Volume 1', 'Volume 2', 'Volume 3']);

  /* And they are numbered across the whole book. Each part numbers its own
     from zero, and left that way the reel sorts them into one interleaved
     run: the first picture of every volume, then the second of every one. */
  assert.deepEqual(images.map((i) => i.volume.slice(-1)),
    ['1', '1', '1', '2', '2', '2', '3', '3', '3']);

  // The chapter a picture belongs to counts from where its volume starts, so
  // jumping from one lands in the right chapter.
  assert.deepEqual([...new Set(images.map((i) => i.chapterIndex))], [0, 1, 2]);
});

await t('a single part is a book too', async () => {
  // A zip of one volume's pages is a whole book, and the two-part minimum
  // turned the commonest case away at the door.
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const zip = new JSZip();
  for (const page of [1, 2, 3]) zip.file(`${page}.png`, png);

  build.clear();
  await build.add([new File([await zip.generateAsync({ type: 'nodebuffer' })], 'Chapter 5.zip')]);
  assert.equal(build.contents().length, 1);

  const { book } = await build.build({});
  assert.ok(book.chapters >= 1);
  // No seam label, because with one part there is no seam.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const first = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index)[0];
  assert.ok(!first.title.includes(' — '), first.title);
});

await t('a built book is named when it is built', async () => {
  /* Naming only at export meant the book sat on the shelf under a filename
   * until someone thought to correct it, and anything written out before then
   * carried that name inside it. */
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const epub = await import(new URL('../app/src/main/assets/www/js/epub.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  const bytes = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  build.clear();
  await build.add([
    new File([bytes], 'Named Vol. 1.epub'),
    new File([bytes], 'Named Vol. 2.epub'),
  ]);

  const { book } = await build.build({ title: 'A Chosen Name', author: 'Someone' });
  assert.equal(book.title, 'A Chosen Name');
  assert.equal(book.author, 'Someone');

  // And it travels: the name is in the file, not only on the shelf.
  const { blob, name } = await epub.buildEpub(book.id);
  assert.equal(name, 'A Chosen Name.epub');

  const written = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  const again = await parse.parse(new File([written], name));
  assert.equal(again.title, 'A Chosen Name');
  assert.equal(again.author, 'Someone');
});

await t('a book can be divided, and the cut is shown before it is made', async () => {
  /* A chapter list does not tell you what a cut separates -- "Chapter 12" and
   * "Chapter 13" look like a safe place to divide until you see that one runs
   * straight into the other. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const id = await store.add('books', {
    title: 'Omnibus', fingerprint: 'omnibus', addedAt: 1, words: 600,
  });
  for (let i = 0; i < 6; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Chapter ${i + 1}`, words: 100,
      html: `<p>Chapter ${i + 1} opens here and runs on before it closes.</p>`,
    });
  }
  // A picture belonging to a chapter in the last part.
  await store.put('images', {
    bookId: id, href: 'plate.png', order: 0, chapterIndex: 4, blob: new Blob(['x']),
  });

  const chapters = (await store.byIndex('chapters', 'bookId', id))
    .sort((a, b) => a.index - b.index);

  const look = library.previewCut(chapters, 3);
  assert.equal(look.endsAt, 'Chapter 3');
  assert.equal(look.beginsAt, 'Chapter 4');
  assert.match(look.endsWith, /closes\.$/);
  assert.match(look.beginsWith, /^Chapter 4 opens/);

  const made = await library.fragmentBook(id, [2, 4], { name: 'Omnibus' });
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((m) => m.chapters), [2, 2, 2]);

  // Each part numbers its chapters from the beginning again.
  for (const part of made) {
    const mine = (await store.byIndex('chapters', 'bookId', part.id))
      .sort((a, b) => a.index - b.index);
    assert.equal(mine[0].index, 0);
  }

  /* Pictures follow their chapters and are renumbered against the part, or
   * they claim to belong to a chapter the part does not have. */
  const last = await store.byIndex('images', 'bookId', made[2].id);
  assert.equal(last.length, 1);
  assert.equal(last[0].chapterIndex, 0);
  assert.equal((await store.byIndex('images', 'bookId', made[0].id)).length, 0);

  // The original is left alone, as joining leaves its parts alone.
  assert.ok(await store.get('books', id));
});

await t('a cut in a comic shows the pages, not the chapter names', async () => {
  /* Repeating a chapter title tells you nothing about where a cut falls, and
   * for a comic that is the only thing worth knowing. */
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const chapter = async (n) => {
    const zip = new JSZip();
    for (const page of [1, 2, 3]) zip.file(`${page}.png`, png);
    return new File([await zip.generateAsync({ type: 'nodebuffer' })], `Chapter ${n}.zip`);
  };

  build.clear();
  await build.add([await chapter(1), await chapter(2)]);
  const { book } = await build.build({ title: 'Comic' });

  const chapters = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index);
  const look = library.previewCut(chapters, 1);

  // The last page before the cut and the first after it.
  assert.ok(look.endsPicture, 'no page shown before the cut');
  assert.ok(look.beginsPicture, 'no page shown after the cut');
  assert.notEqual(look.endsPicture, look.beginsPicture);

  // And both are pictures that actually exist, not references to nothing.
  const stored = new Set((await store.byIndex('images', 'bookId', book.id)).map((i) => i.href));
  assert.ok(stored.has(look.endsPicture));
  assert.ok(stored.has(look.beginsPicture));
});

await t('a cut in prose still shows the words', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const id = await store.add('books', { title: 'Prose', fingerprint: 'prose-cut', addedAt: 1 });
  for (let i = 0; i < 2; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Ch ${i + 1}`, words: 20,
      html: `<p>Chapter ${i + 1} runs on for a little while and then stops.</p>`,
    });
  }
  const chapters = (await store.byIndex('chapters', 'bookId', id)).sort((a, b) => a.index - b.index);
  const look = library.previewCut(chapters, 1);
  assert.match(look.endsWith, /then stops\.$/);
  assert.equal(look.endsPicture, null);
});

await t('parts can be any size, not only equal ones', async () => {
  /* Cuts are placed one at a time and anywhere; dividing evenly is a
   * shortcut, not the mechanism. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const id = await store.add('books', { title: 'Uneven', fingerprint: 'uneven', addedAt: 1 });
  for (let i = 0; i < 15; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Chapter ${i + 1}`, words: 100, html: '<p>x</p>',
    });
  }

  const made = await library.fragmentBook(id, [1, 10, 12], { name: 'Uneven' });
  assert.deepEqual(made.map((m) => m.chapters), [1, 9, 2, 3]);

  // Out of order and with duplicates, since the interface is a set of taps.
  const again = await library.fragmentBook(id, [12, 1, 12, 10], { name: 'Again' });
  assert.deepEqual(again.map((m) => m.chapters), [1, 9, 2, 3]);

  // A cut at the very end still makes a part of one.
  const late = await library.fragmentBook(id, [14], { name: 'Late' });
  assert.deepEqual(late.map((m) => m.chapters), [14, 1]);
});

await t('a book of one chapter is divided by what is in it', async () => {
  /* A comic volume is usually one archive of three hundred pages and a
   * scraped novel is often one long chapter. Neither can be cut at a chapter
   * boundary, because there are none. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const id = await store.add('books', { title: 'Volume', fingerprint: 'vol-one', addedAt: 1 });
  const pages = Array.from({ length: 6 }, (_, i) => `<img data-img="p${i + 1}.png" alt=""/>`).join('');
  await store.put('chapters', { bookId: id, index: 0, title: 'Volume', words: 0, html: pages });
  for (let i = 0; i < 6; i++) {
    await store.put('images', {
      bookId: id, href: `p${i + 1}.png`, order: i, chapterIndex: 0, blob: new Blob([`x${i}`]),
    });
  }

  const units = library.unitsOf(pages);
  assert.equal(units.length, 6);
  assert.ok(units.every((u) => u.picture), 'the pages were not recognised');

  // The cut shows the pages on either side of it, as it does between chapters.
  const look = library.previewUnitCut(units, 3);
  assert.equal(look.endsPicture, 'p3.png');
  assert.equal(look.beginsPicture, 'p4.png');

  const made = await library.fragmentChapter(id, [2, 4], { name: 'Volume' });
  assert.deepEqual(made.map((m) => m.units), [2, 2, 2]);

  /* Each part carries only the pictures its own pages use -- copying them all
   * would give every part the whole volume's artwork. */
  const first = await store.byIndex('images', 'bookId', made[0].id);
  assert.deepEqual(first.map((i) => i.href), ['p1.png', 'p2.png']);
  assert.equal((await store.byIndex('images', 'bookId', made[2].id)).length, 2);
});

await t('one long chapter of prose divides at its paragraphs', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const id = await store.add('books', { title: 'Long', fingerprint: 'long-one', addedAt: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'Long', words: 40,
    html: Array.from({ length: 5 },
      (_, i) => `<p>Paragraph ${i + 1} says something worth reading about.</p>`).join(''),
  });

  const made = await library.fragmentChapter(id, [2], { name: 'Long' });
  assert.deepEqual(made.map((m) => m.units), [2, 3]);

  // The words go with them, so progress and percentages still mean something.
  const part = (await store.byIndex('chapters', 'bookId', made[0].id))[0];
  assert.ok(part.words > 0);
  assert.match(part.html, /Paragraph 1/);
  assert.ok(!/Paragraph 3/.test(part.html), 'a part kept text belonging to the next');
});

await t('an even division is a starting point, not the answer', async () => {
  /* The case that matters: two parts where the first is longer than the
   * second. A fixed "every 10 chapters" cannot express it at all. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const id = await store.add('books', { title: 'Lopsided', fingerprint: 'lop', addedAt: 1 });
  for (let i = 0; i < 12; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Chapter ${i + 1}`, words: 100, html: '<p>x</p>',
    });
  }

  // Two parts, nine and three.
  const twoUneven = await library.fragmentBook(id, [9], { name: 'Lopsided' });
  assert.deepEqual(twoUneven.map((m) => m.chapters), [9, 3]);

  // Three parts, none of them the same size.
  const threeUneven = await library.fragmentBook(id, [7, 8], { name: 'Lopsided' });
  assert.deepEqual(threeUneven.map((m) => m.chapters), [7, 1, 4]);
});

await t('a comic divides at chapters and at pages', async () => {
  /* Both are wanted: chapter boundaries are how it was put together, and any
   * page is how volumes actually fall. */
  const JSZip = (await import('jszip')).default;
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const chapter = async (n) => {
    const zip = new JSZip();
    for (const page of [1, 2, 3, 4]) zip.file(`${page}.png`, png);
    return new File([await zip.generateAsync({ type: 'nodebuffer' })], `Chapter ${n}.zip`);
  };

  build.clear();
  await build.add([await chapter(1), await chapter(2), await chapter(3)]);
  const { book } = await build.build({ title: 'Comic' });

  const chapters = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index);
  assert.equal(chapters.length, 3);

  // Every page, in order, each knowing the chapter it came from.
  const pages = library.pagesOf(chapters);
  assert.equal(pages.length, 12);
  assert.ok(pages[0].chapterTitle);

  // By chapter.
  const byChapter = await library.fragmentBook(book.id, [1], { name: 'Comic' });
  assert.deepEqual(byChapter.map((m) => m.chapters), [1, 2]);

  /* By page, with the cut falling inside chapter two. The part keeps its
     chapter structure rather than collapsing into one undifferentiated run. */
  const byPage = await library.fragmentPages(book.id, [6], { name: 'Comic' });
  assert.deepEqual(byPage.map((m) => m.pages), [6, 6]);
  assert.deepEqual(byPage.map((m) => m.chapters), [2, 2]);

  // And each part carries only its own pages, numbered against its chapters.
  for (const part of byPage) {
    const carried = await store.byIndex('images', 'bookId', part.id);
    assert.equal(carried.length, 6);
    assert.deepEqual([...new Set(carried.map((i) => i.chapterIndex))].sort(), [0, 1]);
  }
});

await t('dividing needs somewhere to divide', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const id = await store.add('books', { title: 'Lone', fingerprint: 'lone', addedAt: 1 });
  await store.put('chapters', { bookId: id, index: 0, title: 'Only', words: 5, html: '<p>x</p>' });
  // One chapter holding one block: there is genuinely nowhere to cut.
  await assert.rejects(library.fragmentBook(id, [1], {}), /only one chapter/);
  await assert.rejects(library.fragmentChapter(id, [1], {}), /nothing in that chapter/);
});

await t('building needs something to build from', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  await assert.rejects(build.build({}), /Add something/);
});

console.log('writing files out');

await t('a book can be written back out as a real EPUB', async () => {
  // A book built here exists only inside this app, which is fine until you
  // want it somewhere else.
  const JSZip = (await import('jszip')).default;
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const epub = await import(new URL('../app/src/main/assets/www/js/epub.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  await library.importFiles([new File(
    [fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))],
    'Written Out.epub')], {});
  const book = (await store.all('books')).find((b) => b.fingerprint?.startsWith('Written Out'));

  const { blob, name } = await epub.buildEpub(book.id);
  assert.match(name, /\.epub$/);

  const bytes = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });

  const archive = await JSZip.loadAsync(bytes);
  // The mimetype entry has to come first and be stored uncompressed: it is a
  // rule about the archive rather than its contents, and a reader that checks
  // will reject the file without it.
  assert.equal(Object.keys(archive.files)[0], 'mimetype');
  assert.equal(await archive.file('mimetype').async('string'), 'application/epub+zip');
  assert.ok(archive.file('META-INF/container.xml'));
  assert.ok(archive.file('OEBPS/nav.xhtml'));

  // And it reads back: the strongest check available here is our own
  // importer, which is the same one that reads everything else.
  const again = await parse.parse(new File([bytes], name));
  assert.equal(again.title, book.title);
  assert.equal(again.chapters.length, 2);
  assert.match(parse.chapterHtml(again.chapters[0]), /harbour kept its own accounts/);
});

await t('a written book is compressed', async () => {
  /* An EPUB is a zip, and a zip that stores rather than deflates is just a
   * container: a book came out roughly the size of its own markup. The
   * repeated per-chapter boilerplate compresses to almost nothing, which is
   * what made a book of thousands of short chapters so much worse than one of
   * ten long ones. */
  const JSZip = (await import('jszip')).default;
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const epub = await import(new URL('../app/src/main/assets/www/js/epub.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

  // A great many short chapters: the shape that suffered most.
  let text = '';
  let n = 1;
  while (text.length < 600 * 1024) {
    text += `Chapter ${n++}\n\n`
      + 'The wall ran on into the rain and she counted the lamps beneath it. '.repeat(12)
      + '\n\n';
  }
  const source = new File([text], 'Compressed.txt');
  await library.importFiles([source], {});
  const book = (await store.all('books')).find((b) => b.fingerprint?.startsWith('Compressed'));

  const chapters = await store.byIndex('chapters', 'bookId', book.id);
  assert.ok(chapters.length > 100, `only ${chapters.length} chapters`);

  const { blob, name } = await epub.buildEpub(book.id);
  assert.ok(blob.size < source.size * 0.6,
    `${blob.size} bytes out of ${source.size} in — it is not being compressed`);

  const bytes = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  const archive = await JSZip.loadAsync(bytes);

  /* The mimetype entry is the exception and must stay uncompressed and
     first, or a reader that checks will reject the file. */
  assert.equal(Object.keys(archive.files)[0], 'mimetype');
  assert.equal(await archive.file('mimetype').async('string'), 'application/epub+zip');

  // And it is still a book, not just a smaller file.
  const again = await parse.parse(new File([bytes], name));
  assert.equal(again.chapters.length, chapters.length);
  assert.match(parse.chapterHtml(again.chapters[0]), /counted the lamps/);
});

await t('pictures are stored rather than deflated again', () => {
  /* JPEG, PNG and WebP are compressed already. Deflating them costs real time
   * on a phone and saves a fraction of a percent, and for a comic that time
   * is most of the export. */
  const source = read('app/src/main/assets/www/js/epub.js');
  assert.match(source, /const PICTURE = \{ compression: 'STORE' \}/);
  // `written` rather than `image.blob`: a smaller copy substitutes a
  // downscaled blob here, and either way it is stored, never deflated.
  assert.match(source, /zip\.file\(`OEBPS\/\$\{name\}`, written, PICTURE\)/);
  assert.match(source, /zip\.file\('OEBPS\/cover\.jpg', book\.coverBlob, PICTURE\)/);
  // While the markup says DEFLATE rather than relying on the default alone.
  assert.match(source, /const TEXT = \{ compression: 'DEFLATE'/);
});

await t('a picture that cannot be written costs its place, not the book', () => {
  // A record whose data did not survive, or a blob the archive will not take.
  const source = read('app/src/main/assets/www/js/epub.js');
  assert.match(source, /typeof image\.blob\?\.size !== 'number'/);
  // Leaving it unnamed is also what drops its reference from the markup, so
  // nothing points at a picture the file does not contain.
  assert.match(source, /if \(!target\) return ''/);
});

await t('files leave in pieces, not in one', () => {
  // Handing a file over whole means holding it three times at the peak, which
  // is what killed the app when files came the other way.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /const EXPORT_CHUNK/);
  assert.match(app, /bridge\.appendExport\(handle, btoa\(binary\)\)/);
  const bridge = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.match(bridge, /public boolean appendExport/);
  // Saving somewhere chosen, not only handing it to whatever app will take
  // it: a backup belongs in a folder that can be found again.
  const main = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(main, /ACTION_CREATE_DOCUMENT/);
  assert.match(main, /void offerExport/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Save a backup/);
  assert.match(panels, /Send a copy/);
});

console.log(`\n${pass} assertions passed`);
