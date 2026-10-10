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

t('a readme does not turn a folder of pages into a library', () => {
  /* Plain text is a format this reader can open, so one readme.txt beside six
   * hundred images was enough to make the archive look like a container
   * holding a single book -- the readme. Building it produced exactly that. */
  const pages = Array.from({ length: 20 }, (_, i) => ({ name: `${i + 1}.png` }));

  assert.equal(parse.classifyArchive([...pages, { name: 'readme.txt' }]), 'comic');
  assert.equal(parse.classifyArchive([...pages, { name: 'Credits.txt' }, { name: 'info.nfo' }]), 'comic');

  // A real library is still a library.
  assert.equal(parse.classifyArchive([
    { name: 'Volume 1.epub' }, { name: 'Volume 2.epub' }, { name: 'readme.txt' },
  ]), 'books');

  // And a couple of illustrations among a pile of text is not a comic.
  assert.equal(parse.classifyArchive([
    { name: 'cover.png' }, { name: 'Volume 1.txt' }, { name: 'Volume 2.txt' },
    { name: 'Volume 3.txt' }, { name: 'Volume 4.txt' },
  ]), 'books');
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

/* ── a comic that came as a .zip ─────────────────────────────────────────
 *
 * Which is most of them. A comic arrives as a .zip at least as often as a
 * .cbz -- it is the same archive with a different extension on it -- and the
 * two have to behave the same.
 */

console.log('\na comic in a plain zip');

const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);

const pagesZip = async (name) => {
  const zip = new JSZip();
  for (let i = 1; i <= 3; i++) zip.file(`page-${String(i).padStart(3, '0')}.png`, PNG);
  return new File([await zip.generateAsync({ type: 'nodebuffer' })], name,
    { type: 'application/zip' });
};

await t('a zip of images imports, whatever it is called', async () => {
  /* It was recognised as a comic here and then queued under its own name, so
   * two loops later the parser was handed a .zip and refused it with
   * "Archives are expanded before parsing" -- which is the one thing that had
   * already happened. A volume of three hundred pages could only be imported
   * by renaming the file first. */
  const out = await library.importFiles([await pagesZip('webnovel 10.10.26.zip')], {});
  assert.equal(out.added, 1, out.failed.map((f) => f.reason).join(' | '));

  const book = (await store.all('books')).find((b) => b.title === 'webnovel 10.10.26');
  assert.ok(book, 'the book is not called what the file was called');
  assert.equal(book.format, 'CBZ');
  assert.equal((await store.byIndex('images', 'bookId', book.id)).length, 3);
});

await t('it comes out the same as the identical .cbz', async () => {
  const asCbz = await library.importFiles([await pagesZip('same pages.cbz')], {});
  assert.equal(asCbz.added, 1);

  const books = await store.all('books');
  const zipped = books.find((b) => b.title === 'webnovel 10.10.26');
  const cbz = books.find((b) => b.title === 'same pages');
  const pagesOf = async (b) => (await store.byIndex('images', 'bookId', b.id)).length;
  assert.equal(await pagesOf(zipped), await pagesOf(cbz));
  assert.equal(zipped.format, cbz.format);
});

await t('a zip with nothing readable in it says so rather than vanishing', async () => {
  // Neither a comic nor a container. It must fail out loud: a file that
  // disappears reads as the app having ignored the import entirely.
  const zip = new JSZip();
  zip.file('notes.docx', 'not really a docx');
  zip.file('cover.psd', 'nor this');
  const file = new File([await zip.generateAsync({ type: 'nodebuffer' })], 'odds and ends.zip');

  const out = await library.importFiles([file], {});
  assert.equal(out.added, 0);
  assert.equal(out.failed.length, 1, 'the file was dropped silently');
  assert.equal(out.failed[0].name, 'odds and ends.zip');
  assert.match(out.failed[0].reason, /No books found/);
});

console.log(`\n${pass} assertions passed`);
