/* The things done to a book rather than inside one.
 *
 * The bin, the floating chapter pad, smaller copies on the way out, building
 * onto a book already on the shelf, and the two crashes that came of a
 * control wearing the router's attribute.
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
const html = read('app/src/main/assets/www/index.html');
const css = read('app/src/main/assets/www/css/app.css');
const app = read('app/src/main/assets/www/js/app.js');
const panels = read('app/src/main/assets/www/js/panels.js');
const activity = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');

const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
const shrink = await import(new URL('../app/src/main/assets/www/js/shrink.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

const rule = (selector) => {
  const at = css.indexOf(`${selector} `);
  const start = css.indexOf('{', at === -1 ? css.indexOf(selector) : at);
  return css.slice(start, css.indexOf('}', start));
};

let seed = 0;
const aBook = (fields = {}) => store.add('books', {
  title: `Book ${++seed}`, fingerprint: `tool:${seed}`, addedAt: seed, ...fields,
});

/* ── the bin ─────────────────────────────────────────────────────────── */

console.log('the bin');

await t('deleting takes a book off the shelf without destroying it', async () => {
  const id = await aBook({ folder: 'Manhwa', percent: 0.4 });
  await store.put('chapters', { bookId: id, index: 0, title: 'One', html: '<p>hi</p>', words: 1 });

  assert.equal(await library.binBooks([id]), 1);

  const book = await store.get('books', id);
  assert.ok(book, 'the book was destroyed by a delete that should be reversible');
  assert.ok(library.isBinned(book));
  // Everything it had is still there: that is what makes the first step worth
  // having, and what the second step is for.
  assert.equal((await store.byIndex('chapters', 'bookId', id)).length, 1);
  assert.equal(book.folder, 'Manhwa');
  assert.equal(book.percent, 0.4);
});

await t('a binned book is off the shelf and out of its folder count', async () => {
  const id = await aBook({ folder: 'Fiction' });
  const before = (await library.folderCounts()).find((f) => f[0] === 'Fiction')?.[1] || 0;
  await library.binBooks([id]);
  const after = (await library.folderCounts()).find((f) => f[0] === 'Fiction')?.[1] || 0;
  assert.equal(after, before - 1, 'the bin still counts towards its folder');

  const shelf = read('app/src/main/assets/www/js/library.js');
  assert.match(shelf, /!b\.binnedAt/, 'renderShelf does not filter the bin out');
});

await t('binning twice does not move the clock a second time', async () => {
  const id = await aBook();
  await library.binBooks([id]);
  const first = (await store.get('books', id)).binnedAt;
  assert.equal(await library.binBooks([id]), 0);
  assert.equal((await store.get('books', id)).binnedAt, first,
    'a second delete reset how long it had been in the bin');
});

await t('putting a book back returns it with everything it had', async () => {
  const id = await aBook({ folder: 'Manga', status: 'reading' });
  await store.addMark({ bookId: id, kind: 'highlight', chapterIndex: 0, anchor: 2, end: 5 });
  await library.binBooks([id]);
  assert.equal(await library.restoreBooks([id]), 1);

  const book = await store.get('books', id);
  assert.equal(library.isBinned(book), false);
  assert.equal(book.folder, 'Manga');
  assert.equal(book.status, 'reading');
  assert.equal((await store.byIndex('marks', 'bookId', id)).length, 1);
});

await t('the bin lists newest first', async () => {
  const older = await aBook();
  const newer = await aBook();
  await library.binBooks([older]);
  await new Promise((r) => setTimeout(r, 2));
  await library.binBooks([newer]);

  const binned = await library.binnedBooks();
  const at = binned.findIndex((b) => b.id === newer);
  const then = binned.findIndex((b) => b.id === older);
  assert.ok(at < then, 'what you just deleted is what you are most likely after');
});

await t('deleting for good is the only step that frees anything', async () => {
  const id = await aBook();
  await store.put('chapters', { bookId: id, index: 0, title: 'One', html: '<p>x</p>', words: 1 });
  await store.put('images', { bookId: id, href: 'a.png', order: 0, chapterIndex: 0, blob: new Blob(['a']) });
  await library.binBooks([id]);

  assert.equal((await store.byIndex('images', 'bookId', id)).length, 1,
    'the bin threw the pictures away, so putting it back was never possible');

  await library.destroyBooks([id]);
  assert.equal(await store.get('books', id), undefined);
  assert.equal((await store.byIndex('chapters', 'bookId', id)).length, 0);
  assert.equal((await store.byIndex('images', 'bookId', id)).length, 0);
});

await t('the bin survives a backup and a restore', async () => {
  assert.ok(read('app/src/main/assets/www/js/store.js').includes("'binnedAt', 'coverBlur'"),
    'neither the bin nor a blurred cover is carried in a backup');

  const id = await aBook({ fingerprint: 'bin-backup' });
  await library.binBooks([id]);
  const backup = await store.exportBackup();
  const saved = backup.books.find((b) => b.fingerprint === 'bin-backup');
  assert.ok(saved.binnedAt, 'the backup does not record that it was in the bin');

  // And absent means "was not in the bin" rather than "leave it alone": a
  // book put back after the backup was made must not come out of a restore
  // still binned.
  await library.restoreBooks([id]);
  await store.importBackup({ ...backup, books: [{ fingerprint: 'bin-backup', title: 'x' }] });
  assert.equal(library.isBinned(await store.get('books', id)), false);
});

await t('the bin has a seat on the bar and a screen of its own', async () => {
  assert.match(html, /data-screen="bin"/);
  assert.match(html, /data-go="bin"/);
  assert.match(app, /case 'bin': return renderBin\(\)/);
  // Deleting for good is asked for in full, because it is the one delete in
  // the app that cannot be undone.
  assert.match(app, /cannot be undone/);
  assert.match(app, /Delete for good/);
});

/* ── the chapter pad ─────────────────────────────────────────────────── */

console.log('\nthe chapter pad');

await t('it is off, locked and vertical until asked otherwise', async () => {
  const pad = store.DEFAULT_SETTINGS.chapterPad;
  assert.equal(pad.on, false);
  // Locked matters most: an unlocked control over the page moves every time
  // you meant to press it.
  assert.equal(pad.locked, true);
  assert.equal(pad.vertical, true, 'up is the next chapter');
});

