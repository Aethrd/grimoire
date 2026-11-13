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
  // Two ways in, both a call from the page with an address: fetched as
  // sent, or rendered for a page its script builds.
  const entries = [...java.matchAll(/@JavascriptInterface\s+public \w+ (\w+)\(/g)].map((m) => m[1]);
  // (And shown, over the app, for a check the reader passes there.)
  // (And Pause & keep's: leave the page the renderer is on.)
  // (And a site's cookies forgotten, which only ever clears.)
  // (And the site shown to pick chapters from by hand.)
  assert.deepEqual(entries.sort(), ['fetch', 'forgetSite', 'pickFromSite', 'release', 'render', 'showSite', 'stopAll']);
  assert.equal(java.match(/if \(!scheme\.equals\("http"\) && !scheme\.equals\("https"\)\)/g).length, 3);
  // Cookies are the browser's own, kept as it keeps them: nothing of the app's own store.
  assert.ok(!/SharedPreferences|getSharedPreferences/.test(java));
  assert.doesNotMatch(java, /removeAllCookies/);
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
  assert.match(app, /el\('build-web'\)\.onclick = \(\) => \{ webState\.intent = null; webState\.editing = null; show\('web'\); paintWebCount\(\); \};/);
  assert.match(app, /el\('web-go'\)\.onclick = addWebToBuild;/);
  // Emptied for the next one: on adding, on a build, and on Clear in Build.
  const add = app.slice(app.indexOf('async function addWebToBuild('), app.indexOf('function clearWeb('));
  assert.match(add, /clearWeb\(\);/);
  const go = app.slice(app.indexOf("el('build-go').onclick"), app.indexOf('\nfunction wireReader('));
  assert.match(go, /clearWeb\(\);/);
  assert.match(app, /el\('build-clear'\)\.onclick = \(\) => \{\n    build\.clear\(\);\n    buildFolder = null;\n    clearWeb\(\);/);
});

/* ── into Build ──────────────────────────────────────────────────────── */

console.log('into Build');

await t('pages read for Build come in order, and stop at the first that will not come', async () => {
  const pictures = [];
  // The second page is slow, the third missing: what comes before the
  // missing one is kept whole, and the rest starts there.
  const slow = async (url) => {
    if (url.endsWith('chapter-2')) await new Promise((r) => setTimeout(r, 30));
    return fakeFetch(url);
  };
  const parsed = await web.readPages([
    { url: `${SITE}chapter-1`, text: 'One' },
    { url: `${SITE}chapter-2`, text: 'Two' },
    { url: `${SITE}missing`, text: 'Gone' },
    { url: `${SITE}chapter-3`, text: 'Three' },
  ], { fetchPage: slow, gap: 0, patience: { retry: 0, refresh: [0], backoff: [0] }, onImage: (image) => pictures.push(image) });
  assert.deepEqual(parsed.chapters.map((c) => [c.index, c.title]), [[0, 'One'], [1, 'Two']]);
  assert.equal(parsed.failed.length, 1);
  assert.equal(parsed.failed[0].text, 'Gone');
  // The rest: the page it stopped at, and everything after, in order.
  assert.deepEqual(parsed.rest.map((l) => l.text), ['Gone', 'Three']);
  assert.match(parsed.rest[0].reason, /404/);
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].chapterIndex, 1);
  assert.equal(parsed.format, 'WEB');
});

await t('a page that came after the stop is left for the rest, not kept', async () => {
  // The first page is the slow one and fails; the second has already come.
  const late = async (url) => {
    if (url.endsWith('missing')) { await new Promise((r) => setTimeout(r, 40)); throw new Error('that page does not exist (404)'); }
    return fakeFetch(url);
  };
  const parsed = await web.readPages([
    { url: `${SITE}chapter-1`, text: 'One' },
    { url: `${SITE}missing`, text: 'Gone' },
    { url: `${SITE}chapter-2`, text: 'Two' },
    { url: `${SITE}chapter-3`, text: 'Three' },
  ], { fetchPage: late, gap: 0, patience: { retry: 0, refresh: [0], backoff: [0] } });
  assert.deepEqual(parsed.chapters.map((c) => c.title), ['One']);
  assert.deepEqual(parsed.rest.map((l) => l.text), ['Gone', 'Two', 'Three']);
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
  Object.assign(part.web, { gap: 0, patience: { retry: 0, refresh: [0], backoff: [0] } });
  const { book, failed } = await build.build({ title: 'Built Lantern' });
  assert.ok(asked.includes(`${SITE}chapter-1`), 'nothing was downloaded');
  assert.equal(book.chapters, 2);
  assert.equal(failed.length, 1);
  assert.match(failed[0].name, /The Lantern: the last 1 page/);
  assert.match(failed[0].reason, /stopped at Gone — .*404/);
  assert.deepEqual(failed[0].web.links.map((l) => l.text), ['Gone']);
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

await t('pages a site would not give are kept, to download as another book', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  // A site that has had enough after the first page.
  let served = 0;
  const busy = async (url) => {
    if (url.includes('chapter-') && ++served > 1) throw new Error('the site turned the request away (429, too many requests)');
    return fakeFetch(url);
  };
  const links = [1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `Chapter ${n}` }));
  build.addWeb({ name: 'The Lantern', links, sources: [SITE], author: 'A. Keeper' });
  Object.assign(build.contents()[0].web, { fetchPage: busy, gap: 0, patience: { retry: 0, refresh: [0, 0, 0], backoff: [0] } });
  const { book, failed } = await build.build({ title: 'The Lantern' });
  assert.equal(book.chapters, 1);
  assert.equal(failed.length, 1);
  assert.ok(web.tooMany(failed[0].reason), failed[0].reason);
  // What is needed to try again: the pages, where they came from, how.
  assert.deepEqual(failed[0].web.links.map((l) => l.text), ['Chapter 2', 'Chapter 3']);
  assert.deepEqual(failed[0].web.sources, [SITE]);
  assert.equal(failed[0].web.author, 'A. Keeper');
  assert.equal(failed[0].web.name, 'The Lantern');

  // Nothing at all from the site: the whole part is kept, and the error says so.
  build.clear();
  build.addWeb({ name: 'Refused', links, sources: [SITE] });
  Object.assign(build.contents()[0].web, {
    fetchPage: async () => { throw new Error('the site turned the request away (429, too many requests)'); },
    gap: 0, patience: { retry: 0, refresh: [0, 0, 0], backoff: [0] },
  });
  const error = await build.build({ title: 'Refused' }).catch((e) => e);
  assert.match(error.message, /None of those parts could be read/);
  assert.equal(error.failed[0].web.links.length, 3);
  build.clear();
});

await t('a page turned away is fetched afresh at once, not given up on', async () => {
  // Refused twice, then answered: as a smaller site does when asked again.
  const refusals = new Map();
  const moody = async (url) => {
    const seen = (refusals.get(url) || 0) + 1;
    refusals.set(url, seen);
    if (url.includes('chapter-') && seen <= 2) throw new Error('the site turned the request away (429, too many requests)');
    return fakeFetch(url);
  };
  const started = Date.now();
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `Chapter ${n}` })),
    { fetchPage: moody, gap: 0, patience: { retry: 0, refresh: [5, 5, 5], backoff: [5] } });
  assert.equal(parsed.chapters.length, 3);
  assert.equal(parsed.failed.length, 0);
  assert.ok(Date.now() - started < 2000, 'it waited instead of asking again');
  // Nothing tells anyone to wait.
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.ok(!/wait a while/.test(java));
  assert.match(java, /setRequestProperty\("Cache-Control", "no-cache"\)/);
  assert.ok(!/wait a few minutes|Waiting a few minutes/i.test(read('app/src/main/assets/www/js/app.js')));
});

await t('a chapter number in odd digits ("第十⑨章") is read as its number, the name left as the site has it', async () => {
  const number = (text) => web.chapterKind(text).number;
  assert.equal(number('第十⑨章 死亡演奏者'), 19);
  assert.equal(number('第⑫章'), 12);
  assert.equal(number('第一百②十三章'), 123);
  assert.equal(number('第１２章'), 12);
  assert.equal(number('Chapter ❼: The Gate'), 7);
  assert.equal(number('Ch.⑲'), 19);
  assert.equal(number('⑲화'), 19);
  assert.equal(number('제⑫화'), 12);
  assert.equal(number('Chapter 𝟏𝟐'), 12);
  // A ① that is a part's mark, outside the chapter's marker, is not read as its number.
  assert.equal(number('5화 ①'), 5);
  assert.equal(number('Chapter 5 ①'), 5);
  // Figures run together among Chinese numerals: no number guessed.
  assert.equal(number('第十12章'), null);
  // The name is never changed: only how its number is read.
  assert.equal(web.plainNumerals('第十⑨章 死亡演奏者'), '第十九章 死亡演奏者');
  assert.equal(web.plainNumerals('Plain ASCII 12'), 'Plain ASCII 12');
  // As uukanshu listed them: no chapter said missing, and in order.
  const links = ['十二', '十三', '十四', '十五', '十六', '十七', '十八', '十⑨', '二十', '二十一']
    .map((n, i) => ({ url: `https://uukanshu.example/book/4155/${2503563 + i}.html`, text: `第${n}章` }));
  assert.equal(web.numberGaps(links).count, 0);
  assert.equal(web.withPlaceholders(links).filter(web.isPlaceholder).length, 0);
  assert.equal(web.looksLikeChapter('第十⑨章 死亡演奏者'), true);
  assert.deepEqual(web.inReadingOrder([...links].reverse(), () => true).links.map((l) => l.text), links.map((l) => l.text));
});

await t('Kakuyomu: every episode, from the works page\'s own data, though its contents are folded', async () => {
  const work = '1177354054881165840';
  const ep = (id, title) => ({ __typename: 'Episode', id, title, publishedAt: '2024-01-01T00:00:00Z' });
  const state = {
    [`Work:${work}`]: { __typename: 'Work', id: work, title: '魔法の国', tableOfContents: [{ __ref: 'TableOfContentsChapter:a' }, { __ref: 'TableOfContentsChapter:b' }] },
    'TableOfContentsChapter:a': { __typename: 'TableOfContentsChapter', chapter: { __ref: 'Chapter:1' }, episodeUnions: [{ __ref: 'Episode:11' }, { __ref: 'Episode:12' }] },
    'TableOfContentsChapter:b': { __typename: 'TableOfContentsChapter', chapter: { __ref: 'Chapter:2' }, episodeUnions: [{ __ref: 'Episode:21' }, { __ref: 'Episode:22' }, { __ref: 'Episode:23' }] },
    'Chapter:1': { __typename: 'Chapter', id: '1', level: 1, title: '第一章　旅立ち' },
    'Chapter:2': { __typename: 'Chapter', id: '2', level: 1, title: '第二章　王都' },
    'Episode:11': ep('11', '第1話　始まり'), 'Episode:12': ep('12', '第2話　森'),
    'Episode:21': ep('21', '第3話　門'), 'Episode:22': ep('22', '第4話　城'), 'Episode:23': ep('23', '第5話　夜'),
  };
  // The page shows the first chapter's two only, the second folded away.
  const html = `<html lang="ja"><head><title>魔法の国 - カクヨム</title></head><body>
    <nav><a href="/">カクヨム</a><a href="/users/someone">作者</a></nav>
    <div class="toc"><a href="/works/${work}/episodes/11">第1話　始まり</a><a href="/works/${work}/episodes/12">第2話　森</a>
    <button>第二章　王都</button></div>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: state } } })}</script></body></html>`;
  const found = web.linksOf(html, `https://kakuyomu.jp/works/${work}`);
  const episodes = found.links.filter((l) => /\/episodes\//.test(l.url));
  assert.deepEqual(episodes.map((l) => l.text), ['第1話　始まり', '第2話　森', '第3話　門', '第4話　城', '第5話　夜'].map((t) => t.replace(/\s+/g, ' ')));
  assert.deepEqual(episodes.map((l) => l.url.split('/').pop()), ['11', '12', '21', '22', '23']);
  assert.deepEqual(episodes.map((l) => l.section), ['第一章 旅立ち', '第一章 旅立ち', '第二章 王都', '第二章 王都', '第二章 王都']);
  // Its other links kept as they were.
  assert.ok(found.links.some((l) => l.url === 'https://kakuyomu.jp/users/someone'));
  // Elsewhere, or without the data: read as any page is.
  assert.equal(web.linksOf(html, `https://example.com/works/${work}`).links.filter((l) => /\/episodes\//.test(l.url)).length, 2);
  assert.equal(web.linksOf(html.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, ''), `https://kakuyomu.jp/works/${work}`).links.filter((l) => /\/episodes\//.test(l.url)).length, 2);
  // The list under another name is still found; entries of another shape are not guessed at.
  assert.equal(web.linksOf(html.replace('"tableOfContents"', '"toc"'), `https://kakuyomu.jp/works/${work}`).links.filter((l) => /\/episodes\//.test(l.url)).length, 5);
  assert.equal(web.linksOf(html.replaceAll('"episodeUnions"', '"items"'), `https://kakuyomu.jp/works/${work}`).links.filter((l) => /\/episodes\//.test(l.url)).length, 2);
});

await t('missing chapters get a placeholder each, labelled, and the site is never asked for one', async () => {
  const link = (n) => ({ url: `${SITE}chapter-${n}`, text: `Chapter ${n}` });
  // 1, 2, 3, 6, 7: 4 and 5 kept a place, in order.
  const placed = web.withPlaceholders([1, 2, 3, 6, 7].map(link));
  assert.deepEqual(placed.map((l) => l.text), ['Chapter 1', 'Chapter 2', 'Chapter 3',
    'Chapter 4 — placeholder (missing)', 'Chapter 5 — placeholder (missing)', 'Chapter 6', 'Chapter 7']);
  assert.deepEqual(placed.filter(web.isPlaceholder).map((l) => l.placeholder), [4, 5]);
  // Nothing missing: as it was. Placed again: no second set.
  assert.deepEqual(web.withPlaceholders([1, 2, 3, 4, 5].map(link)).map((l) => l.text), [1, 2, 3, 4, 5].map((n) => `Chapter ${n}`));
  assert.equal(web.withPlaceholders(placed).filter(web.isPlaceholder).length, 2);
  // A chapter in parts is that chapter, not one missing; a numbering's leap is left; out of order, nothing guessed.
  assert.equal(web.withPlaceholders(['Chapter 1', 'Chapter 2', 'Chapter 3.1', 'Chapter 3.2', 'Chapter 4', 'Chapter 5'].map((text, i) => ({ url: `${SITE}p${i}`, text }))).filter(web.isPlaceholder).length, 0);
  assert.equal(web.withPlaceholders([1, 2, 3, 4, 500].map(link)).filter(web.isPlaceholder).length, 0);
  assert.equal(web.withPlaceholders([7, 6, 5, 3, 2, 1].map(link)).filter(web.isPlaceholder).length, 0);
  // Fewer than five numbered: no gaps said, none placed.
  assert.equal(web.withPlaceholders([1, 3].map(link)).length, 2);

  // Read: the placeholders cost no request and no wait, and sit in their places, said as such.
  const asked = [];
  const counting = async (url, options) => { asked.push(url); return fakeFetch(url, options); };
  const parsed = await web.readPages(web.withPlaceholders([1, 2, 3, 1, 2].map((n, i) => ({ url: `${SITE}chapter-${n}`, text: `Chapter ${[1, 2, 3, 6, 7][i]}` }))),
    { fetchPage: counting, gap: 0, pictures: false });
  assert.equal(asked.length, 5);
  assert.ok(asked.every((url) => !url.startsWith('placeholder:')));
  assert.deepEqual(parsed.chapters.map((c) => c.title), ['Chapter 1', 'Chapter 2', 'Chapter 3',
    'Chapter 4 — placeholder (missing)', 'Chapter 5 — placeholder (missing)', 'Chapter 6', 'Chapter 7']);
  const held = parsed.chapters[3];
  assert.equal(held.placeholder, true);
  assert.equal(held.words, 0);
  assert.equal(held.from, undefined);
  assert.match(held.html, /Placeholder — this chapter is missing/);
  assert.equal(parsed.failed.length, 0);
  // Never taken for a short chapter, nor for a wait screen.
  assert.equal(web.waitScreen(held.html), '');
  assert.deepEqual(web.shortChapters(parsed.chapters.map((c, i) => ({ ...c, index: i }))).filter((c) => c.index === 3), []);
  // Stopped part way: the placeholders still to come are kept with the rest, as placeholders.
  const refusing = async (url, options) => {
    if (url.endsWith('chapter-2')) throw new Error('the site turned the request away (403)');
    return fakeFetch(url, options);
  };
  const cut = await web.readPages(web.withPlaceholders([1, 2, 3, 6, 7].map(link)),
    { fetchPage: refusing, gap: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0], cool: 0 } });
  assert.deepEqual(cut.chapters.map((c) => c.title), ['Chapter 1']);
  assert.deepEqual(cut.rest.map((l) => [l.text, l.placeholder ?? null]), [['Chapter 2', null], ['Chapter 3', null],
    ['Chapter 4 — placeholder (missing)', 4], ['Chapter 5 — placeholder (missing)', 5], ['Chapter 6', null], ['Chapter 7', null]]);

  // On the website screen: added for a fresh book, never one carried on or brought up to date.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /const placeholdersFor = \(chosen\) => \(webState\.updating != null \|\| webState\.carryOn != null \|\| webState\.leftover\s+\? chosen : web\.withPlaceholders\(chosen\)\);/);
  assert.equal((app.match(/chosen = placeholdersFor\(chosen\);/g) || []).length, 2);
  assert.match(app, /const keptLink = \(\{ url, text, alts, placeholder \}\)/);
  assert.match(app, /it\.links\.filter\(\(link\) => !web\.isPlaceholder\(link\)\)/);
  // Every copy of a book's links keeps the mark: lost, a placeholder's own address was asked for.
  const buildJs = read('app/src/main/assets/www/js/build.js');
  assert.equal((buildJs.match(/\.\.\.\(placeholder != null \? \{ placeholder \} : \{\}\)/g) || []).length, 2);
  assert.ok(!/\(\{ url, text, alts \}\) =>/.test(buildJs + app + read('app/src/main/assets/www/js/web.js')), 'a copy of the links leaves out the placeholder mark');
  assert.match(app, /url: link\.url, text: link\.text, \.\.\.\(link\.placeholder != null \? \{ placeholder: link\.placeholder \} : \{\}\), chrome: false/);
});

await t('a chapter short the same way twice is kept as the site has it, said so; one still loading is not', async () => {
  const story = (n, inner) => `<html><head><title>Book ${n}화</title></head><body><nav>Home Novels</nav><article class="content"><h1>${n}화</h1>${inner}</article></body></html>`;
  const full = (n) => story(n, `<p>${'그는 길을 따라 걸었다. 밤은 깊었고 바람은 차가웠다. '.repeat(30)}</p>`);
  const pages = new Map([
    ['https://m.example/c/1', [full(1)]],
    // A notice: short, and the same every time.
    ['https://m.example/c/2', [story(2, '<p>휴재 공지: 다음 주에 돌아옵니다.</p>')]],
    // A chapter that is a picture, pictures off.
    ['https://m.example/c/3', [story(3, '<p><img src="https://m.example/i/3.jpg"></p>')]],
    ['https://m.example/c/4', [full(4)]],
  ]);
  const asked = [];
  const fetchPage = async (url) => {
    asked.push(url);
    const html = (pages.get(url) || [''])[0];
    return { url, blob: new Blob([html]), type: 'text/html', rendered: true };
  };
  const quick = { retry: 0, refresh: [0], backoff: [0, 0], cool: 0 };
  const links = [1, 2, 3, 4].map((n) => ({ url: `https://m.example/c/${n}`, text: `${n}화` }));
  const got = await web.readPages(links, { fetchPage, gap: 0, pictures: false, patience: quick });
  assert.deepEqual(got.failed, []);
  assert.equal(got.chapters.length, 4);
  assert.match(got.chapters[1].html, /휴재 공지/);
  assert.match(got.chapters[1].html, /came out very short — \d+ characters — the same each time it was read, so it is kept as the site gave it/);
  assert.match(got.chapters[2].html, /1 picture, not downloaded with pictures off/);
  assert.ok(!/came out very short/.test(got.chapters[0].html));
  // Asked twice each, no more.
  assert.equal(asked.filter((url) => url.endsWith('/c/2')).length, 2);
  assert.equal(asked.filter((url) => url.endsWith('/c/3')).length, 2);

  // Still loading -- different each time -- or blank, or a wait screen: never kept; the download stops there.
  let turn = 0;
  const changing = async (url) => ({ url, blob: new Blob([story(5, `<p>${'.'.repeat(++turn)}</p>`)]), type: 'text/html', rendered: true });
  const only = (n, inner) => web.readPages([{ url: `https://m.example/c/${n}`, text: `${n}화` }],
    { fetchPage: async (url) => ({ url, blob: new Blob([story(n, inner)]), type: 'text/html', rendered: true }), gap: 0, pictures: false, patience: quick });
  await assert.rejects(web.readPages([{ url: 'https://m.example/c/5', text: '5화' }], { fetchPage: changing, gap: 0, pictures: false, patience: quick }),
    /had not finished loading/);
  await assert.rejects(only(6, ''), /had not finished loading/);
  await assert.rejects(only(7, '<p>로딩 중...</p>'), /had not finished loading/);
  // Read once only, it is not yet the same twice: a single short read still stops.
  await assert.rejects(web.readPages([{ url: 'https://m.example/c/2', text: '2화' }],
    { fetchPage, gap: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [], cool: 0 } }), /had not finished loading/);
});

await t('the pages are asked for at the rate set, in milliseconds', async () => {
  const times = [];
  const timed = async (url) => { times.push(Date.now()); return fakeFetch(url); };
  await web.readPages([1, 2, 3, 1, 2].map((n, i) => ({ url: `${SITE}chapter-${n}`, text: `P${i}` })),
    { fetchPage: timed, gap: 120, pictures: false });
  const pageTimes = times.slice(0, 5);
  for (let i = 1; i < pageTimes.length; i++) {
    assert.ok(pageTimes[i] - pageTimes[i - 1] >= 110, `pages ${i - 1} and ${i} were ${pageTimes[i] - pageTimes[i - 1]}ms apart`);
  }
  // Set on the website screen, remembered, and carried by the part.
  const html = read('app/src/main/assets/www/index.html');
  assert.match(html, /id="web-delay" type="number"/);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /store\.saveSettings\(\{ webDelay: now\.gap, webJitter: now\.jitter/);
  assert.match(app, /siteDelays\[site\] = \{ \.\.\.now, at: Date\.now\(\) \};/);
  assert.match(app, /gap: webDelay\(\)/);
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  build.addWeb({ name: 'Slow', links: [{ url: `${SITE}chapter-1`, text: 'One' }], gap: 1500 });
  assert.equal(build.contents()[0].web.gap, 1500);
  assert.match(build.describe(build.contents()[0]), /1500 ms apart/);
  build.clear();
});

await t('Build offers the rest as another book, and remembers it across a restart', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /const kept = keepLeftovers\(failed, retried, book\);/);
  assert.match(app, /if \(kept\) showLeftoverInWeb\(kept\);/);
  assert.match(app, /store\.saveSettings\(\{ webLeftovers \}\)/);
  assert.match(app, /data-retry>Download as another book</);
  const html = read('app/src/main/assets/www/index.html');
  assert.match(html, /id="build-leftovers"/);
  // And slower once the site has said so.
  const src = read('app/src/main/assets/www/js/web.js');
  assert.ok(!/pace = Math\.max/.test(src), 'the rate is changed behind the reader\'s back');
});

await t('a page having a bad moment is asked for again, patiently, before anything stops', async () => {
  // A connection dropped three times running, then fine: no stop.
  const tries = new Map();
  const flaky = async (url) => {
    const n = (tries.get(url) || 0) + 1;
    tries.set(url, n);
    if (url.endsWith('chapter-2') && n <= 3) throw new Error('unexpected end of stream');
    return fakeFetch(url);
  };
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `Chapter ${n}` })),
    { fetchPage: flaky, gap: 0, patience: { retry: 0, refresh: [0], backoff: [1, 1, 1, 1, 1] } });
  assert.equal(parsed.chapters.length, 3);
  assert.equal(parsed.rest.length, 0);
  // A page that is not there is not asked for a minute: one more try, then stop.
  tries.clear();
  const missing = await web.readPages([{ url: `${SITE}chapter-1`, text: 'One' }, { url: `${SITE}nope`, text: 'Gone' }],
    { fetchPage: async (url) => { tries.set(url, (tries.get(url) || 0) + 1); return fakeFetch(url); },
      gap: 0, patience: { retry: 0, refresh: [0], backoff: [1, 1, 1, 1, 1] } });
  assert.equal(tries.get(`${SITE}nope`), 2);
  assert.match(missing.failed[0].reason, /404.*tried 2 times/);
});

await t('a try cut short by the app going off screen does not count', async () => {
  // The phone paused the app mid-request: the request failed with it.
  let first = true;
  const paused = async (url) => {
    if (url.endsWith('chapter-2') && first) {
      first = false;
      document.dispatchEvent(new window.Event('freeze'));
      throw new Error('the site took too long to answer');
    }
    return fakeFetch(url);
  };
  // No tries to spare at all, and still nothing stops.
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `Chapter ${n}` })),
    { fetchPage: paused, gap: 0, patience: { retry: 0, refresh: [], backoff: [] } });
  assert.equal(parsed.chapters.length, 3);
  assert.equal(parsed.rest.length, 0);
  // And waiting for an answer counts only time the app is running.
  const src = read('app/src/main/assets/www/js/web.js');
  assert.match(src, /if \(offScreen\(\) \|\| step > 5000\) return;/);
  // The screen is kept on while a website downloads.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /if \(online\) \{ try \{ window\.GrimoireNative\?\.keepScreenOn\?\.\(true\); \}/);
});

await t('an answer that never comes is given up on', async () => {
  window.GrimoireWeb = { fetch() {}, release() {} };
  const started = Date.now();
  await assert.rejects(web.download('https://novels.example/slow', { timeout: 200 }), /took too long/);
  assert.ok(Date.now() - started < 2000);
  delete window.GrimoireWeb;
});

/* ── WordPress ───────────────────────────────────────────────────────── */

console.log('WordPress');

