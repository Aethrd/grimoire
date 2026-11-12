/* Per site set to two: two books of one site download side by side, never a
 * third; and when the site stops one of them, the other stops with it after
 * the page under way, and waits (queued, not paused by hand). */
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

const chapter = (title) => `<!doctype html><html><head><title>${title}</title></head><body>
<article><h1>${title}</h1>${Array.from({ length: 12 }, (_, i) => `<p>${title}: the ${i + 1}th paragraph of a chapter long enough to be one, and then some more words.</p>`).join('')}</article></body></html>`;
const asked = [];   // { book, url, start, end }
let blocked = false;
window.GrimoireWeb = {
  fetch(id, address) {
    const book = new URL(address).pathname.split('/').pop().split('-')[0];
    const entry = { book, url: address, start: Date.now(), end: 0 };
    asked.push(entry);
    if (address.endsWith('/F-3') && !blocked) {
      blocked = true;
      setTimeout(() => { entry.end = Date.now(); web.settleWeb(id, false, 'Cloudflare has blocked this connection to the site'); }, 30);
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

const job = (name, base, n) => ({
  id: `q-${name}`, name, author: '', cover: '', sources: [`${base}/list`],
  links: Array.from({ length: n }, (_, i) => ({ url: `${base}/${name}-${i + 1}`, text: `${i + 1}화` })),
  total: n, done: 0, status: 'queued', stops: 0,
});
await store.saveSettings({
  queueAtOnce: 6,
  queuePerSite: 2,
  webDelay: 100,
  webJitter: 0,
  webQueue: [
    job('D', 'https://twin.example/d', 5), job('E', 'https://twin.example/e', 5), job('H', 'https://www.twin.example/h', 3),
    job('F', 'https://halt.example/f', 5), job('G', 'https://halt.example/g', 8),
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
const named = (jobs, name) => jobs.find((each) => each.name === name);

await t('two of one site side by side, the third after; one stopped by its site stops the other', async () => {
  const chips = [...document.querySelectorAll('#build-queue-once .chip')].filter((chip) => /^\d$/.test(chip.textContent));
  assert.equal(chips[6 + 1].getAttribute('aria-pressed'), 'true', 'per site 2 not shown as chosen');
  document.getElementById('build-queue-go').click();
  const jobs = await waitFor((all) => ['D', 'E', 'H'].every((n) => named(all, n)?.status === 'done') && named(all, 'F')?.status === 'attention' && named(all, 'G')?.status !== 'running');
  // D and E went side by side; H only once one of them was done.
  const span = (book) => ({ from: Math.min(...asked.filter((a) => a.book === book).map((a) => a.start)), to: Math.max(...asked.filter((a) => a.book === book).map((a) => a.end)) });
  const [d, e, h] = ['D', 'E', 'H'].map(span);
  assert.ok(e.from < d.to && d.from < e.to, 'two books of one site did not go side by side');
  assert.ok(h.from >= Math.min(d.to, e.to), 'a third book of the site began while two were under way');
  // F stopped by its site; G, beside it, stopped too -- waiting, not paused by hand -- and not finished.
  assert.equal(named(jobs, 'F').status, 'attention');
  assert.equal(named(jobs, 'G').status, 'queued', JSON.stringify(jobs.map((each) => [each.name, each.status, each.note])));
  assert.ok(named(jobs, 'G').links.length > 0 && named(jobs, 'G').links.length < 8, 'G did not stop part way');
  const gAsked = asked.filter((a) => a.book === 'G').length;
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(asked.filter((a) => a.book === 'G').length, gAsked, 'G asked its site again while it was holding');
  assert.match(document.getElementById('build-queue-list').textContent, /its site needs you/);
});

console.log(`\n${pass} queue checks passed`);
process.exit(0);