await t('it is placed in percentages, so rotation does not lose it', async () => {
  const paint = app.slice(app.indexOf('function paintChapterPad'),
    app.indexOf('function wireChapterPad'));
  assert.match(paint, /pad\.style\.left = `\$\{[^`]*\}%`/);
  assert.match(paint, /pad\.style\.top = `\$\{[^`]*\}%`/);
  // And clamped, so it can never be dragged off the screen it lives on.
  assert.match(paint, /Math\.max\(2, Math\.min\(98/);
  assert.match(paint, /Math\.max\(6, Math\.min\(94/);
});

await t('the pad turns pages, so the footer keeps its chapter pair', async () => {
  const paint = app.slice(app.indexOf('function paintChapterPad'),
    app.indexOf('function wireChapterPad'));
  assert.match(paint, /el\('chapter-prev'\)\.hidden = false/);
  assert.match(paint, /el\('chapter-next'\)\.hidden = false/);
  assert.match(html, /id="pad-next" title="Next page"/);
  assert.match(html, /id="pad-prev" title="Previous page"/);
});

await t('copy chapter stays in the footer', async () => {
  // Copying is done with two hands, so that one does not move.
  const pad = html.slice(html.indexOf('id="chapter-pad"'), html.indexOf('id="edge-hint"'));
  assert.ok(!pad.includes('copy-chapter'), 'the copy button was dragged onto the pad');
  assert.match(html, /class="copy-row"[\s\S]*id="copy-chapter"/);
});

await t('only the grip drags it, and only while unlocked', async () => {
  const from = app.indexOf('function wireChapterPad');
  const wire = app.slice(from, app.indexOf('/* \u2500\u2500 annotating', from));
  assert.match(wire, /const grip = el\('pad-grip'\)/);
  assert.match(wire, /grip\.addEventListener\('touchmove'/);
  assert.match(wire, /locked !== false\) return/);
  // Dragging by a button means every imprecise press moves what you meant to
  // press, so the grip is the only handle.
  assert.ok(!/pad-next'\)\.addEventListener\('touchmove/.test(wire));
  assert.match(rule('.chapter-pad.locked .pad-grip'), /pointer-events:\s*none/);
});

await t('it can be flipped to either side in one tap', async () => {
  assert.match(panels, /\['left', 'Left', 12\], \['right', 'Right', 88\]/);
  // The side follows the pad when it is dragged, so Settings never disagrees
  // with where it actually is.
  assert.match(app, /side: x < 50 \? 'left' : 'right'/);
});

await t('the pad and the notice both belong to the reader only', async () => {
  assert.match(app, /if \(name !== 'reader'\) \{ hideEdgeHint\(\); el\('chapter-pad'\)\.hidden = true; \}/);
});

/* ── the chapter edge ────────────────────────────────────────────────── */

console.log('\nthe chapter edge');

await t('the notice is read-through and never takes the tap', async () => {
  assert.match(html, /id="edge-hint"/);
  const hint = rule('.edge-hint');
  // The next tap is the one that turns the chapter.
  assert.match(hint, /pointer-events:\s*none/);
  // Transparent only where the blur that makes it legible exists; opaque
  // otherwise, which is the pattern the toast already uses.
  assert.match(css, /@supports \(backdrop-filter[^}]*\{\s*\.edge-hint/s);
});

await t('reaching the end of a chapter no longer raises a toast', async () => {
  const at = app.indexOf('async function atChapterEdge');
  const edge = app.slice(at, app.indexOf('/* \u2500\u2500 annotating', at));
  assert.match(edge, /showEdgeHint\(/);
  assert.ok(!/toast\(.*tap again/.test(edge),
    'the opaque slab over the last lines of the chapter is still there');
});

/* ── smaller copies ──────────────────────────────────────────────────── */

console.log('\nsmaller copies');

await t('the sizes are named for what they are for', async () => {
  assert.deepEqual(Object.keys(shrink.SIZES), ['full', 'large', 'screen', 'small']);
  assert.equal(shrink.SIZES.full.edge, 0, 'full size must touch nothing');
  assert.ok(shrink.SIZES.small.edge < shrink.SIZES.screen.edge);
  assert.match(shrink.describeSize('screen'), /1400/);
  assert.equal(shrink.describeSize('full'), 'full size');
});

await t('a picture is given back untouched wherever shrinking would not help', async () => {
  const gif = new Blob(['x'.repeat(400)], { type: 'image/gif' });
  // An animation re-encoded comes back as one frame.
  assert.equal(await shrink.shrinkPicture(gif, { edge: 100 }), gif);

  const png = new Blob(['x'.repeat(400)], { type: 'image/png' });
  // No target is no work.
  assert.equal(await shrink.shrinkPicture(png, { edge: 0 }), png);
  // And anything that will not decode keeps its original rather than failing
  // the export at that page.
  assert.equal(await shrink.shrinkPicture(png, { edge: 100 }), png);
});

await t('sizes read as bytes somebody can judge', async () => {
  assert.equal(shrink.describeSaving(900), '900 B');
  assert.equal(shrink.describeSaving(2048), '2 kB');
  assert.equal(shrink.describeSaving(5 * 1024 * 1024), '5.0 MB');
});

await t('the export writes a copy and never edits the book', async () => {
  const epub = read('app/src/main/assets/www/js/epub.js');
  assert.match(epub, /const wanted = size && size !== 'full' && SIZES\[size\]/);
  assert.match(epub, /await shrinkPicture\(image\.blob, wanted\)/);
  // Nothing is written back to the images store on the way out.
  const writing = epub.slice(epub.indexOf('const renamed = new Map()'));
  assert.ok(!/store\.put/.test(writing), 'exporting modified the stored book');
  assert.match(html, /id="export-size"/);
});

await t('a smaller copy says how much smaller', async () => {
  // The saving is the whole reason it was asked for, and on line art it can
  // come out near zero -- which is worth knowing rather than assuming.
  assert.match(read('app/src/main/assets/www/js/epub.js'), /name: `\$\{safeName\(book\.title\)\}\.epub`, saved/);
  assert.match(app, /shrink\.describeSaving\(saved\)/);
});

/* ── building onto a book ────────────────────────────────────────────── */

console.log('\nbuilding onto a book');

await t('a book on the shelf goes into the workshop as a part', async () => {
  build.clear();
  const id = await aBook({ title: 'Volume one', chapters: 3 });
  const book = await store.get('books', id);

  build.addBook(book);
  const [part] = build.contents();
  assert.equal(part.bookId, id);
  assert.equal(part.name, 'Volume one');
  assert.match(build.describe(part), /From the shelf · 3 chapters/);
  assert.equal(build.hasBook(id), true);
});

await t('it is a part like any other: movable, droppable, mixable', async () => {
  build.clear();
  const id = await aBook({ title: 'Shelf book' });
  build.addBook(await store.get('books', id));
  build.addBook(await store.get('books', await aBook({ title: 'Second' })));

  const [first] = build.contents();
  build.move(first.id, 1);
  assert.equal(build.contents()[1].name, 'Shelf book');
  build.drop(first.id);
  assert.equal(build.contents().length, 1);
  build.clear();
});

await t('building onto a book leaves the book alone', async () => {
  const id = await aBook({ title: 'Original', chapters: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'One', words: 2, html: '<p>The first part.</p>',
  });

  build.clear();
  build.addBook(await store.get('books', id));
  const { book } = await build.build({ title: 'Original and more' });

  assert.notEqual(book.id, id, 'building wrote over the book it was built from');
  assert.equal((await store.byIndex('chapters', 'bookId', id)).length, 1);
  assert.equal(book.chapters, 1);
  assert.equal(book.builtFrom[0].bookId, id, 'the result does not record where it came from');
  build.clear();
});

await t('pages taken out of a book stay out of what is built onto it', async () => {
  const source = read('app/src/main/assets/www/js/build.js');
  assert.match(source, /async function readShelfBook/);
  assert.match(source, /filter\(\(image\) => !image\.removed\)/);
});

await t('it is reachable from the book rather than from the workshop', async () => {
  assert.match(app, /async function buildOnto\(book\)/);
  assert.match(app, /'Build onto this book'/);
  // Already in the build is said rather than silently added twice.
  assert.match(app, /already in the build/);
});

/* ── the two blank screens ───────────────────────────────────────────── */

console.log('\nthe blank screen');

await t('the jump button no longer wears the router attribute', async () => {
  const screens = read('app/src/main/assets/www/js/screens.js');
  // data-go with no value read as "go to the screen called nothing", which
  // switched the current screen off, found none to switch on, and left the
  // app a blank page.
  assert.match(screens, /data-goto-page>Go to page/);
  assert.ok(!/data-go>/.test(screens), 'a valueless data-go is back');
  assert.ok(!/data-go>/.test(html), 'a valueless data-go is in the markup');
});

await t('the router refuses to navigate to a screen that is not there', async () => {
  assert.match(app, /\[data-go\]:not\(\[data-go=""\]\)/);
  assert.match(app, /if \(name && screenNode\(name\)\)/);
  // And show() guards too, so the blank page is not one typo away.
  const show = app.slice(app.indexOf('async function show(name'), app.indexOf('async function enter'));
  assert.match(show, /if \(!screenNode\(name\)\) return;/);
});

await t('a dead renderer rebuilds the view instead of killing the app', async () => {
  assert.match(activity, /public boolean onRenderProcessGone/);
  assert.match(activity, /private void rebuildWebView/);
  // The dead one is detached and destroyed: left attached it is a zombie view
  // with live bridges, which is worse than the crash.
  assert.match(activity, /removeView\(dead\)/);
  assert.match(activity, /dead\.destroy\(\)/);
  // And it says what happened, once there is somewhere to say it.
  assert.match(activity, /pendingNotice/);
  assert.match(app, /notice\(message\)/);
});

/* ── the panes and the pad, drawn rather than described ──────────────────
 *
 * A settings pane that wiped itself, a slider drawn invisible, a control that
 * existed and could not be reached: every one of those passed a source check
 * and failed on the phone. These render the real thing and look at what came
 * out.
 */

console.log('\nwhat actually gets drawn');

const el = (id) => document.getElementById(id);
const tap = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const behaviourPane = async () => {
  const panelsMod = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);
  await panelsMod.openSettings(() => {});
  const tab = [...el('settings-strip').children].find((b) => /behaviour/i.test(b.textContent));
  tap(tab);
  await settle();
  return el('settings-body');
};

await t('the pad controls appear without wiping the pane they are in', async () => {
  await store.saveSettings({
    chapterPad: { on: true, x: 88, y: 64, scale: 1, vertical: true, locked: false, side: 'right' },
  });
  const body = await behaviourPane();
  const text = body.textContent;

  for (const want of ['Page buttons', 'Float them over the page', 'Up is the next page',
    'Side', 'Size', 'Down the page', 'Put it back where it started']) {
    assert.ok(text.includes(want), `the pane has no "${want}"`);
  }

  /* And everything that was already there is still there.
   *
   * A mid-render `body.innerHTML = ...` once discarded everything appended
   * above it, so several settings had never been visible at all. */
  for (const kept of ['Page turning', 'Pictures', 'At the end of a chapter', 'Streaks', 'Screen']) {
    assert.ok(text.includes(kept), `adding the pad controls wiped "${kept}"`);
  }

  // Native range inputs, not boxes built out of pseudo-elements: the hand-drawn
  // kind came out invisible on WebViews that do not apply them.
  const ranges = [...body.querySelectorAll('input[type="range"]')];
  assert.ok(ranges.length >= 6, `only ${ranges.length} sliders drawn`);
});

await t('the pad controls collapse when the pad is off', async () => {
  await store.saveSettings({
    chapterPad: { on: false, x: 88, y: 64, scale: 1, vertical: true, locked: true, side: 'right' },
  });
  const text = (await behaviourPane()).textContent;
  assert.ok(text.includes('Float them over the page'));
  assert.ok(!text.includes('Put it back where it started'),
    'controls for a pad that is not on are still showing');
});

await t('the pad is drawn on the reader, where it was put, and turns pages on into chapters', async () => {
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);
  await import(new URL('../app/src/main/assets/www/js/app.js', import.meta.url).href);

  await store.saveSettings({
    chapterPad: { on: true, x: 12, y: 40, scale: 1.3, vertical: true, locked: false, side: 'left' },
  });

  const id = await aBook({ title: 'Padded' });
  for (let i = 0; i < 4; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Chapter ${i + 1}`, words: 20,
      html: `<p>Chapter ${i + 1} runs on for a sentence so there is something to turn.</p>`,
    });
  }

  // The app draws its own shelf, so the tile carries the app's own handler.
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'folders'));
  await settle();
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(300);

  const tile = document.querySelector(`[data-book="${id}"]`);
  assert.ok(tile, 'the book is not on the shelf');
  tap(tile);
  await settle(500);
  assert.equal(document.body.dataset.view, 'reader');

  const pad = el('chapter-pad');
  assert.equal(pad.hidden, false, 'the pad was turned on and never appeared');
  assert.equal(pad.style.left, '12%');
  assert.equal(pad.style.top, '40%');
  assert.equal(pad.style.getPropertyValue('--pad-scale'), '1.3');
  assert.equal(pad.dataset.vertical, '', 'up is not the next chapter');
  assert.equal(pad.classList.contains('locked'), false);

  // It turns pages, so the footer keeps the chapter pair.
  assert.equal(el('chapter-prev').hidden, false);
  assert.equal(el('chapter-next').hidden, false);
  // And it knows where it is in the book: nothing before the first page.
  assert.equal(el('pad-prev').disabled, true, 'back is offered from the first page of the book');
  assert.equal(el('pad-next').disabled, false);

  // A chapter of several pages: onward is the next page, not the next chapter.
  // (jsdom lays nothing out, so the page count is given.)
  assert.equal(reader.state.chapterIndex, 0);
  reader.state.pageCount = 3;
  tap(el('pad-next'));
  await settle(300);
  assert.equal(reader.state.chapterIndex, 0, 'the pad skipped the rest of the chapter');
  assert.equal(reader.state.page, 1, 'the pad did not turn the page');
  assert.equal(el('pad-prev').disabled, false, 'back is not offered from the second page');
  tap(el('pad-prev'));
  await settle(300);
  assert.equal(reader.state.page, 0);

  // At the last page of a chapter, onward is the next chapter -- no "tap
  // again", which guards against stray taps on the text, not button presses.
  reader.state.pageCount = 1;
  tap(el('pad-next'));
  await settle(400);
  assert.equal(reader.state.chapterIndex, 1, 'the pad stops at the end of the chapter');
  // And back from the first page of a chapter is the end of the one before.
  tap(el('pad-prev'));
  await settle(400);
  assert.equal(reader.state.chapterIndex, 0);

  /* Pressed the way a finger presses it, not only clicked.
   *
   * The pad sits inside the page, so a touch on it used to reach the page's
   * own tap handler too -- on the right edge, the forward zone. Next turned
   * two pages and Previous none at all, and a click alone never showed it. */
  const host = el('page-host');
  const realRect = host.getBoundingClientRect;
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 });
  const press = async (button) => {
    const at = { clientX: 380, clientY: 500, identifier: 1, target: button };
    const touch = (type, list) => {
      const event = new window.Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', { value: list });
      Object.defineProperty(event, 'changedTouches', { value: [at] });
      button.dispatchEvent(event);
    };
    touch('touchstart', [at]);
    touch('touchend', []);
    tap(button);
    await settle(300);
  };
  try {
    reader.state.pageCount = 5;
    reader.goToPage(1);
    await settle(100);
    const turnBySideTap = (await store.settings()).turnBySideTap;
    await store.saveSettings({ turnBySideTap: true });
    await press(el('pad-next'));
    assert.equal(reader.state.page, 2, 'one press of Next did not turn exactly one page');
    await press(el('pad-prev'));
    assert.equal(reader.state.page, 1, 'one press of Previous did not turn exactly one page back');
    await store.saveSettings({ turnBySideTap });
  } finally {
    host.getBoundingClientRect = realRect;
  }
  assert.match(app, /const onControl = \(e\) => !!e\.target\?\.closest\?\.\('#chapter-pad, #edge-hint'\)/);

  /* Held on the rail -- a long press on a word at the end of a line, to
   * highlight it -- is not a scrub. The rail used to jump on contact, so
   * highlighting near the margin threw the reader pages away. Only a drag
   * along it moves the book. */
  const rail = el('scrub-rail');
  const realRail = rail.getBoundingClientRect;
  rail.getBoundingClientRect = () => ({ left: 360, right: 386, top: 100, bottom: 700, width: 26, height: 600 });
  const railTouch = (type, x, y) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    const at = { clientX: x, clientY: y, identifier: 2, target: rail };
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [at] });
    Object.defineProperty(event, 'changedTouches', { value: [at] });
    rail.dispatchEvent(event);
  };
  try {
    reader.state.pageCount = 5;
    reader.goToPage(1);
    await settle(100);
    railTouch('touchstart', 373, 650);
    await settle(700);                       // held, as a long press is
    railTouch('touchmove', 375, 652);        // the slight drift of a held finger
    railTouch('touchend', 375, 652);
    await settle(100);
    assert.equal(reader.state.page, 1, 'a press held on the rail moved the book');
    assert.equal(el('scrub-bubble').hidden, true);

    // A drag along it still scrubs.
    railTouch('touchstart', 373, 120);
    for (const y of [140, 300, 500, 690]) railTouch('touchmove', 373, y);
    assert.equal(el('scrub-bubble').hidden, false, 'dragging the rail shows nothing');
    railTouch('touchend', 373, 690);
    await settle(100);
    assert.equal(reader.state.page, 4, 'a drag down the rail did not move through the chapter');
    assert.equal(el('scrub-bubble').hidden, true);
  } finally {
    rail.getBoundingClientRect = realRail;
  }

  /* Dragging cannot be driven here: jsdom has no layout, so a synthetic touch
   * carries no coordinates to drag by. The grip being the only handle, and
   * the lock stopping it, are checked against the source above. */
});

await t('search does not find deleted books', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const screensMod = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);
  const kept = await aBook({ title: 'Quillfeather Kept' });
  const gone = await aBook({ title: 'Quillfeather Gone' });
  await library.binBooks([gone]);
  screensMod.initFind(() => {}, false);
  el('find-input').value = 'Quillfeather';
  el('find-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(450);
  const found = [...el('find-results').querySelectorAll('[data-book]')].map((n) => Number(n.dataset.book));
  assert.ok(found.includes(kept), 'the book on the shelf was not found');
  assert.ok(!found.includes(gone), 'a deleted book was found');
  // Nor counted in its folder, nor caught by Select all, nor grouped.
  const panelsSource = read('app/src/main/assets/www/js/panels.js');
  assert.match(panelsSource, /const visible = books\.filter\(\(b\) => onShelf\(b\)/);
  assert.match(app, /library\.shownOnShelf\.has\(book\.id\)/);
  const screensSource = read('app/src/main/assets/www/js/screens.js');
  assert.equal((screensSource.match(/!b\.binnedAt/g) || []).length, 3);
});


await t('a status set by hand holds until the book is next read, then reading takes over', async () => {
  const lib = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const id = await aBook({ title: 'Statusful', lastReadAt: 5, status: 'onHold' });
  let book = await store.get('books', id);
  assert.equal(lib.statusOf(book), 'onHold', 'what was set does not show');
  assert.equal(lib.statusIsPinned(book), true);

  // Opening it is not reading it: still on hold.
  await store.queuePosition({ bookId: id, chapterIndex: 0, offset: 0, percent: 0.2 });
  await store.flushPosition();
  book = await store.get('books', id);
  assert.equal(lib.statusOf(book), 'onHold', 'merely opening the book undid the status');

  // Reading it is.
  await store.markRead(id);
  book = await store.get('books', id);
  assert.equal(book.status, undefined, 'the status stayed set after reading');
  assert.equal(lib.statusOf(book), 'reading');
  assert.equal(lib.statusIsPinned(book), false);

  // Marked finished, it stays finished when read again: the mark is kept in
  // the dates, not only in the status that reading lets go of.
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  const set = app.slice(app.indexOf('function setStatusOn'), app.indexOf('async function applyStatus'));
  assert.match(set, /status === 'finished'\) \{ book\.finishedAt = book\.finishedAt \|\| Date\.now\(\); book\.percent = 1; \}/);
  assert.match(set, /reader\.noteStatusSet\(book\.id\)/);
  book.status = 'finished'; book.finishedAt = 7; book.percent = 1;
  await store.put('books', book);
  await store.markRead(id);
  assert.equal(lib.statusOf(await store.get('books', id)), 'finished');

  // Every way of setting one goes through it -- one book, a bundle, several.
  assert.match(app, /if \(pickedStatus !== undefined\) setStatusOn\(book, pickedStatus\)/);
  assert.match(app, /if \(pickedStatus !== undefined\) setStatusOn\(edition, pickedStatus\)/);
  assert.match(app, /for \(const book of books\) \{\s*setStatusOn\(book, status\)/);
  // Details is left on Automatic, and says what the status is now.
  assert.match(app, /chip\.setAttribute\('aria-pressed', String\(value === null\)\)/);
  assert.match(app, /as you set it, until you next read it/);
  await library.binBooks([id]);
});

await t('tags: one of each, spelled as the list spells them, and found by search', async () => {
  const tg = await import(new URL('../app/src/main/assets/www/js/tags.js', import.meta.url).href);
  const screensMod = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);
  // The list: every kind from the directory, the Chinese table left out, each tag once.
  assert.equal(tg.TAG_GROUPS.length, 15);
  const all = tg.TAG_GROUPS.flatMap(([, list]) => list);
  assert.equal(new Set(all.map(tg.tagKey)).size, all.length, 'a tag is listed twice');
  assert.ok(!all.some((t) => /[一-鿿]/.test(t)), 'a Chinese tag got in');
  assert.ok(all.includes('Slow Burn') && all.includes('Kingdom Building') && all.includes('LitRPG'));
  // Typed any which way, a listed tag is the listed tag; anything else is kept as typed.
  assert.equal(tg.normaliseTag('  slow-burn '), 'Slow Burn');
  assert.equal(tg.normaliseTag('litrpg'), 'LitRPG');
  assert.equal(tg.normaliseTag('cozy vibes'), 'cozy vibes');
  assert.deepEqual(tg.uniqueTags(['System', 'system', ' SYSTEM ', '', 'Harem']), ['System', 'Harem']);
  assert.deepEqual(tg.tagsOf({ tags: 'Fantasy, Harem' }), ['Fantasy', 'Harem']);
  assert.ok(tg.sameTags(['Harem', 'Fantasy'], ['fantasy', 'harem']));

  // Search: the Tags scope finds books with every tag picked.
  const a = await aBook({ title: 'Tagged A', tags: ['Slow Burn', 'Regression'] });
  const b = await aBook({ title: 'Tagged B', tags: ['Slow Burn', 'Harem'] });
  const c = await aBook({ title: 'Tagged C', tags: ['Fantasy'] });
  screensMod.initFind(() => {}, false);
  const scopes = [...el('find-scope').children];
  const tagScope = scopes.find((chip) => chip.textContent === 'Tags');
  assert.ok(tagScope, 'there is no Tags search');
  tagScope.click();
  await settle(300);
  const row = () => [...el('find-results').querySelectorAll('.find-tags .chip')];
  assert.ok(row().some((chip) => chip.textContent.startsWith('Slow Burn')), 'the shelf\'s tags are not offered');
  // Only tags in use are offered there -- not the long list.
  assert.ok(row().length < 20, `${row().length} tags offered`);
  const found = () => [...el('find-results').querySelectorAll('[data-book]')].map((n) => Number(n.dataset.book));
  row().find((chip) => chip.textContent.startsWith('Slow Burn')).click();
  await settle(300);
  assert.deepEqual(found().sort(), [a, b].sort());
  row().find((chip) => chip.textContent.startsWith('Harem')).click();
  await settle(300);
  assert.deepEqual(found(), [b], 'a second tag did not narrow it');
  el('find-scope').firstElementChild.click();   // Everything
  el('find-input').value = 'regression';
  el('find-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(450);
  assert.ok(found().includes(a), 'Everything does not search tags');
  await library.binBooks([a, b, c]);
});

await t('tags are set from Details, for one book, a bundle, or several', async () => {
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  // One book: its own tags and a button; the list is in its own sheet.
  assert.match(app, /add\.textContent = tagList\.length \? '＋ Tags…' : '＋ Add tags…'/);
  assert.match(app, /if \(tagsChanged\) book\.tags = tagList/);
  // A bundle's other editions get what was added and lose what was taken off.
  assert.match(app, /if \(tagsChanged\) edition\.tags = retag\(edition, tagList, startTags\)/);
  // Several: take one off all of them, or put more on all of them.
  assert.match(app, /const next = tags\.uniqueTags\(\[\.\.\.kept, \.\.\.adding\]\)/);
  // Back shuts the picker before anything else.
  assert.match(app, /if \(tags\.closeTagPicker\(\)\) return true;/);
  const src = fs.readFileSync(new URL('../app/src/main/assets/www/js/tags.js', import.meta.url), 'utf8');
  // The long list stays out of the way: folded until searched, capped when it is.
  assert.match(src, /section\(label, tags\.filter\(fits\), \{ open: searching, cap: searching \? 8 : Infinity \}\)/);
});

await t('a folder hidden from the shelf is only found under Folders', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const screensMod = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);
  const panelsMod = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);
  const out = await aBook({ title: 'Brambleway Out', folder: 'Shelved' });
  const kept = await aBook({ title: 'Brambleway Kept', folder: 'Private' });
  const nested = await aBook({ title: 'Brambleway Nested', folder: 'Private/Old' });
  const lookalike = await aBook({ title: 'Brambleway Lookalike', folder: 'Private stuff' });

  // Nested folders go with the one they are in; a name that merely starts
  // the same does not.
  assert.equal(library.hiddenBy('Private/Old', ['Private']), 'Private');
  assert.equal(library.hiddenBy('Private stuff', ['Private']), null);
  assert.equal(library.hiddenBy('', ['Private']), null);

  await library.setFolderHidden('Private', true);
  const tiles = () => [...el('shelf').querySelectorAll('[data-book]')].map((n) => Number(n.dataset.book));
  const handlers = { onOpen() {}, onLongPress() {}, selection: new Set(), selecting: false };

  await library.renderShelf({ ...handlers, folder: null });
  let shown = tiles();
  assert.ok(shown.includes(out) && shown.includes(lookalike), 'the rest of the shelf went with it');
  assert.ok(!shown.includes(kept), 'a hidden folder is still on the shelf');
  assert.ok(!shown.includes(nested), 'a folder inside a hidden one is still on the shelf');
  assert.ok(!library.shownOnShelf.has(kept), '"select all" would reach a hidden book');

  // Opened from Folders, it shows what is in it.
  await library.renderShelf({ ...handlers, folder: 'Private' });
  shown = tiles();
  assert.ok(shown.includes(kept) && shown.includes(nested), 'opening the folder does not show its books');
  assert.ok(!shown.includes(out));

  // The shelf's search leaves it out too.
  screensMod.initFind(() => {}, false);
  el('find-input').value = 'Brambleway';
  el('find-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(450);
  const found = [...el('find-results').querySelectorAll('[data-book]')].map((n) => Number(n.dataset.book));
  assert.ok(found.includes(out));
  assert.ok(!found.includes(kept) && !found.includes(nested), 'search finds a hidden folder');

  // Still listed under Folders, and marked.
  await panelsMod.openFolders(() => {});
  const rows = [...el('folders-list').querySelectorAll('.folder-row')];
  const row = (name) => rows.find((r) => r.querySelector('b')?.textContent === name);
  assert.ok(row('Private')?.classList.contains('off-shelf'), 'the hidden folder is not listed, or not marked');
  assert.match(row('Private').textContent, /Hidden from the shelf/);
  assert.match(row('Private/Old').textContent, /Hidden with “Private”/);
  assert.ok(!row('Private stuff').classList.contains('off-shelf'));

  // And back again.
  await library.setFolderHidden('Private', false);
  await library.renderShelf({ ...handlers, folder: null });
  assert.ok(tiles().includes(kept), 'showing it again did not put it back');
  await library.binBooks([out, kept, nested, lookalike]);
});

await t('a shelf of only hidden folders does not say there are no books', async () => {
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/library.js', import.meta.url), 'utf8');
  assert.match(app, /kept \? 'Nothing on the shelf' : 'No books yet'/);
  assert.match(app, /in folders hidden from the shelf\. They are under Folders/);
});

await t('a hidden folder is not what the app opens on', async () => {
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  const boot = app.slice(app.indexOf('async function boot()'));
  assert.match(boot, /library\.hiddenBy\(activeFolder, library\.hiddenFolderList\(settings\)\)[\s\S]{0,80}activeFolder = null/);
  // The choice is in the folder's own menu, both ways.
  assert.match(app, /'Hide from the shelf'/);
  assert.match(app, /'Show on the shelf'/);
  assert.match(app, /await library\.setFolderHidden\(target, showing\)/);
});
await t('a text file imported as one frozen block is read again when picked again', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const text = '第一章 开始\n他走了。\n第二章 回来\n她笑了。\n';
  const file = new File([text], 'frozen-novel.txt');
  // What the old reading of text left behind: the whole book in one paragraph.
  const old = await store.add('books', {
    title: 'frozen-novel', format: 'TXT', fingerprint: `frozen-novel.txt:${file.size}`, addedAt: 1, chapterCount: 1,
  });
  await store.put('chapters', { bookId: old, index: 0, title: 'Beginning', words: 1, html: `<p>${'字'.repeat(90 * 1024)}</p>` });
  const out = await library.importFiles([file], {});
  assert.equal(out.reread, 1, 'the frozen copy was kept instead of read again');
  assert.equal(out.added, 1);
  assert.equal(await store.get('books', old), undefined, 'the frozen copy is still there');
  const fresh = (await store.byIndex('books', 'fingerprint', `frozen-novel.txt:${file.size}`))[0];
  const chapters = await store.byIndex('chapters', 'bookId', fresh.id);
  assert.deepEqual(chapters.sort((a, b) => a.index - b.index).map((c) => c.title), ['第一章 开始', '第二章 回来']);
  // Picked a third time, the good copy is kept.
  const again = await library.importFiles([file], {});
  assert.equal(again.added, 0);
  assert.equal(again.already, 1);
});

await t('a chosen cover goes into the book: over its cover page, or in front as one', async () => {
  const covers = await import(new URL('../app/src/main/assets/www/js/coverpage.js', import.meta.url).href);
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);
  const picture = (n) => new Blob([`cover ${n}`], { type: 'image/webp' });
  const words = (html) => html.replace(/<[^>]+>/g, '');
  const firstHtml = async (id) => parse.chapterHtml((await store.byIndex('chapters', 'bookId', id)).find((c) => c.index === 0));

  // A book that opens on its cover: the picture on that page is swapped.
  const comic = await aBook({ title: 'Opens on a cover', imageCount: 2 });
  await store.put('chapters', { bookId: comic, index: 0, title: 'One', words: 3, html: '<figure><img data-img="old.jpg"></figure><p>Once upon a time.</p>' });
  await store.put('images', { bookId: comic, href: 'old.jpg', order: 0, chapterIndex: 0, blob: new Blob(['old']) });
  assert.equal(await covers.placeCover(comic, picture(1)), 'swapped');
  let html = await firstHtml(comic);
  const first = (await store.get('books', comic)).coverPage.href;
  assert.match(html, new RegExp(`^<figure><img data-img="${first}"></figure><p>Once upon a time\\.</p>$`));
  assert.ok(first.startsWith('grimoire-cover/') && first.endsWith('.webp'));
  const kept = await store.get('images', [comic, first]);
  assert.ok(kept && kept.cover === true && kept.chapterIndex === 0, 'the picture is not among the book\'s own');
  assert.equal((await store.get('books', comic)).imageCount, 3);

  // Chosen again: it replaces the last choice instead of stacking up.
  await covers.placeCover(comic, picture(2));
  html = await firstHtml(comic);
  const second = (await store.get('books', comic)).coverPage.href;
  assert.equal((html.match(/<img/g) || []).length, 1);
  assert.ok(html.includes(second) && !html.includes(first));
  assert.equal(await store.get('images', [comic, first]), undefined, 'the replaced choice was left behind');
  assert.equal((await store.get('books', comic)).coverPage.swapped, 'old.jpg', 'the original was forgotten');

  // Removed: the book is as it came.
  assert.equal(await covers.placeCover(comic, null), 'removed');
  assert.equal(await firstHtml(comic), '<figure><img data-img="old.jpg"></figure><p>Once upon a time.</p>');
  assert.equal((await store.get('books', comic)).coverPage, undefined);
  assert.equal((await store.get('books', comic)).imageCount, 2);

  // A book that opens on words: a cover page goes in front, and moves no text,
  // so every mark and reading position counted in characters stays put.
  const novel = await aBook({ title: 'Opens on words' });
  const prose = '<h1>Chapter One</h1><p>It was a dark night.</p>';
  await store.put('chapters', { bookId: novel, index: 0, title: 'One', words: 6, html: prose });
  assert.equal(await covers.placeCover(novel, picture(3)), 'added');
  html = await firstHtml(novel);
  assert.match(html, /^<figure class="grimoire-cover"><img data-img="grimoire-cover\/[^"]+" alt="Cover"><\/figure><h1>/);
  assert.equal(words(html), words(prose), 'the cover page moved the text');
  await covers.placeCover(novel, null);
  assert.equal(await firstHtml(novel), prose);

  // It has a page of its own when reading, and in the exported book.
  assert.match(css, /body\[data-mode="paged"\] \.page-flow figure\.grimoire-cover \{\s*break-after: column/);
  assert.match(read('app/src/main/assets/www/js/epub.js'), /figure\.grimoire-cover \{[^}]*page-break-after: always/);
});

await t('Save in the details puts the cover into the book, and opening a book does not undo it', async () => {
  // Wired where the cover is chosen...
  assert.match(app, /await covers\.placeCover\(book\.id, newCover\)/);
  // ...and the book is never overwritten by an older copy of itself: the
  // shelf's tile record, written back on opening, brought the old cover back.
  const open = app.slice(app.indexOf('async function openBook'), app.indexOf('/* ── selection'));
  assert.match(open, /const current = \(await store\.get\('books', book\.id\)\) \|\| book;/);
  assert.ok(!/await store\.put\('books', book\);/.test(open), 'opening writes the tapped copy back');
  assert.match(app, /async function openDetails\(tapped, \{ editions = \[\] \} = \{\}\) \{[\s\S]{0,300}await store\.get\('books', tapped\.id\)/);
});

await t('a backup puts a chosen cover back into the book, not only onto the shelf', async () => {
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);
  const id = await aBook({ title: 'Restored cover', fingerprint: 'restored-cover.epub:10' });
  await store.put('chapters', { bookId: id, index: 0, title: 'One', words: 2, html: '<p>Two words.</p>' });
  const report = await store.importBackup({
    format: 'grimoire-backup',
    version: 1,
    books: [{ fingerprint: 'restored-cover.epub:10', title: 'Restored cover', coverCustom: true }],
    covers: [{ fingerprint: 'restored-cover.epub:10', dataUrl: 'data:image/webp;base64,UklGRgAAAABXRUJQ' }],
    positions: [], marks: [],
  });
  assert.equal(report.covers, 1);
  const book = await store.get('books', id);
  assert.ok(book.coverPage?.href, 'the cover came back to the shelf only');
  const html = parse.chapterHtml((await store.byIndex('chapters', 'bookId', id))[0]);
  assert.ok(html.includes(book.coverPage.href));
});

await t('an exported book names its cover for what the picture is', async () => {
  const epub = await import(new URL('../app/src/main/assets/www/js/epub.js', import.meta.url).href);
  const source = read('app/src/main/assets/www/js/epub.js');
  assert.match(source, /const coverName = `cover\.\$\{extensionFor\(book\.coverBlob, 'cover\.jpg'\)\}`/);
  assert.match(source, /media-type="\$\{mediaFor\(coverName\)\}"/);
  assert.equal(epub.extensionFor(new Blob(['x'], { type: 'image/webp' }), 'cover.jpg'), 'webp');
});

await t('many books are written into one zip a book at a time, and it opens anywhere', async () => {
  const { zipWriter } = await import(new URL('../app/src/main/assets/www/js/zipwriter.js', import.meta.url).href);
  const JSZip = (await import('jszip')).default;
  const book = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 7 + (i >> 11)) & 255);
  for (const zip64At of [undefined, 1000]) {          // and with the forms used past 4GB
    const parts = [];
    const zip = zipWriter((bytes) => { parts.push(Buffer.from(bytes)); }, zip64At ? { zip64At } : {});
    await zip.add('Volume 1.epub', new Blob([book]));
    await zip.add('Том 2 — 第二.epub', new Blob(['small']));
    await zip.finish();
    const read = await JSZip.loadAsync(Buffer.concat(parts), { checkCRC32: true });
    assert.deepEqual(Object.keys(read.files), ['Volume 1.epub', 'Том 2 — 第二.epub']);
    const back = await read.file('Volume 1.epub').async('uint8array');
    assert.equal(back.length, book.length);
    assert.ok(back.every((v, i) => v === book[i]), 'the book came out changed');
    assert.equal(await read.file('Том 2 — 第二.epub').async('string'), 'small');
  }
  // And the export builds each book, writes it, and lets it go -- not every
  // book held, then the whole archive again.
  const many = app.slice(app.indexOf('async function exportMany'), app.indexOf('function exportSink'));
  assert.ok(!/new JSZip|generateAsync/.test(many), 'the batch is still built whole in memory');
  assert.match(many, /await zip\.add\(entry, blob/);
  assert.match(many, /await zip\.finish\(\);\s*await sink\.done\('application\/zip'\)/);
});

await t('an export survives Android closing the app while the save screen is open', () => {
  const java = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  // Where the file is, kept across the restart...
  assert.match(java, /outState\.putString\(STAGED_PATH, staged\.getAbsolutePath\(\)\)/);
  assert.match(java, /restoreStagedExport\(savedInstanceState\);/);
  assert.match(java, /getSharedPreferences\("exports", MODE_PRIVATE\)/);
  // ...and never dropped without a word.
  const result = java.slice(java.indexOf('protected void onActivityResult'), java.indexOf('staging.execute(() -> {', java.indexOf('protected void onActivityResult')));
  assert.ok(!/if \(target == null \|\| source == null\) return;/.test(result), 'a lost export is still silent');
  assert.match(result, /The export was lost while the save screen was open/);
  assert.match(result, /Not saved — no place was chosen/);
  // What it says is held until the page that will show it is ready.
  assert.match(java, /if \(!readerReady \|\| webView == null\) \{\s*heldCalls\.add\(call\);/);
  assert.match(java, /readerReady = true;\s*flushHeldCalls\(\);/);
  const rebuild = java.slice(java.indexOf('private void rebuildWebView'), java.indexOf('webView.loadUrl(START_URL);', java.indexOf('private void rebuildWebView')));
  assert.match(rebuild, /readerReady = false;/);
});

await t('a book written out and given back is the same book, not a second copy', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const epub = await import(new URL('../app/src/main/assets/www/js/epub.js', import.meta.url).href);
  const JSZip = (await import('jszip')).default;
  const fixture = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  const bytesOf = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  const original = new File([fixture], 'round-trip-almanac.epub');
  const first = await library.importFiles([original], {});
  assert.equal(first.added, 1);
  const book = (await store.byIndex('books', 'fingerprint', `round-trip-almanac.epub:${original.size}`))[0];

  // Written out, it says which book it is -- the same thing every time.
  const { blob } = await epub.buildEpub(book.id, {});
  const opf = await (await JSZip.loadAsync(await bytesOf(blob))).file('OEBPS/content.opf').async('string');
  assert.match(opf, new RegExp(`<dc:identifier id="pub-id">urn:grimoire:${encodeURIComponent(book.fingerprint).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</dc:identifier>`));
  const again = await epub.buildEpub(book.id, {});
  const opf2 = await (await JSZip.loadAsync(await bytesOf(again.blob))).file('OEBPS/content.opf').async('string');
  assert.equal(/<dc:identifier[^>]*>([^<]*)</.exec(opf)[1], /<dc:identifier[^>]*>([^<]*)</.exec(opf2)[1]);

  // Given back while the book is on the shelf: recognised, not added.
  const exported = new File([await bytesOf(blob)], 'The Salt Almanac.epub');
  const back = await library.importFiles([exported], {});
  assert.equal(back.added, 0, 'the export came in as a second copy');
  assert.equal(back.already, 1);
  assert.deepEqual(back.existing, [book.id]);

  // With the book in the Bin, the export takes its place -- and remembers
  // which book it is, so the original file is then the same book too.
  await library.binBooks([book.id]);
  const replaced = await library.importFiles([exported], {});
  assert.equal(replaced.added, 1);
  assert.equal(replaced.replaced, 1);
  const now = (await store.all('books')).filter((b) => b.sourceId === book.fingerprint);
  assert.equal(now.length, 1);
  const theOriginal = await library.importFiles([original], {});
  assert.equal(theOriginal.added, 0, 'the original file came in beside its own export');
  assert.equal(theOriginal.already, 1);
});

await t('a book called ".zip" is one book, on import and in Build -- not its pages', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const fixture = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  const before = (await store.all('books')).length;
  const out = await library.importFiles([new File([fixture], 'Renamed Almanac.zip')], {});
  assert.equal(out.added, 1, `a renamed EPUB came in as ${out.added} things`);
  const added = (await store.all('books')).filter((b) => b.title === 'The Salt Almanac').pop();
  assert.equal(added.format, 'EPUB');
  assert.equal((await store.all('books')).length, before + 1);
  build.clear();
  const parts = await build.add([new File([fixture], 'Renamed Almanac.epub.zip')]);
  assert.deepEqual(parts.map((p) => p.name), ['Renamed Almanac.epub']);
  build.clear();
});

await t('an archive saved over an older file gives back its own books, not the older one', async () => {
  const { zipWriter } = await import(new URL('../app/src/main/assets/www/js/zipwriter.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const JSZip = (await import('jszip')).default;
  const fixture = fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url));
  // An older, larger file: a book of many chapters.
  const old = new JSZip();
  old.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  for (let i = 1; i <= 40; i++) old.file(`OEBPS/text/ch${String(i).padStart(4, '0')}.xhtml`, `<p>${'Old words. '.repeat(400)}</p>`);
  const oldBytes = await old.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  // A newer, smaller export written over the start of it, the rest left behind.
  const parts = [];
  const zip = zipWriter((bytes) => { parts.push(Buffer.from(bytes)); });
  await zip.add('Overwritten Almanac.epub', new Blob([fixture]));
  await zip.finish();
  const fresh = Buffer.concat(parts);
  assert.ok(fresh.length < oldBytes.length);
  const damaged = Buffer.from(oldBytes);
  fresh.copy(damaged, 0);

  // Read from the front, as a file manager would: the new book, and none of
  // the old one's pages.
  const before = (await store.all('books')).filter((b) => /^ch\d{4}/.test(b.title)).length;
  const out = await library.importFiles([new File([damaged], 'Overwritten.zip')], {});
  assert.equal(out.recovered?.[0]?.books, 1, 'it was not read from the front');
  assert.equal(out.failed.length, 0, out.failed[0]?.reason);
  assert.equal((await store.all('books')).filter((b) => /^ch\d{4}/.test(b.title)).length, before,
    'the older file\'s pages came in as books');
  assert.match(app, /was damaged at the end, so its/);

  // Cut off partway, it gives back what is whole.
  const twoParts = [];
  const two = zipWriter((bytes) => { twoParts.push(Buffer.from(bytes)); });
  await two.add('First.epub', new Blob([fixture]));
  await two.add('Second.epub', new Blob([fixture]));
  await two.finish();
  const whole = Buffer.concat(twoParts);
  const zipreader = await import(new URL('../app/src/main/assets/www/js/zipreader.js', import.meta.url).href);
  const cut = await zipreader.openZip(new File([whole.subarray(0, whole.length - 500)], 'cut.zip'));
  assert.deepEqual(cut.names(), ['First.epub'], 'a book cut off partway was taken, or a whole one was lost');
  assert.equal(cut.recovered, true);

  // Nothing whole at all: refused, with the reason, rather than read as anything.
  const ruined = Buffer.from(oldBytes);
  ruined.fill(0, 0, 200);
  await assert.rejects(zipreader.openZip(new File([ruined], 'ruined.zip')), /damaged: its contents do not match its own index/);

  // And it is not made that way: the file is written over entirely, and checked.
  const java = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(java, /openOutputStream\(target, "wt"\)/);
  assert.ok(!/openOutputStream\(target\)\)/.test(java), 'still written with a mode that may not truncate');
  assert.match(java, /if \(written >= 0 && written != expected\)/);
  const saved = java.slice(java.indexOf('copyInto(target, source);'), java.indexOf('} catch (Throwable e) {', java.indexOf('copyInto(target, source);')));
  assert.match(saved, /exportSaved/, '"Saved" is said before the file is checked');
});

await t('a bundle of editions is one book in every count', async () => {
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
  const panels = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);
  // Start from an empty library, so the counts are only these.
  for (const b of await store.all('books')) await store.deleteBook(b.id);
  for (const e of await store.all('events')) await store.del('events', e.id);

  // One novel kept in Korean and in English, bundled; one book on its own;
  // one in the bin; one only opened from a file manager.
  const raw = await store.add('books', { title: 'Raw', lang: 'ko', folder: 'Novels', addedAt: 1 });
  const english = await store.add('books', { title: 'English', lang: 'en', folder: 'Novels', addedAt: 2, finishedAt: 5 });
  for (const id of [raw, english]) { const b = await store.get('books', id); b.bundleId = raw; await store.put('books', b); }
  const alone = await store.add('books', { title: 'Alone', lang: 'en', folder: 'Novels', addedAt: 3 });
  await store.add('books', { title: 'Binned', addedAt: 4, binnedAt: 9, finishedAt: 6, folder: 'Novels' });
  await store.add('books', { title: 'Passing', addedAt: 5, transient: true, folder: 'Novels' });
  // Read a little of both editions, and of the other book.
  for (const bookId of [raw, english, alone]) {
    await store.add('events', { bookId, day: store.dayKey(Date.now()), at: Date.now(), pages: 3, words: 900, activeMs: 60000, chapters: 1 });
  }

  assert.equal(library.countWorks(await store.all('books')), 4, 'the helper does not see the bundle');

  await panels.openStats();
  const stats = document.getElementById('stats-body').textContent;
  assert.match(stats, /2Books — in the library/, `the library is not two books: ${/\d+Books/.exec(stats)?.[0]}`);
  assert.match(stats, /1Finished/, 'finishing one edition is not finishing one book');
  assert.match(stats, /Books touched2of 2 on the shelf/, 'reading both editions counted as two books');
  assert.match(stats, /First book finished.*Earned/s);

  await panels.openFolders(() => {});
  assert.match(document.getElementById('folders-count').textContent, /1 folder · 2 books/);
  const novels = [...document.querySelectorAll('#folders-list .list-row')].find((r) => /Novels/.test(r.textContent));
  assert.equal(novels.querySelector('.trail').textContent, '2');

  // The Groups preview draws the shelf's way too.
  assert.match(read('app/src/main/assets/www/js/screens.js'), /groupBooks\(sortBooks\(collapseBundles\(all, draft\.group\), draft\.keys\), draft\.group\)/);
});

/* ── a file the page is not allowed to read ──────────────────────────────
 *
 * "The requested file could not be read, typically due to permission problems
 * that have occurred after a reference to a file was acquired." That is
 * Chromium's sentence, and on Android it means the renderer was refused the
 * file descriptor behind the content:// URI the picker handed over. This
 * process can almost always still read it, because the grant is held by the
 * activity rather than by the renderer.
 */

console.log('\na file the page cannot read');

const refusing = (name, size) => {
  const file = new window.File([], name, { type: 'application/zip' });
  Object.defineProperty(file, 'size', { value: size });
  const deny = () => {
    const error = new Error('The requested file could not be read, typically due to '
      + 'permission problems that have occurred after a reference to a file was acquired.');
    error.name = 'NotReadableError';
    throw error;
  };
  file.slice = deny;
  file.arrayBuffer = deny;
  file.stream = deny;
  file.text = deny;
  return file;
};

await t('the shell is asked to read it, and the import carries on', async () => {
  const fsMod = await import('node:fs');
  const bytes = fsMod.readFileSync(path.join(root, 'tests/fixtures/comic.cbz'));

  let asked = null;
  window.GrimoireNative = {
    stageForRead(stageId, name, size) {
      asked = { name, size };
      setTimeout(() => window.Grimoire.settleFile(stageId, true, 'handoff://rescued'), 20);
    },
  };
  globalThis.fetch = async (url) => ({
    ok: url === 'handoff://rescued',
    status: 200,
    blob: async () => new window.Blob([bytes], { type: 'application/zip' }),
  });

  const input = el('file-input');
  Object.defineProperty(input, 'files',
    { value: [refusing('rescued volume.zip', bytes.length)], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle(1500);

  assert.ok(asked, 'the page gave up without asking the shell');
  assert.equal(asked.name, 'rescued volume.zip');
  assert.equal(asked.size, bytes.length, 'the shell cannot tell which file to read');

  const book = (await store.all('books')).find((b) => b.title === 'rescued volume');
  assert.ok(book, 'the rescued file never reached the library');

  /* Cleared after the import, not before it. Clearing the input is also
   * letting go of what was picked, and reading a File afterwards is exactly
   * what comes back refused. */
  assert.equal(input.value, '');
  assert.equal(el('import-progress').hidden, true);
});

await t('when nothing can read it, the reason is one somebody can act on', async () => {
  window.GrimoireNative = {
    stageForRead(stageId) {
      setTimeout(() => window.Grimoire.settleFile(
        stageId, false, 'Android would not let the app read it either'), 20);
    },
  };

  const input = el('file-input');
  Object.defineProperty(input, 'files',
    { value: [refusing('lost cause.zip', 4096)], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle(1500);

  /* The refusal, not whatever the parser made of a file it never read.
   * Passed straight through, it failed again inside JSZip and reported
   * "corrupted zip" about a file that is not corrupt. */
  const said = el('toast').textContent;
  assert.match(said, /lost cause\.zip/);
  assert.match(said, /would not let the app read it/);
  assert.doesNotMatch(said, /[Cc]orrupt/);
});

await t('Chromium\'s own sentence is never what the person is shown', async () => {
  // Accurate and useless: it names no cause the person controls and suggests
  // nothing to do about it.
  const plain = app.slice(app.indexOf('function plainReason'), app.indexOf('function handleFiles'));
  assert.match(plain, /NotReadableError/);
  assert.match(plain, /copy it into a folder of your own/);
});

await t('the shell keeps what was picked, so there is something to retry with', async () => {
  /* The page is handed a File and never learns which URI it came from, so
   * without the URI kept on this side a refused read has nothing to retry. */
  assert.match(activity, /void stageForRead\(String id, String name, long size\)/);
  // Matched on name and size together, because a File carries nothing else
  // that identifies it -- and never by guessing.
  assert.match(activity, /name\.equals\(nameOf\(p\)\)/);
  assert.match(activity, /its == size\) return p\.uri/);
  /* Every pick kept, not only the latest. Clearing it on each pick lost the
   * files of an import still running when a second folder was chosen; and
   * a single-file pick was handed back for every request, so other files
   * were imported as copies of it. */
  assert.doesNotMatch(activity, /lastPicked\.clear\(\)/);
  assert.doesNotMatch(activity, /size\(\) == 1\) \{\s*found = /);
  assert.match(activity, /remember\(result\)/);
  // Copied on the staging thread: a bridge method blocks the page on its
  // return value, and a six-hundred-megabyte volume would stall the renderer.
  assert.match(activity, /staging\.execute/);

  const bridge = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.match(bridge, /public void stageForRead\(String id, String name, double size\)/);
});

/* ── the workshop sorts files the same way ───────────────────────────── */

console.log('\nthe workshop and chapter files');

const JSZipMod = (await import('jszip')).default;
const savedPage = (novel, n) => [
  'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="----B"', '', '------B',
  'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable',
  `Content-Location: https://s.example/${n}`, '',
  `<html><head><title>${novel} - Chapter ${n}</title></head><body><article><h1>Chapter ${n}</h1>`
    + `<p>Chapter ${n} of ${novel}.</p></article></body></html>`, '', '------B--',
].join('\r\n');

await t('a zip of three novels is three parts, not one run of all of them', async () => {
  /* It used to be one volume of every saved page in the zip, so three
   * novels came out as one book whose chapters ran from the first into the
   * third. */
  const zip = new JSZipMod();
  for (const novel of ['Alpha Tide', 'Beta Fen', 'Gamma Reach']) {
    for (let n = 1; n <= 3; n++) zip.file(`novels/${novel}/${novel} - Chapter ${n}.mht`, savedPage(novel, n));
  }
  build.clear();
  await build.add([new window.File([await zip.generateAsync({ type: 'nodebuffer' })], 'three.zip')]);
  assert.deepEqual(build.contents().map((p) => `${p.name}:${p.pages?.length}`),
    ['Alpha Tide:3', 'Beta Fen:3', 'Gamma Reach:3']);
  build.clear();
});

await t('loose chapters join, and keep their place among the volumes', async () => {
  build.clear();
  // Volume two came as saved pages; one and three as whole files.
  await build.add([
    new window.File(['CHAPTER ONE\n\nThree.\n'], 'Volume 3.txt'),
    new window.File([savedPage('Volume 2', 2)], 'Volume 2 - Chapter 2.mht'),
    new window.File(['CHAPTER ONE\n\nOne.\n'], 'Volume 1.txt'),
    new window.File([savedPage('Volume 2', 1)], 'Volume 2 - Chapter 1.mht'),
  ]);
  const parts = build.contents();
  assert.deepEqual(parts.map((p) => p.name), ['Volume 1.txt', 'Volume 2', 'Volume 3.txt'],
    'the joined chapters were moved out of their place in the series');
  assert.deepEqual(parts[1].pages.map((f) => f.name),
    ['Volume 2 - Chapter 1.mht', 'Volume 2 - Chapter 2.mht']);

  // And it builds.
  const { book } = await build.build({ title: 'Mid series' });
  assert.equal(book.chapters, 4);
  build.clear();
});

await t('an import of chapter files says Build can join them', async () => {
  // Imported as they came, as in September -- and the place that joins them
  // is named, rather than left to be discovered.
  assert.match(app, /came as \$\{run\.count\} chapter files/);
  assert.match(app, /Build can join them into one book/);
  // And nothing is checked up front any more: a rescue is offered, used only
  // when a read is actually refused.
  assert.match(app, /rescue: \(file\) => rescueFile\(file, done\)/);
  assert.ok(!/async function openable/.test(app), 'every file is still read before the import starts');
});

/* ── several operations at once ──────────────────────────────────────── */

console.log('\nseveral operations at once');

await t('two imports at once are two bars -- one running, one waiting -- and both results are shown', async () => {
  const pick = (files) => {
    Object.defineProperty(el('file-input'), 'files', { value: files, configurable: true });
    el('file-input').dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const novels = (prefix, count) => Array.from({ length: count }, (_, i) =>
    new window.File([`${prefix} ${i + 1}\n\nCHAPTER ONE\n\n${'Words run on. '.repeat(400)}\n`],
      `${prefix} ${String.fromCharCode(65 + (i % 26))}${i}.txt`));

  el('toast').hidden = true;      // whatever earlier tests left on it
  /* Everything the banner shows, as it shows it -- and whether it ever shows
   * both results at once. How far apart the two finish depends on the
   * machine, and a line that has run its time is meant to go. */
  const seen = new Set();
  let together = false;
  const watch = new window.MutationObserver(() => {
    const now = [...el('toast').querySelectorAll('.toast-line')].map((line) => line.textContent);
    for (const line of now) seen.add(line);
    if (now.some((l) => /30 books added/.test(l)) && now.some((l) => /20 books added/.test(l))) together = true;
  });
  watch.observe(el('toast'), { childList: true, subtree: true, characterData: true });

  /* When the second began, measured against when the first finished --
   * rather than by looking at the bars a fixed time later, which on a fast
   * machine finds both imports already done and proves nothing either way. */
  let firstDoneAt = null;
  let secondStartedAt = null;
  const order = new window.MutationObserver(() => {
    if (!firstDoneAt && [...seen].some((l) => /30 books added/.test(l))) firstDoneAt = performance.now();
    const reading = [...el('jobs').querySelectorAll('.job-label')].some((n) => /Reading Beta/.test(n.textContent));
    if (reading && !secondStartedAt) secondStartedAt = performance.now();
  });
  order.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Picked one straight after the other, so the second always arrives while
  // the first is running, however fast the machine.
  pick(novels('Alpha', 30));
  pick(novels('Beta', 20));

  /* At once: a row each. The first is under way; the second says it is
   * waiting for it, and how much it has waiting -- the two no longer run
   * side by side and break each other. */
  const rows = [...el('jobs').querySelectorAll('.job')];
  assert.equal(rows.length, 2, 'the two imports do not have a row each');
  const labels = rows.map((row) => row.querySelector('.job-label').textContent);
  assert.ok(/Waiting for the import before it/.test(labels[1]),
    `the second import did not wait for the first: ${labels.join(' / ')}`);
  assert.ok(!/Waiting/.test(labels[0]), `the first import is waiting on nothing: ${labels.join(' / ')}`);
  assert.match(rows[1].querySelector('.job-count').textContent, /20 files queued/,
    'the waiting import does not say what it is waiting with');
  for (const row of rows) assert.ok(row.querySelector('.bar-fill').style.width, 'a row has no bar');

  for (let i = 0; i < 120 && el('jobs').querySelectorAll('.job:not(.done):not(.failed)').length; i++) {
    await settle(100);
  }
  assert.ok([...el('jobs').querySelectorAll('.job')].every((row) => row.classList.contains('done')));

  // Both results, each marked finished -- and the second only begun once
  // the first was done.
  await settle(50);
  watch.disconnect();
  order.disconnect();
  assert.ok(firstDoneAt && secondStartedAt, 'the order of the two could not be seen');
  assert.ok(secondStartedAt >= firstDoneAt, 'the second import started before the first had finished');
  const said = [...seen];
  assert.ok(said.some((l) => /✓30 books added/.test(l)), `a result was never shown: ${said.join(' | ')}`);
  assert.ok(said.some((l) => /✓20 books added/.test(l)), `a result was never shown: ${said.join(' | ')}`);


  await settle(1200);
  assert.equal(el('import-progress').hidden, true, 'the panel stayed up after both finished');
});

await t('a second notice joins the first instead of replacing it', async () => {
  const screensMod = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);
  el('toast').hidden = true;
  screensMod.toast('Built “Witch City” — 40 chapters', 6000, { kind: 'done' });
  screensMod.toast('Divided into 3 parts', 6000, { kind: 'done' });
  const lines = [...el('toast').querySelectorAll('.toast-line')].map((line) => line.textContent);
  assert.deepEqual(lines, ['✓Built “Witch City” — 40 chapters', '✓Divided into 3 parts']);

  // Each line keeps its own time: a short one goes, a long one stays.
  el('toast').hidden = true;
  screensMod.toast('Brief', 120);
  screensMod.toast('Lasting', 4000, { kind: 'done' });
  await settle(300);
  assert.deepEqual([...el('toast').querySelectorAll('.toast-line')].map((l) => l.textContent), ['✓Lasting']);
});

await t('a notice repeated is counted, not stacked', async () => {
  const screensMod = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);
  el('toast').hidden = true;
  screensMod.toast('That is the last chapter');
  screensMod.toast('That is the last chapter');
  screensMod.toast('That is the last chapter');
  assert.equal(el('toast').textContent, 'That is the last chapter (×3)');
});

/* ── the choices in Behaviour ────────────────────────────────────────── */

console.log('\nthe choices in Behaviour');

await t('every choice is drawn as chosen once it is tapped', async () => {
  /* At the end of a chapter, Pictures and Colour pages in grey are lists of
   * choices that carried aria-pressed and nothing drew it: tapping one saved
   * it and changed nothing on screen, so they looked broken. */
  assert.match(css, /\.list-row\[aria-pressed="true"\] \{[^}]*background/);
  assert.match(css, /\.list-row\[aria-pressed\]::after/);
  assert.match(css, /\.list-row\[aria-pressed="true"\]::after/);

  const panelsMod = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);
  panelsMod.onSettingsChange(() => panelsMod.openSettings(() => {}));
  const body = await behaviourPane();

  for (const [section, choice, key, value] of [
    ['At the end of a chapter', 'Carry straight on', 'chapterOnEdge', 'immediate'],
    ['At the end of a chapter', 'Only the buttons', 'chapterOnEdge', 'buttons'],
    ['At the end of a chapter', 'Tap again to carry on', 'chapterOnEdge', 'confirm'],
    ['Pictures', 'Fit width', 'imageFit', 'width'],
    ['Pictures', 'Smart fit', 'imageFit', 'smart'],
    ['Pictures', 'Fit screen', 'imageFit', 'screen'],
  ]) {
    const block = () => [...body.querySelectorAll('section.block')]
      .find((b) => b.querySelector('h2')?.textContent === section);
    const button = [...block().querySelectorAll('button.list-row')].find((b) => b.textContent.includes(choice));
    assert.ok(button, `no "${choice}" in ${section}`);
    tap(button);
    await settle(200);

    assert.equal((await store.settings())[key], value, `"${choice}" was not saved`);
    const pressed = [...block().querySelectorAll('button.list-row[aria-pressed="true"]')]
      .map((b) => b.querySelector('b').textContent);
    assert.deepEqual(pressed, [choice], `after "${choice}", ${section} shows ${pressed.join(', ') || 'nothing'} as chosen`);
  }

  // And the grey choices, by whichever names they have.
  const grey = [...body.querySelectorAll('section.block')]
    .find((b) => /grey/i.test(b.querySelector('h2')?.textContent || ''));
  const options = [...grey.querySelectorAll('button.list-row')];
  assert.ok(options.length >= 3);
  tap(options[1]);
  await settle(200);
  const greyNow = [...body.querySelectorAll('section.block')]
    .find((b) => /grey/i.test(b.querySelector('h2')?.textContent || ''));
  assert.equal(greyNow.querySelectorAll('button.list-row[aria-pressed="true"]').length, 1);
  assert.notEqual((await store.settings()).greyscale, 'off');
  assert.equal(document.body.dataset.grey, (await store.settings()).greyscale, 'chosen but not applied');
  tap(greyNow.querySelectorAll('button.list-row')[0]);
  await settle(200);
});

await t('choosing something does not throw you back to the top of the pane', async () => {
  /* The pane is redrawn on every choice, and emptying it collapsed the
   * scroll: tap "Fit width" halfway down and you were back at Annotations,
   * never seeing the option change. */
  const panelsMod = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);
  const body = el('settings-body');
  // jsdom has no layout, so the browser's clamp is played here: emptied, a
  // scrolled box is back at the top.
  let top = 0;
  Object.defineProperty(body, 'scrollTop', { get: () => top, set: (v) => { top = v; }, configurable: true });
  const clamp = new window.MutationObserver(() => { if (!body.childElementCount) top = 0; });
  clamp.observe(body, { childList: true });

  await behaviourPane();
  body.scrollTop = 900;
  const fit = [...body.querySelectorAll('button.list-row')].find((b) => b.textContent.includes('Fit width'));
  tap(fit);
  await settle(250);
  assert.equal(body.scrollTop, 900, 'the pane jumped back to the top');

  // A different pane still opens at its top.
  tap([...el('settings-strip').children].find((b) => /^\s*Text/i.test(b.textContent)));
  await settle(250);
  assert.equal(body.scrollTop, 0);
  clamp.disconnect();
  delete body.scrollTop;
  await panelsMod.openSettings(() => {});
});

/* ── one import at a time ────────────────────────────────────────────── */

console.log('\none import at a time');

const queuedFile = (name, words) => new window.File([`${name.toUpperCase()}\n\n${words}\n`], `${name}.txt`);
const pickFiles = (files) => {
  const input = el('file-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const untilIdle = async () => {
  for (let i = 0; i < 200; i++) {
    await settle(100);
    if (el('import-progress').hidden) return;
  }
};
const shelfCount = async (pattern) => (await store.all('books')).filter((b) => pattern.test(b.fingerprint)).length;

await t('a second folder picked mid-import waits its turn instead of breaking the first', async () => {
  delete window.GrimoireNative;
  const first = Array.from({ length: 6 }, (_, i) => queuedFile(`queue first ${i + 1}`, `Text ${i}.`));
  const second = Array.from({ length: 4 }, (_, i) => queuedFile(`queue second ${i + 1}`, `More ${i}.`));
  pickFiles(first);
  pickFiles(second);
  const labels = [...document.querySelectorAll('#jobs .job-label')].map((n) => n.textContent);
  assert.ok(labels.some((l) => /Waiting for the import before it/.test(l)),
    `the second pick did not queue: ${labels.join(' | ')}`);
  await untilIdle();
  assert.equal(await shelfCount(/^queue first/), 6, 'the first import did not finish');
  assert.equal(await shelfCount(/^queue second/), 4, 'the second import did not run');
});

await t('picking the same folder again and again while it imports makes no duplicates', async () => {
  const folder = () => Array.from({ length: 5 }, (_, i) => queuedFile(`spam ${i + 1}`, `Same ${i}.`));
  for (let i = 0; i < 4; i++) { pickFiles(folder()); await settle(2); }
  await untilIdle();
  const books = (await store.all('books')).filter((b) => /^spam /.test(b.fingerprint));
  assert.equal(books.length, 5, `${books.length} books for 5 files`);
  assert.equal(new Set(books.map((b) => b.fingerprint)).size, 5);
});

await t('a copy from the shell that is not the same file is refused, not imported under its name', async () => {
  const fsMod = await import('node:fs');
  const bytes = fsMod.readFileSync(path.join(root, 'tests/fixtures/comic.cbz'));
  window.GrimoireNative = {
    stageForRead(stageId) {
      setTimeout(() => window.Grimoire.settleFile(stageId, true, 'handoff://somebody-else'), 10);
    },
  };
  // The shell hands back a different file -- the one picked most recently.
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    blob: async () => new window.Blob([bytes.subarray(0, bytes.length - 100)], { type: 'application/zip' }),
  });
  pickFiles([refusing('wanted volume.zip', bytes.length)]);
  await untilIdle();
  await settle(200);
  assert.equal((await store.all('books')).find((b) => b.title === 'wanted volume'), undefined,
    'another file was imported under this one\'s name');
  assert.match(el('toast').textContent, /wanted volume\.zip/);
  delete window.GrimoireNative;
});

/* ── blurred covers, kept ────────────────────────────────────────────── */

console.log('\nblurred covers, kept');

const storyFile = (name, words) => new window.File([`${name.toUpperCase()}\n\n${words}\n`], `${name}.txt`);
const byPrint = async (fingerprint) => (await store.byIndex('books', 'fingerprint', fingerprint))[0];
// Fingerprints are the file's name and size, as the importer makes them.
const VEILED = `veiled.txt:${storyFile('veiled', 'Behind a curtain.').size}`;
const OPEN = `open.txt:${storyFile('open', 'In plain sight.').size}`;
const LEAD = `lead.txt:${storyFile('lead', 'First edition.').size}`;
const FOLLOW = `follow.txt:${storyFile('follow', 'Second edition.').size}`;

await t('a backup restored before the books are imported still blurs them as they arrive', async () => {
  /* After a reinstall the obvious order is restore, then import -- and the
   * restore found no books, counted them all as missing, and dropped what it
   * held for them. The blurs were the first thing anyone noticed. */
  await library.importFiles([storyFile('veiled', 'Behind a curtain.'), storyFile('open', 'In plain sight.')], {});
  const veiled = await byPrint(VEILED);
  const open = await byPrint(OPEN);
  assert.ok(veiled && open, 'the two books did not import as expected');
  await library.blurCovers([veiled.id], true);
  veiled.folder = 'Private';
  veiled.status = 'reading';
  await store.put('books', { ...(await store.get('books', veiled.id)), folder: 'Private', status: 'reading' });
  await store.put('positions', { bookId: veiled.id, chapterIndex: 0, anchor: 5, percent: 0.4, pageInBook: 2, totalPages: 5 });
  await store.addMark({ bookId: veiled.id, kind: 'bookmark', chapterIndex: 0, anchor: 3, end: 3, at: 1 });

  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));

  // The reinstall: the books are gone.
  await store.deleteBook(veiled.id);
  await store.deleteBook(open.id);

  // Restore first.
  const report = await store.importBackup(backup);
  assert.ok(report.missing >= 2, 'the books were not counted as still to come');
  assert.ok(await store.pendingRestoreCount() >= 2, 'nothing was held for the books');

  // A backup made in the meantime does not lose what is being held.
  const between = await store.exportBackup();
  assert.ok(between.books.some((b) => b.fingerprint === VEILED && b.coverBlur),
    'a backup made while waiting dropped the blur');

  // Then import.
  const out = await library.importFiles([storyFile('veiled', 'Behind a curtain.'), storyFile('open', 'In plain sight.')], {});
  assert.equal(out.added, 2);
  assert.ok(out.restored >= 2, 'the import did not say it restored anything');

  const back = await byPrint(VEILED);
  assert.equal(back.coverBlur, true, 'the blur did not come back');
  assert.equal(back.folder, 'Private');
  assert.equal(back.status, 'reading');
  assert.equal((await store.get('positions', back.id))?.anchor, 5, 'the place in the book did not come back');
  assert.equal((await store.byIndex('marks', 'bookId', back.id)).length, 1, 'the bookmark did not come back');
  assert.ok(!(await byPrint(OPEN)).coverBlur, 'a cover that was never blurred came back blurred');
  assert.equal(await store.pendingRestoreCount(), 0, 'what was held was not let go');

  // And restoring it again changes nothing and doubles nothing.
  await store.importBackup(backup);
  assert.equal((await store.byIndex('marks', 'bookId', back.id)).length, 1);
  assert.equal((await byPrint(VEILED)).coverBlur, true);
});

await t('restoring with the books already there still works as it did', async () => {
  const [book] = (await store.all('books')).filter((b) => b.fingerprint === VEILED);
  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));
  await library.blurCovers([book.id], false);
  assert.ok(!(await store.get('books', book.id)).coverBlur);
  const report = await store.importBackup(backup);
  assert.equal(report.missing, 0);
  assert.equal((await store.get('books', book.id)).coverBlur, true);

  // A blur taken off after the backup was made: the backup is what comes back.
  const unblurred = JSON.parse(JSON.stringify(backup));
  delete unblurred.books.find((b) => b.fingerprint === VEILED).coverBlur;
  await store.importBackup(unblurred);
  assert.ok(!(await store.get('books', book.id)).coverBlur, 'a restore could not take a blur off');
});

