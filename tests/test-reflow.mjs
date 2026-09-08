import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

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