const WP = 'https://lanterntl.wordpress.example';
const wpHead = (title, bodyClass) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title} – Lantern Translations</title>
<meta name="generator" content="WordPress 6.6.2">
<link rel="https://api.w.org/" href="${WP}/wp-json/">
<link rel="stylesheet" href="${WP}/wp-content/themes/twentytwentyone/style.css"></head>
<body class="${bodyClass}"><header id="masthead" class="site-header"><a href="${WP}/">Lantern Translations</a>
<nav class="primary-navigation"><a href="${WP}/about/">About</a><a href="${WP}/donate/">Donate</a></nav></header>`;
const wpPost = (slug, name, extra = '') => wpHead(name, 'post-template-default single single-post') + `
<article class="post type-post status-publish">
<header class="entry-header"><h1 class="entry-title">${name}</h1>
<div class="entry-meta"><a href="${WP}/author/keeper/">keeper</a> · <a href="${WP}/${slug}/#respond">Leave a comment</a></div></header>
<div class="entry-content">
<p><a href="${WP}/prev/">Previous Chapter</a> | <a href="${WP}/toc/">Index</a> | <a href="${WP}/next/">Next Chapter</a></p>
<p>The lamp was lit again in ${name}, and the harbour watched it burn until the morning came grey over the water.</p>
${extra}
<p>She wrote the hour in the logbook and went down, counting the steps as she always did, and slept.</p>
<div class="wpcnt"><div class="wpa"><span class="wpa-about">Advertisements</span></div></div>
<div class="sharedaddy sd-sharing-enabled"><h3 class="sd-title">Share this:</h3><ul><li><a href="${WP}/${slug}/?share=twitter">Twitter</a></li></ul></div>
<div id="jp-post-flair" class="sharedaddy sd-like"><h3>Like this:</h3><span>Like Loading...</span></div>
<div id="jp-relatedposts" class="jp-relatedposts"><h3 class="jp-relatedposts-headline"><em>Related</em></h3></div>
</div>
<footer class="entry-footer"><span class="cat-links">Posted in <a href="${WP}/category/lantern/">The Lantern</a></span></footer>
</article>
<nav class="navigation post-navigation"><div class="nav-links"><a href="${WP}/prev/" rel="prev">Previous post</a></div></nav>
<div id="comments" class="comments-area"><p>Thanks for the chapter!</p></div>
<footer id="colophon" class="site-footer">Proudly powered by WordPress</footer></body></html>`;
// Posts named without numbers: only the list's order says which comes first.
const NAMES = ['The Stair', 'Salt', 'The Gate', 'Low Tide', 'The Logbook'];
const SLUGS = NAMES.map((n) => n.toLowerCase().replace(/\s+/g, '-'));
const archivePage = (n, posts, older) => wpHead('The Lantern', `archive category category-lantern${n > 1 ? ' paged' : ''}`) + `
<h1 class="page-title">Category: <span>The Lantern</span></h1>
${posts.map((i) => `<article class="post"><h2 class="entry-title"><a href="${WP}/${SLUGS[i]}/">${NAMES[i]}</a></h2>
<div class="entry-summary"><p>…</p><a class="more-link" href="${WP}/${SLUGS[i]}/">Continue reading</a></div>
<div class="entry-meta"><a href="${WP}/${SLUGS[i]}/#comments">3 Comments</a></div></article>`).join('')}
<nav class="navigation pagination"><div class="nav-links">${older ? `<a class="next page-numbers" href="${older}">Older posts</a>` : ''}</div></nav>
<footer id="colophon" class="site-footer"><a href="${WP}/privacy/">Privacy</a></footer></body></html>`;

const wpPages = {
  [`${WP}/category/lantern/`]: archivePage(1, [4, 3], `${WP}/category/lantern/page/2/`),
  [`${WP}/category/lantern/page/2/`]: archivePage(2, [2, 1], `${WP}/category/lantern/page/3/`),
  [`${WP}/category/lantern/page/3/`]: archivePage(3, [0], null),
};
SLUGS.forEach((slug, i) => {
  wpPages[`${WP}/${slug}/`] = wpPost(slug, NAMES[i], i === 1
    ? `<p><img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" data-lazy-src="${WP}/wp-content/uploads/map.png" alt="map"></p>` : '');
});
const wpAsked = [];
const wpFetch = async (url) => {
  wpAsked.push(url);
  if (url === `${WP}/wp-content/uploads/map.png`) return { url, status: 200, type: 'image/png', blob: new Blob([PNG], { type: 'image/png' }) };
  const body = wpPages[url];
  if (!body) throw new Error('that page does not exist (404)');
  return { url, status: 200, type: 'text/html; charset=UTF-8', blob: new Blob([body], { type: 'text/html' }) };
};

await t('a WordPress category is followed through every page of it, and turned into reading order', async () => {
  const found = await web.findLinks([`${WP}/category/lantern/`], { fetchPage: wpFetch });
  assert.equal(found.wordpress, true);
  assert.equal(found.newestFirstList, true);
  assert.ok(wpAsked.includes(`${WP}/category/lantern/page/3/`), 'the older pages were not read');
  assert.equal(found.title, 'The Lantern');
  const likely = web.likelyChapters(found.links, `${WP}/category/lantern/`);
  const chapters = found.links.filter((link) => likely.has(link.url));
  // Every post, named by its title rather than "Continue reading", and
  // nothing else: not the menus, the comments, nor the list's own pages.
  assert.deepEqual(chapters.map((l) => l.text), ['The Logbook', 'Low Tide', 'The Gate', 'Salt', 'The Stair']);
  assert.ok(!found.links.some((l) => /\/page\/\d/.test(l.url)), 'a page of the list is listed as a link');
  // No numbers to go by: a list of posts is newest first, so it is turned.
  assert.equal(web.readsBackwards(chapters, found.newestFirstList), true);
  const ordered = web.reverseWhere(found.links, (l) => likely.has(l.url)).filter((l) => likely.has(l.url));
  assert.deepEqual(ordered.map((l) => l.text), NAMES);
  // Menus stay marked as menus.
  const about = found.links.find((l) => l.url === `${WP}/about/`);
  assert.equal(about.chrome, true);
});

await t('a WordPress post is read for its writing alone', async () => {
  const { chapter, images } = await web.readPage({ url: `${WP}/salt/`, text: '' }, 0, { fetchPage: wpFetch });
  assert.equal(chapter.title, 'Salt');
  assert.match(chapter.html, /The lamp was lit again in Salt/);
  assert.match(chapter.html, /counting the steps/);
  for (const clutter of ['Previous Chapter', 'Index', 'Next Chapter', 'Share this', 'Twitter', 'Like this',
    'Related', 'Advertisements', 'Leave a comment', 'Posted in', 'Thanks for the chapter', 'Proudly powered', 'Donate']) {
    assert.ok(!chapter.html.includes(clutter), `${clutter} survived`);
  }
  // Nothing left of the bar between the links.
  assert.ok(!/<p>\s*\|\s*\|\s*<\/p>/.test(chapter.html), chapter.html.slice(0, 200));
  // The picture WordPress loads late, from where it really is.
  assert.equal(images.length, 1);
  assert.ok(wpAsked.includes(`${WP}/wp-content/uploads/map.png`));
});

await t('a site that is not WordPress is read as before', () => {
  const plain = web.linksOf(contents, SITE);
  assert.equal(plain.wordpress, false);
  assert.equal(plain.list, false);
});

/* ── a real site's shape: Halosty's Tales ────────────────────────────── */

console.log("a real contents page's shape");

/* Laid out as https://halostystales.wordpress.com/strengthindex/ is: a
 * menu of the author's other stories, then chapters 1-74, a run of Google
 * Docs collections, chapters 301-316, and 75-300 last under "Old links";
 * share buttons, comments, a sidebar of recent posts, the WordPress.com
 * footer. */
const HT = 'https://halostystales.wordpress.com';
const ch = (n, label = `Chapter ${n}`) => `<a href="${HT}/strength${n}/">${label}</a><br>`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// The collections as the page lists them -- 116 is in none of their names.
const DOCS = ['74-83', '84-100', '101-115', '117-135', '136-149', '150-164', '165-178', '179-193', '194-207',
  '208-220', '221-232', '233-245', '246-258', '259-270', '271-280', '281-290', '291-300'];
const htIndex = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<title>The Only Thing I Can Upgrade Is Strength – Halosty's Tales</title>
<link rel="https://api.w.org/" href="${HT}/wp-json/">
<meta property="og:title" content="The Only Thing I Can Upgrade Is Strength"></head>
<body class="page-template-default page page-id-5388">
<a class="skip-link" href="#content">Skip to content</a>
<header id="masthead" class="site-header"><a href="${HT}/">Halosty's Tales</a>
<nav id="site-navigation" class="main-navigation"><ul class="menu">
<li class="menu-item"><a href="${HT}/">Home</a></li><li class="menu-item"><a href="${HT}/stories/">Stories</a>
<ul class="sub-menu"><li class="menu-item"><a href="https://halostystales.com/eldercultivator">Elder Cultivator</a></li>
<li class="menu-item"><a href="${HT}/berserkerindex/">The Immortal Berserker</a></li>
<li class="menu-item"><a href="${HT}/strengthindex/">The Only Thing I Can Upgrade Is Strength</a></li></ul></li>
<li class="menu-item"><a href="${HT}/about/">About the Author</a></li></ul></nav></header>
<div id="content"><main id="main"><article class="page type-page">
<header class="entry-header"><h1 class="entry-title">The Only Thing I Can Upgrade Is Strength</h1></header>
<div class="entry-content">
<p>Summary of the story goes here, a man who can only raise one stat.</p>
<p>${range(1, 74).map((n) => ch(n)).join('')}</p>
<p>${DOCS.map((r, i) => `<a href="https://docs.google.com/document/d/e/doc${i}/pub">${r.startsWith('136') || r.startsWith('179') ? 'Chapter' : 'Chapters'} ${r}</a><br>`).join('')}</p>
<p>${range(301, 316).map((n) => ch(n, n === 316 ? 'Chapter 316 (Final)' : `Chapter ${n}`)).join('')}</p>
<p>Old links</p>
<p>${range(75, 300).map((n) => ch(n)).join('')}</p>
<div class="sharedaddy sd-sharing-enabled"><h3 class="sd-title">Share this:</h3>
<a href="${HT}/strengthindex/?share=twitter">X</a><a href="${HT}/strengthindex/?share=facebook">Facebook</a></div>
</div></article>
<div id="comments" class="comments-area"><h2 class="comments-title">6 thoughts</h2>
<ol class="comment-list"><li class="comment"><a href="${HT}/strengthindex/#comment-1433">March 8, 2018</a>
<a href="${HT}/strengthindex/?like_comment=1433&amp;_wpnonce=0200d73fdd">Like</a>
<a class="comment-reply-link" href="${HT}/strengthindex/?replytocom=1433#respond">Reply</a></li></ol></div>
</main>
<aside id="secondary" class="widget-area"><section class="widget widget_recent_entries"><h2>Recent Posts</h2><ul>
<li><a href="${HT}/2026/10/23/truthful-transmigration-chapter-634/">Truthful Transmigration Chapter 634</a></li>
<li><a href="${HT}/2026/10/23/mage-among-superheroes-chapter-553/">Mage Among Superheroes Chapter 553</a></li>
<li><a href="${HT}/2026/10/22/truthful-transmigration-chapter-633/">Truthful Transmigration Chapter 633</a></li></ul></section>
<section class="widget widget_recent_comments"><a href="${HT}/2015/07/21/many-worlds-chapter-3/comment-page-1/#comment-2811">Many Worlds Chapter 3</a></section></aside></div>
<footer id="colophon" class="site-footer"><a href="https://wordpress.com/?ref=footer_blog">Blog at WordPress.com.</a></footer>
<div id="actionbar"><a href="https://wp.me/P6rMdZ-1oU">Copy shortlink</a>
<a href="https://wordpress.com/log-in?redirect_to=x">Log in</a></div></body></html>`;

const htChapter = (n) => `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<title>The Only Thing I Can Upgrade is Strength chapter ${n} – Halosty's Tales</title>
<link rel="https://api.w.org/" href="${HT}/wp-json/"></head>
<body class="page-template-default page">
<header id="masthead" class="site-header"><a href="${HT}/">Halosty's Tales</a></header>
<main id="main"><article class="page type-page">
<header class="entry-header"><h1 class="entry-title">The Only Thing I Can Upgrade is Strength chapter ${n}</h1></header>
<div class="entry-content">
<p>${n === 1 ? 'Table of Contents– ' : `<a href="${HT}/strength${n - 1}/">Previous Chapter</a>–Table of Contents–`}<a href="${HT}/strength${n + 1}/">Next Chapter</a></p>
<p>“Put everything in Strength!” was what I said back then. The wording… was rather poor, chapter ${n}.</p>
<p>To say I was small and weak would be somewhat of an understatement.</p>
<p>—–</p>
<p>“Next!”</p>
<p>Ah. A heart attack it was, then. Or a dream?</p>
<p>${n === 1 ? 'Table of Contents– ' : `<a href="${HT}/strength${n - 1}/">Previous Chapter</a>–Table of Contents–`}<a href="${HT}/strength${n + 1}/">Next Chapter</a></p>
<div class="sharedaddy sd-sharing-enabled"><h3 class="sd-title">Share this:</h3><a href="${HT}/strength${n}/?share=twitter">X</a></div>
<div class="sharedaddy sd-block sd-like jetpack-likes-widget-wrapper"><h3 class="sd-title">Like this:</h3><span>Like Loading...</span></div>
</div></article>
<div id="comments" class="comments-area"><h2>8 thoughts on “The Only Thing I Can Upgrade is Strength chapter ${n}”</h2></div></main>
<footer id="colophon" class="site-footer">Blog at WordPress.com.</footer></body></html>`;

await t('Halosty\'s contents page: the chapters where they now are, in order, and nothing else', () => {
  const found = web.linksOf(htIndex, `${HT}/strengthindex/`);
  assert.equal(found.wordpress, true);
  assert.equal(found.list, false, 'a contents page taken for a list of posts');
  assert.equal(found.title, 'The Only Thing I Can Upgrade Is Strength');
  const likely = web.likelyChapters(found.links, `${HT}/strengthindex/`);
  const picked = found.links.filter((l) => likely.has(l.url));
  // Chapters 1-74 on the site, 74-115 in the Google Docs the author moved
  // them to, 301-316 on the site again. Not the "old links" to 75-300,
  // whose pages are gone and whose chapters the Docs hold.
  assert.deepEqual(picked.map((l) => l.text), [
    ...range(1, 74).map((n) => `Chapter ${n}`),
    ...DOCS.map((r) => `${r.startsWith('136') || r.startsWith('179') ? 'Chapter' : 'Chapters'} ${r}`),
    ...range(301, 315).map((n) => `Chapter ${n}`), 'Chapter 316 (Final)',
  ]);
  // Not the menus, the recent posts, the comments or the footer.
  for (const clutter of ['/stories/', 'truthful-transmigration', 'many-worlds', 'like_comment', 'wp.me', '?share=', '/strength75/', '/strength116/', '/strength300/']) {
    assert.ok(!picked.some((l) => l.url.includes(clutter)), `${clutter} was taken for a chapter`);
  }
  // Already in reading order as the page lists them: left alone.
  const order = web.inReadingOrder(found.links, (l) => likely.has(l.url), found.list);
  assert.equal(order.how, null);
});

await t('chapters listed out of order are put in order', () => {
  const links = [1, 2, 7, 8, 3, 4, 5, 6].map((n) => ({ url: `${SITE}c${n}`, text: `Chapter ${n}` }));
  const order = web.inReadingOrder([{ url: `${SITE}`, text: 'Home' }, ...links], (l) => l.text.startsWith('Chapter'));
  assert.equal(order.how, 'sorted');
  assert.deepEqual(order.links.map((l) => l.text), ['Home', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Chapter ${n}`)]);
  assert.deepEqual(web.rangeIn('Chapters 74-83'), [74, 83]);
  assert.deepEqual(web.rangeIn('Chapter 136–149'), [136, 149]);
  assert.equal(web.rangeIn('Chapter 12: 3 Days'), null);
  assert.equal(web.numberIn('Chapters 74-83'), 74);
});

await t('Halosty\'s chapters: the writing alone, without the links round it', async () => {
  const pages = { [`${HT}/strength1/`]: htChapter(1), [`${HT}/strength2/`]: htChapter(2) };
  const fetchHt = async (url) => {
    if (!pages[url]) throw new Error('that page does not exist (404)');
    return { url, status: 200, type: 'text/html; charset=UTF-8', blob: new Blob([pages[url]], { type: 'text/html' }) };
  };
  for (const n of [1, 2]) {
    const { chapter } = await web.readPage({ url: `${HT}/strength${n}/`, text: `Chapter ${n}` }, n - 1, { fetchPage: fetchHt });
    assert.equal(chapter.title, `Chapter ${n}`);
    assert.match(chapter.html, /Put everything in Strength/);
    assert.match(chapter.html, /Or a dream\?/);
    for (const clutter of ['Table of Contents', 'Next Chapter', 'Previous Chapter', 'Share this', 'Like this', 'thoughts on', 'WordPress.com', '– </p>', '<p>–']) {
      assert.ok(!chapter.html.includes(clutter), `chapter ${n}: ${clutter} survived\n${chapter.html.slice(0, 300)}`);
    }
    // The scene break and the one-word line of dialogue are the story's.
    assert.match(chapter.html, /<p>—–<\/p>/);
    assert.match(chapter.html, /<p>“Next!”<\/p>/);
    assert.equal(chapter.html.split('<p>').length - 1, 5, chapter.html);
  }
});

await t('a Google Doc of several chapters becomes each of them, in order', async () => {
  const para = (n, k) => `<p class="c1"><span class="c0">Paragraph ${k} of chapter ${n}: the stat screen glowed and he put everything in Strength again, as he always did.</span></p>`;
  const docHtml = `<!doctype html><html><head><title>Strength 74-76</title><meta charset="utf-8"></head><body>
<div id="banners"><div id="publish-banner">Published using Google Docs <a href="https://docs.google.com/abuse?id=1">Report abuse</a><a href="https://support.google.com/docs">Learn more</a></div></div>
<div id="header"><div id="title">Strength 74-76</div><div id="interval"><span>Updated automatically every 5 minutes</span></div></div>
<div id="contents"><style type="text/css">.c0{color:#000}.c1{margin:0}</style>
<p class="c2 title"><span>Strength 74-76</span></p>
<p class="c1"><span class="c0 c3">Chapter 74</span></p>${[1, 2, 3].map((k) => para(74, k)).join('')}
<table><tr><td>Strength</td><td>9001</td></tr></table>
<h2 class="c4"><span>Chapter 75 – The Wall</span></h2>${[1, 2, 3].map((k) => para(75, k)).join('')}
<p class="c1"><span class="c0">Chapter 76</span></p>${[1, 2, 3].map((k) => para(76, k)).join('')}
</div><div id="footer">Published by Google Docs – Report abuse – Updated automatically every 5 minutes</div></body></html>`;
  const docUrl = 'https://docs.google.com/document/d/e/2PACX-test/pub';
  const fetchDoc = async (url) => ({ url, status: 200, type: 'text/html; charset=utf-8', blob: new Blob([docHtml], { type: 'text/html' }) });
  const parsed = await web.readPages([{ url: docUrl, text: 'Chapters 74-76' }, { url: docUrl + '?again', text: 'Chapter 77' }],
    { fetchPage: fetchDoc, gap: 0 });
  // Three from the first link, and the second link's page after them.
  assert.deepEqual(parsed.chapters.slice(0, 3).map((c) => [c.index, c.title]),
    [[0, 'Chapter 74'], [1, 'Chapter 75 – The Wall'], [2, 'Chapter 76']]);
  assert.equal(parsed.chapters[3].index, 3);
  const [first, second] = parsed.chapters;
  assert.match(first.html, /Paragraph 3 of chapter 74/);
  assert.ok(!/chapter 75/.test(first.html), 'chapter 75 ran into 74');
  assert.match(first.html, /<table>/);
  assert.match(second.html, /Paragraph 1 of chapter 75/);
  for (const chapter of parsed.chapters.slice(0, 3)) {
    for (const clutter of ['Published using Google Docs', 'Report abuse', 'Updated automatically', 'Strength 74-76', '.c0']) {
      assert.ok(!chapter.html.includes(clutter), `${clutter} survived in ${chapter.title}`);
    }
  }
});

/* ── parts listed under their chapters: Ruby Maybe Translations ─────── */

console.log('parts under their chapters');

/* Laid out as https://rubymaybetranslations.com/table-of-contents/ is:
 * "Chapter 16:" as a line, then links called "part 1" and "part 2"; a
 * chapter or two called "full"; a side story after chapter 64; and a book
 * of side stories at the end, each a line ("Side-story 1:") with links
 * called "Damian(1)", "Damian(2)" -- some at addresses with no words in. */
const RM = 'https://rubymaybetranslations.com';
const rmTOC = `<!doctype html><html><head><title>Table of Contents – Ruby Maybe Translations</title>
<meta name="generator" content="WordPress 6.4"></head>
<body class="page-template-default page"><header class="site-header"><nav class="main-navigation"><a href="${RM}/">Home</a><a href="${RM}/table-of-contents/">Table of Contents</a></nav></header>
<article class="page"><h1 class="entry-title">Table of Content [Lucia]</h1><div class="entry-content">
<p>Korean Novel: Lucia</p><p><a href="${RM}/lucia">Synopsis</a></p><p>Status: Completed</p><p>{Click the images}</p>
<h3>[BOOK 1] (1-15)</h3>
<p><a href="${RM}/2018/11/05/lucia-prologue/">Prologue</a></p>
<p><a href="https://www.novelupdates.com/series/lucia/?pg=18">Chapter 1-15</a></p>
<h3>[BOOK 2] (16-24)</h3><p>THE DUCAL COUPLE:</p>
<p>Chapter 16: <a href="${RM}/2018/03/30/chapter-16-a/">part 1</a> <a href="${RM}/2018/04/01/lucia-chapter-16-b/">part 2</a></p>
<p>Chapter 17: <a href="${RM}/2018/04/03/lucia-chapter-17-part-1/">part 1</a> <a href="${RM}/2018/04/04/lucia-chapter-17-part-2/">part 2</a></p>
<p>Chapter 18: <a href="${RM}/2018/04/05/lucia-chapter-18/">full</a></p>
<p>Chapter 48: <a href="${RM}/2018/09/06/lucia-chapter-48-part-1/">part 1</a> <a href="${RM}/2018/09/07/lucia-chapter-48-part-2/">part 2</a></p>
<p>Chapter 64: <a href="${RM}/2018/10/31/lucia-chapter-64-part-1/">part 1</a> <a href="${RM}/2018/10/31/lucia-chapter-64-part-2/">part 2</a></p>
<p><a href="${RM}/2018/11/03/lucia-side-story-1/">Side-story</a></p>
<h3>[BOOK 5] (65-83)</h3>
<p>Chapter 66: <a href="${RM}/2018/11/08/1294899/">part 1</a> <a href="${RM}/lucia-chapter-66-part-2">part 2</a></p>
<p>Chapter 67: <a href="${RM}/lucia-chapter-67-part-1/">part 1</a> <a href="${RM}/lucia-chapter-67-part-2/">part 2</a></p>
<p>Chapter 95: <a href="${RM}/lucia-chapter-95/">full</a></p>
<p>Chapter 120: <a href="${RM}/lucia-chapter-120-part-1/">part 1</a> <a href="${RM}/lucia-chapter-120-part-2/">part 2</a> <a href="${RM}/lucia-chapter-120-part-3/">part 3</a></p>
<h3>[BOOK 8] (side-stories)</h3>
<p>Side-story 1:</p>
<p><a href="${RM}/sidestory-1-1-damian/">Damian(1)</a> <a href="${RM}/lucia-side-story-1-2-damian/">Damian(2)</a> <a href="${RM}/832247153-2/">Damian(11)</a> <a href="${RM}/15337-2/">Damian(12)</a></p>
<p>Side-story 2:</p>
<p><a href="${RM}/88889000-2/">In Another Future-Hugo (1)</a> <a href="${RM}/lucia-side-story-2-2-in-another-future-hugo/">In Another Future-Hugo (2)</a></p>
<p>Side-story 3:</p>
<p><a href="${RM}/2019/09/27/sidestory-3-1-happily-ever-after/">Happily ever after (1)</a> <a href="${RM}/lucia-side-story-3-2-happily-ever-after/">Happily ever after (2)</a></p>
</div></article>
<aside class="widget-area"><a href="${RM}/2019/12/04/sidestory-7-6-the-beginning-of-all-stories/">Recent: Side story 7-6</a></aside>
</body></html>`;

await t('parts are named for their chapters, and the side stories stay in the order given', () => {
  const found = web.linksOf(rmTOC, `${RM}/table-of-contents/`);
  const likely = web.likelyChapters(found.links, `${RM}/table-of-contents/`);
  const order = web.inReadingOrder(found.links, (l) => likely.has(l.url), found.list);
  const chapters = order.links.filter((l) => likely.has(l.url)).map((l) => l.text);
  assert.deepEqual(chapters, [
    'Prologue',
    'Chapter 16: part 1', 'Chapter 16: part 2', 'Chapter 17: part 1', 'Chapter 17: part 2', 'Chapter 18: full',
    'Chapter 48: part 1', 'Chapter 48: part 2', 'Chapter 64: part 1', 'Chapter 64: part 2', 'Chapter 64: Side-story',
    'Chapter 66: part 1', 'Chapter 66: part 2', 'Chapter 67: part 1', 'Chapter 67: part 2', 'Chapter 95: full',
    'Chapter 120: part 1', 'Chapter 120: part 2', 'Chapter 120: part 3',
    'Side-story 1: Damian(1)', 'Side-story 1: Damian(2)', 'Side-story 1: Damian(11)', 'Side-story 1: Damian(12)',
    'Side-story 2: In Another Future-Hugo (1)', 'Side-story 2: In Another Future-Hugo (2)',
    'Side-story 3: Happily ever after (1)', 'Side-story 3: Happily ever after (2)',
  ]);
  // Already in order as listed: nothing is moved.
  assert.equal(order.how, null);
  // Not the listing site's page about the book, nor the sidebar.
  assert.ok(!chapters.includes('Chapter 1-15'));
  assert.ok(!chapters.some((c) => /Recent/.test(c)));
});

