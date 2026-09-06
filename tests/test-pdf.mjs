import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);
const pdf = await import(new URL('../app/src/main/assets/www/js/pdf.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

console.log('text assembly');

t('positioned fragments are joined back into lines', () => {
  // pdf.js hands back fragments, not lines: only hasEOL says where one ends.
  const items = [
    { str: 'The quick ' }, { str: 'brown fox', hasEOL: true },
    { str: 'jumps over', hasEOL: true },
    { str: 'the lazy dog' },
  ];
  assert.deepEqual(pdf.itemsToLines(items),
    ['The quick brown fox', 'jumps over', 'the lazy dog']);
});

t('lines become paragraphs, not one paragraph each', () => {
  // A PDF records where lines were drawn, never where a paragraph began, so
  // a short line is taken as the end of one. It is a guess, and it is far
  // better than a paragraph per line.
  const lines = [
    'This is a long line of ordinary prose that runs',
    'across most of the measure and keeps going for a',
    'while before it stops.',
    'A new one starts here and also runs the full width',
    'of the page before ending.',
  ];
  const paragraphs = pdf.linesToParagraphs(lines);
  assert.equal(paragraphs.length, 2);
  assert.match(paragraphs[0], /^This is a long line/);
  assert.match(paragraphs[1], /^A new one starts here/);
});

t('a blank line always ends a paragraph', () => {
  assert.equal(pdf.linesToParagraphs(['one line here', '', 'another line here']).length, 2);
});

t('text is escaped on the way into markup', () => {
  assert.equal(pdf.paragraphsToHtml(['a <b> & c']), '<p>a &lt;b&gt; &amp; c</p>');
});

console.log('chapters');

t('an outline becomes the chapters', () => {
  const ranges = pdf.chapterRanges(
    [{ title: 'One', page: 3 }, { title: 'Two', page: 10 }], 20);
  // Pages before the first entry are not silently dropped.
  assert.deepEqual(ranges.map((r) => r.title), ['Front matter', 'One', 'Two']);
  assert.deepEqual(ranges.map((r) => [r.from, r.to]), [[1, 2], [3, 9], [10, 20]]);
  assert.ok(ranges[1].fromOutline);
});

t('without an outline the pages are cut into even runs', () => {
  // So the index has something to list and the reader something to jump to.
  const ranges = pdf.chapterRanges([], 45);
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges.map((r) => [r.from, r.to]), [[1, 20], [21, 40], [41, 45]]);
  assert.ok(!ranges[0].fromOutline);
  assert.match(ranges[0].title, /Pages 1/);
});

console.log('a real file');

const file = new File([fs.readFileSync(new URL('./fixtures/sample.pdf', import.meta.url))], 'sample.pdf');
const parsed = await parse.parse(file);

await t('a PDF parses to readable chapters', () => {
  assert.equal(parsed.format, 'PDF');
  assert.ok(parsed.chapters.length >= 1);
  assert.ok(parsed.words > 40, `only ${parsed.words} words extracted`);
});

await t('paragraphs survive the round trip', () => {
  const html = parsed.chapters[0].html;
  assert.ok((html.match(/<p>/g) || []).length >= 2, 'everything landed in one paragraph');
  assert.match(html, /text extraction works/);
  // Lines were rejoined, not left as one paragraph per line.
  assert.match(html, /minimal document is constructed by hand/);
});

await t('it says where the chapter divisions came from', () => {
  assert.match(parsed.tocSource, /no outline/);
});

await t('a PDF with no readable text is refused, not imported empty', async () => {
  // A scan needs OCR, and an empty book on the shelf is worse than a refusal.
  const empty = new File([Buffer.from('%PDF-1.4\n%%EOF\n')], 'scan.pdf');
  await assert.rejects(parse.parse(empty));
});

t('CJK character maps and the base fonts are bundled', () => {
  // Most Korean and Japanese PDFs reference their fonts rather than embedding
  // them; without the cMaps their text comes out as mojibake or not at all.
  const src = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/pdf.js', import.meta.url), 'utf8');
  assert.match(src, /cMapUrl/);
  assert.match(src, /cMapPacked: true/);
  assert.match(src, /standardFontDataUrl/);
  const cmaps = new URL('../app/src/main/assets/www/vendor/cmaps/', import.meta.url);
  assert.ok(fs.existsSync(new URL('UniKS-UCS2-H.bcmap', cmaps)), 'no Korean cMap');
  assert.ok(fs.existsSync(new URL('UniJIS-UCS2-H.bcmap', cmaps)), 'no Japanese cMap');
});

console.log('loading');

t('pdf.js is fetched only when a PDF is opened', () => {
  // 1.8MB of vendored library that a library of EPUBs should never pay for.
  const src = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/parse.js', import.meta.url), 'utf8');
  assert.match(src, /await import\('\.\/pdf\.js'\)/);
  assert.ok(!/^import .*pdf\.js/m.test(src), 'pdf.js is imported eagerly');
});

t('Promise.withResolvers is polyfilled', () => {
  // pdf.js 4 calls it, and it needs Chrome 119. WebView updates through Play,
  // but minSdk here is 26 and a device that never updated would fail on PDFs
  // alone.
  const src = fs.readFileSync(
    new URL('../app/src/main/assets/www/js/pdf.js', import.meta.url), 'utf8');
  assert.match(src, /Promise\.withResolvers = function/);
});

console.log(`\n${pass} assertions passed`);