await t('a bundle waiting on its leader is joined when the leader arrives', async () => {
  await library.importFiles([storyFile('lead', 'First edition.'), storyFile('follow', 'Second edition.')], {});
  const lead = await byPrint(LEAD);
  const follow = await byPrint(FOLLOW);
  assert.ok(lead && follow);
  await store.put('books', { ...lead, bundleId: lead.id });
  await store.put('books', { ...follow, bundleId: lead.id });
  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));
  await store.deleteBook(lead.id);
  await store.deleteBook(follow.id);
  await store.importBackup(backup);

  // The member first, the leader after it.
  await library.importFiles([storyFile('follow', 'Second edition.')], {});
  await library.importFiles([storyFile('lead', 'First edition.')], {});
  const newLead = await byPrint(LEAD);
  const newFollow = await byPrint(FOLLOW);
  assert.equal(newFollow.bundleId, newLead.id, 'the member was not joined to its leader');
  assert.equal(newLead.bundleId, newLead.id);
});

await t('a blurred book is blurred in Continue reading too', async () => {
  assert.match(css, /\.continue-card\[data-blur\] \.continue-cover img \{[^}]*filter: blur/);
  const lib = read('app/src/main/assets/www/js/library.js');
  assert.match(lib, /card\.toggleAttribute\('data-blur', !!book\.coverBlur\)/);

  // Drawn for real: the book read last is the blurred one.
  await import(new URL('../app/src/main/assets/www/js/app.js', import.meta.url).href);
  const book = await byPrint(VEILED);
  await library.blurCovers([book.id], true);
  await store.put('books', { ...(await store.get('books', book.id)), coverBlob: new window.Blob(['x'], { type: 'image/png' }), coverBytes: 1, lastOpenedAt: Date.now() + 1000 });
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'folders'));
  await settle();
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(400);
  const card = el('continue-card');
  assert.equal(card.hidden, false);
  assert.match(el('continue-title').textContent, /VEILED|veiled/i);
  assert.ok(card.hasAttribute('data-blur'), 'the blurred cover is shown plainly at the top of the shelf');
  assert.ok(el('continue-cover').querySelector('img'), 'the cover is not drawn as a picture that can be blurred');

  await library.blurCovers([book.id], false);
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'folders'));
  await settle();
  tap([...el('tabbar').children].find((b) => b.dataset.go === 'library'));
  await settle(400);
  assert.ok(!el('continue-card').hasAttribute('data-blur'), 'the blur stayed after the cover was shown again');
});

