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
/* A book cut off by an update: on the shelf with its first two chapters, the
 * rest kept as a leftover -- shown above every view, and queued from there. */
const cut = await store.add('books', { title: 'D', fingerprint: 'built:d', addedAt: 1, chapters: 2, words: 40 });
for (let i = 0; i < 2; i += 1) {
  await store.put('chapters', { bookId: cut, index: i, title: `${i + 1}화`, words: 20, html: `<p>D chapter ${i + 1}</p>`, from: `https://sleepy.example/d/D-${i + 1}` });
}
await store.saveSettings({
  webLeftovers: [{ id: 'left-1', name: 'D — from 3화', bookId: cut, bookTitle: 'D', author: '', sources: ['https://sleepy.example/d'],
    links: [{ url: 'https://sleepy.example/d/D-3', text: '3화' }, { url: 'https://sleepy.example/d/D-4', text: '4화' }],
    pictures: false, gap: 150, jitter: 0, reason: 'cut off when the app closed', at: 1 }],
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

await t('a book that stopped shows above every view, and goes to the queue first', async () => {
  // Build empty, novels queued: it opens on every novel -- and the stopped book is there too.
  document.querySelector('[data-go="workshop"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(document.getElementById('build-index').hidden, false);
  const box = document.getElementById('build-leftovers');
  assert.ok(!box.closest('#build-detail'), 'the stopped book is hidden with the book view');
  assert.match(box.textContent, /“D” stopped at 3화/);
  box.querySelector('[data-queue]').click();
  await new Promise((r) => setTimeout(r, 50));
  const jobs = (await store.settings()).webQueue;
  assert.deepEqual([jobs[0].name, jobs[0].bookId, jobs[0].links.length], ['D', cut, 2]);
  assert.equal((await store.settings()).webLeftovers.length, 0);
  assert.match(document.getElementById('build-queue-list').children[0].textContent, /2 chapters to come, carrying its book on/);
});

await t('the queue shows on Build, with each book and Start queue', async () => {
  const list = document.getElementById('build-queue-list');
  assert.equal(list.children.length, 4);
  // Locked, nothing is removed or moved; still opened to be named. Unlocked again, as it was.
  const buttons = () => [...list.querySelectorAll('button')].map((b) => b.title).filter(Boolean);
  assert.ok(buttons().includes('Remove from the queue'));
  document.getElementById('build-queue-lock').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(document.getElementById('build-queue-lock').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(buttons(), []);
  assert.equal((await store.settings()).queueLocked, true);
  assert.ok(list.children[3].querySelector('.col.editable'), 'a locked queue cannot be opened to be named');
  document.getElementById('build-queue-lock').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(buttons().includes('Move up') && buttons().includes('Remove from the queue'));
  assert.equal((await store.settings()).queueLocked, false);
  assert.match(document.getElementById('build-queue-title').textContent, /4 waiting/);
  assert.equal(document.getElementById('build-queue-go').textContent, 'Start queue');
});

await t('a queued book not yet started opens to be named, as a book in Build is', async () => {
  const openC = () => document.getElementById('build-queue-list').children[3].querySelector('.col').click();
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
  assert.equal((await store.settings()).webQueue[3].name, 'C, renamed');
  // Its folder, picked as a book's is: a new one, typed.
  const folders = document.getElementById('job-folder');
  [...folders.querySelectorAll('.chip')].find((chip) => /New folder/.test(chip.textContent)).click();
  const named = folders.querySelector('input');
  named.value = 'Novels/Korean';
  named.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await store.settings()).webQueue[3].folder, 'Novels/Korean');
  // Its chapters on the Website screen, Queue the button; saved back to it, in its place.
  document.getElementById('job-chapters-edit').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.querySelector('[data-screen="web"]').hasAttribute('data-active'), true);
  assert.equal(document.getElementById('web-go').hidden, true);
  assert.match(document.getElementById('web-queue').textContent, /^Queue 4$/);
  assert.equal(document.getElementById('web-list').children.length, 4);
  // Its cover, chosen here too: a picture of the reader's own goes with it to the queue.
  assert.equal(document.getElementById('web-cover-field').closest('[hidden]'), null);
  assert.match(document.getElementById('web-cover-note').textContent, /gave no picture/);
  const image = window.Image;
  window.Image = globalThis.Image = class { set src(v) { this.naturalWidth = 60; this.naturalHeight = 90; setTimeout(() => this.onload?.(), 0); } };
  const click = window.HTMLInputElement.prototype.click;
  window.HTMLInputElement.prototype.click = function pick() {
    if (this.type !== 'file') return click.call(this);
    Object.defineProperty(this, 'files', { value: [new window.File([new Uint8Array(3000).fill(7)], 'c.png', { type: 'image/png' })] });
    this.onchange();
  };
  document.getElementById('web-cover-pick').click();
  await new Promise((r) => setTimeout(r, 80));
  window.HTMLInputElement.prototype.click = click;
  window.Image = globalThis.Image = image;
  assert.ok(document.querySelector('#web-cover img'), 'the picture chosen is not shown');
  assert.equal(document.getElementById('web-cover-pick').getAttribute('aria-pressed'), 'true');
  assert.match(document.getElementById('web-cover-note').textContent, /Your own picture/);
  document.getElementById('web-queue').click();
  await new Promise((r) => setTimeout(r, 80));
  const kept = (await store.settings()).webQueue;
  assert.equal(kept.length, 4, 'changed in its place, not queued again');
  assert.deepEqual([kept[3].name, kept[3].links.length, kept[3].status], ['C, renamed', 4, 'queued']);
  assert.match(kept[3].coverData || '', /^data:image\/png;base64,/);
  openC();
  // Back, top left: every novel again.
  document.getElementById('build-minimise').click();
  assert.equal(document.getElementById('build-job-edit').hidden, true);
  assert.equal(document.getElementById('build-index').hidden, false);
  assert.match(document.getElementById('build-queue-list').children[3].textContent, /C, renamed/);
});

await t('started, it builds every book: two at once, never two from one site', async () => {
  // The usual delays (no site in the box): every queued site here has none of its own.
  document.getElementById('web-delay').value = '150';
  document.getElementById('web-delay').dispatchEvent(new window.Event('change'));
  document.getElementById('web-jitter').value = '0';
  document.getElementById('web-jitter').dispatchEvent(new window.Event('change'));
  document.getElementById('build-queue-go').click();
  const until = Date.now() + 30000;
  let jobs = [];
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    jobs = (await store.settings()).webQueue || [];
    if (jobs.length && jobs.every((each) => each.status === 'done')) break;
  }
  assert.deepEqual(jobs.map((each) => each.status), ['done', 'done', 'done', 'done'], JSON.stringify(jobs.map((each) => [each.name, each.status, each.note])));
  // A book each, whole.
  const books = (await store.all('books')).filter((book) => !book.importing);
  // D carried on: one book of four chapters, the cut-off one binned.
  const d = books.filter((each) => each.title === 'D' && each.chapters === 4);
  assert.equal(d.length, 1, JSON.stringify(books.filter((each) => each.title === 'D').map((each) => [each.id, each.chapters, each.binnedAt || each.inBin || ''])));
  for (const name of ['A', 'B', 'C, renamed']) {
    const book = books.find((each) => each.title === name);
    assert.ok(book, `no book ${name}`);
    assert.equal(book.chapters, name === 'B' ? 3 : 4);
  }
  // Each filed where it was asked to be: C in its folder, the rest as they were queued.
  assert.equal(books.find((each) => each.title === 'C, renamed').folder, 'Novels/Korean');
  assert.equal(books.find((each) => each.title === 'A').folder || '', '');
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
  assert.match(document.getElementById('build-queue-title').textContent, /4 done/);
  assert.equal(document.getElementById('build-queue-go').textContent, 'Start queue');
  assert.equal(document.getElementById('build-queue-go').disabled, true);
});

