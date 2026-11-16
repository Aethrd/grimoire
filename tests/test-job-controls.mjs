/* Pause and Stop from the popup of what is running; a backup that leaves this
 * phone's queue alone; and a saved book number trusted only when the book
 * there is that download's. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const store = await import(www('store.js'));

/* The library after storage was wiped and the books imported again: the
 * numbers started over, so the queue's numbers are other books now. */
const mine = await store.add('books', { title: 'Solo Leveling', fingerprint: 'a.epub:1', addedAt: 1, chapters: 40,
  webSources: ['https://site.example/novel/solo'] });
const other = await store.add('books', { title: 'A Different Novel', fingerprint: 'b.epub:2', addedAt: 2, chapters: 90 });
const renamed = await store.add('books', { title: 'Omniscient Reader', fingerprint: 'c.epub:3', addedAt: 3, chapters: 12 });
// Made by a queue entry carrying on the wrong book: named after that book, its own entry's name another.
const victim = await store.add('books', { title: 'Lord of Mysteries', fingerprint: 'v.epub:4', addedAt: 4, chapters: 30, binnedAt: 5 });
const mixed = await store.add('books', { title: 'Lord of Mysteries', fingerprint: 'built:m', addedAt: 6, chapters: 55, queueJob: 'q-5' });
const job = (id, extra) => ({ id, name: 'x', author: '', sources: [], cover: '', links: [{ url: `https://site.example/${id}/1`, text: '1' }],
  total: 1, done: 0, status: 'queued', stops: 0, ...extra });
await store.saveSettings({
  webQueue: [
    // Its own book, by its website: kept carrying it on.
    job('q-1', { name: 'Solo Leveling', sources: ['https://site.example/novel/solo/'], bookId: mine }),
    // An old number that is another book now: let go of, to begin a book of its own.
    job('q-2', { name: 'Return of the Hero', sources: ['https://else.example/hero'], bookId: other, earlier: [other] }),
    // Of the same name, from no website the book knows: still its book.
    job('q-3', { name: 'Omniscient  Reader', bookId: renamed }),
    // A check of a book that is not there to check: taken out.
    job('q-4', { name: 'Gone Book', kind: 'check', sources: ['https://else.example/gone'], links: [], bookId: other }),
    job('q-5', { name: 'Shadow Slave', status: 'done', bookId: mixed, earlier: [victim] }),
  ],
  webLeftovers: [{ name: 'Return of the Hero — the rest', bookTitle: 'Return of the Hero', sources: ['https://else.example/hero'], links: [{ url: 'u' }], bookId: other }],
});
await import(www('app.js'));
await new Promise((r) => setTimeout(r, 700));

const screens = await import(www('screens.js'));
const said = () => screens.notices().map((entry) => entry.text || entry.message || String(entry)).join('\n');

