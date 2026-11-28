/* A book with no website of its own -- imported from a file, then carried on
 * from its contents page pasted in -- paused part-way, or stopped by its
 * site: the shorter version the queue put in the Bin is let go of then, not
 * kept until the download is whole. Every other book in the Bin is left: one
 * binned by hand of the same name, one joined in Build from a file, and one
 * an old restored queue mixed in. And the book carried on holds every
 * chapter the shorter one had. */
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;

const store = await import(www('store.js'));
const web = await import(www('web.js'));

const chapter = (title) => `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/">Home</a></header>
<article><h1>${title}</h1>${Array.from({ length: 12 }, (_, i) => `<p>${title}: the ${i + 1}th paragraph of a chapter long enough to be one, and then some more words.</p>`).join('')}</article></body></html>`;
window.GrimoireWeb = {
  fetch(id, address) {
    // Y's site says stop at its fourth chapter.
    if (address.endsWith('/Y-4')) {
      setTimeout(() => web.settleWeb(id, false, 'Cloudflare has blocked this connection to the site'), 30);
      return;
    }
    setTimeout(() => {
      const body = chapter(decodeURIComponent(new URL(address).pathname.split('/').pop()));
      const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
      web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path }));
    }, 220);
  },
  release() {},
};
globalThis.GrimoireWeb = window.GrimoireWeb;

// A book imported from a file: two chapters, no website kept on it.
const imported = async (title, fingerprint) => {
  const id = await store.add('books', { title, fingerprint, addedAt: 1, chapters: 2, words: 40 });
  for (let i = 0; i < 2; i += 1) {
    await store.put('chapters', { bookId: id, index: i, title: `${i + 1}화`, words: 20, html: `<p>${title} chapter ${i + 1}</p>` });
  }
  return id;
};
const x = await imported('X', 'x.epub:1');
const y = await imported('Y', 'y.epub:1');
// Binned by hand, the same name as X, nothing of its own website: left.
const byHand = await store.add('books', { title: 'X', fingerprint: 'x-old.epub:1', addedAt: 1, chapters: 1, binnedAt: 5 });
// Joined in Build from a file, and binned: left.
const file = await store.add('books', { title: 'A file', fingerprint: 'file.epub:2', addedAt: 1, chapters: 1, binnedAt: 6 });
const joined = await store.add('books', { title: 'Joined', fingerprint: 'built:joined', addedAt: 2, chapters: 2, builtFrom: [{ name: 'A file', bookId: file }, { name: 'more' }] });
// Another book an old restored queue mixed in: the entry's `earlier`, built from -- but not the entry's book. Left.
const other = await store.add('books', { title: 'Other', fingerprint: 'other.epub:1', addedAt: 1, chapters: 2, binnedAt: 7 });
const m = await store.add('books', { title: 'M', fingerprint: 'built:m', addedAt: 2, chapters: 3, queueJob: 'q-m', webSources: ['https://m.example/list'], builtFrom: [{ name: 'Other', bookId: other }, { name: 'M' }] });

const job = (id, name, base, from, n, bookId) => ({
  id, name, author: '', cover: '', sources: [`${base}/list`], bookId,
  links: Array.from({ length: n }, (_, i) => ({ url: `${base}/${name}-${from + i}`, text: `${from + i}화` })),
  total: n, done: 0, status: 'queued', stops: 0,
});
await store.saveSettings({
  queueAtOnce: 2,
  webQueue: [
    job('q-x', 'X', 'https://x.example/novel', 3, 6, x),
    job('q-y', 'Y', 'https://y.example/novel', 3, 4, y),
    // Waiting on the reader, so it does not run: only the new rule could touch what it lists.
    { ...job('q-m', 'M', 'https://m.example/novel', 4, 1, m), status: 'attention', note: 'its site needs you', earlier: [other] },
  ],
});

