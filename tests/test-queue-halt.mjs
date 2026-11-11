/* The queue when a site says stop: that book waits for the reader, and the
 * other book from its site with it; the other site's book goes on. Retried,
 * the book carries on from where it stopped, as one book. */
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
let blockedOnce = false;
window.GrimoireWeb = {
  fetch(id, address) {
    const site = /marumaru\d+/.test(address) ? 'maru' : 'kor';
    const entry = { site, url: address, start: Date.now(), end: 0 };
    asked.push(entry);
    // The first site blocks the third chapter of A, once.
    if (address.endsWith('/A-3') && !blockedOnce) {
      blockedOnce = true;
      setTimeout(() => web.settleWeb(id, false, 'Cloudflare has blocked this connection to the site'), 30);
      return;
    }
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
const jobsNow = async () => (await store.settings()).webQueue || [];
const waitFor = async (test, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const jobs = await jobsNow();
    if (test(jobs)) return jobs;
    await new Promise((r) => setTimeout(r, 150));
  }
  return jobsNow();
};

await t("blocked: that book needs the reader, its site's other book waits, the other site goes on", async () => {
  document.getElementById('web-delay').value = '100';
  document.getElementById('web-jitter').value = '0';
  document.getElementById('build-queue-go').click();
  const jobs = await waitFor((all) => all[2]?.status === 'done' && all[0]?.status === 'attention');
  assert.deepEqual(jobs.map((each) => each.status), ['attention', 'queued', 'done'], JSON.stringify(jobs.map((each) => [each.name, each.status, each.note])));
  assert.equal(jobs[0].links.length, 2, 'the rest of A is kept: chapters 3 and 4');
  assert.ok(!asked.some((each) => each.url.includes('/B-')), 'B was asked of a site that had said stop');
  const rows = [...document.getElementById('build-queue-list').children];
  assert.match(rows[0].textContent, /Needs you/);
  assert.match(rows[1].textContent, /its site needs you/);
});

await t("retried, it carries on as one book, and the site's other book follows", async () => {
  const retry = [...document.getElementById('build-queue-list').children[0].querySelectorAll('button')]
    .find((button) => button.textContent === 'Retry');
  retry.click();
  const jobs = await waitFor((all) => all.every((each) => each.status === 'done'));
  assert.deepEqual(jobs.map((each) => each.status), ['done', 'done', 'done']);
  const books = (await store.all('books')).filter((book) => !book.importing && !book.binnedAt && !book.deletedAt && !book.inBin);
  const a = books.filter((book) => book.title === 'A');
  assert.equal(a.at(-1).chapters, 4, 'A carried on to its end');
  assert.equal(jobs[0].bookId, a.at(-1).id);
});

console.log(`\n${pass} queue checks passed`);
process.exit(0);
