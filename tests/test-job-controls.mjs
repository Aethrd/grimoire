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

await t('a saved book number that is another book now is let go of -- nothing built onto, binned or covered', async () => {
  const kept = (await store.settings()).webQueue;
  const by = Object.fromEntries(kept.map((each) => [each.id, each]));
  assert.equal(by['q-1'].bookId, mine);
  assert.equal(by['q-2'].bookId, undefined);
  assert.equal(by['q-2'].earlier, undefined, 'still holding the other book to delete');
  assert.equal(by['q-3'].bookId, renamed);
  assert.equal(by['q-4'], undefined, 'a check of another book still queued');
  assert.equal((await store.settings()).webLeftovers[0].bookId, null);
  // Nothing done to the books themselves.
  for (const id of [mine, other, renamed]) assert.ok(!(await store.get('books', id)).binnedAt);
  // A book an old queue mixed up is named, with the one it took the start from -- once.
  const screens = await import(www('screens.js'));
  const said = screens.notices().map((entry) => entry.text || entry.message || String(entry)).join('\n');
  assert.match(said, /May be mixed up: “Lord of Mysteries” starts with that book’s chapters, then has “Shadow Slave” downloaded after them/);
  assert.match(said, /The book it started from is in the Bin: “Lord of Mysteries”/);
  assert.deepEqual((await store.settings()).mixedSaid, [mixed]);
  // The book it took from kept in the Bin: not deleted for good when the entry finishes.
  assert.equal(by['q-5'].earlier, undefined);
  assert.ok((await store.get('books', victim)));
  assert.ok(!/May be mixed up: “Solo Leveling”/.test(said), 'a book carried on rightly said to be mixed up');
  // And at the last moment too: a download not owning its book begins its own.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /if \(job\.bookId != null && !jobOwns\(job, before\)\) \{\s*before = null;/);
  assert.match(app, /if \(!book \|\| book\.binnedAt \|\| !jobOwns\(job, book\)\) return \{ none: true \};/);
  assert.match(app, /if \(!jobOwns\(job, book\)\) return false;/);
});

await t('a backup carries no queue, and restoring one keeps this phone’s queue as it is', async () => {
  const backup = await store.exportBackup();
  for (const key of ['webQueue', 'queueRunning', 'webLeftovers', 'webStops', 'autoExport', 'autoBackup']) {
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
  const jsdomBlob = globalThis.Blob;
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
});

console.log(`\n${pass} checks passed`);
process.exit(0);
