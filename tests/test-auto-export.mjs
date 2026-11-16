/* Automatic export: every book written into a folder, kept in its folders,
 * only what changed written again, an old file deleted when its book is gone
 * or renamed -- and, asked for, every book from a website checked for new
 * chapters in the queue first, the export waiting for them. */
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The folder, as the app sees it: files by path.
const folder = new Map();
const deleted = [];
let staged = new Map();
window.GrimoireNative = {
  beginExport: (name) => { const h = `h${staged.size + 1}-${name}`; staged.set(h, []); return h; },
  appendExport: (h, b64) => { staged.get(h).push(Buffer.from(b64, 'base64')); return true; },
  autoExportFolderName: () => 'Books',
  chooseAutoExportFolder: () => window.Grimoire.autoExportFolderChosen('Books'),
  writeAutoExport: (h, path, token) => {
    folder.set(path, Buffer.concat(staged.get(h)));
    setTimeout(() => window.Grimoire.autoExportWritten(token, true, ''), 0);
  },
  deleteAutoExport: (path) => { deleted.push(path); folder.delete(path); return true; },
};
globalThis.GrimoireNative = window.GrimoireNative;

// A site: its contents page lists three chapters; each chapter a page of prose.
const base = 'https://012.bookkor.com/c';
const chapterPage = (title) => `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/">Home</a></header>
<article><h1>${title}</h1>${Array.from({ length: 12 }, (_, i) => `<p>${title}: the ${i + 1}th paragraph of a chapter long enough to be one, and then some more words.</p>`).join('')}</article></body></html>`;
const listPage = `<!doctype html><html><head><title>C</title></head><body><ul class="list">${[1, 2, 3].map((n) => `<li><a href="${base}/C-${n}">${n}화</a></li>`).join('')}</ul></body></html>`;
const asked = [];
window.GrimoireWeb = {
  fetch(id, address) {
    asked.push(address);
    setTimeout(() => {
      const body = address.endsWith('/list') ? listPage : chapterPage(decodeURIComponent(new URL(address).pathname.split('/').pop()));
      const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
      web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path }));
    }, 20);
  },
  release() {},
};
globalThis.GrimoireWeb = window.GrimoireWeb;

const prose = (n) => `<p>${Array.from({ length: 120 }, () => `word${n}`).join(' ')}.</p>`;
const book = async (title, fingerprint, folderName, extra = {}, chapters = 1) => {
  const id = await store.add('books', { title, fingerprint, addedAt: 1, chapters, words: 120 * chapters, folder: folderName, ...extra });
  for (let i = 0; i < chapters; i += 1) {
    await store.put('chapters', { bookId: id, index: i, title: `${i + 1}화`, words: 120, html: prose(i), from: extra.webSources ? `${base}/C-${i + 1}` : undefined });
  }
  return id;
};
const a = await book('Alpha', 'alpha.epub:1', 'slop');
const b = await book('Beta', 'beta.epub:2', 'nsfw');
await store.saveSettings({ hiddenFolders: ['nsfw'], autoExport: { every: 'day', lastAt: Date.now() } });

await import(www('app.js'));
await sleep(400);
const panels = await import(www('panels.js'));
const exportNow = async () => {
  const host = window.document.createElement('div');
  await panels.openVault(() => {}, host);
  const block = host.querySelector('.auto-export');
  assert.ok(block, 'no Automatic export in Settings');
  [...block.querySelectorAll('button')].find((x) => x.textContent === 'Export now').click();
  for (let i = 0; i < 100 && !(await store.settings()).autoExport?.lastAt; i += 1) await sleep(50);
  await sleep(600);
  return block;
};

await t('every book written into the folder, in its folders, hidden ones too', async () => {
  await store.saveSettings({ autoExport: { every: 'day', lastAt: 0 } });
  await exportNow();
  assert.deepEqual([...folder.keys()].sort(), ['nsfw/Beta.epub', 'slop/Alpha.epub']);
  assert.equal(folder.get('slop/Alpha.epub').subarray(0, 2).toString(), 'PK', 'not an EPUB (a zip)');
  const files = (await store.settings()).autoExport.files;
  assert.equal(files['alpha.epub:1'].path, 'slop/Alpha.epub');
});

