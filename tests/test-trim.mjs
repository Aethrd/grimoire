/* Taking things out of a book.
 *
 * Every other operation makes something new and leaves its source alone, so a
 * bad result costs a delete. This one reaches into a book that already
 * exists, which makes two things worth proving rather than assuming: that
 * what was asked for is what goes, and that what went can come back.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:stub/0';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
const trim = await import(new URL('../app/src/main/assets/www/js/trim.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

/* ── fixtures ─────────────────────────────────────────────────────────── */

let seed = 0;

/** A comic: one chapter per volume, pages as images. */
async function comic(shape = [3, 3]) {
  const id = await store.add('books', {
    title: 'Comic', fingerprint: `comic:${++seed}`, addedAt: 1, chapters: shape.length,
  });
  let n = 0;
  for (const [index, count] of shape.entries()) {
    const pages = [];
    for (let i = 0; i < count; i++) {
      const href = `v${index + 1}-p${i + 1}.png`;
      pages.push(`<img data-img="${href}" alt=""/>`);
      await store.put('images', {
        bookId: id, href, order: n, chapterIndex: index, blob: new Blob([href]),
      });
      n++;
    }
    await store.put('chapters', {
      bookId: id, index, title: `Volume ${index + 1}`, words: 0, html: pages.join(''),
    });
  }
  return id;
}

/** A novel: paragraphs of prose, one chapter each. */
async function novel(count = 4) {
  const id = await store.add('books', {
    title: 'Novel', fingerprint: `novel:${++seed}`, addedAt: 1, chapters: count, lang: 'en',
  });
  for (let index = 0; index < count; index++) {
    await store.put('chapters', {
      bookId: id,
      index,
      title: `Chapter ${index + 1}`,
      words: 8,
      html: `<p>Chapter ${index + 1} opens on a road nobody travels twice.</p>`,
    });
  }
  return id;
}

const chaptersOf = async (id) =>
  (await store.byIndex('chapters', 'bookId', id)).sort((a, b) => a.index - b.index);

const hrefsOf = async (id, { removed = false } = {}) =>
  (await store.byIndex('images', 'bookId', id))
    .filter((image) => !!image.removed === removed)
    .sort((a, b) => a.order - b.order)
    .map((image) => image.href);

/* ── what there is to take out ────────────────────────────────────────── */

console.log('finding the pieces');

await t('a comic offers its pages, numbered across the whole book', async () => {
  const id = await comic([3, 2]);
  const look = await trim.inspect(id);

  assert.equal(look.pages.length, 5);
  // Page numbering runs across the book, not per chapter: "page 4" has to
  // mean the same thing on screen and in the call that removes it.
  assert.deepEqual(look.pages.map((p) => p.at), [0, 1, 2, 3, 4]);
  assert.deepEqual(look.pages.map((p) => p.chapterIndex), [0, 0, 0, 1, 1]);
  assert.equal(look.pages[3].picture, 'v2-p1.png');
  assert.ok(look.canChapters && look.canPages, 'a comic in volumes supports both');
});

await t('a book of one chapter offers pages and not chapters', async () => {
  const id = await comic([4]);
  const look = await trim.inspect(id);
  assert.equal(look.canChapters, false);
  assert.equal(look.canPages, true);
});

await t('a chapter is described by its first page or its first words', async () => {
  const picture = await trim.inspect(await comic([2]));
  assert.equal(picture.rows[0].picture, 'v1-p1.png');
  assert.equal(picture.rows[0].preview, null, 'a chapter of pictures has no words to show');

  const prose = await trim.inspect(await novel(2));
  assert.equal(prose.rows[0].picture, null);
  assert.match(prose.rows[0].preview, /^Chapter 1 opens on a road/);
});

/* ── taking pages out ─────────────────────────────────────────────────── */

console.log('\ntaking pages out');

await t('the pages asked for go and the rest stay in order', async () => {
  const id = await comic([3, 3]);
  // The credit page at the front of each volume: pages 0 and 3.
  const out = await trim.removePages(id, [0, 3]);

  assert.equal(out.removed, 2);
  assert.equal(out.pages, 4);
  assert.deepEqual(await hrefsOf(id),
    ['v1-p2.png', 'v1-p3.png', 'v2-p2.png', 'v2-p3.png']);
});