/* ── the picture frame ───────────────────────────────────────────────── */

console.log('\nthe picture frame');

const frames = await import(new URL('../app/src/main/assets/www/js/frame.js', import.meta.url).href);

await t('a preset is the largest frame of its shape the screen holds, centred', () => {
  const f = frames.presetFrame(2 / 3, 400, 800);
  const w = (f.r - f.l) * 400;
  const h = (f.b - f.t) * 800;
  assert.ok(Math.abs(w / h - 2 / 3) < 0.01, `shape ${w / h}`);
  assert.ok(Math.abs(f.l - (1 - f.r)) < 0.001 && Math.abs(f.t - (1 - f.b)) < 0.001, 'not centred');
  assert.ok(w <= 400 * 0.94 + 0.5 && h <= 800 * 0.94 + 0.5);
  assert.equal(frames.describe(f, 400, 800), '2:3');
  assert.equal(frames.describe(null, 400, 800), 'Whole page');
});

await t('a corner moves its two edges, an edge itself, the inside the whole frame -- never off the screen', () => {
  const f = { l: 0.1, t: 0.1, r: 0.9, b: 0.9 };
  assert.deepEqual(frames.dragFrame(f, 'tl', 0.05, 0.1), { l: 0.15, t: 0.2, r: 0.9, b: 0.9 });
  assert.deepEqual(frames.dragFrame(f, 'r', -0.2, 0.3), { l: 0.1, t: 0.1, r: 0.7, b: 0.9 });
  assert.deepEqual(frames.dragFrame(f, 'move', 0.5, -0.5), { l: 0.2, t: 0, r: 1, b: 0.8 });
  // Not inside out, and not smaller than the least it can be.
  const crushed = frames.dragFrame(f, 'br', -2, -2);
  assert.ok(crushed.r - crushed.l >= 0.15 - 1e-9 && crushed.b - crushed.t >= 0.15 - 1e-9);
  // What is under a finger.
  assert.equal(frames.partAt(f, 40, 80, 400, 800), 'tl');
  assert.equal(frames.partAt(f, 200, 80, 400, 800), 't');
  assert.equal(frames.partAt(f, 200, 400, 400, 800), 'move');
  assert.equal(frames.partAt(f, 5, 5, 400, 800), null);
});