await t("a queued book's line is said again in place, not the list drawn anew, while one downloads", async () => {
  const app = (await import('node:fs')).readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  const track = app.slice(app.indexOf('function trackJob('), app.indexOf('function paintJobLine('));
  assert.ok(!/paintQueue\(\)/.test(track), 'the list is drawn anew at every step of a download');
  assert.match(track, /paintJobLine\(job\);/);
  // The whole row is the tap; a book under way says why it does not open.
  assert.match(app, /row\.onclick = \(event\) => \{\s+if \(event\.target\.closest\('button'\)\) return;/);
  assert.match(app, /toast\('Downloading now — once it is done, change its name or cover on the shelf\.'\)/);
  // A slip in showing progress never stops a download.
  assert.match(app, /try \{ trackJob\(job, under, message, at, now, counts\); \} catch/);
});

await t("each site's delays are remembered, and come back with its address", async () => {
  const address = document.getElementById('web-address');
  const field = (id) => document.getElementById(id);
  const type = (id, value) => { field(id).value = value; field(id).dispatchEvent(new window.Event('change')); };
  const paste = (text) => { address.value = text; address.dispatchEvent(new window.Event('input')); };
  paste('https://marumaru109.com/novel/1');
  assert.match(field('web-site-delays').textContent, /marumaru is new/);
  type('web-delay', '12000');
  type('web-list-delay', '7000');
  let kept = (await store.settings()).siteDelays;
  assert.deepEqual([kept.marumaru.gap, kept.marumaru.listGap], [12000, 7000]);
  assert.match(field('web-site-delays').textContent, /remembered for marumaru/);
  // A site not seen before: the usual ones, untouched by marumaru's. One queued
  // before keeps what it was queued at.
  paste('https://fresh.example/x');
  assert.equal(field('web-delay').value, '150');
  paste('https://012.bookkor.com/c');
  assert.ok(kept.bookkor || (await store.settings()).siteDelays.bookkor, 'a site queued kept no delays');
  // A mirror of the first: its delays again.
  paste('https://marumaru110.com/novel/2');
  assert.deepEqual([field('web-delay').value, field('web-list-delay').value], ['12000', '7000']);
  // Read in the browser, said for the site and kept for it (and its mirrors).
  assert.equal(field('web-in-browser-row').hidden, false);
  field('web-in-browser').checked = true;
  field('web-in-browser').dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual((await store.settings()).browserSites, { marumaru: true });
  paste('https://fresh.example/x');
  assert.equal(field('web-in-browser').checked, false);
  paste('https://marumaru109.com/novel/1');
  assert.equal(field('web-in-browser').checked, true);
  field('web-in-browser').checked = false;
  field('web-in-browser').dispatchEvent(new window.Event('change'));
  // Nothing in the box: the usual ones, and the usual ones are what is changed.
  paste('');
  assert.equal(field('web-in-browser-row').hidden, true);
  assert.equal(field('web-delay').value, '150');
  assert.equal(field('web-site-delays').hidden, true);
  kept = await store.settings();
  assert.equal(kept.webDelay, 150);
  // The queue goes at each site's own.
  const app = (await import('node:fs')).readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /gap: delaysFor\(siteOfJob\(job\)\)\.gap, jitter: delaysFor\(siteOfJob\(job\)\)\.jitter,/);
  assert.match(document.getElementById('build-queue-note').textContent, /Each site at its own remembered delay/);
});