await t('a chapter that loses pages keeps its name and its others', async () => {
  const id = await comic([3, 3]);
  await trim.removePages(id, [1]);

  const chapters = await chaptersOf(id);
  assert.deepEqual(chapters.map((c) => c.title), ['Volume 1', 'Volume 2']);
  assert.equal((chapters[0].html.match(/<img/g) || []).length, 2);
  assert.equal((chapters[1].html.match(/<img/g) || []).length, 3);
});

await t('a chapter emptied by a removal goes with its pages', async () => {
  /* An empty chapter left in the list reads as a book that failed to load,
   * which is worse than one chapter fewer. */
  const id = await comic([2, 2, 2]);
  await trim.removePages(id, [2, 3]);     // the whole of volume 2

  const chapters = await chaptersOf(id);
  assert.deepEqual(chapters.map((c) => c.title), ['Volume 1', 'Volume 3']);
  assert.deepEqual(chapters.map((c) => c.index), [0, 1], 'chapters were not renumbered');
});

await t('pictures are renumbered against the book that is left', async () => {
  const id = await comic([3, 3]);
  await trim.removePages(id, [0, 1]);

  const images = (await store.byIndex('images', 'bookId', id))
    .filter((i) => !i.removed).sort((a, b) => a.order - b.order);
  assert.deepEqual(images.map((i) => i.order), [0, 1, 2, 3]);
  assert.deepEqual(images.map((i) => i.chapterIndex), [0, 1, 1, 1],
    'a picture claiming a chapter the book no longer has breaks the reel');
});

await t('a removed picture keeps its row so it can come back', async () => {
  const id = await comic([3]);
  await trim.removePages(id, [1]);

  assert.deepEqual(await hrefsOf(id, { removed: true }), ['v1-p2.png']);
  const kept = await store.get('images', [id, 'v1-p2.png']);
  assert.ok(kept.blob, 'the blob was thrown away, so putting it back is impossible');
});

await t('emptying a book is refused rather than done', async () => {
  const id = await comic([2]);
  await assert.rejects(() => trim.removePages(id, [0, 1]), /empty the book/);
  await assert.rejects(() => trim.removePages(id, []), /Choose something/);
  assert.equal((await chaptersOf(id)).length, 1, 'the book was changed by a refused removal');
});

await t('prose comes out by the paragraph', async () => {
  const id = await store.add('books', { title: 'Long', fingerprint: `long:${++seed}`, addedAt: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'Long', words: 40,
    html: Array.from({ length: 5 }, (_, i) => `<p>Paragraph ${i + 1} is here.</p>`).join(''),
  });

  await trim.removePages(id, [1, 3]);
  const [chapter] = await chaptersOf(id);
  assert.equal((chapter.html.match(/<p>/g) || []).length, 3);
  assert.match(chapter.html, /Paragraph 1/);
  assert.doesNotMatch(chapter.html, /Paragraph 2/);
  assert.match(chapter.html, /Paragraph 5/);
});

/* ── taking chapters out ──────────────────────────────────────────────── */

console.log('\ntaking chapters out');

await t('the chapters asked for go and the rest are renumbered', async () => {
  const id = await novel(4);
  const out = await trim.removeChapters(id, [1, 2]);

  assert.equal(out.removed, 2);
  const chapters = await chaptersOf(id);
  assert.deepEqual(chapters.map((c) => c.title), ['Chapter 1', 'Chapter 4']);
  assert.deepEqual(chapters.map((c) => c.index), [0, 1]);
});

await t('no stale chapter is left behind at the old numbers', async () => {
  /* Chapters are keyed by book and number, so writing four down to two
   * overwrites two rows and leaves the other two sitting there -- a book that
   * reports two chapters and reads as four. */
  const id = await novel(4);
  await trim.removeChapters(id, [0, 1]);

  const rows = await store.byIndex('chapters', 'bookId', id);
  assert.equal(rows.length, 2);
  assert.equal(await store.get('chapters', [id, 2]), undefined);
  assert.equal(await store.get('chapters', [id, 3]), undefined);
});

