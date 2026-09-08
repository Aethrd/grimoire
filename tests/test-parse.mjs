import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const window = await boot();

// jsdom has no object URLs or image decoding; stub just enough that the
// parser's image path runs end to end.
let urlSeq = 0;
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => `blob:stub/${++urlSeq}`;
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};
globalThis.Image = class { set src(v){ this.naturalWidth=800; this.naturalHeight=1200;
  setTimeout(()=>this.onload&&this.onload(),0);} };

const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

const asFile = (p, name) => new File([fs.readFileSync(p)], name);

console.log('EPUB');
const epub = await parse.parse(asFile('./tests/fixtures/salt-almanac.epub', 'salt-almanac.epub'));

await t('reads Dublin Core metadata', () => {
  assert.equal(epub.title, 'The Salt Almanac');
  assert.equal(epub.author, 'Oyelaran');
  assert.equal(epub.lang, 'en');
});
await t('reads Calibre series metadata', () => {
  assert.equal(epub.series, 'Tidewater');
  assert.equal(epub.seriesIndex, 2);
});
await t('takes chapter titles from the EPUB3 nav document', () => {
  assert.deepEqual(epub.chapters.map(c=>c.title), ['Salt and Tide','The Reckoning']);
  assert.ok(epub.chapters.every(c=>c.fromToc), 'should be flagged as coming from a real TOC');
  assert.match(epub.tocSource, /own table of contents/);
});
await t('strips scripts, styles, stylesheet links and event handlers', () => {
  const html = parse.chapterHtml(epub.chapters[0]);
  assert.ok(!/<script/i.test(html), 'script survived');
  assert.ok(!/<style/i.test(html), 'style survived');
  assert.ok(!/<link/i.test(html), 'link survived');
  assert.ok(!/onclick/i.test(html), 'event handler survived');
  assert.equal(window.stolen, undefined, 'book script must never execute');
});
await t('keeps the prose and the footnote marker', () => {
  assert.match(parse.chapterHtml(epub.chapters[0]), /harbour kept its own accounts/);
  assert.match(parse.chapterHtml(epub.chapters[0]), /<sup>1<\/sup>/);
});
await t('keeps images as blobs and records them in reading order', () => {
  assert.equal(epub.images.length, 1);
  assert.equal(epub.images[0].chapterIndex, 0);
  // Not measured at import: decoding every illustration in every book to fill
  // in two numbers costs minutes on a real shelf. The reel measures on first
  // open and writes the result back.
  assert.equal(epub.images[0].width, 0);
  assert.ok(epub.images[0].blob, 'image blob missing');
  // Not a blob: URL. Those stop resolving once the app is closed, so the
  // chapter keeps a reference the reader resolves at render time instead.
  // The href is the path resolved against the OPF, which is also the key the
  // image is stored under, so the reader can look it up later.
  assert.equal(epub.images[0].href, 'OEBPS/images/plate.png');
  assert.match(parse.chapterHtml(epub.chapters[0]), /data-img="OEBPS\/images\/plate\.png"/);
  assert.ok(!/blob:/.test(parse.chapterHtml(epub.chapters[0])), 'a blob URL was baked into the markup');
  assert.ok(!/data-src/.test(parse.chapterHtml(epub.chapters[0])), 'placeholder attribute left behind');
});
await t('extracts the cover as a blob', () => assert.ok(epub.coverBlob));
await t('counts words across chapters', () => {
  assert.ok(epub.words > 8 && epub.words < 40, `got ${epub.words}`);
});

console.log('CBZ');
const cbz = await parse.parse(asFile('./tests/fixtures/comic.cbz', 'comic.cbz'));
await t('sorts pages naturally, so page 2 precedes page 10', () => {
  assert.deepEqual(cbz.images.map(i=>i.href), ['page1.png','page2.png','page10.png']);
});
await t('builds a single scrollable chapter of figures', () => {
  assert.equal(cbz.chapters.length, 1);
  assert.equal((parse.chapterHtml(cbz.chapters[0]).match(/<img/g)||[]).length, 3);
});