await t('only what changed is written again; a renamed book replaces its old file; a book gone has its file deleted', async () => {
  const writes = () => [...folder.keys()].length;
  folder.clear();
  await store.saveSettings({ autoExport: { ...(await store.settings()).autoExport, lastAt: 0 } });
  await exportNow();
  assert.equal(writes(), 0, 'books that had not changed were written again');
  await store.put('books', { ...(await store.get('books', a)), title: 'Alpha Two' });
  await store.deleteBook(b);
  await store.saveSettings({ autoExport: { ...(await store.settings()).autoExport, lastAt: 0 } });
  await exportNow();
  assert.deepEqual([...folder.keys()], ['slop/Alpha Two.epub']);
  assert.deepEqual(deleted.sort(), ['nsfw/Beta.epub', 'slop/Alpha.epub']);
  assert.deepEqual(Object.keys((await store.settings()).autoExport.files), ['alpha.epub:1']);
});

await t('checked for new chapters first: in the queue, at the site\'s pace, and the export waits for them', async () => {
  const c = await book('Cee', 'built:c', '', { webSources: [`${base}/list`] }, 2);
  // Exported as it was first: carried on, the new book's file takes its place -- not deleted with the old book.
  await store.saveSettings({ autoExport: { ...(await store.settings()).autoExport, lastAt: 0 } });
  await exportNow();
  assert.ok(folder.has('Cee.epub'));
  folder.clear();
  deleted.length = 0;
  asked.length = 0;
  await store.saveSettings({ autoExport: { ...(await store.settings()).autoExport, update: true, lastAt: 0 } });
  const host = window.document.createElement('div');
  await panels.openVault(() => {}, host);
  [...host.querySelector('.auto-export').querySelectorAll('button')].find((x) => x.textContent === 'Export now').click();
  const until = Date.now() + 30000;
  while (Date.now() < until && !folder.size) await sleep(100);
  // The list read, and only the new chapter fetched.
  assert.ok(asked.includes(`${base}/list`), `asked ${JSON.stringify(asked)}`);
  assert.deepEqual(asked.filter((u) => /C-\d$/.test(u)), [`${base}/C-3`]);
  const cee = (await store.all('books')).find((x) => /Cee/.test(x.title) && !x.binnedAt);
  assert.equal(cee.chapters, 3, 'the new chapter is not in the book');
  assert.ok([...folder.keys()].some((p) => /Cee\.epub$/.test(p)), `exported ${JSON.stringify([...folder.keys()])}`);
  assert.ok(folder.has('Cee.epub') && !deleted.includes('Cee.epub'), 'the carried-on book\'s file was deleted with the old one');
  assert.equal((await store.settings()).autoExport.pending, false);
  // No check left behind in the queue.
  assert.ok(!(await store.settings()).webQueue.some((job) => job.kind === 'check'));
  assert.ok(c);
});

await t('on its schedule, only once something new has come in: a day with nothing new writes nothing', async () => {
  const scheduled = async () => {
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await sleep(4600);
    for (let i = 0; i < 60 && (await store.settings()).autoExport.pending; i += 1) await sleep(100);
    await sleep(400);
  };
  // Due a day ago, nothing new since the last export: left alone, and the day not restarted.
  const was = (await store.settings()).autoExport;
  await store.saveSettings({ autoExport: { ...was, update: false, lastAt: Date.now() - 2 * 86400e3 } });
  folder.clear();
  await scheduled();
  assert.equal(folder.size, 0, 'exported with nothing new');
  assert.ok((await store.settings()).autoExport.lastAt < Date.now() - 86400e3, 'a day with nothing new counted as an export');
  // A book imported: the next look exports it.
  await book('Delta', 'delta.epub:4', 'slop');
  await scheduled();
  for (let i = 0; i < 80 && !folder.size; i += 1) await sleep(100);
  assert.deepEqual([...folder.keys()], ['slop/Delta.epub']);
  // Counted once the export has finished, which on a slow machine is a moment after its file lands.
  for (let i = 0; i < 100 && !((await store.settings()).autoExport.lastAt > Date.now() - 60000); i += 1) await sleep(100);
  assert.ok((await store.settings()).autoExport.lastAt > Date.now() - 60000);
});

console.log(`\n${pass} checks passed`);
process.exit(0);
