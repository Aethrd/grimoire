/* The bulk downloader: a contents page in, its links listed, the chosen ones
 * downloaded into a book. The network is a small fake site here -- the real
 * fetching is native (WebBridge.java) and has nothing to test without a
 * phone. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const web = await import(new URL('../app/src/main/assets/www/js/web.js', import.meta.url).href);
const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass++; };

/* ── a site ──────────────────────────────────────────────────────────── */

const SITE = 'https://novels.example/novel/lantern/';
const chapterPage = (n, extra = '') => `<!doctype html><html lang="en"><head><title>Chapter ${n} | NovelSite</title></head><body>
<header><a href="/">Home</a><a href="/login">Sign in</a></header>
<nav class="breadcrumbs"><a href="/novel/lantern/">The Lantern</a></nav>
<h1>NovelSite</h1>
<div class="chapter-content">
  <p><a href="/novel/lantern/chapter-${n - 1}">Previous Chapter</a> <a href="/novel/lantern/">Table of Contents</a> <a href="/novel/lantern/chapter-${n + 1}">Next Chapter</a></p>
  <p>The keeper climbed the stair for the ${n}th night and lit the lamp above the harbour.</p>
  <p>Below, the café stayed open late, and the visitors argued about the tide until morning came grey.</p>
  ${extra}
  <p>She wrote the hour in the logbook and went down again, counting the steps as she always did.</p>
</div>
<div class="comments"><p>first!!</p></div>
<footer>Copyright NovelSite</footer>
</body></html>`;

