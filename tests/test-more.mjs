import assert from 'node:assert/strict';
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

console.log(`\n${pass} assertions passed`);
