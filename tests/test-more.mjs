import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { boot } from './harness.mjs';
const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:stub/1';
globalThis.Image = class { set src(v){ this.naturalWidth=10; this.naturalHeight=10;
  setTimeout(()=>this.onload&&this.onload(),0);} };

const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);
let pass = 0;
const t = async (n, f) => { await f(); console.log('  ok  ' + n); pass++; };

console.log('EPUB 2 fallback');
// No nav document, only an NCX — the EPUB 2 shape, still very common.
const z = new JSZip();
z.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
z.file('content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old Book</dc:title></metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="one.html" media-type="application/xhtml+xml"/></manifest>
<spine toc="ncx"><itemref idref="c1"/></spine></package>`);
z.file('toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
<navPoint><navLabel><text>An Older Chapter</text></navLabel><content src="one.html"/></navPoint>
</navMap></ncx>`);
z.file('one.html', `<html><body><h1>Ignored</h1><p>Body text here.</p></body></html>`);
const epub2 = await parse.parse(new File([await z.generateAsync({type:'nodebuffer'})], 'old.epub'));

await t('falls back to the NCX when there is no nav document', () => {
  assert.equal(epub2.chapters[0].title, 'An Older Chapter');
  assert.ok(epub2.chapters[0].fromToc);
});

console.log('no TOC at all');
const z2 = new JSZip();
z2.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
z2.file('c.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Bare</dc:title></metadata>
<manifest><item id="c1" href="a.html" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine></package>`);
z2.file('a.html', `<html><body><h2>Derived From Heading</h2><p>Text.</p></body></html>`);
const bare = await parse.parse(new File([await z2.generateAsync({type:'nodebuffer'})],'bare.epub'));

await t('derives titles from headings and says so', () => {
  assert.equal(bare.chapters[0].title, 'Derived From Heading');
  assert.equal(bare.chapters[0].fromToc, false);
  assert.match(bare.tocSource, /no table of contents/);
});

console.log('copy chapter');
// chapterText is the clipboard path: footnotes flattened, images dropped,
// paragraph breaks kept, whitespace normalised.
const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);
reader.state.chapters = [{ index: 0, title: 'X', html:
  '<h1>Salt and Tide</h1><p>The   harbour\n kept   accounts<sup>1</sup>.</p>' +
  '<img src="blob:stub/1"><p>Second paragraph.</p>' }];
reader.state.chapterIndex = 0;
const text = reader.chapterText(0);

await t('flattens footnotes to inline brackets', () => assert.match(text, /accounts \[1\]\./));
await t('drops images', () => assert.ok(!/blob:/.test(text) && !/<img/.test(text)));
await t('keeps paragraph breaks', () => assert.equal(text.split('\n\n').length, 3));
await t('normalises runs of whitespace', () => assert.match(text, /The harbour kept accounts/));
await t('keeps the heading as its own block', () => assert.ok(text.startsWith('Salt and Tide')));



console.log('finding a book');

const shelf = [
  { title: 'Witch City', author: 'Kim Aera', series: 'Witch City', folder: 'Fic' },
  { title: '마녀의 도시', author: 'Kim Aera', series: 'Witch City', folder: 'Raw' },
  { title: 'Solo Leveling Vol. 3', author: 'Chugong', series: 'Solo Leveling', folder: 'Manhwa' },
  { title: 'The Salt Almanac', author: 'Oyelaran', folder: 'Fic' },
  { title: 'A City of Salt', author: 'Someone', folder: 'Fic' },
];

await t('a book is found by anything that identifies it', async () => {
  /* Pinpointing a book is a different question from finding a sentence
   * inside one. It used to look only at the title and the author, so a
   * library organised into folders could not be searched by folder. */
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const titles = (query) => library.findBooks(shelf, query).map((b) => b.title);

  assert.deepEqual(titles('manhwa'), ['Solo Leveling Vol. 3']);
  assert.ok(titles('witch').includes('마녀의 도시'), 'the series was not searched');
  assert.deepEqual(titles('chugong'), ['Solo Leveling Vol. 3']);
});

await t('the words can be typed in any order', async () => {
  // It required them in the order given, so "almanac salt" found nothing
  // while "salt almanac" worked.
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  assert.deepEqual(library.findBooks(shelf, 'almanac salt').map((b) => b.title),
    ['The Salt Almanac']);
  assert.deepEqual(library.findBooks(shelf, 'salt almanac').map((b) => b.title),
    ['The Salt Almanac']);
});

await t('every word has to match something', async () => {
  // Two words should narrow the answer, not widen it.
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  assert.equal(library.findBooks(shelf, 'witch chugong').length, 0);
  assert.equal(library.findBooks(shelf, 'salt nonsense').length, 0);
});

await t('the best match comes first', async () => {
  /* Returning them in shelf order buries the book whose title was typed
   * under one that happens to share an author. */
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const found = library.findBooks(shelf, 'solo leveling');
  assert.equal(found[0].title, 'Solo Leveling Vol. 3');

  // A title match outranks a folder match on the same word.
  const salt = library.findBooks([
    { title: 'Nothing Relevant', author: 'X', folder: 'Salt' },
    { title: 'The Salt Almanac', author: 'Y', folder: 'Fic' },
  ], 'salt');
  assert.equal(salt[0].title, 'The Salt Almanac');
});

await t('a result says why it is in the list', async () => {
  // A book matched on its folder looks like a mistake beside one matched on
  // its title, unless it says so.
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  assert.equal(library.matchedOn(shelf[2], 'manhwa'), 'folder');
  assert.equal(library.matchedOn(shelf[0], 'witch'), 'series');
  assert.equal(library.matchedOn(shelf[3], 'almanac'), null, 'a title match needs no explaining');
});

await t('scoping to titles ignores the rest', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  assert.equal(library.findBooks(shelf, 'manhwa', ['title', 'shown']).length, 0);
  assert.equal(library.findBooks(shelf, 'kim', ['author']).length, 2);
});

console.log('saved web pages');

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const savedPage = (n) => [
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="----B"',
  '', '------B',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  'Content-Location: https://site.example/ch' + n,
  '',
  `<html><head><title>Chapter ${n} - Witch City | NovelSite</title></head><body>`,
  '<nav class=3D"site-nav"><a href=3D"/">Home</a></nav>',
  '<header class=3D"banner">NovelSite</header>',
  `<article><h1>Chapter ${n}: The Gate</h1>`,
  '<p>She had walked the wall a hundred times, and never once seen the gate =',
  'open from the inside.</p>',
  '<img src=3D"https://site.example/img/plate.png"/></article>',
  '<div class=3D"comments"><p>first!!</p></div>',
  '<div id=3D"recommendations"><a>Other novels</a></div>',
  '<footer>Copyright NovelSite</footer>',
  '</body></html>',
  '', '------B',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-Location: https://site.example/img/plate.png',
  '', png, '', '------B--',
].join('\r\n');

await t('a saved page reads as a chapter', async () => {
  const result = await parse.parse(new File([savedPage(12)], 'Chapter 12.mht'));
  assert.equal(result.format, 'MHT');
  assert.equal(result.chapters.length, 1);
  // The page's own heading, not the site's title bar.
  assert.equal(result.title, 'Chapter 12: The Gate');
  assert.ok(result.words > 10);
});

await t('the site is stripped off the story', async () => {
  // A saved page carries the header, the navigation, the comments and
  // whatever else was on screen, and none of it is the book.
  const result = await parse.parse(new File([savedPage(12)], 'Chapter 12.mht'));
  const html = parse.chapterHtml(result.chapters[0]);

  assert.match(html, /never once seen the gate/);
  assert.ok(!/Home<\/a>/.test(html), 'the navigation survived');
  assert.ok(!/first!!/.test(html), 'the comments survived');
  assert.ok(!/Other novels/.test(html), 'the recommendations survived');
  assert.ok(!/Copyright NovelSite/.test(html), 'the footer survived');
});

await t('pictures saved inside the page are kept', async () => {
  // They are referred to by the address they had on the web, and the file
  // carries them under that same address.
  const result = await parse.parse(new File([savedPage(12)], 'Chapter 12.mht'));
  assert.equal(result.imageCount, 1);
  assert.match(parse.chapterHtml(result.chapters[0]), /data-img=/);
  assert.ok(result.images[0].blob.size > 0);
});

await t('both spellings of the extension are read', async () => {
  // "mhtml?" is "mhtm" with an optional "l" — it never matches ".mht", which
  // is the commoner of the two.
  assert.equal(parse.formatOf('a.mht'), 'MHT');
  assert.equal(parse.formatOf('a.mhtml'), 'MHT');
  const source = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/build.js', import.meta.url), 'utf8');
  assert.ok(!/mhtml\?/.test(source), 'the pattern still cannot match .mht');
});

console.log(`\n${pass} assertions passed`);