const contents = `<!doctype html><html><head><title>The Lantern - NovelSite</title>
<meta property="og:title" content="The Lantern"><meta property="og:image" content="/covers/lantern.png">
<meta name="author" content="A. Keeper"></head><body>
<header><a href="/">Home</a><a href="/ranking">Ranking</a><a href="/login">Sign in</a></header>
<h1>The Lantern</h1>
<a href="#chapters">Jump to chapters</a>
<a href="javascript:void(0)">Bookmark</a>
<ul class="chapter-list">
  <li><a href="chapter-3">Chapter 3: The Gate</a></li>
  <li><a href="chapter-2">Chapter 2: Salt</a></li>
  <li><a href="/novel/lantern/chapter-1">Chapter 1: The Stair</a></li>
  <li><a href="chapter-1">Chapter 1: The Stair</a></li>
</ul>
<a href="cover.jpg">Cover art</a>
<aside class="sidebar"><a href="/novel/other/">Other novels</a></aside>
<footer><a href="/about">About</a><a href="mailto:a@b.c">Mail</a></footer>
</body></html>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);

const pages = {
  [SITE]: { type: 'text/html; charset=utf-8', body: contents },
  [`${SITE}chapter-1`]: { type: 'text/html', body: chapterPage(1) },
  [`${SITE}chapter-2`]: { type: 'text/html', body: chapterPage(2, '<p><img src="data:image/gif;base64,R0lGOD" data-src="/img/map.png" alt="map"></p>') },
  [`${SITE}chapter-3`]: { type: 'text/html', body: chapterPage(3) },
  'https://novels.example/img/map.png': { type: 'image/png', body: PNG },
  'https://novels.example/covers/lantern.png': { type: 'image/png', body: new Uint8Array(4096).fill(7) },
};
const asked = [];
const fakeFetch = async (url) => {
  asked.push(url);
  const page = pages[url];
  if (!page) throw new Error('that page does not exist (404)');
  return { url, status: 200, type: page.type, blob: new Blob([page.body], { type: page.type.split(';')[0] }) };
};

/* ── the links ───────────────────────────────────────────────────────── */

console.log('the links on a page');

const found = web.linksOf(contents, SITE);

await t('every link is listed, once, in the order the page gives them', () => {
  const urls = found.links.map((l) => l.url);
  assert.deepEqual(urls, [
    'https://novels.example/', 'https://novels.example/ranking', 'https://novels.example/login',
    `${SITE}chapter-3`, `${SITE}chapter-2`, `${SITE}chapter-1`,
    `${SITE}cover.jpg`, 'https://novels.example/novel/other/', 'https://novels.example/about',
  ]);
  // Jumps within the page, scripts and mail are not pages.
  assert.ok(!urls.some((u) => /#|javascript|mailto/.test(u)));
});

await t('the menus are marked as menus, not dropped', () => {
  const byUrl = Object.fromEntries(found.links.map((l) => [l.url, l]));
  assert.equal(byUrl['https://novels.example/login'].chrome, true);
  assert.equal(byUrl['https://novels.example/novel/other/'].chrome, true);
  assert.equal(byUrl['https://novels.example/about'].chrome, true);
  assert.equal(byUrl[`${SITE}chapter-2`].chrome, false);
  assert.equal(byUrl[`${SITE}cover.jpg`].kind, 'picture');
});

await t('the book is named from the page, with its author and cover', () => {
  assert.equal(found.title, 'The Lantern');
  assert.equal(found.author, 'A. Keeper');
  assert.equal(found.cover, 'https://novels.example/covers/lantern.png');
});

await t('the chapters are picked out as a suggestion', () => {
  const likely = web.likelyChapters(found.links, SITE);
  assert.deepEqual([...likely].sort(), [`${SITE}chapter-1`, `${SITE}chapter-2`, `${SITE}chapter-3`]);
});

await t('a list running newest first is noticed', () => {
  const chapters = found.links.filter((l) => /chapter-/.test(l.url));
  assert.equal(web.newestFirst(chapters), true);
  assert.equal(web.newestFirst([...chapters].reverse()), false);
  assert.equal(web.newestFirst([{ text: 'Prologue' }, { text: 'Interlude' }]), false);
});

await t('turned round, the chapters change places and the menus do not', () => {
  const items = ['menu', 'c3', 'c2', 'c1', 'footer'];
  assert.deepEqual(web.reverseWhere(items, (x) => x.startsWith('c')), ['menu', 'c1', 'c2', 'c3', 'footer']);
});

await t('addresses are found in whatever was pasted', () => {
  assert.deepEqual(web.addressesIn('see https://a.example/x, and\nhttps://b.example/y).'),
    ['https://a.example/x', 'https://b.example/y']);
  assert.deepEqual(web.addressesIn('novels.example/novel/lantern'), ['https://novels.example/novel/lantern']);
  assert.deepEqual(web.addressesIn('not an address'), []);
});

await t('chapters are told by their names in more than one language', () => {
  for (const name of ['Chapter 12', 'Ch. 3 - The Gate', 'Episode 4', 'Prologue', '第十二章 归来', '12. The Gate']) {
    assert.ok(web.looksLikeChapter(name), name);
  }
  for (const name of ['Home', 'Sign in', 'Other novels', 'About us']) {
    assert.ok(!web.looksLikeChapter(name), name);
  }
});

await t('a page in an older encoding is read in it', () => {
  // "第一章" in GBK, declared by the page itself.
  const head = new TextEncoder().encode('<meta charset="gbk"><p>');
  const body = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
  const bytes = new Uint8Array([...head, ...body]);
  assert.match(web.decodePage(bytes, 'text/html'), /第一章/);
});

/* ── a page as a chapter ─────────────────────────────────────────────── */

console.log('a page as a chapter');

await t('the site is stripped off the chapter, and so are its page links', async () => {
  const { chapter } = await web.readPage({ url: `${SITE}chapter-1`, text: 'Chapter 1: The Stair' }, 0, { fetchPage: fakeFetch });
  assert.equal(chapter.title, 'Chapter 1: The Stair');
  assert.match(chapter.html, /lit the lamp above the harbour/);
  assert.match(chapter.html, /counting the steps/);
  for (const clutter of ['Previous Chapter', 'Next Chapter', 'Table of Contents', 'first!!', 'Copyright', 'Sign in']) {
    assert.ok(!chapter.html.includes(clutter), `${clutter} survived`);
  }
  assert.ok(chapter.words > 20);
});

await t('a picture loaded late by the site is fetched from where it really is', async () => {
  asked.length = 0;
  const { chapter, images } = await web.readPage({ url: `${SITE}chapter-2`, text: 'Chapter 2' }, 1, { fetchPage: fakeFetch });
  assert.ok(asked.includes('https://novels.example/img/map.png'), asked.join(' '));
  assert.equal(images.length, 1);
  assert.match(chapter.html, new RegExp(`data-img="${images[0].href}"`));
  // And left out, without leaving a hole, when pictures are not wanted.
  const plain = await web.readPage({ url: `${SITE}chapter-2`, text: 'Chapter 2' }, 1, { fetchPage: fakeFetch, pictures: false });
  assert.equal(plain.images.length, 0);
  assert.ok(!/<img/.test(plain.chapter.html));
});

/* ── the book ────────────────────────────────────────────────────────── */

console.log('the whole book');

await t('the chosen pages become one book, in the order chosen', async () => {
  const links = [
    { url: `${SITE}chapter-1`, text: 'Chapter 1: The Stair' },
    { url: `${SITE}chapter-2`, text: 'Chapter 2: Salt' },
    { url: `${SITE}chapter-3`, text: 'Chapter 3: The Gate' },
  ];
  const result = await web.downloadBook({
    title: 'The Lantern', author: 'A. Keeper', cover: 'https://novels.example/covers/lantern.png',
    links, folder: 'Serials', sources: [SITE], fetchPage: fakeFetch, gap: 0,
  });
  assert.equal(result.done, 3);
  assert.deepEqual(result.failed, []);
  const book = await store.get('books', result.bookId);
  assert.equal(book.title, 'The Lantern');
  assert.equal(book.folder, 'Serials');
  assert.equal(book.format, 'WEB');
  assert.equal(book.importing, undefined, 'left marked unfinished');
  assert.equal(book.chapterCount, 3);
  assert.equal(book.imageCount, 1);
  assert.equal(book.author, 'A. Keeper');
  // The site's picture of the book, not the map in chapter two.
  assert.equal(book.coverBytes, 4096);
  assert.deepEqual(book.webSource.pages, [SITE]);
  const chapters = (await store.byIndex('chapters', 'bookId', result.bookId)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => c.title), links.map((l) => l.text));
  const images = await store.byIndex('images', 'bookId', result.bookId);
  assert.equal(images.length, 1);
  assert.equal(images[0].chapterIndex, 1);
});

await t('a page that fails costs that page, and the book is numbered without a gap', async () => {
  const links = [
    { url: `${SITE}chapter-1`, text: 'One' },
    { url: `${SITE}missing`, text: 'Gone' },
    { url: `${SITE}chapter-2`, text: 'Two' },
  ];
  const seen = [];
  const result = await web.downloadBook({
    title: 'Holes', links, fetchPage: fakeFetch, gap: 0,
    onPage: (link, ok) => seen.push(`${link.text}:${ok}`),
  });
  assert.equal(result.done, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].text, 'Gone');
  assert.match(result.failed[0].reason, /404/);
  assert.ok(seen.includes('Gone:false') && seen.includes('Two:true'));
  const chapters = (await store.byIndex('chapters', 'bookId', result.bookId)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => [c.index, c.title]), [[0, 'One'], [1, 'Two']]);
  // The picture moved with its chapter.
  const images = await store.byIndex('images', 'bookId', result.bookId);
  assert.equal(images[0].chapterIndex, 1);
});

await t('stopping keeps what has come', async () => {
  let calls = 0;
  const result = await web.downloadBook({
    title: 'Stopped', fetchPage: fakeFetch, gap: 0,
    links: [1, 2, 3, 1, 2, 3].map((n, i) => ({ url: `${SITE}chapter-${n}`, text: `Part ${i}` })),
    stop: () => ++calls > 3,
  });
  assert.equal(result.stopped, true);
  assert.ok(result.done >= 1 && result.done < 6, String(result.done));
});

await t('nothing downloaded is no book at all', async () => {
  const before = (await store.all('books')).length;
  await assert.rejects(
    web.downloadBook({ title: 'Nothing', links: [{ url: `${SITE}nope`, text: 'x' }], fetchPage: fakeFetch, gap: 0 }),
    /None of those pages could be downloaded/);
  assert.equal((await store.all('books')).length, before);
});

/* ── the boundary ────────────────────────────────────────────────────── */

console.log('the network boundary');

await t('without the app, it says so rather than trying', async () => {
  delete window.GrimoireWeb;
  assert.equal(web.available(), false);
  await assert.rejects(web.download('https://novels.example/'), /needs the app/);
});

await t('the native side fetches only web addresses, and only when asked', () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /if \(!scheme\.equals\("http"\) && !scheme\.equals\("https"\)\)/);
  // One way in: a call from the page with an address.
  const entries = [...java.matchAll(/@JavascriptInterface\s+public \w+ (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(entries.sort(), ['fetch', 'release']);
  // And no cookies kept past the app being closed.
  assert.ok(!/SharedPreferences|getSharedPreferences/.test(java));
});

await t('the screen is reached from Build, and only from there', () => {
  const html = read('app/src/main/assets/www/index.html');
  assert.match(html, /data-screen="web"/);
  assert.match(html, /id="build-web"/);
  // The shelf's + is the file picker again, in one tap.
  assert.match(html, /<button class="icon-btn accent" data-import title="Import files">/);
  assert.ok(!/data-go="web"/.test(html), 'still offered somewhere other than Build');
  assert.ok(!/id="add-menu"/.test(html));
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /case 'web': return renderWeb\(\);/);
  assert.match(app, /settleWeb: web\.settleWeb/);
  assert.match(app, /el\('build-web'\)\.onclick = \(\) => show\('web'\);/);
  assert.match(app, /el\('web-go'\)\.onclick = addWebToBuild;/);
  // Emptied for the next one: on adding, on a build, and on Clear in Build.
  const add = app.slice(app.indexOf('async function addWebToBuild('), app.indexOf('function clearWeb('));
  assert.match(add, /clearWeb\(\);/);
  const go = app.slice(app.indexOf("el('build-go').onclick"), app.indexOf("el('build-go').onclick") + 2500);
  assert.match(go, /clearWeb\(\);/);
  assert.match(app, /el\('build-clear'\)\.onclick = \(\) => \{\n    build\.clear\(\);\n    clearWeb\(\);/);
});

/* ── into Build ──────────────────────────────────────────────────────── */

console.log('into Build');

await t('pages read for Build come in order, numbered without a gap, pictures with them', async () => {
  const pictures = [];
  // The second page is slow, the third missing: the order still holds.
  const slow = async (url) => {
    if (url.endsWith('chapter-2')) await new Promise((r) => setTimeout(r, 30));
    return fakeFetch(url);
  };
  const parsed = await web.readPages([
    { url: `${SITE}chapter-1`, text: 'One' },
    { url: `${SITE}chapter-2`, text: 'Two' },
    { url: `${SITE}missing`, text: 'Gone' },
    { url: `${SITE}chapter-3`, text: 'Three' },
  ], { fetchPage: slow, gap: 0, onImage: (image) => pictures.push(image) });
  assert.deepEqual(parsed.chapters.map((c) => [c.index, c.title]), [[0, 'One'], [1, 'Two'], [2, 'Three']]);
  assert.equal(parsed.failed.length, 1);
  assert.equal(parsed.failed[0].text, 'Gone');
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].chapterIndex, 1);
  assert.equal(parsed.imageCount, 1);
  assert.equal(parsed.format, 'WEB');
});

await t('a website is a part in Build, joined with the rest and downloaded when built', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  build.addWeb({
    name: 'The Lantern',
    links: [{ url: `${SITE}chapter-1`, text: 'One' }, { url: `${SITE}chapter-2`, text: 'Two' }, { url: `${SITE}nope`, text: 'Gone' }],
    sources: [SITE],
  });
  const [part] = build.contents();
  assert.match(build.describe(part), /From the web · 3 pages, downloaded when built · novels\.example/);
  part.web.fetchPage = fakeFetch;
  asked.length = 0;
  const { book, failed } = await build.build({ title: 'Built Lantern' });
  assert.ok(asked.includes(`${SITE}chapter-1`), 'nothing was downloaded');
  assert.equal(book.chapters, 2);
  assert.equal(failed.length, 1);
  assert.match(failed[0].name, /The Lantern: 1 page/);
  const chapters = (await store.byIndex('chapters', 'bookId', book.id)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => c.title), ['One', 'Two']);
  const images = await store.byIndex('images', 'bookId', book.id);
  assert.equal(images.length, 1);
  assert.ok(images[0].href.startsWith('p0/web/'), images[0].href);
  assert.match(chapters[1].html, new RegExp(`data-img="${images[0].href}"`));
  build.clear();
});

await t('the link list is ticked by holding and dragging, with nothing to read first', () => {
  const html = read('app/src/main/assets/www/index.html');
  assert.ok(!/web-hint/.test(html), 'the instructions are still there');
  assert.match(html, /id="build-web"/);
  const app = read('app/src/main/assets/www/js/app.js');
  const wire = app.slice(app.indexOf('function wireWeb('), app.indexOf('/* ── global wiring'));
  assert.match(wire, /list\.addEventListener\('touchmove', \(e\) => \{[\s\S]*?if \(e\.cancelable\) e\.preventDefault\(\);[\s\S]*?\}, \{ passive: false \}\);/);
  assert.match(wire, /const want = pos >= low && pos <= high \? paint\.value : paint\.was\.get\(at\);/);
});

console.log(`\n${pass} assertions passed`);