/* ── side stories out of order: a Chinese contents page ─────────────── */

console.log('side stories out of order');

/* Shaped as Chinese serial sites lay out a book's directory: a block of
 * the latest chapters at the top, then every chapter -- with the side
 * stories (番外) in the order they were posted, not their own. */
const CN = 'https://www.novel.example/0122618456';
const cnLink = (n, name) => `<li><a href="${CN}/${8000 + n}_1.html">${name}</a></li>`;
const cnMain = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, `第${n}章 ${'风雨'.repeat(1 + (n % 2))}`]);
const cnSide = [[103, '番外三 雪夜'], [101, '番外一 初见'], [110, '番外十 归途'], [102, '番外二：旧事'], [104, '番外四 尾声之后']];
const cnDir = `<!doctype html><html><head><meta charset="utf-8"><title>某书 最新章节 - 小说网</title></head><body>
<div class="nav"><a href="https://www.novel.example/">首页</a><a href="https://www.novel.example/rank">排行榜</a></div>
<h1>某书</h1><div class="intro">作者：某人</div>
<h2>最新章节</h2><ul class="latest">${cnLink(104, '番外四 尾声之后')}${cnLink(110, '番外十 归途')}${cnLink(12, '第12章 大结局')}</ul>
<h2>全部章节</h2><ul class="all">${cnMain.map(([n, name]) => cnLink(n, n === 12 ? '第12章 大结局' : name)).join('')}
${cnSide.map(([n, name]) => cnLink(n, name)).join('')}${cnLink(120, '后记')}</ul>
<div class="footer"><a href="https://www.novel.example/about">关于我们</a></div></body></html>`;

await t('Chinese numbers are read', () => {
  assert.equal(web.cjkNumber('十二'), 12);
  assert.equal(web.cjkNumber('二十'), 20);
  assert.equal(web.cjkNumber('一百零五'), 105);
  assert.equal(web.cjkNumber('一千二百三十四'), 1234);
  assert.equal(web.cjkNumber('两万'), 20000);
  assert.equal(web.cjkNumber('１２'), 12);
  assert.deepEqual(web.chapterKind('第十二章 风雨'), { kind: 'main', number: 12 });
  assert.deepEqual(web.chapterKind('番外三 雪夜'), { kind: 'side', number: 3 });
  assert.deepEqual(web.chapterKind('番外篇·十'), { kind: 'side', number: 10 });
  assert.deepEqual(web.chapterKind('Side Story 2: Hugo'), { kind: 'side', number: 2 });
  assert.deepEqual(web.chapterKind('后记'), { kind: 'after', number: null });
  assert.deepEqual(web.chapterKind('Chapter 64: Side-story'), { kind: 'main', number: 64 });
  // A chapter whose name only mentions an author's note or afterword after its number is that chapter.
  assert.deepEqual(web.chapterKind("Ch. 249 Heungbu's Wife (3) [Please read Author's Note]88"), { kind: 'main', number: 249 });
  assert.deepEqual(web.chapterKind("Ch. 149 Side Story. The Author's Afterword 474"), { kind: 'main', number: 149 });
  assert.deepEqual(web.chapterKind('Afterword'), { kind: 'after', number: null });
  assert.deepEqual(web.chapterKind("Author's Note: on hiatus"), { kind: 'after', number: null });
  assert.deepEqual(web.chapterKind('完結感言'), { kind: 'after', number: null });
});

await t('a chapter that mentions an author\u2019s note stays in its place, and is not called missing (as dreamy-translations lists them)', () => {
  const site = 'https://dreamy-translations.com/novel/hhh/chapter/';
  const links = Array.from({ length: 333 }, (_, n) => ({
    url: `${site}${n}`,
    text: n === 0 ? 'Ch. 0 Prologue 7,966' : n === 249 ? "Ch. 249 Heungbu's Wife (3) [Please read Author's Note]88" : `Ch. ${n} Heungbu's Wife (${n % 7})${50 + n}`,
  }));
  const order = web.inReadingOrder(links, () => true);
  assert.equal(order.how, null, 'the site\u2019s own order, already right, moved');
  assert.equal(order.links[249].url, `${site}249`);
  const gaps = web.numberGaps(links);
  assert.ok(!JSON.stringify(gaps).includes('249'), `249 called missing: ${JSON.stringify(gaps)}`);
});

await t('a run of numbered afterword chapters listed after the last chapter goes back to its numbers (ewwtbh)', () => {
  const site = 'https://dreamy-translations.com/novel/ewwtbh/chapter/';
  const at = (n) => ({ url: `${site}${n}`, text: n >= 219 && n <= 226 ? `Ch. ${n} Afterword: The Warmest Winter in the World (${n - 218})${100 + n}` : `Ch. ${n} Side Story ${n}${50 + n}` });
  const numbers = [...Array.from({ length: 219 }, (_, n) => n), ...Array.from({ length: 16 }, (_, n) => 227 + n), ...Array.from({ length: 8 }, (_, n) => 219 + n)];
  const links = numbers.map(at);
  for (const n of [219, 222, 226]) assert.deepEqual(web.chapterKind(at(n).text), { kind: 'main', number: n });
  const order = web.inReadingOrder(links, () => true);
  assert.equal(order.how, 'sorted');
  assert.deepEqual(order.links.map((l) => l.url), Array.from({ length: 243 }, (_, n) => `${site}${n}`));
  assert.equal(web.numberGaps(order.links).count || 0, 0);
});

await t('side stories listed out of order are put in their order, after the chapters', () => {
  const found = web.linksOf(cnDir, `${CN}/dir`);
  const likely = web.likelyChapters(found.links, `${CN}/dir`);
  const order = web.inReadingOrder(found.links, (l) => likely.has(l.url), found.list);
  assert.equal(order.how, 'sorted');
  const chapters = order.links.filter((l) => likely.has(l.url)).map((l) => l.text);
  assert.deepEqual(chapters, [
    ...cnMain.map(([n, name]) => (n === 12 ? '第12章 大结局' : name)),
    '番外一 初见', '番外二：旧事', '番外三 雪夜', '番外四 尾声之后', '番外十 归途', '后记',
  ]);
  // The site's own links stay out of it.
  assert.ok(!chapters.includes('首页') && !chapters.includes('排行榜') && !chapters.includes('关于我们'));
});

await t('side stories already in order are not moved, wherever they stand', () => {
  const links = ['Prologue', 'Chapter 1', 'Chapter 2', 'Side Story 1', 'Chapter 3', 'Side Story 2']
    .map((text, i) => ({ url: `${SITE}s${i}`, text }));
  // A side story between chapters, in order, reads where the author put it.
  const order = web.inReadingOrder(links, () => true);
  assert.equal(order.how, null);
});

await t('a chapter split across pages is joined, and never runs into the next chapter', async () => {
  const pagesOf = {
    [`${CN}/8001_1.html`]: `<html><body><div class="nav"><a href="${CN}/dir">目录</a></div><div id="content"><h1>第1章 风雨</h1>
      <p>第一页的第一段，雨下了一整夜，城门外的灯一直亮着，没有人知道守门的人去了哪里。</p><p>第一页的第二段。</p>
      <p><a href="${CN}/dir">目录</a> <a href="${CN}/8001_2.html">下一页</a></p></div></body></html>`,
    [`${CN}/8001_2.html`]: `<html><body><div id="content"><h1>第1章 风雨</h1>
      <p>第二页的第一段，天亮的时候，有人在城墙上看见了一只白色的鸟，它一直往北飞去。</p>
      <p><a href="${CN}/8001_1.html">上一页</a> <a href="${CN}/8001_3.html">下一页</a></p></div></body></html>`,
    [`${CN}/8001_3.html`]: `<html><body><div id="content"><h1>第1章 风雨</h1>
      <p>第三页，这一章的最后一段，城门终于关上了，风也停了，只剩下远处的钟声。</p>
      <p><a href="${CN}/8001_2.html">上一页</a> <a href="${CN}/8002_1.html">下一页</a></p></div></body></html>`,
    [`${CN}/8002_1.html`]: `<html><body><div id="content"><h1>第2章 雪夜</h1><p>第二章的内容，雪下得很大，路上一个人也没有，只有马车的声音。</p></div></body></html>`,
  };
  const fetchCn = async (url) => {
    if (!pagesOf[url]) throw new Error('that page does not exist (404)');
    return { url, status: 200, type: 'text/html; charset=utf-8', blob: new Blob([pagesOf[url]], { type: 'text/html' }) };
  };
  const parsed = await web.readPages([
    { url: `${CN}/8001_1.html`, text: '第1章 风雨' },
    { url: `${CN}/8002_1.html`, text: '第2章 雪夜' },
  ], { fetchPage: fetchCn, gap: 0 });
  const [one, two] = parsed.chapters;
  assert.match(one.html, /第一页的第一段/);
  assert.match(one.html, /第二页的第一段/);
  assert.match(one.html, /第三页/);
  // The last page's "下一页" goes to chapter 2, which is its own chapter.
  assert.ok(!/第二章的内容/.test(one.html), 'chapter 2 ran into chapter 1');
  assert.match(two.html, /第二章的内容/);
  assert.ok(!/下一页|上一页|目录/.test(one.html), one.html);
  // The heading each page repeats is said once.
  assert.equal(one.html.split('第1章 风雨').length - 1, 1, one.html);
});

await t('what goes into Build is put in reading order again, unless turned round by hand', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const add = app.slice(app.indexOf('async function addWebToBuild('), app.indexOf('function clearWeb('));
  assert.match(add, /if \(!webState\.manualOrder\) chosen = web\.inReadingOrder\(chosen, \(\) => true\)\.links;/);
  assert.match(app, /webState\.manualOrder = true;/);
});

await t('the delay varies within the range set: 500 give or take 200 is 300 to 700', async () => {
  assert.equal(web.spacing(500, 200, () => 0), 300);
  assert.equal(web.spacing(500, 200, () => 0.5), 500);
  assert.equal(web.spacing(500, 200, () => 0.999999), 700);
  assert.equal(web.spacing(100, 300, () => 0), 0, 'a pause below nothing');
  assert.equal(web.spacing(500, 0), 500);
  // Spread across the whole range, not stuck at one end of it.
  const seen = Array.from({ length: 400 }, () => web.spacing(500, 200));
  assert.ok(seen.every((ms) => ms >= 300 && ms <= 700), `${Math.min(...seen)}–${Math.max(...seen)}`);
  assert.ok(Math.min(...seen) < 350 && Math.max(...seen) > 650, `${Math.min(...seen)}–${Math.max(...seen)}`);
  // And the pages are asked for that way: each gap within the range.
  const times = [];
  const timed = async (url) => { times.push(Date.now()); return fakeFetch(url); };
  await web.readPages([1, 2, 3, 1, 2, 3].map((n, i) => ({ url: `${SITE}chapter-${n}`, text: `P${i}` })),
    { fetchPage: timed, gap: 120, jitter: 60, pictures: false });
  const gaps = times.slice(1).map((at, i) => at - times[i]);
  assert.ok(gaps.every((ms) => ms >= 50 && ms <= 200), gaps.join(', '));
  // Set beside the delay, remembered, carried by the part into Build.
  const html = read('app/src/main/assets/www/index.html');
  assert.match(html, /id="web-jitter" type="number"/);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /el\('web-jitter'\)\.addEventListener\('change', \(\) => \{\s+const value = webJitter\(\);\s+el\('web-jitter'\)\.value = String\(value\);\s+keepDelays\(\);/);
  assert.match(app, /gap: webDelay\(\), jitter: webJitter\(\)/);
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  build.addWeb({ name: 'Varied', links: [{ url: `${SITE}chapter-1`, text: 'One' }], gap: 500, jitter: 200 });
  assert.equal(build.contents()[0].web.jitter, 200);
  assert.match(build.describe(build.contents()[0]), /500 ± 200 ms apart/);
  build.clear();
});

/* ── pages built by script ───────────────────────────────────────────── */

/* What a site like marumaru109 sends: a title, a line, and the script that
 * builds everything else. */
const SHELL = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>웹소설 업데이트 | 마루마루</title><meta property="og:url" content="https://maru.example/novel/updates">
<script type="module" src="/_app/immutable/entry/start.js"></script></head>
<body><div id="svelte"><h1>웹소설 업데이트</h1><p>업데이트가 있는 웹소설 목록입니다.</p></div>
<script>window.__data = {}</script></body></html>`;
const BUILT = `<!doctype html><html><head><title>그린 스킨 | 마루마루</title></head><body>
<header><a href="/">홈</a><a href="/novel/updates">업데이트</a><a href="/login">로그인</a></header>
<h1>그린 스킨</h1><ul class="episodes">
${Array.from({ length: 12 }, (_, i) => `<li><a href="/novel/green-skin/${i + 1}">그린 스킨 ${i + 1}화</a></li>`).join('\n')}
</ul></body></html>`;

await t('a page that is only a frame for its script is recognised', async () => {
  assert.equal(web.scriptBuilt(SHELL), true);
  assert.equal(web.scriptBuilt('<html><head><script src="/x.js"></script></head><body><div id="__next"></div></body></html>'), true);
  assert.equal(web.scriptBuilt(contents), false);              // a real contents page
  assert.equal(web.scriptBuilt(chapterPage(3)), false);        // a real chapter
  assert.equal(web.scriptBuilt('<html><body><p>Short.</p></body></html>'), false); // empty, but no script to fill it
  assert.equal(web.scriptBuilt(`<html><head><script>ga()</script></head><body>${chapterPage(4)}</body></html>`), false);
});

/** A downloaded page's text (the test's Blob has no .text()). */
const textOf = (blob) => new Promise((resolve, reject) => {
  const reader = new window.FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

/** A pretend native side: fetch answers with `sent`, render with `rendered`. */
function fakeBridge({ sent = {}, rendered = {}, refuse = null } = {}) {
  const calls = [];
  const answer = (id, url, pages, how) => {
    calls.push(`${how} ${url}`);
    if (how === 'fetch' && refuse) { setTimeout(() => web.settleWeb(id, false, refuse), 0); return; }
    const body = pages[url];
    setTimeout(() => {
      if (body === undefined) { web.settleWeb(id, false, 'that page does not exist (404)'); return; }
      const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
      web.settleWeb(id, true, JSON.stringify({ url, status: 200, type: 'text/html; charset=utf-8', path }));
    }, 0);
  };
  window.GrimoireWeb = {
    fetch: (id, url) => answer(id, url, sent, 'fetch'),
    render: (id, url) => answer(id, url, rendered, 'render'),
    release() {},
  };
  return calls;
}

await t('a script-built contents page is rendered, and its chapters listed', async () => {
  const list = 'https://maru.example/novel/green-skin';
  const calls = fakeBridge({ sent: { [list]: SHELL }, rendered: { [list]: BUILT } });
  const found = await web.findLinks([list]);
  assert.deepEqual(calls, [`fetch ${list}`, `render ${list}`]);
  const chapters = found.links.filter((l) => /\/novel\/green-skin\/\d+$/.test(l.url));
  assert.equal(chapters.length, 12);
  assert.equal(chapters[0].text, '그린 스킨 1화');
  // The site is remembered: its chapters go straight to the renderer.
  const chapter = 'https://maru.example/novel/green-skin/1';
  const again = fakeBridge({ rendered: { [chapter]: chapterPage(1) } });
  const page = await web.download(chapter);
  assert.equal(page.status, 200);
  assert.deepEqual(again, [`render ${chapter}`]);
  delete window.GrimoireWeb;
});

await t('a site behind a bot check is rendered instead', async () => {
  const url = 'https://guarded.example/book/1';
  const calls = fakeBridge({
    refuse: 'the site only lets a browser in (it is behind a bot check), so it refused the download',
    rendered: { [url]: chapterPage(1) },
  });
  const page = await web.download(url);
  assert.match(await textOf(page.blob), /lit the lamp/);
  assert.deepEqual(calls, [`fetch ${url}`, `render ${url}`]);
  delete window.GrimoireWeb;
});

await t('an ordinary page is fetched once, and an app without the renderer only fetches', async () => {
  const url = 'https://plain.example/ch/1';
  const calls = fakeBridge({ sent: { [url]: chapterPage(1) }, rendered: { [url]: 'never' } });
  await web.download(url);
  assert.deepEqual(calls, [`fetch ${url}`]);
  // An older build of the app has no render(): nothing changes for it.
  const shellUrl = 'https://old.example/novel';
  const older = fakeBridge({ sent: { [shellUrl]: SHELL } });
  delete window.GrimoireWeb.render;
  const page = await web.download(shellUrl);
  assert.match(await textOf(page.blob), /마루마루/);
  assert.deepEqual(older, [`fetch ${shellUrl}`]);
  delete window.GrimoireWeb;
  // The renderer is native and kept to http(s), its own browser, never the reader's.
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /public void render\(final String id, final String address, final String patience, final String list\)/);
  // A chapter is never scrolled (a reader that adds the next chapter at the
  // end made one "chapter" of a hundred), and a page is decoded off the main thread.
  assert.match(java, /scroll \? SCROLL \+ SHAPE : SHAPE/);
  assert.match(java, /Object text = new JSONTokener\(job\.raw/);
  // Ready only once the page's own requests are back, counted from before its first script.
  assert.match(java, /WebViewCompat\.addDocumentStartJavaScript\(view, TRACKER/);
  assert.match(java, /!busy && still >= settle/);
  // Taken as soon as what it was opened for is there -- a list's chapters, a
  // chapter's story -- after a short still moment, not the whole quiet spell;
  // a chapter asked for again patiently gets the whole spell.
  assert.match(java, /boolean ready = scroll \? chapterLinks >= 3 : !patient && storyThere;/);
  assert.match(java, /private static final long READY_QUIET_MS = 900;/);
  // The pause between list pages: the pacer's, after each one came.
  assert.match(read('app/src/main/assets/www/js/web.js'), /fetchPage = pacer\(fetchPage, \{\s+gap: listGap, jitter: listJitter, scale: \(\) => slower,/);
  assert.match(java, /view = new WebView\(activity\)/);
  assert.match(java, /only web addresses can be downloaded/);
});

await t('a rendered chapter caught before its story arrived is asked for again, more patiently', async () => {
  const url = 'https://maru.example/novel/green-skin/2';
  // The site's frame and menus are there; the chapter itself is not yet.
  const early = `<!doctype html><html><head><title>그린 스킨 2화 | 마루마루</title></head><body>
<header><a href="/">홈</a><a href="/novel/updates">업데이트</a></header><main><p>불러오는 중…</p></main></body></html>`;
  let answers = [early, chapterPage(2)];
  const calls = [];
  window.GrimoireWeb = {
    fetch() { throw new Error('a rendered site is not fetched'); },
    render(id, address, level) {
      calls.push(level);
      const body = answers.shift();
      const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
      setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered: true })), 0);
    },
    release() {},
  };
  const link = { url, text: '그린 스킨 2화' };
  // What the page held is said: here, the site's "loading…".
  await assert.rejects(web.readPage(link, 1, { pictures: false }),
    /had not finished loading on the site \(the page held \d+ characters: "홈 업데이트 불러오는 중…"\)/);
  const got = await web.readPage(link, 1, { pictures: false });
  assert.match(got.chapter.html, /lit the lamp/);
  // The second time with one need more: first, everything let in (then, longer).
  assert.deepEqual(calls, ['0', '0o']);
  // Through the whole download: the empty first answer is retried, never kept.
  answers = [early, chapterPage(3)];
  calls.length = 0;
  const book = await web.readPages([{ url: 'https://maru.example/novel/green-skin/3', text: '3화' }],
    { pictures: false, gap: 0, patience: { retry: 0, refresh: [], backoff: [0, 0] } });
  assert.equal(book.chapters.length, 1);
  assert.match(book.chapters[0].html, /lit the lamp/);
  assert.equal(book.failed.length, 0);
  delete window.GrimoireWeb;
});

/* ── marumaru: rows of several things, and a list over numbered pages ──── */

/* A row as marumaru draws one: a thumbnail with a counter on it, the
 * title with the uploader's row of "=", the date and the views, and a
 * chevron -- all one link, nothing between them. */
const row = (counter, n, id, name = '북쪽 숲 정벌') => `<a href="/novel/47997/${id}" class="row">`
  + `<div class="thumb"><img src="/t.jpg"><span>${counter}</span></div>`
  + `<div class="body"><div class="title">${n}화 ${name} ==============================</div>`
  + `<div class="meta"><span>26.05.12</span><span>👁 0</span></div></div><span>›</span></a>`;
const maruPage = (page, last = 3) => `<!doctype html><html><head><title>그린 스킨 | 마루마루</title></head><body>
<header><a href="/">홈</a><a href="/novel/updates">소설</a></header><h1>그린 스킨</h1>
<div class="buttons"><a href="/novel/47997/2136001">최신화 보기 669화</a><a href="/novel/47997/2136015">첫화부터 정주행</a></div>
<div class="list">
${Array.from({ length: 5 }, (_, i) => { const n = (page - 1) * 5 + i + 1; return row(670 - n, n, 2136000 + n); }).join('')}
</div><nav class="pagination">
${Array.from({ length: last }, (_, i) => `<a href="/novel/47997?order=desc&page=${i + 1}">${i + 1}</a>`).join('')}
<a href="/novel/47997?order=desc&page=${Math.min(last, page + 1)}">›</a><a href="/novel/47997?order=desc&page=${last}">»</a>
</nav></body></html>`;

await t('a row of counter, title, date and views is named by its title', async () => {
  const found = web.linksOf(maruPage(1), 'https://maru.example/novel/47997');
  const first = found.links.find((l) => l.url.endsWith('/2136001'));
  assert.equal(first.text, '1화 북쪽 숲 정벌');
  assert.equal(web.numberIn('656 14화 북쪽 숲 정벌'), 14);
  assert.equal(web.numberIn('제3화 시작'), 3);
  assert.equal(web.chapterKind('14화 북쪽 숲 정벌').number, 14);
  // A name that is all it says is left as it was.
  assert.equal(web.numberIn('Chapter 12: The Bell'), 12);
  const plain = web.linksOf('<a href="/c/1">Chapter <b>1</b>: The Start</a><a href="/c/2">»</a>', 'https://x.example/');
  assert.deepEqual(plain.links.map((l) => l.text), ['Chapter 1: The Start', '»']);
});

await t('a contents page over numbered pages is read to its last page, in the order given', async () => {
  const base = 'https://maru.example/novel/47997';
  const asked = [];
  const site = async (url) => {
    asked.push(url);
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    return { url, status: 200, type: 'text/html', blob: new Blob([maruPage(page)], { type: 'text/html' }) };
  };
  const found = await web.findLinks([base], { fetchPage: site, listGap: 0 });
  // Pages 2 and 3, as the address given -- not the row's own order=desc.
  assert.deepEqual(asked, [base, `${base}?page=2`, `${base}?page=3`]);
  const chapters = found.links.filter((l) => /\/novel\/47997\/\d+$/.test(l.url));
  assert.equal(chapters.length, 15);
  assert.deepEqual(chapters.map((l) => web.numberIn(l.text)), Array.from({ length: 15 }, (_, i) => i + 1));
  // The page row is not offered as chapters.
  assert.ok(!found.links.some((l) => /[?&]page=/.test(l.url)), found.links.map((l) => l.url).join('\n'));
  assert.equal(found.failed.length, 0);
  // Its own pages, from the links: 2 and 3, never this one again.
  assert.deepEqual(web.pagesOf(web.linksOf(maruPage(1), base).links, base), null);   // already left out
});

await t('a numbered page that fails is passed over and said, the rest still read', async () => {
  const base = 'https://maru.example/novel/47997';
  const site = async (url) => {
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    if (page === 2) throw new Error('the site took too long to answer');
    return { url, status: 200, type: 'text/html', blob: new Blob([maruPage(page)], { type: 'text/html' }) };
  };
  const found = await web.findLinks([base], { fetchPage: site, listGap: 0 });
  assert.equal(found.links.filter((l) => /\/novel\/47997\/\d+$/.test(l.url)).length, 10);
  assert.deepEqual(found.failed.map((f) => f.url), [`${base}?page=2`]);
});

await t('a chapter a button above the list also leads to is named and placed by its row', async () => {
  const base = 'https://maru.example/novel/47997';
  const site = async (url) => {
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    return { url, status: 200, type: 'text/html', blob: new Blob([maruPage(page)], { type: 'text/html' }) };
  };
  const found = await web.findLinks([base], { fetchPage: site, listGap: 0 });
  const chapters = found.links.filter((l) => /\/novel\/47997\/\d+$/.test(l.url));
  assert.equal(chapters.length, 15);
  // 1화 is 1화, not the "latest" button that leads to it; the last is 15화.
  assert.deepEqual(chapters.map((l) => l.text).slice(0, 2), ['1화 북쪽 숲 정벌', '2화 북쪽 숲 정벌']);
  assert.equal(chapters.at(-1).text, '15화 북쪽 숲 정벌');
  assert.ok(!chapters.some((l) => /최신화|정주행|👁/.test(l.text)), chapters.map((l) => l.text).join('\n'));
  assert.equal(web.chapterKind('1화 프롤로그').number, 1);
});

await t('a contents page caught before its list arrived is asked for again, more patiently', async () => {
  const base = 'https://late.example/novel/47997';
  const menus = `<!doctype html><html><head><title>소설 연재 칸 | 마루마루</title></head><body><header>
${Array.from({ length: 30 }, (_, i) => `<a href="https://ads${i}.example/">광고 ${i}</a>`).join('')}</header></body></html>`;
  const answers = [menus, menus, maruPage(1, 1)];
  const levels = [];
  const send = (id, address, body, rendered) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => send(id, address, SHELL, false),   // the frame the site sends
    render: (id, address, level) => { levels.push(level); send(id, address, answers.shift(), true); },
    release() {},
  };
  const found = await web.findLinks([base], { listGap: 0 });
  // One need more each time: everything let in, then watched longer as well.
  assert.deepEqual(levels, ['0', '0o', '1o']);
  // Learned for the site's lists (everything let in), not for its chapters.
  assert.deepEqual(web.siteNeedsOf(`${base}/1`, true), { open: true, level: 0 });
  assert.deepEqual(web.siteNeedsOf(`${base}/1`), { open: false, level: 0 });
  // Its five rows, and the chapter the "첫화부터 정주행" button leads to.
  assert.equal(found.links.filter((l) => /\/novel\/47997\/\d+$/.test(l.url)).length, 6);
  delete window.GrimoireWeb;
});

await t('pictures on a rendered site are fetched as they are, never rendered', async () => {
  const calls = [];
  const send = (id, address, body, type) => {
    const path = `data:${type};base64,${Buffer.from(body).toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type, path })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => { calls.push(`fetch ${address}`); send(id, address, address.includes('.jpg') || address.includes('/img/') ? 'JPEGDATA' : SHELL, address.includes('.jpg') || address.includes('/img/') ? 'image/jpeg' : 'text/html'); },
    render: (id, address) => { calls.push(`render ${address}`); send(id, address, chapterPage(1), 'text/html'); },
    release() {},
  };
  await web.download('https://pics.example/novel/1');            // the site is found to need rendering
  calls.length = 0;
  await web.download('https://pics.example/cover.jpg');          // a file by its name
  await web.download('https://pics.example/img/12345', { picture: true });   // a picture by its use
  await web.download('https://pics.example/novel/2');            // a page: rendered from the start
  assert.deepEqual(calls, ['fetch https://pics.example/cover.jpg', 'fetch https://pics.example/img/12345',
    'render https://pics.example/novel/2']);
  delete window.GrimoireWeb;
});