const pointerAt = (type, x, y, id = 1) => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  return event;
};

await t('the frame is drawn by dragging its corners, over the whole screen', async () => {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const done = frames.editFrame({ l: 0.1, t: 0.1, r: 0.9, b: 0.9 });
  const editor = document.querySelector('.frame-edit');
  assert.ok(editor, 'no editor');
  assert.equal(editor.querySelectorAll('.frame-edit-svg .corner').length, 4, 'not four corners');
  assert.equal(editor.querySelectorAll('.frame-edit-svg .edge').length, 4);
  assert.ok(editor.querySelectorAll('.frame-edit [data-preset]').length >= 4, 'no shapes to start from');

  const svg = editor.querySelector('.frame-edit-svg');
  svg.dispatchEvent(pointerAt('pointerdown', 0.1 * W, 0.1 * H));
  assert.ok(editor.classList.contains('dragging'), 'the bar does not get out of the way');
  svg.dispatchEvent(pointerAt('pointermove', 0.2 * W, 0.3 * H));
  svg.dispatchEvent(pointerAt('pointerup', 0.2 * W, 0.3 * H));
  assert.ok(!editor.classList.contains('dragging'));
  tap(editor.querySelector('[data-act="save"]'));
  const frame = await done;
  assert.ok(Math.abs(frame.l - 0.2) < 0.001 && Math.abs(frame.t - 0.3) < 0.001, JSON.stringify(frame));
  assert.equal(frame.r, 0.9);
  assert.equal(document.querySelector('.frame-edit'), null, 'the editor stayed up');

  // Cancel changes nothing; Whole page is "no frame".
  const cancelled = frames.editFrame(frame);
  tap(document.querySelector('.frame-edit [data-act="cancel"]'));
  assert.equal(await cancelled, undefined);
  const none = frames.editFrame(frame);
  tap(document.querySelector('.frame-edit [data-act="none"]'));
  assert.equal(await none, null);
  // Back closes it.
  const backed = frames.editFrame(frame);
  assert.equal(window.Grimoire.onBack(), true);
  assert.equal(await backed, undefined);
});

