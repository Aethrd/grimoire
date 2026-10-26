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


await t('a chapter set without paragraphs is copied whole, not just its heading', () => {
  // Plain blocks, and lines with breaks between them: how a great many web
  // novels are set. Only the heading used to come out.
  reader.state.chapters = [{ index: 0, title: 'D', html:
    '<h1>Chapter One</h1><div>First line of the story.</div><div>Second line.</div>'
    + 'Loose text straight in the chapter.<br><br>After a blank line.<br>And the next line.' }];
  const copied = reader.chapterText(0);
  assert.equal(copied, 'Chapter One\n\nFirst line of the story.\n\nSecond line.\n\n'
    + 'Loose text straight in the chapter.\n\nAfter a blank line.\nAnd the next line.');
  // A quotation holding paragraphs is copied once, not twice.
  reader.state.chapters = [{ index: 0, title: 'Q', html:
    '<blockquote><p>One.</p><p>Two.</p></blockquote><p>Three.</p>' }];
  assert.equal(reader.chapterText(0), 'One.\n\nTwo.\n\nThree.');
});

await t('half a chapter: split between paragraphs, near the middle, nothing lost', () => {
  const para = (n) => `<p>${`Word${n} `.repeat(40).trim()}.</p>`;
  reader.state.chapters = [{ index: 0, title: 'H', html: Array.from({ length: 10 }, (_, i) => para(i)).join('') }];
  const whole = reader.chapterText(0);
  const [first, second] = reader.chapterHalves(0);
  assert.equal(`${first}\n\n${second}`, whole);
  assert.equal(first.split('\n\n').length, 5);
  // One long paragraph is split at a sentence.
  reader.state.chapters = [{ index: 0, title: 'L', html: `<p>${'One sentence here. '.repeat(30)}</p>` }];
  const [a, b] = reader.chapterHalves(0);
  assert.ok(a.endsWith('.') && b.startsWith('One'), `${a.slice(-20)} | ${b.slice(0, 20)}`);
  assert.ok(Math.abs(a.length - b.length) < 40);
});

await t('the progress bar points at the whole book, by words', () => {
  reader.state.chapters = [
    { index: 0, title: 'A', words: 1000, html: '<p>a</p>' },
    { index: 1, title: 'B', words: 3000, html: '<p>b</p>' },
    { index: 2, title: 'C', words: 1000, html: '<p>c</p>' },
  ];
  reader.state.totalPages = 50;
  reader.state.pagesBefore = [0, 10, 40];
  assert.equal(reader.bookPlace(0).chapterIndex, 0);
  assert.equal(reader.bookPlace(0).page, 1);
  // 1000 + 1500 of 5000 words: halfway through the middle chapter.
  const middle = reader.bookPlace(0.5);
  assert.equal(middle.chapterIndex, 1);
  assert.ok(Math.abs(middle.within - 0.5) < 1e-9, String(middle.within));
  assert.equal(middle.page, 25);
  const end = reader.bookPlace(1);
  assert.equal(end.chapterIndex, 2);
  assert.equal(end.within, 1);
  assert.equal(end.page, 50);
  // A comic, with no words, is measured in pictures.
  reader.state.chapters = [
    { index: 0, title: 'A', html: '<img data-img="1"><img data-img="2"><img data-img="3">' },
    { index: 1, title: 'B', html: '<img data-img="4">' },
  ];
  assert.equal(reader.bookPlace(0.9).chapterIndex, 1);
  assert.equal(reader.bookPlace(0.5).chapterIndex, 0);
});