await t("a removed chapter's pictures go with it and the others stay", async () => {
  const id = await comic([2, 2, 2]);
  await trim.removeChapters(id, [1]);

  assert.deepEqual(await hrefsOf(id),
    ['v1-p1.png', 'v1-p2.png', 'v3-p1.png', 'v3-p2.png']);
  assert.deepEqual(await hrefsOf(id, { removed: true }), ['v2-p1.png', 'v2-p2.png']);
});

await t('taking every chapter is refused', async () => {
  const id = await novel(3);
  await assert.rejects(() => trim.removeChapters(id, [0, 1, 2]), /empty the book/);
});

await t("the book's own counts are brought up to date", async () => {
  const id = await novel(4);
  await trim.removeChapters(id, [3]);
  const book = await store.get('books', id);
  assert.equal(book.chapters, 3);
  assert.equal(book.words, 24, 'the word count still describes the book it was');
  assert.equal(book.trimmedCount, 1);
});

/* ── marks and where the reader was ──────────────────────────────────── */

console.log('\nmarks and position');

await t('a mark in a surviving chapter follows it to its new number', async () => {
  const id = await novel(4);
  await store.addMark({ bookId: id, kind: 'highlight', chapterIndex: 3, anchor: 5, end: 9 });
  await trim.removeChapters(id, [0]);

  const [mark] = await store.byIndex('marks', 'bookId', id);
  assert.equal(mark.chapterIndex, 2, 'the mark now points at a different chapter');
  assert.equal(mark.anchor, 5, 'the text did not move, so neither should the anchor');
});

await t('a mark on text that was removed is carried out, not left wrong', async () => {
  const id = await novel(3);
  await store.addMark({ bookId: id, kind: 'highlight', chapterIndex: 1, anchor: 5, end: 9 });
  const out = await trim.removeChapters(id, [1]);

  assert.equal(out.marks, 1);
  assert.equal((await store.byIndex('marks', 'bookId', id)).length, 0);
});

await t('a mark in a chapter that lost pages is carried out too', async () => {
  /* Every offset after the gap has shifted, so the mark would highlight the
   * wrong sentence. Taking it out with the removal is recoverable; leaving it
   * pointing somewhere plausible and wrong is not. */
  const id = await comic([4]);
  await store.addMark({ bookId: id, kind: 'highlight', chapterIndex: 0, anchor: 2, end: 6 });
  const out = await trim.removePages(id, [1]);
  assert.equal(out.marks, 1);
});

await t('a saved position is never left pointing past the end', async () => {
  const id = await novel(4);
  await store.put('positions', { bookId: id, chapterIndex: 3, anchor: 40, page: 2, percent: 0.9 });
  await trim.removeChapters(id, [3]);

  const saved = await store.get('positions', id);
  assert.ok(saved.chapterIndex <= 2, 'reopening would land outside the book');
});

await t('a position in an untouched chapter keeps its place exactly', async () => {
  const id = await novel(4);
  await store.put('positions', { bookId: id, chapterIndex: 3, anchor: 40, page: 2, percent: 0.9 });
  await trim.removeChapters(id, [0]);

  const saved = await store.get('positions', id);
  assert.equal(saved.chapterIndex, 2);
  assert.equal(saved.anchor, 40, 'the chapter is unchanged, so the offset is still good');
});

/* ── putting it back ──────────────────────────────────────────────────── */

console.log('\nputting it back');

await t('pages go back at the numbers they came from', async () => {
  const id = await comic([3, 3]);
  const before = await hrefsOf(id);
  await trim.removePages(id, [0, 3]);
  await trim.putBack(id);

  assert.deepEqual(await hrefsOf(id), before);
  assert.deepEqual(await hrefsOf(id, { removed: true }), [], 'a picture stayed hidden');
});

await t('chapters go back at the numbers they came from', async () => {
  const id = await novel(4);
  await trim.removeChapters(id, [1, 2]);
  const out = await trim.putBack(id);

  assert.equal(out.back, 2);
  const chapters = await chaptersOf(id);
  assert.deepEqual(chapters.map((c) => c.title),
    ['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4']);
  assert.deepEqual(chapters.map((c) => c.index), [0, 1, 2, 3]);
});

