/* Short chapters fetched again go through the queue, as every download from a
 * website does: queued first in line, at the site's delay, each put back in
 * its own place -- the book not added to, nor built anew. */
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
const asked = [];
window.GrimoireWeb = {
  fetch(id, address) {
    asked.push(address);
    setTimeout(() => {
      const body = chapter(decodeURIComponent(new URL(address).pathname.split('/').pop()));
      const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
      web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path }));
    }, 30);
  },
  release() {},
};
globalThis.GrimoireWeb = window.GrimoireWeb;

const base = 'https://012.bookkor.com/r';
const long = (n) => `<p>${Array.from({ length: 200 }, () => `word${n}`).join(' ')}.</p>`;
const id = await store.add('books', { title: 'R', fingerprint: 'built:r', addedAt: 1, chapters: 8, words: 1405, webSources: [`${base}/list`] });
for (let i = 0; i < 8; i += 1) {
  const short = i === 3;
  await store.put('chapters', { bookId: id, index: i, title: `${i + 1}화`, words: short ? 5 : 200,
    html: short ? '<p>Please wait, loading.</p>' : long(i), from: `${base}/R-${i + 1}` });
}
await store.saveSettings({
  webQueue: [{ id: 'q-r', kind: 'refetch', name: 'R', author: '', sources: [`${base}/list`], cover: '', bookId: id,
    links: [{ url: `${base}/R-4`, text: '4화' }], total: 1, done: 0, status: 'queued', stops: 0 }],
});

await import(www('app.js'));
await new Promise((r) => setTimeout(r, 300));

await t('a book\'s short chapters, queued, are fetched again in place: nothing added, no other book made', async () => {
  document.querySelector('[data-go="workshop"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  assert.match(document.getElementById('build-queue-list').textContent, /1 short chapter to fetch again/);
  const booksBefore = (await store.all('books')).length;
  document.getElementById('build-queue-go').click();
  const until = Date.now() + 20000;
  let jobs = [];
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    jobs = (await store.settings()).webQueue || [];
    if (jobs.every((job) => job.status === 'done')) break;
  }
  assert.deepEqual(jobs.map((job) => job.status), ['done'], JSON.stringify(jobs));
  assert.deepEqual(asked, [`${base}/R-4`]);
  const chapters = await store.byIndex('chapters', 'bookId', id);
  assert.equal(chapters.length, 8);
  assert.match(chapters[3].html, /R-4: the 1th paragraph/);
  assert.ok(chapters[3].words > 5);
  assert.equal(chapters[2].html, long(2));
  assert.equal((await store.all('books')).length, booksBefore);
  assert.ok(!(await store.get('books', id)).binnedAt);
  // The list is drawn just after the job is marked done: given a moment, on a busy machine.
  for (let wait = Date.now() + 3000; Date.now() < wait && !/Done ·/.test(document.getElementById('build-queue-list').textContent);) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(document.getElementById('build-queue-list').textContent, /Done · 1 of 1 short chapters came back longer/);
});

console.log(`\n${pass} queue checks passed`);
for (const w of [window]) try { w.close(); } catch { /* closed */ }
process.exit(0);
