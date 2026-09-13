import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

/* Reader behaviour, in its own file and so its own process.
 *
 * The reader is a single module holding a single book, rendering into one
 * DOM. Tests that open books therefore tread on each other: measurements one
 * relies on are pulled out from under it by work still settling in another,
 * and a book opened anywhere re-applies its layout over whatever mode was
 * set. These passed alone and failed in company, which is a fact about
 * sharing a file rather than about the reader.
 */

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

await (async () => {
  /* The mode has to outlast the book it was chosen on. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?modes`);

  const make = async (title) => {
    const id = await store.add('books', { title, fingerprint: title, addedAt: 1 });
    await store.put('chapters', { bookId: id, index: 0, title: 'One', html: '<p>x</p>', words: 5 });
    return id;
  };

  await t('a mode chosen on one book applies to the next', async () => {
    const a = await make('First');
    const b = await make('Second');
    reader.init({ onChange() {} });

    await reader.open(a);
    assert.equal(reader.state.mode, 'paged');

    await reader.setMode('scroll');
    assert.equal((await store.settings()).readingMode, 'scroll', 'the choice was not saved');

    // The book it was never chosen on.
    await reader.open(b);
    assert.equal(reader.state.mode, 'scroll');

    // And still there on returning to the first.
    await reader.open(a);
    assert.equal(reader.state.mode, 'scroll');
  });
})();

await (async () => {
  /* Highlights could not be created at all until text became selectable --
   * the store, the Highlights tab and the data model were all there, waiting
   * for a way to make one. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?marks`);

  const id = await store.add('books', { title: 'Marked', fingerprint: 'mk', addedAt: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'One', words: 20,
    html: '<p>The quick brown fox jumps over the lazy dog.</p><p>A second paragraph.</p>',
  });

  reader.init({ onChange() {} });
  await reader.open(id);

  await t('a highlight is made from a selection and survives a re-render', async () => {
    const paragraph = document.querySelector('#page-flow p');
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 4);
    range.setEnd(paragraph.firstChild, 19);          // "quick brown fox"
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const found = reader.selectionRange();
    assert.ok(found, 'the selection was not recognised');
    assert.equal(found.text, 'quick brown fox');
    assert.equal(found.anchor, 4);

    await reader.addMark(found, 'underline', 'green', 'compare with chapter 9');

    const painted = document.querySelector('#page-flow mark.hl');
    assert.ok(painted, 'the mark was not drawn');
    assert.equal(painted.textContent, 'quick brown fox');
    assert.ok(painted.classList.contains('hl-underline'));
    assert.ok(painted.classList.contains('hl-green'));
    assert.equal(painted.dataset.note, 'compare with chapter 9');
  });

  await t('it comes back when the chapter is loaded again', async () => {
    await reader.open(id);
    const painted = document.querySelector('#page-flow mark.hl');
    assert.ok(painted, 'the mark did not survive reopening');
    assert.equal(painted.textContent, 'quick brown fox');
  });

  await t('removing one takes it off the page', async () => {
    const stored = (await store.byIndex('marks', 'bookId', id))
      .filter((m) => m.kind === 'highlight');
    assert.equal(stored.length, 1);
    await reader.removeMark(stored[0].id);
    assert.equal(document.querySelector('#page-flow mark.hl'), null);
  });

  /* Selecting by character offset into the chapter, the way the reader
     addresses text.
     Two things make the obvious approach wrong: painting a mark replaces the
     whole section, so a node held from before is detached; and once part of a
     paragraph is marked its first child is a <mark> element rather than a
     text node, so offsets into it mean nothing. */
  const pickIn = (from, to) => {
    const section = document.querySelector('#page-flow .chapter') || document.getElementById('page-flow');
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let at = 0;
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: at, length: node.nodeValue.length });
      at += node.nodeValue.length;
    }
    const locate = (offset) => {
      const entry = nodes.find((n) => offset >= n.start && offset <= n.start + n.length);
      return [entry.node, offset - entry.start];
    };
    const range = document.createRange();
    range.setStart(...locate(from));
    range.setEnd(...locate(to));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return reader.selectionRange();
  };

  await t('two marks that touch become one', async () => {
    // Marking a sentence, then the next, then the next leaves three ranges
    // that are really one passage -- and they render with seams where the
    // gaps fall.
    const pick = pickIn;

    await reader.addMark(pick(0, 9), 'highlight', 'yellow');    // "The quick"
    await reader.addMark(pick(10, 19), 'highlight', 'yellow');  // "brown fox"

    const marks = reader.marksInOrder();
    assert.equal(marks.length, 1, 'the two were not joined');
    assert.equal(marks[0].anchor, 0);
    assert.equal(marks[0].end, 19);
  });

  await t('marks that disagree are left alone', async () => {
    // A different colour is saying something different about the words.
    await reader.addMark(pickIn(20, 25), 'underline', 'blue');
    assert.equal(reader.marksInOrder().length, 2);
  });

  await t('a phrase can be split out of a longer mark', async () => {
    for (const mark of reader.marksInOrder()) await reader.removeMark(mark.id);

    await reader.addMark(pickIn(0, 30), 'highlight', 'yellow');

    // A phrase inside it.
    const found = pickIn(4, 9);
    const around = reader.markAround(found);
    assert.ok(around, 'the surrounding mark was not recognised');

    await reader.splitMark(around, found, 'box', 'green');
    const after = reader.marksInOrder();
    assert.equal(after.length, 3, 'the remainder was not kept');
    assert.deepEqual(after.map((m) => m.style), ['highlight', 'box', 'highlight']);
  });

  await t('stepping moves between marks without opening a list', async () => {
    const all = reader.marksInOrder();
    const second = await reader.stepToMark(all[0].id, 1);
    assert.equal(second.id, all[1].id);
    // And wraps rather than stopping at the end.
    const wrapped = await reader.stepToMark(all[all.length - 1].id, 1);
    assert.equal(wrapped.id, all[0].id);
  });

  await t('density is a setting the reader keeps to hand', async () => {
    await reader.setMarkDensity('hidden');
    assert.equal(document.body.dataset.marks, 'hidden');
    assert.equal((await store.settings()).markDensity, 'hidden');
    await reader.setMarkDensity('full');
  });
})();