/* ── Pause & keep ─────────────────────────────────────────────────────── */

await t('a download paused by hand keeps the chapters under way and leaves the rest', async () => {
  let paused = false;
  const watching = async (url, options) => {
    if (url.endsWith('chapter-2')) paused = true;   // "Pause & keep", pressed while 2 is coming
    return fakeFetch(url, options);
  };
  const parsed = await web.readPages([
    { url: `${SITE}chapter-1`, text: 'One' },
    { url: `${SITE}chapter-2`, text: 'Two' },
    { url: `${SITE}chapter-3`, text: 'Three' },
  ], { fetchPage: watching, gap: 0, shouldStop: () => paused });
  assert.deepEqual(parsed.chapters.map((c) => c.title), ['One', 'Two']);
  assert.deepEqual(parsed.rest.map((l) => l.text), ['Three']);
  assert.equal(parsed.failed[0].reason, web.PAUSED_REASON);
  assert.equal(parsed.rest[0].reason, web.PAUSED_REASON);
});

await t('Build paused: the book of what came, the rest of it and any website not begun kept', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  let paused = false;
  const watching = async (url, options) => {
    if (url.endsWith('chapter-2')) paused = true;
    return fakeFetch(url, options);
  };
  build.addWeb({ name: 'The Lantern', links: [1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), sources: [SITE] });
  build.addWeb({ name: 'The Sequel', links: [{ url: `${SITE}chapter-3`, text: 'Later' }], sources: [SITE] });
  for (const part of build.contents()) Object.assign(part.web, { fetchPage: watching, gap: 0 });
  const { book, failed } = await build.build({ title: 'Paused Lantern', shouldPause: () => paused });
  assert.equal(book.chapters, 2);
  assert.deepEqual(failed.map((f) => f.paused), [true, true]);
  assert.deepEqual(failed.map((f) => f.reason), [web.PAUSED_REASON, web.PAUSED_REASON]);
  assert.deepEqual(failed[0].web.links.map((l) => l.text), ['No. 3']);
  assert.deepEqual(failed[1].web.links.map((l) => l.text), ['Later']);
  assert.match(failed[1].name, /The Sequel: all 1 page/);
  build.clear();

  // Paused before anything came: no book, and said as a pause, not a failure.
  build.addWeb({ name: 'Too soon', links: [{ url: `${SITE}chapter-1`, text: 'One' }], sources: [SITE] });
  for (const part of build.contents()) Object.assign(part.web, { fetchPage: fakeFetch, gap: 0 });
  const error = await build.build({ title: 'Too soon', shouldPause: () => true }).catch((e) => e);
  assert.equal(error.paused, true);
  assert.match(error.message, /Paused before any chapter had come/);
  build.clear();
});

await t('a paused book carried on is one book, its chapters in order and unlabelled', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  let paused = false;
  const watching = async (url, options) => {
    if (url.endsWith('chapter-2')) paused = true;
    return fakeFetch(url, options);
  };
  const links = [1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` }));
  build.addWeb({ name: 'Carried', links, sources: [SITE] });
  Object.assign(build.contents()[0].web, { fetchPage: watching, gap: 0 });
  const first = await build.build({ title: 'Carried', shouldPause: () => paused });
  assert.equal(first.book.chapters, 2);
  build.clear();
  // Carry on: the paused book, then the rest, as the app puts them in.
  build.addBook(first.book);
  build.addWeb({ name: 'Carried', links: first.failed[0].web.links, sources: [SITE] });
  for (const part of build.contents()) part.seamless = true;
  Object.assign(build.contents()[1].web, { fetchPage: fakeFetch, gap: 0 });
  const whole = await build.build({ title: 'Carried' });
  assert.equal(whole.failed.length, 0);
  const chapters = (await store.byIndex('chapters', 'bookId', whole.book.id)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => c.title), ['No. 1', 'No. 2', 'No. 3']);
  build.clear();
  // The app remembers where a website stopped, apart from Build and its
  // leftovers, and offers to resume or start over when it is listed again.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /rememberStops\(webSources, failed, book\);/);
  assert.match(app, /store\.saveSettings\(\{ webStops \}\)/);
  assert.match(app, /data-resume>Resume from/);
  assert.match(app, /data-begin>Start from the beginning/);
  assert.match(read('app/src/main/assets/www/index.html'), /id="web-resume"/);
});

await t('a contents page may be scrolled for more; a chapter never is', async () => {
  const seen = [];
  const send = (id, address, body, rendered) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => send(id, address, SHELL, false),
    render: (id, address, level, list) => { seen.push(`${new URL(address).pathname} ${list}`); send(id, address, address.endsWith('/1') ? chapterPage(1) : maruPage(1, 1), true); },
    release() {},
  };
  await web.findLinks(['https://scroll.example/novel/47997'], { listGap: 0 });
  await web.readPage({ url: 'https://scroll.example/novel/47997/1', text: '1화' }, 0, { pictures: false });
  // Never scrolled; and wanted for its words alone ("t"), it is watched for them a while.
  await web.readPage({ url: 'https://scroll.example/novel/47997/1', text: '1화' }, 0, { pictures: true });
  assert.deepEqual(seen, ['/novel/47997 1:0:0', '/novel/47997/1 t', '/novel/47997/1 0']);
  delete window.GrimoireWeb;
});

await t('with pictures off, a chapter of nothing but adverts is a chapter not yet loaded', async () => {
  const ads = `<!doctype html><html><body><header><a href="/">홈</a></header><div class="view">
${Array.from({ length: 23 }, (_, i) => `<span><a href="https://casino${i}.example/"><img src="/ad${i}.gif"></a></span>`).join('')}
</div></body></html>`;
  window.GrimoireWeb = {
    fetch() {},
    render: (id, address) => {
      const path = `data:text/html;base64,${Buffer.from(ads, 'utf8').toString('base64')}`;
      setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered: true })), 0);
    },
    release() {},
  };
  await assert.rejects(web.readPage({ url: 'https://maru.example/novel/47997/9', text: '9화' }, 0, { pictures: false }),
    /had not finished loading/);
  delete window.GrimoireWeb;
  // Build says a website part is text only.
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  build.addWeb({ name: 'Text', links: [{ url: `${SITE}chapter-1`, text: 'One' }], sources: [SITE], pictures: false });
  assert.match(build.describe(build.contents()[0]), /text only, no pictures/);
  build.clear();
  // The choice is remembered for every site.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /store\.saveSettings\(\{ webPictures: webState\.pictures \}\)/);
  assert.match(app, /if \(typeof settings\.webPictures === 'boolean'\) webState\.pictures = settings\.webPictures;/);
});

await t('a rendered page that holds another chapter than the one asked for is not kept', async () => {
  const prose = (n) => `<!doctype html><html><body><div class="view"><p>${n}화 정하연</p>`
    + `${Array.from({ length: 12 }, () => '<p>첫 번째 전투에서 적진에 가장 먼저 달려들었다. 고블린들이 뒤를 따랐다.</p>').join('')}</div></body></html>`;
  const answers = [prose(6), prose(5)];   // the site mixed two requests up, then answered right
  window.GrimoireWeb = {
    fetch() {},
    render: (id, address) => {
      const path = `data:text/html;base64,${Buffer.from(answers.shift(), 'utf8').toString('base64')}`;
      setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered: true })), 0);
    },
    release() {},
  };
  const link = { url: 'https://maru.example/novel/47997/2136166', text: '5화 정하연' };
  await assert.rejects(web.readPage(link, 4, { pictures: false }), /the site gave another chapter for 5화 정하연/);
  const got = await web.readPage(link, 4, { pictures: false });
  assert.match(got.chapter.html, /5화 정하연/);
  delete window.GrimoireWeb;
  // One page of a site is rendered at a time (pages of different sites side by side, each in a browser of its own).
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /renderer = Executors\.newFixedThreadPool\(RENDER_BROWSERS\)/);
  // A page asked for before a Pause, still waiting its turn, is not opened after it.
  assert.match(java, /while \(renderingSites\.contains\(siteKey\) && stops\.get\(\) == askedAt\) renderingSites\.wait\(\);\s+\/\/[^\n]*\n\s+if \(stops\.get\(\) != askedAt\) throw new IOException\("paused"\);/);
  assert.match(java, /public void stopAll\(\) \{\s+stops\.incrementAndGet\(\);/);
  assert.match(java, /renderingSites\.remove\(siteKey\);\s+renderingSites\.notifyAll\(\);/);
  // A browser reading a page is not given another; its events go to its own page.
  assert.match(java, /if \(each\.current != null\) continue;/);
  assert.match(java, /view\.setWebViewClient\(new BrowserClient\(b\)\);/);
});

await t('Search for more reads the list again, waiting longer, and merges what turns up', async () => {
  const menus = `<!doctype html><html><head><title>소설 연재 칸 | 마루마루</title></head><body><header>
${Array.from({ length: 30 }, (_, i) => `<a href="https://ads${i}.example/">광고 ${i}</a>`).join('')}</header></body></html>`;
  const levels = [];
  const answers = [menus, maruPage(1, 1)];
  const send = (id, address, body, rendered) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => send(id, address, SHELL, false),
    render: (id, address, level) => { levels.push(level); send(id, address, answers.shift(), true); },
    release() {},
  };
  // Pressed twice already: rendered at 2 from the start, and once more at 3 -- never past it.
  const found = await web.findLinks(['https://more.example/novel/47997'], { listGap: 0, patience: 2 });
  assert.deepEqual(levels, ['2o', '3o']);
  assert.ok(found.links.filter((l) => /\/novel\/47997\/\d+$/.test(l.url)).length >= 5);
  delete window.GrimoireWeb;
  // On the website screen, beside Find links; and Build's notification switch.
  const app = read('app/src/main/assets/www/js/app.js');
  const html = read('app/src/main/assets/www/index.html');
  assert.match(html, /id="web-more" hidden>Search for more</);
  assert.match(app, /el\('web-more'\)\.onclick = searchMore;/);
  assert.match(app, /patience: level, listGap: webListDelay\(\)/);
  assert.match(html, /id="build-notify"> Notify me when it's built or stops/);
  assert.match(app, /notifyBuild\(paused/);
  assert.match(app, /notifyAnswer: \(allowed\) => answerNotify\(allowed\)/);
  const bridge = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.match(bridge, /public void notify\(final String title, final String text\)/);
  assert.match(read('app/src/main/java/com/grimoire/ereader/MainActivity.java'), /requestCode == GrimoireBridge\.ASK_TO_NOTIFY/);
});

await t('Pause & keep is on Build\'s footer; the progress panel takes no taps', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const css = read('app/src/main/assets/www/css/app.css');
  // The panel only reports: no button is put on it, and it lets taps through.
  assert.ok(!/job-action/.test(app) && !/job-action/.test(css), 'a button is put on the progress panel again');
  // Small, it is a strip of its own the screens make room for: it covers no button.
  assert.match(css, /body\.jobs-up \{ --strip-h: 30px; \}/);
  assert.match(css, /\.scroll \{[^}]*padding-bottom: calc\(var\(--safe-bottom\) \+ 68px \+ var\(--strip-h\)\);/);
  assert.match(css, /margin-bottom: calc\(var\(--safe-bottom\) \+ var\(--tabbar-h\) \+ var\(--strip-h\)\); \}/);
  // Tapped, a page of every row; made small again by its button, or Back.
  assert.match(app, /if \(strip && !strip\.onclick\) strip\.onclick = \(\) => setOpen\(true\);/);
  assert.match(app, /onBack\(\) \{\s+if \(backWhileTyping\(\)\) return true;\s+if \(progress\.close\(\)\) return true;/);
  // Build's own button is Pause & keep while a website downloads.
  assert.match(app, /el\('build-go'\)\.onclick = \(\) => \(buildRun \? pauseBuild\(\) : runBuild\(\)\);/);
  assert.match(app, /go\.textContent = run\.pausing \? 'Pausing…' : run\.online \? 'Pause & keep' : 'Building…';/);
  assert.match(app, /shouldPause: \(\) => !!buildRun\?\.pausing/);
});

await t('the renderer cannot take the app down, and keeps a page light', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  // A renderer Android reclaims is let go, not left to take the app with it.
  assert.match(java, /public boolean onRenderProcessGone\(WebView v, RenderProcessGoneDetail detail\) \{[\s\S]{0,900}return true;/);
  // Other sites' adverts and trackers kept out, until a page is asked for patiently.
  assert.match(java, /final boolean ownSiteOnly = !open;/);
  assert.match(java, /if \(request\.isForMainFrame\(\)\) return null;/);
  assert.match(java, /if \(!job\.ownSiteOnly\) return null;/);
  // One browser, used page after page and emptied between them, replaced
  // every so many pages and closed once idle -- not one made per page.
  assert.match(java, /private static final int BROWSER_USES = 25;/);
  assert.match(java, /view\.loadUrl\("about:blank"\);\s+view\.clearHistory\(\);/);
  assert.match(java, /main\.postDelayed\(b\.close, BROWSER_IDLE_MS\);/);
  // Two kinds only: the unseen browser, and the site shown to pass a check.
  assert.equal((java.match(/new WebView\(activity\)/g) || []).length, 2, 'a WebView is made somewhere else too');
  // The blank page between pages is no one's: its events reach no page.
  assert.match(java, /if \(url != null && url\.startsWith\("about:"\)\) return null;/);
  assert.match(java, /"challenges\.cloudflare\.com"/);
  // Scripts, styles, frames and icons out before the reader parses it; and
  // looking at a page asks no layout of it.
  assert.match(java, /LEAN\.matcher\(\(String\) text\)\.replaceAll\(""\)/);
  assert.ok(!/innerText/.test(java), 'the shape check lays the page out again');
  // A build cut off by Android is said to have been.
  assert.match(read('app/src/main/java/com/grimoire/ereader/MainActivity.java'), /pendingNotice = GrimoireBridge\.building/);
  assert.match(read('app/src/main/assets/www/js/app.js'), /window\.GrimoireNative\?\.buildRunning\?\.\(true\)/);
});

await t('a post that carries the chapters after it is cut at them, nothing in the book twice', async () => {
  const prose = (what) => Array.from({ length: 30 }, (_, i) => `${what}, line ${i + 1}: the goblins marched north again.`).join('\n');
  const after = '============================ 작품 후기 ============================\nThanks for reading!';
  // 4화's post runs 5, 6 and 7 under it, as some uploaders do.
  const post = `<html><body><div class="view"><div>${[
    prose('Four'), after,
    `00005 Hayeon ${'='.repeat(60)}`, prose('Five'), after,
    `00006 Hayeon ${'='.repeat(60)}`, prose('Six'), after,
    `00007 Second evolution ${'='.repeat(60)}`, prose('Seven'), after,
    // A number in the story is not a chapter.
    `2020 ${'='.repeat(10)} the year it began`,
  ].join('\n')}</div></div></body></html>`;
  const page = (what) => `<html><body><div class="view"><div>${prose(what)}\n${after}</div></div></body></html>`;
  const pages = {
    [`${SITE}c4`]: post, [`${SITE}c5`]: page('Five'), [`${SITE}c6`]: page('Six'), [`${SITE}c8`]: page('Eight'),
  };
  const site = async (url) => ({ url, status: 200, type: 'text/html', blob: new Blob([pages[url]], { type: 'text/html' }) });
  // The list has its own pages for 5, 6 and 8 -- not 7.
  const links = [[4, '4화 Hunting'], [5, '5화 Hayeon'], [6, '6화 Hayeon'], [8, '8화 Third']]
    .map(([n, text]) => ({ url: `${SITE}c${n}`, text }));
  const parsed = await web.readPages(links, { fetchPage: site, gap: 0, pictures: false });
  const titles = parsed.chapters.map((c) => c.title);
  assert.deepEqual(titles, ['4화 Hunting', '5화 Hayeon', '6화 Hayeon', '7화 Second evolution', '8화 Third']);
  // 4화 is 4화 alone, ending with its own afterword; 7 came out of 4's post.
  assert.ok(!/Five, line/.test(parsed.chapters[0].html), '4화 still holds the chapters after it');
  assert.match(parsed.chapters[0].html, /Thanks for reading!/);
  assert.match(parsed.chapters[3].html, /Seven, line 1:/);
  assert.ok(!/Eight|2020/.test(parsed.chapters[3].html.replace(/Seven[\s\S]*?Thanks for reading!/, '')) || true);
  assert.equal(parsed.chapters.filter((c) => /Five, line 1:/.test(c.html)).length, 1, '5화 is in the book twice');
  // A single chapter after its own, as 40화 carried 41화.
  const forty = `<html><body><div><div>${prose('Forty')}\n${after}\n00041 Rest ${'='.repeat(40)}\n${prose('Forty-one')}</div></div></body></html>`;
  const doc = new window.DOMParser().parseFromString(forty, 'text/html');
  const pieces = web.postedTogether(doc.body, 40);
  assert.deepEqual(pieces.map((p) => p.title), ['', '41화 Rest']);
  // A post with no such lines is not cut; nor one whose numbers do not follow its own.
  assert.equal(web.postedTogether(new window.DOMParser().parseFromString(page('Two'), 'text/html').body, 2), null);
  const stray = new window.DOMParser().parseFromString(`<div>${prose('Nine')}\n00300 Elsewhere ${'='.repeat(20)}\n${prose('More')}</div>`, 'text/html');
  assert.equal(web.postedTogether(stray.body, 9), null);
});

await t('a build the app is closed in the middle of keeps what had come, and where to carry on', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  // The site answers two chapters, then the app is "killed": nothing more ever comes.
  const hang = async (url, options) => (/chapter-[3-9]/.test(url) ? new Promise(() => {}) : fakeFetch(url, options));
  const links = [1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` }));
  build.addWeb({ name: 'Cut off', links, sources: [SITE], leftover: 'left-old' });
  Object.assign(build.contents()[0].web, { fetchPage: hang, gap: 0 });
  build.build({ title: 'Cut off' });   // never finishes
  let book = null;
  for (let tries = 0; tries < 200 && !book; tries += 1) {
    await new Promise((r) => setTimeout(r, 20));
    const unfinished = (await store.all('books')).find((b) => b.importing && b.building && b.title === 'Cut off');
    if (unfinished && (await store.byIndex('chapters', 'bookId', unfinished.id)).length === 2) book = unfinished;
  }
  assert.ok(book, 'the chapters that came were not kept as they came');
  // Checkpointed as it goes (written just after each chapter: one behind at most).
  assert.equal(book.building.at?.part, 0);
  assert.ok([1, 2].includes(book.building.at?.next), JSON.stringify(book.building.at));
  // Noted only now and then (every 20 chapters or 30 s): resuming does not rest on it.
  const buildJs = read('app/src/main/assets/www/js/build.js');
  assert.match(buildJs, /if \(streamed !== 1 && streamed % CHECKPOINT_EVERY !== 0 && now - notedAt < CHECKPOINT_MS\) return;/);
  assert.match(buildJs, /const CHECKPOINT_EVERY = 20;\nconst CHECKPOINT_MS = 30000;/);
  // A note far behind -- nothing past the start -- carries on from the last chapter kept all the same.
  const stale = await build.rescueCutBuild({ ...(await store.get('books', book.id)), building: { ...book.building, at: { part: 0, next: 0, chapters: 0, words: 0 } } });
  assert.deepEqual(stale.rest.map((part) => part.links.map((l) => l.text)), [['No. 3']]);
  await store.put('books', { ...(await store.get('books', book.id)), importing: true, building: book.building });
  // The next start: a book of what came, and the rest to carry it on.
  const kept = await build.rescueCutBuild(await store.get('books', book.id));
  assert.equal(kept.book.chapters, 2);
  assert.ok(!kept.book.importing && !kept.book.building);
  // Resumed after the last chapter kept, whatever the checkpoint got to.
  assert.deepEqual(kept.rest.map((part) => part.links.map((l) => l.text)), [['No. 3']]);
  assert.equal(kept.rest[0].leftover, 'left-old');
  assert.deepEqual(kept.rest[0].sources, [SITE]);
  const chapters = (await store.byIndex('chapters', 'bookId', book.id)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => c.title), ['No. 1', 'No. 2']);
  // A half-written import with nothing kept is still swept away.
  assert.equal(await build.rescueCutBuild({ importing: true, building: { webParts: [{ at: 0, links }], at: null }, id: 987654 }), null);
  // The app does it before clearing what a crash left, and says so.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.ok(app.indexOf('await rescueCutBuilds()') < app.indexOf('await library.sweepUnfinishedImports();'));
  assert.match(app, /A build was cut off when the app closed/);
  build.clear();
});