await import(www('app.js'));
await new Promise((r) => setTimeout(r, 300));
const jobsNow = async () => (await store.settings()).webQueue || [];
const waitFor = async (test, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

await t('paused part-way, and stopped by its site: the shorter version it carried on is deleted for good', async () => {
  document.getElementById('web-delay').value = '100';
  document.getElementById('web-delay').dispatchEvent(new window.Event('change'));
  document.getElementById('web-jitter').value = '0';
  document.getElementById('web-jitter').dispatchEvent(new window.Event('change'));
  document.getElementById('build-queue-go').click();
  // X under way, a chapter of it come: paused from its row.
  assert.ok(await waitFor(async () => (await store.all('chapters')).some((each) => /\/X-3$/.test(each.from || ''))), 'X never began');
  const pause = document.querySelector('#build-queue-list button[aria-label="Pause “X”"]');
  assert.ok(pause, 'no Pause on X while it downloads');
  pause.click();
  assert.ok(await waitFor(async () => {
    const jobs = await jobsNow();
    return jobs.find((each) => each.id === 'q-x')?.status === 'paused' && jobs.find((each) => each.id === 'q-y')?.status === 'attention';
  }), JSON.stringify((await jobsNow()).map((each) => [each.name, each.status, each.note])));
  await new Promise((r) => setTimeout(r, 300));
  const jobs = await jobsNow();
  for (const [id, was, name] of [['q-x', x, 'X'], ['q-y', y, 'Y']]) {
    const entry = jobs.find((each) => each.id === id);
    assert.notEqual(entry.bookId, was, `${name} was not carried on`);
    const book = await store.get('books', entry.bookId);
    assert.ok(book && !book.binnedAt && !book.importing, `${name}'s book is not on the shelf`);
    // Every chapter the shorter one had, and what came after.
    const chapters = (await store.byIndex('chapters', 'bookId', book.id)).sort((a, b) => a.index - b.index);
    assert.ok(chapters.length >= 3, `${name} has ${chapters.length} chapters`);
    assert.match(chapters[0].html, new RegExp(`${name} chapter 1`));
    assert.match(chapters[1].html, new RegExp(`${name} chapter 2`));
    assert.equal(book.chapters, chapters.length);
    // The shorter version: gone, chapters and all -- not waiting in the Bin.
    assert.equal(await store.get('books', was), undefined, `the shorter ${name} still in the Bin`);
    assert.equal((await store.byIndex('chapters', 'bookId', was)).length, 0);
  }
  assert.equal(jobs.find((each) => each.id === 'q-y').links.length, 3, 'the rest of Y (4화 on) is kept to try again');
});

await t('every other book left as it was: binned by hand, joined from a file, mixed in by an old queue', async () => {
  assert.ok((await store.get('books', byHand))?.binnedAt, 'a book binned by hand was deleted');
  assert.ok((await store.get('books', file))?.binnedAt, 'a file joined in Build was deleted');
  assert.ok(await store.get('books', joined), 'a book joined in Build was touched');
  assert.ok((await store.get('books', other))?.binnedAt, 'a book an old queue mixed in was deleted');
  assert.ok(await store.get('books', m));
  const entry = (await jobsNow()).find((each) => each.id === 'q-m');
  assert.deepEqual([entry.status, entry.earlier], ['attention', [other]], 'the mixed-in entry ran, so this proves nothing');
  // And so when the Bin is opened, too.
  document.querySelector('[data-go="bin"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  for (const id of [byHand, file, other]) assert.ok((await store.get('books', id))?.binnedAt, `book ${id} gone from the Bin`);
});

await t('stopped from the popup: the entry taken out is still asked about its shorter versions', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(dropCancelled\(job, under\)\) outcome\.said = '';[\s\S]{0,200}await purgeSuperseded\(\{ jobs: \[job\] \}\)/);
  assert.match(app, /carried\.has\(older\.id\) && !older\.importing && !older\.inVault && jobOwns\(job, older\)/);
});

console.log(`\n${pass} carry-on checks passed`);
process.exit(0);
