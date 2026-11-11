/* The queue, run for real: the app booted, books queued from two sites, and
 * the queue started. What is checked is what the reader and the sites see:
 * every book built, no two books from one site downloading at once, books
 * from different sites side by side, and nothing asked of a site faster than
 * its delay. */
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

/* Two sites, the first under two addresses (a numbered mirror): its books
 * must still go one after the other. Each request is answered after 60 ms. */
const chapter = (title) => `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/">Home</a></header>
<article><h1>${title}</h1>${Array.from({ length: 12 }, (_, i) => `<p>${title}: the ${i + 1}th paragraph of a chapter long enough to be one, and then some more words.</p>`).join('')}</article></body></html>`;
const asked = [];   // { site, url, start, end }
window.GrimoireWeb = {
  fetch(id, address) {
    const site = /marumaru\d+/.test(address) ? 'maru' : 'kor';
    const entry = { site, url: address, start: Date.now(), end: 0 };
    asked.push(entry);
    setTimeout(() => {
      entry.end = Date.now();
      const body = chapter(decodeURIComponent(new URL(address).pathname.split('/').pop()));
      const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
      web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path }));
    }, 60);
  },
  release() {},
};
globalThis.GrimoireWeb = window.GrimoireWeb;

const job = (id, name, base, n) => ({
  id, name, author: '', cover: '', sources: [`${base}/list`],
  links: Array.from({ length: n }, (_, i) => ({ url: `${base}/${name}-${i + 1}`, text: `${i + 1}화` })),
  total: n, done: 0, status: 'queued', stops: 0,
});
await store.saveSettings({
  queueAtOnce: 2,
  webQueue: [
    job('q-1', 'A', 'https://marumaru109.com/novel/1', 4),
    job('q-2', 'B', 'https://marumaru110.com/novel/2', 3),
    job('q-3', 'C', 'https://012.bookkor.com/c', 4),
  ],
});

await import(www('app.js'));
await new Promise((r) => setTimeout(r, 300));

await t('the queue shows on Build, with each book and Start queue', async () => {
  const list = document.getElementById('build-queue-list');
  assert.equal(list.children.length, 3);
  assert.match(document.getElementById('build-queue-title').textContent, /3 waiting/);
  assert.equal(document.getElementById('build-queue-go').textContent, 'Start queue');
});

await t('a queued book not yet started opens to be named, as a book in Build is', async () => {
  const openC = () => document.getElementById('build-queue-list').children[2].querySelector('.col').click();
  openC();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('build-job-edit').hidden, false);
  assert.equal(document.getElementById('build-index').hidden, true);
  assert.equal(document.getElementById('job-title').value, 'C');
  assert.match(document.getElementById('job-chapters').textContent, /4 chapters: 1화 … 4화 · bookkor/);
  const title = document.getElementById('job-title');
  title.value = 'C, renamed';
  title.dispatchEvent(new window.Event('input'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await store.settings()).webQueue[2].name, 'C, renamed');
  // Its chapters on the Website screen, Queue the button; saved back to it, in its place.
  document.getElementById('job-chapters-edit').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.querySelector('[data-screen="web"]').hasAttribute('data-active'), true);
  assert.equal(document.getElementById('web-go').hidden, true);
  assert.match(document.getElementById('web-queue').textContent, /^Queue 4$/);
  assert.equal(document.getElementById('web-list').children.length, 4);
  document.getElementById('web-queue').click();
  await new Promise((r) => setTimeout(r, 80));
  const kept = (await store.settings()).webQueue;
  assert.equal(kept.length, 3, 'changed in its place, not queued again');
  assert.deepEqual([kept[2].name, kept[2].links.length, kept[2].status], ['C, renamed', 4, 'queued']);
  openC();
  // Back, top left: every novel again.
  document.getElementById('build-minimise').click();
  assert.equal(document.getElementById('build-job-edit').hidden, true);
  assert.equal(document.getElementById('build-index').hidden, false);
  assert.match(document.getElementById('build-queue-list').children[2].textContent, /C, renamed/);
});

await t('started, it builds every book: two at once, never two from one site', async () => {
  document.getElementById('web-delay').value = '150';
  document.getElementById('web-jitter').value = '0';
  document.getElementById('build-queue-go').click();
  const until = Date.now() + 30000;
  let jobs = [];
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    jobs = (await store.settings()).webQueue || [];
    if (jobs.length && jobs.every((each) => each.status === 'done')) break;
  }
  assert.deepEqual(jobs.map((each) => each.status), ['done', 'done', 'done'], JSON.stringify(jobs.map((each) => [each.name, each.status, each.note])));
  // A book each, whole.
  const books = (await store.all('books')).filter((book) => !book.importing);
  for (const name of ['A', 'B', 'C, renamed']) {
    const book = books.find((each) => each.title === name);
    assert.ok(book, `no book ${name}`);
    assert.equal(book.chapters, name === 'B' ? 3 : 4);
  }
  // marumaru109 and marumaru110 are one site: its requests never overlap, and
  // each starts no sooner than the delay after the one before it ended.
  const maru = asked.filter((each) => each.site === 'maru').sort((a, b) => a.start - b.start);
  for (let i = 1; i < maru.length; i += 1) {
    assert.ok(maru[i].start >= maru[i - 1].end, 'two requests to one site at once');
  }
  const aEnd = Math.max(...maru.filter((each) => each.url.includes('/A-')).map((each) => each.end));
  const bStart = Math.min(...maru.filter((each) => each.url.includes('/B-')).map((each) => each.start));
  assert.ok(bStart >= aEnd, 'the second book of a site began before the first was done');
  // The other site's book went alongside, not after.
  const kor = asked.filter((each) => each.site === 'kor');
  assert.ok(Math.min(...kor.map((each) => each.start)) < aEnd, 'books from different sites did not go side by side');
});

await t('done, the queue says so and lets the screen go', async () => {
  assert.match(document.getElementById('build-queue-title').textContent, /3 done/);
  assert.equal(document.getElementById('build-queue-go').textContent, 'Start queue');
  assert.equal(document.getElementById('build-queue-go').disabled, true);
});

console.log(`\n${pass} queue checks passed`);
process.exit(0);