console.log('plain text');
const txt = await parse.parse(new File([
  'CHAPTER ONE\n\nThe road bent north.\n\nIt kept bending.\n\nCHAPTER TWO\n\nThen it stopped.'
], 'road.txt'));
await t('splits plain text on heading-like lines', () => {
  assert.deepEqual(txt.chapters.map(c=>c.title), ['CHAPTER ONE','CHAPTER TWO']);
  assert.equal((parse.chapterHtml(txt.chapters[0]).match(/<p>/g)||[]).length, 2);
});
await t('escapes markup found in plain text', async () => {
  const evil = await parse.parse(new File(['<img src=x onerror=alert(1)>'], 'x.txt'));
  assert.ok(!/<img/.test(parse.chapterHtml(evil.chapters[0])), 'raw HTML leaked out of a .txt file');
});

console.log('Markdown');
const md = await parse.parse(new File(['# Opening\n\nSome **bold** text.\n\n## Next\n\nMore.'], 'notes.md'));
await t('reads Markdown headings and inline emphasis', () => {
  assert.deepEqual(md.chapters.map(c=>c.title), ['Opening','Next']);
  assert.match(parse.chapterHtml(md.chapters[0]), /<strong>bold<\/strong>/);
});

console.log('word counting');
await t('counts CJK by character over a per-language factor', () => {
  const zh = parse.countWords('冬光'.repeat(105), 'zh');   // 210 chars / 2.1
  assert.equal(zh, 100);
  assert.equal(parse.countWords('one two three', 'en'), 3);
});

console.log('refusals');
await t('an unsupported format names a reason rather than failing silently', async () => {
  // PDF used to be the example here. It is read properly now, so this uses a
  // format that genuinely is not supported yet.
  await assert.rejects(
    parse.parse(new File([new Uint8Array([1, 2, 3])], 'book.mobi')),
    (e) => /PalmDOC|No parser/.test(e.message));
});

await t('PDF is no longer in the refusal list', () => {
  assert.equal(parse.UNSUPPORTED_REASON.PDF, undefined);
  assert.ok(parse.SUPPORTED.has('PDF'));
});
await t('rejects a zip that is not an EPUB with a useful message', async () => {
  const JSZipMod = (await import('jszip')).default;
  const junk = await new JSZipMod().file('a.txt','x').generateAsync({type:'nodebuffer'});
  await assert.rejects(parse.parse(new File([junk],'fake.epub')), /container\.xml/);
});

console.log('import cost');

await t('importing does not parse the chapters', async () => {
  // Building a DOM costs about 1.6ms a chapter and produces nothing an import
  // needs: the word count and the picture list can both be had from the
  // markup as text for a fifth of that. On a shelf of long books that is the
  // difference between minutes and not.
  const parsed = await parse.parse(new File(
    [fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))], 'salt.epub'));

  const chapter = parsed.chapters[0];
  assert.ok(chapter.source, 'the chapter source was not kept');
  assert.equal(chapter.html, undefined, 'the chapter was parsed at import after all');
  // Where it sits in the archive, so its pictures can be found again later.
  assert.ok(chapter.base);
});

await t('the sanitiser still runs, just later', async () => {
  // The step moved; it did not go. Nothing reaches the page without it.
  const parsed = await parse.parse(new File(
    [fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))], 'salt.epub'));
  const html = parse.chapterHtml(parsed.chapters[0]);

  assert.ok(!/<script/i.test(html));
  assert.ok(!/<style/i.test(html));
  assert.ok(!/ class=/.test(html));
  assert.ok(!/ onclick=/i.test(html));
  assert.match(html, /<p>/);
});

await t('a word count is not a count of the stylesheet', async () => {
  // Stripping tags alone leaves the stylesheet's own text behind, and it then
  // counts as prose.
  const counted = parse.countWords(
    parse.plainTextOf?.('<style>p{color:red}</style><p>one two three</p>')
      ?? 'one two three', 'en');
  assert.equal(counted, 3);
});