await t('a saved book number that is another book now is let go of -- nothing built onto, binned or covered', async () => {
  const kept = (await store.settings()).webQueue;
  const by = Object.fromEntries(kept.map((each) => [each.id, each]));
  assert.equal(by['q-1'].bookId, mine);
  assert.equal(by['q-2'].bookId, undefined);
  assert.equal(by['q-2'].earlier, undefined, 'still holding the other book to delete');
  assert.equal(by['q-3'].bookId, renamed);
  // Said by name: which download, and the book it had been pointed at; and on its row in the queue.
  assert.match(said(), /saved downloads? pointed at a book not (its|their) own .*caught before .*ran — no book was changed: .*the queue’s “Return of the Hero” \(pointed at “A Different Novel”\) — will begin a book of its own/);
  assert.match(said(), /the queue’s check of “Gone Book” \(pointed at “A Different Novel”\) — taken out/);
  assert.match(said(), /Build’s leftover “Return of the Hero” \(pointed at “A Different Novel”\)/);
  assert.equal(by['q-2'].repointed, '“A Different Novel”');
  assert.equal(by['q-4'], undefined, 'a check of another book still queued');
  assert.equal((await store.settings()).webLeftovers[0].bookId, null);
  // Nothing done to the books themselves.
  for (const id of [mine, other, renamed]) assert.ok(!(await store.get('books', id)).binnedAt);
  // A book an old queue mixed up is named, with the one it took the start from -- once.
  assert.match(said(), /May be mixed up: “Lord of Mysteries” starts with that book’s chapters, then has “Shadow Slave” downloaded after them/);
  assert.match(said(), /The book it started from is in the Bin: “Lord of Mysteries”/);
  assert.deepEqual((await store.settings()).mixedSaid, [mixed]);
  // The book it took from kept in the Bin: not deleted for good when the entry finishes.
  assert.equal(by['q-5'].earlier, undefined);
  assert.ok((await store.get('books', victim)));
  assert.ok(!/May be mixed up: “Solo Leveling”/.test(said()), 'a book carried on rightly said to be mixed up');
  // And at the last moment too: a download not owning its book begins its own.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /if \(job\.bookId != null && !jobOwns\(job, before\)\) \{\s*before = null;/);
  assert.match(app, /if \(!book \|\| book\.binnedAt \|\| !jobOwns\(job, book\)\) return \{ none: true \};/);
  assert.match(app, /if \(!jobOwns\(job, book\)\) return false;/);
});

await t('a backup carries no queue, and restoring one keeps this phone’s queue as it is', async () => {
  const backup = await store.exportBackup();
  for (const key of ['webQueue', 'queueRunning', 'webLeftovers', 'webStops', 'autoExport', 'autoBackup', 'exportRun']) {
    assert.ok(!(key in backup.settings), `${key} in the backup`);
  }
  const before = (await store.settings()).webQueue.map((each) => each.id);
  // One made before: its queue of old numbers, and a setting that is yours.
  const old = JSON.parse(JSON.stringify(backup));
  old.settings = { ...old.settings, accent: '#123456', queueRunning: true,
    webQueue: [job('q-old', { name: 'Stale', bookId: other })], webLeftovers: [{ bookId: other, links: [] }] };
  const report = await store.importBackup(old);
  const now = await store.settings();
  assert.equal(now.accent, '#123456', 'the settings did not come back');
  assert.deepEqual(now.webQueue.map((each) => each.id), before);
  assert.ok(!now.webQueue.some((each) => each.id === 'q-old'));
  assert.notEqual(now.queueRunning, true);
  assert.ok(report.skipped.includes('webQueue'));
  // A settings file cannot bring one in either.
  await store.importSettings({ accent: '#654321', webQueue: [job('q-file', {})] }).catch(() => {});
  assert.ok(!(await store.settings()).webQueue.some((each) => each.id === 'q-file'));
});

await t('the popup: Pause asks once, Stop asks twice; each said at once and only once', async () => {
  const { progress } = await import(www('app.js'));
  const asked = [];
  const row = progress.start('Downloading something');
  row.controls({ pause: () => asked.push('pause'), cancel: () => asked.push('cancel') });
  const job = [...window.document.querySelectorAll('#jobs .job')].at(-1);
  const pause = job.querySelector('.job-pause');
  const stop = job.querySelector('.job-cancel');
  assert.ok(pause && stop, 'no Pause and Stop on the row');
  pause.click();
  pause.click();
  assert.deepEqual(asked, ['pause']);
  assert.match(job.querySelector('.job-label').textContent, /^Pausing/);
  // The download's own words do not talk over it while it finishes the chapter.
  row.say('Chapter 12', 0.5);
  assert.match(job.querySelector('.job-label').textContent, /^Pausing/);
  assert.ok(stop.disabled, 'Stop still offered while pausing');
  row();

  const second = progress.start('Exporting');
  second.controls({ cancel: () => asked.push('stop') });
  const row2 = [...window.document.querySelectorAll('#jobs .job')].at(-1);
  assert.equal(row2.querySelector('.job-pause'), null, 'Pause on what cannot pause');
  const stop2 = row2.querySelector('.job-cancel');
  stop2.click();
  assert.deepEqual(asked, ['pause'], 'stopped on one tap');
  assert.ok(stop2.classList.contains('armed'));
  stop2.click();
  assert.deepEqual(asked, ['pause', 'stop']);
  assert.match(row2.querySelector('.job-label').textContent, /^Stopping/);
  second();
});

