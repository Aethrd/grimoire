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

/* ── chapters that arrive as files ───────────────────────────────────────
 *
 * A web novel arrives as a folder of saved pages, one per chapter, usually a
 * folder per novel zipped together. Every page was imported as a book of its
 * own: a zip of three novels put hundreds of one-chapter books on the shelf,
 * and doing all that work hundreds of times over was most of why it was slow.
 */

console.log('\nchapters that arrive as files');

const group = await import(new URL('../app/src/main/assets/www/js/group.js', import.meta.url).href);

const saved = (novel, n, heading = `Chapter ${n}`) => [
  'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="----B"', '', '------B',
  'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable',
  `Content-Location: https://site.example/${encodeURIComponent(novel)}/${n}`, '',
  `<html><head><title>${novel} - ${heading} | NovelSite</title></head><body>`,
  `<article><h1>${heading}</h1><p>The text of ${heading} of ${novel}, which runs on.</p></article>`,
  '</body></html>', '', '------B--',
].join('\r\n');

const zipFile = async (name, entries) => {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(entries)) zip.file(path, body);
  return new File([await zip.generateAsync({ type: 'nodebuffer' })], name);
};

const chaptersOf = async (book) =>
  (await store.byIndex('chapters', 'bookId', book.id)).sort((a, b) => a.index - b.index);
const bookCalled = async (title) => (await store.all('books')).find((b) => b.title === title);

await t('a zip of novels in folders is a book per novel, not a book per page', async () => {
  const entries = {};
  for (const novel of ['Witch City', 'Salt Road']) {
    for (let n = 1; n <= 6; n++) entries[`webnovel/${novel}/${novel} - Chapter ${n} - NovelSite.mht`] = saved(novel, n);
  }
  const before = (await store.all('books')).length;
  const out = await library.importFiles([await zipFile('webnovel 10.10.26.zip', entries)], {});

  assert.equal(out.added, 2, 'twelve pages became something other than two novels');
  assert.equal((await store.all('books')).length - before, 2);

  const witch = await bookCalled('Witch City');
  assert.ok(witch, 'the novel is not named for its folder');
  assert.equal((await chaptersOf(witch)).length, 6);
  assert.equal(witch.joinedFrom, 6);
  // Filed where the folder sat, not inside a shelf folder of its own name.
  assert.equal(witch.folder || '', '');
  assert.ok(out.joined.some((j) => j.name === 'Salt Road' && j.chapters === 6));
});

await t('chapters come out in reading order, not filename order', async () => {
  /* Sorting by name puts "Epilogue" between chapters and "Prologue" after
   * all of them, and "Chapter 10" before "Chapter 2". */
  const entries = {};
  for (const heading of ['Chapter 10', 'Epilogue', 'Chapter 2', 'Prologue', 'Side Story 1', 'Chapter 1']) {
    entries[`Ninth Bell/Ninth Bell - ${heading}.mht`] = saved('Ninth Bell', heading, heading);
  }
  await library.importFiles([await zipFile('ninth.zip', entries)], {});
  const titles = (await chaptersOf(await bookCalled('Ninth Bell'))).map((c) => c.title);
  assert.deepEqual(titles,
    ['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 10', 'Epilogue', 'Side Story 1']);
});

await t('two novels saved into one folder are still two novels', async () => {
  const entries = {};
  for (const novel of ['Glass Harbour', 'Red Orchard']) {
    for (let n = 1; n <= 3; n++) entries[`saved/${novel} - Chapter ${n}.mht`] = saved(novel, n);
  }
  const out = await library.importFiles([await zipFile('mixed pages.zip', entries)], {});
  assert.equal(out.added, 2);
  assert.ok(await bookCalled('Glass Harbour'));
  assert.ok(await bookCalled('Red Orchard'));
});