await t('a chapter emptied and then put back is a chapter again', async () => {
  const id = await comic([2, 2, 2]);
  await trim.removePages(id, [2, 3]);
  await trim.putBack(id);

  const chapters = await chaptersOf(id);
  assert.deepEqual(chapters.map((c) => c.title), ['Volume 1', 'Volume 2', 'Volume 3']);
});

await t('marks taken out with a removal come back with it', async () => {
  const id = await novel(3);
  await store.addMark({ bookId: id, kind: 'highlight', chapterIndex: 1, anchor: 5, end: 9 });
  await trim.removeChapters(id, [1]);
  await trim.putBack(id);

  const marks = await store.byIndex('marks', 'bookId', id);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].chapterIndex, 1);
  assert.equal(marks[0].anchor, 5);
});

await t('putting back is newest first and empties the history as it goes', async () => {
  const id = await comic([4]);
  await trim.removePages(id, [0]);
  await trim.removePages(id, [0]);        // what was page 1

  let book = await store.get('books', id);
  assert.equal(book.trimmed.length, 2);
  assert.equal(trim.removalSummary(book).filter((r) => r.newest).length, 1);

  await trim.putBack(id);
  await trim.putBack(id);

  book = await store.get('books', id);
  assert.equal(trim.canPutBack(book), false);
  assert.deepEqual(await hrefsOf(id),
    ['v1-p1.png', 'v1-p2.png', 'v1-p3.png', 'v1-p4.png']);
});

await t('there is nothing to put back on a book nothing was taken from', async () => {
  const id = await novel(2);
  await assert.rejects(() => trim.putBack(id), /nothing to put back/);
});

/* ── discarding ──────────────────────────────────────────────────────── */

console.log('\ndiscarding for good');

await t('discarding frees the pictures and clears the history', async () => {
  const id = await comic([4]);
  await trim.removePages(id, [1, 2]);
  assert.equal((await store.byIndex('images', 'bookId', id)).length, 4);

  const out = await trim.discard(id);
  assert.equal(out.pictures, 2);
  assert.equal((await store.byIndex('images', 'bookId', id)).length, 2,
    'the removed pictures are still taking up room');

  const book = await store.get('books', id);
  assert.equal(trim.canPutBack(book), false);
});

await t('discarding leaves the pictures the book is still using', async () => {
  const id = await comic([4]);
  await trim.removePages(id, [0]);
  await trim.discard(id);

  assert.deepEqual(await hrefsOf(id), ['v1-p2.png', 'v1-p3.png', 'v1-p4.png']);
});

/* ── the rest of the app ─────────────────────────────────────────────── */

console.log('\nthe rest of the app');

await t('the reel, the export and dividing all skip removed pictures', async () => {
  /* A removed picture keeps its row on purpose, which means every place that
   * reads pictures by book has to know the flag exists -- otherwise the page
   * is gone from the book and still in the strip. */
  for (const file of ['js/screens.js', 'js/epub.js', 'js/library.js']) {
    const source = read(`app/src/main/assets/www/${file}`);
    assert.match(source, /removed/, `${file} does not filter removed pictures`);
  }
});

await t('removal is reachable from a book and has a screen to do it on', async () => {
  const html = read('app/src/main/assets/www/index.html');
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(html, /data-screen="remove"/);
  assert.match(app, /openRemove/);
  assert.match(app, /trim\.(removePages|removeChapters)/);
});

/* ── the whole path a finger takes ───────────────────────────────────────
 *
 * Every bug in this app that reached the user got through because the pieces
 * were right and the path between them was not: a search that never ran, a
 * settings pane that wiped itself, a slider that was drawn invisible, a
 * button wearing the router's attribute. So the engine being correct is not
 * the test that matters -- this is.
 */

console.log('\nthe whole path');