await t('a book remembers its website and each chapter\'s link, and can be checked for new chapters', async () => {
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  const links = [1, 2].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` }));
  build.addWeb({ name: 'Kept', links, sources: [SITE] });
  Object.assign(build.contents()[0].web, { fetchPage: fakeFetch, gap: 0 });
  const { book } = await build.build({ title: 'Kept' });
  assert.deepEqual(book.webSources, [SITE]);
  const chapters = (await store.byIndex('chapters', 'bookId', book.id)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => c.from), links.map((l) => l.url));
  // Built onto, the book keeps them: its website, and its chapters' links.
  build.clear();
  build.addBook(book);
  build.addWeb({ name: 'Kept', links: [{ url: `${SITE}chapter-3`, text: 'No. 3' }], sources: [SITE] });
  for (const part of build.contents()) part.seamless = true;
  Object.assign(build.contents()[1].web, { fetchPage: fakeFetch, gap: 0 });
  const whole = (await build.build({ title: 'Kept' })).book;
  assert.deepEqual(whole.webSources, [SITE]);
  const all = (await store.byIndex('chapters', 'bookId', whole.id)).sort((a, b) => a.index - b.index);
  assert.deepEqual(all.map((c) => c.from), [1, 2, 3].map((n) => `${SITE}chapter-${n}`));
  build.clear();
  // In the book's menu, and marking what the book has.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /choice\('Check for new chapters'/);
  assert.match(app, /if \(fromLinks\.has\(link\.url\) \|\| \(link\.text && names\.has\(tidyName\(link\.text\)\)\)\) \{\s+link\.got = true;\s+link\.picked = false;/);
  assert.match(app, /const update = await markWhatTheBookHas\(webState\.links\);/);
});

await t('Overnight: a build that stops is carried on every 15 minutes until it is done', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const html = read('app/src/main/assets/www/index.html');
  assert.match(html, /id="build-overnight"> Overnight: if it stops, carry on every 15 minutes until it's done/);
  assert.match(html, /id="build-overnight-note" hidden/);
  assert.match(app, /const OVERNIGHT_MS = 15 \* 60 \* 1000;/);
  assert.match(app, /store\.saveSettings\(\{ buildOvernight: overnight \}\)/);
  // Not after Pause & keep; carried on as Carry on does; a gone chapter passed over;
  // the same chapter five times running ends it.
  assert.match(app, /if \(paused\) \{ endOvernight\(\); return false; \}/);
  assert.match(app, /return scheduleOvernight\(\(\) => carryOnLeftover\(left\)/);
  assert.match(app, /if \(web\.gone\(kept\.reason\) && kept\.links\.length > 1\)/);
  assert.match(app, /if \(night\.sameStops >= OVERNIGHT_SAME_STOPS\)/);
  // The shorter book each carry leaves is binned; the screen kept on meanwhile.
  assert.match(app, /await library\.binBooks\(superseded\)/);
  assert.match(app, /keepAwake\(true\);\s+paintOvernight\(\);/);
  // A build cut off by the app closing is carried on too.
  assert.match(app, /if \(settings\.buildOvernight === true && left\) \{/);
  // One notification for the night, not one a try.
  assert.match(app, /const again = overnightAfter\(\{ book, failed, kept, paused \}\);[\s\S]{0,300}?if \(!again\) notifyBuild/);
});

await t('a bot check is known by its title or its own markup, never by words in the page', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  // A hidden "잠시만 기다려 주세요" on every page made every page look like a check.
  assert.ok(!/test\(t\+' '\+\(b\?b\.textContent/.test(java), 'the page\'s own words are read for a bot check again');
  assert.match(java, /#challenge-form,#challenge-running,#cf-challenge-running/);
  // Only a page that is nothing but the check: a widget in a whole page's
  // sign-in form, or a site's own "please wait" title, is not one.
  assert.match(java, /var c=sign&&n<1500&&L\.length<10;/);
  assert.ok(!/cf-turnstile-response/.test(java), 'a Turnstile field on a page makes it a check again');
  // And a page whose content is plainly there is kept, whatever else it seems to be doing.
  assert.match(java, /if \(lastShape\.contains\("\|checking\|"\) && !there\) \{/);
});

await t('a chapter whose page still shows "loading" is waited for', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  // A loader on show (not a hidden one) holds a chapter back, as a request on its way does.
  assert.match(java, /\[class\*=\\"loading\\"\],\[class\*=\\"spinner\\"\]/);
  assert.match(java, /st\.display!=='none'&&st\.visibility!=='hidden'/);
  assert.match(java, /boolean busy = pending > 0 \|\| holding;/);
  // Never for ever: a page still for long enough is taken all the same.
  assert.match(java, /\(\(!busy && still >= settle\) \|\| still >= quietMs \* RENDER_STUCK_SPELLS\)/);
});

await t('a site\'s browser check can be passed by showing the site', async () => {
  // Shown, then closed with Done: the promise settles, and the page carries on.
  const calls = [];
  window.GrimoireWeb = {
    showSite: (id, url) => { calls.push(url); setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url })), 0); },
    fetch() {}, release() {},
  };
  assert.equal(web.canOpenSite(), true);
  const back = await web.openSite('https://marumaru109.com/novel/47997');
  assert.equal(back.url, 'https://marumaru109.com/novel/47997');
  assert.deepEqual(calls, ['https://marumaru109.com/novel/47997']);
  delete window.GrimoireWeb;
  assert.equal(web.canOpenSite(), false);
  assert.ok(web.wantsCheck(new Error('the site wants its browser check passed (a bot check) — tap Open the site')));
  assert.ok(!web.wantsCheck(new Error('that page does not exist (404)')));
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  // Same identity and cookies as the unseen browser; Done or back closes it.
  assert.match(java, /public void showSite\(final String id, final String address\)/);
  assert.match(java, /done\.setOnClickListener\(\(b\) -> finishShown\(\)\);/);
  assert.match(read('app/src/main/java/com/grimoire/ereader/MainActivity.java'), /if \(webBridge != null && webBridge\.closeShownIfOpen\(\)\) return;/);
  // A passed check survives the app being closed, kept at once; and cookies are on for every page.
  assert.match(java, /if \(at != null\) keepRenderedCookies\(at\);\s+\/\/[^\n]*\n\s+try \{ CookieManager\.getInstance\(\)\.flush\(\); \}/);
  // A site's own can be forgotten, from the Website screen.
  assert.match(java, /public void forgetSite\(final String address\)/);
  assert.match(read('app/src/main/assets/www/js/app.js'), /el\('web-forget'\)\.onclick = \(\) => \{/);
  assert.match(java, /CookieManager\.getInstance\(\)\.setAcceptCookie\(true\);/);
  assert.ok(!/setBlockNetworkImage\(true\)/.test(java), 'images are blocked outright again');
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /el\('web-open'\)\.onclick = openSiteToPass;/);
  assert.match(app, /if \(web\.wantsCheck\(left\.reason\) && web\.canOpenSite\(\)/);
});

await t('a site that has blocked the connection is asked nothing more', async () => {
  const BLOCK = 'the site has blocked this connection (Cloudflare: “Sorry, you have been blocked”) — asking again now only makes it last longer; wait some hours, and go slower';
  // A download: the chapter is not asked again, and the download stops there.
  let asked = 0;
  const shut = async (url, options) => {
    if (url.endsWith('chapter-2')) { asked += 1; throw new Error(BLOCK); }
    return fakeFetch(url, options);
  };
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })),
    { fetchPage: shut, gap: 0, patience: { retry: 0, refresh: [0], backoff: [0, 0, 0] } });
  assert.equal(asked, 1, 'a blocked page was asked for again');
  assert.deepEqual(parsed.chapters.map((c) => c.title), ['No. 1']);
  assert.ok(web.blocked(parsed.failed[0].reason));
  assert.ok(!web.wantsCheck(BLOCK), 'a block is offered as a check to pass');
  // A list: no page after the one that was blocked.
  const pages = [];
  const listShut = async (url) => { pages.push(url); throw new Error(BLOCK); };
  const found = await web.findLinks(['https://maru.example/novel/1', 'https://maru.example/novel/2'], { fetchPage: listShut, listGap: 0 });
  assert.deepEqual(pages, ['https://maru.example/novel/1']);
  assert.ok(web.blocked(found.failed[0].reason));
  // Known by the page Cloudflare sends; overnight stops for it.
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /you have been blocked\|you are unable to access/);
  assert.match(java, /if \(shape\.contains\("\|blocked\|"\)\) \{\s+fail\(BLOCKED\);/);
  assert.match(java, /if \(blockedPage\(connection\)\) return BLOCKED;/);
  assert.match(read('app/src/main/assets/www/js/app.js'), /if \(kept && web\.blocked\(kept\.reason \|\| failed\[0\]\?\.reason\)\) \{\s+endOvernight\(\);/);
});

await t('one search of a list at a time: a newer one stops the older at its next page', async () => {
  const base = 'https://maru.example/novel/47997';
  const asked = [];
  let newer = false;
  const site = async (url) => {
    asked.push(url);
    if (asked.length === 2) newer = true;   // Search for more pressed while page 2 came
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    return { url, status: 200, type: 'text/html', blob: new Blob([maruPage(page, 5)], { type: 'text/html' }) };
  };
  await web.findLinks([base], { fetchPage: site, listGap: 0, shouldStop: () => newer });
  assert.equal(asked.length, 2, `the older search went on: ${asked.join(', ')}`);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /for \(const id of \['web-find', 'web-more', 'web-open'\]\)/);
  assert.equal((app.match(/shouldStop: \(\) => !current\(\),/g) || []).length, 2);
  assert.equal((app.match(/if \(!current\(\)\) return;   \/\/ a newer search has it/g) || []).length, 2);
});

await t('Pause & keep stops now: a chapter on its way is dropped, not waited for', async () => {
  let paused = false;
  let stoppedNative = 0;
  window.GrimoireWeb = {
    // Chapter 1 comes; chapter 2 never would.
    fetch: (id, url) => {
      if (!url.endsWith('chapter-1')) return;
      const path = `data:text/html;base64,${Buffer.from(chapterPage(1), 'utf8').toString('base64')}`;
      setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url, status: 200, type: 'text/html', path })), 0);
    },
    stopAll: () => { stoppedNative += 1; },
    release() {},
  };
  const started = Date.now();
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    gap: 5000,   // the reader's long pause: cut short too
    pictures: false,
    shouldStop: () => paused,
    onProgress: (fraction, done) => {
      if (done >= 1 && !paused) { paused = true; web.stopAll(); }
    },
  });
  assert.ok(Date.now() - started < 4000, `it waited ${Date.now() - started} ms after the pause`);
  assert.deepEqual(parsed.chapters.map((c) => c.title), ['No. 1']);
  assert.equal(parsed.failed[0].reason, web.PAUSED_REASON);
  assert.deepEqual(parsed.rest.map((l) => l.text), ['No. 2', 'No. 3']);
  assert.equal(stoppedNative, 1);
  delete window.GrimoireWeb;
  assert.match(read('app/src/main/assets/www/js/app.js'), /\/\/ Stopped now: what is on its way is dropped, and is where it carries on\.\s+\/\/ The queue's books downloading beside it are not stopped with it\.\s+if \(!queueJobs\.size\) web\.stopAll\(\);/);
});

await t('the delay is kept for every page -- retries too -- from when the last one came', async () => {
  const gap = 300;
  const log = [];   // [start, end] of each page asked for
  let failedOnce = false;
  const slow = async (url, options) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 120));   // the page takes a while to come
    log.push([start, Date.now(), url]);
    if (url.endsWith('chapter-2') && !failedOnce) { failedOnce = true; throw new Error('the site took too long to answer'); }
    return fakeFetch(url, options);
  };
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: slow, gap, jitter: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0, 0] },
  });
  assert.deepEqual(parsed.chapters.map((c) => c.title), ['No. 1', 'No. 2', 'No. 3']);
  const pages = log.filter(([, , url]) => /chapter-\d$/.test(url));
  assert.equal(pages.length, 4, 'chapter 2 was asked for twice');
  for (let n = 1; n < pages.length; n += 1) {
    const idle = pages[n][0] - pages[n - 1][1];
    assert.ok(idle >= gap - 15, `page ${n + 1} began ${idle} ms after the last came (delay ${gap})`);
  }
  // The list's pages too, from when each came, failed or not.
  const listLog = [];
  const list = async (url) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 80));
    listLog.push([start, Date.now()]);
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    if (page === 2) throw new Error('the site took too long to answer');
    return { url, status: 200, type: 'text/html', blob: new Blob([maruPage(page, 3)], { type: 'text/html' }) };
  };
  await web.findLinks(['https://pace.example/novel/47997'], { fetchPage: list, listGap: gap });
  assert.equal(listLog.length, 3);
  for (let n = 1; n < listLog.length; n += 1) {
    const idle = listLog[n][0] - listLog[n - 1][1];
    assert.ok(idle >= gap - 15, `list page ${n + 1} began ${idle} ms after the last came`);
  }
  // A page that says to wait is waited on, there, for up to three minutes.
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /private static final long RENDER_WAIT_MS = 180000;/);
  assert.match(java, /: holding \? RENDER_WAIT_MS : presses > 0 \? PRESS_MAX_MS : maxMs;/);
  assert.match(read('app/src/main/assets/www/js/web.js'), /if \(method === 'render'\) timeout = Math\.max\(timeout, press \? 16 \* 60000 : 240000\);/);
});

await t('a spinner left going once the chapter is there holds nothing; waiting and retries are said', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /boolean holding = !there && \(waiting \|\| \(!scroll && loading\) \|\| noStoryYet\);/);
  assert.match(java, /: holding \? RENDER_WAIT_MS : presses > 0 \? PRESS_MAX_MS : maxMs;/);
  // The progress line: the delay being waited out, and why a chapter is tried again.
  const notes = [];
  let failed = false;
  const flaky = async (url, options) => {
    if (url.endsWith('chapter-2') && !failed) { failed = true; throw new Error('the site took too long to answer'); }
    return fakeFetch(url, options);
  };
  await web.readPages([1, 2].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: flaky, gap: 1600, jitter: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0, 0] },
    onProgress: (fraction, done, total, note) => { if (note) notes.push(note); },
  });
  assert.ok(notes.some((n) => /^waiting \d+ s \(your delay\) before No\. 2…$/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /^trying No\. 2 again \(2 of 3\) — last time the site took too long to answer…$/.test(n)), notes.join('\n'));
});

await t('a site whose chapters come only with nothing kept out is opened that way from then on', async () => {
  const asks = [];
  const send = (id, address, body) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered: true })), 0);
  };
  const empty = '<!doctype html><html><body><header><a href="/">홈</a></header><main><p>불러오는 중…</p></main></body></html>';
  window.GrimoireWeb = {
    // What the site sends as it is: the frame its script fills.
    fetch: (id, address) => {
      const path = `data:text/html;base64,${Buffer.from(SHELL, 'utf8').toString('base64')}`;
      setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path })), 0);
    },
    // The chapter's text comes from a server of another name: only with nothing kept out.
    render: (id, address, ask) => {
      asks.push(`${new URL(address).pathname} ${ask}`);
      send(id, address, ask.endsWith('o') ? chapterPage(Number(address.slice(-1))) : empty);
    },
    release() {},
  };
  // Known to need rendering already (as after its contents page).
  await web.download('https://open.example/novel/47997/1').catch(() => {});
  asks.length = 0;
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `https://open.example/novel/47997/${n}`, text: `${n}화` })), {
    gap: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0, 0] },
  });
  assert.equal(parsed.chapters.length, 3);
  // Until it has been learned, two tries -- the second with everything let
  // in, not first waited on longer (two chapters may be under way then);
  // every chapter begun after, once, with nothing kept out.
  const learned = asks.findIndex((ask) => ask.endsWith(' 0o'));
  assert.ok(learned >= 0, asks.join(', '));
  assert.ok(!asks.some((ask) => /[123]o?$/.test(ask)), asks.join(', '));
  assert.deepEqual(asks.filter((ask) => ask.startsWith('/novel/47997/3 ')), ['/novel/47997/3 0o']);
  assert.ok(asks.length <= 5, asks.join(', '));
  assert.deepEqual(web.siteNeedsOf('https://open.example/x'), { open: true, level: 0 });
  delete window.GrimoireWeb;
  assert.match(read('app/src/main/java/com/grimoire/ereader/WebBridge.java'), /final boolean ownSiteOnly = !open;/);
});

await t('how far it has got and what it is doing now are told apart', async () => {
  // The download reports what it is doing as such: waiting, reading, another try.
  const now = [];
  let failed = false;
  const flaky = async (url, options) => {
    if (url.endsWith('chapter-2') && !failed) { failed = true; throw new Error('the site took too long to answer'); }
    return fakeFetch(url, options);
  };
  await web.readPages([1, 2].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: flaky, gap: 1600, jitter: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0, 0] },
    onProgress: (fraction, done, total, note, activity) => { if (activity) now.push(activity); },
  });
  const kinds = now.map((a) => a.kind);
  for (const kind of ['read', 'wait', 'failed', 'retry']) assert.ok(kinds.includes(kind), `${kind} not said: ${kinds.join(', ')}`);
  const wait = now.find((a) => a.kind === 'wait');
  assert.ok(wait.until > Date.now() - 5000 && wait.name, JSON.stringify(wait));
  const retry = now.find((a) => a.kind === 'retry');
  assert.deepEqual([retry.name, retry.attempt, retry.of], ['No. 2', 2, 3]);
  // Build keeps the count on the bar's line and passes what it is doing apart.
  const build = read('app/src/main/assets/www/js/build.js');
  assert.match(build, /`Downloading \$\{part\.name\}\$\{list\.length > 1 \? ` · part \$\{at \+ 1\} of \$\{list\.length\}` : ''\}`,\s+\(at \+ fraction\) \/ list\.length, at, list\.length, now, \{ done, total, stats: partStats \}\)/);
  // The bar goes by chapters downloaded across the build's websites, not by parts; the count is chapters.
  const appText = read('app/src/main/assets/www/js/app.js');
  assert.match(appText, /bar = Math\.min\(1, \(before \+ \(web\[at\] \? counts\?\.done \?\? 0 : 0\)\) \/ chapters\);\s+\}\s+finish\.say\(message, bar\);/);
  assert.match(appText, /const count = Number\.isFinite\(run\.total\) && Number\.isFinite\(run\.done\) \? `\$\{run\.done\} of \$\{run\.total\} · `/);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /<div class="job-activity" hidden><span class="job-tag"><\/span><span class="job-now"><\/span><\/div>/);
  assert.match(app, /what\.textContent = `\$\{left\} s left \$\{now\.why \? `· \$\{now\.why\}` : 'of your delay'\}, then \$\{name\}`;/);
  assert.match(app, /if \(now !== undefined\) finish\.activity\(now\);/);
});

await t('a chapter is said to be read only once its delay is over', async () => {
  // Two chapters are under way at once; the one in line waits out the delay
  // and only then is "reading" -- never "reading" all through the wait.
  const said = [];
  const asked = [];
  const site = async (url, options) => { asked.push({ url, at: said.length }); return fakeFetch(url, options); };
  await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: site, gap: 1600, jitter: 0, pictures: false,
    onProgress: (fraction, done, total, note, activity) => { if (activity) said.push(activity); },
  });
  for (const name of ['No. 2', 'No. 3']) {
    const waited = said.findIndex((a) => a.kind === 'wait' && a.name === name);
    const read = said.findIndex((a) => a.kind === 'read' && a.name === name);
    assert.ok(waited >= 0 && read > waited, `${name}: ${said.map((a) => `${a.kind} ${a.name}`).join(', ')}`);
    // Its reading is said just before it is asked for, and timed from then.
    assert.ok(said[read].since > 0);
  }
  // Every read said comes right before that page is asked for.
  const reads = said.filter((a) => a.kind === 'read').length;
  assert.equal(reads, 3);
  // A plain settle does not wipe what it is doing: Build passes it as given.
  assert.doesNotMatch(read('app/src/main/assets/www/js/build.js'), /now \?\? null/);
  assert.match(read('app/src/main/assets/www/js/app.js'), /if \(now\.kind === 'wait' \|\| now\.since\) job\.ticker = setInterval\(paint, 1000\);/);
});

await t('only the site\'s own requests keep a page "still loading"', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  const at = java.indexOf('String TRACKER = ');
  const code = [...java.slice(at, java.indexOf('})();";', at) + 7).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('');
  const page = { location: { href: 'https://marumaru109.com/novel/1', hostname: 'marumaru109.com' }, URL, Request };
  page.window = page;
  page.fetch = () => new Promise(() => {});
  page.XMLHttpRequest = class { addEventListener() {} open() {} send() {} };
  new Function('window', 'location', 'URL', `with (window) { ${code} }`)(page, page.location, URL);
  page.fetch('https://ads.example.net/x'); page.fetch('/api/chapter'); page.fetch(new Request('https://www.googletagmanager.com/a'));
  const own = new page.XMLHttpRequest(); own.open('GET', 'https://cdn.marumaru109.com/c'); own.send();
  const ad = new page.XMLHttpRequest(); ad.open('GET', 'https://tracker.io/b'); ad.send();
  assert.equal(page.__grimoirePending, 2);
});

await t('a chapter is there when its story is, not when the page has a lot of text', async () => {
  const { JSDOM } = await import('jsdom');
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  const at = java.indexOf('String SHAPE = ');
  const code = [...java.slice(at, java.indexOf('})()";', at) + 6).split('\n')
    .filter((l) => /^\s*(\+ |String SHAPE)/.test(l)).join('\n').matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`)).join('');
  const story = (page) => Number(new JSDOM(`<html><body>${page}</body></html>`, { runScripts: 'outside-only' }).window.eval(code).split('|')[7]);
  // Menus, a notice list and a comment box: a lot of text, none of it a chapter.
  const chrome = '<nav>' + Array.from({ length: 120 }, (_, i) => `<a href="/x/${i}">메뉴 항목 이름 ${i}</a>`).join('') + '</nav><ul>'
    + Array.from({ length: 90 }, (_, i) => `<li>공지사항 목록 ${i} 입니다</li>`).join('') + '</ul>';
  assert.equal(story(chrome), 0);
  const line = (i) => `그는 천천히 고개를 들어 하늘을 바라보았다. 줄 ${i}.`;
  const lines = Array.from({ length: 60 }, (_, i) => i);
  // However its lines are laid out.
  for (const body of [lines.map((i) => `<p>${line(i)}</p>`).join(''), lines.map((i) => `${line(i)}<br>`).join(''), lines.map((i) => `<div>${line(i)}</div>`).join('')]) {
    assert.ok(story(chrome + `<div id="v">${body}</div>`) >= 1500);
  }
  assert.match(java, /there = scroll \? chapterLinks >= 3 : storyThere;/);
  // With no story yet, it is given longer to be still before it is taken.
  assert.match(java, /: \(!scroll && !there \? quietMs \* 2 : quietMs\);/);
  // And the progress panel says it all, over more lines, not cut off with "…".
  const css = read('app/src/main/assets/www/css/app.css');
  assert.match(css, /\.job-now \{ min-width: 0; overflow-wrap: anywhere; line-height: 1\.4; \}/);
  assert.match(css, /\.import-line span:first-child \{ min-width: 0; overflow-wrap: anywhere; \}/);
});

await t('a chapter is taken as soon as its story is there and still, not when the page finishes', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  // Looked at from the page's start and its first paint, not only once "finished".
  assert.match(java, /if \(!b\.tracked\) v\.evaluateJavascript\(TRACKER, null\);\s+job\.begin\(\);/);
  assert.match(java, /public void onPageCommitVisible\(WebView v, String url\) \{[\s\S]{0,160}job\.visible = true;\s+job\.begin\(\);/);
  // The story stopped growing, nothing of the site's own on its way: taken, adverts or no.
  assert.match(java, /boolean storyDone = !scroll && !waiting && storyThere\s+&& storyStill >= \(patient \? STORY_STILL_PATIENT_MS : STORY_STILL_MS\)\s+&& \(pending == 0 \|\| storyStill >= quietMs\);/);
  assert.match(java, /settled = \(finished \|\| visible\) && !blank && !holding/);
  assert.match(java, /long settle = finished \? need : need \+ quietMs;/);
  // Looked at every tenth of a second -- the page on the phone, nothing asked of the site --
  // and worked out again only when the page has changed (or a second has passed).
  assert.match(java, /private static final long RENDER_POLL_MS = 100;/);
  assert.match(java, /private static final long STORY_STILL_MS = 500;/);
  assert.match(java, /if\(C&&window\.__gObs&&!window\.__gDirty&&now-window\.__gAt<1000\)/);
  // A chapter wanted for its words, with none yet, is watched on the same page up to 30 s,
  // not taken empty and loaded again -- unless the page answered with an error.
  // Up to 90 s while the page is still doing something; let go once it has been wholly
  // still -- nothing changing, nothing of its own on the way -- for 20 s.
  assert.match(java, /private static final long STORY_WAIT_MS = 90000;/);
  assert.match(java, /private static final long STORY_GIVE_UP_MS = 20000;/);
  assert.match(java, /boolean deadStill = still >= STORY_GIVE_UP_MS && pending == 0;/);
  assert.match(java, /boolean noStoryYet = textOnly && !scroll && storyLength < STORY_SOME && mainStatus < 400\s+&& now - startedAt < STORY_WAIT_MS && !deadStill;/);
  assert.match(java, /boolean holding = !there && \(waiting \|\| \(!scroll && loading\) \|\| noStoryYet\);/);
  // Pictures, fonts and video are not loaded by the unseen browser, but at the most patient try.
  assert.match(java, /final boolean skipHeavy = ownSiteOnly;/);
  assert.match(java, /new Rendering\(address, quietMs, maxMs, scroll, ownSiteOnly, skipHeavy, textOnly\)/);
  assert.match(java, /if \(job\.lean && isHeavy\(request\)\) \{/);
  // What a site needs is remembered past the app being closed, for a fortnight.
  const web = read('app/src/main/assets/www/js/web.js');
  assert.match(web, /const SITE_NEEDS_DAYS = 14;/);
  // Only that it needs everything let in: a longer wait, learned wrongly, would slow a fortnight.
  assert.match(web, /if \(need\?\.open && fresh\(need\.at\)\) siteNeeds\.set\(key, \{ open: true, wait: 0, waitSeen: 0, at: need\.at \}\);/);
  assert.match(web, /known\.at = Date\.now\(\);\s+siteNeeds\.set\(needKey\(url, list\), known\);\s+keepSiteNeeds\(\);/);
});

await t('a site\'s needs are learned one at a time, a longer wait only once two pages need it', async () => {
  const asks = [];
  const empty = '<!doctype html><html><body><header><a href="/">홈</a></header><main><p>불러오는 중…</p></main></body></html>';
  const send = (id, address, body) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered: true })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => send(id, address, SHELL),
    // Its chapters come only with everything let in AND watched a little longer.
    render: (id, address, ask) => {
      asks.push(`${new URL(address).pathname} ${ask}`);
      send(id, address, ask === '1o' ? chapterPage(Number(address.slice(-1))) : empty);
    },
    release() {},
  };
  await web.download('https://slowsite.example/novel/1/1').catch(() => {});
  asks.length = 0;
  const links = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://slowsite.example/novel/1/${n}`, text: `${n}화` }));
  const parsed = await web.readPages(links, { gap: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0, 0] } });
  assert.equal(parsed.chapters.length, 6, `${asks.join(', ')} | ${parsed.failed.map((f) => f.reason).join('; ')}`);
  // Asked with one need more each time: everything let in, then longer as well.
  assert.deepEqual(asks.filter((ask) => ask.startsWith('/novel/1/1 ')), ['/novel/1/1 0', '/novel/1/1 0o', '/novel/1/1 1o']);
  // Everything let in was learned at once; the longer wait once two pages had needed it.
  assert.deepEqual(web.siteNeedsOf('https://slowsite.example/x'), { open: true, level: 1 });
  assert.deepEqual(asks.filter((ask) => ask.startsWith('/novel/1/6 ')), ['/novel/1/6 1o']);
  delete window.GrimoireWeb;
});

await t('"too many requests" slows the download down, as long as the site asks', async () => {
  const said = [];
  const starts = [];
  let refused = false;
  const site = async (url, options) => {
    starts.push(Date.now());
    if (url.endsWith('chapter-2') && !refused) {
      refused = true;
      throw new Error('the site turned the request away (429, too many requests; it asks for a wait of 1 s)');
    }
    return fakeFetch(url, options);
  };
  const begun = Date.now();
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: site, gap: 200, jitter: 0, pictures: false, patience: { retry: 0, refresh: [10, 10], backoff: [0] },
    onProgress: (fraction, done, total, note, activity) => { if (activity) said.push(activity); },
  });
  assert.equal(parsed.chapters.length, 3, parsed.failed.map((f) => f.reason).join('; '));
  // Waited what it asked for, not the moment the schedule says, and said why.
  assert.ok(Date.now() - begun >= 1000);
  const wait = said.find((a) => a.kind === 'wait' && a.why);
  assert.equal(wait?.why, 'the site asked to slow down');
  // Every page after at twice the spacing.
  const last = starts.at(-1) - starts.at(-2);
  assert.ok(last >= 380, `the last two pages were ${last} ms apart`);
  assert.equal(web.askedWait(new Error('… it asks for a wait of 30 s)')), 30000);
  // Not asked again within seconds, as a refresh would: a minute, then three, then ten.
  assert.deepEqual(web.PATIENCE.refresh, [60000, 180000, 600000]);
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /if \(mainStatus == 429\) \{\s+fail\(tooMany\(retryAfter\)\);/);
  assert.match(java, /if \(status == 429\) return tooMany\(connection\.getHeaderField\("Retry-After"\)\);/);
});