await t('searching a book strips text rather than sanitising it', async () => {
  // Search asked for the sanitised HTML and threw the markup away again,
  // which parsed every chapter on every keystroke -- about a second on a long
  // book. Stripping the source is forty times cheaper and the same answer.
  const screens = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/screens.js', import.meta.url), 'utf8');
  assert.match(screens, /chapterPlainText\(chapter\)/);
  assert.ok(!/chapterHtml\(chapter\)/.test(screens), 'search still sanitises every chapter');

  // And it finds the same words either way.
  const parsed = await parse.parse(new File(
    [fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))], 'salt.epub'));
  const stripped = parse.chapterPlainText(parsed.chapters[0]);
  assert.match(stripped, /harbour kept its own accounts/);
  assert.ok(!/</.test(stripped), 'markup survived the strip');
});

await t('a chapter that will not parse as XML still opens', async () => {
  // A book that cannot be read is worse than one that renders a little
  // loosely, and scraped EPUBs are frequently not well-formed.
  const html = parse.chapterHtml({
    source: '<html><body><p>unclosed <b>bold</p></body></html>',
    base: 'x.xhtml',
  });
  assert.match(html, /unclosed/);
});

await t('images can be handed off instead of accumulated', async () => {
  // A heavily illustrated book is well over a hundred megabytes of blobs.
  // Holding all of them until the parse finished is what killed the app
  // partway through a shelf.
  const sunk = [];
  const streamed = await parse.parse(
    new File([fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))], 'salt.epub'),
    null, { onImage: (record) => { sunk.push(record); } });

  assert.ok(sunk.length > 0, 'nothing reached the sink');
  assert.equal(streamed.images.length, 0, 'images were kept as well as handed off');
  // The count still has to be reported, since the book record stores it.
  assert.equal(streamed.imageCount, sunk.length);
  for (const record of sunk) assert.ok(record.blob, 'a record arrived without its blob');
});

await t('without a sink the images come back as before', async () => {
  const whole = await parse.parse(
    new File([fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))], 'salt.epub'));
  assert.ok(whole.images.length > 0);
  assert.equal(whole.imageCount, whole.images.length);
});

await t('a comic keeps its cover even when the images are handed off', async () => {
  // The cover was taken from images[0], which is empty with a sink.
  const cbz = await parse.parse(
    new File([fs.readFileSync(new URL('./fixtures/comic.cbz', import.meta.url))], 'c.cbz'),
    null, { onImage: () => {} });
  assert.ok(cbz.coverBlob, 'the comic lost its cover');
  assert.equal(cbz.images.length, 0);
  assert.ok(cbz.imageCount > 0);
});

t('a chapter is read once, not four times', () => {
  // Build a sanitised DOM, serialise, re-parse to fix images, serialise
  // again, parse a third time for the word count: 5.9ms per chapter against
  // 0.19ms for one walk. Sixty per cent of the import was re-reading work
  // already done.
  const src = read('app/src/main/assets/www/js/parse.js');
  assert.match(src, /function readChapter/);
  assert.ok(!/function sanitise\(/.test(src), 'the separate sanitise pass is back');
  assert.ok(!/function textOf\(/.test(src), 'the text is being extracted by a third parse again');
  // No intermediate DOM: markup is emitted as strings.
  const fn = src.slice(src.indexOf('function readChapter'), src.indexOf('const CJK_FACTOR'));
  assert.ok(!/createElement/.test(fn), 'readChapter builds a DOM again');
});

t('progress is throttled and yields the main thread', () => {
  // A bar redrawn once per chapter is hundreds of layouts a book, and it
  // competes with the work it describes. The yield is what lets it paint at
  // all, and keeps Android from deciding the app has stopped responding.
  const src = read('app/src/main/assets/www/js/parse.js');
  const tick = src.slice(src.indexOf('async function tick'));
  assert.match(tick.slice(0, 400), /now - lastTick < 100/);
  assert.match(tick.slice(0, 400), /setTimeout/);
});

console.log(`\n${pass} assertions passed`);