await t('per site set to two: two books of one site side by side, and no more', async () => {
  const chips = [...document.querySelectorAll('#build-queue-once .chip')];
  const perSite = chips.filter((chip) => /^\d$/.test(chip.textContent)).slice(6);
  assert.deepEqual(perSite.map((chip) => chip.textContent), ['1', '2', '3']);
  perSite[1].click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await store.settings()).queuePerSite, 2);
  asked.length = 0;
  const jobs = (await store.settings()).webQueue.filter((each) => each.status !== 'done');
  await store.saveSettings({ webQueue: [...jobs] });
  document.querySelector('[data-go="workshop"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // Three books of one site, queued from the Website screen's way in.
  const app = (await import('node:fs')).readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(\(busy\.get\(site\) \|\| 0\) >= queueState\.perSite \|\| held\.has\(site\)\) continue;/);
  // One of a site stopped by it: the others of that site stop with it, and wait (not paused by hand).
  assert.match(app, /if \(under\) \{ under\.siteStop = true; under\.pausing = true; \}/);
  assert.match(app, /settleJob\(job, outcome, under\.pausing && !under\.siteStop\);/);
  perSite[0].click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await store.settings()).queuePerSite, 1);
});

await t('picked in the site: a chapter passed over in the drag, and the page\'s chapters left out, are said', async () => {
  const fetchBefore = window.GrimoireWeb.fetch;
  const picked = [1, 2, 3, 4, 5, 7, 8].map((n) => ({ url: `https://pick.example/b/${n}`, text: `${n}화` }));
  const listed = Array.from({ length: 10 }, (_, i) => `${i + 1}화`);
  window.GrimoireWeb.pickFromSite = (id, url) => setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url, title: 'B', links: picked, listed })), 0);
  const address = document.getElementById('web-address');
  address.value = 'https://pick.example/b';
  address.dispatchEvent(new window.Event('input'));
  document.getElementById('web-pick').checked = true;
  document.getElementById('web-find').click();
  await new Promise((r) => setTimeout(r, 300));
  const gaps = document.getElementById('web-gaps');
  assert.equal(gaps.hidden, false);
  assert.match(gaps.textContent, /1 chapter missing between 1 and 8: 6\. Passed over in the drag/);
  assert.match(gaps.textContent, /The site's page lists 1–10; 3 of them not picked: 6, 9–10\./);
  // Its folder, picked beside the delays, goes with it to the queue.
  const box = document.getElementById('web-folder');
  assert.ok(box.querySelector('.chip'), 'no folders to pick from beside the delays');
  [...box.querySelectorAll('.chip')].find((chip) => /New folder/.test(chip.textContent)).click();
  const named = box.querySelector('input');
  named.value = 'From the web';
  named.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  document.getElementById('web-queue').click();
  await new Promise((r) => setTimeout(r, 80));
  const queued = (await store.settings()).webQueue.at(-1);
  assert.deepEqual([queued.name, queued.folder], ['B', 'From the web']);
  document.getElementById('web-pick').checked = false;
  delete window.GrimoireWeb.pickFromSite;
  window.GrimoireWeb.fetch = fetchBefore;
});