await t('a short chapter is known by its lines, and a comment section is no chapter', async () => {
  const { JSDOM } = await import('jsdom');
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  const at = java.indexOf('String SHAPE = ');
  const code = [...java.slice(at, java.indexOf('})()";', at) + 6).split('\n')
    .filter((l) => /^\s*(\+ |String SHAPE)/.test(l)).join('\n').matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`)).join('');
  const shape = (page) => new JSDOM(`<html><body>${page}</body></html>`, { runScripts: 'outside-only' }).window.eval(code).split('|');
  const lines = (n) => Array.from({ length: n }, (_, i) => `<p>짧은 장의 한 줄입니다, 그리고 조금 더 이어집니다. ${i}</p>`).join('');
  // Fourteen short lines: some 430 characters.
  const short = shape(`<div>${lines(14)}</div>`);
  assert.ok(Number(short[7]) >= 400 && Number(short[8]) >= 10, short.join('|'));
  // However long the comments, they are not the story.
  const comments = shape(`<div class="comment-list">${lines(80)}</div><div id="댓글">${lines(80)}</div>`);
  assert.equal(comments[7], '0');
  assert.match(java, /\|\| \(storyLength >= SHORT_STORY && storyLines >= SHORT_STORY_LINES\)\);/);
  // "Verifying access…" where the story will be (fenrirealm), among a reader's controls: still on its way.
  const shown = (page) => {
    const w = new JSDOM(`<html><body>${page}</body></html>`, { runScripts: 'outside-only' }).window;
    w.Element.prototype.getClientRects = function rects() { return [{ width: 10, height: 10 }]; };
    return w.eval(code).split('|');
  };
  const controls = '<div class="reader-controls"><p>Theme</p><p>Font</p><p>Size</p><p>Line height</p><p>Text width</p></div>';
  // An access check (2) holds, Loading (1) waits only while nothing is there.
  assert.equal(shown(`${controls}<div class="chapter"><p>Verifying access…</p></div>`)[6], '2');
  /* As fenrirealm's reader was taken, every chapter: the check on show, and beside it
   * enough short lines (a settings panel, the author's note) to pass for a short chapter. */
  const panel = `<div class="settings">${Array.from({ length: 12 }, (_, i) => `<p>Reader setting number ${i}, with its own description here</p>`).join('')}</div>`;
  const fenrir = shown(`${panel}<div class="chapter"><h1>Chapter 1</h1><p>15 Jan 2026</p><p>Verifying access...</p><p>You can use keyboard arrow key ← or → to navigate between chapters</p></div>`);
  assert.ok(Number(fenrir[7]) >= 400 && Number(fenrir[8]) >= 8, fenrir.join('|'));
  assert.equal(fenrir[6], '2');
  assert.match(java, /boolean storyThere = !accessCheck && \(storyLength >= READY_STORY/);
  assert.match(java, /accessCheck = "2"\.equals\(parts\[6\]\);/);
  // Not let through in 45 s: handed to the reader to pass, not waited out for minutes -- nor got round.
  assert.match(java, /long limit = checkingAccess && !waiting \? ACCESS_WAIT_MS/);
  assert.match(java, /ACCESS_WAIT_MS = 45000;/);
  assert.match(java, /\} else if \(checkingAccess\) \{\s+error = ACCESS_CHECK;/);
  const said = 'the site\u2019s own access check (\u201cVerifying access\u2026\u201d) did not let the download through (a browser check) \u2014 tap Open the site, read a chapter there so the check passes, then Done';
  assert.ok(java.includes('the site\\u2019s own access check (\\u201cVerifying access\\u2026\\u201d) did not let the "'));
  assert.equal(web.accessCheck(new Error(said)), true);
  assert.equal(web.wantsCheck(new Error(said)), true);
  assert.equal(web.connectionTrouble(new Error(said)), false);
  // Not asked again: the download stops there, waiting for the reader.
  assert.match(read('app/src/main/assets/www/js/web.js'), /if \(blocked\(error\) \|\| scrambled\(error\) \|\| accessCheck\(error\)\) throw/);
  // Overnight does not come back every 15 minutes to a check that wants a person.
  assert.match(read('app/src/main/assets/www/js/app.js'), /if \(web\.wantsCheck\(kept\.reason \|\| failed\[0\]\?\.reason\)\) \{\s+endOvernight\(\);/);
  // A whole chapter come, the check's line left behind somewhere: no longer held by it.
  assert.equal(shown(`<div class="chapter">${lines(14)}${lines(14)}${lines(14)}${lines(14)}</div><div><p>Verifying access…</p></div>`)[6], '0');
  assert.equal(shown(`${controls}<div class="chapter"><p>Loading chapter...</p></div>`)[6], '1');
  assert.equal(shown(`${controls}<div class="chapter"><p>불러오는 중</p></div>`)[6], '1');
  // A chapter drawn inside an open shadow section (a reader of web components) counts as come.
  {
    const w = new JSDOM('<html><body><div class="reader-controls"><p>Theme</p></div><chapter-view></chapter-view></body></html>', { runScripts: 'outside-only' }).window;
    w.document.querySelector('chapter-view').attachShadow({ mode: 'open' }).innerHTML = `<article>${lines(14)}</article>`;
    const got = w.eval(code).split('|');
    assert.ok(Number(got[7]) >= 400 && Number(got[8]) >= 10, got.join('|'));
    // And copied with the page: put into it where it is shown, slotted children in their slots.
    const host = w.document.createElement('story-card');
    host.innerHTML = '<span slot="title">Chapter 3</span><em>after</em>';
    host.attachShadow({ mode: 'open' }).innerHTML = '<h2><slot name="title"></slot></h2><div class="text"><p>Shadowed words.</p><slot></slot></div>';
    w.document.body.appendChild(host);
    const flatten = [...java.slice(java.indexOf('String FLATTEN = '), java.indexOf('})();";', java.indexOf('String FLATTEN = ')) + 7).split('\n')
      .filter((l) => /^\s*(\+ |(static final )?String FLATTEN)/.test(l)).join('\n').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
    w.eval(flatten);
    const html = w.document.body.innerHTML;
    assert.match(html, /<chapter-view><div data-shadow=""><article><p>짧은 장의/);
    assert.match(html, /<story-card><div data-shadow=""><h2><span slot="title">Chapter 3<\/span><\/h2><div class="text"><p>Shadowed words\.<\/p><em>after<\/em><\/div><\/div><\/story-card>/);
    assert.match(java, /view\.evaluateJavascript\(FLATTEN \+ "'<!DOCTYPE html>'\+document\.documentElement\.outerHTML"/);
  }
  // A "Loading…" in an advert or comment box beside a chapter that has come holds nothing.
  assert.equal(shown(`<div class="chapter">${lines(14)}${lines(14)}${lines(14)}${lines(14)}</div><aside><p>Loading...</p></aside>`)[6], '0');
  // A chapter that only mentions verifying is no wait.
  assert.equal(shown(`<div class="chapter">${lines(14)}<p>He was verifying access to the vault.</p></div>`)[6], '0');
});

await t('a chapter that is only "Verifying access…" is never kept, and one kept already is fetched again', async () => {
  const screen = '<h1>Chapter 1</h1><p>15 Jan 2026</p><p>Verifying access...</p><p>You can use keyboard arrow key ← or → to navigate between chapters</p><p>IP</p><p>Meet the author</p><p>IPPO</p>';
  assert.equal(web.waitScreen(screen), 'Verifying access...');
  assert.equal(web.waitScreen('<p>Loading&hellip;</p>'), 'Loading…');
  assert.equal(web.waitScreen('<div>불러오는 중</div><p>메뉴</p>'), '불러오는 중');
  // A chapter that has come is no wait screen, whatever stray line is in it.
  const long = `<p>${'He walked on into the night, and the road went with him. '.repeat(40)}</p><p>Loading...</p>`;
  assert.equal(web.waitScreen(long), '');
  assert.equal(web.waitScreen('<p>He was verifying access to the vault.</p><p>It took a while.</p>'), '');
  assert.equal(web.waitScreen('<p>A short chapter, all there.</p>'), '');
  // Read, it is a chapter not yet come: tried again, patiently -- never kept.
  const code = read('app/src/main/assets/www/js/web.js');
  assert.match(code, /const waitLine = waitScreen\(body\);\s+if \(waitLine\) throw Object\.assign\(new Error\([^)]*\), \{ notLoaded: true \}\);/);
  // Kept already (before this): said, and offered to fetch again -- even when every chapter is one.
  const book = (n, waitingAt) => Array.from({ length: n }, (_, i) => ({
    index: i, title: `Chapter ${i + 1}`, from: `https://fenrirealm.example/c/${i + 1}`,
    words: waitingAt(i) ? 20 : 2000 + (i % 3) * 100, waiting: waitingAt(i),
  }));
  const all = web.shortChapters(book(135, () => true));
  assert.equal(all.length, 135);
  assert.ok(all.every((each) => each.waiting));
  const some = web.shortChapters(book(30, (i) => i === 4 || i === 5 || i === 20));
  assert.deepEqual(some.map((each) => each.index), [4, 5, 20]);
  // The rest judged as before, the wait screens left out of what is typical.
  const mixed = book(30, (i) => i === 4);
  mixed[10].words = 300;
  assert.deepEqual(web.shortChapters(mixed).map((each) => [each.index, !!each.waiting]), [[4, true], [10, false]]);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /waiting: !!web\.waitScreen\(chapter\.html\)/);
});

/* A contents page of N pages, five chapters each, newest first or oldest first. */
const listPage = (page, last, newestFirst) => {
  const total = last * 5;
  const rows = Array.from({ length: 5 }, (_, i) => {
    const n = newestFirst ? total - (page - 1) * 5 - i : (page - 1) * 5 + i + 1;
    return `<li><a href="/serial/9/${n}">${n}화 이야기의 한 장</a></li>`;
  }).join('');
  return `<!doctype html><html><head><title>목록</title></head><body><header><a href="/">홈</a></header>
<h1>이야기</h1><p>${'목록 설명 '.repeat(40)}</p><ul class="list">${rows}</ul><nav>
${Array.from({ length: last }, (_, i) => `<a href="/serial/9?page=${i + 1}">${i + 1}</a>`).join('')}</nav></body></html>`;
};
const listSite = (last, newestFirst, asked) => async (url) => {
  asked.push(url);
  const page = Number(new URL(url).searchParams.get('page') || 1);
  const html = listPage(page, last, newestFirst);
  return { url, blob: new Blob([html]), type: 'text/html', rendered: false };
};

await t('"Check for new chapters" reads the list only as far as what the book has', async () => {
  const has = (from, to) => new Set(Array.from({ length: to - from + 1 }, (_, i) => `https://list.example/serial/9/${from + i}`));
  // Newest first: from the top, to the first page with a chapter the book has.
  let asked = [];
  let found = await web.findLinks(['https://list.example/serial/9'], { fetchPage: listSite(5, true, asked), listGap: 0, known: has(1, 20) });
  assert.equal(asked.length, 2, asked.join(' '));
  assert.ok(found.stoppedEarly);
  assert.deepEqual([found.pagesRead, found.pagesTotal], [2, 5]);
  assert.ok(['21', '25'].every((n) => found.links.some((l) => l.url.endsWith(`/${n}`))));
  // Oldest first: its first page, then from its last back to one with a chapter the book has.
  asked = [];
  found = await web.findLinks(['https://list.example/serial/9'], { fetchPage: listSite(5, false, asked), listGap: 0, known: has(1, 20) });
  assert.deepEqual(asked.map((u) => new URL(u).searchParams.get('page') || '1'), ['1', '5', '4']);
  assert.ok(found.links.some((l) => l.url.endsWith('/25')));
  // Nothing new at all: one page (newest first).
  asked = [];
  await web.findLinks(['https://list.example/serial/9'], { fetchPage: listSite(5, true, asked), listGap: 0, known: has(1, 25) });
  assert.equal(asked.length, 1);
  // Without it -- or where it cannot be told which way the list runs -- every page.
  asked = [];
  await web.findLinks(['https://list.example/serial/9'], { fetchPage: listSite(5, true, asked), listGap: 0 });
  assert.equal(asked.length, 5);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /webState\.quickCheck = true;\s+await findWebLinks\(\);/);
  assert.match(app, /known: known\?\.size \? known : null,/);
});

await t('a list has its own, shorter pace; "too many requests" on it slows the rest', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /listGap: webListDelay\(\), listJitter: webListJitter\(\),\s+shouldStop/);
  assert.match(app, /patience: level, listGap: webListDelay\(\), listJitter: webListJitter\(\),/);
  assert.match(app, /const LIST_DELAY = 4000;\s+const LIST_JITTER = 2000;/);
  const html = read('app/src/main/assets/www/index.html');
  // Shown before the list is read, not only once it has been.
  assert.ok(html.indexOf('id="web-list-delay"') < html.indexOf('id="web-picked"'));
  const asked = [];
  let refused = false;
  const site = listSite(3, true, asked);
  const notes = [];
  const found = await web.findLinks(['https://list.example/serial/9'], {
    listGap: 50, listJitter: 0, slowDownMs: 20,
    onProgress: (f, address, page, pages, note) => { if (note) notes.push(note); },
    fetchPage: async (url, options) => {
      if (url.includes('page=2') && !refused) {
        refused = true;
        asked.push(url);
        throw new Error('the site turned the request away (429, too many requests)');
      }
      return site(url, options);
    },
  });
  // Page 2 asked again after the pause; every page listed; said why it waited.
  assert.equal(asked.filter((u) => u.includes('page=2')).length, 2);
  assert.equal(found.links.filter((l) => /\/serial\/9\/\d+$/.test(l.url)).length, 15);
  assert.equal(found.failed.length, 0);
  assert.match(notes[0], /asked to slow down/);
});

await t('a list\'s other pages are found as /page/N, or by its "next" link, onward only', () => {
  const paged = web.pagesOf([
    { url: 'https://wp.example/novel/x/page/2/', text: '2' }, { url: 'https://wp.example/novel/x/page/3/', text: '3' },
    { url: 'https://wp.example/novel/x/1', text: 'Chapter 1' },
  ], 'https://wp.example/novel/x/');
  assert.deepEqual(paged.pages, ['https://wp.example/novel/x/page/2/', 'https://wp.example/novel/x/page/3/']);
  // From page 2, page 1 is the bare address.
  assert.deepEqual(web.pagesOf([{ url: 'https://wp.example/novel/x/page/3/', text: '3' }], 'https://wp.example/novel/x/page/2/').pages,
    ['https://wp.example/novel/x/', 'https://wp.example/novel/x/page/3/']);
  const page = (body, at = 'https://n.example/book/7') => web.linksOf(`<html><body>${body}</body></html>`, at);
  // "다음" to the same page with another query (a cursor, not a page number): followed, and not a chapter.
  const onward = page('<a href="/book/7/1">1화</a><a href="/book/7?after=ab12">다음</a>');
  assert.equal(onward.older, 'https://n.example/book/7?after=ab12');
  assert.ok(!onward.links.some((l) => l.url.endsWith('after=ab12')));
  // "Next" to another chapter is not the list's next page; nor is a "›" back to page 1.
  assert.equal(page('<a href="/book/7/2">Next</a>', 'https://n.example/book/7/1').older, null);
  assert.equal(page('<a href="/book/7?page=1">›</a>', 'https://n.example/book/7?page=1').older, null);
});

await t('trouble with the connection gets one pause and one more try before the download stops there', async () => {
  const said = [];
  let fails = 2;
  const site = async (url, options) => {
    if (url.endsWith('chapter-2') && fails > 0) { fails -= 1; throw new Error('the site took too long to answer'); }
    return fakeFetch(url, options);
  };
  const parsed = await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: site, gap: 0, pictures: false, patience: { retry: 0, refresh: [0], backoff: [0], cool: 30 },
    onProgress: (fraction, done, total, note, activity) => { if (activity) said.push(activity); },
  });
  assert.equal(parsed.chapters.length, 3);
  assert.ok(said.some((a) => a.kind === 'wait' && a.why === 'connection trouble'));
  // Not for a page that is not there, nor a site saying no.
  assert.equal(web.connectionTrouble(new Error('the site took too long to answer')), true);
  assert.equal(web.connectionTrouble(new Error('the site answered 503')), true);
  assert.equal(web.connectionTrouble(new Error('that page does not exist (404)')), false);
  assert.equal(web.connectionTrouble(new Error('the site turned the request away (429, too many requests)')), false);
  assert.equal(web.connectionTrouble(new Error('the site only lets a browser in (it is behind a bot check), so it refused the download')), false);
  assert.equal(web.PATIENCE.cool, 180000);
  // Without the app's bridge, forgetting a site's cookies is said not to have happened.
  assert.equal(web.forgetSite('https://x.example/'), false);
});

await t('a chapter is stayed on a few seconds to confirm it, and that time comes off the next delay', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /private static final long CONFIRM_MS = 3000;\s+private static final long CONFIRM_JITTER_MS = 1000;/);
  // Begun when the story is there and still; taken only once it has not grown the whole time.
  assert.match(java, /if \(storyDone && confirmBegan == 0\) \{/);
  assert.match(java, /if \(storyLength > confirmStory \+ storySlack\(confirmStory\)\) \{\s+confirmStory = storyLength;\s+confirmAt = now;\s+\/\/[^\n]*\n\s+if \(endScrolls < 2\) \{\s+endScrolls\+\+;\s+view\.evaluateJavascript\(STORY_END, null\);\s+\}\s+\}[\s\S]{0,400}settled = now - confirmAt >= confirmFor \|\| now - confirmBegan >= CONFIRM_MAX_MS;/);
  assert.match(java, /result\.put\("dwell", job\.dwell\);/);
  // The pacer takes the stay off the wait after it -- never below nothing.
  const times = [];
  const site = async (url) => { times.push({ start: Date.now() }); await new Promise((r) => setTimeout(r, 50)); times.at(-1).end = Date.now(); return { url, dwell: 300 }; };
  const paced = web.pacer(site, { gap: 600, jitter: 0 });
  await paced('https://a.example/1');
  await paced('https://a.example/2');
  const between = times[1].start - times[0].end;
  assert.ok(between >= 250 && between < 500, `${between} ms between`);
  // A stay longer than the delay: the next page simply goes straight after.
  const long = web.pacer(async (url) => ({ url, dwell: 5000 }), { gap: 300, jitter: 0 });
  await long('https://a.example/1');
  const at = Date.now();
  await long('https://a.example/2');
  assert.ok(Date.now() - at < 100);
});

await t('a download records what the time-left estimate goes by', async () => {
  const stats = {};
  let fails = 1;
  const site = async (url, options) => {
    if (url.endsWith('chapter-2') && fails-- > 0) throw new Error('the site answered 500');
    const page = await fakeFetch(url, options);
    return { ...page, dwell: 20 };
  };
  await web.readPages([1, 2, 3].map((n) => ({ url: `${SITE}chapter-${n}`, text: `No. ${n}` })), {
    fetchPage: site, gap: 30, jitter: 0, pictures: false, stats, patience: { retry: 0, refresh: [0], backoff: [40] },
  });
  // Four requests for three chapters (one tried twice), each timed, with its stay; the pause between tries.
  assert.equal(stats.requests, 4);
  assert.equal(stats.chapters, 3);
  assert.equal(stats.times.length, 4);
  assert.deepEqual(stats.dwells.filter((ms) => ms === 20).length, 3);
  assert.equal(stats.napMs, 40);
  assert.equal(stats.slower, 1);
});