await t('Korean and Japanese chapter numbering is read too', async () => {
  const plan = group.planBooks(['마녀의 도시 3화.txt', '마녀의 도시 1화.txt', '마녀의 도시 프롤로그.txt',
    '마녀의 도시 외전 1화.txt', '마녀의 도시 2화.txt'].map((name) => ({ name })));
  assert.equal(plan.length, 1, 'the side story or the prologue was filed as another novel');
  assert.deepEqual(plan[0].items.map((i) => i.name), ['마녀의 도시 프롤로그.txt',
    '마녀의 도시 1화.txt', '마녀의 도시 2화.txt', '마녀의 도시 3화.txt', '마녀의 도시 외전 1화.txt']);
  assert.equal(group.chapterNumber('第12話 夜'), 12);
});

await t('separate novels that happen to be text files stay separate', async () => {
  /* The judgement is made cautiously for text: thirty differently named
   * novels in one folder are thirty books. */
  const plan = group.planBooks(['The Left Hand of Darkness.txt', 'The Dispossessed.txt',
    'Middlemarch.txt', 'Emma.txt'].map((name) => ({ name })));
  assert.ok(plan.every((step) => step.kind === 'book'));
});

await t('whole books in the same zip are left whole', async () => {
  const entries = {
    'Series/Volume 2.txt': 'CHAPTER ONE\n\nVolume two.\n',
    'Series/Volume 10.txt': 'CHAPTER ONE\n\nVolume ten.\n',
    'Series/Side Stories/Side Stories Ch 1.html': '<h1>One</h1><p>a</p>',
    'Series/Side Stories/Side Stories Ch 2.html': '<h1>Two</h1><p>b</p>',
  };
  const { books } = await parse.expandArchive(await zipFile('series.zip', entries));
  assert.deepEqual(books.map((b) => (b.group ? `[${b.name}: ${b.parts.length}]` : b.name)),
    ['[Side Stories: 2]', 'Volume 2.txt', 'Volume 10.txt'],
    'whole books were joined, or the order is not natural');
});

await t('chapters picked loose from one folder are one book', async () => {
  const files = Array.from({ length: 9 }, (_, i) =>
    new File([saved('Loose Leaf', i + 1)], `Loose Leaf - Chapter ${i + 1}.mht`));
  const before = (await store.all('books')).length;
  const out = await library.importFiles(files, {});
  assert.equal(out.added, 1);
  assert.equal((await store.all('books')).length - before, 1);
  assert.equal((await chaptersOf(await bookCalled('Loose Leaf'))).length, 9);
});

await t('importing the same zip twice does not make a second copy', async () => {
  const entries = {};
  for (let n = 1; n <= 3; n++) entries[`Twice/Twice - Chapter ${n}.mht`] = saved('Twice', n);
  const file = await zipFile('twice.zip', entries);
  await library.importFiles([file], {});
  const again = await library.importFiles([file], {});
  assert.equal(again.added, 0);
  assert.equal((await store.all('books')).filter((b) => b.title === 'Twice').length, 1);
});

/* ── comics that arrive as folders ───────────────────────────────────── */

console.log('\ncomics that arrive as folders');

await t('a whole manga series in one zip is no longer refused', async () => {
  /* Sixty chapters of forty pages is two thousand four hundred pictures --
   * an ordinary download, refused outright as "a disk image". */
  const zip = new JSZip();
  for (let c = 1; c <= 60; c++) {
    for (let p = 1; p <= 40; p++) zip.file(`Series/Ch ${c}/${String(p).padStart(3, '0')}.png`, PNG);
  }
  const file = new File([await zip.generateAsync({ type: 'nodebuffer' })], 'long series.zip');
  const out = await library.importFiles([file], {});
  assert.equal(out.added, 1, out.failed.map((f) => f.reason).join(' | '));

  const book = await bookCalled('long series');
  const chapters = await chaptersOf(book);
  assert.equal(chapters.length, 60, 'the chapters were run together into one');
  assert.equal(chapters[0].title, 'Ch 1');
  assert.equal(chapters[59].title, 'Ch 60');
  assert.equal(book.imageCount, 2400);
});