await t('the copy button: split, with a choice of page, half or chapter', () => {
  const fs2 = fs;
  const www = (f) => fs2.readFileSync(new URL(`../app/src/main/assets/www/${f}`, import.meta.url), 'utf8');
  const html = www('index.html');
  const app = www('js/app.js');
  assert.match(html, /<div class="copy-split">\s*<button class="btn primary" id="copy-chapter">Copy chapter<\/button>\s*<button class="btn primary copy-amount" id="copy-amount"/);
  for (const amount of ['page', 'half', 'chapter']) assert.ok(html.includes(`data-amount="${amount}"`));
  // The icon: three lines, a hollow circle on each.
  const icon = html.slice(html.indexOf('id="copy-amount"'), html.indexOf('</button>', html.indexOf('id="copy-amount"')));
  assert.match(icon, /<path d="M3 6h18M3 12h18M3 18h18"\/>/);
  assert.equal((icon.match(/<circle class="knob"/g) || []).length, 3);
  // ...whose circles move along their lines when the place in the book does.
  assert.match(app, /if \(place !== copyIconAt\) \{\s*if \(copyIconAt\) moveCopyIconKnobs\(\);/);
  // Remembered, and each choice copies what it says.
  assert.match(app, /await store\.saveSettings\(\{ copyAmount \}\)/);
  assert.match(app, /reader\.copyPage\(\)[\s\S]*reader\.copyHalf\(\)[\s\S]*reader\.copyChapter\(\)/);
  // The bar is a tall target and goes anywhere in the book.
  assert.match(app, /await reader\.goToBookFraction\(fraction\)/);
  assert.match(www('css/app.css'), /\.progress-hit \{[^}]*height: 32px/);
});



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



console.log('choosing how colour becomes grey');

const page = (width, height, draw) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = draw(x, y);
      const at = (y * width + x) * 4;
      pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b; pixels[at + 3] = 255;
    }
  }
  return { pixels, width, height };
};

await t('a hue pair luminance flattens is caught by another channel', async () => {
  /* Red at 220,70,70 and green at 30,160,90 are very different colours and
   * nearly the same brightness. Under luminance the lettering and the panel
   * behind it become one grey, and nothing downstream recovers it. */
  const mix = await import(new URL('../app/src/main/assets/www/js/mix.js', import.meta.url).href);

  const trap = page(60, 60, (x) => (x % 8 < 3 ? [220, 70, 70] : [30, 160, 90]));
  const scored = (name) => {
    const found = mix.MIXES.find((m) => m.name === name);
    return mix.scoreGrey(mix.applyMix(trap.pixels, found.rgb), trap.width, trap.height);
  };

  assert.ok(scored('red') > scored('luminance') * 2,
    'the red channel did not do better than luminance on a red/green page');
  assert.notEqual(mix.chooseMix([trap]).name, 'luminance');
});

await t('a page with no colour is left alone', async () => {
  // Switching conversion on a mono scan would change nothing and risk making
  // it worse.
  const mix = await import(new URL('../app/src/main/assets/www/js/mix.js', import.meta.url).href);
  const scan = page(60, 60, (x) => { const v = x % 10 < 4 ? 30 : 230; return [v, v, v]; });

  assert.equal(mix.hasColour(scan.pixels), false);
  assert.equal(mix.chooseMix([scan]).name, 'luminance');
});

await t('luminance wins ties, and near-ties', async () => {
  /* A mix that wins by a whisker is noise, and switching on noise means two
   * volumes of one book rendering differently for no visible reason. */
  const mix = await import(new URL('../app/src/main/assets/www/js/mix.js', import.meta.url).href);
  const source = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/mix.js', import.meta.url), 'utf8');
  assert.match(source, /totals\[best\] < totals\[0\] \* 1\.1/);
  // Luminance is first in the list, so an exact tie leaves it in place.
  assert.equal(mix.MIXES[0].name, 'luminance');
});

await t('the measurement is per book, not per page', async () => {
  /* A page is a canvas pass and a slow screen cannot afford one per turn --
   * and a book is drawn by one person in one palette. */
  const library = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/library.js', import.meta.url), 'utf8');
  assert.match(library, /export async function greyMixFor/);
  assert.match(library, /if \(book\.greyMix\) return book\.greyMix/);
  assert.match(library, /stored\.greyMix = chosen\.name/);

  // Sampled through the book, since the first pages are a cover and a title.
  const mixSource = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/mix.js', import.meta.url), 'utf8');
  assert.match(mixSource, /const step = Math\.max\(1, Math\.floor\(blobs\.length \/ take\)\)/);
});

console.log(`\n${pass} assertions passed`);