await t('every picture gets a box of the frame\'s size, where the frame was drawn', async () => {
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);
  const viewport = el('page-viewport');
  const flow = el('page-flow');
  const W = window.innerWidth;
  const H = window.innerHeight;
  viewport.getBoundingClientRect = () => ({ left: 0, top: 50, right: W, bottom: H - 100, width: W, height: H - 150 });
  const pad = (side) => parseFloat(getComputedStyle(viewport)[side] || 0) || 0;
  const roomTop = 50 + pad('paddingTop');
  const roomBottom = H - 100 - pad('paddingBottom');
  reader.setPictureFrame({ l: 0.25, t: 0.2, r: 0.75, b: 0.7 });
  assert.ok(document.body.hasAttribute('data-frame'));
  const top = Math.max(roomTop, 0.2 * H);
  const bottom = Math.min(roomBottom, 0.7 * H);
  assert.equal(flow.style.getPropertyValue('--pic-w'), `${Math.floor(0.75 * W - 0.25 * W)}px`);
  assert.equal(flow.style.getPropertyValue('--pic-x'), `${Math.round(0.25 * W - pad('paddingLeft'))}px`);
  assert.equal(flow.style.getPropertyValue('--pic-y'), `${Math.round(top - roomTop)}px`);
  assert.equal(flow.style.getPropertyValue('--pic-h'), `${Math.floor(bottom - top)}px`);
  // More than the page can show -- running under the bars -- it is shrunk to
  // fit rather than cut down, so it keeps the shape that was drawn.
  reader.setPictureFrame({ l: 0, t: 0, r: 1, b: 1 });
  const scale = (roomBottom - roomTop) / H;
  assert.equal(flow.style.getPropertyValue('--pic-y'), '0px');
  assert.equal(flow.style.getPropertyValue('--pic-h'), `${Math.floor(roomBottom - roomTop)}px`);
  assert.equal(flow.style.getPropertyValue('--pic-w'), `${Math.floor(W * scale)}px`);
  assert.equal(flow.style.getPropertyValue('--pic-x'), `${Math.round((W - W * scale) / 2 - pad('paddingLeft'))}px`);
  const shown = parseFloat(flow.style.getPropertyValue('--pic-w')) / parseFloat(flow.style.getPropertyValue('--pic-h'));
  assert.ok(Math.abs(shown - W / H) < 0.01, `the frame changed shape to fit: ${shown} for ${W / H}`);
  // None at all: the pictures use the page as before.
  reader.setPictureFrame(null);
  assert.ok(!document.body.hasAttribute('data-frame'));
  assert.equal(flow.style.getPropertyValue('--pic-w'), '');
  delete viewport.getBoundingClientRect;

  assert.match(css, /body\[data-frame\] \.page-flow \.pic:not\(\.small\) \{[^}]*width: var\(--pic-w\); height: var\(--pic-h\)/);
  assert.match(css, /body\[data-frame\]\[data-mode="paged"\] \.page-flow \.pic:not\(\.small\) \{[^}]*break-before: column/);
  assert.match(css, /body\[data-frame\]\[data-images="fill"\] \.page-flow \.pic:not\(\.small\) img \{ object-fit: cover; \}/);
});