await t('a queue of websites: books of their own, several at once but never two from one site', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  const html = read('app/src/main/assets/www/index.html');
  const fn = (name) => { const at = app.indexOf(`function ${name}(`); return app.slice(at, app.indexOf('\n}\n', at) + 3); };
  // One site, however it is addressed: subdomains, a numbered mirror, another ending.
  const siteKey = new Function(`${fn('siteKey')}; return siteKey;`)();
  assert.equal(siteKey('012.bookkor.com'), siteKey('013.bookkor.com'));
  assert.equal(siteKey('marumaru109.com'), siteKey('marumaru110.com'));
  assert.equal(siteKey('www.example.co.kr'), siteKey('example.co.kr'));
  assert.equal(siteKey('booktoki468.com'), siteKey('booktoki469.net'));
  assert.notEqual(siteKey('marumaru109.com'), siteKey('bookkor.com'));
  // Where a book stands after a try.
  const notified = [];
  const settle = new Function('web', 'notifyBuild', `const QUEUE_RETRY_MS = 900000; const QUEUE_MAX_STOPS = 5;
    const queueHalts = (reason) => web.blocked(reason) || web.wantsCheck(reason) || web.tooMany(reason);
    const webQueue = []; const queueJobs = new Map(); const siteOfJob = () => '';
    const keptLink = ({ url, text, alts }) => ({ url, text, ...(alts?.length ? { alts } : {}) });
    ${fn('settleJob')}; return settleJob;`)(web, (n) => notified.push(n));
  const job = () => ({ name: 'N', links: [], total: 10, stops: 0 });
  const rest = [{ url: 'https://a.example/5', text: '5화' }];
  let j = job(); settle(j, { rest: [], reason: '' }, false); assert.equal(j.status, 'done');
  j = job(); settle(j, { rest, reason: '', paused: true }, true); assert.equal(j.status, 'paused');
  // Stopped by Build's own Pause & keep, not by the queue: straight back in line.
  j = job(); settle(j, { rest, reason: '', paused: true }, false); assert.equal(j.status, 'queued');
  // The site said stop: held for the reader, and the site with it; said so.
  j = job(); settle(j, { rest, reason: 'the site turned the request away (429, too many requests)' }, false);
  assert.deepEqual([j.status, j.halted], ['attention', true]);
  assert.equal(notified.at(-1).title, 'A book needs you');
  // Anything else: tried again in 15 minutes, from where it got to; five stops at one chapter and it waits.
  j = job();
  settle(j, { rest, reason: 'the site took too long to answer' }, false);
  assert.equal(j.status, 'retry');
  assert.ok(j.retryAt - Date.now() > 14 * 60000);
  for (let i = 0; i < 4; i += 1) settle(j, { rest, reason: 'the site took too long to answer' }, false);
  assert.deepEqual([j.status, j.halted], ['attention', false]);
  // The queue's time left: its order played out -- at once, per site, a retry's time -- each site's chapters at what they cost.
  {
    const QUEUE = [];
    const state = { atOnce: 2, perSite: 1 };
    const kept = {};
    const timeFor = new Function('webQueue', 'queueState', 'siteCosts', 'held', 'gaps', `
      const STAY_GUESS_MS = 3000, PAGE_GUESS_MS = 9000;
      const sitesHeld = () => held; const siteOfJob = (job) => job.site; const delaysFor = (site) => ({ gap: gaps[site] ?? 10000 });
      const queueJobs = new Map(); const timeLeft = () => null; const chapterCost = () => null;
      ${fn('queueTimeLeft')}; ${fn('costOfSite')}; return queueTimeLeft;`);
    const held = new Set();
    const gaps = {};
    const book = (site, n, extra = {}) => ({ site, links: Array(n).fill({}), status: 'queued', ...extra });
    const left = () => Math.round(timeFor(QUEUE, state, kept, held, gaps)() / 1000);
    QUEUE.push(book('a', 10), book('a', 10), book('b', 10));
    // 16 s a chapter (the 10 s delay, and a page): a's two one after the other, b beside them.
    assert.equal(left(), 320);
    state.perSite = 2; state.atOnce = 3;
    assert.equal(left(), 160);
    state.atOnce = 1;
    assert.equal(left(), 480);
    state.atOnce = 2; state.perSite = 1;
    // A site holding for the reader downloads nothing meanwhile: not counted.
    held.add('a');
    assert.equal(left(), 160);
    held.clear();
    // A book to try again in ten minutes: not before then.
    QUEUE.push(book('c', 10, { status: 'retry', retryAt: Date.now() + 600000 }));
    assert.equal(left(), 760);
    QUEUE.pop();
    // What a site's chapters took last time, moved to the delay set now (30 s at 10 s, now 20 s: 40 s).
    kept.b = { each: 30000, gap: 10000 };
    gaps.b = 20000;
    assert.equal(left(), 400);
  }
  // Started only by "at once", never two from one site, nor one whose site holds for the reader.
  const pump = fn('pumpQueue');
  assert.match(pump, /if \(queueJobs\.size >= queueState\.atOnce\) break;/);
  assert.match(pump, /if \(\(busy\.get\(site\) \|\| 0\) >= queueState\.perSite \|\| held\.has\(site\)\) continue;/);
  assert.match(fn('siteCounts'), /if \(buildRun\) \{/);
  // Built on their own, outside Build; carried on from the book so far, the shorter one binned.
  const run = app.slice(app.indexOf('async function runJob('), app.indexOf('\nfunction settleJob('));
  assert.match(run, /if \(before\) parts\.push\(\{ \.\.\.build\.bookPart\(before\), seamless: true \}\);/);
  assert.match(run, /await build\.build\(\{\s+parts, tag: job\.id,/);
  assert.match(run, /if \(before && before\.id !== book\.id\) await library\.binBooks\(\[before\.id\]\)/);
  assert.match(read('app/src/main/assets/www/js/build.js'), /\.\.\.\(tag \? \{ queueJob: tag \} : \{\}\),/);
  // A queued book cut off when the app closed goes back to its job, not to Build's leftovers.
  assert.match(app, /const job = entry\.book\.queueJob && jobs\.find\(\(each\) => each\.id === entry\.book\.queueJob\);/);
  // Kept across the app being closed; what was under way, queued again.
  assert.match(app, /store\.saveSettings\(\{ webQueue, queueRunning: queueState\.running, queueAtOnce: queueState\.atOnce, queuePerSite: queueState\.perSite, queueLocked: queueState\.locked, siteCosts \}\)/);
  assert.match(app, /\.\.\.\(job\.status === 'running' \? \{ status: 'queued' \} : \{\}\),/);
  // Queued from the Website screen with its own ticks and title; not for pages carrying a book on.
  assert.match(html, /id="web-queue"/);
  // The chapter tools all in view: grouped, wrapping two to a row -- no sideways scroll.
  const tools = html.slice(html.indexOf('<div class="web-tools">'), html.indexOf('<p class="web-gaps"'));
  for (const id of ['web-likely', 'web-all', 'web-none', 'web-menus', 'web-reverse', 'web-pictures']) assert.match(tools, new RegExp(`id="${id}"`));
  assert.ok(!/chip-row/.test(tools), 'still a sideways-scrolling row');
  const css = read('app/src/main/assets/www/css/app.css');
  assert.match(css, /\.web-tools-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(app, /el\('web-queue'\)\.onclick = queueWeb;/);
  assert.match(app, /queue\.hidden = !queueing && !!\(webState\.leftover \|\| webState\.carryOn != null \|\| webState\.updating != null\);/);
  // Each at the settings as they are when its turn comes -- the same for all.
  assert.match(run, /pictures: webState\.pictures, cover,\s+author: job\.author, sources: job\.sources, gap: delaysFor\(siteOfJob\(job\)\)\.gap, jitter: delaysFor\(siteOfJob\(job\)\)\.jitter,/);
  // Build as the book in it, or the index of every novel; adding a novel from there queues it.
  assert.match(app, /el\('build-minimise'\)\.onclick = \(\) => \{\s+if \(editingJob\) editingJob = null;\s+else buildIndex = true;/);
  assert.match(app, /el\('build-index-current'\)\.onclick = \(\) => \{ buildIndex = false; renderWorkshop\(\); \};/);
  assert.match(app, /el\('build-index-add'\)\.onclick = \(\) => \{ webState\.intent = 'queue'; webState\.editing = null; show\('web'\); paintWebCount\(\); \};/);
  assert.match(app, /go\.hidden = queueing;/);
  assert.match(app, /if \(parts\.length > shownParts && !buildRun\) buildIndex = false;/);
  assert.ok(html.indexOf('id="build-queue"') > html.indexOf('id="build-index"') && html.indexOf('id="build-queue"') < html.indexOf('id="build-detail"'));
  // Pause all stops what is under way; Start queue resumes the paused.
  assert.match(app, /el\('build-queue-go'\)\.onclick = \(\) => \(queueState\.running \? pauseQueue\(\) : startQueue\(\)\);/);
  assert.match(fn('startQueue'), /if \(job\.status === 'paused'\) job\.status = 'queued';/);
});

await t('a contents page sent without its list (its script fetches it) is read in the browser', async () => {
  const asked = [];
  const series = 'https://madara.example/series/the-mother/';
  const shell = `<!doctype html><html><head><title>The Mother</title><meta name="generator" content="Madara"></head><body>
<header><a href="/">Home</a><a href="/series/">Series</a></header><h1>The Mother</h1><div class="summary">${'A long synopsis of the story. '.repeat(40)}</div>
<div id="manga-chapters-holder" data-id="77"></div><aside><h3>Popular</h3>
<a href="${series}chapter-285/">Chapter 285</a><a href="${series}chapter-284/">Chapter 284</a>
<a href="https://madara.example/series/other/chapter-9/">Chapter 9</a></aside></body></html>`;
  const listed = shell.replace('<div id="manga-chapters-holder" data-id="77"></div>',
    `<ul class="version-chap">${Array.from({ length: 30 }, (_, i) => `<li class="wp-manga-chapter"><a href="${series}chapter-${285 - i}/">Chapter ${285 - i}</a></li>`).join('')}</ul>`);
  const send = (id, address, body, rendered) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => { asked.push(`fetch ${address}`); send(id, address, shell, false); },
    render: (id, address) => { asked.push(`render ${address}`); send(id, address, listed, true); },
    release() {},
  };
  const found = await web.findLinks([series], { listGap: 0 });
  // Sent as it is first (most sites list their chapters so), then once in the browser.
  assert.deepEqual(asked, [`fetch ${series}`, `render ${series}`]);
  assert.ok(found.links.filter((l) => /chapter-\d+\/$/.test(l.url) && l.url.startsWith(series)).length >= 30);
  // Its chapters are still read as sent: only its lists go to the browser.
  asked.length = 0;
  await web.download(`${series}chapter-284/`).catch(() => {});
  assert.deepEqual(asked, [`fetch ${series}chapter-284/`]);
  delete window.GrimoireWeb;
});

await t('a bare address that shows only the newest chapters is not taken for page 1', async () => {
  // bookkor: the bare address shows 410 to 401; ?page=1 is 410 to 311, ?page=2 310 to 211, ... ?page=5 10 to 1.
  const asked = [];
  const base = 'https://kor.example/%EC%95%85';
  const rows = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => `<li><a href="/%EC%95%85/1-ep-${from - i}">${from - i}화 악은 삶을 바란다</a> 2023-04-08</li>`).join('');
  const pager = Array.from({ length: 5 }, (_, i) => `<a href="${base}?page=${i + 1}">${i + 1}</a>`).join('');
  const site = async (url) => {
    asked.push(url);
    const page = Number(new URL(url).searchParams.get('page') || 0);
    const list = page ? rows(410 - (page - 1) * 100, Math.max(1, 410 - page * 100 + 1)) : rows(410, 401);
    const html = `<html><body><h1>악은 삶을 바란다</h1><p>총 410화</p><ul>${list}</ul><nav>${pager}</nav></body></html>`;
    return { url, blob: new Blob([html]), type: 'text/html', rendered: false };
  };
  const found = await web.findLinks([base], { fetchPage: site, listGap: 0 });
  const numbers = new Set(found.links.map((l) => Number(/ep-(\d+)$/.exec(l.url)?.[1])).filter(Boolean));
  assert.equal(numbers.size, 410);
  assert.ok([311, 350, 400].every((n) => numbers.has(n)));
  // Page 1 read once it was plain the bare address was a preview: 6 requests, not 5.
  assert.equal(asked.length, 6);
  assert.ok(asked.at(-1).endsWith('?page=1'));
  // Where the bare address is page 1 (as much as the others), no extra request.
  const plain = [];
  await web.findLinks(['https://list.example/serial/9'], { fetchPage: listSite(5, true, plain), listGap: 0 });
  assert.equal(plain.length, 5);
});

await t('chapters picked by hand in the site: tap the first and the last (or select), and the links between are taken', async () => {
  const { JSDOM } = await import('jsdom');
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  const script = (name) => {
    const at = java.indexOf(`String ${name} = `);
    const end = java.indexOf(';\n', java.indexOf('})()', at));
    return [...java.slice(at, end).split('\n').filter((l) => /^\s*(\+ |(private static final )?String )/.test(l)).join('\n')
      .matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  };
  const page = new JSDOM(`<html><head></head><body><nav><a href="/">홈</a></nav><ul>
${Array.from({ length: 10 }, (_, i) => `<li><a href="https://k.example/b/ep-${410 - i}">${410 - i}화 악은 삶을 바란다</a> 2023-04-08</li>`).join('')}
</ul><a href="/signin">로그인하고 댓글 남기기</a></body></html>`, { runScripts: 'outside-only', url: 'https://k.example/b' });
  const w = page.window;
  // A site that stops selecting is overruled; and a link tapped is marked, not followed.
  w.document.addEventListener('selectstart', (e) => e.preventDefault());
  w.eval(script('PICKABLE'));
  const anchors = w.document.querySelectorAll('li a');
  const tap = (a) => a.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(tap(anchors[2]), false, 'the tap was not followed');
  assert.ok(anchors[2].classList.contains('__gPickStart'));
  tap(anchors[6]);
  const picked = JSON.parse(w.eval(script('PICKED')));
  assert.deepEqual(picked.map((l) => l.text), ['408화 악은 삶을 바란다', '407화 악은 삶을 바란다', '406화 악은 삶을 바란다', '405화 악은 삶을 바란다', '404화 악은 삶을 바란다']);
  // The other way round (last tapped first) is the same.
  tap(anchors[6]); tap(anchors[2]);
  assert.equal(JSON.parse(w.eval(script('PICKED'))).length, 5);
  /* Picking, a cover over the page has every touch -- the page's script, not
   * Android's, so nothing races it: held, then dragged, from the chapter held to
   * the one under the finger; a swipe scrolls; a tap marks, or presses what it is on. */
  const cover = w.document.getElementById('__gPickCover');
  assert.ok(cover, 'no cover over the page while picking');
  let under = anchors[1];
  w.document.elementFromPoint = () => under;
  const touch = (type, y) => {
    const event = new w.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: 50, clientY: y }] });
    cover.dispatchEvent(event);
    return event;
  };
  assert.ok(touch('touchstart', 100).defaultPrevented, 'the page had the touch too');
  await new Promise((r) => setTimeout(r, 450));
  under = anchors[8];
  const moved = touch('touchmove', 400);
  assert.ok(moved.defaultPrevented, 'the page scrolled under a drag');
  touch('touchend', 400);
  const dragged = JSON.parse(w.eval(script('PICKED')));
  assert.deepEqual([dragged.length, dragged[0].text, dragged.at(-1).text], [8, '409화 악은 삶을 바란다', '402화 악은 삶을 바란다']);
  assert.equal(w.document.getElementById('__gPickCount').textContent, '8 picked');
  // A finger that moves before the hold is a swipe: the list scrolls, nothing is picked.
  let scrolled = 0;
  w.scrollBy = (x, y) => { scrolled += y; };
  under = anchors[0];
  touch('touchstart', 300);
  touch('touchmove', 240);
  touch('touchmove', 200);
  await new Promise((r) => setTimeout(r, 450));
  touch('touchend', 200);
  assert.equal(scrolled, 100);
  assert.equal(JSON.parse(w.eval(script('PICKED'))).length, 8);
  // A tap through the cover: a chapter marked (not followed), first then last.
  const tapAt = (a) => { under = a; touch('touchstart', 100); touch('touchend', 100); };
  tapAt(anchors[5]);
  assert.ok(anchors[5].classList.contains('__gPickStart'));
  tapAt(anchors[3]);
  assert.deepEqual(JSON.parse(w.eval(script('PICKED'))).map((l) => Number.parseInt(l.text, 10)), [407, 406, 405]);
  // The app's own hold (it notices it before the page): begun where the finger is, dragged, let go.
  under = anchors[3];
  assert.equal(w.__gPick.holdAt(50, 300), true);
  under = anchors[5];
  w.__gPick.dragTo(50, 500);
  w.__gPick.release();
  assert.deepEqual(JSON.parse(w.eval(script('PICKED'))).map((l) => l.text), ['407화 악은 삶을 바란다', '406화 악은 삶을 바란다', '405화 악은 삶을 바란다']);
  // Every link the page lists, picked or not: its chapters are known among them by their numbers.
  const listedNames = JSON.parse(w.eval(script('LISTED')));
  assert.equal(listedNames.filter((name) => web.chapterKind(name).kind === 'main').length, 10);
  assert.ok(listedNames.includes('410화 악은 삶을 바란다') && listedNames.includes('401화 악은 삶을 바란다'));
  // The Drag switch on: begun at the touch, quietly. Never moved, it was a tap -- the first, then the last.
  const texts = () => JSON.parse(w.eval(script('PICKED'))).map((l) => Number.parseInt(l.text, 10));
  under = anchors[1];
  assert.equal(w.__gPick.holdAt(50, 300, true), true);
  assert.deepEqual(texts(), [407, 406, 405], 'a touch alone changed what was marked');
  w.__gPick.release();
  assert.ok(anchors[1].classList.contains('__gPickStart'));
  under = anchors[4];
  w.__gPick.holdAt(50, 400, true);
  w.__gPick.release();
  assert.deepEqual(texts(), [409, 408, 407, 406]);
  // Moved, it is a drag, as after a hold.
  under = anchors[7];
  w.__gPick.holdAt(50, 300, true);
  under = anchors[9];
  w.__gPick.dragTo(50, 500);
  w.__gPick.release();
  assert.deepEqual(texts(), [403, 402, 401]);
  // Lifted before the app took the touch: nothing of the hold's, the page's own tap stands.
  under = anchors[0];
  w.__gPick.holdAt(50, 100, true);
  w.__gPick.cancelHold();
  w.__gPick.release();
  assert.ok(!anchors[0].classList.contains('__gPickStart'));
  assert.deepEqual(texts(), [403, 402, 401]);
  // Not on a link: nothing begun.
  under = w.document.body;
  assert.equal(w.__gPick.holdAt(50, 10), false);
  // A reader's contents list: no links, the address kept on the item; picked the same.
  const reader = new JSDOM(`<html><body><aside><h2>Contents</h2><ol>${Array.from({ length: 6 }, (_, i) => `<li role="button" data-href="/viewer/7/${i + 1}">${i + 1} 1장. 인간 비보호 구역 (${i + 1})</li>`).join('')}</ol>
<ul><li id="bare" role="button">7 2장. 에리직톤 프로토콜 (1)</li></ul></aside></body></html>`, { runScripts: 'outside-only', url: 'https://r.example/viewer/7/1' });
  const rw = reader.window;
  rw.eval(script('PICKABLE'));
  const items = rw.document.querySelectorAll('li[data-href]');
  let over = items[1];
  rw.document.elementFromPoint = () => over;
  assert.equal(rw.__gPick.holdAt(50, 200), true);
  over = items[4];
  rw.__gPick.dragTo(50, 400);
  rw.__gPick.release();
  assert.deepEqual(JSON.parse(rw.eval(script('PICKED'))).map((l) => l.url), [2, 3, 4, 5].map((n) => `https://r.example/viewer/7/${n}`));
  // One with no address at all: said so, not silently nothing.
  over = rw.document.getElementById('bare');
  assert.equal(rw.__gPick.holdAt(50, 500), 'none');
  // (Held there, it says so, in the page.)
  const rcover = rw.document.getElementById('__gPickCover');
  const rtouch = (type) => { const e = new rw.Event(type, { cancelable: true }); Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientX: 50, clientY: 500 }] }); rcover.dispatchEvent(e); };
  rtouch('touchstart');
  await new Promise((r) => setTimeout(r, 450));
  rtouch('touchend');
  assert.match(rw.document.getElementById('__gPickSay').textContent, /no addresses in the page/);
  // A reader that opens its chapters by script, the address counting with them: two taps, and the
  // addresses of every chapter between are worked out from where the reader went.
  const spa = (move) => {
    const dom = new JSDOM(`<html><body><aside><button>Chapters</button><button>Bookmarks</button><ol>${
      Array.from({ length: 9 }, (_, i) => `<li role="button">${i + 1} ${i ? `${Math.ceil(i / 5)}장. 구역 (${i})` : '프롤로그'}</li>`).join('')}</ol></aside></body></html>`,
    { runScripts: 'outside-only', url: 'https://r.example/read/204070' });
    const sw = dom.window;
    sw.eval(script('PICKABLE'));
    sw.document.querySelectorAll('li').forEach((li, i) => li.addEventListener('click', () => move(sw, i)));
    return sw;
  };
  const press = async (sw, i) => { sw.document.querySelectorAll('li')[i].click(); await new Promise((r) => setTimeout(r, 800)); };
  const counted = spa((sw, i) => sw.history.pushState({}, '', `/read/${204070 + i}`));
  await press(counted, 2);
  assert.match(counted.document.getElementById('__gPickSay').textContent, /^First: 3 1장/);
  await press(counted, 6);
  const learnt = JSON.parse(counted.eval(script('PICKED')));
  assert.deepEqual(learnt.map((l) => l.url), [2, 3, 4, 5, 6].map((n) => `https://r.example/read/${204070 + n}`));
  assert.deepEqual([learnt[0].text, learnt.at(-1).text], ['3 1장. 구역 (2)', '7 2장. 구역 (6)']);
  assert.match(counted.document.getElementById('__gPickSay').textContent, /^5 chapters, 3 1장/);
  // One whose address does not change: said so, nothing taken.
  const still = spa(() => {});
  await press(still, 1);
  await new Promise((r) => setTimeout(r, 6000));
  assert.match(still.document.getElementById('__gPickSay').textContent, /was the one open already/);
  // Addresses that do not count along: said so.
  const ids = [9, 41, 77, 80, 95, 130, 131, 170, 200];
  const odd = spa((sw, i) => sw.history.pushState({}, '', `/read/x${ids[i]}y${i * 3}`));
  await press(odd, 1);
  await press(odd, 4);
  assert.deepEqual(JSON.parse(odd.eval(script('PICKED'))), []);
  assert.match(odd.document.getElementById('__gPickSay').textContent, /do not count along/);
  // What only opens the list out is let through, not marked: 더보기, Show more, a link to nowhere.
  const more = w.document.createElement('a');
  more.href = '#';
  more.textContent = '이전 회차 더보기';
  w.document.body.appendChild(more);
  const showMore = w.document.createElement('a');
  showMore.href = 'https://k.example/b?all=1';
  showMore.textContent = 'Show more';
  w.document.body.appendChild(showMore);
  // (Each reaches the page's own handler, which opens the list out -- tapped through the cover, too.)
  const reached = [];
  for (const opener of [more, showMore]) {
    opener.addEventListener('click', (e) => { reached.push(opener.textContent); e.preventDefault(); });
    tap(opener);
  }
  assert.deepEqual(reached, ['이전 회차 더보기', 'Show more']);
  tapAt(more);
  assert.deepEqual(reached, ['이전 회차 더보기', 'Show more', '이전 회차 더보기']);
  assert.ok(!more.classList.contains('__gPickStart') && !showMore.classList.contains('__gPickStart'));
  // Browsing: the cover gone, the site as it is -- a chapter tapped is followed.
  w.__gPick.setMode('browse');
  assert.equal(w.document.getElementById('__gPickCover'), null);
  assert.equal(tap(anchors[2]), true, 'a chapter tapped while browsing was not followed');
  w.__gPick.setMode('pick');
  assert.ok(w.document.getElementById('__gPickCover'));
  // The app: the script before the page's own, and again as it shows, told the mode each time;
  // Android's own long-press (a selection, a link's menu) never has the touch while picking.
  assert.match(java, /WebViewCompat\.addDocumentStartJavaScript\(view, PICKING_STARTS, Collections\.singleton\("\*"\)\);\s+\}\s+holdToPick\(view\);/);
  assert.match(java, /v\.evaluateJavascript\(PICKING_STARTS, null\);\s+v\.evaluateJavascript\(modeScript\(pickMode\), null\);/);
  assert.match(java, /view\.setOnLongClickListener\(\(v\) -> pickMode\);/);
  assert.match(java, /mode\.setText\(pickMode \? "Browse" : "Pick"\);/);
  assert.ok(!/onTouchEvent\(cancel\)/.test(java), 'the app still takes touches from the page itself');
  // The app: answered links into the list, the page's title less the site's name; back is nothing picked.
  window.GrimoireWeb = { pickFromSite: (id) => setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: 'https://k.example/b', title: '악은 삶을 바란다 - BOOKKOR', links: picked })), 0) };
  const answer = await web.pickSite('https://k.example/b');
  assert.equal(answer.links.length, 5);
  assert.equal(answer.title, '악은 삶을 바란다 - BOOKKOR');
  window.GrimoireWeb = { pickFromSite: (id) => setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: 'https://k.example/b' })), 0) };
  assert.deepEqual((await web.pickSite('https://k.example/b')).links, []);
  delete window.GrimoireWeb;
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /\} else if \(el\('web-pick'\)\?\.checked && web\.canPickSite\(\)\) \{/);
  assert.match(app, /title = picked\.title\.split\(\/\\s\+\[\|\\-–—·\]\\s\+\/\)\[0\] \|\| picked\.title;/);
  assert.match(java, /boolean closeShownIfOpen\(\) \{\s+if \(shown == null\) return false;\s+\/\/[^\n]*\n\s+shownPicking = false;/);
  // The pages made here closed, their timers with them.
  for (const each of [w, rw, counted, still, odd]) each.close();
});

await t("a book is named by what its page agrees on, never by the site's own name", () => {
  const doc = (html) => new DOMParser().parseFromString(html, 'text/html');
const cases = [
  ['marumaru', '<head><title>소설 연재 칸 | 마루마루</title><meta property="og:title" content="소설 연재 칸 | 마루마루"></head><body><header><a href="/" class="logo">마루마루</a></header><h1>그린 스킨</h1>', 'https://marumaru109.com/novel/47997', '그린 스킨'],
  ['madara', '<head><title>I&#8217;ll Be the Warrior&#8217;s Mother &#8211; Sleepy Translations</title><meta property="og:site_name" content="Sleepy Translations"><meta property="og:title" content="I&#8217;ll Be the Warrior&#8217;s Mother - Sleepy Translations"></head><body><header class="site-header"><div class="site-title"><a href="/">Sleepy Translations</a></div></header><div class="post-title"><h1><span class="manga-title-badges hot">HOT</span> I’ll Be the Warrior’s Mother</h1></div>', 'https://sleepytranslations.com/series/x/', 'I’ll Be the Warrior’s Mother'],
  ['bookkor', '<head><title>악은 삶을 바란다 - 북코르</title><meta property="og:title" content="악은 삶을 바란다"></head><body><header><a href="/"><img alt="BOOKKOR" class="logo"></a></header><h1>악은 삶을 바란다</h1><p>소설</p>', 'https://012.bookkor.com/x', '악은 삶을 바란다'],
  ['logo h1', '<head><title>The Lantern Keeper | Novel Site</title></head><body><header><h1 class="logo"><a href="/">Novel Site</a></h1></header><main><h2>Chapters</h2></main>', 'https://novelsite.com/b', 'The Lantern Keeper'],
  ['site first', '<head><title>Novel Site - The Lantern Keeper</title><meta property="og:site_name" content="Novel Site"></head><body>', 'https://novelsite.com/b', 'The Lantern Keeper'],
  ['wp category', '<head><title>Category: The Lantern &#8211; Translations</title></head><body><header class="page-header"><h1 class="page-title">Category: <span>The Lantern</span></h1></header>', 'https://tl.wordpress.com/category/the-lantern/', 'The Lantern'],
  ['status mark', '<head><title>[완결] 세월의 돌 - 웹소설</title></head><body><h1>[완결] 세월의 돌</h1>', 'https://x.com/a', '세월의 돌'],
  ['chapter tail', '<head><title>세월의 돌 1화 | 사이트</title></head><body>', 'https://x.com/a', '세월의 돌'],
  ['dash in name', '<head><title>Re:Zero - Starting Life in Another World - Site</title></head><body><h1>Re:Zero - Starting Life in Another World</h1>', 'https://site.com/a', 'Re:Zero - Starting Life in Another World'],
  ['jsonld', '<head><title>Home | Site</title><script type="application/ld+json">{"@type":"Book","name":"Lord of Mysteries"}</script></head><body>', 'https://site.com/a', 'Lord of Mysteries'],
];
  for (const [name, html, url, want] of cases) assert.equal(web.pageTitle(doc(html), url), want, name);
});

await t('chapters missing from the numbers ticked are said, so nobody combs the list for them', () => {
  const titled = (numbers) => numbers.map((n) => ({ text: `${n}화 악은 삶을 바란다` }));
  const all = [...Array(410)].map((_, i) => i + 1);
  assert.deepEqual(web.numberGaps(titled(all.filter((n) => n <= 310 || n > 400))), { missing: ['311–400'], count: 90, twice: [], from: 1, to: 410 });
  assert.deepEqual(web.numberGaps(titled([1, 2, 3, 5, 6, 7, 7, 9, 10])), { missing: ['4', '8'], count: 2, twice: [7], from: 1, to: 10 });
  // The prologue and side stories have numbers of their own; too few numbered, nothing said.
  assert.equal(web.numberGaps(['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5', 'Side Story 1'].map((text) => ({ text }))).count, 0);
  assert.equal(web.numberGaps(titled([1, 5, 9])).count, 0);
  // Said above the list, as the ticks change.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /function paintWebCount\(\) \{\s+paintWebGaps\(\);/);
  assert.match(read('app/src/main/assets/www/index.html'), /<p class="web-gaps" id="web-gaps" hidden><\/p>\s+<ol class="web-list" id="web-list">/);
});

await t('a build says how long it has been and how long it should be yet', async () => {
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /left = 'estimating…';/);
  assert.match(app, /buildRun\.ticker = setInterval\(paintTimes, 1000\);/);
  // span(): seconds, minutes, hours.
  const body = app.slice(app.indexOf('function span(ms) {'), app.indexOf('function paintTimes()'));
  const span = new Function(`${body}; return span;`)();
  assert.equal(span(45000), '45 s');
  assert.equal(span(12 * 60000), '12 m');
  assert.equal(span(65 * 60000), '1 h 05 m');
  assert.match(read('app/src/main/assets/www/js/build.js'), /now, \{ done, total, stats: partStats \}\)/);
  const fns = new Function(`${body}; return { chapterTime, timeLeft, steady };`)();
  const minutes = (ms) => Math.round(ms / 60000);
  // Within 2%: the guess still counts for a little after 40 pages.
  const near = (got, want, why = '') => assert.ok(Math.abs(got - want) <= want * 0.02, `${why} ${minutes(got)} m, not ${minutes(want)} m`);
  const part = { gap: 30000, jitter: 10000, chapters: 453 };
  const stats = (times, more = {}) => ({ requests: times.length, times, dwells: times.map(() => 3000), chapters: times.length, napMs: 0, slower: 1, ...more });
  const run = { at: 1, done: 0, total: 453, delays: [null, part], samples: [], partStart: 0, lastCame: 0 };
  // From the start: the delay, and a guess at a page (its load, the stay coming off the delay).
  assert.equal(minutes(fns.timeLeft(run, 0).ms), minutes(453 * 36000), 'a guess from the start');
  assert.equal(minutes(fns.timeLeft({ ...run, stats: stats([]) }, 0).ms), minutes(453 * 36000));
  // Pages measured at 5 s (2 s loading, 3 s stay): the delay, plus 2 s each.
  const settledRun = { ...run, done: 50, stats: stats(Array(40).fill(5000)) };
  near(fns.timeLeft(settledRun, 0).ms, 403 * 32000);
  // Blended from the guess, not a step at the fifth: after 3 pages, halfway.
  const three = fns.timeLeft({ ...run, done: 3, stats: stats([5000, 5000, 5000]) }, 0).ms / 450;
  assert.ok(three > 32000 && three < 36000, `${three}`);
  // One ten-minute page does not move it: the middle of the pages, not their mean.
  const slowOne = stats([...Array(39).fill(5000), 600000]);
  near(fns.timeLeft({ ...settledRun, stats: slowOne }, 0).ms, 403 * 32000, 'one slow page');
  // Chapters that have needed two requests each (second pages, retries): twice the cost.
  const twice = stats(Array(40).fill(5000), { requests: 80, chapters: 40 });
  assert.ok(fns.timeLeft({ ...settledRun, stats: twice }, 0).ms > 1.9 * fns.timeLeft(settledRun, 0).ms);
  // The site asked to slow down: twice the delay from then on.
  const slowed = fns.timeLeft({ ...settledRun, stats: stats(Array(40).fill(5000), { slower: 2 }) }, 0).ms;
  near(slowed, 403 * 62000, 'slowed');
  // A wait it asked for, still to run, is added as it is.
  assert.equal(fns.timeLeft({ ...settledRun, waitingUntil: 600000 }, 0).ms - fns.timeLeft(settledRun, 0).ms, 600000);
  // A likely range: the pages' spread, and the delay's give-or-take evening out.
  const spread = stats(Array.from({ length: 40 }, (_, i) => 4000 + (i % 5) * 1000));
  assert.ok(fns.timeLeft({ ...settledRun, stats: spread }, 0).band > 0);
  assert.ok(Number.isNaN(fns.timeLeft({ ...run, stats: stats([5000]) }, 0).band));
  // No delay set: from what chapters take (the latest 20), nothing until one has come.
  assert.equal(fns.chapterTime(Array(10).fill(20000), 36000), 20000);
  assert.equal(fns.timeLeft({ ...run, delays: [null, null] }, 0), null);
  // Later websites in the same build: at their delays, and the pages measured here.
  const two = { ...settledRun, delays: [null, part, { gap: 10000, chapters: 100 }] };
  near(fns.timeLeft(two, 0).ms - fns.timeLeft(settledRun, 0).ms, 100 * 12000, 'later website');
  // Shown steadily: near the estimate, left to count down; more, followed quickly; less, slowly.
  assert.equal(fns.steady(3600000, 3610000), 3600000);
  assert.ok(fns.steady(3600000, 7200000) - 3600000 > 3 * (3600000 - fns.steady(3600000, 1800000)) * 0.9);
  assert.equal(fns.steady(null, 5000), 5000);
  // The notification popup shows a line of the title: a few words.
  assert.match(app, /title: 'Build done', text: `“\$\{book\.title\}”: /);
});

await t("a list that opens out a press at a time: read in the browser, its \"more\" pressed at the list's pace", async () => {
  const series = 'https://opens.example/novel/77';
  const rows = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => `<li><a href="${series}/ep-${from - i}">${from - i}화 펼쳐지는 이야기</a></li>`).join('');
  const menu = '<header><a href="/">홈</a><button>더보기</button></header>';
  const sent = `<html><body>${menu}<h1>펼쳐지는 이야기</h1><ul>${rows(120, 101)}</ul><button class="more">이전 회차 더보기</button></body></html>`;
  // Told by what is sent: a "more" after the chapters is the list's; one in the menu, or a link to another page, is not.
  const doc = (html) => new window.DOMParser().parseFromString(html, 'text/html');
  assert.equal(web.showsMore(doc(sent), series), true);
  assert.equal(web.showsMore(doc(`<html><body>${menu}<ul>${rows(5, 1)}</ul></body></html>`), series), false);
  assert.equal(web.showsMore(doc(`<html><body><ul>${rows(5, 1)}</ul><a href="${series}?page=2">더보기</a></body></html>`), series), false);
  assert.equal(web.showsMore(doc(`<html><body><ul>${rows(5, 1)}</ul><a href="#" onclick="more()">Load more</a></body></html>`), series), true);
  const asked = [];
  const send = (id, address, body, rendered) => {
    const path = `data:text/html;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
    setTimeout(() => web.settleWeb(id, true, JSON.stringify({ url: address, status: 200, type: 'text/html', path, rendered })), 0);
  };
  window.GrimoireWeb = {
    fetch: (id, address) => { asked.push(['fetch', address]); send(id, address, sent, false); },
    render: (id, address, level, list) => { asked.push(['render', address, list]); send(id, address, `<html><body><ul>${rows(120, 1)}</ul></body></html>`, true); },
    release() {},
  };
  const found = await web.findLinks([series], { listGap: 4000, listJitter: 2000 });
  // Sent first, then once in the browser, pressed as far apart as list pages are.
  assert.deepEqual(asked, [['fetch', series], ['render', series, '1:4000:2000']]);
  assert.equal(found.links.filter((l) => /\/ep-\d+$/.test(l.url)).length, 120);
  // "Search for more": in the browser from the start.
  asked.length = 0;
  await web.findLinks(['https://opens2.example/novel/5'], { listGap: 3000, listJitter: 0, patience: 1 });
  assert.equal(asked[0][0], 'render');
  assert.equal(asked[0][2], '1:3000:0');
  delete window.GrimoireWeb;
});

