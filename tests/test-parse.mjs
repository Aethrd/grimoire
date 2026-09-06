import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';
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
  const html = epub.chapters[0].html;
  assert.ok(!/<script/i.test(html), 'script survived');
  assert.ok(!/<style/i.test(html), 'style survived');
  assert.ok(!/<link/i.test(html), 'link survived');
  assert.ok(!/onclick/i.test(html), 'event handler survived');
  assert.equal(window.stolen, undefined, 'book script must never execute');
});
await t('keeps the prose and the footnote marker', () => {
  assert.match(epub.chapters[0].html, /harbour kept its own accounts/);
  assert.match(epub.chapters[0].html, /<sup>1<\/sup>/);
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
  assert.match(epub.chapters[0].html, /data-img="OEBPS\/images\/plate\.png"/);
  assert.ok(!/blob:/.test(epub.chapters[0].html), 'a blob URL was baked into the markup');
  assert.ok(!/data-src/.test(epub.chapters[0].html), 'placeholder attribute left behind');
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
  assert.equal((cbz.chapters[0].html.match(/<img/g)||[]).length, 3);
});

console.log('plain text');
const txt = await parse.parse(new File([
  'CHAPTER ONE\n\nThe road bent north.\n\nIt kept bending.\n\nCHAPTER TWO\n\nThen it stopped.'
], 'road.txt'));
await t('splits plain text on heading-like lines', () => {
  assert.deepEqual(txt.chapters.map(c=>c.title), ['CHAPTER ONE','CHAPTER TWO']);
  assert.equal((txt.chapters[0].html.match(/<p>/g)||[]).length, 2);
});
await t('escapes markup found in plain text', async () => {
  const evil = await parse.parse(new File(['<img src=x onerror=alert(1)>'], 'x.txt'));
  assert.ok(!/<img/.test(evil.chapters[0].html), 'raw HTML leaked out of a .txt file');
});

console.log('Markdown');
const md = await parse.parse(new File(['# Opening\n\nSome **bold** text.\n\n## Next\n\nMore.'], 'notes.md'));
await t('reads Markdown headings and inline emphasis', () => {
  assert.deepEqual(md.chapters.map(c=>c.title), ['Opening','Next']);
  assert.match(md.chapters[0].html, /<strong>bold<\/strong>/);
});

console.log('word counting');
await t('counts CJK by character over a per-language factor', () => {
  const zh = parse.countWords('冬光'.repeat(105), 'zh');   // 210 chars / 2.1
  assert.equal(zh, 100);
  assert.equal(parse.countWords('one two three', 'en'), 3);
});

console.log('refusals');
await t('names a reason rather than failing silently', async () => {
  await assert.rejects(
    parse.parse(new File([new Uint8Array([1,2,3])], 'book.pdf')),
    (e) => /pdf\.js|PdfRenderer/.test(e.message));
});
await t('rejects a zip that is not an EPUB with a useful message', async () => {
  const JSZipMod = (await import('jszip')).default;
  const junk = await new JSZipMod().file('a.txt','x').generateAsync({type:'nodebuffer'});
  await assert.rejects(parse.parse(new File([junk],'fake.epub')), /container\.xml/);
});

console.log(`\n${pass} assertions passed`);