await t('a picture in a figure, a quote or a list still lands on the frame, with no empty page before it', async () => {
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);
  const flow = el('page-flow');
  const viewport = el('page-viewport');
  viewport.getBoundingClientRect = () => ({ left: 0, top: 50, right: 400, bottom: 750, width: 400, height: 700 });
  const keep = [...flow.childNodes];
  flow.innerHTML = '<section class="chapter"><p>Words.</p>'
    + '<figure style="margin: 16px 40px"><span class="pic" id="in-figure"><img alt=""></span><figcaption>Caption</figcaption></figure>'
    + '<blockquote style="margin: 0; padding-left: 12px; border-left: 2px solid"><p>Quoted.</p><span class="pic" id="in-quote"><img alt=""></span></blockquote>'
    + '<p>Before <span class="pic small in-text" id="emoji"><img alt=""></span> after.</p></section>';
  try {
    reader.setPictureFrame({ l: 0.1, t: 0.1, r: 0.9, b: 0.9 });
    const figure = flow.querySelector('figure');
    // The figure's indent is taken back off, so the box sits where the frame is.
    assert.equal(document.getElementById('in-figure').style.getPropertyValue('--pic-in'), '40px');
    assert.equal(document.getElementById('in-quote').style.getPropertyValue('--pic-in'), '14px');
    // The figure opens with its picture, so it gives up its top spacing; the
    // quote and the chapter do not, since words come first in both.
    assert.ok(figure.classList.contains('pic-lead'), 'the figure keeps a margin that pushes its picture a page on');
    assert.ok(!flow.querySelector('blockquote').classList.contains('pic-lead'));
    assert.ok(!flow.querySelector('section').classList.contains('pic-lead'));
    // A picture small enough to sit in a sentence is not framed, so leads nothing.
    assert.ok(!flow.querySelectorAll('p')[2].classList.contains('pic-lead'));
    // No frame: nothing is marked.
    reader.setPictureFrame(null);
    reader.setPictureFrame({ l: 0.1, t: 0.1, r: 0.9, b: 0.9 });
    document.getElementById('in-figure').classList.add('small');
    reader.setPictureFrame({ l: 0.1, t: 0.1, r: 0.9, b: 0.8 });
    assert.ok(!figure.classList.contains('pic-lead'), 'an ornament took the figure\'s spacing away');
  } finally {
    reader.setPictureFrame(null);
    flow.replaceChildren(...keep);
    delete viewport.getBoundingClientRect;
  }
  // Moved into place, not pushed there by margins -- a margin before a page
  // break is what left a blank page in front of every framed picture.
  assert.match(css, /body\[data-frame\] \.page-flow \.pic:not\(\.small\) \{[^}]*margin: 0;[^}]*position: relative;[^}]*left: calc\(var\(--pic-x, 0px\) - var\(--pic-in, 0px\)\);[^}]*top: var\(--pic-y, 0px\)/);
  assert.match(css, /body\[data-frame\]\[data-mode="paged"\] \.page-flow \.pic-lead \{[^}]*margin-top: 0/);
  assert.match(css, /\.page-flow \.pic\.small\.in-text \{[^}]*display: inline-block/);
  const readerSource = fs.readFileSync(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url), 'utf8');
  assert.match(readerSource, /Math\.min\(w, h\) < 100/, 'a thin divider would be given a page of its own');
});