await t('each folder of pictures is a chapter, in natural order', async () => {
  const file = await zipFile('chaptered.zip', {
    'Comic/Ch 10/1.png': PNG, 'Comic/Ch 2/1.png': PNG, 'Comic/Ch 2/2.png': PNG, 'Comic/Ch 1/1.png': PNG,
  });
  await library.importFiles([file], {});
  const chapters = await chaptersOf(await bookCalled('chaptered'));
  assert.deepEqual(chapters.map((c) => c.title), ['Ch 1', 'Ch 2', 'Ch 10']);

  // And the pictures belong to the chapters they are in.
  const book = await bookCalled('chaptered');
  const images = (await store.byIndex('images', 'bookId', book.id)).sort((a, b) => a.order - b.order);
  assert.deepEqual(images.map((i) => i.chapterIndex), [0, 1, 1, 2]);
});

await t('two series side by side are two comics', async () => {
  const file = await zipFile('two series.zip', {
    'Crow Road/Ch 1/1.png': PNG, 'Crow Road/Ch 2/1.png': PNG,
    'Lantern/Ch 1/1.png': PNG,
  });
  const out = await library.importFiles([file], {});
  assert.equal(out.added, 2);
  assert.equal((await chaptersOf(await bookCalled('Crow Road'))).length, 2);
  assert.equal((await chaptersOf(await bookCalled('Lantern'))).length, 1);
});

await t('volumes of chapters are one series, not one book per volume', async () => {
  const plan = group.planComics(['Vol 1/Ch 1/1.png', 'Vol 1/Ch 2/1.png', 'Vol 2/Ch 3/1.png'], 'saga');
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].chapters.map((c) => c.title), ['Vol 1 · Ch 1', 'Vol 1 · Ch 2', 'Vol 2 · Ch 3']);
});

await t('a comic with no folders is one chapter, as it always was', async () => {
  const cbz = await parse.parse(new File([await (async () => {
    const zip = new JSZip();
    zip.file('1.png', PNG); zip.file('2.png', PNG);
    return zip.generateAsync({ type: 'nodebuffer' });
  })()], 'flat.cbz'));
  assert.equal(cbz.chapters.length, 1);
  assert.equal(cbz.chapters[0].title, 'Pages');
});

/* ── loose files that are not books ──────────────────────────────────── */

console.log('\nloose files that are not books');

await t('pictures picked together are one comic, not a book each', async () => {
  /* They were each read as text: a chapter folder of pages became a shelf of
   * books full of mojibake. */
  const files = Array.from({ length: 7 }, (_, i) =>
    new File([PNG], `${String(i + 1).padStart(3, '0')}.png`, { type: 'image/png' }));
  const before = (await store.all('books')).length;
  const out = await library.importFiles(files, {});
  assert.equal(out.added, 1);
  assert.equal((await store.all('books')).length - before, 1);
  const book = (await store.all('books')).find((b) => b.imageCount === 7 && b.format === 'CBZ');
  assert.ok(book, 'the pages did not become a comic');
});

await t('a file of no known kind is refused, not read as text', async () => {
  const out = await library.importFiles([new File(['\u0000\u0001binary'], 'backup.sqlite')], {});
  assert.equal(out.added, 0);
  assert.match(out.failed[0].reason, /not a kind of file/);
});

/* ── the wait ────────────────────────────────────────────────────────── */

console.log('\nthe wait');

await t('chapters are read ahead, so a slow provider is not waited on in turn', async () => {
  /* Each read of a picked file is a round trip to wherever it lives. Done
   * strictly in turn the parser sits idle through every one; read ahead, the
   * waiting overlaps the work. Measured with a 25ms delay on every read:
   * forty chapters cannot take a full second unless none of it overlaps. */
  const LATENCY = 25;
  const files = Array.from({ length: 40 }, (_, i) => {
    const body = saved('Slow', i + 1);
    const file = new File([body], `Slow - Chapter ${i + 1}.mht`);
    const wait = () => new Promise((r) => setTimeout(r, LATENCY));
    file.arrayBuffer = async () => { await wait(); return new TextEncoder().encode(body).buffer; };
    file.text = async () => { await wait(); return body; };
    return file;
  });
  const started = Date.now();
  const out = await parse.parseChapters(files, null, {});
  const took = Date.now() - started;
  assert.equal(out.chapters.length, 40);
  assert.ok(took < 40 * LATENCY * 0.7, `${took}ms: the reads were not overlapped`);
});

console.log(`\n${pass} assertions passed`);
