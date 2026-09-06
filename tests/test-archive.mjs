import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { boot } from './harness.mjs';
const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:stub/1';
globalThis.Image = class { set src(v) { this.naturalWidth = 10; this.naturalHeight = 10;
  setTimeout(() => this.onload && this.onload(), 0); } };

const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function zipOf(entries) {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body);
  return new File([await zip.generateAsync({ type: 'nodebuffer' })], 'library.zip');
}

const BOOK = 'CHAPTER ONE\n\nSome text.\n';

console.log('folder detection');

await t('folders inside the archive become folders here', async () => {
  const file = await zipOf({
    'Fiction/Le Guin/left-hand.txt': BOOK,
    'Fiction/Le Guin/dispossessed.txt': BOOK,
    'Reference/style-guide.txt': BOOK,
  });
  const { books } = await parse.expandArchive(file);
  const byName = Object.fromEntries(books.map((b) => [b.name, b.folder]));
  assert.equal(byName['left-hand.txt'], 'Fiction/Le Guin');
  assert.equal(byName['style-guide.txt'], 'Reference');
});

await t('a book at the archive root is unfiled, not put in a folder', async () => {
  const file = await zipOf({ 'loose.txt': BOOK, 'Folder/filed.txt': BOOK });
  const { books } = await parse.expandArchive(file);
  assert.equal(books.find((b) => b.name === 'loose.txt').folder, '');
  assert.equal(books.find((b) => b.name === 'filed.txt').folder, 'Folder');
});

console.log('wrapper directories');

await t('a single wrapper directory is stripped', () => {
  // Zipping a folder puts everything under one directory of that name.
  // Keeping it would file the whole library under "My Books".
  assert.deepEqual(
    parse.stripCommonRoot(['My Books/Fiction/a.epub', 'My Books/Reference/b.epub']),
    ['Fiction/a.epub', 'Reference/b.epub']);
});

await t('nested wrappers are stripped all the way down', () => {
  assert.deepEqual(
    parse.stripCommonRoot(['a/b/Fiction/x.epub', 'a/b/Poetry/y.epub']),
    ['Fiction/x.epub', 'Poetry/y.epub']);
});

await t('a real shared folder is not mistaken for a wrapper', () => {
  // Both files sit under Fiction. Stripping it would leave every book unfiled
  // and throw away the only folder the archive carried, so it stays.
  assert.deepEqual(
    parse.stripCommonRoot(['Fiction/a.epub', 'Fiction/b.epub']),
    ['Fiction/a.epub', 'Fiction/b.epub']);
});

await t('a wrapper is still stripped when real folders survive underneath', () => {
  assert.deepEqual(
    parse.stripCommonRoot(['Grimoire/Fiction/a.epub', 'Grimoire/Fiction/b.epub', 'Grimoire/Poetry/c.epub']),
    ['Fiction/a.epub', 'Fiction/b.epub', 'Poetry/c.epub']);
});

await t('a lone file keeps its folder', () => {
  // With one path there is no evidence the directory is a wrapper.
  assert.deepEqual(parse.stripCommonRoot(['Fiction/only.epub']), ['Fiction/only.epub']);
});

await t('nothing is stripped when the roots differ', () => {
  assert.deepEqual(
    parse.stripCommonRoot(['Fiction/a.epub', 'Poetry/b.epub']),
    ['Fiction/a.epub', 'Poetry/b.epub']);
});

console.log('comic versus container');

await t('a zip of images is a comic, not a container', async () => {
  const file = await zipOf({ 'page1.png': PNG, 'page2.png': PNG });
  const result = await parse.expandArchive(file);
  assert.equal(result.comic, true);
  assert.equal(result.books.length, 0);
});

await t('a zip holding books is a container even with images beside them', async () => {
  // Cover art next to the books must not make the whole archive read as a comic.
  const file = await zipOf({ 'a.epub': 'x', 'cover.png': PNG });
  const result = await parse.expandArchive(file);
  assert.equal(result.comic, false);
});

console.log('junk and refusals');

await t('macOS resource forks and dotfiles are skipped', async () => {
  const file = await zipOf({
    'Books/real.txt': BOOK,
    '__MACOSX/Books/._real.txt': 'junk',
    'Books/._real.txt': 'junk',
    '.DS_Store': 'junk',
  });
  const { books } = await parse.expandArchive(file);
  assert.equal(books.length, 1, 'resource forks imported as books');
  assert.equal(books[0].name, 'real.txt');
});

await t('an archive of archives is refused with advice, not silence', async () => {
  const file = await zipOf({ 'inner.zip': 'x', 'other.zip': 'y' });
  await assert.rejects(parse.expandArchive(file), /Extract it once/);
});

await t('an archive with nothing readable says so', async () => {
  const file = await zipOf({ 'notes.docx': 'x' });
  await assert.rejects(parse.expandArchive(file), /No books found/);
});

await t('parse() refuses a container rather than guessing', async () => {
  const file = await zipOf({ 'Books/a.txt': BOOK });
  await assert.rejects(parse.parse(file), /expandArchive/);
});

console.log('extracted content');

await t('books are extracted one at a time, not all at once', async () => {
  // Unpacking every book up front holds the whole archive in memory --
  // hundreds of megabytes for an ordinary library zip, which is enough to
  // have the WebView killed mid-import. Entries come back as a read() the
  // importer calls when that book's turn arrives.
  const file = await zipOf({ 'A/one.txt': BOOK, 'B/two.txt': BOOK });
  const { books } = await parse.expandArchive(file);
  for (const book of books) {
    assert.equal(book.blob, undefined, 'the entry was extracted eagerly');
    assert.equal(typeof book.read, 'function');
  }
});

await t('an extracted book still parses', async () => {
  const file = await zipOf({ 'Fiction/road.txt': 'CHAPTER ONE\n\nThe road bent north.\n' });
  const { books } = await parse.expandArchive(file);
  const parsed = await parse.parse(new File([await books[0].read()], books[0].name));
  assert.equal(parsed.chapters[0].title, 'CHAPTER ONE');
  assert.match(parsed.chapters[0].html, /road bent north/);
});

await t('several folders at once each keep their own path', async () => {
  const file = await zipOf({
    'Fantasy/a.txt': BOOK,
    'Fantasy/Sub/b.txt': BOOK,
    'Romance/c.txt': BOOK,
    'loose.txt': BOOK,
  });
  const { books } = await parse.expandArchive(file);
  const byName = Object.fromEntries(books.map((b) => [b.name, b.folder]));
  assert.equal(byName['a.txt'], 'Fantasy');
  assert.equal(byName['b.txt'], 'Fantasy/Sub');
  assert.equal(byName['c.txt'], 'Romance');
  assert.equal(byName['loose.txt'], '');
});

console.log(`\n${pass} assertions passed`);