await t('automatic backups: a folder chosen once, written on schedule and after the queue, the newest few kept', async () => {
  const panels = await import(www('panels.js'));
  let folder = '';
  const staged = new Map();
  const written = [];
  window.GrimoireNative = {
    ...(window.GrimoireNative || {}),
    beginExport: (name) => { staged.set(name, []); return name; },
    appendExport: (handle, b64) => { staged.get(handle).push(Buffer.from(b64, 'base64')); return true; },
    chooseBackupFolder: () => setTimeout(() => { folder = 'Backups'; window.Grimoire.backupFolderChosen('Backups'); }, 0),
    backupFolderName: () => folder,
    writeBackup: (handle, keep) => {
      written.push({ name: handle, keep, json: JSON.parse(Buffer.concat(staged.get(handle)).toString('utf8')) });
      setTimeout(() => window.Grimoire.backupWritten(true, handle), 0);
    },
  };
  const host = document.createElement('div');
  await panels.openVault(() => {}, host);
  const block = host.querySelector('.auto-backup');
  assert.ok(block, 'no automatic backups in Settings');
  assert.match(block.textContent, /into a folder you choose/);
  const chip = (text) => [...block.querySelectorAll('.chip')].find((c) => c.textContent === text);
  // Every week, with no folder yet: the folder is asked for first; then due (none made yet), one is made.
  chip('Week').click();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(folder, 'Backups');
  assert.equal(written.length, 1, 'none made once it was due');
  assert.match(written[0].name, /^quire-backup-auto-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  assert.equal(written[0].json.format, 'grimoire-backup');
  assert.equal(written[0].keep, 5);
  const kept = (await store.settings()).autoBackup;
  assert.equal(kept.every, 'week');
  assert.ok(Date.now() - kept.lastAt < 5000);
  assert.match(block.textContent, /On · into “Backups” · the newest 5 kept · last /);
  // Not due again within the week: none more.
  block.querySelector('.chip[aria-pressed="true"]');
  chip('10').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(written.length, 1);
  // By hand, now: keeping ten.
  [...block.querySelectorAll('button')].find((b) => b.textContent === 'Back up now').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(written.length, 2);
  assert.equal(written[1].keep, 10);
  // When the queue finishes, if asked.
  chip('When the queue finishes').click();
  await new Promise((r) => setTimeout(r, 100));
  const app = (await import('node:fs')).readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /notifyBuild\(\{ title: 'Queue done', text: message \}\);\s+letScreenGo\(\);\s+autoBackups\.afterQueue\(\);/);
  // A write that fails is said once, and kept to show.
  window.GrimoireNative.writeBackup = () => setTimeout(() => window.Grimoire.backupWritten(false, 'the backup folder can no longer be written — choose it again'), 0);
  [...block.querySelectorAll('button')].find((b) => b.textContent === 'Back up now').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.match((await store.settings()).autoBackup.lastError, /can no longer be written/);
  assert.match(block.textContent, /last try failed: the backup folder can no longer be written/);
  // The native side: the folder's permission kept; only automatic backups ever removed.
  const java = (await import('node:fs')).readFileSync(new URL('../app/src/main/java/com/grimoire/ereader/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /takePersistableUriPermission\(tree,/);
  assert.match(java, /name\.startsWith\(AUTO_BACKUP_PREFIX\) && name\.endsWith\("\.json"\)/);
  assert.match(java, /private static final String AUTO_BACKUP_PREFIX = "quire-backup-auto-";/);
});

await t('two settings saved at once both stay saved', async () => {
  await Promise.all([store.saveSettings({ testOne: 1 }), store.saveSettings({ testTwo: 2 }), store.saveSettings({ testThree: 3 })]);
  const kept = await store.get('settings', 'app');
  assert.deepEqual([kept.value.testOne, kept.value.testTwo, kept.value.testThree], [1, 2, 3]);
});

console.log(`\n${pass} queue checks passed`);
process.exit(0);
