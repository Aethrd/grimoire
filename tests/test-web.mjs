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
  assert.match(app, /store\.saveSettings\(\{ webJitter: value \}\)/);
  assert.match(app, /gap: webDelay\(\), jitter: webJitter\(\)/);
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  build.clear();
  build.addWeb({ name: 'Varied', links: [{ url: `${SITE}chapter-1`, text: 'One' }], gap: 500, jitter: 200 });
  assert.equal(build.contents()[0].web.jitter, 200);
  assert.match(build.describe(build.contents()[0]), /500 ± 200 ms apart/);
  build.clear();
});

console.log(`\n${pass} assertions passed`);