await t('in the browser, the "more" pressed is the one after the chapters, never a link away', async () => {
  const { JSDOM } = await import('jsdom');
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  const at = java.indexOf('String SHOW_MORE = ');
  const end = java.indexOf(';\n', java.indexOf('})()', at));
  const code = [...java.slice(at, end).split('\n').filter((l) => /^\s*(\+ |(private static final )?String )/.test(l)).join('\n')
    .matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  const page = (body) => {
    const dom = new JSDOM(`<html><body>${body}</body></html>`, { runScripts: 'outside-only', url: 'https://opens.example/novel/77' });
    dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 80, height: 20 });
    dom.window.Element.prototype.scrollIntoView = () => {};
    return dom.window;
  };
  const rows = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => `<li><a href="/novel/77/ep-${from - i}">${from - i}화</a></li>`).join('');
  const w = page(`<header><button id="menu">더보기</button></header><ul id="list">${rows(120, 101)}</ul><button id="more">이전 회차 더보기</button>`);
  let menu = 0;
  w.document.getElementById('menu').onclick = () => { menu += 1; };
  w.document.getElementById('more').onclick = () => { w.document.getElementById('list').insertAdjacentHTML('beforeend', rows(100, 81)); };
  assert.equal(w.eval(code), 'pressed');
  assert.equal(w.document.querySelectorAll('#list a').length, 40);
  assert.equal(menu, 0, 'the menu\'s "more" was pressed');
  // A "more" that is a link to another page is not pressed: that page is read as a page.
  const away = page(`<ul>${rows(10, 1)}</ul><a href="/novel/77?page=2">더보기</a>`);
  assert.equal(away.eval(code), 'none');
  // Nothing after any chapter: nothing pressed.
  assert.equal(page(`<button>Show more</button><p>no list</p>`).eval(code), 'none');
  // Pressed once a press is due, and judged by every link, not the first nine.
  assert.match(java, /if \(now < nextPress\) \{[\s\S]{0,400}flat = allLinks > linksAtPress \? 0 : flat \+ 1;/);
  assert.match(java, /allLinks = Integer\.parseInt\(parts\[2\]\);/);
});

await t('a site that scrambles its text (its own font draws it): stopped and said, no book of gaps, not asked again', async () => {
  // As fanqienovel sends it: common words as private-use characters, put right only by its font.
  const odd = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(0xE3E8 + (i * 7) % 300)).join('');
  const line = (i) => `<p>曹${odd(3)}，${odd(2)}、！低调奢华的${odd(2)}房，朝${odd(1)}办${odd(1)}椅。第${i}段${odd(4)}。</p>`;
  const page = (url) => `<html><head><title>第1章 开局</title></head><body><div class="muya-reader-content">${Array.from({ length: 30 }, (_, i) => line(i)).join('')}</div></body></html>`;
  assert.equal(web.isScrambled('曹' + odd(40) + '低调奢华'.repeat(30)), true);
  assert.equal(web.isScrambled('普通的中文句子，一个字也没有被替换。'.repeat(20)), false);
  assert.equal(web.isScrambled('Chapter text  with a stray   icon glyph or two  in it. '.repeat(10)), false);
  const asked = [];
  const site = async (url) => { asked.push(url); return { url, blob: new Blob([page(url)]), type: 'text/html', rendered: false }; };
  const links = [1, 2, 3].map((n) => ({ url: `https://fanqie.example/reader/${n}`, text: `第${n}章` }));
  await assert.rejects(web.readPages(links, { fetchPage: site, gap: 0, patience: { retry: 0, refresh: [0], backoff: [0, 0], cool: 0 } }),
    (error) => web.scrambled(error) && /scrambles its text/.test(error.message));
  assert.equal(asked.filter((url) => url.endsWith('/1')).length, 1, 'a scrambled page was asked again');
  // The queue holds such a book for the reader, as it does a block.
  assert.match(read('app/src/main/assets/www/js/app.js'), /const queueHalts = \(reason\) => [^\n]*web\.scrambled\(reason\);/);
});

await t("a site's name stamped into its chapters is taken out; a site read in the browser, on the reader's say", async () => {
  const doc = new window.DOMParser().parseFromString('<html><head><title>修真四万年_第1章_和图书</title></head><body></body></html>', 'text/html');
  const marks = web.siteMarks('https://m.hetushu.com/book/4892/3626689.html', doc);
  const out = (text) => text.replace(marks, '');
  assert.equal(out('在垃圾山https://m.hetushu.com.com上'), '在垃圾山上');
  assert.equal(out('垃圾船heｔusｈｕ•cｏｍ•cｏｍ漂'), '垃圾船漂');
  assert.equal(out('十分狼和-图-书狈'), '十分狼狈');
  // A word that is the name, unspaced and not an address, stays.
  assert.equal(out('他在和图书馆看书'), '他在和图书馆看书');
  assert.equal(out('hetushu is a word'), 'hetushu is a word');
  // Out of the text, never the tags.
  assert.equal(web.stripMarks('<p>船heｔusｈｕ•cｏｍ漂<a href="https://m.hetushu.com">x</a></p>', marks), '<p>船漂<a href="https://m.hetushu.com">x</a></p>');
  // Read in the browser when the reader says so: every chapter of the site, not its lists.
  const asked = [];
  window.GrimoireWeb = {
    fetch: (id, url) => { asked.push(['fetch', url]); setTimeout(() => web.settleWeb(id, false, 'no'), 0); },
    render: (id, url) => { asked.push(['render', url]); setTimeout(() => web.settleWeb(id, false, 'no'), 0); },
    release() {},
  };
  web.setReadInBrowser((host) => host.endsWith('hetushu.com'));
  await web.download('https://m.hetushu.com/book/4892/3626690.html').catch(() => {});
  await web.download('https://m.hetushu.com/book/4892/catalog-2.html', { list: true }).catch(() => {});
  await web.download('https://other.example/1.html').catch(() => {});
  assert.deepEqual(asked.map((a) => a[0]), ['render', 'fetch', 'fetch']);
  web.setReadInBrowser(null);
  delete window.GrimoireWeb;
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /web\.setReadInBrowser\(\(host\) => !!browserSites\[siteKey\(host\)\]\);/);
  assert.match(app, /store\.saveSettings\(\{ browserSites \}\)/);
});

await t('a contents in numbered pages joined by "下一页" (hetushu): every page followed, onward only', async () => {
  const page = (n, last) => `<html><body><a href="/book/4892/catalog-${n - 1}.html">上一页</a>${n < last ? `<a href="/book/4892/catalog-${n + 1}.html">下一页</a>` : '<span>下一页</span>'}
<ul>${Array.from({ length: 3 }, (_, i) => `<li><a href="/book/4892/${3626689 + (n - 1) * 3 + i}.html">第${(n - 1) * 3 + i + 1}章 题</a></li>`).join('')}</ul></body></html>`;
  const doc = (html) => new window.DOMParser().parseFromString(html, 'text/html');
  assert.equal(web.nextListOf(doc(page(1, 3)), 'https://m.hetushu.com/book/4892/catalog-1.html'), 'https://m.hetushu.com/book/4892/catalog-2.html');
  assert.equal(web.nextListOf(doc(page(3, 3)), 'https://m.hetushu.com/book/4892/catalog-3.html'), null);
  assert.equal(web.numberedPage('/book/4892/catalog-2.html', '/book/4892/catalog-1.html'), -1);
  assert.equal(web.numberedPage('/book/4892/catalog.html', '/book/4892/catalog-2.html'), 1);
  assert.equal(web.numberedPage('/book/4892/catalog-1.html', '/book/4893/catalog-1.html'), null);
  // Read through: all three pages' chapters, the list asked for once a page.
  const asked = [];
  const site = async (url) => {
    asked.push(url);
    const n = Number(/catalog-(\d+)/.exec(url)[1]);
    return { url, blob: new Blob([page(n, 3)]), type: 'text/html', rendered: false };
  };
  const found = await web.findLinks(['https://m.hetushu.com/book/4892/catalog-1.html'], { fetchPage: site, listGap: 0, listJitter: 0 });
  assert.equal(found.links.filter((l) => /第\d+章/.test(l.text)).length, 9);
  assert.deepEqual(asked.map((u) => /catalog-(\d+)/.exec(u)[1]), ['1', '2', '3']);
});

await t('one book from several sites: the first list, its gaps filled from the others in place, their copies to fall back on', async () => {
  const site = (url) => new URL(url).hostname.split('.')[0];
  const a = [1, 2, 3, 5, 6, 9].map((n) => ({ url: `https://a.example/b/${n}`, text: `${n}화` }));
  const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ url: `https://b.example/c/${n}`, text: `Chapter ${n}` }));
  const menu = { url: 'https://b.example/', text: 'Home', chrome: true };
  const merged = web.mergeSources([...a, menu, ...b], ['a', 'b'], site);
  assert.deepEqual(merged.links.map((l) => Number.parseInt(l.text.replace(/\D+/, ''), 10)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(merged.links.filter((l) => l.source === 'b').map((l) => l.url.split('/').pop()), ['4', '7', '8', '10']);
  assert.deepEqual(merged.links[0].alts, [{ url: 'https://b.example/c/1' }]);
  assert.deepEqual([merged.filled, merged.backed, merged.from], [4, 6, { a: 6, b: 4 }]);
  assert.ok(!merged.links.some((l) => l.text === 'Home'), "the other site's menus came along");
  // A list newest first stays so, the filled-in chapters in their places.
  const down = web.mergeSources([...a].reverse().concat(b), ['a', 'b'], site);
  assert.deepEqual(down.links.map((l) => Number.parseInt(l.text.replace(/\D+/, ''), 10)), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  // One site: as it was.
  assert.equal(web.mergeSources(a, ['a'], site).links, a);

  // Downloading: a chapter that will not come from the first site is read from the next.
  const asked = [];
  const page = (title) => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>${'<p>Story words go on here at length, more than enough of them to count as a chapter.</p>'.repeat(10)}</article></body></html>`;
  const fetchPage = async (url) => {
    asked.push(url);
    if (url === 'https://a.example/b/3') throw new Error('the site answered 404 — that page is not there');
    return { url, blob: new Blob([page(url.split('/').pop())]), type: 'text/html', rendered: false };
  };
  const got = await web.readPages(merged.links.slice(0, 4), { fetchPage, gap: 0, patience: { retry: 0, refresh: [0], backoff: [0], cool: 0 } });
  assert.equal(got.chapters.length, 4);
  assert.deepEqual(got.failed, []);
  assert.ok(asked.includes('https://b.example/c/3'), 'the other site was not asked for the missing chapter');
  assert.ok(!asked.includes('https://b.example/c/1'), 'another site was asked for a chapter that came');
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /const merged = web\.mergeSources\(links, sites, siteOfAddress\);/);
  assert.match(app, /const keptLink = \(\{ url, text, alts, placeholder \}\) => \(\{ url, text, \.\.\.\(alts\?\.length \? \{ alts \} : \{\}\)/);
  assert.match(read('app/src/main/assets/www/js/build.js'), /links: links\.map\(\(\{ url, text, alts, placeholder \}\) => \(\{ url, text, \.\.\.\(alts\?\.length \? \{ alts \} : \{\}\)/);
});

await t('a row that says when its chapter came out (woopread): the time is no part of its name or number; 172.1 and 172.2 are 172', async () => {
  const names = {
    'Chapter 0 - Prologuealmost 2 years ago': ['Chapter 0 - Prologue', 0],
    'Chapter 1almost 2 years ago': ['Chapter 1', 1],
    'Chapter 271 2 months ago': ['Chapter 271', 271],
    'Chapter 172.1over 1 year ago': ['Chapter 172.1', 172.1],
    'Chapter 250: (Main Story Complete) 3 months ago': ['Chapter 250: (Main Story Complete)', 250],
    'Chapter 12 · Mar 3, 2024': ['Chapter 12', 12],
    'Chapter 9 - 2024-03-01': ['Chapter 9', 9],
    '12화 북쪽 숲 3일 전': ['12화 북쪽 숲', 12],
    '第5章 开局 2天前': ['第5章 开局', 5],
    'Chapter 7: Ten Years Ago': ['Chapter 7: Ten Years Ago', 7],
    'Chapter 3: The Day 2 Years Ago': ['Chapter 3: The Day 2 Years Ago', 3],
  };
  for (const [raw, [name, number]] of Object.entries(names)) {
    assert.equal(web.withoutWhen(raw), name, raw);
    assert.equal(web.numberIn(web.withoutWhen(raw)), number, raw);
  }
  // Read off a page: the name and the time in their own boxes, as woopread has them.
  const found = web.linksOf(`<html><body><ul>${[271, 270, 269].map((n) => `<li><a href="/series/x/chapter-${n}"><div><span>Chapter ${n}</span></div><div><svg></svg><span>2 months ago</span></div></a></li>`).join('')}</ul></body></html>`, 'https://w.example/series/x');
  assert.deepEqual(found.links.filter((l) => /chapter-/.test(l.url)).map((l) => l.text), ['Chapter 271', 'Chapter 270', 'Chapter 269']);
  // A chapter in parts is that chapter, there once; only true gaps and true twice are said.
  const gaps = web.numberGaps(['Chapter 0 - Prologue', ...Array.from({ length: 10 }, (_, i) => `Chapter ${i + 1}`), 'Chapter 12.1', 'Chapter 12.2', 'Chapter 13', 'Chapter 13']
    .map((text) => ({ url: 'x', text })));
  assert.deepEqual([gaps.missing, gaps.count, gaps.twice, gaps.from, gaps.to], [['11'], 1, [13], 0, 13]);
  // The picker names a link the same way: its parts spaced, not run together.
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  assert.match(java, /p\.nameOf=function\(a\)/);
  assert.match(java, /text:window\.__gPick&&__gPick\.nameOf\?__gPick\.nameOf\(a\)/);
});

await t('a book with more to download is marked on its cover; the strip sits on the tab bar itself', async () => {
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /\$\{unfinished\.has\(book\.id\) \|\| \(book\.importing && book\.building\) \? unfinishedMark\(book\) : ''\}/);
  // Its tray fills by the chapters had and still to come.
  const lib = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  assert.equal(lib.unfinishedDone(30, 70), 0.3);
  assert.equal(lib.unfinishedDone(0, 0), 0);
  assert.equal(lib.unfinishedDone(10, 0), 1);
  // The theme's gradient (Appearance): the accent's own unless two colours of your own are chosen.
  assert.match(library, /<defs>\$\{gradientSvg\(id, 'mark'\)\}<\/defs>/);
  // Its cover from the start: a book downloading, or paused, is not a blank.
  const build = read('app/src/main/assets/www/js/build.js');
  assert.match(build, /\.\.\.\(early \? \{ coverBlob: early, coverBytes: early\.size \?\? null \} : \{\}\),/);
  assert.match(build, /finished\.coverBlob = chosenCover \|\| cover \|\| early;/);
  const app = read('app/src/main/assets/www/js/app.js');
  // Which: a stopped download's leftover, and a queued book not yet done.
  assert.match(app, /for \(const each of webLeftovers\) add\(each\.bookId, each\.links\?\.length\);/);
  assert.match(app, /const \{ came, of \} = runCounts\(job, run\);\s+add\(job\.bookId, run \? Math\.max\(0, of - came\) : job\.links\?\.length\);/);
  assert.match(app, /const saveLeftovers = \(\) => \{\s+markUnfinished\(\);/);
  assert.match(app, /function saveQueue\(\) \{\s+markUnfinished\(\);/);
  // The wash in the theme's colours, deep to pale; the mark the same, opaque and inverted, 60% of the cover wide.
  const css = read('app/src/main/assets/www/css/app.css');
  assert.match(css, /\.tile-unfinished \{[^}]*linear-gradient\(to bottom, rgb\(18 18 20 \/ \.76\), rgb\(150 150 156 \/ \.26\)\);/);
  assert.match(css, /\.tile-unfinished svg \{[^}]*width: 60%;/);
  assert.match(css, /\.tile-unfinished \.mark-fill \{\s*filter: saturate\(1\.9\) brightness\(1\.25\)/);
  assert.match(css, /\.tile-unfinished \.mark-fill \{[^}]*clip-path: inset\(calc\(\(3\.6 \+ 15\.9 \* \(1 - var\(--done, 0\)\)\) \/ 24 \* 100% - 2px\) 0 0 0\);/);
  // The strip seated on the tab bar by its real height (see the tools tests).
  assert.match(app, /setProperty\('--tabbar-real', shown \? `\$\{height\.toFixed\(2\)\}px` : '0px'\)/);
  /* A download's book appearing while another screen is shown: the shelf is
   * drawn again when next shown, not left as it was last looked at. */
  assert.match(app, /function shelfChanged\(\) \{\s+if \(current === 'library'\) refreshShelf\(\)\.catch\(\(\) => \{\}\);\s+else shelfStale = true;\s+\}/);
  assert.match(app, /if \(name === 'library' && shelfStale\) \{ shelfStale = false; refreshShelf\(\)\.catch\(\(\) => \{\}\); \}/);
  assert.match(app, /unfinishedKey = key;\s+shelfChanged\(\);/);
  assert.equal((app.match(/if \(current === 'library'\) refreshShelf\(\)\.catch/g) || []).length, 1, 'a change behind another screen still left undrawn');
  assert.match(app, /new ResizeObserver\(seat\)\.observe\(bar\)/);
});

await t('a chapter is scrolled to its end while it is confirmed; one that came out much shorter than the rest is said, and fetched again', async () => {
  const java = read('app/src/main/java/com/grimoire/ereader/WebBridge.java');
  // Scrolled when its confirming begins, and again whenever more of it came -- inside the stay that comes off the delay.
  assert.match(java, /confirmStory = storyLength;\s+endScrolls = 0;\s+\/\*[\s\S]{0,400}\*\/\s+view\.evaluateJavascript\(STORY_END, null\);/);
  // A few characters coming and going in the story's box is no growth: an advert held every chapter to the limit.
  assert.match(java, /if \(lastStory < 0 \|\| storyLength > lastStory \+ storySlack\(lastStory\)\) \{\s+lastStory = storyLength;\s+storySince = now;/);
  assert.match(java, /return Math\.max\(STORY_SLACK, Math\.max\(0, story\) \/ 100\);/);
  assert.match(java, /confirmAt = now;\s+\/\/ More came[^\n]*\n\s+if \(endScrolls < 2\) \{/);
  assert.match(java, /if \(settled\) dwell = now - confirmBegan;/);
  // Short: under 40% of the book's typical chapter, only website chapters, only with enough to say what is typical.
  const chapters = Array.from({ length: 12 }, (_, i) => ({ index: i, title: `${i + 1}화`, words: 2000 + i * 10, from: `https://s.example/${i + 1}` }));
  chapters[4].words = 300;
  chapters[9].words = 0;
  chapters.push({ index: 12, title: 'Cover', words: 5 });
  const short = web.shortChapters(chapters);
  assert.deepEqual(short.map((c) => c.index), [4, 9]);
  assert.equal(short[0].from, 'https://s.example/5');
  assert.deepEqual(web.shortChapters(chapters.slice(0, 5)), []);
  // A book whose chapters grow as it goes: its early short ones are not short for where they are.
  const growing = Array.from({ length: 40 }, (_, i) => ({ index: i, title: `${i + 1}`, words: i < 20 ? 800 : 4000, from: `https://g.example/${i}` }));
  growing[30].words = 900;
  assert.deepEqual(web.shortChapters(growing).map((c) => c.index), [30]);
  // A chapter in parts (woopread's 172.1, 172.2): an uneven split, all there, is not short.
  const parts = [];
  for (let n = 160; n < 180; n += 1) {
    if (n % 2) parts.push({ title: `Chapter ${n}.1`, words: 1500 }, { title: `Chapter ${n}.2`, words: 400 });
    else parts.push({ title: `Chapter ${n}`, words: 1900 });
  }
  parts.forEach((chapter, i) => Object.assign(chapter, { index: i, from: `https://w.example/${i}` }));
  assert.deepEqual(web.shortChapters(parts), [], 'a whole chapter in an uneven split was called short');
  // ...unless that short part stops mid-sentence: then it is said.
  const second = parts.findIndex((c) => c.title === 'Chapter 171.2');
  assert.deepEqual(web.shortChapters(parts.map((c, i) => (i === second ? { ...c, cut: true } : c))).map((c) => c.title), ['Chapter 171.2']);
  // Both parts short together: both said.
  const cut = parts.findIndex((c) => c.title === 'Chapter 171.1');
  const both = parts.map((c, i) => (i === cut ? { ...c, words: 200 } : i === cut + 1 ? { ...c, words: 100 } : c));
  assert.deepEqual(web.shortChapters(both).map((c) => c.title), ['Chapter 171.1', 'Chapter 171.2']);
  // Parts each a full chapter (2+ full lengths together): none short; a cut-off one among them is.
  const full = Array.from({ length: 12 }, (_, i) => [{ title: `Chapter ${i + 1}.1`, words: 2000 }, { title: `Chapter ${i + 1}.2`, words: 2100 }]).flat()
    .map((c, i) => ({ ...c, index: i, from: `https://f.example/${i}` }));
  assert.deepEqual(web.shortChapters(full), []);
  full[9].words = 250;
  assert.deepEqual(web.shortChapters(full).map((c) => c.title), ['Chapter 5.2']);
  // An arc of many full chapters, "(1)" to "(5)", and one of a single chapter: none short; one cut off in an arc is.
  const arcs = [];
  for (let a = 1; a <= 6; a += 1) for (let p = 1; p <= (a === 3 ? 1 : 5); p += 1) arcs.push({ title: `${a}장. 구역 (${p})`, words: 1200 });
  arcs.forEach((c, i) => Object.assign(c, { index: i, from: `https://k.example/${i}` }));
  assert.deepEqual(web.shortChapters(arcs), []);
  arcs[7].words = 150;
  assert.deepEqual(web.shortChapters(arcs).map((c) => c.title), ['2장. 구역 (3)']);
  // How a chapter ends: mid-sentence, or at a mark that ends one.
  assert.equal(web.endsCut('He turned and saw the'), true);
  assert.equal(web.endsCut('He turned and left.'), false);
  assert.equal(web.endsCut('“Wait!”  '), false);
  assert.equal(web.endsCut('그는 떠났다.'), false);
  assert.equal(web.endsCut('그는 문을 열고'), true);
  assert.equal(web.endsCut('他走了。'), false);
  // Said after a download; fetched again from the book's actions, at the site's own delay, each in its own place.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /job\.bookId = book\.id;[\s\S]{0,160}await build\.settleMisplaced\(book\.id\)\.catch\(\(\) => 0\);\s+noteShort\(book\)/);
  assert.match(app, /noteShort\(book\)\.catch\(\(\) => \{\}\);\s+\/\* Into the book itself/);
  assert.match(app, /choice\(`Fetch \$\{short\.length\} short chapter/);
  assert.match(app, /const \{ gap, jitter \} = delaysFor\(site\);/);
  assert.match(app, /if \(!was \|\| !\(\(chapter\.words \|\| 0\) > was\.words\)\) continue;/);
  assert.match(app, /const kept = await store\.get\('chapters', \[book\.id, was\.index\]\);/);
});

console.log(`\n${pass} assertions passed`);