await t('search, long press, pick the credit pages, take them out, put them back', async () => {
  const screensMod = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);
  await import(new URL('../app/src/main/assets/www/js/app.js', import.meta.url).href);

  const el = (id) => document.getElementById(id);
  const tap = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const settle = (ms = 140) => new Promise((r) => setTimeout(r, ms));

  // Two volumes of three pages, with a scanlator's credit page in front of
  // each -- which is the thing this feature exists for.
  const id = await comic([3, 3]);
  const book = await store.get('books', id);
  book.title = 'Driven comic';
  await store.put('books', book);
  await settle();

  screensMod.initFind(() => {}, false);
  const input = el('find-input');
  input.value = 'Driven';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);

  const tile = el('find-results').querySelector(`[data-book="${id}"]`);
  assert.ok(tile, 'the book could not be found by name');

  // A long press, which is the only way to this menu.
  tile.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
  await settle(620);
  assert.equal(el('folder-actions').hidden, false, 'the long press opened nothing');

  const takeOut = [...el('folder-actions-list').children]
    .find((b) => b.textContent.includes('Take pages out'));
  assert.ok(takeOut, 'the menu does not offer taking pages out');
  tap(takeOut);
  await settle(300);

  const active = [...document.getElementById('screens').querySelectorAll('[data-screen]')]
    .filter((s) => s.hasAttribute('data-active')).map((s) => s.dataset.screen);
  assert.deepEqual(active, ['remove'], `ended up on ${active.join(' + ')}`);

  // A comic gets a grid of its pages, not a list of their names.
  const cells = [...el('remove-body').querySelectorAll('.remove-cell')];
  assert.equal(cells.length, 6);

  const first = [...el('remove-picks').children]
    .find((c) => c.textContent === 'First of each chapter');
  assert.ok(first, 'the one-tap pick for credit pages is missing');
  tap(first);
  await settle(150);

  const picked = [...el('remove-body').querySelectorAll('.remove-cell[aria-pressed="true"]')]
    .map((c) => Number(c.querySelector('.remove-number').textContent));
  assert.deepEqual(picked, [1, 4], 'the wrong pages were picked');
  assert.equal(el('remove-go').disabled, false);

  tap(el('remove-go'));
  await settle(450);

  const chapters = (await store.byIndex('chapters', 'bookId', id)).sort((a, b) => a.index - b.index);
  assert.deepEqual(chapters.map((c) => (c.html.match(/<img/g) || []).length), [2, 2]);
  assert.deepEqual(chapters.map((c) => c.title), ['Volume 1', 'Volume 2'],
    'the chapters lost their names');
  assert.deepEqual(await hrefsOf(id),
    ['v1-p2.png', 'v1-p3.png', 'v2-p2.png', 'v2-p3.png']);

  // The panel comes back down, and the screen now offers the way back.
  assert.equal(el('import-progress').hidden, true);
  const back = [...el('remove-body').querySelectorAll('.remove-history-actions button')]
    .find((b) => b.textContent.includes('Put the last one back'));
  assert.ok(back, 'nothing on the screen offers to put it back');

  tap(back);
  await settle(450);

  assert.deepEqual(await hrefsOf(id),
    ['v1-p1.png', 'v1-p2.png', 'v1-p3.png', 'v2-p1.png', 'v2-p2.png', 'v2-p3.png']);
  assert.equal(el('remove-body').querySelector('.remove-history'), null,
    'the history is still shown after the last removal was undone');
});

await t('the bin screen lists what was deleted and puts it back', async () => {
  const el = (id) => document.getElementById(id);
  const tap = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const settle = (ms = 140) => new Promise((r) => setTimeout(r, ms));

  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const id = await store.add('books', {
    title: 'Binned', fingerprint: 'binned-drive', addedAt: 2, folder: 'Manhwa',
  });
  await library.binBooks([id]);

  const seat = [...el('tabbar').children].find((b) => b.dataset.go === 'bin');
  assert.ok(seat, 'the bin has no seat on the bar');
  tap(seat);
  await settle(300);

  assert.ok(el('bin-body').querySelector(`[data-book="${id}"]`), 'the bin does not list it');
  assert.equal(el('bin-foot').hidden, false);

  tap(el('bin-restore-all'));
  await settle(350);

  const back = await store.get('books', id);
  assert.equal(library.isBinned(back), false);
  assert.equal(back.folder, 'Manhwa', 'it came back without its folder');
});

console.log(`\n${pass} assertions passed`);
