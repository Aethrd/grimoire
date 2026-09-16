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

await (async () => {
  /* Showing or hiding the chrome re-flows the text, and for a frame or two
   * the flow has no width. Measured then, a chapter of forty pages comes back
   * as one, and the position -- clamped to what exists -- lands on page one.
   * A tap in the middle of the screen did that every time. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?chrome`);

  const id = await store.add('books', { title: 'Chrome', fingerprint: 'chr', addedAt: 1 });
  for (let i = 0; i < 3; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Ch ${i}`, words: 400,
      html: Array.from({ length: 40 }, (_, p) => `<p>Chapter ${i} paragraph ${p}.</p>`).join(''),
    });
  }

  reader.init({ onChange() {} });
  await reader.open(id);

  await t('toggling the chrome does not move the reader', async () => {
    await reader.setMode('paged');
    // A measured page count, and nothing measurable afterwards — which is the
    // state a page is in while the chrome animates.
    reader.state.pageCount = 12;
    reader.goToPage(7);
    assert.equal(reader.state.page, 7);

    for (let tap = 0; tap < 3; tap++) {
      reader.cycleChrome();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(reader.state.page, 7, `a tap moved the reader to page ${reader.state.page}`);
      assert.equal(reader.state.pageCount, 12, 'the page count was thrown away');
    }
  });

  await t('an unmeasurable page is not page one', () => {
    // Null rather than zero, and the difference is the whole bug: every
    // caller took "could not measure" as "the beginning".
    const source = read('app/src/main/assets/www/js/reader.js');
    assert.match(source, /function pageAtAnchor[\s\S]{0,900}return null;/);
    assert.match(source, /pageAtAnchor\(anchor, chapter\) \?\? state\.page/);
    // A chapter being opened does start at its beginning; a re-flow does not.
    assert.match(source, /pageAtAnchor\(anchor\) \?\? 0/);
    assert.match(source, /if \(width <= 0\) return;/);
  });
})();

await (async () => {
  /* Position is kept as a character offset into the chapter, which is right
   * for prose and meaningless for a comic: every page is offset zero, so a
   * book of pictures always reopened at its first page however far through it
   * you were. */
  const JSZip = (await import('jszip')).default;
  globalThis.JSZip = JSZip;
  window.JSZip = JSZip;

  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const build = await import(new URL('../app/src/main/assets/www/js/build.js', import.meta.url).href);
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?pictures`);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const chapter = async (n) => {
    const zip = new JSZip();
    for (let page = 1; page <= 8; page++) {
      zip.file(`${String(page).padStart(3, '0')}.png`, png);
    }
    return new File([await zip.generateAsync({ type: 'nodebuffer' })], `Chapter ${n}.zip`);
  };

  build.clear();
  await build.add([await chapter(1), await chapter(2), await chapter(3)]);
  const { book } = await build.build({ title: 'Pictures' });

  reader.init({ onChange() {} });

  await t('a book of pictures is measured in pictures', async () => {
    /* The estimate works from word counts, and a comic has none -- so every
     * chapter counted as one page, the total came to less than the page being
     * read, and the percentage saturated at a hundred before the first page
     * was turned. */
    await reader.open(book.id);
    assert.ok(reader.state.totalPages > 3,
      `a three-chapter comic totalled ${reader.state.totalPages} pages`);
    assert.ok(reader.percent() < 0.5, `it opened at ${Math.round(reader.percent() * 100)}%`);
  });

  await t('a book of pictures reopens where it was left', async () => {
    await reader.goTo({ chapter: 1, anchor: 0 });
    reader.state.pageCount = 8;
    reader.goToPage(5);
    await new Promise((r) => setTimeout(r, 150));
    await reader.pauseSession();

    const saved = await store.get('positions', book.id);
    assert.equal(saved.chapterIndex, 1);
    assert.equal(saved.page, 5);

    await reader.open(book.id);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(reader.state.chapterIndex, 1);
    assert.equal(reader.state.page, 5, `it reopened on page ${reader.state.page}`);
  });
})();

await (async () => {
  /* A page is one column of a fixed width and the viewport clips what leaves
   * it. Fit height, Original and Smart all allow a picture to be wider than
   * that -- the point of them, and fine in scroll mode where the flow can
   * scroll sideways. In paged mode the overflow is cut off and the picture
   * disappears entirely rather than partly, so the mode looks broken. */
  const css = fs.readFileSync(
    new URL('../app/src/main/assets/www/css/app.css', import.meta.url), 'utf8');

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const picture = document.createElement('img');
  document.getElementById('page-flow').appendChild(picture);

  const fitted = (mode, fit, className = '') => {
    document.body.dataset.mode = mode;
    document.body.dataset.images = fit;
    picture.className = className;
    const computed = window.getComputedStyle(picture);
    return { maxWidth: computed.maxWidth, maxHeight: computed.maxHeight };
  };

  await t('no picture can escape the page in paged mode', () => {
    for (const fit of ['screen', 'width', 'height', 'stretch', 'original', 'smart']) {
      const { maxWidth, maxHeight } = fitted('paged', fit);
      assert.equal(maxWidth, '100%', `${fit} lets a picture out of the column`);
      assert.equal(maxHeight, '88vh', `${fit} lets a picture past the screen`);
    }
    // Including the shapes smart fitting singles out.
    for (const shape of ['landscape', 'tall']) {
      assert.equal(fitted('paged', 'smart', shape).maxWidth, '100%', shape);
    }
  });

  await t('colour pages can be shown in grey, and put back', () => {
    /* CSS grayscale() is the luminance conversion worth having: the
     * specification defines it with the same coefficients (0.2126 R, 0.7152 G,
     * 0.0722 B), so this is not a naive desaturation. What it does not do is
     * replace the contrast that was carried by hue -- hence the later
     * settings. */
    const greyed = (mode) => {
      document.body.dataset.grey = mode;
      document.body.dataset.mode = 'paged';
      document.body.dataset.images = 'screen';
      return window.getComputedStyle(picture).filter || 'none';
    };

    assert.equal(greyed('off'), 'none');

    /* The conversion itself is a filter now, not CSS grayscale(), because
     * which conversion to use is measured per book: luminance is the default
     * and the wrong answer often enough to matter. */
    assert.match(greyed('plain'), /url\(#greymix\)/);

    // Contrast lifted, because grey alone flattens a coloured page.
    assert.match(greyed('contrast'), /url\(#greymix\) contrast\(/);

    /* And the edges put back, greying first: sharpening in colour exaggerates
     * chroma noise the greying would then average away. */
    const crisp = greyed('crisp');
    assert.match(crisp, /^url\(#greymix\)/);
    assert.match(crisp, /url\(#crisp\)$/);

    document.body.dataset.grey = 'off';
  });

  await t('the e-ink preset uses every level the panel has', () => {
    /* Raising contrast linearly clips both ends, and on sixteen levels losing
     * three to black is a fifth of the range. The preset sets a black and a
     * white point instead, lifts the midtones, and picks the sixteen levels
     * itself rather than letting the panel dither them. */
    document.body.dataset.grey = 'eink';
    assert.match(window.getComputedStyle(picture).filter, /url\(#eink\)/);

    const html = read('app/src/main/assets/www/index.html');
    const filter = html.slice(html.indexOf('<filter id="eink"'), html.indexOf('</filter>', html.indexOf('<filter id="eink"')));

    // The measured conversion, then levels, then gamma, then sixteen bands.
    assert.match(filter, /feColorMatrix id="eink-matrix" type="matrix"/);
    assert.match(filter, /type="linear" slope="1\.30" intercept="-0\.14"/);
    assert.match(filter, /type="gamma" exponent="0\.82"/);
    assert.equal((filter.match(/type="discrete"/g) || []).length, 3);

    const table = /tableValues="([^"]+)"/.exec(filter)[1].split(' ');
    assert.equal(table.length, 16, 'not sixteen levels');
    assert.equal(table[0], '0');
    assert.equal(table[15], '1');

    /* No sharpening: a halo is subtle at 256 levels and obvious at sixteen,
     * and it lingers in the ghosting of the next page. */
    assert.ok(!/feConvolveMatrix/.test(filter), 'the e-ink preset sharpens');

    document.body.dataset.grey = 'off';
  });

  await t('every fitting mode does something different in paged mode', () => {
    /* A page is one column with the overflow hidden, so Original, Fit height
     * and Smart had to be clamped back to Fit screen there -- four of the six
     * settings doing the same thing. Each picture has a box of its own now
     * that can scroll, so it can exceed the page and still be reachable. */
    const box = document.createElement('span');
    box.className = 'pic';
    const inner = document.createElement('img');
    box.appendChild(inner);
    document.getElementById('page-flow').appendChild(box);

    const shapeOf = (fit) => {
      document.body.dataset.mode = 'paged';
      document.body.dataset.images = fit;
      const outside = window.getComputedStyle(box);
      const picture = window.getComputedStyle(inner);
      return [outside.overflow, picture.maxWidth, picture.maxHeight, picture.height].join('/');
    };

    const shapes = ['screen', 'width', 'height', 'stretch', 'original', 'smart'].map(shapeOf);
    // The three that need room say so by scrolling their box.
    assert.equal(shapeOf('original').split('/')[0], 'auto');
    assert.equal(shapeOf('height').split('/')[0], 'auto');
    assert.equal(shapeOf('smart').split('/')[0], 'auto');
    // And Original is no longer indistinguishable from Fit screen.
    assert.notEqual(shapeOf('original'), shapeOf('screen'));
    assert.notEqual(shapeOf('height'), shapeOf('screen'));

    // At least five genuinely different results out of six.
    assert.ok(new Set(shapes).size >= 5, `only ${new Set(shapes).size} distinct modes`);

    box.remove();
    document.body.dataset.images = 'screen';
  });

  await t('scroll mode still lets a picture run off the side', () => {
    // Which is what makes Fit height and Original worth having.
    for (const fit of ['height', 'original']) {
      assert.equal(fitted('scroll', fit).maxWidth, 'none', fit);
    }
  });

  style.remove();
  picture.remove();
})();

await (async () => {
  /* Opening a book must not throw.
   *
   * A function was called that had never been defined -- an edit that looked
   * applied but matched nothing. Every book failed to open, and nothing
   * caught it: a syntax check passes on a name that does not exist, and no
   * test opened a book through the shell.
   */
  const fs2 = await import('node:fs');
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

  await library.importFiles([new File(
    [fs2.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))],
    'Opens.epub')], {});

  await import(`${new URL('../app/src/main/assets/www/js/app.js', import.meta.url).href}?open`);
  await new Promise((r) => setTimeout(r, 300));

  await t('tapping a book opens it', async () => {
    const tile = document.querySelector('#shelf .tile');
    assert.ok(tile, 'nothing on the shelf to tap');
    tile.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));

    assert.equal(document.body.dataset.view, 'reader', 'the book did not open');
    assert.ok((document.getElementById('page-flow').textContent || '').trim().length > 0,
      'the reader opened empty');
  });

  await t('the grey conversion is settled for whatever opened the book', async () => {
    /* There are several ways in -- a tile, a bundle, a search result, a file
     * handed over from another app -- so this hangs off the repaint rather
     * than off one of them. */
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(document.body.dataset.greyMix, 'no conversion was chosen');

    const app = read('app/src/main/assets/www/js/app.js');
    assert.match(app, /function paintReader\(\)[\s\S]{0,160}settleGreyMix\(state\.book\)/);
    // Defined, not merely called.
    assert.match(app, /function settleGreyMix\(book\) \{/);
  });
})();

await (async () => {
  /* Leaving a book in scroll mode used to record the top of the chapter.
   *
   * A hidden element has no layout and reports a scroll position of zero, and
   * in scroll mode the reading position is derived from exactly that. The
   * screen was hidden first and the position saved afterwards. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(
    `${new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href}?leaving`);

  const id = await store.add('books', { title: 'Leaving', fingerprint: 'leaving', addedAt: 1, words: 900 });
  for (let i = 0; i < 3; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Ch ${i}`, words: 300,
      html: Array.from({ length: 60 }, (_, p) => `<p>Chapter ${i} paragraph ${p}.</p>`).join(''),
    });
  }

  reader.init({ onChange() {} });
  await reader.open(id);
  await reader.setMode('scroll');

  const viewport = document.getElementById('page-viewport');
  let laidOut = 700;
  let top = 0;
  Object.defineProperty(viewport, 'clientHeight', { get: () => laidOut, configurable: true });
  Object.defineProperty(viewport, 'scrollTop',
    { get: () => top, set: (v) => { top = v; }, configurable: true });

  await t('the position is taken before the screen is taken away', async () => {
    viewport.scrollTop = 4200;
    reader.holdPosition();
    await reader.pauseSession();

    const saved = await store.get('positions', id);
    assert.ok(saved.page > 0, `it saved page ${saved.page}`);
    assert.equal(saved.chapterIndex, 1);
  });

  await t('a scroll arriving after the screen is hidden changes nothing', async () => {
    const before = await store.get('positions', id);

    // What leaving mid-scroll does: the settle lands once there is no layout.
    laidOut = 0;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 300));
    reader.holdPosition();
    await reader.pauseSession();

    const after = await store.get('positions', id);
    assert.equal(after.page, before.page, `it moved to page ${after.page}`);
    assert.equal(after.chapterIndex, before.chapterIndex);

    laidOut = 700;
  });

  await t('in scroll mode a tap only ever toggles the chrome', () => {
    /* A side tap used to jump a screenful, which fights the thing scroll mode
     * is for: the text is already moving under your thumb. Two mechanisms
     * driving the same axis. */
    const app = read('app/src/main/assets/www/js/app.js');
    assert.match(app, /if \(middle \|\| reader\.state\.mode === 'scroll'\)/);
    // And the setting says so, rather than promising something it does not do.
    const panels = read('app/src/main/assets/www/js/panels.js');
    assert.match(panels, /Paged mode only: in scroll mode a tap toggles the chrome/);
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
