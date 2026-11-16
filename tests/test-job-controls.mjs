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

console.log(`\n${pass} checks passed`);
process.exit(0);