await t('a picture drawn through SVG comes in as a picture', async () => {
  const JSZip = (await import('jszip')).default;
  const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/c.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Plates</dc:title></metadata><manifest>'
    + '<item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="p" href="img/plate.png" media-type="image/png"/><item id="q" href="img/plain.png" media-type="image/png"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
  // A page that is only an SVG-wrapped picture, and one with words and both kinds.
  zip.file('OEBPS/text/a.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><body><div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image width="10" height="10" xlink:href="../img/plate.png"/></svg></div></body></html>');
  zip.file('OEBPS/text/b.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Words.</p><img src="../img/plain.png" alt=""/><svg xmlns="http://www.w3.org/2000/svg"><image href="../img/plate.png"/></svg></body></html>');
  zip.file('OEBPS/img/plate.png', PNG);
  zip.file('OEBPS/img/plain.png', PNG);
  const book = await parse.parse(new File([await zip.generateAsync({ type: 'nodebuffer' })], 'plates.epub'));
  assert.equal(book.chapters.length, 2, 'the page that is only a picture was dropped');
  assert.deepEqual(book.images.map((i) => i.href).sort(), ['OEBPS/img/plain.png', 'OEBPS/img/plate.png']);
  assert.match(parse.chapterHtml(book.chapters[0]), /^<div><img data-img="OEBPS\/img\/plate\.png"><\/div>$/);
  const second = parse.chapterHtml(book.chapters[1]);
  assert.match(second, /data-img="OEBPS\/img\/plain\.png"/);
  assert.match(second, /data-img="OEBPS\/img\/plate\.png"/);
  assert.ok(!/<svg|<image/i.test(second), 'SVG got through the sanitiser');
});

await t('the frame belongs to the glass: turned with the screen, same shape, same place', async () => {
  // Drawn upright: a 2:3 frame in the upper-left of the phone.
  const upright = { l: 0.1, t: 0.1, r: 0.6, b: 0.5 };
  assert.deepEqual(frames.toScreen(upright, 0), upright);
  // Screen turned anticlockwise (top of the phone to the left): the phone's
  // top-left corner is now bottom-left, and the frame runs across, not down.
  assert.deepEqual(frames.toScreen(upright, 90), { l: 0.1, t: 0.4, r: 0.5, b: 0.9 });
  // Clockwise (top to the right): the same corner is now top-right.
  assert.deepEqual(frames.toScreen(upright, 270), { l: 0.5, t: 0.1, r: 0.9, b: 0.6 });
  assert.deepEqual(frames.toScreen(upright, 180), { l: 0.4, t: 0.5, r: 0.9, b: 0.9 });
  // And back: whatever way it is drawn, it is kept upright.
  for (const turn of [0, 90, 180, 270]) {
    assert.deepEqual(frames.toUpright(frames.toScreen(upright, turn), turn), upright);
  }
  // On a phone (393 x 851 upright, 851 x 393 sideways) the shape survives the
  // turn: a tall frame upright is the same frame lying down.
  const W = 393; const H = 851;
  const tall = frames.presetFrame(2 / 3, W, H);
  const lying = frames.toScreen(tall, 90);
  const ratio = ((lying.r - lying.l) * H) / ((lying.b - lying.t) * W);
  assert.ok(Math.abs(ratio - 3 / 2) < 0.01, `the frame changed shape when turned: ${ratio}`);
  // The turn is what the screen reports -- the rotation the phone has
  // actually made, not how it is being held. Rotation lock means no turn.
  const real = Object.getOwnPropertyDescriptor(window.screen, 'orientation');
  try {
    Object.defineProperty(window.screen, 'orientation', { configurable: true, value: { angle: 270 } });
    assert.equal(frames.screenTurn(), 270);
    Object.defineProperty(window.screen, 'orientation', { configurable: true, value: { angle: 0 } });
    assert.equal(frames.screenTurn(), 0);
  } finally {
    if (real) Object.defineProperty(window.screen, 'orientation', real);
    else delete window.screen.orientation;
  }
  const source = fs.readFileSync(new URL('../app/src/main/assets/www/js/frame.js', import.meta.url), 'utf8');
  assert.ok(!/deviceorientation|devicemotion/i.test(source), 'the frame follows the sensors, not the screen');
  const readerSource = fs.readFileSync(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url), 'utf8');
  assert.match(readerSource, /const frame = frames\.toScreen\(pictureFrame, turn\)/);
});

await t('the editor draws the frame as the screen runs now and keeps it upright', async () => {
  const real = Object.getOwnPropertyDescriptor(window.screen, 'orientation');
  Object.defineProperty(window.screen, 'orientation', { configurable: true, value: { angle: 90 } });
  try {
    const upright = { l: 0.1, t: 0.1, r: 0.6, b: 0.5 };
    const editing = frames.editFrame(upright);
    // Shown turned...
    const outline = document.querySelector('.frame-edit-svg .outline');
    const W = window.innerWidth; const H = window.innerHeight;
    assert.equal(+outline.getAttribute('x'), 0.1 * W);
    assert.equal(+outline.getAttribute('y'), 0.4 * H);
    // ...and saved upright again, unchanged, with its exact shape.
    document.querySelector('.frame-edit [data-act="save"]').click();
    const saved = await editing;
    assert.deepEqual({ l: saved.l, t: saved.t, r: saved.r, b: saved.b }, upright);
    assert.equal(saved.ratio, frames.shapeOf(frames.toScreen(upright, 90), W, H, 90));
  } finally {
    if (real) Object.defineProperty(window.screen, 'orientation', real);
    else delete window.screen.orientation;
  }
});

await t('16:9 drawn sideways is exactly 9:16 upright -- the corners stay the corners of the shape', async () => {
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);
  const real = Object.getOwnPropertyDescriptor(window.screen, 'orientation');
  const realW = window.innerWidth; const realH = window.innerHeight;
  const size = (w, h) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  };
  const viewport = el('page-viewport');
  const flow = el('page-flow');
  try {
    // Sideways, with the navigation bar at the side: 805 x 393, not 851 x 393.
    Object.defineProperty(window.screen, 'orientation', { configurable: true, value: { angle: 90 } });
    size(805, 393);
    const editing = frames.editFrame(null);
    document.querySelector('.frame-edit [data-preset="16:9"]').click();
    assert.match(document.querySelector('.frame-edit-caption').textContent, /16:9/);
    document.querySelector('.frame-edit [data-act="save"]').click();
    const saved = await editing;
    assert.ok(Math.abs(saved.ratio - 9 / 16) < 0.001, `kept as ${saved.ratio}, not 9:16 upright`);

    // Upright again, a little taller than the sideways screen was wide.
    Object.defineProperty(window.screen, 'orientation', { configurable: true, value: { angle: 0 } });
    size(393, 851);
    assert.equal(frames.describeKept(saved), '9:16');
    assert.equal(frames.describeKept(saved, 90), '16:9');
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 393, bottom: 851, width: 393, height: 851 });
    reader.setPictureFrame(saved);
    const w = parseFloat(flow.style.getPropertyValue('--pic-w'));
    const h = parseFloat(flow.style.getPropertyValue('--pic-h'));
    assert.ok(Math.abs(w / h - 9 / 16) < 0.01, `upright it is ${w} x ${h}, not 9:16`);
    // And the turned preset is named that way round in Settings.
    assert.equal(frames.describe({ l: 0, t: 0, r: 1, b: 1 }, 1600, 900), '16:9');
    assert.equal(frames.describe({ l: 0, t: 0, r: 1, b: 1 }, 900, 1600), '9:16');
    assert.equal(frames.describe({ l: 0, t: 0, r: 1, b: 1 }, 1500, 1000), '3:2');
  } finally {
    reader.setPictureFrame(null);
    delete viewport.getBoundingClientRect;
    size(realW, realH);
    if (real) Object.defineProperty(window.screen, 'orientation', real);
    else delete window.screen.orientation;
  }
});

await t('Settings offers the frame, and Fill, beside the other fittings', async () => {
  const pane = await behaviourPane();
  assert.match(pane.textContent, /Picture frame/);
  assert.match(pane.textContent, /Fill/);
  assert.ok(pane.querySelector('#picture-frame-edit'), 'nothing to draw the frame with');
  const defaults = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  assert.equal(defaults.DEFAULT_SETTINGS.pictureFrame, null);
});

console.log(`\n${pass} assertions passed`);