await t('what each Stop does: the queue’s book out of the queue with its chapters kept; exports discarded; imports between files', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  // The queue: the same light pause -- its own pages by address, never everything -- then out of the queue.
  const pauseFn = app.slice(app.indexOf('function pauseRunningJob('), app.indexOf('function dropCancelled('));
  assert.match(pauseFn, /web\.stopPages\(/);
  assert.ok(!/stopAll/.test(pauseFn), 'a pause from the popup stops every page');
  assert.match(app, /under\.finish\.controls\(\{\s*pause: \(\) => pauseRunningJob\(job\),\s*cancel: \(\) => pauseRunningJob\(job, \{ cancel: true \}\),/);
  assert.match(app, /if \(dropCancelled\(job, under\)\) outcome\.said = '';/);
  assert.match(app, /const pause = playButton\(word\('', \(\) => pauseRunningJob\(job\)\)/);
  // Build: Pause & keep.
  assert.match(app, /finish\.controls\(\{ pause: \(\) => pauseBuild\(\) \}\)/);
  // Many books written out: between books, and nothing half-made offered.
  assert.match(app, /for \(const sink of \[\.\.\.staged, open\?\.sink\]\.filter\(Boolean\)\) sink\.discard\(\);/);
  assert.match(read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java'), /public void discardExport\(String handle\)/);
  // Imports: before the next file, never in one.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /if \(stopNow\(\)\) \{ results\.stopped = work\.length - w; break; \}/);
  assert.match(app, /shouldStop: \(\) => stopped,/);
  // Nothing ticking for the buttons: made once, not redrawn as it runs.
  const controls = app.slice(app.indexOf('const controls = ({ pause, cancel } = {}) => {'), app.indexOf('handle.controls = controls;'));
  assert.ok(!/setInterval|requestAnimationFrame/.test(controls));
});

const jsdomBlob = globalThis.Blob;
await t('the checksum: eight bytes at a time, and two made one, the same as zlib’s', async () => {
  const { crcUpdate, crcCombine } = await import(www('zipwriter.js'));
  const { crc32 } = await import('node:zlib');
  for (const size of [0, 1, 7, 8, 9, 63, 1000, 70001]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + (i >> 3)) & 255);
    assert.equal(crcUpdate(0, bytes), crc32(bytes), `size ${size}`);
    // In pieces, carried on.
    const cut = Math.floor(size / 3);
    assert.equal(crcUpdate(crcUpdate(0, bytes.subarray(0, cut)), bytes.subarray(cut)), crc32(bytes));
    // Combined, without reading the first again.
    assert.equal(crcCombine(crc32(bytes.subarray(0, cut)), crc32(bytes.subarray(cut)), size - cut), crc32(bytes), `combined ${size}`);
  }
  // A length past 4GB, as zip64 sizes are: still exact, by the halving.
  assert.equal(crcCombine(0x12345678, 0, 2 ** 33) >>> 0, crcCombine(crcCombine(0x12345678, 0, 2 ** 32), 0, 2 ** 32) >>> 0);
});

await t('a book written out by the phone’s own deflate is a whole EPUB: mimetype first and stored, chapters deflated, pictures as they are', async () => {
  const epub = await import(www('epub.js'));
  const { canDeflate } = await import(www('zipwriter.js'));
  assert.ok(canDeflate(), 'no CompressionStream here to test with');
  const id = await store.add('books', { title: 'Deflated', fingerprint: 'd.epub:9', addedAt: 9, chapters: 3 });
  for (let i = 0; i < 3; i += 1) {
    await store.put('chapters', { bookId: id, index: i, title: `Chapter ${i + 1}`,
      html: `<p>${'The same sentence, over and over, as prose is. '.repeat(400)}</p><img data-img="p.png">` });
  }
  const { Blob: NodeBlob } = await import('node:buffer');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ab0000000049454e44ae426082', 'hex');
  await store.put('images', { bookId: id, href: 'p.png', blob: new NodeBlob([png], { type: 'image/png' }) });
  // jsdom's Blob cannot hold another Blob as a part, as a browser's can; Node's can.
  globalThis.Blob = NodeBlob;
  let blob;
  try { ({ blob } = await epub.buildEpub(id)); } finally { globalThis.Blob = jsdomBlob; }
  const bytes = new Uint8Array(await (await import(www('blobs.js'))).readArrayBuffer(blob));
  // The first entry, by its local header: "mimetype", stored, no extra field.
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 0, 'mimetype compressed');
  assert.equal(view.getUint16(28, true), 0, 'an extra field on mimetype');
  assert.equal(Buffer.from(bytes.subarray(30, 38)).toString(), 'mimetype');
  const JSZip = (await import('jszip')).default;
  const read = await JSZip.loadAsync(Buffer.from(bytes), { checkCRC32: true });
  assert.equal(await read.file('mimetype').async('string'), 'application/epub+zip');
  const chapter = Object.keys(read.files).find((name) => /text\/ch0001\.xhtml$/.test(name));
  assert.ok(chapter, 'no chapter');
  assert.match(await read.file(chapter).async('string'), /The same sentence/);
  assert.equal(read.files[chapter]._data.compression.magic, '\x08\x00', 'the chapter was not deflated');
  assert.ok(read.files[chapter]._data.compressedSize < read.files[chapter]._data.uncompressedSize / 5);
  const picture = Object.keys(read.files).find((name) => /images\/img0001\.png$/.test(name));
  assert.deepEqual(Buffer.from(await read.file(picture).async('uint8array')), png);
  assert.match(await read.file('OEBPS/content.opf').async('string'), /<dc:title>Deflated<\/dc:title>/);
  // Its checksum worked out as it was made, and right: a zip of it takes it without reading it again, and checks.
  const { crcUpdate, zipWriter } = await import(www('zipwriter.js'));
  assert.equal(blob.crc32, crcUpdate(0, bytes));
  const outer = [];
  const zip = zipWriter((piece) => { outer.push(piece); }, { blobs: true });
  globalThis.Blob = NodeBlob;
  try {
    await zip.add('Deflated.epub', blob);
    await zip.finish();
  } finally { globalThis.Blob = jsdomBlob; }
  const whole = Buffer.concat(await Promise.all(outer.map(async (p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(await p.arrayBuffer())))));
  const back = await JSZip.loadAsync(whole, { checkCRC32: true });
  assert.deepEqual(Buffer.from(await back.file('Deflated.epub').async('uint8array')), Buffer.from(bytes));
});

await t('files written out go to Android as bytes through the pipe, a piece at a time, each waited on; base64 only without it', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const src = app.slice(app.indexOf('const pipe = (() => {'), app.indexOf('/**\n * A piece of a file as base64, for the bridge'));
  const received = [];
  let answer = 'ok';
  const listeners = [];
  const port = {
    addEventListener: (kind, fn) => listeners.push(fn),
    postMessage(data) {
      received.push(data);
      if (typeof data !== 'string') setTimeout(() => listeners.forEach((fn) => fn({ data: answer })), 5);
    },
  };
  const fakeWindow = { MythosPipe: port };
  const blobsShim = { readArrayBuffer: (b) => b.arrayBuffer() };
  const appended = [];
  const bridge = { appendExport: (handle, text) => { appended.push([handle, text]); return true; } };
  const make = (win) => new Function('window', 'blobs', 'blobBase64', 'Blob', `${src}\nreturn sendPiece;`)(win, blobsShim, async (b) => Buffer.from(await b.arrayBuffer()).toString('base64'), NodeBlob);
  const { Blob: NodeBlob } = await import('node:buffer');
  const send = make(fakeWindow);
  assert.equal(await send(bridge, 'Books (part 1).zip', new Uint8Array(Buffer.from('abc'))), true);
  // A piece of a larger buffer: only its own bytes go.
  assert.equal(await send(bridge, 'Books (part 1).zip', new Uint8Array(Buffer.from('xdefx')).subarray(1, 4)), true);
  assert.deepEqual(received.map((d) => (typeof d === 'string' ? d : Buffer.from(d).toString())),
    ['to:Books (part 1).zip', 'abc', 'to:Books (part 1).zip', 'def']);
  assert.equal(appended.length, 0, 'sent as base64 as well');
  // Not written: said so, so the export stops rather than going on with a hole in the file.
  answer = 'failed';
  assert.equal(await send(bridge, 'x.zip', new Uint8Array(Buffer.from('g'))), false);
  // No pipe: base64, as before.
  const plain = make({});
  assert.equal(await plain(bridge, 'y.zip', new Uint8Array(Buffer.from('hi'))), true);
  assert.deepEqual(appended, [['y.zip', Buffer.from('hi').toString('base64')]]);
  const main = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(main, /WebViewCompat\.addWebMessageListener\(webView, "MythosPipe", java\.util\.Collections\.singleton\(ORIGIN\)/);
  assert.match(read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java'), /reply\.postMessage\(ok \? "ok" : "failed"\)/);
});

await t('many books written out pass through as bytes, no Blob made of them: memory the engine sees, and frees as it goes', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const sinkSrc = app.slice(app.indexOf('function exportSink(name) {'), app.indexOf('/* Remembered between exports, not between sessions.'));
  const { Blob: NodeBlob } = await import('node:buffer');
  let made = 0;
  // Any Blob made in here counted: there should be none.
  const CountingBlob = class extends NodeBlob { constructor(...args) { super(...args); made += 1; } };
  const sent = [];
  const bridge = { beginExport: (name) => name };
  const sendPiece = async (_bridge, handle, bytes) => { sent.push(Buffer.from(bytes)); return true; };
  const CHUNK = 64;
  const exportSink = new Function('inBook', 'window', 'blobs', 'EXPORT_CHUNK', 'sendPiece', 'untilNotReading', 'Blob', 'URL', 'document',
    `${sinkSrc}\nreturn exportSink;`)(null, { GrimoireNative: bridge }, { readArrayBuffer: (b) => b.arrayBuffer() }, CHUNK, sendPiece, async () => {}, CountingBlob, null, null);
  const sink = exportSink('Books.zip');
  // A book in parts -- bytes, and a picture that is a Blob already -- then more bytes.
  const picture = new NodeBlob([Buffer.alloc(100, 7)]);
  const book = { parts: [new Uint8Array(30).fill(1), picture, new Uint8Array(50).fill(2)], size: 180 };
  await sink.write(book);
  await sink.write(new Uint8Array(10).fill(3));
  await sink.close();
  assert.equal(made, 0, `${made} Blob(s) made on the way`);
  const whole = Buffer.concat(sent);
  assert.deepEqual(whole, Buffer.concat([Buffer.alloc(30, 1), Buffer.alloc(100, 7), Buffer.alloc(50, 2), Buffer.alloc(10, 3)]));
  assert.ok(sent.every((piece) => piece.length <= CHUNK), 'a piece over the size sent at once');
  // The books themselves asked for in parts, by the export of many and the automatic export alike.
  assert.match(app, /let \{ blob, name: entry \} = await epub\.buildEpub\(book\.id, \{\s*parts: true,/);
  assert.match(app, /const \{ blob \} = await epub\.buildEpub\(book\.id, \{ parts: true \}\);/);
});

await t('a book built in parts is the same book: same bytes, size and checksum as built whole', async () => {
  const epub = await import(www('epub.js'));
  const { crcUpdate } = await import(www('zipwriter.js'));
  const { Blob: NodeBlob } = await import('node:buffer');
  const id = (await store.all('books')).find((b) => b.title === 'Deflated').id;
  globalThis.Blob = NodeBlob;
  try {
    const { blob: whole } = await epub.buildEpub(id);
    const { blob: inParts } = await epub.buildEpub(id, { parts: true });
    assert.ok(Array.isArray(inParts.parts));
    const bytes = Buffer.concat(await Promise.all(inParts.parts.map(async (p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(await p.arrayBuffer())))));
    const wholeBytes = Buffer.from(await whole.arrayBuffer());
    assert.equal(inParts.size, wholeBytes.length);
    assert.equal(inParts.crc32, crcUpdate(0, wholeBytes));
    // Built twice a moment apart, the same but for the time stamped in its headers.
    assert.equal(bytes.length, wholeBytes.length);
  } finally { globalThis.Blob = jsdomBlob; }
});

await t('a long book is written a hundred chapters at a time, in order, none held all at once', async () => {
  const epub = await import(www('epub.js'));
  const { Blob: NodeBlob } = await import('node:buffer');
  const id = await store.add('books', { title: 'Very Long', fingerprint: 'long.epub:1', addedAt: 20, chapters: 250 });
  for (let i = 0; i < 250; i += 1) await store.put('chapters', { bookId: id, index: i * 2, title: `Chapter ${i + 1}`, html: `<p>Part ${i + 1}</p>` });
  assert.equal(await store.chapterCount(id), 250);
  assert.equal((await store.chapterBatch(id, -Infinity, 100)).length, 100);
  assert.equal((await store.chapterBatch(id, 198, 100))[0].index, 200);
  globalThis.Blob = NodeBlob;
  let blob;
  try { ({ blob } = await epub.buildEpub(id)); } finally { globalThis.Blob = jsdomBlob; }
  const JSZip = (await import('jszip')).default;
  const opened = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()), { checkCRC32: true });
  const names = Object.keys(opened.files).filter((name) => /text\/ch\d+\.xhtml$/.test(name)).sort();
  assert.equal(names.length, 250);
  assert.match(await opened.file(names[0]).async('string'), /Part 1</);
  assert.match(await opened.file(names[249]).async('string'), /Part 250</);
  const src = read('app/src/main/assets/www/js/epub.js');
  assert.ok(!/byIndex\('chapters'/.test(src), 'every chapter still read at once');
  assert.match(src, /await zip\.file\(`OEBPS\/\$\{file\}`,/);
});

await t('a chapter whose paragraphs open with many spaces is read in a moment, not frozen on', async () => {
  const { spacedByLines } = await import(www('parse.js'));
  // Korean and Japanese serials indent with full-width and no-break spaces; sixty before the words.
  const indented = Array.from({ length: 40 }, (_, i) => `<p>${'\u3000'.repeat(30)}${'\u00a0'.repeat(30)}그는 말했다 ${i}.</p>`).join('');
  const began = Date.now();
  assert.equal(spacedByLines(indented), false);
  assert.ok(Date.now() - began < 500, `took ${Date.now() - began} ms`);
  // Still finds what it is for: blank paragraphs of any kind of space between the lines.
  const spaced = Array.from({ length: 12 }, (_, i) => `<p>Line ${i}</p><p>\u3000</p><p>&nbsp;<br/></p>`).join('');
  assert.equal(spacedByLines(spaced), true);
  // No pattern left that can read the same space two ways.
  assert.ok(!/\(\?:\\s\|[^)]*\\u(00a0|3000)/.test(read('app/src/main/assets/www/js/parse.js')));
});

await t('what an export cut off left in the app’s own storage is cleared on start -- but not a file waiting to be saved', () => {
  const main = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(main, /restoreStagedExport\(savedInstanceState\);\s*clearStaleExports\(\);/);
  const clear = main.slice(main.indexOf('private void clearStaleExports()'), main.indexOf('private void restoreStagedExport('));
  assert.match(clear, /if \(staged != null\) keep\.add\(staged\.getAbsolutePath\(\)\);/);
  assert.match(clear, /getString\(STAGED_SET, null\)/);
  assert.match(clear, /file\.lastModified\(\) > before\) continue;/);
});

console.log(`\n${pass} checks passed`);
process.exit(0);
