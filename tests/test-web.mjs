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
  assert.match(app, /store\.saveSettings\(\{ webDelay: value \}\)/);
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
  assert.match(app, /const kept = keepLeftovers\(failed, retried\);/);
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

console.log(`\n${pass} assertions passed`);