await (async () => {
  /* Arriving at a chapter is not a measurement.
   *
   * loadChapter worked the page out from where the anchor's rectangle landed,
   * which needs the column layout to have settled. On arrival it sometimes
   * has not, and a result that comes back too large is clamped to the last
   * page -- so going forward landed at the end of the new chapter. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?arrival`);

  const id = await store.add('books', { title: 'Arrival', fingerprint: 'arr', addedAt: 1 });
  for (let i = 0; i < 4; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Ch ${i}`, words: 100,
      html: `<p>Chapter ${i} says something.</p>`.repeat(20),
    });
  }

  reader.init({ onChange() {} });
  await reader.open(id);

  await t('moving forward lands on the first page of the next chapter', async () => {
    await reader.setMode('paged');
    await reader.goTo({ chapter: 1, anchor: 0 });

    // The state a chapter is in before its layout has settled: a page count
    // left over from somewhere else.
    reader.state.pageCount = 9;
    reader.goToPage(8);
    assert.equal(reader.state.page, 8);

    await reader.nextChapter();
    assert.equal(reader.state.chapterIndex, 2);
    assert.equal(reader.state.page, 0, 'it arrived somewhere other than the beginning');
  });

  await t('a page that never measured cannot clamp to "the last page"', () => {
    // Math.min(page, pageCount - 1) with a count of zero puts every arrival
    // at -1, and with NaN it puts it anywhere at all.
    const source = read('app/src/main/assets/www/js/reader.js');
    assert.match(source, /Number\.isFinite\(state\.pageCount\) && state\.pageCount > 0/);
    assert.match(source, /Number\.isFinite\(page\) \? page : 0/);
  });
})();

console.log('what counts as reading');

await (async () => {
  /* Opening a book is not reading it, but every way of moving through one is
   * -- including scrolling, which for a while recorded nothing at all: taps
   * stopped turning pages in scroll mode, and scrolling was never wired to
   * take their place. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  const make = async (title) => {
    const id = await store.add('books', { title, fingerprint: title, addedAt: 1 });
    for (let i = 0; i < 6; i++) {
      await store.put('chapters', {
        bookId: id, index: i, title: `Ch ${i}`, words: 200,
        html: Array.from({ length: 40 }, (_, p) => `<p>Line ${p}</p>`).join(''),
      });
    }
    return id;
  };
  const statusOf = async (id) => library.statusOf(await store.get('books', id));
  reader.init({ onChange() {} });

  await t('opening a book leaves it unread', async () => {
    const id = await make('Glanced at');
    await reader.open(id);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await statusOf(id), 'unread');
  });

  await t('turning a page counts as reading', async () => {
    // And on the first turn: counting before the move meant the first turn
    // recorded the position it was leaving, so it counted nothing.
    const id = await make('Paged');
    await reader.open(id);
    // Stated rather than assumed: an earlier test may have left the reader
    // scrolling, and turn() behaves differently in each mode.
    await reader.setMode('paged');
    assert.equal(reader.state.mode, 'paged');
    reader.state.pageCount = 10;          // jsdom measures nothing
    reader.turn(1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await statusOf(id), 'reading');
  });

  await t('scrolling counts as reading', async () => {
    const id = await make('Scrolled');
    await reader.open(id);
    await reader.setMode('scroll');
    const viewport = document.getElementById('page-viewport');
    Object.defineProperty(viewport, 'clientHeight', { get: () => 800, configurable: true });
    Object.defineProperty(viewport, 'scrollHeight', { get: () => 8000, configurable: true });
    let top = 0;
    Object.defineProperty(viewport, 'scrollTop',
      { get: () => top, set: (v) => { top = v; }, configurable: true });

    assert.equal(await statusOf(id), 'unread');
    viewport.scrollTop = 2400;
    viewport.dispatchEvent(new window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await statusOf(id), 'reading');
  });

  await t('moving by chapter counts as reading', async () => {
    // Even though it credits no pages: jumping to chapter five does not mean
    // one to four were read.
    const id = await make('By chapter');
    await reader.open(id);
    await reader.nextChapter();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await statusOf(id), 'reading');
  });
})();

console.log('re-flow in scroll mode');

await (async () => {
  /* Showing or hiding the chrome changes the viewport's height and re-flows
   * the text. Restoring the position through a page index rounded it to the
   * nearest whole screenful, so a tap moved the page under the reader. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  /* Its own instance of the reader.
   *
   * The reader is one module holding one book, and every test in this file
   * shares it. Opening a book re-applies its layout, so a mode set here can
   * be undone by anything else that opens one -- including work still
   * settling from an earlier test. A separate instance cannot be reached by
   * any of that. */
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?isolated`);

  const id = await store.add('books', { title: 'Scrolled', fingerprint: 'sc', addedAt: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'One', words: 800,
    html: Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i}.</p>`).join(''),
  });

  reader.init({ onChange() {} });
  await reader.open(id);

  // jsdom measures nothing, so give the viewport a size and place ranges by
  // where their paragraph sits.
  const viewport = document.getElementById('page-viewport');
  Object.defineProperty(viewport, 'clientHeight', { get: () => 800, configurable: true });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => 8000, configurable: true });
  viewport.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 800 });
  let top = 0;
  Object.defineProperty(viewport, 'scrollTop',
    { get: () => top, set: (v) => { top = v; }, configurable: true });
  window.Range.prototype.getBoundingClientRect = function rect() {
    const paragraphs = [...document.querySelectorAll('#page-flow p')];
    const at = paragraphs.indexOf(this.startContainer.parentElement);
    return { top: (at < 0 ? 0 : at * 100) - top, left: 0, width: 5, height: 20 };
  };

  await t('a re-flow in scroll mode leaves the text where it was', async () => {
    await reader.setMode('scroll');
    assert.equal(reader.state.mode, 'scroll');

    // Deliberately not on a screen boundary: rounding to one is the bug.
    viewport.scrollTop = 1234;
    reader.state.anchor = 0;
    reader.repaginate();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(viewport.scrollTop, 1234,
      `the page moved ${Math.abs(viewport.scrollTop - 1234)}px`);
    // And it is not a multiple of the viewport height, which is what going
    // through a page index would have produced.
    assert.ok(viewport.scrollTop % 800 !== 0);
  });
})();

console.log(`\n${pass} assertions passed`);
