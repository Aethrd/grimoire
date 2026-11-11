/* App shell: routing, gestures, and the two hooks MainActivity calls. */

import * as store from './store.js';
import * as theme from './theme.js';
import * as reader from './reader.js';
import * as library from './library.js';
import * as screens from './screens.js';
import * as panels from './panels.js';
import { nameWithFormat, chapterHtml, plainTextOf } from './parse.js';
import * as glossary from './glossary.js';
import * as build from './build.js';
import * as epub from './epub.js';
import * as trim from './trim.js';
import * as covers from './coverpage.js';
import { zipWriter } from './zipwriter.js';
import { pictureType, pictureName } from './picturesave.js';
import * as tags from './tags.js';
import * as shrink from './shrink.js';
import * as translate from './translate.js';
import * as blobs from './blobs.js';
import * as redact from './redact.js';
import * as frames from './frame.js';
import * as web from './web.js';
import * as ocr from './ocr.js';
import * as ocrEval from './ocr-eval.js';

const el = (id) => document.getElementById(id);
const { toast } = screens;

/* ── routing ──────────────────────────────────────────────────────────── */

const stack = ['library'];
let current = 'library';

function screenNode(name) {
  // Scoped to the container on purpose. This used to be a bare
  // document.querySelector, and the moment <body> gained a data-screen
  // attribute of its own it started matching that instead -- so the real
  // section was never switched off and screens piled up on top of each other.
  return document.getElementById('screens').querySelector(`[data-screen="${name}"]`);
}

/* ── what finishes while you read ─────────────────────────────────────
 *
 * Imports, builds and exports run on while you do something else, and that
 * something is often reading. Finishing used to break in on it: a build
 * opened the book it had made in place of the one being read, an import's
 * summary sat over the text, and an export brought up Android's save screen
 * mid-page. Now, while a book is open -- the reader, or one of its own
 * screens such as the index -- what was started elsewhere keeps its news and
 * its save screen until the book is put down. What was started from inside
 * the book still answers straight away: that was asked for there. */
let inBook = false;
const held = [];

function viewChanged() {
  if (current === 'reader') inBook = true;
  else if (!BESIDE_THE_BOOK.has(current)) inBook = false;
  document.body.classList.toggle('in-book', inBook);
  liftProgress();
  if (!inBook && held.length) {
    for (const deliver of held.splice(0)) {
      try { deliver(); } catch (error) { console.warn('A held notice could not be shown', error); }
    }
  }
}

/** Now, or once the book is put down. */
function whenNotReading(deliver, startedReading = false) {
  if (inBook && !startedReading) held.push(deliver);
  else deliver();
}

/** Resolves now, or once the book is put down. */
function untilNotReading(startedReading = false) {
  return new Promise((resolve) => whenNotReading(resolve, startedReading));
}

async function show(name, { replace = false } = {}) {
  if (name === current) return;
  /* A screen that does not exist is not navigated to.
   *
   * Switching the current one off and finding nothing to switch on leaves the
   * app a blank page with no way back, which is the worst thing it can do and
   * was one missing attribute value away. */
  if (!screenNode(name)) return;

  // Leaving the reader ends the session, so the log never counts the time
  // someone spent on the stats page as reading.
  // Await it: the stats screen reads the log the moment it opens, and an
  // unawaited flush would land just after it had rendered the old numbers.
  if (current === 'divide' && name !== 'divide') dividePages.release();
  /* Thumbnails of six hundred pages, held only while the screen is up.
   * Leaving without releasing them is the whole volume kept decoded for the
   * rest of the session. */
  if (current === 'remove' && name !== 'remove') {
    removeThumbs.release();
    looking = null;
    el('remove-look').hidden = true;
    el('remove-confirm').hidden = true;
  }

  if (current === 'reader' && name !== 'reader') {
    hideRedactChip();
    // Before anything is hidden, for the same reason as in back().
    reader.holdPosition();
    if (desk) await closeDesk({ returnHome: false });
    await reader.pauseSession();
    // Only when leaving the book, not when stepping into one of its own
    // screens: the index, the picture reel and the rest all leave the reader
    // and coming back is the whole point of them.
    if (!BESIDE_THE_BOOK.has(name)) await forgetTransientBook();
  }

  // Recorded before the change, or it is simply the screen just arrived at --
  // which is how in-book search kept behaving as though it had come from the
  // shelf.
  cameFrom = current;
  screenNode(current)?.removeAttribute('data-active');
  screenNode(name)?.setAttribute('data-active', '');
  current = name;

  if (replace) stack[stack.length - 1] = name;
  else if (stack[stack.length - 1] !== name) stack.push(name);

  // Leaving the library ends selection: the bar refers to books you can no
  // longer see.
  if (name !== 'library') clearSelection();
  /* The shelf becomes the place to pick what goes in Build only when asked
   * for, with Build's "Add books from the shelf…": going back to the shelf
   * with a build in it -- mid-download, say, to read -- is going to the shelf.
   * Anywhere else, picking is over. */
  if (name === 'library' && pickNext) { pickNext = false; startPicking(); }
  else if (name !== 'library') endPicking();
  // The tab bar is app furniture; it has no business over a page of prose.
  document.body.dataset.view = name;
  viewChanged();
  el('tabbar').hidden = name === 'reader' || selecting();
  if (name !== 'reader') { hideEdgeHint(); el('chapter-pad').hidden = true; }
  else store.settings().then(paintChapterPad);
  for (const button of el('tabbar').children) {
    button.setAttribute('aria-pressed', String(button.dataset.go === name));
  }

  await enter(name);
}

async function enter(name) {
  switch (name) {
    case 'library': return refreshShelf();
    case 'sort': return screens.openSort();
    case 'workshop': return renderWorkshop();
    case 'web': return renderWeb();
    case 'divide': return renderDivide();
    case 'remove': return renderRemove();
    case 'bin': return renderBin();
    case 'find': return screens.initFind(goToMatch, cameFrom === 'reader');
    case 'toc': return screens.openToc(goToChapter);
    case 'reel': return reader.state.book
      ? screens.openReel(reader.state.book.id, jumpToImage)
      : emptyReel();
    case 'layout': return reader.state.book
      ? screens.openLayout(reader.state.book.id)
      : (el('layout-body').innerHTML = '<p class="muted" style="padding:24px 0">Open a book first.</p>');
    case 'folders': return panels.openFolders(openFolder);
    case 'settings': return panels.openSettings(refreshShelf);
    case 'appearance': return panels.openAppearance();
    case 'language': return panels.openLanguage();
    case 'stats': return panels.openStats({ onOpen: openFromStats });
    case 'vault': return panels.openVault(refreshShelf);
    case 'reader': return;   // opened by picking a book, never by a tab
    default: return;
  }
}

function emptyReel() {
  el('reel-counts').textContent = '';
  el('reel-grid').innerHTML = '<p class="muted" style="padding:24px 0">Open a book to see its images.</p>';
}

function back() {
  if (stack.length <= 1) {
    // Tab screens replace rather than stack, so there is nothing to pop from
    // one. Back should still return to the shelf rather than leave the app --
    // only the shelf itself is a place you exit from.
    if (TABS.includes(current) && current !== 'library') {
      show('library', { replace: true });
      return true;
    }
    return false;
  }
  stack.pop();
  const target = stack[stack.length - 1];
  const previous = current;

  /* Where you were, captured before the screen is taken away.
   *
   * A hidden element has no layout, so its scroll position reads as zero --
   * and in scroll mode the position is derived from exactly that. Hiding the
   * reader first and saving afterwards recorded the top of the chapter for
   * anyone who left while part way down one.
   */
  if (previous === 'reader') reader.holdPosition();

  screenNode(current)?.removeAttribute('data-active');
  screenNode(target)?.setAttribute('data-active', '');
  current = target;
  document.body.dataset.view = target;
  viewChanged();
  /* Out of a book, the screen arrived at is drawn once what was read has
   * been written: the last position, the book finished, the status the
   * reading gives it. Drawn straight away, the shelf showed the book as it
   * was when opened -- a book just finished still said Reading, one picked
   * up again still said On hold -- until something else redrew it. (back()
   * itself stays synchronous: Android asks whether back was handled.) */
  const written = previous === 'reader' ? reader.pauseSession().catch(() => {}) : null;
  el('tabbar').hidden = target === 'reader';
  if (written) written.then(() => { if (current === target) enter(target); });
  else enter(target);
  // Back into a book that was changed while it was away.
  if (target === 'reader') reloadReader();
  return true;
}

/* ── library ──────────────────────────────────────────────────────────── */

/**
 * The folder the shelf is filtered to, or null for everything.
 *
 * Mirrored from settings so the shelf can render synchronously, but settings
 * is what survives a relaunch -- as a module variable alone it was forgotten
 * every time the app was closed.
 */
/**
 * Discard a book that was only being looked at.
 *
 * Deliberately on leaving the reader rather than at the next launch: someone
 * who opened a file to glance at it should not find it still taking up space
 * days later because the app was never restarted.
 */
/* Screens that belong to the book being read.
 *
 * Going to one of these is not leaving the book. Treating it as leaving meant
 * a book that was only passing through -- opened from a file manager and not
 * yet kept -- was deleted the moment its index or picture reel was opened,
 * and both came up empty because the book had just been thrown away.
 */
const BESIDE_THE_BOOK = new Set(['toc', 'reel', 'find', 'layout', 'settings', 'marks', 'remove']);

async function forgetTransientBook() {
  const book = reader.state.book;
  if (!book?.transient) return;
  await store.deleteBook(book.id).catch(() => {});
  reader.state.book = null;
}

let activeFolder = null;

/* The screen the current one was opened from. Search needs it: reader.state
   keeps the last book open so it can be resumed, so "has a book ever been
   opened" is true forever -- and searching from the shelf kept offering
   in-book scopes and the in-book query. */
let cameFrom = 'library';

async function openFolder(folder) {
  activeFolder = folder;
  await store.saveSettings({ shelfFolder: folder });
  // show() returns early when the screen is already showing, so clearing the
  // filter from the shelf itself would otherwise change nothing on screen.
  if (current === 'library') await refreshShelf();
  else show('library', { replace: true });
}

/** Said once, briefly, when books have just been put on hold. */
function heldNote(count, days) {
  if (!count) return;
  toast(`${count} book${count === 1 ? '' : 's'} not read for ${days} day${days === 1 ? '' : 's'} put on hold`, 5000);
}

async function putQuietOnHold() {
  const count = await library.holdQuietBooks().catch(() => 0);
  if (!count) return;
  if (current === 'library') await refreshShelf();
  heldNote(count, (await store.settings()).autoHoldDays ?? 5);
}

async function refreshShelf() {
  await library.renderShelf({
    onOpen: onTileTap, onLongPress: onTileHold, selection,
    selecting: selectMode, folder: activeFolder,
    onNotice: (message) => toast(message, 6000),
    onClearFolder: () => openFolder(null),
  });
  // The folder lists on the stats page follow the shelf, even while shown --
  // an import or a build finishing behind them.
  if (current === 'stats') panels.openStats({ onOpen: openFromStats });
}

/** A title tapped in the stats page's folder lists: a book opens, a
 *  bundle asks which edition, as on the shelf. */
function openFromStats(book) {
  if (book.bundle) return openBundleSheet(book.bundle);
  return openBook(book);
}

/**
 * Point the grey filters at the conversion this book actually wants.
 *
 * Worked out once from a handful of its pages and remembered on the book, so
 * it costs a canvas pass the first time the book is greyed and nothing
 * afterwards. Not awaited: the book opens now and the filter follows.
 *
 * Nothing happens at all when greying is off, which is the default -- a
 * screen that shows colour shows the page as it was drawn.
 */
/* The book the grey conversion was last settled for. */
let greyMixFor = null;

function settleGreyMix(book) {
  /* Called from the repaint rather than from one way of opening a book.
   *
   * There are several ways in -- a tile, a bundle, a search result, a file
   * handed over from another app -- and hanging this off one of them meant it
   * ran for some books and not others. The repaint happens for all of them.
   */
  if (!book || greyMixFor === book.id) return;
  greyMixFor = book.id;

  store.settings().then((settings) => {
    if (settings.greyscale === 'off') {
      theme.useGreyMix('luminance');
      return null;
    }
    return library.greyMixFor(book).then((name) => theme.useGreyMix(name || 'luminance'));
  }).catch((error) => {
    // Swallowed silently, this hid the fact that the whole thing was never
    // running. Greying falls back to luminance either way, so a failure here
    // costs nothing except the measurement -- but it should still be visible.
    console.warn('Could not settle the grey conversion', error);
    theme.useGreyMix('luminance');
  });
}

async function openBook(book, opts) {
  // Opened afresh, so nothing is waiting to be reopened.
  readerStale = null;
  // Another book: the last one's page and name are cleared before the reader
  // shows, not left up until this one has been read in.
  if (reader.state.book?.id !== book.id) blankReader(book);
  await show('reader');
  try {
    // Opened, not read. Continue follows this; the status does not, because
    // glancing at a book is not reading it.
    /* Stamped on the book as it is stored now, not on the copy that was
     * tapped. The shelf hands over the record it drew the tile from, which
     * can be older than the book: writing that back undid whatever had been
     * saved since -- a cover just replaced came back as the old one, and the
     * new one's place in the book was forgotten, so it could not be removed. */
    const current = (await store.get('books', book.id)) || book;
    current.lastOpenedAt = Date.now();
    await store.put('books', current);
    await reader.open(book.id, opts);
    paintReader();
    if ((await store.settings()).keepScreenOn) window.GrimoireNative?.keepScreenOn?.(true);
  } catch (error) {
    toast(error.message);
    back();
  }
}

/* ── a book's glossary ─────────────────────────────────────────────────
 *
 * Its names and terms, and how each is translated (glossary.js): edited here
 * row by row, found in the book by the AI model, brought in from a file --
 * Glossarion's own included -- and written out again. Nothing is kept until
 * Save, so a scan or an import can be looked over first.
 */

let glossaryState = null;   // { book, entries, scanned, fresh: Set, filter }

async function openGlossary(book) {
  const loaded = await glossary.load(book);
  glossaryState = { book, entries: loaded.entries.map((e) => ({ ...e })), scanned: { ...loaded.scanned }, fresh: new Set(), filter: '' };
  el('glossary-of').textContent = `Glossary · ${library.displayTitle(book)}`;
  const engine = translate.status().engine;
  el('glossary-note').textContent = `For ${loaded.scope.label}. `
    + (engine === 'llm' || engine === 'deepl'
      ? 'Every translation keeps to it: the names in what is translated go with it.'
      : 'It is used when the translator is an AI model or DeepL; on-device translation cannot take one.');
  el('glossary-find').hidden = false;
  el('glossary-filter').value = '';
  el('glossary-sheet').hidden = false;
  paintGlossary();
}

function closeGlossary() {
  if (el('glossary-sheet').hidden) return false;
  el('glossary-sheet').hidden = true;
  glossaryState = null;
  el('glossary-list').innerHTML = '';
  return true;
}

function paintGlossary() {
  const g = glossaryState;
  if (!g) return;
  const list = el('glossary-list');
  list.innerHTML = '';
  const needle = g.filter.trim().toLowerCase();
  const shown = g.entries
    .map((entry, at) => ({ entry, at }))
    .filter(({ entry }) => !needle || `${entry.source} ${entry.target} ${entry.note}`.toLowerCase().includes(needle));
  if (!g.entries.length) {
    list.innerHTML = '<p class="glossary-empty">No names yet. Add them one by one, let the AI model find them in the book, or import a glossary — Glossarion’s JSON, CSV and text glossaries all read.</p>';
    return;
  }
  for (const { entry, at } of shown) {
    const row = document.createElement('div');
    row.className = `glossary-row${g.fresh.has(entry) ? ' fresh' : ''}`;
    const field = (value, placeholder, key) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.oninput = () => { g.entries[at][key] = input.value; };
      return input;
    };
    const choose = (options, value, key, label) => {
      const select = document.createElement('select');
      select.setAttribute('aria-label', label);
      for (const [code, name] of options) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        option.selected = code === value;
        select.appendChild(option);
      }
      select.onchange = () => { g.entries[at][key] = select.value; };
      return select;
    };
    const more = document.createElement('div');
    more.className = 'glossary-more';
    const remove = document.createElement('button');
    remove.className = 'glossary-remove';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Remove ${entry.source}`);
    remove.onclick = () => { g.entries.splice(at, 1); paintGlossary(); };
    more.append(
      choose([['', 'Kind'], ...glossary.KINDS], entry.kind, 'kind', 'Kind'),
      choose(glossary.GENDERS, entry.gender, 'gender', 'Said as'),
      field(entry.note, 'Note', 'note'),
      remove,
    );
    row.append(field(entry.source, 'As written', 'source'), field(entry.target, 'Translated as', 'target'), more);
    list.appendChild(row);
  }
}

/** The book's words, chapter by chapter, for the model to look through. */
async function glossaryScan() {
  const g = glossaryState;
  if (!g) return;
  if (translate.status().engine !== 'llm' || !translate.status().configured) {
    return toast('Finding names needs an AI model as the translator — Settings → Translation', 6000);
  }
  const book = g.book;
  const chapters = await store.byIndex('chapters', 'bookId', book.id);
  const from = g.scanned[book.id] || { chapter: 0, offset: 0 };
  const { pieces, next } = glossary.nextPieces(chapters, from, (c) => plainTextOf(chapterHtml(c)));
  if (!pieces.length) {
    return toast(from.chapter || from.offset
      ? 'The whole book has been looked through. Its names are all in the list.'
      : 'This book has no text to look for names in — add them by hand, or import a glossary.', 6000);
  }
  const settings = await store.settings();
  const target = translate.TARGETS.find(([code]) => code === settings.translateTarget)?.[1] || 'English';
  const button = el('glossary-find');
  button.disabled = true;
  let added = 0;
  try {
    for (let i = 0; i < pieces.length; i++) {
      button.textContent = `Looking… ${i + 1} of ${pieces.length}`;
      const known = g.entries.map((e) => e.source).filter(Boolean).slice(0, 300);
      const user = (known.length ? `Already in the glossary: ${known.join(', ')}\n\n` : '') + `Text:\n${pieces[i]}`;
      const found = glossary.parseFound(await translate.complete(glossary.findingInstructions(target), user));
      if (!glossaryState) return;
      const merged = glossary.merge(g.entries, found);
      for (const entry of merged.entries.slice(g.entries.length)) g.fresh.add(entry);
      added += merged.added;
      g.entries = merged.entries;
      paintGlossary();
    }
    g.scanned[book.id] = next;
    toast(added
      ? `${added} found — look them over, then Save. Tap again to look further into the book.`
      : 'Nothing new found there. Tap again to look further into the book.', 6000);
  } catch (error) {
    toast(error.message || 'The model could not be asked', 6000, { kind: 'failed' });
  } finally {
    button.disabled = false;
    button.textContent = 'Find names with AI';
  }
}

function wireGlossary() {
  el('glossary-cancel').onclick = () => closeGlossary();
  el('glossary-sheet').onclick = (e) => { if (e.target === el('glossary-sheet')) closeGlossary(); };
  el('glossary-filter').oninput = () => {
    if (!glossaryState) return;
    glossaryState.filter = el('glossary-filter').value;
    paintGlossary();
  };
  el('glossary-add').onclick = () => {
    const g = glossaryState;
    if (!g) return;
    const entry = { source: '', target: '', kind: '', gender: '', note: '' };
    g.entries.unshift(entry);
    g.fresh.add(entry);
    g.filter = '';
    el('glossary-filter').value = '';
    paintGlossary();
    el('glossary-list').querySelector('input')?.focus();
  };
  el('glossary-find').onclick = () => glossaryScan();
  el('glossary-import').onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    // Typed loosely on purpose: a .json or .csv through a chat app is often "some file".
    picker.accept = 'application/json,text/csv,text/plain,text/markdown,application/octet-stream,.json,.csv,.txt,.md,.tsv';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      const g = glossaryState;
      if (!file || !g) return;
      try {
        const text = await (typeof file.text === 'function' ? file.text() : new Response(file).text());
        const merged = glossary.merge(g.entries, glossary.parseFile(text, file.name));
        for (const entry of merged.entries.slice(g.entries.length)) g.fresh.add(entry);
        g.entries = merged.entries;
        paintGlossary();
        toast(`${merged.added} added${merged.filled ? `, ${merged.filled} filled in` : ''} — Save to keep them. Names already here keep their translation.`, 6000);
      } catch (error) {
        toast(error.message || 'That glossary could not be read', 6000);
      }
    };
    picker.click();
  };
  const exportAs = (kind) => async () => {
    const g = glossaryState;
    if (!g) return;
    const name = `${epub.safeName(library.displayTitle(g.book))} glossary.${kind}`;
    const text = kind === 'json' ? glossary.toJson(g.entries) : glossary.toCsv(g.entries);
    await writeOut(new Blob([text], { type: kind === 'json' ? 'application/json' : 'text/csv' }), name,
      kind === 'json' ? 'application/json' : 'text/csv', { share: true });
  };
  el('glossary-export').onclick = exportAs('json');
  el('glossary-export-csv').onclick = exportAs('csv');
  el('glossary-save').onclick = async () => {
    const g = glossaryState;
    if (!g) return;
    const entries = glossary.clean(g.entries);
    await glossary.save(g.book, entries, { scanned: g.scanned });
    const missing = entries.filter((e) => !e.target).length;
    closeGlossary();
    toast(`${entries.length} kept${missing ? ` · ${missing} still to be given a translation` : ''}. New translations keep to them.`, 5000, { kind: 'done' });
  };
  el('ocr-glossary').onclick = () => {
    const book = reader.state.book;
    if (book) openGlossary(book);
  };
}

/* ── selection ────────────────────────────────────────────────────────────
 * Long press starts it; tapping adds and removes. Actions are buttons in a
 * bar, because choosing the books and then describing what to do with them in
 * words was the wrong way round.
 */

const selection = new Set();
let selectMode = false;

function selecting() { return selectMode || !!buildPicks; }

function onTileTap(book) {
  if (buildPicks) { pickTile(book); return; }
  if (!selectMode) {
    // A bundle is one thing on the shelf and several things to open, so it
    // asks which rather than guessing.
    if (book.bundle) return openBundleSheet(book.bundle);
    return openBook(book);
  }
  if (selection.has(book.id)) unselectTile(book);
  else selectTile(book);
  // Deliberately stays in the mode at zero: dropping out because you
  // deselected the last one loses your place in a long shelf.
  paintSelection();
  refreshShelf();
}

function onTileHold(book) {
  // While picking for Build a press is a tap: no second mode on top of it.
  if (buildPicks) { pickTile(book); return; }
  selectMode = true;
  selectTile(book);
  paintSelection();
  refreshShelf();
}

/* ── picking books for Build, on the shelf ────────────────────────────
 *
 * A build with a book in it, and the way back to the shelf to find what
 * goes after it: there, every book tapped is the next part, numbered in its
 * corner with the place it will have -- the books already in the build show
 * theirs too, darker -- and Finish puts them in, in that order. Tapping one
 * again takes it out, and the numbers after it close up.
 */
let buildPicks = null;   // { ids: [] } while books are being picked
let pickNext = false;    // Build's "Add books from the shelf…" was tapped

function startPicking() {
  if (buildPicks) return;
  buildPicks = { ids: [] };
  paintPicking();
}

function endPicking() {
  if (!buildPicks) return false;
  buildPicks = null;
  library.setBuildOrder(null);
  paintPicking();
  if (current === 'library') refreshShelf();
  return true;
}

function pickOrder() {
  const order = new Map();
  const parts = build.contents();
  parts.forEach((part, at) => { if (part.bookId) order.set(part.bookId, { place: at + 1, already: true }); });
  if (buildPicks) buildPicks.ids.forEach((id, at) => order.set(id, { place: parts.length + at + 1, already: false }));
  return order;
}

function paintPicking() {
  const on = !!buildPicks;
  document.body.classList.toggle('picking', on);
  el('pick-head').hidden = !on;
  el('library-head').hidden = on || selectMode;
  el('tabbar').hidden = on || selectMode || current === 'reader';
  if (!on) return;
  const parts = build.contents().length;
  const count = buildPicks.ids.length;
  el('pick-count').textContent = count ? `${count} to add to Build` : 'Add to Build';
  el('pick-note').textContent = `Tap in order · after part ${parts}`;
  el('pick-finish').textContent = count ? `Finish · ${count}` : 'Finish';
  library.setBuildOrder(pickOrder());
}

async function pickTile(book) {
  if (build.hasBook(book.id)) {
    const at = build.contents().findIndex((part) => part.bookId === book.id) + 1;
    toast(`Already in the build, as part ${at}`);
    return;
  }
  const at = buildPicks.ids.indexOf(book.id);
  if (at === -1) buildPicks.ids.push(book.id);
  else buildPicks.ids.splice(at, 1);
  paintPicking();
  await refreshShelf();
}

async function finishPicking() {
  if (!buildPicks) return;
  const ids = [...buildPicks.ids];
  let added = 0;
  for (const id of ids) {
    const book = await store.get('books', id);
    if (!book || build.hasBook(id)) continue;
    build.addBook(book);
    added += 1;
  }
  endPicking();
  await show('workshop');
  renderWorkshop();
  if (added) toast(`${added} book${added === 1 ? '' : 's'} added to the build, in the order picked`);
}

/* A bundle is one tile and several books.
 *
 * Its tile carries the leader's id, so selecting it selected the leader and
 * nothing else: filing, deleting, locking away or writing out a bundle did it
 * to one edition and left the rest where they were. Which editions a tile
 * stood for is kept with the selection, so everything done to the tile is
 * done to every book in it. Kept from the tile itself rather than looked up
 * by bundle: when the shelf is grouped so that a bundle's editions are shown
 * apart, each is its own tile and is selected on its own. */
const selectedBundles = new Map();   // leader id -> the ids of every edition

function selectTile(book) {
  selection.add(book.id);
  if (book.bundle?.length > 1) selectedBundles.set(book.id, book.bundle.map((b) => b.id));
}

function unselectTile(book) {
  selection.delete(book.id);
  selectedBundles.delete(book.id);
}

/** Every book the selection stands for: bundles opened out into editions. */
function selectedIds() {
  const ids = new Set(selection);
  for (const [leader, editions] of selectedBundles) {
    if (selection.has(leader)) for (const id of editions) ids.add(id);
  }
  return ids;
}

/** The one bundle selected, when a single tile that is a bundle is all
 *  that is selected. */
function soleBundle() {
  if (selection.size !== 1) return null;
  const [id] = selection;
  return selectedBundles.get(id) || null;
}

function paintSelection() {
  const on = selectMode;
  const count = selection.size;

  el('select-head').hidden = !on;
  el('library-head').hidden = on;
  el('select-actions').hidden = !on;
  el('tabbar').hidden = on || current === 'reader';
  if (!on) el('confirm-bar').hidden = true;

  // A bundle counts as the one tile it is, with what it holds said beside.
  const books = selectedIds().size;
  el('select-count').textContent = count === 0
    ? 'Select books'
    : books > count ? `${count} selected · ${books} books` : `${count} selected`;

  // Actions that only make sense for one book, or for any book at all.
  for (const button of el('select-actions').children) {
    const act = button.dataset.act;
    // Details works for several books too: their folder and status.
    const single = act === 'open';
    button.disabled = single ? count !== 1 : count === 0;
  }
}

function clearSelection() {
  if (!selectMode) return false;
  selectMode = false;
  selection.clear();
  selectedBundles.clear();
  paintSelection();
  refreshShelf();
  return true;
}

/** The books selected, every edition of a selected bundle among them. */
async function selectedBooks() {
  const ids = selectedIds();
  const books = await store.all('books');
  return books.filter((b) => ids.has(b.id));
}

/**
 * For what is done to one book: which one, when the tile is a bundle.
 *
 * Taking pages out of a bundle, or dividing one, means one of its editions;
 * the bundle's sheet of editions is shown so the choice is yours rather than
 * whichever happens to lead.
 */
async function oneSelected(refusal, run) {
  const bundle = soleBundle();
  if (bundle) {
    const books = await store.all('books');
    const editions = bundle.map((id) => books.find((b) => b.id === id)).filter(Boolean);
    clearSelection();
    return openBundleSheet(editions, { verb: refusal.verb, run });
  }
  const books = await selectedBooks();
  if (books.length !== 1) return toast(refusal.text);
  return run(books[0]);
}

function wireSelection() {
  el('select-cancel').onclick = () => clearSelection();
  el('pick-cancel').onclick = () => endPicking();
  el('pick-finish').onclick = () => finishPicking();

  el('select-all').onclick = async () => {
    /* Everything on the shelf as it stands, not everything you own.
     *
     * Filtered to a folder, "select all" that reaches past the filter is a
     * trap: what it selects is not what is in front of you, and the next
     * thing pressed -- move, delete -- happens to books you cannot see.
     */
    // What the shelf drew, so nothing in a hidden folder is caught up in it
    // -- nor anything outside the folder the shelf is filtered to.
    const books = (await store.all('books')).filter((book) => library.shownOnShelf.has(book.id));

    // A second press clears, so the same button undoes itself.
    const all = books.every((book) => selection.has(book.id));
    if (all) for (const book of books) selection.delete(book.id);
    else for (const book of books) selection.add(book.id);

    paintSelection();
    refreshShelf();
  };

  const actions = {
    // A bundle asks which edition, as tapping it does.
    open: () => oneSelected({ text: 'Choose one book to open', verb: 'Open which edition?' }, (book) => {
      clearSelection();
      openBook(book);
    }),

    /* Writing a book out is a thing you do to a book, so it belongs with the
       other things you do to a book. It was only inside the details sheet,
       which is a long press and a scroll away -- far enough that it may as
       well not have been there. */
    /* Covering a cover, for a shelf that is looked at in public.
     *
     * A toggle rather than two actions: with several selected, any that are
     * showing get blurred, and a selection that is already entirely blurred
     * is revealed. */
    blur: async () => {
      const books = await selectedBooks();
      if (!books.length) return;

      const allBlurred = books.every((book) => book.coverBlur);
      const changed = await library.blurCovers(books.map((b) => b.id), !allBlurred);
      clearSelection();
      await refreshShelf();
      toast(allBlurred
        ? `${changed} cover${changed === 1 ? '' : 's'} showing again`
        : `${changed} cover${changed === 1 ? '' : 's'} blurred`);
    },

    export: async () => {
      const books = await selectedBooks();
      if (!books.length) return;
      if (books.length === 1) return askAboutExport(books[0]);
      return exportMany(books);
    },

    /* Folder and status live here, for one book or many.
     *
     * They were two more buttons beside this one, doing part of what it does;
     * one book gets its whole details sheet, several get the part of it that
     * applies to all of them at once. */
    details: async () => {
      // One bundle: its leader's details, with folder and status for every
      // edition -- the title and cover are the leader's own.
      const bundle = soleBundle();
      if (bundle) {
        const [leader] = selection;
        return openDetails({ id: leader }, { editions: bundle.filter((id) => id !== leader) });
      }
      const books = await selectedBooks();
      if (books.length === 1) return openDetails(books[0]);
      if (books.length > 1) return openGroupDetails(books);
    },

    /* Only the undo lives here now.
     *
     * Joining books already on the shelf was the wrong shape for the job: the
     * parts of a serial are files, and importing thirty volumes in order to
     * join them and then delete thirty leftovers is a great deal of work to
     * arrive where you meant to start. Building happens in the workshop, from
     * the files themselves. Taking a built book apart still belongs here,
     * beside the book it applies to. */
    /* Taking something apart, whichever way it was put together.
     *
     * A book that was joined comes apart into what it was made from. Any
     * other book can be divided at chapters you choose -- which is the same
     * idea applied to a file that arrived as one piece. */
    merge: () => oneSelected({ text: 'Choose one book to take apart', verb: 'Take apart which edition?' }, (book) => {

      /* A book that was built can be taken apart two different ways, and
       * choosing for the reader was wrong: it went straight to undoing the
       * join, so a built comic could never be divided at all. */
      if (library.wasJoined(book) || book.builtFrom) return offerTakeApart(book);
      return openDivide(book);
    }),

    /* Bundling is one action that reads both ways: several books become a
       bundle, and a bundle already selected comes apart. Two buttons for
       something that is its own opposite is one too many. */
    bundle: async () => {
      const books = await selectedBooks();
      if (!books.length) return;

      const bundled = books.filter((b) => b.bundleId);
      if (bundled.length === books.length && books.length) {
        /* Every member comes apart, not only the ones selected. A bundle
           shows as a single tile, so selecting it selects the leader alone --
           and releasing just the leader would leave the others pointing at a
           book that is no longer in a bundle. */
        const ids = new Set(bundled.map((b) => b.bundleId));
        const all = (await store.all('books')).filter((b) => ids.has(b.bundleId));
        for (const book of all) { delete book.bundleId; await store.put('books', book); }
        clearSelection();
        return toast(`${all.length} editions separated — each is a book of its own again`);
      }

      if (books.length < 2) return toast('Select two or more books to join as editions of one book');

      /* A bundle already among them keeps leading, so books added to it join
       * it -- rather than its leader being made a member of something else,
       * which left its old editions pointing at a bundle that had moved. */
      const leader = books.find((b) => b.bundleId === b.id) || books[0];
      for (const book of books) { book.bundleId = leader.id; await store.put('books', book); }
      clearSelection();
      toast(`${books.length} books joined as editions of “${leader.title}”`);
    },

    vault: async () => {
      const books = await selectedBooks();
      if (!books.length) return;
      const settings = await store.settings();
      if (!settings.vaultPassphrase) {
        // Otherwise the books simply disappear: hidden from the shelf, and
        // only reachable from a screen that asks for a passphrase nobody set.
        toast('Set a vault passphrase first — Settings, then Vault.', 5000);
        return;
      }
      const anyOut = books.some((b) => !b.inVault);
      for (const book of books) {
        book.inVault = anyOut;
        await store.put('books', book);
      }
      clearSelection();
      toast(anyOut ? `${books.length} moved to the vault` : `${books.length} taken out of the vault`);
    },

    /* Out of the way, not gone.
     *
     * A mistap on a grid of covers is not a decision, and deleting outright
     * treated it as one: the file had to be found again, which for something
     * downloaded a year ago often means not at all. */
    /* Adding more files to the end of a book: the same as "Build onto this
     * book" in a search result's menu, which was the only place it was. */
    build: () => oneSelected({ text: 'Choose one book to build onto', verb: 'Build onto which edition?' }, (book) => {
      clearSelection();
      return buildOnto(book);
    }),

    trim: () => oneSelected({ text: 'Choose one book to take pages out of', verb: 'Take pages out of which edition?' }, (book) => {
      clearSelection();
      return openRemove(book);
    }),

    redact: () => oneSelected({ text: 'Choose one book to black out panels in', verb: 'Black out panels in which edition?' }, (book) => {
      clearSelection();
      return openRedactPick(book);
    }),

    delete: () => {
      resetConfirm();
      const n = selectedIds().size;
      el('confirm-text').textContent = selectedBundles.size && n > selection.size
        ? `Delete ${n} books, every edition of ${soleBundle() ? 'it' : 'them'}? They go to the bin.`
        : `Delete ${n} book${n === 1 ? '' : 's'}? They go to the bin.`;
      el('confirm-bar').hidden = false;
    },
  };

  for (const button of el('select-actions').children) {
    button.onclick = () => actions[button.dataset.act]?.();
  }

  resetConfirm();

  el('details-sheet').onclick = (e) => {
    if (e.target === el('details-sheet')) el('details-sheet').hidden = true;
  };

  el('folder-actions-cancel').onclick = () => { el('folder-actions').hidden = true; };
  el('folder-actions').onclick = (e) => {
    if (e.target === el('folder-actions')) el('folder-actions').hidden = true;
  };

  el('export-cancel').onclick = () => { el('export-sheet').hidden = true; };
  el('export-sheet').onclick = (e) => {
    if (e.target === el('export-sheet')) el('export-sheet').hidden = true;
  };

  el('merge-cancel').onclick = () => { el('merge-sheet').hidden = true; };
  el('merge-sheet').onclick = (e) => {
    if (e.target === el('merge-sheet')) el('merge-sheet').hidden = true;
  };

  el('bundle-cancel').onclick = () => { el('bundle-sheet').hidden = true; };
  el('bundle-sheet').onclick = (e) => {
    if (e.target === el('bundle-sheet')) el('bundle-sheet').hidden = true;
  };

}

async function openDetails(tapped, { editions = [] } = {}) {
  // The book as it is stored, not the copy the menu was opened from -- which
  // can be older, and saving it would undo whatever changed since.
  const book = (await store.get('books', tapped.id)) || tapped;
  const body = el('details-body');
  const urls = blobs.pool();
  const coverUrl = urls.url(book.coverBlob);

  body.innerHTML = `
    <p class="eyebrow">${editions.length
      ? `Book details · ${editions.length + 1} editions · folder and status go to all of them`
      : 'Book details'}</p>
    <div class="details-head">
      <span class="details-cover" id="details-cover">
        ${coverUrl ? `<img src="${coverUrl}" alt="">` : ''}
      </span>
      <span class="col">
        <button class="btn ghost" id="details-cover-from">From its pictures…</button>
        <button class="btn ghost" id="details-cover-pick">Replace cover</button>
        <button class="btn ghost" id="details-cover-clear">Remove cover</button>
      </span>
    </div>`;

  const exports = document.createElement('div');
  exports.className = 'field';
  exports.innerHTML = '<label><span>Write out</span></label>';
  const row = document.createElement('div');
  row.className = 'chip-row';
  for (const [label, share] of [['Save as EPUB', false], ['Send a copy', true]]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.onclick = () => { close(); askAboutExport(book); };
    row.appendChild(chip);
  }
  exports.appendChild(row);
  body.appendChild(exports);

  // The names and terms its translations keep to (glossary.js).
  const terms = document.createElement('div');
  terms.className = 'field';
  const kept = await glossary.load(book);
  terms.innerHTML = `<label><span>Glossary</span><span class="muted">${escapeText(
    kept.scope.series ? 'shared by the series' : 'names and terms kept the same')}</span></label>`;
  const termsButton = document.createElement('button');
  termsButton.className = 'chip';
  termsButton.style.textTransform = 'none';
  termsButton.textContent = kept.entries.length
    ? `${kept.entries.length} name${kept.entries.length === 1 ? '' : 's'} and term${kept.entries.length === 1 ? '' : 's'}…`
    : 'Add names and terms…';
  termsButton.onclick = () => openGlossary(book);
  terms.appendChild(termsButton);
  body.appendChild(terms);

  const statusField = document.createElement('div');
  statusField.className = 'field';
  // Automatic is always what it is left on: a status chosen here is set once,
  // and holds only until the book is next read.
  // A bundle's status is the bundle's: where the edition read last stands.
  const editionBooks = (await Promise.all(editions.map((id) => store.get('books', id)))).filter(Boolean);
  const asRead = editionBooks.length ? { ...book, ...library.readAsOne([book, ...editionBooks]) } : book;
  const nowLabel = library.STATUS_LABELS[library.statusOf(asRead)];
  statusField.innerHTML = `<label><span>Status</span><span class="muted">${escapeText(
    library.statusIsPinned(asRead)
      ? `${nowLabel}, as you set it, until you next read it`
      : `${nowLabel}, from your reading`)}</span></label>`;
  const statusChips = document.createElement('div');
  statusChips.className = 'chip-row wrap';
  let pickedStatus;   // undefined = leave as it is
  for (const [value, label] of [...library.STATUSES, [null, 'Automatic']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(value === null));
    chip.onclick = () => {
      pickedStatus = value;
      for (const other of statusChips.children) other.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
    };
    statusChips.appendChild(chip);
  }
  statusField.appendChild(statusChips);
  body.appendChild(statusField);

  /* Tags: only the book's own are shown here, with one button to choose
   * more. The long list of common tags lives in its own sheet, folded away. */
  const startTags = tags.tagsOf(book);
  let tagList = [...startTags];
  const tagField = document.createElement('div');
  tagField.className = 'field';
  tagField.innerHTML = `<label><span>Tags</span>${
    editions.length ? '<span class="muted">for every edition</span>' : ''}</label>`;
  const tagRow = document.createElement('div');
  tagRow.className = 'chip-row wrap details-tags';
  tagField.appendChild(tagRow);
  const paintTags = () => {
    tagRow.innerHTML = '';
    for (const tag of tagList) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.setAttribute('aria-pressed', 'true');
      chip.textContent = `${tag}  ✕`;
      chip.title = `Take off ${tag}`;
      chip.onclick = () => { tagList = tagList.filter((t) => t !== tag); paintTags(); };
      tagRow.appendChild(chip);
    }
    const add = document.createElement('button');
    add.className = 'chip details-tags-add';
    add.textContent = tagList.length ? '＋ Tags…' : '＋ Add tags…';
    add.onclick = async () => {
      const picked = await tags.openTagPicker({
        chosen: tagList, used: await tagsInUse(), title: `Tags · ${library.displayTitle(book)}`,
      });
      if (picked) { tagList = picked; paintTags(); }
    };
    tagRow.appendChild(add);
  };
  paintTags();
  body.appendChild(tagField);

  const fields = [
    ['title', 'Title', book.title || ''],
    ['author', 'Author', book.author || ''],
    ['series', 'Series', book.series || ''],
    ['seriesIndex', 'Series number', book.seriesIndex ?? ''],
    ['lang', 'Language', book.lang || ''],
  ];
  const inputs = {};
  for (const [key, label, value] of fields) {
    const field = document.createElement('label');
    field.className = 'field';
    field.innerHTML = `<label><span>${label}</span></label>`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    if (key === 'lang') input.placeholder = 'e.g. en, ko, ja — used as the translation source';
    inputs[key] = input;
    field.appendChild(input);
    body.appendChild(field);
  }

  /* The folder, picked rather than typed.
   *
   * Typing it meant spelling an existing folder exactly as it was spelled
   * before, or quietly making a second one beside it. The folders there are
   * are offered as they are; a new one is still a tap and a name away. */
  inputs.folder = await folderPicker(body, book.folder || '');

  // Read-only, because these describe the file rather than the record.
  const facts = document.createElement('div');
  facts.className = 'facts';
  const bytes = book.words ? `${book.words.toLocaleString()} words` : '—';
  for (const [label, value] of [
    ['Format', book.format || '—'],
    ['Chapters', book.chapterCount ?? '—'],
    ['Length', bytes],
    ['Images', book.imageCount ?? 0],
    ['Added', book.addedAt ? new Date(book.addedAt).toLocaleDateString() : '—'],
    ['Last read', book.lastReadAt ? new Date(book.lastReadAt).toLocaleDateString() : 'Never'],
  ]) {
    const cell = document.createElement('div');
    cell.innerHTML = `<b>${label}</b><small>${escapeText(String(value))}</small>`;
    facts.appendChild(cell);
  }
  body.appendChild(facts);

  let newCover;   // undefined = unchanged, null = cleared, Blob = replaced

  body.querySelector('#details-cover-pick').onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = blobs.COVER_ACCEPT;
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        // Decoded and re-encoded, so a format the picker offered but the
        // WebView cannot draw is refused here rather than stored as a blank.
        newCover = await blobs.normaliseCover(file);
        const preview = urls.url(newCover);
        body.querySelector('#details-cover').innerHTML = `<img src="${preview}" alt="">`;
      } catch (error) {
        toast(error.message, 6000);
      }
    };
    picker.click();
  };
  /* Any picture in the book -- or, for a bundle, in any of its editions --
   * as its cover: the first page of a comic is often a credit page, and the
   * real cover is the third. */
  const withPictures = [book, ...editionBooks];
  body.querySelector('#details-cover-from').onclick = () => openCoverPick({
    title: editions.length ? 'Cover from the editions' : 'Cover from the book',
    none: editions.length ? 'None of these editions has pictures in it.' : 'This book has no pictures in it.',
    sources: withPictures.map((b) => ({ name: library.displayTitle(b), pictures: () => picturesOfBook(b.id) })),
    onPick: (cover) => {
      newCover = cover;
      body.querySelector('#details-cover').innerHTML = `<img src="${urls.url(newCover)}" alt="">`;
    },
  });
  body.querySelector('#details-cover-clear').onclick = () => {
    newCover = null;
    body.querySelector('#details-cover').innerHTML = '';
  };

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.style.cssText = 'border:0;background:none;padding:10px 0 0';
  actions.innerHTML = `
    <button class="btn ghost" id="details-cancel">Cancel</button>
    <button class="btn primary" id="details-save">Save</button>`;
  body.appendChild(actions);

  const close = () => { el('details-sheet').hidden = true; urls.release(); };
  actions.querySelector('#details-cancel').onclick = close;
  actions.querySelector('#details-save').onclick = async () => {
    book.title = inputs.title.value.trim() || book.title;
    book.author = inputs.author.value.trim() || null;
    book.series = inputs.series.value.trim() || null;
    const index = parseFloat(inputs.seriesIndex.value);
    book.seriesIndex = Number.isFinite(index) ? index : null;
    book.folder = inputs.folder.value.trim().replace(/^\/+|\/+$/g, '');
    book.lang = inputs.lang.value.trim() || null;
    if (newCover !== undefined) {
      book.coverBlob = newCover;
      book.coverBytes = newCover?.size ?? null;
      // Marked as chosen rather than found in the file. A cover taken from
      // the book comes back on its own when the book is imported again; one
      // picked by hand does not, so the backup has to carry it.
      book.coverCustom = !!newCover;
    }
    if (pickedStatus !== undefined) setStatusOn(book, pickedStatus);
    const tagsChanged = !tags.sameTags(tagList, startTags);
    if (tagsChanged) book.tags = tagList;

    await store.put('books', book);
    /* Into the book itself, not only onto the shelf: the cover page shows the
     * new picture, an export carries it, and removing it puts the book back
     * as it came. See coverpage.js. */
    if (newCover !== undefined && (newCover || book.coverPage)) {
      try {
        await covers.placeCover(book.id, newCover);
        // An open copy of this book is reread when it is next shown.
        if (reader.state.book?.id === book.id) readerStale = { bookId: book.id, land: null };
      } catch (error) {
        toast(`The cover is set, but could not be put into the book: ${error.message}`, 6000);
      }
    }
    // A bundle is filed and marked as one: its other editions follow.
    const others = [];
    for (const id of editions) {
      const edition = await store.get('books', id);
      if (!edition) continue;
      edition.folder = book.folder;
      if (!edition.folder) delete edition.folder;
      if (pickedStatus !== undefined) setStatusOn(edition, pickedStatus);
      // What was added or taken off, rather than the leader's list wholesale:
      // an edition may carry a tag of its own ("Raw", say).
      if (tagsChanged) edition.tags = retag(edition, tagList, startTags);
      await store.put('books', edition);
      others.push(edition);
    }
    // Titles were translated from the old text, so that cache is now wrong.
    await translate.clearCache(book.id).catch(() => {});
    close();
    clearSelection();
    toast(await hiddenNote([book, ...others], others.length
      ? `Details saved, for all ${others.length + 1} editions` : 'Details saved'), 5000);
  };

  el('details-sheet').hidden = false;
}

/**
 * A folder chooser: the folders that exist, "Not filed", and a new one.
 *
 * @returns something with a `value` -- the folder chosen, "" for none -- so
 *   it reads like the text field it replaces.
 */
async function folderPicker(body, current, { keep = false } = {}) {
  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML = '<label><span>Folder</span></label>';
  const row = document.createElement('div');
  row.className = 'chip-row wrap details-folders';
  field.appendChild(row);
  const typed = document.createElement('input');
  typed.type = 'text';
  typed.className = 'details-folder-new';
  typed.placeholder = 'Name the new folder — a / puts it inside another';
  typed.hidden = true;
  field.appendChild(typed);
  body.appendChild(field);

  let chosen = current;
  const chips = [];
  const press = (chip) => { for (const other of chips) other.setAttribute('aria-pressed', String(other === chip)); };
  const offer = (label, folder) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.dataset.folder = folder ?? '';
    chip.setAttribute('aria-pressed', String(!keep && folder === current));
    chip.onclick = () => {
      if (folder === null) {
        // A new one: the name box, ready to type in.
        typed.hidden = false;
        chosen = typed.value.trim();
        typed.focus();
      } else {
        typed.hidden = true;
        chosen = folder;
      }
      press(chip);
    };
    chips.push(chip);
    row.appendChild(chip);
  };

  // For several books at once: change nothing unless a folder is picked.
  if (keep) { chosen = undefined; offer('Leave as they are', undefined); chips[0].setAttribute('aria-pressed', 'true'); }
  offer('Not filed', '');
  const folders = (await library.folderCounts()).map(([folder]) => folder).filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  for (const folder of folders) offer(folder, folder);
  offer('＋ New folder…', null);
  typed.oninput = () => { chosen = typed.value.trim(); };

  return { get value() { return chosen; } };
}

/**
 * Details for several books at once: what can sensibly be the same for all of
 * them -- where they are filed and how far through they are. Nothing changes
 * that is not picked.
 */
async function openGroupDetails(books) {
  const body = el('details-body');
  body.innerHTML = `<p class="eyebrow">${books.length} books</p>`;

  const statusField = document.createElement('div');
  statusField.className = 'field';
  statusField.innerHTML = '<label><span>Status</span></label>';
  const statusChips = document.createElement('div');
  statusChips.className = 'chip-row wrap';
  let pickedStatus;   // undefined = leave them as they are
  for (const [value, label] of [[undefined, 'Leave as they are'], ...library.STATUSES, [null, 'Automatic']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(value === undefined));
    chip.onclick = () => {
      pickedStatus = value;
      for (const other of statusChips.children) other.setAttribute('aria-pressed', String(other === chip));
    };
    statusChips.appendChild(chip);
  }
  statusField.appendChild(statusChips);
  body.appendChild(statusField);

  /* Tags for all of them: each tag any of them has, with how many have it --
   * tapped, it comes off all of them -- and more to put on all of them. */
  const had = tags.usedTags(books);
  const dropping = new Set();
  let adding = [];
  const tagField = document.createElement('div');
  tagField.className = 'field';
  tagField.innerHTML = '<label><span>Tags</span><span class="muted">tap one to take it off all of them</span></label>';
  const tagRow = document.createElement('div');
  tagRow.className = 'chip-row wrap details-tags';
  tagField.appendChild(tagRow);
  const paintGroupTags = () => {
    tagRow.innerHTML = '';
    for (const [tag, count] of had) {
      const chip = document.createElement('button');
      const off = dropping.has(tags.tagKey(tag));
      chip.className = off ? 'chip struck' : 'chip';
      chip.setAttribute('aria-pressed', String(!off));
      chip.textContent = `${tag} ${count}/${books.length}`;
      chip.onclick = () => {
        const key = tags.tagKey(tag);
        if (dropping.has(key)) dropping.delete(key); else dropping.add(key);
        paintGroupTags();
      };
      tagRow.appendChild(chip);
    }
    for (const tag of adding) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.setAttribute('aria-pressed', 'true');
      chip.textContent = `+ ${tag}  ✕`;
      chip.onclick = () => { adding = adding.filter((t) => t !== tag); paintGroupTags(); };
      tagRow.appendChild(chip);
    }
    const add = document.createElement('button');
    add.className = 'chip details-tags-add';
    add.textContent = '＋ Add tags to all…';
    add.onclick = async () => {
      const picked = await tags.openTagPicker({
        chosen: adding, used: await tagsInUse(), title: `Tags for ${books.length} books`,
      });
      if (picked) { adding = picked; paintGroupTags(); }
    };
    tagRow.appendChild(add);
  };
  paintGroupTags();
  body.appendChild(tagField);

  const folder = await folderPicker(body, null, { keep: true });

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.style.cssText = 'border:0;background:none;padding:10px 0 0';
  actions.innerHTML = `
    <button class="btn ghost" id="details-cancel">Cancel</button>
    <button class="btn primary" id="details-save">Save</button>`;
  body.appendChild(actions);

  const close = () => { el('details-sheet').hidden = true; };
  actions.querySelector('#details-cancel').onclick = close;
  actions.querySelector('#details-save').onclick = async () => {
    if (pickedStatus !== undefined) await applyStatus(books, pickedStatus, { quiet: true });
    if (dropping.size || adding.length) {
      for (const book of books) {
        const stored = (await store.get('books', book.id)) || book;
        const kept = tags.tagsOf(stored).filter((t) => !dropping.has(tags.tagKey(t)));
        const next = tags.uniqueTags([...kept, ...adding]);
        if (tags.sameTags(next, tags.tagsOf(stored))) continue;
        stored.tags = next;
        await store.put('books', stored);
      }
    }
    const chosen = folder.value;
    if (chosen !== undefined) {
      const clean = String(chosen).trim().replace(/^\/+|\/+$/g, '');
      for (const book of books) {
        const stored = (await store.get('books', book.id)) || book;
        stored.folder = clean;
        await store.put('books', stored);
      }
    }
    close();
    clearSelection();
    await refreshShelf();
    toast(await hiddenNote(books, `${books.length} books updated`), 5000);
  };

  el('details-sheet').hidden = false;
}

/** The tags used on the shelf, most used first: offered before the list. */
async function tagsInUse() {
  const books = (await store.all('books'))
    .filter((b) => !b.binnedAt && !b.importing && (!b.inVault || library.vaultUnlocked));
  return tags.usedTags(books);
}

/** An edition's tags, changed the way the leader's were: from `before` to `after`. */
function retag(book, after, before) {
  const gone = new Set(before.map(tags.tagKey));
  for (const tag of after) gone.delete(tags.tagKey(tag));
  const kept = tags.tagsOf(book).filter((t) => !gone.has(tags.tagKey(t)));
  return tags.uniqueTags([...kept, ...after]);
}

const escapeText = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Set the reading status of the selected books.
 *
 * More than finished-or-not: a book can be on hold or dropped, and those are
 * not the same as unread. Automatic puts it back to being worked out from
 * whether the book has been opened and finished, which is what it does until
 * someone says otherwise.
 */
/** Which edition of a bundled book to open. */
function openBundleSheet(members, { verb = null, run = null } = {}) {
  const list = el('bundle-list');
  list.innerHTML = '';
  // Asking which edition something is to be done to, or which to read.
  const heading = el('bundle-sheet').querySelector('.eyebrow');
  if (heading) {
    if (heading.dataset.plain == null) heading.dataset.plain = heading.textContent;
    heading.textContent = verb || heading.dataset.plain;
  }

  for (const book of members) {
    const row = document.createElement('button');
    // Language and format are what actually tell two editions apart.
    const marks = [book.lang ? book.lang.toUpperCase() : null, book.format]
      .filter(Boolean).join(' · ');
    row.innerHTML = `<span>${escapeText(library.displayTitle(book))}</span>`
      + `<span>${escapeText(marks)}</span>`;
    row.onclick = () => { el('bundle-sheet').hidden = true; (run || openBook)(book); };
    list.appendChild(row);
  }

  el('bundle-sheet').hidden = false;
}

/**
 * Join several volumes into one book.
 *
 * Shown in the order they will be joined, natural-sorted so volume 2 comes
 * before volume 10 — which plain text sorting gets backwards, and which is
 * the whole difference between a readable serial and a shuffled one.
 */
/**
 * Which way to take a built book apart.
 *
 * Undoing the join gives back what it was made from. Dividing cuts it
 * wherever you like, which is a different thing entirely -- and the one that
 * was unreachable.
 */
/* ── everything you can do to one book, where the book is ─────────────────
 *
 * All of it lived behind selecting a book on the shelf. So finding a book by
 * name and then wanting to move it, write it out or trim it meant leaving the
 * search, clearing the query and finding the same book again on a grid of
 * three hundred covers -- which is the opposite of what searching for it was
 * for.
 */
async function openBookMenu(book) {
  const sheet = el('folder-actions');
  el('folder-actions-name').textContent = library.displayTitle(book);

  const list = el('folder-actions-list');
  list.innerHTML = '';

  const choice = (text, note, run) => {
    const button = document.createElement('button');
    button.innerHTML = `<span>${escapeText(text)}</span><span>${escapeText(note)}</span>`;
    button.onclick = () => { sheet.hidden = true; run(); };
    list.appendChild(button);
  };

  choice('Open', 'Start reading', () => openBook(book));
  /* Its folder and its reading status are details of the book, and live
   * with the rest of them -- not as two more rows in a menu that was already
   * the longest thing on the screen. */
  choice('Details', 'Title, author, status, folder, cover', () => openDetails(book));
  choice('Take pages out', 'Credit pages, ads, afterwords', () => openRemove(book));
  // Offered unless the book is known to have no pictures at all.
  if (book.imageCount !== 0) {
    choice('Black out panels', 'Cover part of a picture, in the file itself', () => openRedactPick(book));
  }

  if (library.wasJoined(book) || book.builtFrom) {
    choice('Take apart', 'Undo the join, or divide it', () => offerTakeApart(book));
  } else {
    choice('Divide', 'Into parts of your own choosing', () => openDivide(book));
  }

  choice('Build onto this book', 'Add more files to the end of it', () => buildOnto(book));
  choice('Check for new chapters', book.webSources?.length
    ? 'List its website again, and add what it does not have yet'
    : 'From its contents page: add what it does not have yet',
  () => checkNewChapters(book));
  choice('Write out', 'As an EPUB, whole or smaller', () => askAboutExport(book));
  choice(book.coverBlur ? 'Show the cover' : 'Blur the cover', 'For a shelf read in public', async () => {
    await library.blurCovers([book.id], !book.coverBlur);
    await refreshShelf();
    toast(book.coverBlur ? 'Cover showing again' : 'Cover blurred');
  });
  choice('Delete', 'To the bin, where it can be put back', async () => {
    await library.binBooks([book.id]);
    await refreshShelf();
    toast(`“${library.displayTitle(book)}” moved to the bin`, 6000);
  });

  sheet.hidden = false;
}

/** The delete confirmation is shared, so it is put back the way it was. */
function resetConfirm() {
  el('confirm-yes').textContent = 'Delete';
  el('confirm-no').onclick = () => { el('confirm-bar').hidden = true; resetConfirm(); };
  el('confirm-yes').onclick = async () => {
    const ids = [...selectedIds()];
    el('confirm-bar').hidden = true;
    const moved = await library.binBooks(ids);
    clearSelection();
    toast(`${moved} book${moved === 1 ? '' : 's'} moved to the bin`, 6000);
  };
}

/* ── the bin ──────────────────────────────────────────────────────────────
 *
 * Deleting means "out of the way"; this is where "gone" happens. Nothing is
 * freed until it is deleted from here, which is what makes the first step
 * worth having.
 */
const binSelection = new Set();

async function renderBin() {
  const books = await library.binnedBooks();
  const body = el('bin-body');
  body.innerHTML = '';

  for (const id of [...binSelection]) {
    if (!books.some((book) => book.id === id)) binSelection.delete(id);
  }

  el('bin-eyebrow').textContent = books.length
    ? `${books.length} book${books.length === 1 ? '' : 's'} · still taking up room`
    : 'Nothing in here';
  el('bin-foot').hidden = !books.length;

  if (!books.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.style.lineHeight = '1.6';
    none.textContent = 'Books you delete wait here. They keep their place, their '
      + 'bookmarks and their pictures until they are deleted for good, so a '
      + 'mistap costs nothing.';
    body.appendChild(none);
    return;
  }

  const note = document.createElement('p');
  note.className = 'muted';
  note.style.cssText = 'font-size:12px;line-height:1.5;margin:0 0 10px';
  note.textContent = 'Tap to pick. Putting one back returns it to its folder with '
    + 'everything it had.';
  body.appendChild(note);

  const grid = document.createElement('div');
  grid.className = 'shelf find-shelf';
  for (const book of books) {
    const node = library.bookTile(book, () => {
      if (binSelection.has(book.id)) binSelection.delete(book.id);
      else binSelection.add(book.id);
      renderBin();
    });
    if (binSelection.has(book.id)) node.classList.add('selected');

    const when = document.createElement('span');
    when.className = 'tile-meta';
    when.textContent = sinceBinned(book.binnedAt);
    node.appendChild(when);
    grid.appendChild(node);
  }
  body.appendChild(grid);

  el('bin-count').textContent = binSelection.size
    ? `${binSelection.size} picked`
    : `${books.length} in the bin`;
  /* One bar, saying what it will do to: the picked books, or all of them.
   * There used to be an Empty at the top as well, doing what Delete for good
   * already did with nothing picked -- two buttons for one thing, at opposite
   * ends of the screen. */
  el('bin-restore-all').textContent = binSelection.size ? 'Put back' : 'Put all back';
  el('bin-destroy').textContent = binSelection.size ? 'Delete for good' : 'Empty bin';
  el('bin-destroy').disabled = false;
}

function sinceBinned(at) {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'Deleted today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** Which books an action in the bin applies to: the picked ones, or all. */
async function binTargets() {
  const books = await library.binnedBooks();
  return binSelection.size ? books.filter((book) => binSelection.has(book.id)) : books;
}

function wireBin() {
  el('bin-restore-all').onclick = async () => {
    const books = await binTargets();
    if (!books.length) return;
    const back = await library.restoreBooks(books.map((b) => b.id));
    binSelection.clear();
    await renderBin();
    await refreshShelf();
    toast(`${back} book${back === 1 ? '' : 's'} back on the shelf`, 5000);
  };

  el('bin-destroy').onclick = () => confirmDestroy(false);
}

/**
 * The irreversible step, asked for in the bar rather than a dialog.
 *
 * Said in full, because it is the only delete in the app that cannot be
 * undone and it has to read differently from the one that can.
 */
async function confirmDestroy(everything) {
  const books = everything ? await library.binnedBooks() : await binTargets();
  if (!books.length) return toast('The bin is empty');

  el('confirm-text').textContent = `Delete ${books.length} book${books.length === 1 ? '' : 's'} for good? `
    + 'This cannot be undone.';
  el('confirm-yes').textContent = 'Delete for good';
  el('confirm-bar').hidden = false;

  el('confirm-no').onclick = () => { el('confirm-bar').hidden = true; resetConfirm(); };
  el('confirm-yes').onclick = async () => {
    el('confirm-bar').hidden = true;
    resetConfirm();
    const finish = progress.start(`Deleting ${books.length} book${books.length === 1 ? '' : 's'}`);
    try {
      for (const [at, book] of books.entries()) {
        await library.destroyBooks([book.id]);
        finish.say(null, (at + 1) / books.length, `${at + 1} of ${books.length}`);
      }
    } finally {
      finish();
    }
    binSelection.clear();
    await renderBin();
    await refreshShelf();
    toast(`${books.length} book${books.length === 1 ? '' : 's'} deleted for good`, 6000, { kind: 'done' });
  };
}

function offerTakeApart(book) {
  const sheet = el('folder-actions');
  el('folder-actions-name').textContent = library.displayTitle(book);

  const list = el('folder-actions-list');
  list.innerHTML = '';

  const choice = (text, note, run) => {
    const button = document.createElement('button');
    button.innerHTML = `<span>${escapeText(text)}</span><span>${escapeText(note)}</span>`;
    button.onclick = () => { sheet.hidden = true; run(); };
    list.appendChild(button);
  };

  const from = book.builtFrom?.length || book.mergedFrom?.length || 0;
  choice('Undo the join', `Back into ${from} parts`, () => splitSelected(book));
  choice('Divide at chapters', 'Cut wherever you choose', () => openDivide(book, 'chapters'));
  choice('Divide at pages', 'Ignore the chapter boundaries', () => openDivide(book, 'pages'));
  /* Taking content out is the other direction entirely, and belongs here:
   * this is the sheet somebody opens when a book is not the shape they
   * wanted. */
  choice('Take pages out', 'Keep the book, lose the pages', () => openRemove(book, 'pages'));
  choice('Take chapters out', 'Afterwords, samples, notes', () => openRemove(book, 'chapters'));

  sheet.hidden = false;
}

/**
 * Start a build with a book already on the shelf as its first part.
 *
 * The series you have been reading for a year, and the new volume has just
 * come out. Building was files-only, so the only way to put one on the end
 * was to re-import all thirty -- which is why this exists where the book is
 * rather than in the workshop, where you would have to go and find it again.
 */
async function buildOnto(book) {
  if (build.hasBook(book.id)) {
    await show('workshop');
    return toast('That book is already in the build');
  }

  build.addBook(book);
  // Named after the book it is being built onto, unless a name has been typed.
  if (!buildTitleTouched && !el('build-title').value.trim()) {
    el('build-title').value = library.displayTitle(book);
    el('build-eyebrow').textContent = library.displayTitle(book);
  }
  clearSelection();
  renderWorkshop();
  await show('workshop');
  toast(`“${library.displayTitle(book)}” is the first part — go back to the shelf and tap what goes after it, in order`, 7000);
}

/** Take a joined book apart, and say what that actually did. */
async function splitSelected(book) {
  try {
    const { restored, kept } = await library.splitBook(book.id);
    clearSelection();
    await refreshShelf();
    // The two cases are different enough to be worth distinguishing: usually
    // the volumes were never gone, so nothing is rebuilt.
    toast(restored.length
      ? `Split back into ${restored.length + kept} volumes — ${restored.length} rebuilt`
      : `“${book.title}” removed; its ${kept} volumes were still on the shelf`, 7000);
  } catch (error) {
    toast(error.message || 'That book could not be split', 6000);
  }
}

/**
 * Write a book out as an EPUB.
 *
 * Saving goes to a folder the person picks; sending hands it to whatever app
 * will take it. Both are wanted, and only the second existed -- a backup
 * belongs somewhere findable, not in a chat thread.
 */
/**
 * Write several books out at once, as one file.
 *
 * Saving them individually would mean the system file picker opening once per
 * book, which for a shelf of twenty is twenty decisions to make about where
 * things go. One archive is one decision, and unpacks into the same files.
 */
async function exportMany(books) {
  const finish = progress.start(`Writing ${books.length} books`);
  const failed = [];
  const name = `${epub.safeName(commonTitle(books.map((b) => b.title)) || 'Books')}.zip`;

  /* One book at a time, straight into the archive.
   *
   * Every book used to be built and kept, then packed into a zip built whole
   * in memory, then sent: the entire batch held two or three times over at
   * the peak. With enough books Android shut the app down while its save
   * screen was open, and the export never arrived. Now each book is built,
   * written into the archive on disk, and let go before the next. */
  const sink = exportSink(name);
  const zip = zipWriter(sink.write);
  const used = new Set();

  try {
    for (const [at, book] of books.entries()) {
      finish.say(`Writing ${library.displayTitle(book)}`, null, `${at + 1} of ${books.length}`);
      try {
        let { blob, name: entry } = await epub.buildEpub(book.id, {
          onProgress: (fraction) => {
            finish.say(null, ((at + fraction * 0.8) / books.length));
          },
        });
        // Two books of the same name would otherwise replace each other.
        const base = entry;
        let n = 2;
        while (used.has(entry)) entry = base.replace(/\.epub$/i, ` (${n++}).epub`);
        used.add(entry);
        await zip.add(entry, blob, (fraction) => {
          finish.say(null, ((at + 0.8 + fraction * 0.2) / books.length));
        });
        blob = null;
      } catch (error) {
        if (error.writeFailed) throw error;
        // One book that will not write costs that book, not the batch.
        failed.push({ title: library.displayTitle(book), reason: error.message });
      }
    }

    if (!used.size) {
      throw new Error(failed[0] ? `${failed[0].title}: ${failed[0].reason}` : 'Nothing could be written');
    }

    await zip.finish();
    await sink.done('application/zip');

    clearSelection();
    await refreshShelf();
    toast(failed.length
      ? `${books.length - failed.length} written · ${failed.length} skipped — ${failed[0].title}: ${failed[0].reason}`
      : `${books.length} books written out — choose where to save them`, 7000, { kind: 'done' });
  } catch (error) {
    finish.fail();
    toast(error.message || 'Those books could not be written out', 6000, { kind: 'failed' });
  } finally {
    finish();
  }
}

/**
 * Where an archive being written goes: a file on the native side, in pieces
 * of a few megabytes, or -- in an ordinary browser with no native side -- a
 * download made of the same pieces.
 */
function exportSink(name) {
  const startedReading = inBook;
  const bridge = window.GrimoireNative;
  const native = !!bridge?.beginExport;
  const handle = native ? bridge.beginExport(name) : null;
  if (native && !handle) throw new Error('There was nowhere to write the file');

  const held = [];
  let heldBytes = 0;
  const kept = [];             // the browser's download, which has to be whole

  const flush = () => {
    if (!heldBytes) return;
    const piece = new Uint8Array(heldBytes);
    let at = 0;
    for (const part of held) { piece.set(part, at); at += part.length; }
    held.length = 0;
    heldBytes = 0;
    if (!native) { kept.push(piece); return; }
    if (!bridge.appendExport(handle, base64Of(piece))) {
      const error = new Error('The file could not be written — the phone may be out of space');
      error.writeFailed = true;
      throw error;
    }
  };

  return {
    async write(bytes) {
      held.push(bytes);
      heldBytes += bytes.length;
      if (heldBytes >= EXPORT_CHUNK) {
        flush();
        // A breath, so the progress bar paints and the app answers taps.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    async done(mimeType, share = false) {
      flush();
      // Android's save screen, not over a page being read.
      await untilNotReading(startedReading);
      if (native) { bridge.finishExport(handle, mimeType, share); return; }
      const url = URL.createObjectURL(new Blob(kept, { type: mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },
  };
}

/* Remembered between exports, not between sessions.
 *
 * Writing out a series is one book after another at the same size; having to
 * choose again each time is the kind of small friction that makes people stop
 * at volume three. It resets on launch because full size is what an export
 * should mean when nobody has said otherwise. */
let exportSize = 'full';

/** Ask what the book should be called before writing it out. */
function askAboutExport(book) {
  el('export-title').value = library.displayTitle(book);
  el('export-author').value = book.author || '';
  el('export-file').value = `${epub.safeName(library.displayTitle(book))}.epub`;

  // A title typed here is what the book will be called; the file name follows
  // along unless it has been changed by hand.
  let fileTouched = false;
  el('export-file').oninput = () => { fileTouched = true; };
  el('export-title').oninput = () => {
    if (!fileTouched) el('export-file').value = `${epub.safeName(el('export-title').value)}.epub`;
  };

  /* How big the pictures come out.
   *
   * Full size is the default and stays the default: a smaller copy is a
   * choice somebody makes for a reason -- sending it, keeping thirty volumes
   * -- and quietly shrinking an export would be throwing away detail nobody
   * asked to lose. */
  const row = el('export-size');
  row.innerHTML = '';
  for (const [key, size] of Object.entries(shrink.SIZES)) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = `<b>${escapeText(size.label)}</b>`;
    chip.title = size.note;
    chip.setAttribute('aria-pressed', String(exportSize === key));
    chip.onclick = () => { exportSize = key; askAboutExport(book); };
    row.appendChild(chip);
  }

  const which = shrink.SIZES[exportSize] || shrink.SIZES.full;
  const note = document.createElement('span');
  note.className = 'muted';
  note.style.cssText = 'font-size:11px;align-self:center;margin-left:4px';
  note.textContent = which.note;
  row.appendChild(note);

  const go = (share) => () => {
    el('export-sheet').hidden = true;
    exportBook(book, {
      share,
      title: el('export-title').value.trim() || book.title,
      author: el('export-author').value.trim() || null,
      filename: el('export-file').value.trim(),
      size: exportSize,
    });
  };
  el('export-save').onclick = go(false);
  el('export-send').onclick = go(true);
  el('export-sheet').hidden = false;
}

async function exportBook(book, { share = false, title, author, filename, size } = {}) {
  const finish = progress.start(`Writing ${book.title}`);
  try {
    const { blob, name, saved } = await epub.buildEpub(book.id, {
      title,
      author,
      size,
      onProgress: (fraction, message) => finish.say(message, fraction * 0.9),
    });
    const saveAs = filename && /\.epub$/i.test(filename) ? filename : name;
    await writeOut(blob, saveAs, 'application/epub+zip', {
      share,
      onProgress: (fraction) => finish.say(null, 0.9 + fraction * 0.1),
    });

    /* What it came out as, when it is not what the book is.
     *
     * A smaller copy is the one export whose result is not obvious from the
     * file name, and the saving is the whole reason it was asked for. */
    const smaller = size && size !== 'full'
      ? ` · ${shrink.describeSize(size)}${saved ? `, ${shrink.describeSaving(saved)} smaller` : ''}`
      : '';
    if (share) toast(`${saveAs} ready to send${smaller}`, 5000, { kind: 'done' });
    else if (smaller) toast(`${saveAs} written${smaller}`, 5000, { kind: 'done' });
  } catch (error) {
    finish.fail();
    toast(error.message || 'That book could not be written out', 6000, { kind: 'failed' });
  } finally {
    finish();
  }
}

async function openMergeSheet() {
  const books = await selectedBooks();
  if (books.length < 2) return toast('Pick two or more books to join');

  const ordered = [...books].sort((a, b) => library.naturalOrder(a.title, b.title));

  const list = el('merge-list');
  list.innerHTML = '';
  ordered.forEach((book, at) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.pointerEvents = 'none';
    row.innerHTML = `<span class="body"><b>${at + 1}. ${escapeText(library.displayTitle(book))}</b></span>`;
    list.appendChild(row);
  });

  // A sensible name, from what the volumes have in common.
  el('merge-title').value = commonTitle(ordered.map((b) => b.title)) || ordered[0].title;

  el('merge-go').onclick = async () => {
    el('merge-sheet').hidden = true;
    const finish = progress.start('Joining');
    try {
      const made = await library.mergeBooks(ordered.map((b) => b.id), {
        title: el('merge-title').value.trim() || ordered[0].title,
        onProgress: finish.step,
      });
      clearSelection();
      await refreshShelf();
      toast(`Joined into “${made.title}” — ${made.chapters} chapters`, 6000, { kind: 'done' });
    } catch (error) {
      finish.fail();
      toast(error.message || 'Those books could not be joined', 6000, { kind: 'failed' });
    } finally {
      finish();
    }
  };

  el('merge-sheet').hidden = false;
}

/**
 * What a set of titles have in common, as a name for the whole.
 *
 * "Witch City Vol. 1" and "Witch City Vol. 2" should suggest "Witch City"
 * rather than the first one's full name.
 */
function commonTitle(titles) {
  if (!titles.length) return null;
  const words = titles.map((t) => String(t).split(/\s+/));
  const shared = [];
  for (let i = 0; i < words[0].length; i++) {
    const word = words[0][i];
    if (!words.every((w) => w[i] === word)) break;
    shared.push(word);
  }
  // Trailing "Vol." or "Volume" belongs to the part that differs.
  while (shared.length && /^(vol\.?|volume|part|book|#|-|—)$/i.test(shared[shared.length - 1])) {
    shared.pop();
  }
  return shared.join(' ').trim() || null;
}

/**
 * What can be done to a whole folder.
 *
 * Two of these are ordinary and one is not, so they are not presented as
 * three equal choices: deleting says how many books it will destroy, and asks
 * again before it does.
 */
async function openFolderActions(folder, label, count) {
  const sheet = el('folder-actions');
  el('folder-actions-name').textContent = `${label} · ${count} book${count === 1 ? '' : 's'}`;

  const list = el('folder-actions-list');
  list.innerHTML = '';

  const choice = (text, note, run) => {
    const button = document.createElement('button');
    button.innerHTML = `<span>${escapeText(text)}</span><span>${escapeText(note || '')}</span>`;
    button.onclick = run;
    list.appendChild(button);
    return button;
  };

  choice('Open it', 'Filter the shelf to this folder', () => {
    sheet.hidden = true;
    openFolder(folder);
  });

  choice('Take the books out', 'They stay in the library, unfiled', async () => {
    sheet.hidden = true;
    const books = (await store.all('books')).filter((b) => (b.folder || '') === folder);
    for (const book of books) {
      delete book.folder;
      await store.put('books', book);
    }
    // The folder is gone; a later one of the same name starts on the shelf.
    if (by === folder) await library.setFolderHidden(folder, false);
    if (activeFolder === folder) await openFolder(null);
    await refreshShelf();
    await panels.openFolders(openFolder);
    toast(`${books.length} book${books.length === 1 ? '' : 's'} taken out of “${label}”`);
  });

  /* Off the shelf, or back on it. A folder inside a hidden one is hidden by
   * that one, so the choice offered is the one that would change anything. */
  const hidden = library.hiddenFolderList(await store.settings());
  const by = library.hiddenBy(folder, hidden);
  if (folder) {
    const target = by || folder;
    const showing = !by;
    choice(
      showing ? 'Hide from the shelf' : by === folder ? 'Show on the shelf' : `Show “${by}” on the shelf`,
      showing ? 'Its books are only found here, under Folders'
        : by === folder ? 'Its books go back on the shelf'
        : `Hidden because it is inside “${by}”`,
      async () => {
        sheet.hidden = true;
        await library.setFolderHidden(target, showing);
        await refreshShelf();
        await panels.openFolders(openFolder);
        toast(showing ? `“${label}” is off the shelf. Open it from Folders.` : `“${target}” is back on the shelf`);
      });
  }

  choice('Blur every cover', 'Hide what is on them, on this shelf only', async () => {
    sheet.hidden = true;
    const books = await library.booksInFolder(folder);
    const changed = await library.blurCovers(books.map((b) => b.id), true);
    await refreshShelf();
    toast(`${changed} cover${changed === 1 ? '' : 's'} blurred in “${label}”`);
  });

  choice('Show every cover', 'Undo it for this folder', async () => {
    sheet.hidden = true;
    const books = await library.booksInFolder(folder);
    const changed = await library.blurCovers(books.map((b) => b.id), false);
    await refreshShelf();
    toast(`${changed} cover${changed === 1 ? '' : 's'} showing again`);
  });

  const remove = choice(`Delete all ${count}`, 'The books themselves, permanently', async () => {
    // Asked twice, because there is no undo and a folder can hold a lot.
    remove.innerHTML = `<span>Really delete ${count} book${count === 1 ? '' : 's'}?</span>`
      + '<span>Tap again</span>';
    remove.onclick = async () => {
      sheet.hidden = true;
      const books = (await store.all('books')).filter((b) => (b.folder || '') === folder);

      const finish = progress.start(`Deleting ${label}`);
      try {
        for (const [at, book] of books.entries()) {
          await library.binBooks([book.id]);
          finish.say(null, (at + 1) / books.length, `${at + 1} of ${books.length}`);
        }
      } finally {
        finish();
      }

      if (by === folder) await library.setFolderHidden(folder, false);
      if (activeFolder === folder) await openFolder(null);
      await refreshShelf();
      await panels.openFolders(openFolder);
      toast(`${books.length} book${books.length === 1 ? '' : 's'} deleted`, 4000, { kind: 'done' });
    };
  });
  remove.classList.add('danger');

  sheet.hidden = false;
}

/** A book filed into a hidden folder disappears from the shelf; say where. */
async function hiddenNote(books, said) {
  if (activeFolder != null) return said;
  const hidden = library.hiddenFolderList(await store.settings());
  const fresh = await Promise.all(books.map((b) => store.get('books', b.id)));
  const off = fresh.filter((b) => b && library.offShelf(b, hidden));
  if (!off.length) return said;
  const where = library.hiddenBy(off[0].folder, hidden);
  return `${said}. ${off.length === 1 ? 'It is' : `${off.length} are`} in “${where}”, hidden from the shelf`;
}

/**
 * Set a status by hand, once.
 *
 * It holds until the book is next read, and then the reading takes over
 * (store.markRead). So the dates are made to agree with it: what the reading
 * says afterwards carries on from what was set -- a book marked finished
 * stays finished when it is next opened, instead of the mark simply being
 * forgotten.
 */
function setStatusOn(book, status) {
  if (status === null) delete book.status;
  else book.status = status;
  // Set by hand now, whatever put it there before.
  delete book.heldAt;
  delete book.heldAutomatically;
  if (status === 'finished') { book.finishedAt = book.finishedAt || Date.now(); book.percent = 1; }
  if (status === 'reading' || status === 'unread') book.finishedAt = null;
  if (status === 'unread') book.percent = 0;
  // Read on from here, even in the book already open, and the reading says.
  reader.noteStatusSet(book.id);
}

async function applyStatus(books, status, { quiet = false } = {}) {
  for (const book of books) {
    setStatusOn(book, status);
    await store.put('books', book);
  }
  if (quiet) return;
  clearSelection();
  toast(status === null
    ? `${books.length} book${books.length === 1 ? '' : 's'} back to automatic`
    : `${books.length} marked ${library.STATUS_LABELS[status].toLowerCase()}`);
}

/* ── import ───────────────────────────────────────────────────────────── */

function pickFiles() {
  // The shell turns this into the system document picker, multi-select.
  el('file-input').click();
}

/* ── a bar for every operation ───────────────────────────────────────────
 *
 * There is one panel and there was never one operation. Importing, building,
 * dividing, exporting, deleting a folder and writing a backup all use it.
 * The first version hid it when any of them finished, taking the bar away
 * from the others; the second counted them, but could only show one, so two
 * builds at once read as "2 things at once" with no bar at all -- no way to
 * tell which was nearly done and which had stalled.
 *
 * So each operation gets a row of its own: its name, how far along, and a
 * bar. The panel is up while any row is. A finished row stays for a moment
 * marked done, rather than vanishing mid-glance, so you see it complete.
 */
const progress = (() => {
  const jobs = [];
  let counter = 0;

  const panel = () => el('import-progress');
  const list = () => el('jobs');

  /** At most this many rows; the rest are counted. A phone has no room for a
   *  dozen bars, and nobody is watching a dozen. */
  const SHOWN = 4;

  function paint() {
    const host = panel();
    if (!host) return;
    const live = jobs.filter((job) => !job.ended);
    host.hidden = jobs.length === 0;
    if (!jobs.length) host.classList.remove('minimised');

    // The summary for when the panel is minimised, or there are more rows
    // than room.
    const summary = el('jobs-summary');
    if (summary) {
      summary.textContent = live.length > 1
        ? `${live.length} running`
        : live.length === 1 ? `${Math.round((live[0].fraction || 0) * 100)}%` : 'Done';
    }
    const more = el('jobs-more');
    if (more) {
      const hidden = jobs.length - SHOWN;
      more.hidden = hidden <= 0;
      more.textContent = hidden > 0 ? `+${hidden} more running` : '';
    }
    jobs.forEach((job, at) => { job.row.hidden = at >= SHOWN; });
  }

  function makeRow(label) {
    const row = document.createElement('div');
    row.className = 'job';
    row.innerHTML = '<div class="import-line"><span class="job-label"></span>'
      + '<span class="muted job-count"></span></div>'
      + '<span class="bar"><span class="bar-fill" style="width:0%"></span></span>'
      + '<div class="job-activity" hidden><span class="job-tag"></span><span class="job-now"></span></div>';
    row.querySelector('.job-label').textContent = label || 'Working';
    list()?.appendChild(row);
    return row;
  }

  function start(label) {
    // Minimising is the panel's, not any one import's, so it is wired once.
    const minimise = el('import-minimise');
    if (minimise && !minimise.onclick) {
      minimise.onclick = () => panel()?.classList.toggle('minimised');
    }

    const job = { id: ++counter, label: label || 'Working', fraction: 0, ended: false };
    job.row = makeRow(job.label);
    jobs.push(job);
    paint();

    /** What this operation is doing now. Each row says only its own. */
    const say = (message, fraction, count) => {
      if (job.ended) return;
      if (message) {
        job.label = message;
        job.row.querySelector('.job-label').textContent = message;
      }
      if (fraction != null && Number.isFinite(fraction)) {
        job.fraction = Math.max(0, Math.min(1, fraction));
        job.row.querySelector('.bar-fill').style.width = `${Math.round(job.fraction * 100)}%`;
      }
      if (count != null) job.row.querySelector('.job-count').textContent = count;
      paint();
    };

    /**
     * End it. Callable once; the closure is the only way to end a row, so a
     * count cannot drift and one operation cannot take down another's bar.
     *
     * @param failed  marks the row as having failed rather than finished.
     */
    /**
     * What it is doing right now, on a line of its own under the bar -- not
     * mixed into how far it has got. { kind: 'wait' | 'read' | 'retry' |
     * 'failed', name, until, attempt, of, reason }, or null for nothing.
     */
    const activity = (now) => {
      if (job.ended) return;
      clearInterval(job.ticker);
      const line = job.row.querySelector('.job-activity');
      if (!now) { line.hidden = true; return; }
      const tag = line.querySelector('.job-tag');
      const what = line.querySelector('.job-now');
      line.className = `job-activity ${now.kind}`;
      const name = now.name || 'the next page';
      const paint = () => {
        if (now.kind === 'wait') {
          const left = Math.max(0, Math.ceil((now.until - Date.now()) / 1000));
          tag.textContent = 'Waiting';
          what.textContent = `${left} s left ${now.why ? `· ${now.why}` : 'of your delay'}, then ${name}`;
        } else if (now.kind === 'retry') {
          tag.textContent = `Try ${now.attempt} of ${now.of}`;
          what.textContent = `${name}${took()}${now.reason ? ` · last time: ${now.reason}` : ''}`;
        } else if (now.kind === 'failed') {
          tag.textContent = 'Failed';
          what.textContent = `${name} · ${now.reason || 'it did not come'} — trying again`;
        } else {
          tag.textContent = 'Reading';
          what.textContent = `${name}${took()}`;
        }
      };
      // How long this read has taken so far: what "reading takes long" is.
      const took = () => (now.since ? ` · ${Math.max(0, Math.round((Date.now() - now.since) / 1000))} s` : '');
      paint();
      if (now.kind === 'wait' || now.since) job.ticker = setInterval(paint, 1000);
      line.hidden = false;
    };

    const end = (failed = false) => {
      if (job.ended) return;
      clearInterval(job.ticker);
      job.ended = true;
      job.row.classList.add(failed ? 'failed' : 'done');
      if (!failed) job.row.querySelector('.bar-fill').style.width = '100%';
      paint();
      // Left up briefly, marked, so a finish is seen rather than inferred
      // from a row that has gone.
      setTimeout(() => {
        const at = jobs.indexOf(job);
        if (at !== -1) jobs.splice(at, 1);
        job.row.remove();
        paint();
      }, failed ? 2400 : 900);
    };

    // Called as a function, as every caller already does; and with say and
    // step on it for routing progress to this row and no other.
    const handle = () => end(false);
    handle.say = say;
    handle.activity = activity;
    handle.step = (message, fraction) => say(message, fraction);
    handle.fail = () => end(true);
    handle.end = end;
    return handle;
  }

  /** The newest live row, for anything that reports without a handle. */
  const newest = () => [...jobs].reverse().find((job) => !job.ended);

  return {
    start,
    get running() { return jobs.filter((job) => !job.ended).length; },
    /* Kept for callers outside an operation: they speak for the newest
     * row, which is the one they started. */
    say: (message, fraction, count) => {
      const job = newest();
      if (!job) return;
      if (message) job.row.querySelector('.job-label').textContent = message;
      if (fraction != null) job.row.querySelector('.bar-fill').style.width = `${Math.round(fraction * 100)}%`;
      if (count != null) job.row.querySelector('.job-count').textContent = count;
    },
  };
})();

/* ── a file the page is not allowed to read ──────────────────────────────
 *
 * "The requested file could not be read, typically due to permission problems
 * that have occurred after a reference to a file was acquired." That sentence
 * is Chromium's, and on Android it means one specific thing: the renderer was
 * refused the file descriptor behind the content:// URI the picker handed
 * over. It is a separate sandboxed process, and whether it inherits a usable
 * descriptor depends on the provider the file came from -- a download that is
 * still a placeholder, a provider that grants to the activity and not to the
 * renderer, a file picked through Recents whose grant has already lapsed.
 *
 * The app's own process can almost always still read it, because the grant is
 * held by the activity. So the file is read there instead and served back
 * over this origin, which is an ordinary fetch with no provider in the way.
 *
 * Checked before importing rather than after it fails. A one-byte read proves
 * the descriptor is usable, costs nothing, and means a book is either
 * importable or rescued before any work is done on it -- rather than failing
 * part-way through a two-hundred-chapter archive.
 */

const staging = new Map();
let stageCounter = 0;

/** Called from Java when a rescued file has been staged. Not a reader API. */
function settleFile(id, ok, payload) {
  const entry = staging.get(id);
  if (!entry) return;
  staging.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(payload || 'That file could not be read'));
}

const canStage = () => typeof window.GrimoireNative?.stageForRead === 'function';

function stageForRead(file) {
  return new Promise((resolve, reject) => {
    const id = `s${++stageCounter}`;
    // A copy that never answers would hang the import for good. Generous,
    // because the file being rescued may be a very large archive.
    const timer = setTimeout(() => {
      staging.delete(id);
      reject(new Error('That file took too long to read'));
    }, 180000);
    staging.set(id, { resolve, reject, timer });
    try {
      window.GrimoireNative.stageForRead(id, file.name, file.size || 0);
    } catch (error) {
      staging.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * A copy of a file the page was refused, read by the shell instead.
 *
 * Handed to the importer and used only when a read actually fails. This
 * used to be a check of every file before the import began: one read per
 * file, in turn, before the first book was started -- which for a few
 * hundred files picked from a slow provider was a long wait spent proving
 * that files were readable when nearly all of them were.
 */
const refused = new Map();

async function rescueFile(file, job = null) {
  if (!canStage()) {
    refused.set(file.name, 'Android would not let the app read it');
    throw Object.assign(new Error('Android would not let the app read it'), { name: 'NotReadableError' });
  }
  try {
    (job || progress).say(`Reading ${file.name} another way`);
    const url = await stageForRead(file);
    const copy = await fetch(url);
    if (!copy.ok) throw new Error(`could not fetch the staged copy (${copy.status})`);
    const blob = await copy.blob();
    /* The same file, or nothing. The shell finds the file by its name and
     * size; a copy that comes back a different size is some other file, and
     * imported under this one's name it was a duplicate of a book already
     * on the shelf wearing the wrong title. */
    if (file.size > 0 && blob.size !== file.size) {
      throw new Error('the copy Android handed back was a different file');
    }
    return new File([blob], file.name, { type: file.type || blob.type });
  } catch (error) {
    /* Remembered by name so the failure is reported as what it was. Left to
     * the parser, a file nothing could read fails again further in as a
     * "corrupted zip" -- about a file that is not corrupt and was never
     * read. */
    refused.set(file.name, error.message || 'it could not be read');
    throw error;
  }
}

/**
 * A reason somebody can act on, where the browser gives one nobody can.
 *
 * "The requested file could not be read, typically due to permission problems
 * that have occurred after a reference to a file was acquired" is accurate
 * and useless: it names no cause the person controls and suggests nothing to
 * do. By the time it is shown the shell has already tried to read the file
 * itself and failed too, so the honest next step is a copy of the file
 * somewhere ordinary.
 */
function plainReason(reason) {
  const text = String(reason || '');
  if (/could not be read|NotReadableError|permission problems/i.test(text)) {
    return 'Android would not let the app read it. If it is in Downloads or '
      + 'came straight from another app, copy it into a folder of your own '
      + 'and pick it from there.';
  }
  return text;
}

/* ── one import at a time ─────────────────────────────────────────────────
 *
 * Picking a second folder while the first was still importing started a
 * second import alongside it. The two fought over the same storage, the same
 * memory and -- worst -- the same record of what had been picked, and the
 * first was the one that lost: its remaining files could no longer be read
 * and the whole of it failed. And both checked for duplicates before either
 * had written anything, so picking the same folder again in the meantime
 * imported it twice.
 *
 * So imports queue. A pick made while one is running gets its own bar at
 * once, saying it is waiting, and starts when the one before it finishes --
 * and by then the one before it has written everything it was going to, so
 * the duplicate check sees it.
 */
let importQueue = Promise.resolve();
let importsWaiting = 0;

function handleFiles(files, options = {}) {
  if (!files.length) return Promise.resolve();
  const job = progress.start(importsWaiting ? 'Waiting for the import before it' : 'Opening…');
  if (importsWaiting) {
    job.say(null, 0, `${files.length} file${files.length === 1 ? '' : 's'} queued`);
  }
  importsWaiting += 1;
  /* Into the folder the shelf is open at, as it is when the import is asked
   * for: a folder left while the import waits its turn does not change where
   * these books were meant to go. */
  const into = options.transient ? '' : (activeFolder || '');
  const run = importQueue.then(() => importNow(files, { ...options, into }, job));
  // The next one waits for this to finish, however it finishes.
  importQueue = run.catch(() => {}).then(() => { importsWaiting -= 1; });
  return run;
}

async function importNow(files, { transient = false, into = '' } = {}, done) {
  // Its report waits for the book to be put down, unless it was asked for
  // from inside one -- a file opened from another app, say.
  const startedReading = inBook;
  const say = (...args) => whenNotReading(() => toast(...args), startedReading);
  done.say('Opening…', 0, '');

  /* The shelf is refreshed as books land rather than only at the end, so an
     import can be watched -- and used -- while it runs. Not per book: on a
     large shelf that is a redraw a second competing with the parsing. */
  let shownAt = 0;

  /* Taken down in a finally, not on the line after the import.
   *
   * An import that threw -- a corrupt archive, storage full -- left the panel
   * up forever, which with the count behind it now would also hold it up for
   * every later operation. */
  let results;
  refused.clear();
  try {
    results = await library.importFiles(files, {
      transient,
      into,
      // Anything the page is not allowed to read is read by the shell
      // instead -- but only when a read is actually refused.
      rescue: (file) => rescueFile(file, done),
      onProgress: (message, fraction, at, total) => {
        done.say(message, fraction || 0, total > 1 ? `${at + 1} of ${total}` : '');

        /* Only while the shelf is what is on screen. Redrawing a shelf
         * nobody is looking at, every three seconds, competes with the
         * import for the same thread -- and redraws a little more each
         * time. */
        if (current === 'library' && Date.now() - shownAt > 3000) {
          shownAt = Date.now();
          refreshShelf();
        }
      },
    });
  } finally {
    done();
  }
  await refreshShelf();

  /* What was skipped, said rather than counted as nothing.
   *
   * "0 books added" with a tick read as an import that had broken, when
   * every book in the zip was simply on the shelf already. */
  const besides = [
    results.already ? `${results.already} already on your shelf` : null,
    results.inVault ? `${results.inVault} already in the Vault` : null,
    results.replaced ? `${results.replaced} replaced ${results.replaced === 1 ? 'its copy' : 'their copies'} in the Bin` : null,
    results.reread ? `${results.reread} read again and split properly, replacing the copy that froze` : null,
    results.restored ? `${results.restored} given back what your backup held for ${results.restored === 1 ? 'it' : 'them'}` : null,
  ].filter(Boolean).join(' · ');
  const note = besides ? ` · ${besides}` : '';

  if (results.failed.length) {
    // A parse failure is confined to its own file; the rest of the batch
    // still lands, and the reason is shown rather than swallowed.
    /* The first failure, with the reason that actually applies.
     *
     * A file nothing could read fails again inside the parser, which reports
     * what it made of nothing rather than why there was nothing -- so the
     * refusal wins where there was one. */
    const first = results.failed[0];
    const why = refused.get(first.name);
    // Failed only if nothing at all came of it; some books in and one refused
    // is a finish with a note, not a failure.
    say(`${results.added} added${note} · ${first.name}: ${
      why ? plainReason(why) : plainReason(first.reason)}`, 8000,
    { kind: results.added ? 'done' : 'failed' });
  } else if (!results.added && besides) {
    // Nothing new, and nothing wrong: not a failure, and not a tick either.
    say(`Nothing new to add · ${besides}`, 7000);
  } else {
    const folders = results.folders?.size || 0;
    const seconds = (results.elapsedMs || 0) / 1000;
    const each = results.added ? seconds / results.added : 0;
    // The time is part of the result. Without it there is no way to tell
    // whether a change to the importer helped, and no way to say where the
    // time actually went on a real phone.
    const took = seconds > 2 ? ` · ${seconds.toFixed(0)}s, ${each.toFixed(1)}s a book` : '';
    const one = results.added === 1 && results.titles?.[0];
    // Where they went, when that was the folder the shelf is open at.
    const where = into ? ` to “${into}”` : '';
    say((one
      ? `Added “${one}”${where}${took}`
      : folders
        ? `${results.added} book${results.added === 1 ? '' : 's'} added${where} across ${folders} folder${folders === 1 ? '' : 's'}${took}`
        : `${results.added} book${results.added === 1 ? '' : 's'} added${where}${took}`) + note, 6000, { kind: 'done' });
  }

  /* A zip whose index was damaged, read from the front instead. What came
   * of it is in the count above; this says why it might not be everything. */
  const [rescued] = results.recovered || [];
  if (rescued) {
    say(`“${rescued.name}” was damaged at the end, so its ${rescued.books} complete book${
      rescued.books === 1 ? ' was' : 's were'} read from the front of it. Anything that was cut off is not included.`, 10000);
  }

  /* A file that was ruined before it arrived, said plainly and on its own.
   *
   * Its characters were lost when something saved it in the wrong encoding,
   * so it imports as a page of question marks -- which looks exactly like a
   * reader that cannot read Chinese, unless it is told otherwise. */
  const [damaged] = results.damaged || [];
  if (damaged) {
    say(`“${damaged}” was already damaged before it reached the app — most of its characters `
      + 'were lost when it was saved in the wrong encoding. A fresh copy of the file should read properly.', 12000);
  }

  /* A web novel saved a page per chapter is imported as it came -- a book per
   * page -- and Build is where those become one book. Said once, as its own
   * line, so it is not mistaken for part of the result. */
  const [run] = results.chapterRuns || [];
  if (run && results.added) {
    const more = results.chapterRuns.length - 1;
    say(`“${run.title}” came as ${run.count} chapter files${
      more ? ` (and ${more} more like it)` : ''} — Build can join them into one book`, 9000);
  }

  return results;
}

/* ── reader wiring ────────────────────────────────────────────────────── */

/** The reader emptied for a book about to open: its name, and no page yet. */
function blankReader(book) {
  reader.blank();
  el('reader-book').textContent = library.displayTitle(book) || book.title || '';
  el('reader-pos').textContent = '';
  el('progress-fill').style.width = '0%';
  el('progress-knob').style.left = '0%';
  el('progress-pct').textContent = '';
  el('progress-page').textContent = '';
}

function paintReader() {
  const state = reader.state;
  if (!state.book) return;
  settleGreyMix(state.book);
  el('reader-book').textContent = state.book.title;
  const name = reader.chapterName(state.chapterIndex);
  const within = state.mode === 'scroll'
    ? `screen ${state.page + 1}/${state.pageCount}`
    : `p. ${state.page + 1}/${state.pageCount}`;
  // Only the chapter name is tinted: the page numbers beside it are not a
  // translation of anything.
  const shownName = reader.isTranslatedName(state.chapterIndex)
    ? `<span class="translated-text">${escapeText(name)}</span>`
    : escapeText(name);
  el('reader-pos').innerHTML =
    `${shownName} · ${within} · `
    + `${reader.pageInBook()} of ${state.totalPages} · ${Math.round(reader.percent() * 100)}%`;

  const pct = reader.percent();
  // Not while the bar is being dragged: it shows where the finger is.
  if (!barDragging) {
    el('progress-fill').style.width = `${pct * 100}%`;
    el('progress-knob').style.left = `${pct * 100}%`;
    el('progress-pct').textContent = `${Math.round(pct * 100)}%`;
  }
  el('progress-page').textContent = `p. ${reader.pageInBook()}`;
  // A new place in the book moves the copy icon's circles.
  const place = `${state.book.id}:${state.chapterIndex}:${reader.pageInBook()}`;
  if (place !== copyIconAt) {
    if (copyIconAt) { moveCopyIconKnobs(); drawOcrPanels(); }
    copyIconAt = place;
    syncOverlay();
  }
  // Only where there are pictures to read.
  el('ocr-btn').hidden = !(state.images && state.images.size);
  const thumb = el('scrub-thumb');
  const fraction = reader.scrollFraction();
  const ratio = Math.max(0.06, Math.min(1, reader.viewportRatio()));
  if (state.mode === 'scroll') {
    // A proportional handle, positioned so it never overruns the rail.
    thumb.style.height = `${ratio * 100}%`;
    thumb.style.top = `${fraction * (100 - ratio * 100)}%`;
  } else {
    thumb.style.height = '';
    thumb.style.top = `${fraction * 100}%`;
  }
  document.body.dataset.mode = state.mode;

  el('chapter-prev').disabled = !reader.hasPrevChapter();
  el('chapter-next').disabled = !reader.hasNextChapter();
  store.settings().then(paintChapterPad);
  refreshBookmarkState();
  refreshKeepButton();
  refreshTranslateButton();
}

/** Re-checked on every paint, so turning body translation on in settings does
 *  not require closing and reopening the book. */
/**
 * A book that is only passing through says so, and offers to stay.
 *
 * Without this it would be indistinguishable from one in the library right up
 * until it vanished.
 */
function refreshKeepButton() {
  const book = reader.state.book;
  const keep = el('keep-book');
  keep.hidden = !book?.transient;
  keep.onclick = async () => {
    delete book.transient;
    const stored = await store.get('books', book.id);
    if (stored) delete stored.transient;
    await store.put('books', stored || book);
    keep.hidden = true;
    await refreshShelf();
    toast('Kept in your library');
  };
}

async function refreshTranslateButton() {
  const settings = await store.settings();
  el('translate-chapter').hidden =
    !(settings.translateBody && translate.status().configured);
}

async function refreshBookmarkState() {
  const state = reader.state;
  if (!state.book) return;
  const marks = await store.byIndex('marks', 'bookId', state.book.id);
  // Fills when the current page carries a mark.
  const here = marks.some((m) => m.kind === 'bookmark'
    && m.chapterIndex === state.chapterIndex
    && Math.abs(m.anchor - state.anchor) < 400);
  el('bookmark-btn').setAttribute('aria-pressed', String(here));
}

function goToChapter({ chapter, anchor = 0 }) {
  back();
  if (current !== 'reader') show('reader');
  reader.goTo({ chapter, anchor });
}

async function goToMatch(hit) {
  if (hit.bookId) {
    const book = await store.get('books', hit.bookId);
    return openBook(book);
  }
  back();
  if (current !== 'reader') await show('reader');
  await reader.goTo({ chapter: hit.chapter, anchor: hit.anchor, flash: true });
}

/* ── coming back to a book that changed ─────────────────────────────────
 *
 * Taking pages out of the book being read changes it under the reader. It
 * is reopened when it is next shown -- at the saved place, which the removal
 * has already moved with the pages -- and where a picture was on screen, at
 * that picture, or the one after it if that was the page taken out.
 */
let readerStale = null;     // { bookId, land: href | null }
let readerLanding = null;   // the picture on screen when the book was left

async function reloadReader() {
  const stale = readerStale;
  const book = reader.state.book;
  if (!stale || !book || stale.bookId !== book.id) return;
  readerStale = null;
  readerLanding = null;
  try {
    await reader.open(book.id);
    paintReader();
    if (!stale.land) return;
    const was = await store.get('images', [book.id, stale.land]);
    if (!was) return;
    const live = (await library.livePictures(book.id)).sort((a, b) => (a.order || 0) - (b.order || 0));
    const target = !was.removed ? was
      : live.find((image) => (image.order || 0) > (was.order || 0)) || live[live.length - 1];
    if (!target) return;
    if (target.chapterIndex !== reader.state.chapterIndex) await reader.goTo({ chapter: target.chapterIndex });
    reader.flashImage(target.href);
  } catch (error) {
    toast(error.message || 'That book could not be reopened');
  }
}

async function jumpToImage(image) {
  back();
  if (current !== 'reader') await show('reader');
  if (image.chapterIndex !== reader.state.chapterIndex) {
    await reader.goTo({ chapter: image.chapterIndex });
  }
  reader.flashImage(image.href);
}

/**
 * A tap or swipe that could not move because the chapter has ended.
 *
 * Doing nothing is correct -- crossing into another chapter is a much bigger
 * jump than a page, and it should take the button that says so -- but silence
 * is indistinguishable from a missed tap. Said once, not on every attempt.
 */
let edgeToldAt = 0;
let edgeDirection = 0;
let edgeTimer = null;

/* ── the chapter edge, said quietly ──────────────────────────────────────
 *
 * This was a toast: an opaque slab across the bottom of the page, over the
 * last two lines of the chapter it is telling you about. Reaching the end of
 * a chapter is the most ordinary thing that happens while reading and it was
 * being announced like a failure.
 *
 * So it is a thin pill, mostly transparent, with the words still legible
 * underneath it -- and it never takes a tap, because the next tap is the one
 * that turns the chapter.
 */
function showEdgeHint(message) {
  const hint = el('edge-hint');
  if (!hint) return toast(message, 4000);
  hint.textContent = message;
  hint.hidden = false;
  // Two frames, so the transition runs from the hidden state rather than
  // being skipped because the element was display:none when it was set.
  requestAnimationFrame(() => requestAnimationFrame(() => hint.classList.add('up')));

  clearTimeout(edgeTimer);
  edgeTimer = setTimeout(hideEdgeHint, 4000);
}

function hideEdgeHint() {
  const hint = el('edge-hint');
  if (!hint) return;
  clearTimeout(edgeTimer);
  hint.classList.remove('up');
  // Left in the layout until the fade has finished, then taken out of it.
  edgeTimer = setTimeout(() => { hint.hidden = true; }, 260);
}

/* ── the page pad ────────────────────────────────────────────────────────
 *
 * Turning the page by tapping the edge of it means reaching across the
 * screen, and on a tall phone held in one hand the far edge is out of reach.
 * So the turn floats, and it goes where the hand is: dragged anywhere, made
 * bigger or smaller, and flipped to whichever side the thumb is on. Vertical
 * by default, with up as onward, because that is how a thumb reads a stack.
 *
 * It turns pages, and carries on into the next chapter at the end of one --
 * so it is the only control reading needs. It used to turn whole chapters,
 * which left the page itself to the far edge of the screen; the chapter
 * buttons are in the footer, as they always were.
 *
 * Locked by default, which is the part that makes it usable at all: an
 * unlocked control sitting over the page is one that moves every time you
 * meant to press it.
 */
const PAD = { on: false, x: 88, y: 64, scale: 1, vertical: true, locked: true, side: 'right' };

function padSettings(settings) {
  return { ...PAD, ...(settings?.chapterPad || {}) };
}

function paintChapterPad(settings) {
  const pad = el('chapter-pad');
  if (!pad) return;
  const own = padSettings(settings);

  pad.hidden = !own.on || current !== 'reader';
  if (pad.hidden) return;

  pad.dataset.vertical = own.vertical ? '' : 'no';
  pad.classList.toggle('locked', own.locked !== false);
  pad.style.setProperty('--pad-scale', String(own.scale || 1));
  // Percentages, so it stays where it was put when the window changes shape
  // -- rotation, the keyboard, the insets MainActivity pushes in.
  pad.style.left = `${Math.max(2, Math.min(98, own.x))}%`;
  pad.style.top = `${Math.max(6, Math.min(94, own.y))}%`;

  /* Up is the next page when it is vertical, and the right-hand button when
   * it is not. The two buttons swap rather than the labels, so the arrow
   * always points the way it goes. Only the very ends of the book stop it:
   * the end of a chapter is a page turn like any other. */
  el('pad-next').disabled = !reader.canTurn(1) && !reader.hasNextChapter();
  el('pad-prev').disabled = !reader.canTurn(-1) && !reader.hasPrevChapter();

  // It turns pages now, so the footer keeps its chapter pair.
  el('chapter-prev').hidden = false;
  el('chapter-next').hidden = false;
}

/**
 * Turn a page from the pad, and on into the next chapter (or back to the end
 * of the previous one) where the chapter runs out.
 *
 * No "tap again to carry on" here, which the page edge asks for: that guards
 * against a stray tap on the text, and a press on a button is not one.
 */
async function padTurn(direction) {
  if (!reader.turn(direction)) {
    if (direction > 0 && reader.hasNextChapter()) await reader.nextChapter();
    else if (direction < 0 && reader.hasPrevChapter()) await reader.prevChapter(true);
    else toast(`That is the ${direction > 0 ? 'end' : 'start'} of the book`);
  }
  paintReader();
}

function wireChapterPad() {
  const pad = el('chapter-pad');
  if (!pad) return;

  el('pad-next').onclick = () => padTurn(1);
  el('pad-prev').onclick = () => padTurn(-1);

  /* Dragged by the grip, and only while unlocked.
   *
   * The grip rather than the whole pad: dragging by a button means every
   * slightly imprecise press moves the thing you were trying to press.
   */
  const grip = el('pad-grip');
  let from = null;

  const begin = (event) => {
    const touch = event.touches ? event.touches[0] : event;
    from = { x: touch.clientX, y: touch.clientY };
  };

  const move = async (event) => {
    if (!from) return;
    const settings = await store.settings();
    if (padSettings(settings).locked !== false) return;

    const touch = event.touches ? event.touches[0] : event;
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const own = padSettings(settings);

    const x = Math.max(2, Math.min(98, own.x + ((touch.clientX - from.x) / width) * 100));
    const y = Math.max(6, Math.min(94, own.y + ((touch.clientY - from.y) / height) * 100));
    from = { x: touch.clientX, y: touch.clientY };

    // The side follows the pad rather than the other way round, so the
    // Left/Right choice in Settings never disagrees with where it is.
    const next = await store.saveSettings({
      chapterPad: { ...own, x, y, side: x < 50 ? 'left' : 'right' },
    });
    paintChapterPad(next);
    if (event.cancelable) event.preventDefault();
  };

  const end = () => { from = null; };

  grip.addEventListener('touchstart', begin, { passive: true });
  grip.addEventListener('touchmove', move, { passive: false });
  grip.addEventListener('touchend', end);
  grip.addEventListener('mousedown', (event) => { begin(event); event.preventDefault(); });
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
}

async function atChapterEdge(direction) {
  const more = direction > 0 ? reader.hasNextChapter() : reader.hasPrevChapter();
  if (!more) {
    toast(`That is the ${direction > 0 ? 'last' : 'first'} chapter`);
    return;
  }

  const how = (await store.settings()).chapterOnEdge || 'confirm';
  if (how === 'buttons') {
    if (Date.now() - edgeToldAt > 2500) {
      edgeToldAt = Date.now();
      showEdgeHint(`End of the chapter — use ${direction > 0 ? 'Ch \u203a' : '\u2039 Ch'} to carry on`);
    }
    return;
  }

  // A second tap the same way, soon after the first, is the confirmation.
  const asked = how === 'immediate'
    || (edgeDirection === direction && Date.now() - edgeToldAt < 4000);

  if (!asked) {
    edgeToldAt = Date.now();
    edgeDirection = direction;
    showEdgeHint(direction > 0 ? 'End of the chapter — tap again to carry on'
      : 'Start of the chapter — tap again to go back');
    return;
  }

  edgeToldAt = 0;
  edgeDirection = 0;
  if (direction > 0) await reader.nextChapter();
  else await reader.prevChapter(true);
  paintReader();
}

/* ── annotating ───────────────────────────────────────────────────────────
 *
 * The bar is placed opposite Android's own selection menu rather than near
 * the selection. The system puts its toolbar above the selected text when
 * there is room above and below it otherwise, so going the other way is what
 * keeps the two from covering each other -- and covering Copy, Translate or
 * Web search would be worse than showing nothing at all.
 */

let pendingSelection = null;

function placeAnnotateBar(rect) {
  const bar = el('annotate');

  /* Below the selection where it fits, above where it does not, and always
   * inside the screen.
   *
   * This used to measure the room above and, finding little, place the bar
   * above anyway -- so selecting a line near the top of the page put the bar
   * off the top edge, where most of it could not be seen at all. Which side
   * it ends up on is decided by where it fits, and then clamped regardless.
   *
   * Below is preferred because Android puts its own selection menu above when
   * it can, and covering Copy or Translate is worse than being a little far
   * from the words.
   */
  bar.hidden = false;
  bar.style.bottom = '';

  const margin = 12;
  const height = bar.offsetHeight || 170;
  const limit = window.innerHeight - height - margin;

  let top = rect.bottom + margin;
  if (top > limit) top = rect.top - height - margin;

  bar.style.top = `${Math.max(margin, Math.min(top, Math.max(margin, limit)))}px`;
}

function hideAnnotateBar() {
  el('annotate').hidden = true;
  const note = el('annotate-text');
  note.value = '';
  note.hidden = true;
  pendingSelection = null;
}

async function wireAnnotations() {
  const settings = await store.settings();
  let style = settings.markStyle;
  let colour = settings.markColour;

  const styles = el('annotate-styles');
  for (const [value, label] of reader.MARK_STYLES) {
    const button = document.createElement('button');
    button.textContent = label.replace('Double underline', 'Double').replace('Wavy underline', 'Wavy');
    button.setAttribute('aria-pressed', String(style === value));
    button.onclick = () => {
      style = value;
      for (const other of styles.children) other.setAttribute('aria-pressed', String(other === button));
      store.saveSettings({ markStyle: value });
    };
    styles.appendChild(button);
  }

  const colours = el('annotate-colours');
  for (const [value, hex] of reader.MARK_COLOURS) {
    const button = document.createElement('button');
    button.style.setProperty('--swatch', hex);
    button.title = value;
    button.setAttribute('aria-pressed', String(colour === value));
    button.onclick = () => {
      colour = value;
      for (const other of colours.children) other.setAttribute('aria-pressed', String(other === button));
      store.saveSettings({ markColour: value });
    };
    colours.appendChild(button);
  }

  const save = async (note) => {
    if (!pendingSelection) return;
    // A selection inside an existing mark is a phrase being picked out of it,
    // not a second mark laid over the first -- two overlapping ranges saying
    // different things about the same words help nobody.
    const around = reader.markAround(pendingSelection);
    if (around) await reader.splitMark(around, pendingSelection, style, colour, note);
    else await reader.addMark(pendingSelection, style, colour, note);

    window.getSelection?.().removeAllRanges();
    hideAnnotateBar();
    toast(around ? 'Split out' : note ? 'Note saved' : 'Marked');
  };

  const noteField = el('annotate-text');

  el('annotate-save').onclick = () => save(noteField.value.trim() || null);

  // The field appears in place rather than as a dialog: a note is written
  // while looking at the sentence it is about.
  el('annotate-note').onclick = () => {
    noteField.hidden = !noteField.hidden;
    if (!noteField.hidden) noteField.focus();
  };

  // Offered as soon as there is something to mark, and withdrawn the moment
  // there is not.
  /* A tap on the bar is not the selection going away.
   *
   * Pressing a colour or a style collapses the selection, which fired
   * selectionchange, which hid the bar -- so the press appeared to do nothing
   * and the bar vanished under the finger. Anything begun inside the bar is
   * the bar being used. */
  let usingBar = false;
  el('annotate').addEventListener('pointerdown', () => { usingBar = true; });
  el('annotate').addEventListener('touchstart', () => { usingBar = true; }, { passive: true });
  document.addEventListener('pointerup', () => { setTimeout(() => { usingBar = false; }, 0); });

  document.addEventListener('selectionchange', () => {
    if (current !== 'reader') return;
    if (usingBar) return;
    // Typing in the note field selects text too; that is not a passage to
    // mark, and reacting to it would close the bar being typed into.
    if (document.activeElement === noteField) return;
    const found = reader.selectionRange();
    if (!found) { hideAnnotateBar(); return; }
    pendingSelection = found;

    /* What the bar offers depends on what is under the selection.
     *
     * Inside an existing mark there are two useful things to do -- pick a
     * phrase out of it, or take it off -- and removing was only reachable by
     * tapping the mark afterwards to open its note. */
    const around = reader.markAround(found) || reader.markAt(found);
    el('annotate-save').textContent = around && around.exact ? 'Mark' : (around ? 'Split out' : 'Mark');
    el('annotate-remove').hidden = !around;
    el('annotate-remove').onclick = async () => {
      await reader.removeMark(around.id);
      window.getSelection?.().removeAllRanges();
      hideAnnotateBar();
      toast('Mark removed');
    };

    placeAnnotateBar(found.rect);
  });

  /* A note is read where its marker is, not on another screen -- and the
     same card steps between marks, so going from one to the next does not
     mean opening a list and losing the thread. */
  let peekedMark = null;

  const showPeek = (mark, rect) => {
    const peek = el('peek');
    peekedMark = mark;
    el('peek-note').textContent = mark.note || '';
    peek.hidden = false;

    const below = rect.bottom + 12;
    peek.style.top = below + peek.offsetHeight > window.innerHeight
      ? `${Math.max(12, rect.top - peek.offsetHeight - 12)}px`
      : `${below}px`;
  };

  const step = async (delta) => {
    const next = await reader.stepToMark(peekedMark?.id, delta);
    if (!next) return;
    paintReader();
    // Wait for the page to settle before measuring where it landed.
    requestAnimationFrame(() => {
      const drawn = document.querySelector(`mark[data-mark="${next.id}"]`);
      showPeek(next, drawn ? drawn.getBoundingClientRect()
        : { top: 120, bottom: 140 });
    });
  };

  el('peek-prev').onclick = () => step(-1);
  el('peek-next').onclick = () => step(1);
  el('peek-remove').onclick = async () => {
    if (!peekedMark) return;
    await reader.removeMark(peekedMark.id);
    el('peek').hidden = true;
    peekedMark = null;
    toast('Removed');
  };

  el('page-host').addEventListener('click', (e) => {
    const marker = e.target.closest?.('mark[data-mark]');
    if (!marker) { el('peek').hidden = true; peekedMark = null; return; }
    const mark = reader.markById(Number(marker.dataset.mark));
    if (mark) showPeek(mark, marker.getBoundingClientRect());
  });

}

/* ── reading desk ─────────────────────────────────────────────────────────
 *
 * A workspace held over the book for as long as it is wanted.
 *
 * The problem it answers: comparing three passages means jumping between
 * them, and every jump costs the place you were reading. So opening the desk
 * records where you were, jumping from it is free, and closing it puts you
 * back exactly there. The pins are the desk's own -- they last as long as it
 * does and no longer, which is what makes pinning something cheap enough to
 * do without thinking about it.
 */

let desk = null;

function deskEntry(label, note, onGo) {
  const row = document.createElement('button');
  row.className = 'list-row';
  row.innerHTML = `<span class="body"><b>${escapeText(label)}</b>`
    + (note ? `<small>${escapeText(note)}</small>` : '') + '</span>';
  row.onclick = onGo;
  return row;
}

async function renderDesk() {
  const body = el('desk-body');
  body.innerHTML = '';
  if (!desk) return;

  const state = reader.state;
  const group = (title) => {
    const section = document.createElement('div');
    section.className = 'desk-group';
    section.innerHTML = `<h3>${title}</h3>`;
    body.appendChild(section);
    return section;
  };

  const here = group('Current');
  here.appendChild(deskEntry(
    reader.chapterName(state.chapterIndex),
    `p. ${reader.pageInBook()} of ${state.totalPages}`,
    () => jumpFromDesk(state.chapterIndex, state.anchor)));

  const pins = group('Pinned');
  if (!desk.pinned.length) {
    pins.insertAdjacentHTML('beforeend',
      '<p class="desk-empty">Nothing pinned. Pin this page to come back to it.</p>');
  }
  for (const pin of desk.pinned) {
    pins.appendChild(deskEntry(pin.label, pin.excerpt,
      () => jumpFromDesk(pin.chapterIndex, pin.anchor)));
  }

  const marks = await store.byIndex('marks', 'bookId', state.book.id);

  const bookmarks = group('Bookmarks');
  const saved = marks.filter((m) => m.kind === 'bookmark');
  if (!saved.length) bookmarks.insertAdjacentHTML('beforeend', '<p class="desk-empty">None yet.</p>');
  for (const mark of saved) {
    bookmarks.appendChild(deskEntry(reader.chapterName(mark.chapterIndex), null,
      () => jumpFromDesk(mark.chapterIndex, mark.anchor)));
  }

  const notes = group('Notes');
  const written = marks.filter((m) => m.note);
  if (!written.length) notes.insertAdjacentHTML('beforeend', '<p class="desk-empty">None yet.</p>');
  for (const mark of written) {
    notes.appendChild(deskEntry(mark.note, mark.text || reader.chapterName(mark.chapterIndex),
      () => jumpFromDesk(mark.chapterIndex, mark.anchor)));
  }
}

async function jumpFromDesk(chapterIndex, anchor) {
  el('desk').hidden = true;
  el('desk-tab').hidden = false;
  await reader.goTo({ chapter: chapterIndex, anchor });
  paintReader();
}

async function openDesk() {
  if (!reader.state.book) return toast('Open a book first');
  // Where to come back to. Recorded once, when the desk is opened, so that
  // jumping around from it costs nothing.
  if (!desk) {
    desk = {
      home: { chapterIndex: reader.state.chapterIndex, anchor: reader.state.anchor },
      pinned: [],
    };
  }
  el('desk-tab').hidden = true;
  el('desk').hidden = false;
  await renderDesk();
}

async function closeDesk({ returnHome = true } = {}) {
  const home = desk?.home;
  desk = null;
  el('desk').hidden = true;
  el('desk-tab').hidden = true;
  if (returnHome && home) {
    await reader.goTo({ chapter: home.chapterIndex, anchor: home.anchor });
    paintReader();
  }
}

function wireDesk() {
  el('desk-open').onclick = () => openDesk();
  el('desk-tab').onclick = () => openDesk();
  el('desk-hide').onclick = () => { el('desk').hidden = true; el('desk-tab').hidden = false; };
  el('desk-close').onclick = () => closeDesk();
  el('desk').onclick = (e) => {
    // Dismissing by the scrim is a peek at the page, not a close: closing
    // would move the reader, which is not what tapping outside asks for.
    if (e.target !== el('desk')) return;
    el('desk').hidden = true;
    el('desk-tab').hidden = false;
  };

  el('desk-pin').onclick = async () => {
    if (!desk) return;
    const state = reader.state;
    desk.pinned.push({
      chapterIndex: state.chapterIndex,
      anchor: state.anchor,
      label: `p. ${reader.pageInBook()} · ${reader.chapterName(state.chapterIndex)}`,
      excerpt: reader.excerptAt(state.anchor),
    });
    await renderDesk();
  };
}

/**
 * How much of each edge turns the page, as a fraction of the width.
 *
 * This setting used to be a percentage and is now a fraction, and an install
 * from before the change still has the old number in it. Compared against a
 * fraction, 26 is never exceeded -- so the middle of the screen was never the
 * middle, and every tap anywhere turned the page. Read either way now.
 */
function sideZone(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0.18;
  const fraction = raw > 1 ? raw / 100 : raw;
  // Never so wide that there is no middle left to tap.
  return Math.min(0.35, Math.max(0.05, fraction));
}

/* ── reading guides ───────────────────────────────────────────────────────
 *
 * A band that follows the line being read, and a dimming of everything but
 * the passage in front of you. Both are aids for dense text, tired eyes and
 * dyslexia, and both are off unless asked for.
 */

let guideSettings = { readingRuler: false, focusMode: 'off' };

export async function refreshGuides() {
  const settings = await store.settings();
  guideSettings = settings;
  document.body.dataset.focus = settings.focusMode || 'off';
  el('ruler').hidden = !settings.readingRuler;
  if (!settings.readingRuler) return;
  // Parked in the middle until a line is chosen, rather than at the top where
  // it would sit over the first line by accident.
  const host = el('page-host').getBoundingClientRect();
  el('ruler').style.top = `${host.top + host.height / 2}px`;
}

/** Put the guides on whatever is under a given point. */
function moveGuides(clientY) {
  if (guideSettings.readingRuler) {
    const ruler = el('ruler');
    ruler.hidden = false;
    ruler.style.top = `${clientY - ruler.offsetHeight / 2}px`;
  }

  if ((guideSettings.focusMode || 'off') === 'off') return;

  // The block under the point, rather than the nearest by distance: a finger
  // resting in a margin should not light up the paragraph across the page.
  const target = document.elementFromPoint(window.innerWidth / 2, clientY);
  const block = target?.closest?.('#page-flow p, #page-flow li');
  for (const lit of document.querySelectorAll('#page-flow .in-focus')) {
    lit.classList.remove('in-focus');
  }
  if (block) block.classList.add('in-focus');
}

/* ── dividing a book ──────────────────────────────────────────────────────
 *
 * A single file often holds what are really several things: a bound set of
 * volumes, a year of serialised chapters, an omnibus. Reading it means one
 * enormous spine with no sense of where you are.
 *
 * The chapter list alone is not enough to divide it well -- "Chapter 12" and
 * "Chapter 13" look like a safe place to cut until you see that one runs
 * straight into the other. So every cut shows the words on each side of it.
 */

let dividing = null;      // { book, chapters, pictures }
let divideCuts = new Set();
/* Thumbnails live only as long as the screen does. */
const dividePages = blobs.urlCache();

/** Which of the two ways of cutting is being used: 'chapters' or 'pages'. */
let divideMode = 'chapters';

async function openDivide(book, mode) {
  const chapters = (await store.byIndex('chapters', 'bookId', book.id))
    .sort((a, b) => a.index - b.index);
  if (!chapters.length) return toast('That book has nothing in it');

  // The pages themselves, so a cut in a comic can be looked at rather than
  // read about.
  const images = await library.livePictures(book.id);
  const pictures = new Map(images.filter((i) => i.blob).map((i) => [i.href, i.blob]));

  /* Two ways of cutting, and a comic wants both.
   *
   * At chapter boundaries, which is how it was put together, and at any page,
   * which is how volumes actually fall. A book of one chapter has no
   * boundaries to use, so it only has the second.
   */
  const pages = library.pagesOf(chapters, await library.readUnits(chapters));
  const canCutChapters = chapters.length > 1;
  const canCutPages = pages.length > 1;

  if (!canCutChapters && !canCutPages) return toast('There is nothing in that book to divide');

  divideMode = mode || (canCutChapters ? 'chapters' : 'pages');
  if (divideMode === 'chapters' && !canCutChapters) divideMode = 'pages';
  if (divideMode === 'pages' && !canCutPages) divideMode = 'chapters';

  dividing = { book, chapters, pictures, pages, canCutChapters, canCutPages };
  divideCuts = new Set();
  divideShown = null;
  await show('divide');
}

/**
 * Place cuts for an even division into a given number of parts.
 *
 * A starting point, not an answer: almost no book divides evenly, and the
 * cuts can be moved one piece at a time afterwards. Getting from "nothing" to
 * "roughly right" by tapping through three hundred gaps is not reasonable.
 */
function divideInto(parts, total) {
  divideCuts = new Set();
  for (let n = 1; n < parts; n++) {
    divideCuts.add(Math.round((total * n) / parts));
  }
  // Rounding can land two cuts on the same place in a very short book.
  divideCuts = new Set([...divideCuts].filter((at) => at > 0 && at < total));
}

/** The two ways of cutting, offered only where both are possible. */
function renderModeChips() {
  const row = el('divide-mode');
  row.innerHTML = '';
  if (!dividing.canCutChapters || !dividing.canCutPages) {
    row.hidden = true;
    return;
  }
  row.hidden = false;

  for (const [mode, label] of [['chapters', 'By chapter'], ['pages', 'By page']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(divideMode === mode));
    chip.onclick = () => {
      if (divideMode === mode) return;
      divideMode = mode;
      divideShown = null;
      // Cuts are positions in one list or the other; they do not carry over.
      divideCuts = new Set();
      renderDivide();
    };
    row.appendChild(chip);
  }
}

function renderIntoChips(total) {
  const row = el('divide-into');
  row.innerHTML = '';

  /* Offered up to whatever the book can actually be divided into, so a
     six-page volume does not suggest making ten parts of it. */
  const most = Math.min(8, total);
  for (let parts = 2; parts <= most; parts++) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = `${parts}`;
    chip.title = `Into ${parts} parts`;
    chip.setAttribute('aria-pressed', String(divideCuts.size === parts - 1 && evenlyCut(parts, total)));
    chip.onclick = () => { divideInto(parts, total); renderDivide(); };
    row.appendChild(chip);
  }

  const label = document.createElement('span');
  label.className = 'muted';
  label.style.cssText = 'font-size:11px;align-self:center;margin-left:4px';
  label.textContent = 'parts';
  row.appendChild(label);
}

/** Whether the cuts are still where an even division would have put them. */
function evenlyCut(parts, total) {
  for (let n = 1; n < parts; n++) {
    if (!divideCuts.has(Math.round((total * n) / parts))) return false;
  }
  return true;
}

let divideShown = null;         // { from, to }: the rows of the list on screen

function renderDivide({ around = null } = {}) {
  if (!dividing) return;
  const { book, chapters } = dividing;
  const body = el('divide-body');
  body.innerHTML = '';

  // What is being cut between: whole chapters, or the pages inside them.
  const units = divideMode === 'pages' ? dividing.pages : null;
  const rows = units || chapters;
  const allPictures = !!units && units.every((u) => u.picture);
  const noun = units ? (allPictures ? 'pages' : 'sections') : 'chapters';

  renderModeChips();

  el('divide-of').textContent = `${library.displayTitle(book)} · ${rows.length} ${noun}`;
  renderIntoChips(rows.length);

  /* Said once, at the top, because none of it is obvious from an unmarked
     list: cuts are placed by tapping between rows, and a placed cut can then
     be dragged. */
  const how = document.createElement('p');
  how.className = 'muted';
  how.style.cssText = 'font-size:12px;line-height:1.5;margin:0 0 10px';
  how.textContent = divideCuts.size
    ? 'Drag a cut to move it, or tap between rows to add another.'
    : `Choose a number of parts above, or tap between ${noun} to place a cut.`;
  body.appendChild(how);

  /* Which part each chapter is going to end up in.
   *
   * Cuts can be placed anywhere and in any number, so the parts are rarely
   * the same size -- and a list of chapters with a few lines drawn through it
   * does not show what you have actually made. A part number against every
   * chapter does. */
  /* A stretch of the list at a time, as on the Take out screen: dividing a
   * novel at its paragraphs is tens of thousands of rows, each with a cut
   * above it. The part numbers carry on from the rows not drawn. */
  divideShown = stretchOf(divideShown, rows.length, around);
  const { from, to } = divideShown;
  const partAt = (at) => 1 + [...divideCuts].filter((n) => n > 0 && n <= at).length;

  const holder = document.createElement('div');
  body.appendChild(holder);
  if (from > 0) {
    holder.appendChild(earlierRows(body, from, () => {
      divideShown = { from: Math.max(0, from - STRETCH), to: divideShown.to };
      renderDivide();
    }));
  }

  const drawRow = (at, into, before = null) => {
    const row = rows[at];
    // A cut sits between two of them, so one is offered above every row
    // except the first.
    if (at > 0) into.insertBefore(cutControl(at), before);
    const part = partAt(at);

    const line = document.createElement('div');
    line.className = 'divide-chapter';

    const label = units
      ? (row.picture
        ? `Page ${at + 1}${row.chapterTitle ? ` · ${row.chapterTitle}` : ''}`
        : (row.text.slice(0, 60) || `Section ${at + 1}`))
      : row.title;
    const note = units
      ? (row.picture ? '' : `${row.text.split(/\s+/).filter(Boolean).length} words`)
      : (row.words ? `${row.words} words` : 'pictures');

    line.innerHTML = `<span class="divide-part">${divideCuts.size ? part : ''}</span>`
      + `<b>${escapeText(label)}</b><small>${escapeText(note)}</small>`;
    line.dataset.at = String(at);
    into.insertBefore(line, before);
  };

  for (let at = from; at < to; at++) drawRow(at, holder);
  if (to < rows.length) {
    moreRows(body, holder, {
      left: () => rows.length - divideShown.to,
      add: (more) => {
        const end = Math.min(rows.length, divideShown.to + STRETCH);
        for (let at = divideShown.to; at < end; at++) drawRow(at, holder, more);
        divideShown = { from: divideShown.from, to: end };
      },
    });
  }

  /* The shape of the division, in the footer.
   *
   * "4 parts" says nothing about whether they are 4, 4, 4, 3 or 1, 9, 2, 3 --
   * which is the whole question when the cuts are placed by hand. */
  const sizes = partSizes(rows.length, divideCuts);
  el('divide-count').textContent = divideCuts.size
    ? `${sizes.length} parts · ${sizes.join(', ')} ${noun}`
    : `Tap between ${noun} to cut`;
  el('divide-go').disabled = divideCuts.size === 0;
}

/** How many chapters each part would hold, in order. */
function partSizes(total, cuts) {
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), total];
  return bounds.slice(1).map((end, i) => end - bounds[i]);
}

function cutControl(at) {
  const cut = document.createElement('button');
  cut.className = 'divide-cut';
  cut.setAttribute('aria-pressed', String(divideCuts.has(at)));
  cut.innerHTML = `<span class="divide-cut-line">${
    divideCuts.has(at) ? 'Cut here — drag to move' : '＋ cut here'}</span>`;

  cut.onclick = () => {
    if (divideCuts.has(at)) divideCuts.delete(at);
    else divideCuts.add(at);
    renderDivide();
  };

  if (!divideCuts.has(at)) return cut;

  /* What this cut separates, and a way to move it.
   *
   * Shown only once a cut is placed: a preview under every gap would bury the
   * list it is meant to explain. */
  const holder = document.createElement('div');
  holder.appendChild(cut);

  const preview = document.createElement('div');
  preview.className = 'divide-preview';
  holder.appendChild(preview);

  const total = (divideMode === 'pages' ? dividing.pages : dividing.chapters).length;

  /* A slider, because a cut can be anywhere.
   *
   * Stepping one piece at a time is fine for a book of twelve chapters and
   * hopeless for a volume of three hundred pages. Dragging shows each
   * position as it passes, and only the one it is let go on is kept -- so
   * finding the right place costs one gesture rather than two hundred taps.
   */
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'divide-slider';
  // Never onto a neighbouring cut, which would silently merge two into one.
  const others = [...divideCuts].filter((n) => n !== at).sort((a, b) => a - b);
  slider.min = String(Math.max(1, (others.filter((n) => n < at).pop() ?? 0) + 1));
  slider.max = String(Math.min(total - 1, (others.find((n) => n > at) ?? total) - 1));
  slider.value = String(at);
  slider.setAttribute('aria-label', 'Where this cut falls');

  fillPreview(preview, at, at);

  slider.oninput = () => {
    // Drawn as it moves, but not committed: the list above renumbers itself
    // on release rather than on every pixel.
    fillPreview(preview, Number(slider.value), at);
  };
  slider.onchange = () => {
    const to = Number(slider.value);
    if (to === at || divideCuts.has(to)) return;
    divideCuts.delete(at);
    divideCuts.add(to);
    renderDivide({ around: to });
  };

  // Labelled, so it reads as a control rather than a stray line.
  const sliderRow = document.createElement('div');
  sliderRow.className = 'divide-slider-row';
  const sliderLabel = document.createElement('b');
  sliderLabel.textContent = 'Move';
  sliderRow.appendChild(sliderLabel);
  sliderRow.appendChild(slider);
  preview.appendChild(sliderRow);
  return holder;
}

/**
 * Fill a cut's preview for a position.
 *
 * @param at       the position being shown, which during a drag is not yet
 *                 the position the cut is actually at
 * @param committed  where the cut currently sits, for working out which part
 *                 of the division is being changed
 */
function fillPreview(preview, at, committed) {
  const total = (divideMode === 'pages' ? dividing.pages : dividing.chapters).length;
  const look = divideMode === 'pages'
    ? library.previewUnitCut(dividing.pages, at)
    : library.previewCut(dividing.chapters, at);

  const side = (label, chapterName, words, href) => {
    const block = document.createElement('div');
    block.innerHTML = `<em>${escapeText(label)} ${escapeText(chapterName || '')}</em>`;

    /* A page, where there is one. For a comic the picture is the whole
       content, and a title is no substitute for seeing it. */
    const blob = href ? dividing.pictures.get(href) : null;
    if (blob) {
      const img = document.createElement('img');
      img.className = 'divide-page';
      img.src = dividePages.url(href, blob, blob.size);
      img.alt = '';
      block.appendChild(img);
    } else {
      const text = document.createElement('p');
      text.textContent = words || '—';
      block.appendChild(text);
    }
    return block;
  };

  const pair = document.createElement('div');
  pair.className = look.endsPicture || look.beginsPicture ? 'divide-pair pages' : 'divide-pair';
  pair.appendChild(side('Ends', look.endsAt, look.endsWith, look.endsPicture));
  pair.appendChild(side('Next part opens', look.beginsAt, look.beginsWith, look.beginsPicture));

  // What the division would be if the cut were let go here.
  const candidate = new Set([...divideCuts].filter((n) => n !== committed));
  candidate.add(at);
  const sizes = partSizes(total, candidate);
  const which = [...candidate].sort((a, b) => a - b).indexOf(at);

  const where = document.createElement('p');
  where.className = 'divide-where';
  where.textContent = `${sizes[which]} then ${sizes[which + 1]}`;

  const sliderRow = preview.querySelector('.divide-slider-row');
  preview.innerHTML = '';
  preview.appendChild(pair);
  preview.appendChild(where);
  if (sliderRow) preview.appendChild(sliderRow);
}

function wireDivide() {
  el('divide-clear').onclick = () => { divideCuts.clear(); renderDivide(); };

  el('divide-go').onclick = async () => {
    if (!dividing || !divideCuts.size) return;
    const finish = progress.start('Dividing');
    try {
      const divide = divideMode === 'pages' ? library.fragmentPages : library.fragmentBook;
      const made = await divide(dividing.book.id, [...divideCuts], {
        name: library.displayTitle(dividing.book),
        onProgress: finish.step,
      });
      dividing = null;
      divideCuts = new Set();
      dividePages.release();
      await refreshShelf();
      // Back to where it was asked for, not out to the shelf.
      back();
      toast(`Divided into ${made.length} parts — the original is still here`, 7000, { kind: 'done' });
    } catch (error) {
      finish.fail();
      toast(error.message || 'That book could not be divided', 6000, { kind: 'failed' });
    } finally {
      finish();
    }
  };
}

/* ── taking things out of a book ──────────────────────────────────────────
 *
 * Dividing cuts a book into books. This takes content out and keeps the
 * book, which is the other half of the same need and the one that was
 * missing: a download arrives with things attached that are not the work --
 * a scanlator's credit page in front of every chapter, the advertisement
 * spread bound into a volume, the duplicated scan, the sample chapter for a
 * different series.
 *
 * Picking those out is a different gesture from placing a cut. A cut is one
 * position chosen carefully; this is a handful of pages recognised on sight,
 * scattered through six hundred. So it is a grid of the pages themselves
 * rather than a list of their names, and the pages that repeat -- the first
 * of every chapter, the last of every chapter -- can be taken in one tap
 * instead of forty.
 */

let removing = null;                    // what inspect() found
let removePicked = new Set();
let removeMode = 'pages';
/* Thumbnails live only as long as the screen does. */
const removeThumbs = blobs.urlCache();

/* Where Take out was opened from: 'reader' when it was the book being read,
 * so finishing goes back to reading it rather than leaving it. */
let removeOrigin = null;

/**
 * @param options.from   'reader' when opened from the book being read
 * @param options.focus  the row to open at, as an index into what is shown
 * @param options.pick   rows to start with picked
 */
async function openRemove(book, mode, { from = null, focus = null, pick = null } = {}) {
  let look;
  try {
    look = await trim.inspect(book.id);
  } catch (error) {
    return toast(error.message || 'That book could not be opened');
  }

  if (!look.canChapters && !look.canPages) {
    return toast('There is nothing in that book to take out');
  }

  /* Pages for a book of pictures, chapters for a book of words.
   *
   * A "page" of prose is a paragraph, and a novel has tens of thousands of
   * them: offered first, that was a list nobody could use and a screen that
   * took so long to draw the app looked frozen. The chapters are what is
   * wanted out of a novel; the paragraphs are still a tap away. */
  const pictured = look.pages.filter((page) => page.picture).length;
  const mostlyPictures = look.pages.length > 0 && pictured * 2 >= look.pages.length;
  removeMode = mode || (look.canPages && (mostlyPictures || !look.canChapters) ? 'pages' : 'chapters');
  if (removeMode === 'pages' && !look.canPages) removeMode = 'chapters';
  if (removeMode === 'chapters' && !look.canChapters) removeMode = 'pages';

  removing = look;
  removeOrigin = from;
  removePicked = new Set(pick || []);
  removeShown = null;
  removeThumbs.release();
  renderRemove({ around: focus });
  await show('remove');
  // Opened at the part of the book that was on screen, not at page one of six
  // hundred.
  if (focus != null) {
    const row = el('remove-body').querySelector(`[data-at="${focus}"]`);
    if (row) el('remove-body').scrollTop = Math.max(0, row.offsetTop - el('remove-body').clientHeight / 3);
  }
}

/** Which of the two things can be taken out, offered only where both can. */
function renderRemoveModes() {
  const row = el('remove-mode');
  row.innerHTML = '';
  if (!removing.canChapters || !removing.canPages) { row.hidden = true; return; }
  row.hidden = false;

  for (const [mode, text] of [['pages', 'Pages'], ['chapters', 'Chapters']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = text;
    chip.setAttribute('aria-pressed', String(removeMode === mode));
    chip.onclick = () => {
      if (removeMode === mode) return;
      removeMode = mode;
      // A pick is a position in one list or the other; they do not carry over.
      removePicked = new Set();
      removeShown = null;
      renderRemove();
    };
    row.appendChild(chip);
  }
}

/**
 * Ways of picking that would otherwise be forty taps.
 *
 * The credit page at the front of every chapter is the single most common
 * thing anybody wants out of a comic, and picking it out by hand across
 * thirty volumes is the kind of job people give up on halfway through.
 */
function renderRemovePicks() {
  const row = el('remove-picks');
  row.innerHTML = '';

  const total = removeMode === 'pages' ? removing.pages.length : removing.rows.length;

  const pick = (text, run, title) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = text;
    if (title) chip.title = title;
    chip.onclick = () => { run(); renderRemove(); };
    row.appendChild(chip);
  };

  if (removeMode === 'pages') {
    const byChapter = new Map();
    removing.pages.forEach((page) => {
      if (!byChapter.has(page.chapterIndex)) byChapter.set(page.chapterIndex, []);
      byChapter.get(page.chapterIndex).push(page.at);
    });

    if (byChapter.size > 1) {
      pick('First of each chapter', () => {
        removePicked = new Set([...byChapter.values()].map((ats) => ats[0]));
      }, 'The credit page, usually');
      pick('Last of each chapter', () => {
        removePicked = new Set([...byChapter.values()].map((ats) => ats[ats.length - 1]));
      });
    }
  }

  pick('Invert', () => {
    const next = new Set();
    for (let at = 0; at < total; at++) if (!removePicked.has(at)) next.add(at);
    removePicked = next;
  });

  const note = document.createElement('span');
  note.className = 'muted';
  note.style.cssText = 'font-size:11px;align-self:center;margin-left:4px';
  note.textContent = 'Tap to pick';
  row.appendChild(note);
}

/* ── long lists, a stretch at a time ─────────────────────────────────────
 *
 * The lists on these screens can be enormous: every page of a long comic, or
 * every paragraph of a novel -- twenty-four thousand rows for one web novel,
 * which is a quarter of a million elements built in one go and built again
 * on every tap. On a phone the app simply stopped. So a list shows a stretch
 * of rows and adds the next as it is scrolled to, and opens at the stretch
 * that was asked for rather than at the top.
 */
const STRETCH = 120;

/** The rows to draw: the stretch already shown, or one around `around`. */
function stretchOf(shown, total, around = null) {
  let { from, to } = shown || { from: 0, to: 0 };
  if (!shown || (around != null && (around < from || around >= to))) {
    from = around == null ? 0 : Math.max(0, around - 40);
    to = from + STRETCH;
  }
  from = Math.max(0, Math.min(from, total - 1));
  to = Math.min(total, Math.max(to, from + Math.min(STRETCH, total)));
  return { from, to };
}

/**
 * The control at the bottom of a stretch: shows the next one when tapped, or
 * by itself when it is scrolled near.
 */
function moreRows(scroller, holder, { left, add }) {
  const more = document.createElement('button');
  more.className = 'list-more';
  const label = () => { more.textContent = `Show more · ${left()} after these`; };
  label();

  let watch = null;
  const extend = () => {
    add(more);
    if (left() <= 0) {
      watch?.disconnect();
      more.remove();
      return;
    }
    label();
    // Looked at again, so a stretch too short to push it out of reach is
    // followed by the next straight away.
    if (watch) { watch.unobserve(more); watch.observe(more); }
  };
  more.onclick = extend;

  if (typeof IntersectionObserver === 'function') {
    watch = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) extend();
    }, { root: scroller, rootMargin: '600px' });
    watch.observe(more);
  }
  holder.appendChild(more);
  return more;
}

/** The control at the top of a stretch that does not start at the beginning. */
function earlierRows(scroller, count, show) {
  const earlier = document.createElement('button');
  earlier.className = 'list-more';
  earlier.textContent = `Show ${Math.min(STRETCH, count)} before these · ${count} in all`;
  earlier.onclick = () => {
    // Kept still: the rows added above should not shove the one in view away.
    const first = earlier.nextElementSibling;
    const at = first?.dataset.at;
    const top = first ? first.getBoundingClientRect().top : 0;
    show();
    const again = at != null ? scroller.querySelector(`[data-at="${at}"]`) : null;
    if (again) scroller.scrollTop += again.getBoundingClientRect().top - top;
  };
  return earlier;
}

let removeShown = null;         // { from, to }: the rows of the list on screen

function renderRemove({ around = null } = {}) {
  if (!removing) return;
  const { book } = removing;
  const body = el('remove-body');
  body.innerHTML = '';

  const pages = removeMode === 'pages';
  const rows = pages ? removing.pages : removing.rows;
  const allPictures = pages && rows.every((row) => row.picture);
  const noun = pages ? (allPictures ? 'pages' : 'sections') : 'chapters';

  renderRemoveModes();
  renderRemovePicks();

  el('remove-of').textContent = `${library.displayTitle(book)} · ${rows.length} ${noun}`;

  if (removing.history.length) body.appendChild(removeHistory());

  const how = document.createElement('p');
  how.className = 'muted';
  how.style.cssText = 'font-size:12px;line-height:1.5;margin:0 0 10px';
  how.textContent = allPictures
    ? 'Tap a page to pick it, or the glass to see it full size. Nothing goes until you confirm, and it can be put back afterwards.'
    : `Tap ${noun === 'chapters' ? 'a chapter' : 'one'} to pick it, or the glass to read a little of it. `
      + 'Nothing goes until you confirm, and it can be put back afterwards.';
  body.appendChild(how);

  /* A grid of the pages for a comic, a list of names for anything else.
   *
   * A page of a comic has no name worth reading and is recognised on sight in
   * a moment; a chapter of prose is the other way round. Showing both the
   * same way means one of them is useless. */
  const holder = document.createElement('div');
  holder.className = allPictures ? 'remove-grid' : 'remove-list';
  const make = (at) => (allPictures ? removeCell(rows[at], at) : removeLine(rows[at], at, pages));

  removeShown = stretchOf(removeShown, rows.length, around);
  const { from, to } = removeShown;
  if (from > 0) {
    holder.appendChild(earlierRows(body, from, () => {
      removeShown = { from: Math.max(0, from - STRETCH), to: removeShown.to };
      renderRemove();
    }));
  }
  for (let at = from; at < to; at++) holder.appendChild(make(at));
  if (to < rows.length) {
    moreRows(body, holder, {
      left: () => rows.length - removeShown.to,
      add: (more) => {
        const end = Math.min(rows.length, removeShown.to + STRETCH);
        const batch = document.createDocumentFragment();
        for (let at = removeShown.to; at < end; at++) batch.appendChild(make(at));
        holder.insertBefore(batch, more);
        removeShown = { from: removeShown.from, to: end };
      },
    });
  }
  body.appendChild(holder);
  removeFooter();
}

/** The footer's count and buttons, which are all a pick changes. */
function removeFooter() {
  if (!removing) return;
  const total = (removeMode === 'pages' ? removing.pages : removing.rows).length;
  const left = total - removePicked.size;
  el('remove-count').textContent = removePicked.size
    ? `${removePicked.size} out · ${left} left`
    : `Nothing picked`;
  el('remove-go').disabled = removePicked.size === 0 || left === 0;
  el('remove-none').disabled = removePicked.size === 0;
}

/** A page of a comic, as the page. */
function removeCell(page, at) {
  const cell = document.createElement('button');
  cell.className = 'remove-cell';
  cell.dataset.at = String(at);
  cell.setAttribute('aria-pressed', String(removePicked.has(at)));
  cell.onclick = () => { toggleRemove(at); };

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  cell.appendChild(img);

  const number = document.createElement('span');
  number.className = 'remove-number';
  number.textContent = String(at + 1);
  cell.appendChild(number);

  /* A separate target for looking, because tapping the page picks it.
   *
   * One gesture cannot mean both "I want to see this" and "remove this", and
   * making the tap open a viewer would turn picking forty credit pages into
   * forty viewers to dismiss. */
  const look = document.createElement('span');
  look.className = 'remove-look-btn';
  look.title = 'Look at this page';
  look.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/>'
    + '<path d="M20 20l-4.6-4.6"/></svg>';
  look.onclick = (event) => {
    event.stopPropagation();     // not a pick
    openRemoveLook(at);
  };
  cell.appendChild(look);

  /* Decoded when it comes into view, not all six hundred at once.
   *
   * A volume of three hundred pages is three hundred decodes, and doing them
   * on render is a screen that does not appear for several seconds on a
   * mid-range phone. Where there is no observer to lean on -- an old WebView,
   * or a test -- they are all drawn immediately, which is slow rather than
   * broken. */
  const blob = page.picture ? removing.pictures.get(page.picture) : null;
  const draw = () => { if (blob) img.src = removeThumbs.url(page.picture, blob, blob.size); };

  if (typeof IntersectionObserver === 'function') {
    const watch = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      draw();
      watch.disconnect();
    }, { rootMargin: '400px' });
    watch.observe(cell);
  } else {
    draw();
  }

  return cell;
}

/** A chapter, or a paragraph of prose, as a line of text. */
function removeLine(row, at, pages) {
  const line = document.createElement('button');
  line.className = 'remove-row';
  line.dataset.at = String(at);
  line.setAttribute('aria-pressed', String(removePicked.has(at)));
  line.onclick = () => { toggleRemove(at); };

  const label = pages
    ? (row.picture
      ? `Page ${at + 1}${row.chapterTitle ? ` · ${row.chapterTitle}` : ''}`
      : (row.text.slice(0, 70) || `Section ${at + 1}`))
    : row.title;

  const note = pages
    ? (row.picture ? (row.chapterTitle || 'page') : `${row.text.split(/\s+/).filter(Boolean).length} words`)
    : [row.pages === 1 ? '1 page' : `${row.pages} pages`,
      row.pictures ? `${row.pictures} pictures` : null,
      row.words ? `${row.words} words` : null].filter(Boolean).join(' · ');

  line.innerHTML = `<span class="remove-tick"></span>`
    + `<span class="col"><b>${escapeText(label)}</b><small>${escapeText(note)}</small></span>`;

  // The same split as the grid: tapping the row picks it, the glass looks at
  // it. A chapter called "Chapter 41" and an afterword called "Chapter 41"
  // are the same row until you read a paragraph of either.
  const look = document.createElement('span');
  look.className = 'remove-look-btn inline';
  look.title = 'Look at this';
  look.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/>'
    + '<path d="M20 20l-4.6-4.6"/></svg>';
  look.onclick = (event) => { event.stopPropagation(); openRemoveLook(at); };
  line.appendChild(look);

  return line;
}

/**
 * Hold, then drag: every item the finger passes is set the way the first one
 * went, and dragging back puts them as they were.
 *
 * For lists and grids alike. Items are told apart by their data-at, and the
 * run is every index between the first item and the one under the finger --
 * across a grid that is whole rows at a time, as a run of pages is. Near the
 * top or bottom edge the view scrolls on by itself.
 *
 * @param host      the element holding the items (they may come and go)
 * @param scroller  what scrolls
 * @param item      selector for an item
 * @param ignore    selector for parts of an item that are not for picking
 * @param picked    (at) => whether it is picked
 * @param set       (at, value) => pick or unpick it
 * @param changed   () => after a run of changes
 */
function dragToPick({ host, scroller, item, ignore = null, picked, set, changed }) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let paint = null;     // { value, from, was: Map(at -> picked), x, y }
  let endedAt = 0;
  let creep = null;
  const itemAt = (target) => {
    const found = target?.closest?.(item);
    return found && host.contains(found) ? found : null;
  };
  const atOf = (node) => Number(node.dataset.at);

  const paintTo = (to) => {
    const [low, high] = paint.from < to ? [paint.from, to] : [to, paint.from];
    for (let at = low; at <= high; at += 1) {
      if (!paint.was.has(at)) paint.was.set(at, picked(at));
      if (picked(at) !== paint.value) set(at, paint.value);
    }
    // Dragged back over: those outside the run go back to how they were.
    for (const [at, was] of paint.was) {
      if ((at < low || at > high) && picked(at) !== was) set(at, was);
    }
    changed();
  };
  const under = () => {
    const node = itemAt(document.elementFromPoint(paint.x, paint.y));
    return node ? atOf(node) : null;
  };
  const creepOn = () => {
    creep = null;
    if (!paint) return;
    const box = scroller.getBoundingClientRect();
    const edge = 72;
    let by = 0;
    if (paint.y < box.top + edge) by = -Math.ceil((box.top + edge - paint.y) / 6);
    else if (paint.y > box.bottom - edge) by = Math.ceil((paint.y - (box.bottom - edge)) / 6);
    if (!by) return;
    scroller.scrollTop += by;
    const at = under();
    if (at !== null) paintTo(at);
    creep = requestAnimationFrame(creepOn);
  };
  const end = () => {
    clearTimeout(timer);
    timer = null;
    if (creep) cancelAnimationFrame(creep);
    creep = null;
    if (!paint) return false;
    paint = null;
    host.classList.remove('painting');
    endedAt = Date.now();
    return true;
  };

  host.addEventListener('touchstart', (e) => {
    const node = itemAt(e.target);
    if (!node || e.touches.length !== 1 || (ignore && e.target.closest(ignore))) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const from = atOf(node);
      paint = { value: !picked(from), from, was: new Map(), x: startX, y: startY };
      host.classList.add('painting');
      paintTo(from);
    }, 380);
  }, { passive: true });

  // Not passive: once a drag is picking, it must not also scroll.
  host.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    if (timer && (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10)) {
      clearTimeout(timer);
      timer = null;
    }
    if (!paint) return;
    if (e.cancelable) e.preventDefault();
    paint.x = touch.clientX;
    paint.y = touch.clientY;
    const at = under();
    if (at !== null) paintTo(at);
    if (!creep) creep = requestAnimationFrame(creepOn);
  }, { passive: false });

  const lift = (e) => { if (end() && e.cancelable) e.preventDefault(); };
  host.addEventListener('touchend', lift);
  host.addEventListener('touchcancel', lift);
  // The system's own long press -- a menu, a picture to save -- is this one's.
  host.addEventListener('contextmenu', (e) => { if (itemAt(e.target)) e.preventDefault(); });
  // And the tap a browser may still make of the lift is not a pick.
  host.addEventListener('click', (e) => {
    if (Date.now() - endedAt < 350 && itemAt(e.target)) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

/* A pick changes one row and the footer, so that is all that is redrawn --
   not the list, which on a long book was the whole of the delay. */
function toggleRemove(at) {
  if (removePicked.has(at)) removePicked.delete(at);
  else removePicked.add(at);
  const row = el('remove-body').querySelector(`[data-at="${at}"]`);
  if (row) row.setAttribute('aria-pressed', String(removePicked.has(at)));
  else renderRemove({ around: at });
  removeFooter();
}

/* ── looking at one of them properly ─────────────────────────────────────
 *
 * A thumbnail is enough to find a page and not enough to be sure about it: a
 * scanlator's credit page and the first page of a chapter are the same shape
 * at that size, and so are two consecutive pages of the same spread. The
 * whole reason to preview a removal is to be able to trust it, and a grid of
 * eighty-pixel pictures cannot be trusted.
 *
 * So one of them can be opened full size and stepped through from there,
 * picked or unpicked on the way -- which is also the fastest way to go
 * through a volume: look, decide, next.
 */
let looking = null;          // { of: [at,…], cursor }

function openRemoveLook(at, only = null) {
  if (!removing) return;
  const total = (removeMode === 'pages' ? removing.pages : removing.rows).length;

  /* What it steps through: the picked ones when it was opened from the
   * confirmation, which is a review of a decision already made, and the whole
   * book when it was opened from a page, which is making the decision. */
  const of = only && only.length ? [...only] : Array.from({ length: total }, (_, n) => n);
  const cursor = Math.max(0, of.indexOf(at));

  looking = { of, cursor: cursor === -1 ? 0 : cursor };
  paintRemoveLook();
  el('remove-look').hidden = false;
}

function closeRemoveLook() {
  // Back at the one last looked at, which may be far from where it started.
  const last = looking ? looking.of[looking.cursor] : null;
  looking = null;
  el('remove-look').hidden = true;
  renderRemove({ around: last });
}

function paintRemoveLook() {
  if (!looking) return;
  const at = looking.of[looking.cursor];
  const pages = removeMode === 'pages';
  const row = (pages ? removing.pages : removing.rows)[at];
  if (!row) return closeRemoveLook();

  const stage = el('remove-look-stage');
  stage.innerHTML = '';

  const href = row.picture || row.pictureHrefs?.[0] || null;
  const blob = href ? removing.pictures.get(href) : null;

  // Covering part of a page is often what was wanted instead of taking the
  // whole page out -- one panel, not the chapter's opening spread.
  el('remove-look-redact').hidden = !blob;

  if (blob) {
    const img = document.createElement('img');
    img.src = removeThumbs.url(href, blob, blob.size);
    img.alt = '';
    stage.appendChild(img);
  } else {
    /* Prose, which is the other half of this: an afterword and a chapter are
     * indistinguishable by name, and a paragraph of either tells you which
     * one you are looking at. */
    const text = document.createElement('p');
    text.className = 'look-text';
    text.textContent = pages
      ? (row.text || 'Nothing to show for this one')
      : (row.extract || row.preview || 'Nothing to show for this one');
    stage.appendChild(text);
  }

  const label = pages
    ? `Page ${at + 1} of ${removing.pages.length}${row.chapterTitle ? ` · ${row.chapterTitle}` : ''}`
    : `${row.title} · ${[row.pages === 1 ? '1 page' : `${row.pages} pages`,
      row.pictures ? `${row.pictures} pictures` : null,
      row.words ? `${row.words} words` : null].filter(Boolean).join(' · ')}`;

  el('remove-look-caption').textContent = looking.of.length < (pages ? removing.pages : removing.rows).length
    ? `${label} · ${looking.cursor + 1} of ${looking.of.length} picked`
    : label;

  el('remove-look-prev').disabled = looking.cursor === 0;
  el('remove-look-next').disabled = looking.cursor >= looking.of.length - 1;

  // The same button says both things, so there is one place to look and one
  // place to press.
  const picked = removePicked.has(at);
  const pick = el('remove-look-pick');
  pick.textContent = picked ? 'Keep it' : 'Take this out';
  pick.className = picked ? 'btn ghost' : 'btn danger';
}

function stepRemoveLook(by) {
  if (!looking) return;
  const to = looking.cursor + by;
  if (to < 0 || to >= looking.of.length) return;
  looking.cursor = to;
  paintRemoveLook();
}

/* ── blacking out part of a picture ──────────────────────────────────────
 *
 * Each shape is drawn by tapping points round what is to be covered -- three
 * for a triangle, six for a six-sided shape, as many as it takes -- and
 * filled in with "Black out shape" (or a tap back on the first point). The
 * shapes are painted into the picture on Save -- the book's copy is
 * replaced, so the edit goes wherever the book goes. redact.js does the
 * geometry, the painting and the bookkeeping; this is the editor around it.
 *
 * Pressing a point and holding lets it be slid into place before letting go,
 * with the loupe showing what is under the finger. Once filled, a shape is
 * chosen, and each point -- or the middle of an edge, which moves the whole
 * edge -- can be dragged to fit. Pressing inside a shape chooses it again
 * later; dragging from inside moves it.
 *
 * The editor always shows the original with every shape drawn over it, never
 * the last saved edit: clearing every shape and saving is the picture as it
 * came.
 */

let redacting = null;
const redactUrls = blobs.pool();

/** How near a finger has to be to a corner or an edge to take hold of it, in screen pixels. */
const REDACT_REACH = 26;

/** The picture's own size, from the record where it was measured, or by loading it. */
function measureRedact(img, url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    img.onload = () => { clearTimeout(timer); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

async function openRedact(bookId, href) {
  const image = await store.get('images', [bookId, href]);
  if (!image?.blob) {
    toast('That picture is no longer in the book', 4000, { kind: 'failed' });
    return;
  }
  const original = image.original || image.blob;

  redactUrls.release();
  const img = el('redact-img');
  const url = redactUrls.url(original);
  const loaded = measureRedact(img, url);

  let width = image.width;
  let height = image.height;
  if (!width || !height) {
    const got = await loaded;
    if (!got || !got.width || !got.height) {
      redactUrls.release();
      toast('That picture could not be opened for editing', 5000, { kind: 'failed' });
      return;
    }
    ({ width, height } = got);
  }

  if (redact.tooLarge(width, height)) {
    redactUrls.release();
    toast(`That picture is ${width}×${height} — too large for a phone to edit in one piece`, 6000, { kind: 'failed' });
    return;
  }

  const edits = redact.normalise(JSON.parse(JSON.stringify(image.edits || [])));
  redacting = {
    bookId, href, image, width, height, url,
    shapes: edits,
    saved: JSON.parse(JSON.stringify(edits)),
    past: [], future: [],   // { shapes, pending } as they were, for Undo and Redo
    tool: 'panel', colour: 'black', zoom: 1,
    textSize: 0,      // the size the next piece of text is lettered at
    editing: null,    // the text being typed: { before }
    pending: [],      // corners pressed so far for the next panel
    chosen: -1,       // the panel being adjusted
    drag: null,
    warn: '',
    busy: false,
  };

  // The record's numbers were measured once, by the reel; the picture itself
  // is the authority, and a disagreement is corrected before anything is drawn.
  loaded.then((got) => {
    const r = redacting;
    if (!r || r.href !== href || !got?.width) return;
    if ((got.width !== r.width || got.height !== r.height) && !r.shapes.length) {
      r.width = got.width;
      r.height = got.height;
      layoutRedact();
      paintRedact();
    }
  });

  el('redact-svg').setAttribute('viewBox', `0 0 ${width} ${height}`);
  el('redact-leave').hidden = true;
  el('redact-loupe').hidden = true;
  el('redact-save').disabled = false;
  el('redact-restore').hidden = !redact.isEdited(image);
  el('redact').hidden = false;
  el('redact-text').hidden = true;
  setRedactTool('panel');
  setRedactColour('black');
  el('redact-zoom').textContent = '1×';
  layoutRedact();
  paintRedact();
}

function closeRedact() {
  redacting = null;
  redactFingers.clear();
  redactIdle.clear();
  redactPan = null;
  el('redact-text').hidden = true;
  el('redact').hidden = true;
  el('redact-leave').hidden = true;
  el('redact-loupe').hidden = true;
  el('redact-svg').innerHTML = '';
  el('redact-img').removeAttribute('src');
  redactUrls.release();
}

function redactChanged() {
  if (redacting) finishText();
  return !!redacting && (redacting.pending.length > 0
    || !redact.sameShapes(redacting.shapes, redacting.saved));
}

/** Cancel, or the back gesture: straight out if nothing was marked, asked if something was. */
function leaveRedact() {
  if (!redacting) return;
  if (redactChanged()) el('redact-leave').hidden = false;
  else closeRedact();
}

/**
 * The picture at the size of the stage, times the zoom.
 *
 * Fitted whole, except a strip far taller than it is wide -- a webtoon
 * chapter -- which fitted whole is a line down the middle of the screen. That
 * is fitted to the width and scrolled with Move instead.
 */
function layoutRedact() {
  const r = redacting;
  if (!r) return;
  const stage = el('redact-stage');
  const frame = el('redact-frame');
  const roomW = Math.max(1, stage.clientWidth - 16);
  const roomH = Math.max(1, stage.clientHeight - 16);

  // Kept centred on what was in the middle of the screen before the zoom.
  const midX = stage.scrollWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : 0.5;
  const midY = stage.scrollHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : 0.5;

  let fit = Math.min(roomW / r.width, roomH / r.height);
  if (r.height / r.width > 3) fit = roomW / r.width;
  if (!Number.isFinite(fit) || fit <= 0) fit = 1;

  frame.style.width = `${Math.round(r.width * fit * r.zoom)}px`;
  frame.style.height = `${Math.round(r.height * fit * r.zoom)}px`;
  el('redact-svg').setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);

  stage.scrollLeft = midX * stage.scrollWidth - stage.clientWidth / 2;
  stage.scrollTop = midY * stage.scrollHeight - stage.clientHeight / 2;
  paintRedact();
}

/** Picture pixels to one screen pixel, so handles are the same size at every zoom. */
function redactScale() {
  const r = redacting;
  const rect = el('redact-svg').getBoundingClientRect();
  return rect.width ? r.width / rect.width : 1;
}

function paintRedact() {
  const r = redacting;
  if (!r) return;
  const scale = redactScale();
  const svg = el('redact-svg');
  const parts = r.shapes.map((shape, at) => {
    const drawn = redact.svgFor(shape);
    return redact.isPolygon(shape)
      ? drawn.replace('<polygon ', `<polygon class="panel${at === r.chosen ? ' chosen' : ''}" `)
      : drawn;
  });

  const chosen = r.shapes[r.chosen];
  if (redact.isText(chosen)) {
    // A box round it, a little clear of the letters.
    const box = redact.textBox(chosen);
    const pad = 4 * scale;
    parts.push(`<rect class="outline" x="${box.x - pad}" y="${box.y - pad}" width="${box.w + pad * 2}" height="${box.h + pad * 2}"/>`);
  } else if (redact.isPolygon(chosen)) {
    const pts = chosen.points.map(([x, y]) => `${x},${y}`).join(' ');
    parts.push(`<polygon class="outline" points="${pts}"/>`);
    for (const [x, y] of redact.edgeMiddles(chosen.points)) {
      parts.push(`<circle class="edge" cx="${x}" cy="${y}" r="${6 * scale}"/>`);
    }
    for (const [x, y] of chosen.points) {
      parts.push(`<circle class="corner" cx="${x}" cy="${y}" r="${10 * scale}"/>`);
    }
  } else if (chosen) {
    // An oval or brush stroke from the first version: it can be chosen and
    // deleted, though not reshaped.
    parts.push(redact.svgFor(chosen).replace(/fill="[^"]*"/, 'class="outline"'));
  }

  const n = r.pending.length;
  if (n && !(r.drag?.kind === 'aim' && !r.drag.text)) {
    // The outline as it will be filled: joined so that it never crosses.
    const pts = redact.outline(r.pending).map(([x, y]) => `${x},${y}`).join(' ');
    if (n >= 3) parts.push(`<polygon class="preview" points="${pts}"/>`);
    if (n > 1) parts.push(`<polygon class="pending" points="${pts}"/>`);
  }
  if (n) {
    // Small, however close together: each is where a finger was let go.
    r.pending.forEach(([x, y]) => {
      parts.push(`<circle class="placed" cx="${x}" cy="${y}" r="${5 * scale}"/>`);
    });
  }

  // Where the point being aimed will land when the finger is let go.
  const aim = r.drag?.kind === 'aim' ? r.drag.aim : null;
  if (aim) {
    const [ax, ay] = aim;
    // The outline as it will be with this point in it.
    if (n && !r.drag.text) {
      const next = redact.outline([...r.pending, aim]);
      const pts = next.map(([x, y]) => `${x},${y}`).join(' ');
      if (next.length >= 3) parts.push(`<polygon class="preview" points="${pts}"/>`);
      parts.push(`<polygon class="closing" points="${pts}"/>`);
    }
    const arm = 14 * scale;
    parts.push(`<path class="aim" d="M${ax - arm} ${ay}H${ax - arm / 3}M${ax + arm / 3} ${ay}H${ax + arm}`
      + `M${ax} ${ay - arm}V${ay - arm / 3}M${ax} ${ay + arm / 3}V${ay + arm}"/>`);
    parts.push(`<circle class="aim-dot" cx="${ax}" cy="${ay}" r="${3 * scale}"/>`);
  }

  svg.innerHTML = parts.join('');
  svg.classList.toggle('editing', r.chosen >= 0);

  el('redact-undo').disabled = !r.past.length && !r.editing;
  el('redact-redo').disabled = !r.future.length;
  el('redact-clear').disabled = !r.shapes.length && !n;
  el('redact-delete').disabled = r.chosen < 0;

  // Kept in the layout when idle, never taken out of it: see the CSS.
  el('redact-shape').classList.toggle('idle', !n);
  el('redact-shape').setAttribute('aria-hidden', String(!n));
  el('redact-shape-cancel').disabled = !n;
  el('redact-shape-count').textContent = `${n} point${n === 1 ? '' : 's'}`;
  el('redact-confirm').disabled = n < 3;

  const words = r.shapes.filter((shape) => redact.isText(shape)).length;
  const count = r.shapes.length - words;
  const said = [
    count ? `${count} shape${count === 1 ? '' : 's'}` : '',
    words ? `${words} text${words === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  el('redact-caption').textContent = said.length ? `Black out · ${said.join(' · ')}` : 'Black out';

  let note;
  if (r.warn) note = r.warn;
  else if (r.tool === 'move') note = 'Drag to look around the picture.';
  else if (aim) note = 'Let go to place the point at the middle of the circle.';
  else if (r.editing) note = 'Type the text. Drag it to move it; Done when it is right.';
  else if (r.tool === 'text') note = 'Tap where the text goes — it is centred there. Tap text to change it.';
  else if (n && n < 3) {
    note = 'Keep placing points round what you want covered. Each lands where your finger lifts — slide to aim.';
  } else if (n) {
    note = 'Add more points, or tap Black out shape to fill it in.';
  } else if (redact.isText(chosen)) {
    note = 'Drag the text to move it.';
  } else if (r.chosen >= 0) {
    note = 'Drag a point, or the dot in the middle of an edge, to adjust. Drag inside to move it.';
  } else {
    note = 'Place points round what you want covered — as many as the shape needs. Each lands where your finger lifts.';
  }
  const notes = [note];
  if (r.zoom > 1 && r.tool !== 'move') notes.push('Two fingers move the picture.');
  if (r.image.animated || r.image.wasAnimated) {
    notes.push('This picture moves — saved, it keeps only its first frame.');
  }
  el('redact-hint').textContent = notes.join(' ');
}

/**
 * Fill in the shape being drawn.
 *
 * @returns whether there was one to fill.
 */
function confirmShape() {
  const r = redacting;
  if (!r || r.pending.length < 3) return false;
  const shape = redact.poly(r.pending, r.colour);
  if (redact.isTiny(shape)) {
    // The points stay: Undo takes back the last, or more can be added.
    r.warn = 'Those points cover almost nothing — place them round the outline of what to cover.';
    paintRedact();
    return false;
  }
  r.warn = '';
  remember(r);
  r.pending = [];
  r.shapes = [...r.shapes, shape];
  r.chosen = r.shapes.length - 1;
  r.picked = false;
  paintRedact();
  return true;
}

/* Undo and Redo go step by step through everything: a point placed, a shape
 * filled, adjusted, recoloured or deleted, text typed. Each step keeps the
 * shapes and the points of the shape being drawn as they were before it. */
const redactState = (r) => ({ shapes: r.shapes, pending: r.pending.map((p) => [...p]) });

/** The state before a step, kept for Undo; anything undone is now out of reach. */
function remember(r, before = redactState(r)) {
  r.past.push(before);
  if (r.past.length > 300) r.past.shift();
  r.future = [];
}

function backTo(r, state) {
  r.shapes = state.shapes;
  r.pending = state.pending.map((p) => [...p]);
  r.chosen = -1;
  r.picked = false;
  r.warn = '';
}

function undoRedact() {
  const r = redacting;
  if (!r || r.drag) return;
  finishText();
  if (!r.past.length) return;
  r.future.push(redactState(r));
  backTo(r, r.past.pop());
  paintRedact();
}

function redoRedact() {
  const r = redacting;
  if (!r || r.drag) return;
  finishText();
  if (!r.future.length) return;
  r.past.push(redactState(r));
  backTo(r, r.future.pop());
  paintRedact();
}

/** A change that Undo can take back. */
function changeRedact(next, chosen = -1, picked = false) {
  const r = redacting;
  r.picked = picked;
  remember(r);
  r.shapes = next;
  r.chosen = chosen;
  paintRedact();
}

/* ── text on the picture ───────────────────────────────────────────── */

let measureCtx = null;
/** A line's width in a font, measured as the canvas will letter it. */
function measureLine(line, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext?.('2d') || null;
  const guess = () => [...line].length * (parseFloat(font.split(' ')[1]) || 12) * 0.56;
  if (!measureCtx) return guess();
  measureCtx.font = font;
  const width = measureCtx.measureText?.(line)?.width;
  return Number.isFinite(width) ? width : guess();
}

/** A size to start at: about what a bubble in a page this size is lettered at. */
const startingTextSize = (r) => r.textSize
  || Math.max(redact.TEXT_MIN, Math.min(48, Math.round(Math.min(r.width, r.height) / 45)));

/** Open the text at `at` for typing; the step it makes is kept for Undo when done. */
function editText(at, { focus = false } = {}) {
  const r = redacting;
  const shape = r.shapes[at];
  if (!redact.isText(shape)) return;
  r.chosen = at;
  r.picked = true;
  if (!r.editing) r.editing = { before: redactState(r) };
  const input = el('redact-text-input');
  input.value = shape.text;
  paintTextSize(shape.size);
  el('redact-text').hidden = false;
  if (focus) setTimeout(() => input.focus(), 0);
  paintRedact();
}

/** New text, centred where the finger was let go. */
function placeText(x, y) {
  const r = redacting;
  const before = redactState(r);
  const size = startingTextSize(r);
  r.shapes = [...r.shapes, redact.text(x, y, '', size, r.colour, measureLine)];
  r.editing = { before };
  editText(r.shapes.length - 1, { focus: true });
}

/** The text being typed, changed, and drawn again. */
function retext(change) {
  const r = redacting;
  const shape = r?.shapes[r.chosen];
  if (!r?.editing || !redact.isText(shape)) return;
  const next = redact.measured({ ...shape, ...change }, measureLine);
  r.shapes = r.shapes.map((s, at) => (at === r.chosen ? next : s));
  paintRedact();
}

function paintTextSize(size) {
  el('redact-text-size').value = String(size);
  el('redact-text-size-n').textContent = `${size}px`;
}

function setTextSize(size) {
  const r = redacting;
  if (!r) return;
  const next = Math.max(redact.TEXT_MIN, Math.min(redact.TEXT_MAX, Math.round(size * 2) / 2));
  r.textSize = next;
  paintTextSize(next);
  retext({ size: next });
}

/**
 * Close the text being typed: kept as one step for Undo if it changed
 * anything, taken away if it says nothing.
 */
function finishText() {
  const r = redacting;
  if (!r?.editing) return;
  const { before } = r.editing;
  r.editing = null;
  el('redact-text').hidden = true;
  el('redact-text-input').blur();
  r.shapes = r.shapes.filter((shape) => !(redact.isText(shape) && redact.isTiny(shape)));
  if (r.chosen >= r.shapes.length || !redact.isText(r.shapes[r.chosen])) r.chosen = -1;
  if (!redact.sameShapes(r.shapes, before.shapes)) remember(r, before);
  paintRedact();
}

function setRedactTool(tool) {
  if (!redacting) return;
  finishText();
  redacting.tool = tool;
  redacting.drag = null;
  redacting.warn = '';
  el('redact-loupe').hidden = true;
  el('redact').dataset.tool = tool;
  for (const button of el('redact-tool').querySelectorAll('[data-tool]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  }
  paintRedact();
}

/** The colour for the next panel -- and for the chosen one, if there is one. */
function setRedactColour(colour) {
  const r = redacting;
  if (!r) return;
  r.colour = colour;
  for (const button of el('redact-colour').querySelectorAll('[data-colour]')) {
    button.setAttribute('aria-pressed', String(button.dataset.colour === colour));
  }
  // Recoloured only when it was picked out on purpose: the shape just
  // finished is chosen too, so its points can be adjusted, and choosing white
  // for the next one turned that one white as well.
  const chosen = r.picked ? r.shapes[r.chosen] : null;
  // Text being typed takes the colour as part of the typing.
  if (r.editing && redact.isText(chosen)) { retext({ colour }); return; }
  if (chosen && chosen.colour !== colour) {
    changeRedact(r.shapes.map((shape, at) => (at === r.chosen ? { ...shape, colour } : shape)), r.chosen, true);
  }
}

function redactPoint(event) {
  const r = redacting;
  const rect = el('redact-svg').getBoundingClientRect();
  return redact.toPicture(event.clientX, event.clientY, rect, r.width, r.height);
}

/**
 * The finger's surroundings, magnified, in the top corner away from it.
 *
 * The picture as it is underneath, without the panels: what is being lined
 * up with is the art's own border, and that is what a black panel over it
 * would hide.
 */
function showLoupe(event) {
  const r = redacting;
  const loupe = el('redact-loupe');
  const frame = el('redact-frame').getBoundingClientRect();
  const stage = el('redact-stage').getBoundingClientRect();
  if (!frame.width) { loupe.hidden = true; return; }
  const size = 120;
  const zoom = 2.5;
  // Off the picture, the loupe shows its edge, where the point is held.
  const fx = Math.max(0, Math.min(frame.width, event.clientX - frame.left));
  const fy = Math.max(0, Math.min(frame.height, event.clientY - frame.top));
  loupe.style.backgroundImage = `url("${r.url}")`;
  loupe.style.backgroundSize = `${frame.width * zoom}px ${frame.height * zoom}px`;
  loupe.style.backgroundPosition = `${size / 2 - fx * zoom}px ${size / 2 - fy * zoom}px`;
  const onLeft = event.clientX > stage.left + stage.width / 2;
  loupe.style.left = `${onLeft ? stage.left + 12 : stage.left + stage.width - size - 12}px`;
  loupe.style.top = `${stage.top + 12}px`;
  loupe.hidden = false;
}

/**
 * A finger on the picture.
 *
 * A point for a shape is placed where the finger is let go, not where it
 * landed: pressed, it shows the loupe and a cross where the point will go,
 * and sliding moves both, so it can be aimed exactly -- right beside the
 * last point if that is where it belongs. Nothing already placed is taken
 * hold of while a shape is being drawn; Undo takes back a point.
 */
/* ── two fingers move the picture ──────────────────────────────────────
 *
 * Zoomed in, the picture is larger than the screen, and switching to Move
 * and back for every look round broke up the marking. So two fingers on the
 * picture move it, in any tool: whatever the first finger had started -- a
 * point being aimed, a corner being dragged -- is let go as if it never
 * began, and the picture follows the middle of the two fingers until either
 * lifts. The finger left on the glass does nothing more until it lifts too.
 */
const redactFingers = new Map();   // pointerId -> { x, y }, on the picture now
let redactPan = null;              // { ids, mid, left, top }
const redactIdle = new Set();      // fingers that ended a pan and are still down

const fingersMiddle = (ids) => {
  const [a, b] = ids.map((id) => redactFingers.get(id));
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

/** Let go of whatever one finger had started, leaving things as they were. */
function dropRedactDrag(r) {
  const drag = r.drag;
  if (!drag) return;
  r.drag = null;
  if (drag.kind !== 'aim') r.shapes = drag.before.shapes;
  el('redact-loupe').hidden = true;
}

function startRedactPan(r) {
  dropRedactDrag(r);
  const ids = [...redactFingers.keys()].slice(-2);
  const stage = el('redact-stage');
  redactPan = { ids, mid: fingersMiddle(ids), left: stage.scrollLeft, top: stage.scrollTop };
  paintRedact();
}

function redactDown(event) {
  const r = redacting;
  if (!r || r.busy || r.tool === 'move') return;
  redactFingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  event.preventDefault();
  // A second finger: the picture is being moved, not marked.
  if (redactFingers.size >= 2) {
    try { el('redact-svg').setPointerCapture?.(event.pointerId); } catch { /* not every WebView can */ }
    if (!redactPan) startRedactPan(r);
    return;
  }
  if (r.drag || redactPan) return;
  /* Held by the picture's layer itself, not by what was under the finger:
   * a corner's handle is drawn again on every move, and the capture went
   * with the old one -- so a finger carried off the picture was lost, the
   * drag never ended, and nothing more could be marked. */
  try { el('redact-svg').setPointerCapture?.(event.pointerId); } catch { /* not every WebView can */ }

  const point = redactPoint(event);
  const reach = REDACT_REACH * redactScale();
  const here = [point.x, point.y];
  r.warn = '';

  const begin = (drag) => {
    r.drag = { pointer: event.pointerId, from: point, ...drag };
    if (drag.kind !== 'aim') {
      r.drag.before = redactState(r);
      r.drag.base = r.shapes[r.chosen];
      r.shapes = r.shapes.slice();
    }
    if (drag.kind !== 'whole') showLoupe(event);
    paintRedact();
  };

  // Text being typed: pressing it moves it; anywhere else closes it first.
  if (r.editing) {
    const on = redact.shapeAt(r.shapes, point, reach / 2);
    if (on === r.chosen) return begin({ kind: 'whole', keepTyping: true });
    finishText();
  }

  // Partway through a shape: every press aims the next point.
  if (r.pending.length && r.tool === 'panel') return begin({ kind: 'aim', aim: here });

  // A corner or edge of the chosen panel.
  const handle = redact.handleAt(r.shapes[r.chosen], point, reach);
  if (handle) return begin(handle);

  // A corner of any other panel chooses that panel and takes hold of it --
  // drawing shapes only: placing text beside a panel should not move it.
  if (r.tool === 'panel') {
    for (let at = r.shapes.length - 1; at >= 0; at -= 1) {
      const corner = redact.handleAt(r.shapes[at], point, reach);
      if (corner?.kind === 'corner') {
        r.chosen = at;
        r.picked = true;
        return begin(corner);
      }
    }
  }

  // Inside a shape or on text: choose it, and dragging moves it.
  const inside = redact.shapeAt(r.shapes, point, redact.isText(r.shapes[r.chosen]) ? reach / 2 : 0);
  if (inside >= 0 && (r.tool === 'panel' || redact.isText(r.shapes[inside]))) {
    r.chosen = inside;
    r.picked = true;
    const shape = r.shapes[inside];
    if (redact.isPolygon(shape) || redact.isText(shape)) return begin({ kind: 'whole', openText: redact.isText(shape) });
    paintRedact();
    return undefined;
  }

  // Anywhere else: aim the first point of a new shape, or where text goes.
  r.chosen = -1;
  r.picked = false;
  return begin({ kind: 'aim', aim: here, text: r.tool === 'text' });
}

function redactMove(event) {
  const r = redacting;
  if (r && redactFingers.has(event.pointerId)) {
    redactFingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  if (r && redactPan) {
    if (!redactPan.ids.includes(event.pointerId)) return;
    if (event.cancelable) event.preventDefault();
    const mid = fingersMiddle(redactPan.ids);
    const stage = el('redact-stage');
    stage.scrollLeft = redactPan.left - (mid.x - redactPan.mid.x);
    stage.scrollTop = redactPan.top - (mid.y - redactPan.mid.y);
    return;
  }
  const drag = r?.drag;
  if (!drag || drag.pointer !== event.pointerId) return;
  if (event.cancelable) event.preventDefault();
  const point = redactPoint(event);
  if (drag.kind === 'aim') {
    drag.aim = [point.x, point.y];
  } else {
    drag.moved = true;
    r.shapes[r.chosen] = redact.moveHandle(drag.base, drag, drag.from, point, r.width, r.height);
  }
  if (drag.kind !== 'whole') showLoupe(event);
  paintRedact();
}

function redactUp(event) {
  const r = redacting;
  redactFingers.delete(event.pointerId);
  // The end of a pan: the other finger is let be until it lifts as well.
  if (redactPan) {
    if (!redactPan.ids.includes(event.pointerId)) return;
    for (const id of redactPan.ids) if (id !== event.pointerId) redactIdle.add(id);
    redactPan = null;
    if (r) paintRedact();
    return;
  }
  if (redactIdle.delete(event.pointerId)) return;
  const drag = r?.drag;
  if (!drag || drag.pointer !== event.pointerId) return;
  const cancelled = event.type === 'pointercancel';
  r.drag = null;
  el('redact-loupe').hidden = true;

  if (drag.kind === 'aim') {
    if (cancelled) { paintRedact(); return; }
    const [x, y] = drag.aim;
    if (drag.text) { placeText(x, y); return; }
    // The point lands where the finger let go -- however near the last --
    // and joins the outline where it fits, so it never crosses itself.
    remember(r);
    r.pending.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    paintRedact();
    return;
  }

  // An adjustment is one step for Undo, however many moves it took -- and
  // none at all if nothing moved. Text being typed keeps its moves with its
  // typing, as one step.
  const unmoved = cancelled || redact.sameShapes(r.shapes, drag.before.shapes);
  if (unmoved) r.shapes = drag.before.shapes;
  else if (!drag.keepTyping) remember(r, drag.before);
  // Text tapped, not dragged, opens to be typed into.
  if (drag.openText && unmoved && !cancelled) { editText(r.chosen, { focus: true }); return; }
  if (drag.openText && !unmoved) { paintRedact(); return; }
  paintRedact();
}

/* ── which picture to black out ─────────────────────────────────────────
 *
 * The editor was reachable only by opening a book, finding the image reel in
 * the reader's toolbar, opening a picture full size and spotting a button at
 * the bottom of it -- four steps, none of which said black out, and it could
 * not be found. So it has its own place: "Black out panels" in a book's menu
 * and at the top of the reel, both opening every picture in the book to pick
 * from. The editor opens over the list and comes back to it, so a run of
 * pages can be done one after another.
 */

let picking = null;               // { book, only, near }
const pickUrls = blobs.pool();

/**
 * @param options.only  just these pictures -- the ones on screen, from the reader
 * @param options.near  a chapter to open the list at
 */
async function openRedactPick(book, { only = null, near = null } = {}) {
  if (!book) return;
  picking = { book, only, near };
  el('redact-pick-of').textContent = only
    ? `${library.displayTitle(book)} · on this page`
    : library.displayTitle(book);
  el('redact-pick').hidden = false;
  el('redact-pick-body').scrollTop = 0;
  await paintRedactPick();
  if (near != null) {
    const target = el('redact-pick-body').querySelector(`[data-chapter="${near}"]`);
    if (target) el('redact-pick-body').scrollTop = Math.max(0, target.offsetTop - 60);
  }
}

function closeRedactPick() {
  picking = null;
  el('redact-pick').hidden = true;
  el('redact-pick-body').innerHTML = '';
  pickUrls.release();
}

async function paintRedactPick() {
  if (!picking) return;
  const body = el('redact-pick-body');
  const keep = body.scrollTop;
  const images = (await library.livePictures(picking.book.id))
    .filter((image) => image.blob && (!picking.only || picking.only.includes(image.href)))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  pickUrls.release();
  body.innerHTML = '';
  if (!images.length) {
    body.innerHTML = '<p class="muted" style="padding:24px 0">This book has no pictures to black out.</p>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'reel-grid';
  images.forEach((image, at) => {
    const figure = document.createElement('figure');
    figure.className = 'reel-item';
    figure.dataset.href = image.href;
    figure.dataset.chapter = String(image.chapterIndex || 0);
    figure.innerHTML = `
      ${redact.isEdited(image) ? '<span class="edited">BLACKED OUT</span>' : ''}
      <img src="${pickUrls.url(image.blob)}" alt="" loading="lazy">
      <figcaption>Picture ${at + 1} · ch. ${(image.chapterIndex || 0) + 1}</figcaption>`;
    figure.onclick = () => openRedact(picking.book.id, image.href);
    grid.appendChild(figure);
  });
  body.appendChild(grid);
  body.scrollTop = keep;
}

/* ── while reading ─────────────────────────────────────────────────────
 *
 * Two ways from the page to the editor, without leaving the book. A button in
 * the reader's toolbar takes the picture on screen -- straight to it when
 * there is one, a choice of them when a page holds several. And holding a
 * finger on a picture offers it: offered rather than opened, because a thumb
 * resting on a comic page is a long press too, and finding yourself in an
 * editor for having held the phone would be its own kind of broken.
 */

/** The toolbar button: the picture on screen, or a choice. */
function redactHere() {
  const book = reader.state.book;
  if (!book) return;
  const here = reader.picturesInView();
  if (here.length === 1) return openRedact(book.id, here[0]);
  if (here.length > 1) return openRedactPick(book, { only: here });
  toast('No picture on this page — pick one from the book', 3500);
  return openRedactPick(book, { near: reader.state.chapterIndex });
}

let chipTimer = null;
let chipHide = null;

function hideRedactChip() {
  clearTimeout(chipTimer);
  clearTimeout(chipHide);
  chipTimer = null;
  el('redact-chip').hidden = true;
}

/**
 * Take the held page out, from the page itself.
 *
 * The same confirmation as the Take out screen -- the page, shown, and what
 * goes with it -- over the book rather than instead of it, and back to
 * reading at the page after it once it is gone.
 */
async function removePageHere(href) {
  const book = reader.state.book;
  if (!book) return;
  let look;
  try {
    look = await trim.inspect(book.id);
  } catch (error) {
    return toast(error.message || 'That book could not be opened');
  }
  const page = look.pages.find((p) => p.picture === href);
  if (!page) {
    return toast('That picture is not a page on its own — use Take out to choose what goes', 5000);
  }
  removing = look;
  removeMode = 'pages';
  removePicked = new Set([page.at]);
  removeOrigin = 'reader';
  readerLanding = href;
  await askAboutRemoval();
}

/**
 * The toolbar's Take out: the whole screen of pages, opened at the page on
 * screen with nothing picked -- and back into the book when it is done.
 */
async function removeHere() {
  const book = reader.state.book;
  if (!book) return;
  const here = reader.picturesInView();
  readerLanding = here[0] || null;
  let look;
  try {
    look = await trim.inspect(book.id);
  } catch (error) {
    return toast(error.message || 'That book could not be opened');
  }
  if (look.canPages && here.length) {
    const pages = look.pages.filter((p) => here.includes(p.picture));
    const ats = pages.map((p) => p.at);
    // Opened at the page on screen, with nothing picked: the page you were
    // on is where you are, not what you want gone. (Holding a finger on a
    // page and choosing Take out is how one page is taken.)
    return openRemove(book, 'pages', {
      from: 'reader',
      focus: ats.length ? Math.min(...ats) : null,
    });
  }
  // Prose: the chapters, opened at this one.
  const mode = look.canChapters ? 'chapters' : 'pages';
  const focus = mode === 'chapters'
    ? look.rows.findIndex((row) => row.index === reader.state.chapterIndex)
    : look.pages.findIndex((p) => p.chapterIndex === reader.state.chapterIndex);
  return openRemove(book, mode, { from: 'reader', focus: focus >= 0 ? focus : null });
}

function wireRedactWhileReading() {
  el('redact-here').onclick = () => redactHere();
  el('remove-here').onclick = () => removeHere();

  const host = el('page-host');
  const chip = el('redact-chip');
  let pressX = 0;
  let pressY = 0;

  host.addEventListener('touchstart', (e) => {
    hideRedactChip();
    if (e.touches.length !== 1) return;
    const img = e.target.closest?.('img[data-img]');
    if (!img || !reader.state.book) return;
    pressX = e.touches[0].clientX;
    pressY = e.touches[0].clientY;
    const href = img.getAttribute('data-img');
    const bookId = reader.state.book.id;
    chipTimer = setTimeout(() => {
      chipTimer = null;
      // Saving it -- a GIF as the GIF it is -- beside the two ways of changing it.
      el('chip-save').onclick = () => {
        hideRedactChip();
        offerPicture(reader.state.images?.get(href), { title: reader.state.book?.title, href });
      };
      el('chip-redact').onclick = () => { hideRedactChip(); openRedact(bookId, href); };
      el('chip-remove').onclick = () => { hideRedactChip(); removePageHere(href); };
      // Above the finger, so the finger is not on top of it; kept on screen.
      chip.hidden = false;
      const width = chip.offsetWidth || 300;
      chip.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, pressX - width / 2))}px`;
      chip.style.top = `${Math.max(12, pressY - 76)}px`;
      chipHide = setTimeout(hideRedactChip, 4000);
    }, 550);
  }, { passive: true });

  // Moving is scrolling or selecting, not holding.
  host.addEventListener('touchmove', (e) => {
    if (!chipTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - pressX) > 10 || Math.abs(t.clientY - pressY) > 10) hideRedactChip();
  }, { passive: true });
  host.addEventListener('touchend', () => {
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = null; }
  }, { passive: true });
  el('page-viewport').addEventListener('scroll', () => { if (!chip.hidden || chipTimer) hideRedactChip(); }, { passive: true });
  // Holding an image is not a request for the browser's own menu.
  host.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('img[data-img]')) e.preventDefault();
  });
}

/** Everything showing this picture is shown the new one. */
async function afterRedact(bookId, href, blob) {
  // The save has happened by now. Anything here failing is a picture on
  // screen left stale until it is next drawn -- not a failed save, and not
  // to be reported as one.
  try {
    await showRedacted(bookId, href, blob);
  } catch (error) {
    console.warn('Could not redraw the edited picture', error);
  }
}

async function showRedacted(bookId, href, blob) {
  reader.refreshPicture(bookId, href, blob);
  if (picking && picking.book.id === bookId) await paintRedactPick();
  if (current === 'reel' && reader.state.book?.id === bookId) {
    await screens.openReel(bookId, jumpToImage);
  }
  if (removing && removing.book.id === bookId && removing.pictures.has(href)) {
    removing.pictures.set(href, blob);
    if (looking) paintRemoveLook();
    else if (current === 'remove') renderRemove();
  }
}

async function saveRedact() {
  const r = redacting;
  if (!r || r.busy) return;
  finishText();
  // A shape with enough points to be one is what was meant; fewer is not
  // a shape yet, and saying so beats guessing at it.
  if (r.pending.length >= 3) confirmShape();
  if (r.pending.length) {
    r.warn = `That shape has only ${r.pending.length} point${r.pending.length === 1 ? '' : 's'} — add more, or Cancel shape, then save.`;
    paintRedact();
    return;
  }
  if (!redactChanged()) { closeRedact(); return; }

  r.busy = true;
  el('redact-save').disabled = true;
  const covering = r.shapes.length > 0;
  const done = progress.start(covering ? 'Blacking out a picture' : 'Putting a picture back');
  try {
    done.say(covering ? 'Painting it into the book' : 'Putting the original back', 0.3);
    const next = await redact.saveEdits(r.bookId, r.href, r.shapes);
    done.say(null, 1);
    closeRedact();
    await afterRedact(r.bookId, r.href, next.blob);
    toast(covering
      ? 'Blacked out. It is in the book itself now, and goes with it when it is exported — the original is kept, so it can be put back'
      : 'The picture is back as it was', 7000, { kind: 'done' });
  } catch (error) {
    done.fail();
    r.busy = false;
    el('redact-save').disabled = false;
    toast(plainReason(error?.message) || 'That picture could not be saved', 6000, { kind: 'failed' });
  } finally {
    done();
  }
}

async function restoreRedact() {
  const r = redacting;
  if (!r || r.busy) return;
  r.busy = true;
  const done = progress.start('Putting a picture back');
  try {
    const next = await redact.restoreOriginal(r.bookId, r.href);
    closeRedact();
    await afterRedact(r.bookId, r.href, next.blob);
    toast('The picture is back as it was', 5000, { kind: 'done' });
  } catch (error) {
    done.fail();
    r.busy = false;
    toast(error?.message || 'That picture could not be put back', 6000, { kind: 'failed' });
  } finally {
    done();
  }
}

function wireRedact() {
  const svg = el('redact-svg');
  svg.addEventListener('pointerdown', redactDown);
  /* Followed wherever the finger goes, off the picture too: a point dragged
   * to the picture's edge is held there while the finger carries on past it
   * to see what it is lining up with. Listened for on the window, so a
   * finger let go off the picture still lets go. */
  window.addEventListener('pointermove', redactMove);
  window.addEventListener('pointerup', redactUp);
  window.addEventListener('pointercancel', redactUp);

  el('redact-tool').onclick = (event) => {
    const button = event.target.closest('[data-tool]');
    if (button) setRedactTool(button.dataset.tool);
  };
  el('redact-colour').onclick = (event) => {
    const button = event.target.closest('[data-colour]');
    if (button) setRedactColour(button.dataset.colour);
  };
  el('redact-zoom').onclick = () => {
    if (!redacting) return;
    redacting.zoom = redacting.zoom >= 3 ? 1 : redacting.zoom + 1;
    el('redact-zoom').textContent = `${redacting.zoom}×`;
    layoutRedact();
  };
  el('redact-undo').onclick = () => undoRedact();
  el('redact-redo').onclick = () => redoRedact();
  el('redact-delete').onclick = () => {
    const r = redacting;
    if (!r || r.drag) return;
    finishText();
    if (r.chosen < 0) return;
    changeRedact(r.shapes.filter((_, at) => at !== r.chosen));
  };
  el('redact-clear').onclick = () => {
    const r = redacting;
    if (!r || r.drag) return;
    finishText();
    r.warn = '';
    if (!r.shapes.length && !r.pending.length) { paintRedact(); return; }
    remember(r);
    r.pending = [];
    r.shapes = [];
    r.chosen = -1;
    paintRedact();
  };
  el('redact-confirm').onclick = () => confirmShape();
  el('redact-shape-cancel').onclick = () => {
    const r = redacting;
    if (!r || !r.pending.length) return;
    remember(r);
    r.pending = [];
    r.warn = '';
    paintRedact();
  };
  el('redact-text-input').addEventListener('input', () => retext({ text: el('redact-text-input').value }));
  el('redact-text-size').addEventListener('input', () => setTextSize(parseFloat(el('redact-text-size').value)));
  // A step at a time, and finer the smaller it is: half a pixel under ten.
  const step = (dir) => {
    const now = parseFloat(el('redact-text-size').value) || 12;
    setTextSize(now + dir * (now < 10 ? 0.5 : now < 30 ? 1 : 2));
  };
  el('redact-text-smaller').onclick = () => step(-1);
  el('redact-text-larger').onclick = () => step(1);
  el('redact-text-done').onclick = () => finishText();
  el('redact-text-delete').onclick = () => {
    const r = redacting;
    if (!r?.editing) return;
    r.shapes = r.shapes.filter((_, at) => at !== r.chosen);
    r.chosen = -1;
    finishText();
  };
  el('redact-restore').onclick = () => restoreRedact();
  el('redact-cancel').onclick = () => leaveRedact();
  el('redact-leave-no').onclick = () => { el('redact-leave').hidden = true; };
  el('redact-leave-yes').onclick = () => closeRedact();
  el('redact-save').onclick = () => saveRedact();
  /* Fitted again whenever the room for it changes -- a turned phone, or a
   * hint running to a second line under it -- or a picture fitted to the old room
   * spills off the new one. Not every WebView has the observer; those still
   * hear about the phone turning. */
  window.addEventListener('resize', () => { if (redacting) layoutRedact(); });
  if (typeof window.ResizeObserver === 'function') {
    new window.ResizeObserver(() => { if (redacting && redacting.zoom === 1) layoutRedact(); })
      .observe(el('redact-stage'));
  }

  screens.onRedact((bookId, href) => openRedact(bookId, href));
  screens.onPicture((blob, about) => offerPicture(blob, about));
  el('picture-cancel').onclick = () => { el('picture-sheet').hidden = true; };
  el('picture-sheet').onclick = (e) => {
    if (e.target === el('picture-sheet')) el('picture-sheet').hidden = true;
  };
  el('redact-pick-close').onclick = () => closeRedactPick();
  wireRedactWhileReading();
  el('reel-redact').onclick = () => {
    if (reader.state.book) openRedactPick(reader.state.book);
    else toast('Open a book first');
  };
  el('remove-look-redact').onclick = () => {
    if (!looking || !removing) return;
    const pages = removeMode === 'pages';
    const row = (pages ? removing.pages : removing.rows)[looking.of[looking.cursor]];
    const href = row?.picture || row?.pictureHrefs?.[0];
    if (href) openRedact(removing.book.id, href);
  };
}

/* ── the last word before it happens ─────────────────────────────────────
 *
 * Taking pages out is the one operation here that deleting the result does
 * not undo, so it is the one that gets a confirmation -- and the
 * confirmation is the pages themselves, because "12 pages" is not something
 * anybody can check.
 *
 * What it says about pictures, marks and what is left all comes from the same
 * plan the removal runs, read rather than written. A preview computed by a
 * second piece of code that is supposed to agree with the first will
 * eventually disagree, and then it is worse than none.
 */
async function askAboutRemoval() {
  if (!removing || !removePicked.size) return;

  let look;
  try {
    look = await trim.preview(removing.book.id, removeMode, pickedKeys());
  } catch (error) {
    return toast(error.message || 'That could not be taken out', 6000);
  }

  el('remove-confirm-what').textContent = `Taking out ${look.what}`;

  /* A strip of what is going, in the order it sits in the book.
   *
   * Capped, with the rest counted: a hundred thumbnails in a sheet is a
   * scroll nobody finishes, and the point is to recognise the kind of thing
   * being removed rather than to audit every one. Looking through all of them
   * is the button next to it. */
  const strip = el('remove-confirm-strip');
  strip.innerHTML = '';
  const SHOWN = 12;

  for (const item of look.items.slice(0, SHOWN)) {
    const cell = document.createElement('div');
    cell.className = 'remove-strip-cell';

    const blob = item.picture ? removing.pictures.get(item.picture) : null;
    if (blob) {
      const img = document.createElement('img');
      img.src = removeThumbs.url(item.picture, blob, blob.size);
      img.alt = '';
      cell.appendChild(img);
    } else {
      const text = document.createElement('span');
      text.className = 'remove-strip-text';
      text.textContent = item.text || item.note || item.label;
      cell.appendChild(text);
    }

    const name = document.createElement('small');
    name.textContent = item.label;
    cell.appendChild(name);
    strip.appendChild(cell);
  }

  if (look.items.length > SHOWN) {
    const more = document.createElement('div');
    more.className = 'remove-strip-cell more';
    more.innerHTML = `<span>+${look.items.length - SHOWN}</span><small>more</small>`;
    strip.appendChild(more);
  }

  /* Everything that goes with it, said rather than discovered afterwards.
   *
   * The marks line is the one that matters: a bookmark on text that is being
   * removed cannot stay where it is, and finding that out after the fact is
   * how somebody loses a note they cared about. */
  const parts = [];
  if (look.pictures) {
    parts.push(look.pictures === 1
      ? '1 picture stops being used'
      : `${look.pictures} pictures stop being used`);
  }
  if (look.marks) {
    parts.push(look.marks === 1
      ? '1 bookmark comes out with it'
      : `${look.marks} bookmarks come out with them`);
  }
  /* Only worth saying when pages are what is being removed.
   *
   * Taking chapters out obviously costs chapters, and repeating it under a
   * heading that already says "2 chapters" reads as a second, different
   * consequence. Taking pages out emptying a whole chapter is the surprise,
   * and that is the case this is here for. */
  const gone = look.chaptersWas - look.chaptersLeft;
  if (gone > 0 && look.mode === 'pages') {
    parts.push(gone === 1
      ? '1 chapter is emptied and goes with them'
      : `${gone} chapters are emptied and go with them`);
  }

  el('remove-confirm-note').innerHTML =
    `<b>${look.pagesLeft} page${look.pagesLeft === 1 ? '' : 's'} and ${
      look.chaptersLeft} chapter${look.chaptersLeft === 1 ? '' : 's'} left.</b>`
    + (parts.length ? ` ${escapeText(parts.join(' · '))}.` : '')
    + (removeOrigin === 'reader' && current !== 'remove'
      // Asked from the page itself, where there is no "this screen".
      ? ' It can be put back from Take out in the reader’s toolbar until you discard it.'
      : ' Everything here can be put back from this screen until you discard it.');

  el('remove-confirm').hidden = false;
}

/** The picks, as the numbers the removal itself takes. */
function pickedKeys() {
  if (removeMode === 'pages') return [...removePicked];
  // A chapter is picked by where it sits in the list; the removal wants the
  // chapter's own number, and after an earlier removal those are not the
  // same thing to rely on.
  return [...removePicked].map((at) => removing.rows[at]?.index).filter((n) => n != null);
}

/**
 * What has already been taken out of this book, and the two ways back.
 *
 * Put back is offered for the newest removal only, and that is the whole
 * reason it is exact rather than a guess: nothing has happened to the book
 * since, so the positions the removal recorded still describe the book it is
 * going back into.
 */
function removeHistory() {
  const panel = document.createElement('div');
  panel.className = 'remove-history';

  const records = trim.removalSummary(removing.book);
  const total = records.reduce((n, record) => n + record.count, 0);

  const line = document.createElement('p');
  line.innerHTML = `<b>${total} taken out of this book</b>`;
  panel.appendChild(line);

  const list = document.createElement('div');
  list.className = 'remove-history-list';
  for (const record of [...records].reverse()) {
    const item = document.createElement('p');
    item.className = 'muted';
    item.textContent = record.newest
      ? `${record.what} — the most recent`
      : `${record.what}`;
    list.appendChild(item);
  }
  panel.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'remove-history-actions';

  const back = document.createElement('button');
  back.className = 'btn ghost';
  back.textContent = 'Put the last one back';
  back.onclick = () => runPutBack();
  actions.appendChild(back);

  const gone = document.createElement('button');
  gone.className = 'btn ghost';
  gone.textContent = 'Discard for good';
  gone.title = 'Frees the space the removed pictures still take up';
  gone.onclick = () => runDiscard();
  actions.appendChild(gone);

  panel.appendChild(actions);
  return panel;
}

async function runPutBack() {
  if (!removing) return;
  const id = removing.book.id;
  const done = progress.start('Putting it back');
  try {
    const out = await trim.putBack(id, { onProgress: done.step });
    if (reader.state.book?.id === id) readerStale = { bookId: id, land: readerLanding };
    toast(`${out.what} back in the book`, 5000, { kind: 'done' });
    await refreshShelf();
    await reopenRemove(id);
  } catch (error) {
    done.fail();
    toast(error.message || 'That could not be put back', 6000, { kind: 'failed' });
  } finally {
    done();
  }
}

async function runDiscard() {
  if (!removing) return;
  const id = removing.book.id;
  const count = (removing.history || []).reduce((n, r) => n + (r.count || 0), 0);

  // Asked for in the footer rather than a dialog, as deleting books is.
  el('confirm-text').textContent = `Discard ${count} removed item${count === 1 ? '' : 's'}? They cannot be put back.`;
  el('confirm-yes').textContent = 'Discard';
  el('confirm-bar').hidden = false;

  el('confirm-no').onclick = () => { el('confirm-bar').hidden = true; resetConfirm(); };
  el('confirm-yes').onclick = async () => {
    el('confirm-bar').hidden = true;
    resetConfirm();
    const done = progress.start('Discarding');
    try {
      const out = await trim.discard(id, { onProgress: done.step });
      toast(out.pictures
        ? `Discarded — ${out.pictures} picture${out.pictures === 1 ? '' : 's'} freed`
        : 'Discarded', 5000, { kind: 'done' });
      await reopenRemove(id);
    } catch (error) {
      done.fail();
      toast(error.message || 'That could not be discarded', 6000, { kind: 'failed' });
    } finally {
      done();
    }
  };
}

/** Read the book again, so the screen shows what it is now. */
async function reopenRemove(bookId) {
  const book = await store.get('books', bookId);
  if (!book) { removing = null; return show('library'); }
  removeThumbs.release();
  removing = await trim.inspect(bookId);
  removePicked = new Set();
  removeShown = null;
  if (removeMode === 'pages' && !removing.canPages) removeMode = 'chapters';
  if (removeMode === 'chapters' && !removing.canChapters) removeMode = 'pages';
  renderRemove();
}

function wireRemove() {
  el('remove-none').onclick = () => { removePicked = new Set(); renderRemove(); };

  // Hold a chapter or a page and drag to pick a run of them.
  dragToPick({
    host: el('remove-body'),
    scroller: el('remove-body'),
    item: '.remove-row, .remove-cell',
    ignore: '.remove-look-btn',
    picked: (at) => removePicked.has(at),
    set: (at, value) => {
      if (value) removePicked.add(at); else removePicked.delete(at);
      const node = el('remove-body').querySelector(`[data-at="${at}"]`);
      if (node) node.setAttribute('aria-pressed', String(value));
    },
    changed: () => removeFooter(),
  });

  // The footer asks; the sheet is what actually sets it going.
  el('remove-go').onclick = () => askAboutRemoval();

  el('remove-confirm-cancel').onclick = () => { el('remove-confirm').hidden = true; };
  el('remove-confirm').onclick = (event) => {
    if (event.target === el('remove-confirm')) el('remove-confirm').hidden = true;
  };

  /* Straight from the confirmation into looking through exactly what it
   * listed, which is the honest answer to "are you sure": not a bigger
   * warning, the pages themselves. */
  el('remove-confirm-look').onclick = () => {
    el('remove-confirm').hidden = true;
    const picked = [...removePicked].sort((a, b) => a - b);
    if (picked.length) openRemoveLook(picked[0], picked);
  };

  el('remove-look-close').onclick = () => closeRemoveLook();
  el('remove-look-prev').onclick = () => stepRemoveLook(-1);
  el('remove-look-next').onclick = () => stepRemoveLook(1);
  el('remove-look-pick').onclick = () => {
    if (!looking) return;
    const at = looking.of[looking.cursor];
    if (removePicked.has(at)) removePicked.delete(at);
    else removePicked.add(at);
    paintRemoveLook();
  };

  el('remove-confirm-go').onclick = async () => {
    el('remove-confirm').hidden = true;
    if (!removing || !removePicked.size) return;
    const id = removing.book.id;
    const done = progress.start('Taking it out');
    try {
      // Where the reader is, written down first: the removal moves the saved
      // place along with the pages, and it can only move what was saved.
      if (current === 'reader' && reader.state.book?.id === id) {
        reader.holdPosition();
        await store.flushPosition();
      }
      const take = removeMode === 'pages' ? trim.removePages : trim.removeChapters;
      const out = await take(id, pickedKeys(), { onProgress: done.step });

      await refreshShelf();
      if (reader.state.book?.id === id) readerStale = { bookId: id, land: readerLanding };

      if (removeOrigin === 'reader') {
        /* Back to reading, at the same place -- not to the list of pages,
         * and certainly not to the shelf. */
        const marks = out.marks ? `, ${out.marks} mark${out.marks === 1 ? '' : 's'} with it` : '';
        removeOrigin = null;
        if (current === 'remove') back();
        else await reloadReader();
        toast(`${out.what} taken out${marks} — put it back from Take out in the toolbar`, 7000, { kind: 'done' });
        return;
      }
      await reopenRemove(id);

      /* Said in full, because it is the one operation here that changes a
       * book that already exists -- and the sentence that matters is the one
       * about getting it back. */
      const marks = out.marks
        ? `, ${out.marks} mark${out.marks === 1 ? '' : 's'} with it`
        : '';
      toast(`${out.what} taken out${marks} — put back from this screen`, 7000, { kind: 'done' });
    } catch (error) {
      done.fail();
      toast(error.message || 'That could not be taken out', 6000, { kind: 'failed' });
    } finally {
      done();
    }
  };
}

let lastEvery = 0;

/* ── the workshop ─────────────────────────────────────────────────────────
 *
 * Several files in, one book out. The order is the whole point of a serial,
 * so it is shown and movable rather than inferred and hoped for.
 */

/**
 * Shorten a long name from the middle, keeping both ends.
 *
 * The end of a filename is where the volume number lives, and cutting there
 * leaves a list of parts that all read the same: ordering them becomes
 * guesswork. Names short enough to fit are left alone.
 */
function shortenMiddle(name, limit = 64) {
  const text = String(name);
  if (text.length <= limit) return text;

  /* The cut is placed around the last number, not at a fixed midpoint.
   *
   * Which part a file is is almost always a number, and a blind middle cut
   * lands wherever it lands -- "Volume 14" came back as "lume 14", which is
   * worse than useless in a list being put in order. Finding the last run of
   * digits and keeping everything from a little before it onwards means the
   * part that identifies the file always survives.
   */
  const lastNumber = text.search(/\d+(?!.*\d)/);
  const fromNumber = lastNumber === -1 ? 0 : text.length - lastNumber;

  const MIN_HEAD = 12;
  // Enough lead-in to bring the word before the number with it: "14" alone
  // is ambiguous where "Volume 14" is not.
  const wanted = Math.max(Math.floor((limit - 1) * 0.55), fromNumber + 10);
  const tail = Math.min(wanted, limit - 1 - MIN_HEAD);
  const head = limit - 1 - tail;

  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Whether the title field has been typed into, so suggestions stop. */
let buildTitleTouched = false;

/* The cover a build will have.
 *
 * Left alone, it is the first part's -- a book built onto keeps its own, a
 * run of pictures starts with its first page -- and that is shown here before
 * building, so it is not a surprise afterwards. One chosen here replaces it,
 * and goes into the book as a cover chosen in Details does. */
let buildCover = null;
// Where it came from: the first book ('first'), a picture in one of the
// books ('book', with what it was), or a picture of your own ('file').
let buildCoverFrom = 'first';
let buildCoverWhat = '';
const buildCoverUrls = blobs.pool();
const coverPickUrls = blobs.pool();

async function paintBuildCover() {
  const box = el('build-cover');
  const first = build.contents()[0];
  let shown = buildCover;
  let note = buildCoverFrom === 'book'
    ? `${buildCoverWhat}. It goes into the book as its cover.`
    : 'Your own picture. It goes into the book as its cover.';
  if (!shown && first) {
    // The first book's own, looked for in the file if it is not on the shelf.
    shown = await build.firstCover();
    note = shown
      ? `The cover of the first book, “${shortenMiddle(first.name)}”.`
      : 'The first book has no cover to show. The next one that does is used, or pick one.';
  }
  buildCoverUrls.release();
  const url = shown ? buildCoverUrls.url(shown) : null;
  box.classList.toggle('empty', !url);
  box.innerHTML = url ? `<img src="${url}" alt="">` : '<span>No cover yet</span>';
  el('build-cover-note').textContent = first ? note : '';
  el('build-cover-clear').setAttribute('aria-pressed', String(!buildCover));
  el('build-cover-from-books').setAttribute('aria-pressed', String(!!buildCover && buildCoverFrom === 'book'));
  el('build-cover-pick').setAttribute('aria-pressed', String(!!buildCover && buildCoverFrom === 'file'));
}

/* Any picture in any of the books, as the combined book's cover.
 *
 * Each book is looked into for its pictures -- a book on the shelf has them
 * already; a file is opened only as far as its list of pictures -- and they
 * are shown a few rows at a time, since a volume of a comic is hundreds of
 * pages and drawing them all at once is a wall and a lot of memory. */
const PICK_BATCH = 16;

/**
 * Any picture from a list of sources, chosen as a cover.
 *
 * @param sources  [{ name, pictures: () => [{ name, load() }] }] -- the parts
 *                 of a build, or a book and its other editions
 * @param onPick   (blob, label) once one is chosen and made a cover of
 */
async function openCoverPick({ sources, onPick, title = 'Cover from the books', none } = {}) {
  const sheet = el('cover-pick-sheet');
  const list = el('cover-pick-list');
  coverPickUrls.release();
  list.innerHTML = '';
  sheet.querySelector('.eyebrow').textContent = title;
  sheet.hidden = false;
  let any = false;
  for (const source of sources) {
    const section = document.createElement('section');
    section.className = 'cover-pick-part';
    section.innerHTML = `<h3>${escapeText(shortenMiddle(source.name))}</h3><p class="muted" style="font-size:12px;margin:0">Looking…</p>`;
    list.appendChild(section);
    const pictures = await source.pictures().catch(() => []);
    if (sheet.hidden) return;              // closed while looking
    const note = section.querySelector('p');
    if (!pictures.length) { note.textContent = 'No pictures in this one.'; continue; }
    any = true;
    note.remove();
    const grid = document.createElement('div');
    grid.className = 'cover-pick-grid';
    section.appendChild(grid);
    let shown = 0;
    const more = document.createElement('button');
    more.className = 'btn ghost cover-pick-more';
    const showMore = async () => {
      const batch = pictures.slice(shown, shown + PICK_BATCH);
      shown += batch.length;
      more.hidden = shown >= pictures.length;
      more.textContent = `Show more (${pictures.length - shown} left)`;
      for (const [n, picture] of batch.entries()) {
        const button = document.createElement('button');
        button.title = picture.name;
        grid.appendChild(button);
        const blob = await picture.load().catch(() => null);
        if (sheet.hidden) return;
        const url = blob ? coverPickUrls.url(blob) : null;
        if (!url) { button.remove(); continue; }
        button.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
        // A spacer that slipped through by size is dropped by its shape.
        button.firstChild.onload = function () {
          if (this.naturalWidth < 60 && this.naturalHeight < 60) button.remove();
        };
        const number = shown - batch.length + n + 1;
        button.onclick = async () => {
          try {
            // Decoded and re-encoded, as a picture of your own is.
            const cover = await blobs.normaliseCover(new File([blob], picture.name || 'cover', { type: blob.type }));
            closeCoverPick();
            await onPick(cover, `Picture ${number} of “${shortenMiddle(source.name)}”`);
          } catch (error) {
            toast(error.message, 6000);
          }
        };
      }
    };
    more.onclick = showMore;
    section.appendChild(more);
    await showMore();
  }
  if (!any && !sheet.hidden) {
    list.insertAdjacentHTML('beforeend', `<p class="muted" style="padding:8px 0">${escapeText(none
      || 'None of these books has pictures in it that can be read before building. Choose a picture of your own instead.')}</p>`);
  }
}

/** The cover for a build, from any picture in its parts. */
function openBuildCoverPick() {
  return openCoverPick({
    sources: build.contents().map((part) => ({ name: part.name, pictures: () => build.picturesOf(part) })),
    onPick: async (cover, label) => {
      buildCover = cover;
      buildCoverFrom = 'book';
      buildCoverWhat = label;
      await paintBuildCover();
    },
  });
}

/** A book's pictures, in reading order, for choosing one as its cover. */
async function picturesOfBook(bookId) {
  return (await library.livePictures(bookId))
    .filter((image) => image.blob)
    .sort((a, b) => (a.chapterIndex || 0) - (b.chapterIndex || 0) || (a.order || 0) - (b.order || 0))
    .map((image) => ({ name: image.href, load: async () => image.blob }));
}

function closeCoverPick() {
  if (el('cover-pick-sheet').hidden) return false;
  el('cover-pick-sheet').hidden = true;
  coverPickUrls.release();
  el('cover-pick-list').innerHTML = '';
  return true;
}

/* ── a build under way ─────────────────────────────────────────────────
 *
 * The progress panel only reports: it takes no taps, so nothing on it gets
 * in the way of the shelf or the page (minimising aside). What a build can
 * be told -- "Pause & keep" -- is on Build's own footer instead, where it
 * was started: the Build button becomes Pause & keep while a website is
 * downloading, and the count beside it says how far it has got.
 */
let buildRun = null;   // { online, pausing, status, finish } while a build runs

/** The progress panel above Build's footer while that is on screen. */
function liftProgress() {
  const foot = el('build-foot');
  document.body.classList.toggle('build-foot-up', current === 'workshop' && !!foot && !foot.hidden);
}

function paintBuildFoot() {
  liftProgress();
  // Not while it builds: what it is building is settled.
  const fromShelf = el('build-from-shelf');
  if (fromShelf) fromShelf.hidden = !!buildRun;
  const go = el('build-go');
  const clear = el('build-clear');
  if (!go || !clear) return;
  const run = buildRun;
  go.classList.toggle('primary', !run);
  go.classList.toggle('ghost', !!run);
  clear.disabled = !!run;
  if (!run) {
    go.textContent = 'Build';
    go.disabled = false;
    return;
  }
  go.textContent = run.pausing ? 'Pausing…' : run.online ? 'Pause & keep' : 'Building…';
  go.disabled = run.pausing || !run.online;
  if (run.status) el('build-count').textContent = run.status;
}

/* ── how long it has been, and is to be ───────────────────────────────── */

/** "45 s", "12 m", "1 h 05 m". */
function span(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

/** A guess at reading one page, the delay apart, before any has come. */
/** A guess, before any page has come, at a page's time from asking to answer:
 *  its loading, and the few seconds it is stayed on to confirm its story. */
const PAGE_GUESS_MS = 9000;
const STAY_GUESS_MS = 3000;
/** How many measured pages count for as much as the guess. */
const GUESS_WEIGHT = 3;
/** How many of the latest chapters the fallback estimate goes by (no delay set). */
const RECENT_CHAPTERS = 20;
/** How many chapters until what they took counts for more than the guess. */
const TRUST_AFTER = 5;

/** The middle value; and the value a fraction of the way up (0.2, 0.8). */
const middleOf = (values) => quantileOf(values, 0.5);
function quantileOf(values, q) {
  if (!values?.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * The fallback, where there is no delay to go by (none set): each chapter's
 * whole time, the latest 20, one more than three times the typical counted
 * as three.
 */
function chapterTime(samples, guess) {
  const recent = samples.slice(-RECENT_CHAPTERS);
  if (!recent.length) return guess;
  const typical = middleOf(recent);
  const mean = recent.reduce((sum, ms) => sum + Math.min(ms, typical * 3), 0) / recent.length;
  if (!Number.isFinite(guess)) return mean;
  const trust = Math.min(1, recent.length / TRUST_AFTER);
  return trust * mean + (1 - trust) * guess;
}

/**
 * What a chapter of this website costs, taken apart into what is known and
 * what is measured:
 *
 *   the delay   known: the reader set it, and its give-or-take evens out --
 *               it is not guessed from how the waits happened to fall (times
 *               how much slower the site has asked it to go);
 *   a page      measured: the middle of the latest pages' times from asking
 *               to answer -- the middle, so one long hold does not move it --
 *               blended from a guess while few have come (no step at the
 *               fifth); the time stayed to confirm it comes off the delay
 *               after, so a page costs (time − stay) + the longer of the stay
 *               and the delay;
 *   pages each  measured: how many requests a chapter has needed -- second
 *               pages, retries -- so a three-page chapter counts as three,
 *               not as a slow one;
 *   pauses      the pauses taken between tries, spread over the chapters.
 *
 * `band` is how wide the likely spread is, a chapter's worth: the pages'
 * own spread (the 20th to 80th of a hundred), for a range shown beside it.
 */
function chapterCost(run, part) {
  const stats = run.stats;
  if (!part || !(part.gap > 0 || part.jitter > 0) || !stats) return null;
  const delay = part.gap * (stats.slower || 1);
  const n = stats.times.length;
  const blend = (measured, guess) => (n ? (n * measured + GUESS_WEIGHT * guess) / (n + GUESS_WEIGHT) : guess);
  const page = blend(middleOf(stats.times), PAGE_GUESS_MS);
  const stay = Math.min(page, blend(middleOf(stats.dwells), STAY_GUESS_MS));
  const cycle = (page - stay) + Math.max(stay, delay);
  const pages = (stats.requests + 2) / (stats.chapters + 2);
  const pauses = stats.napMs / (stats.chapters + 2);
  const spread = n >= 5 ? (quantileOf(stats.times, 0.8) - quantileOf(stats.times, 0.2)) / 2 : NaN;
  return { each: pages * cycle + pauses, band: spread * pages, jitter: (part.jitter || 0) * (stats.slower || 1) };
}

/**
 * The time left, and how far either way it may well be (null if not yet
 * to be said): this chapter's rest, the chapters after it at what one
 * costs (chapterCost), a wait the site asked for still to run, and the
 * websites after this one at their delays and the pages measured here.
 */
function timeLeft(run, now) {
  const left = run.total - run.done;
  if (!(left > 0)) return { ms: 0, band: 0 };
  const part = run.delays?.[run.at];
  const cost = chapterCost(run, part);
  const each = cost ? cost.each : chapterTime(run.samples || [], part ? part.gap + PAGE_GUESS_MS - STAY_GUESS_MS : NaN);
  if (!Number.isFinite(each)) return null;
  const since = now - (run.lastCame || run.partStart || now);
  let ms = Math.max(0, each - since) + each * (left - 1);
  // Waiting out what the site asked for, or a pause before one more try: known, and beyond the usual.
  if (run.waitingUntil > now) ms += run.waitingUntil - now;
  const page = cost && run.stats?.times.length ? middleOf(run.stats.times) : PAGE_GUESS_MS;
  for (const later of (run.delays || []).slice(run.at + 1)) {
    if (later) ms += later.chapters * (Math.max(0, page - STAY_GUESS_MS) + Math.max(STAY_GUESS_MS, later.gap));
  }
  /* How far either way: the pages' spread for every chapter left, and the
   * delay's give-or-take, which evens out over many (its spread grows as the
   * square root of how many). */
  const band = cost && Number.isFinite(cost.band)
    ? cost.band * left + (cost.jitter / Math.sqrt(3)) * Math.sqrt(left)
    : NaN;
  return { ms, band };
}

/**
 * What is shown, counting down by the second, against a new estimate: left
 * as it is while the two are near (within 3%, or half a minute) -- so it does
 * not wobble with each chapter -- and otherwise moved toward it: quickly when
 * it is more (the site is slowing: worth knowing), slowly when it is less (a
 * few quick chapters are no promise).
 */
function steady(ticked, target) {
  if (ticked == null) return target;
  const off = target - ticked;
  if (Math.abs(off) <= Math.max(30000, ticked * 0.03)) return ticked;
  return ticked + off * (off > 0 ? 0.25 : 0.08);
}

/**
 * Time so far, and an estimate of the time left -- on the progress row, by
 * the count, and beside Pause & keep (see timeLeft). Shown counting down
 * second by second, and eased toward a new estimate rather than jumping to
 * it each time a chapter comes.
 */
function paintTimes() {
  const run = buildRun;
  if (!run) return;
  const now = Date.now();
  const elapsed = span(now - run.startedAt);
  let left = '';
  if (Number.isFinite(run.total) && Number.isFinite(run.done) && run.done < run.total) {
    const estimate = timeLeft(run, now);
    if (estimate === null) {
      left = 'estimating…';
    } else {
      run.shown = steady(run.shown == null ? null : Math.max(0, run.shown - (now - run.shownAt)), estimate.ms);
      run.shownAt = now;
      // A range once there is enough to say one, and when it is worth saying.
      const band = Number.isFinite(estimate.band) && estimate.band >= 120000 ? ` (± ${span(estimate.band)})` : '';
      left = `~${span(run.shown)} left${band}`;
    }
  }
  // Chapters, while a website downloads ("120 of 453"); otherwise which part of how many.
  const count = Number.isFinite(run.total) && Number.isFinite(run.done) ? `${run.done} of ${run.total} · `
    : run.parts > 1 ? `part ${run.at + 1} of ${run.parts} · ` : '';
  run.finish?.say(null, null, `${count}${elapsed}${left ? ` · ${left}` : ''}`);
  if (!run.pausing && Number.isFinite(run.total)) {
    run.status = `${run.done} of ${run.total}${left ? ` · ${left}` : ''}`;
    paintBuildFoot();
  }
}

/** Pause & keep: the download stops now -- a chapter half-come is dropped,
 *  and is where it carries on -- the book is made of what came, and the
 *  rest is kept to carry it on. */
function pauseBuild() {
  const run = buildRun;
  if (!run || !run.online || run.pausing) return;
  run.pausing = true;
  run.status = 'Pausing — making the book…';
  run.finish?.say('Paused — making the book of the chapters that have come…');
  // Stopped now: what is on its way is dropped, and is where it carries on.
  web.stopAll();
  paintBuildFoot();
}

/* ── the queue ─────────────────────────────────────────────────────────
 *
 * Several websites, each with its own chapters ticked and its own title,
 * waiting their turn: built one after another, a book each, with the same
 * settings for all -- the Website screen's delay, list delay and pictures,
 * as they are when each one's turn comes. Each goes into Build when its turn
 * comes and is built there as any website is: what does not come is kept as
 * a leftover, as ever, and Overnight carries it on before the queue goes on.
 *
 * It stops, keeping the rest, when Pause & keep is pressed, or when a site
 * itself says stop -- blocked, a check to pass, "too many requests" -- since
 * going on would only ask again. Kept across the app being closed; it starts
 * again only when asked.
 */
let webQueue = [];   // [{ id, name, author, sources, cover, links: [{ url, text }] }]
const queueState = { running: false, built: 0, last: null, stopAfter: false };
let runBuild = async () => {};

function saveQueue() {
  store.saveSettings({ webQueue }).catch(() => {});
  paintQueue();
}

/** A failure that means a site wants no more asking for now. */
const queueHalts = (reason) => web.blocked(reason) || web.wantsCheck(reason) || web.tooMany(reason);

/** The ticked chapters on the Website screen, into the queue as a book of their own. */
function queueWeb() {
  let chosen = webState.links.filter((link) => link.picked);
  if (!chosen.length) return;
  if (!webState.manualOrder) chosen = web.inReadingOrder(chosen, () => true).links;
  const name = (el('web-title').value || '').trim() || webState.title || 'From the web';
  webQueue.push({
    id: `q-${Date.now()}`, name, author: webState.author || '', sources: webState.sources || [],
    cover: webState.cover || '', links: chosen.map(({ url, text }) => ({ url, text })),
  });
  saveQueue();
  clearWeb();
  toast(`“${name}” queued — ${chosen.length} chapter${chosen.length === 1 ? '' : 's'}. ${webQueue.length} website${webQueue.length === 1 ? '' : 's'} in the queue, on Build.`, 5000);
  back();
}

async function startQueue() {
  if (!webQueue.length || queueState.running) return;
  if (buildRun) { toast('Build is busy — the queue can start once it is done.'); return; }
  if (!build.isEmpty()) {
    toast('Build has parts in it — build or clear them first; the queue builds each website on its own.', 6000);
    return;
  }
  Object.assign(queueState, { running: true, built: 0, stopAfter: false });
  try { window.GrimoireNative?.keepScreenOn?.(true); } catch { /* not in a browser */ }
  paintQueue();
  await nextInQueue();
}

/** Stopped once the website under way is done (or paused), the rest kept. */
function stopQueueAfterThis() {
  queueState.stopAfter = true;
  paintQueue();
  toast('The queue stops after this book — the rest stay queued.');
}

function endQueue(message, title) {
  queueState.running = false;
  queueState.stopAfter = false;
  paintQueue();
  renderWorkshop();
  if (current !== 'reader' && !night.timer) {
    try { window.GrimoireNative?.keepScreenOn?.(false); } catch { /* not in a browser */ }
  }
  if (message) {
    whenNotReading(() => toast(message, 8000, { kind: 'done' }));
    notifyBuild({ title, text: message });
  }
}

/** After every build: on to the queue's next website, if it is running and may. */
function queueAfter(last) {
  if (!queueState.running) return;
  const built = `${queueState.built} book${queueState.built === 1 ? '' : 's'} built`;
  if (last?.paused) { endQueue(`Queue paused — ${built}; ${webQueue.length} still queued. Start queue goes on.`, 'Queue paused'); return; }
  if (last?.halt) { endQueue(`Queue stopped: the site said to stop — ${built}; ${webQueue.length} still queued.`, 'Queue stopped'); return; }
  setTimeout(() => { nextInQueue(); }, 1500);
}

async function nextInQueue() {
  if (!queueState.running || buildRun) return;
  const built = `${queueState.built} book${queueState.built === 1 ? '' : 's'} built`;
  // Overnight is carrying the last one on: the queue goes on once that is done.
  if (night.timer) { paintQueue(); return; }
  if (queueState.stopAfter) { endQueue(`Queue stopped as asked — ${built}; ${webQueue.length} still queued.`, 'Queue stopped'); return; }
  if (!build.isEmpty()) {
    endQueue(`Queue stopped — Build has parts in it; ${webQueue.length} still queued.`, 'Queue stopped');
    return;
  }
  if (!webQueue.length) { endQueue(`Queue done — ${built}.`, 'Queue done'); return; }
  const item = webQueue.shift();
  saveQueue();
  const cover = item.cover ? await web.fetchCover(item.cover).catch(() => null) : null;
  build.addWeb({
    name: item.name, links: item.links, pictures: webState.pictures, cover,
    author: item.author, sources: item.sources, gap: webDelay(), jitter: webJitter(),
  });
  el('build-title').value = item.name;
  buildTitleTouched = true;
  el('build-author').value = item.author || '';
  renderWorkshop();
  await runBuild();
}

/** The queue on Build: what is waiting, the settings all share, start or stop. */
function paintQueue() {
  const box = el('build-queue');
  if (!box) return;
  box.hidden = !webQueue.length && !queueState.running;
  const n = webQueue.length;
  el('build-queue-title').textContent = queueState.running
    ? `Queue · building, ${n} more waiting`
    : `Queue · ${n} website${n === 1 ? '' : 's'}`;
  const jitter = webJitter();
  el('build-queue-note').textContent = 'Each a book of its own, one after another, all at the Website screen\'s settings: '
    + `${webDelay()}${jitter ? ` ± ${jitter}` : ''} ms between chapters, list pages ${webListDelay()} ± ${webListJitter()} ms, `
    + `pictures ${webState.pictures ? 'on' : 'off'}.`;
  const go = el('build-queue-go');
  go.textContent = queueState.running ? (queueState.stopAfter ? 'Stopping after this…' : 'Stop after this book') : 'Start queue';
  go.disabled = queueState.running ? queueState.stopAfter : (!n || !!buildRun);
  const list = el('build-queue-list');
  list.replaceChildren();
  webQueue.forEach((item, at) => {
    const row = document.createElement('li');
    let host = '';
    try { host = new URL(item.sources?.[0] || item.links[0]?.url).host; } catch { /* no address */ }
    row.innerHTML = `<span class="col"><b>${escapeText(shortenMiddle(item.name))}</b>`
      + `<small class="muted">${item.links.length} chapter${item.links.length === 1 ? '' : 's'}${host ? ` · ${escapeText(host)}` : ''}</small></span>`;
    for (const [by, label, path] of [
      [-1, 'Move up', 'M12 19V5M5 12l7-7 7 7'],
      [1, 'Move down', 'M12 5v14M5 12l7 7 7-7'],
      [0, 'Remove from the queue', 'M6 6l12 12M18 6L6 18'],
    ]) {
      const button = document.createElement('button');
      button.className = 'icon-btn';
      button.title = label;
      button.innerHTML = `<svg viewBox="0 0 24 24"><path d="${path}"/></svg>`;
      button.disabled = by < 0 ? at === 0 : by > 0 ? at === n - 1 : false;
      button.onclick = () => {
        if (by === 0) webQueue.splice(at, 1);
        else webQueue.splice(at + by, 0, ...webQueue.splice(at, 1));
        saveQueue();
        renderWorkshop();
      };
      row.appendChild(button);
    }
    list.appendChild(row);
  });
}

/* ── overnight ─────────────────────────────────────────────────────────
 *
 * A website of six hundred chapters, left to build overnight with the phone
 * on. A site that turns requests away, a page that will not load, the app
 * cut off: any of them stops it, and nobody is awake to carry it on. With
 * Overnight ticked, a build that stops on its own (not by Pause & keep) is
 * carried on every 15 minutes -- the book it got to and the rest after it,
 * as Carry on does -- until it is all there. A chapter the site says is
 * gone (404) is passed over and said in the morning; the same chapter
 * stopping it five times running ends the night, and says so. The shorter
 * books each carry leaves behind go to the Bin, so the morning has one.
 */
const OVERNIGHT_MS = 15 * 60 * 1000;
const OVERNIGHT_SAME_STOPS = 5;
let overnight = false;
const night = { timer: null, at: 0, run: null, why: '', lastStop: '', sameStops: 0, made: new Set(), skipped: [] };
store.settings().then((settings) => {
  overnight = settings.buildOvernight === true;
  const box = el('build-overnight');
  if (box) box.checked = overnight;
}).catch(() => {});

function keepAwake(on) {
  try { window.GrimoireNative?.keepScreenOn?.(on); } catch { /* not in the app */ }
}

/** Carry it on in 15 minutes; false when the night is over instead. */
function scheduleOvernight(run, why, stopAt = '') {
  if (stopAt && stopAt === night.lastStop) night.sameStops += 1;
  else { night.lastStop = stopAt; night.sameStops = 1; }
  if (night.sameStops >= OVERNIGHT_SAME_STOPS) {
    endOvernight();
    const text = `It stopped at the same chapter ${OVERNIGHT_SAME_STOPS} times running — ${why}. What came is on the shelf, and the rest is in Build.`;
    toast(`Overnight build gave up. ${text}`, 12000);
    notifyBuild({ title: 'Overnight build gave up', text });
    return false;
  }
  clearTimeout(night.timer);
  night.at = Date.now() + OVERNIGHT_MS;
  night.run = run;
  night.why = why;
  night.timer = setTimeout(() => {
    const go = night.run;
    night.timer = null;
    night.run = null;
    paintOvernight();
    Promise.resolve(go?.()).catch(() => {});
  }, OVERNIGHT_MS);
  keepAwake(true);
  paintOvernight();
  return true;
}

function endOvernight() {
  clearTimeout(night.timer);
  night.timer = null;
  night.run = null;
  night.lastStop = '';
  night.sameStops = 0;
  if (!buildRun) keepAwake(false);
  paintOvernight();
}

function paintOvernight() {
  const note = el('build-overnight-note');
  if (!note) return;
  if (!night.timer) { note.hidden = true; note.replaceChildren(); return; }
  const at = new Date(night.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  note.innerHTML = `<p><b>Overnight: carrying on at ${escapeText(at)}</b> — it stopped: ${escapeText(night.why)}.`
    + '<small>Keep the app open and the phone on. Tap Stop trying to leave it as it is.</small></p>'
    + '<div class="web-row"><button class="btn ghost" data-stop>Stop trying</button>'
    + '<button class="btn primary" data-now>Try now</button></div>';
  note.querySelector('[data-stop]').onclick = () => { endOvernight(); toast('Overnight stopped — what is left stays in Build'); };
  note.querySelector('[data-now]').onclick = () => {
    const go = night.run;
    clearTimeout(night.timer);
    night.timer = null;
    night.run = null;
    paintOvernight();
    Promise.resolve(go?.()).catch(() => {});
  };
  note.hidden = false;
}

/** After a build, with Overnight on: carry it on later, or the night is done. */
function overnightAfter({ book, failed, kept, paused }) {
  if (!overnight) return false;
  if (book) night.made.add(book.id);
  if (paused) { endOvernight(); return false; }
  // Blocked outright: coming back every 15 minutes would only keep it blocked.
  if (kept && web.blocked(kept.reason || failed[0]?.reason)) {
    endOvernight();
    const text = 'The site blocked this connection (Cloudflare). Overnight has stopped: wait some hours, then carry on, more slowly.';
    toast(`Overnight stopped. ${text}`, 15000);
    notifyBuild({ title: 'Overnight stopped', text });
    return true;   // said; no other notification
  }
  if (!kept) {
    // All there: the night's work is done.
    const skipped = night.skipped.splice(0);
    endOvernight();
    if (skipped.length && book) {
      toast(`Overnight: “${book.title}” is done. Passed over, gone from the site: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}.`, 15000);
    }
    return false;
  }
  // A chapter the site says is gone will never come: passed over, said in the morning.
  let left = kept;
  if (web.gone(kept.reason) && kept.links.length > 1) {
    night.skipped.push(kept.links[0].text || kept.links[0].url);
    left = { ...kept, links: kept.links.slice(1) };
    webLeftovers = webLeftovers.map((each) => (each.id === kept.id ? left : each));
    saveLeftovers();
  }
  return scheduleOvernight(() => carryOnLeftover(left), failed[0]?.reason || 'it stopped', kept.links[0]?.url || '');
}

function wireBuildOvernight() {
  const box = el('build-overnight');
  if (!box) return;
  box.onchange = () => {
    overnight = box.checked;
    store.saveSettings({ buildOvernight: overnight }).catch(() => {});
    if (!overnight) endOvernight();
    toast(overnight
      ? 'Overnight on — a website build that stops is carried on every 15 minutes until it is done. Keep the app open and the phone on.'
      : 'Overnight off');
  };
}

/* ── a notification when a build ends ─────────────────────────────────
 *
 * "Notify me when it's built or stops", in Build: a website of six hundred
 * chapters is an hour or two of downloading, not something to sit and
 * watch. Off until it is turned on; turning it on is when Android is asked
 * whether Grimoire may notify at all. Remembered.
 */
let buildNotify = false;
const canNotifyNow = () => {
  try { return !!window.GrimoireNative?.canNotify?.(); } catch { return false; }
};
store.settings().then((settings) => {
  buildNotify = settings.buildNotify === true;
  const box = el('build-notify');
  if (box) box.checked = buildNotify && canNotifyNow();
}).catch(() => {});

/** Said in a notification, if that was asked for: what became of a build. */
function notifyBuild({ title, text }) {
  if (!buildNotify) return;
  try { window.GrimoireNative?.notify?.(title, text); } catch { /* not in the app */ }
}

/** Android's answer to "may Grimoire notify?". */
function answerNotify(allowed) {
  buildNotify = !!allowed;
  const box = el('build-notify');
  if (box) box.checked = buildNotify;
  store.saveSettings({ buildNotify }).catch(() => {});
  toast(allowed
    ? 'You will get a notification when a build is done, paused or stopped'
    : 'Grimoire is not allowed to notify — turn its notifications on in Android settings, then tick this again', 7000);
}

function wireBuildNotify() {
  const box = el('build-notify');
  if (!box) return;
  box.onchange = () => {
    if (!box.checked) {
      buildNotify = false;
      store.saveSettings({ buildNotify }).catch(() => {});
      return;
    }
    if (canNotifyNow()) { answerNotify(true); return; }
    // Ticked once Android says yes, not before.
    box.checked = false;
    try { window.GrimoireNative.askToNotify(); } catch { answerNotify(false); }
  };
}

function wireBuildCover() {
  el('build-cover-pick').onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = blobs.COVER_ACCEPT;
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        // Decoded and re-encoded, as in Details: a picture the picker offered
        // but the WebView cannot draw is refused here, not built in blank.
        buildCover = await blobs.normaliseCover(file);
        buildCoverFrom = 'file';
        await paintBuildCover();
      } catch (error) {
        toast(error.message, 6000);
      }
    };
    picker.click();
  };
  el('build-cover-clear').onclick = async () => {
    buildCover = null;
    buildCoverFrom = 'first';
    await paintBuildCover();
  };
  el('build-cover-from-books').onclick = () => openBuildCoverPick();
  el('cover-pick-cancel').onclick = () => closeCoverPick();
  el('cover-pick-sheet').onclick = (e) => { if (e.target === el('cover-pick-sheet')) closeCoverPick(); };
}

function renderWorkshop() {
  const list = el('build-list');
  const parts = build.contents();
  paintLeftovers(parts);

  el('build-empty').hidden = parts.length > 0;
  el('build-naming').hidden = parts.length === 0;
  el('build-foot').hidden = parts.length === 0;
  // Only where the app can notify at all (not in a plain browser).
  const notifyRow = el('build-notify-row');
  if (notifyRow) notifyRow.hidden = parts.length === 0 || typeof window.GrimoireNative?.notify !== 'function';
  const overnightRow = el('build-overnight-row');
  if (overnightRow) overnightRow.hidden = !parts.some((part) => part.web) && !night.timer && !webQueue.length;
  paintQueue();
  // Where it will be filed, said before it is built: the folder the shelf is
  // open at is two tabs away from here.
  el('build-count').textContent = parts.length
    ? `${parts.length} part${parts.length === 1 ? '' : 's'}${activeFolder ? ` · into “${activeFolder}”` : ''}` : '';
  paintBuildFoot();

  /* The suggested name follows what has been added, until it is typed over.
   *
   * Adding three more volumes should improve the suggestion; it should not
   * throw away a name someone has already chosen. */
  const suggested = build.suggestedName(parts);
  if (!buildTitleTouched) el('build-title').value = suggested;
  el('build-eyebrow').textContent = parts.length
    ? (el('build-title').value || suggested) : 'Join files into one';
  // Follows the first part as parts are added and moved.
  paintBuildCover();

  list.innerHTML = '';
  parts.forEach((part, at) => {
    const row = document.createElement('div');
    row.className = 'build-row';
    row.innerHTML = `<span class="build-num">${at + 1}</span>`
      + `<span class="build-what"><b>${escapeText(shortenMiddle(part.name))}</b>`
      + `<small>${escapeText(build.describe(part))}</small></span>`;

    const moves = document.createElement('div');
    moves.className = 'build-move';
    for (const [by, label, path] of [
      [-1, 'Move up', 'M12 19V5M5 12l7-7 7 7'],
      [1, 'Move down', 'M12 5v14M5 12l7 7 7-7'],
    ]) {
      const button = document.createElement('button');
      button.className = 'icon-btn';
      button.title = label;
      button.innerHTML = `<svg viewBox="0 0 24 24"><path d="${path}"/></svg>`;
      button.disabled = by < 0 ? at === 0 : at === parts.length - 1;
      button.onclick = () => { build.move(part.id, by); renderWorkshop(); };
      moves.appendChild(button);
    }
    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.title = 'Remove';
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    remove.onclick = () => { build.drop(part.id); renderWorkshop(); };
    moves.appendChild(remove);

    row.appendChild(moves);
    list.appendChild(row);
  });
}

/* ── chapters a website would not give ────────────────────────────────
 *
 * A site that has had enough -- "too many requests" -- or a page that was
 * down for a minute leaves a built book short a few chapters. Those pages
 * are kept, address and all, and offered in Build to download as another
 * book once the site is willing. Kept in the settings, so closing the app in
 * the meantime loses nothing.
 */

let webLeftovers = [];
store.settings().then((settings) => {
  webLeftovers = Array.isArray(settings.webLeftovers) ? settings.webLeftovers : [];
  if (current === 'workshop') renderWorkshop();
}).catch(() => {});

const saveLeftovers = () => store.saveSettings({ webLeftovers }).catch(() => {});

/* ── where a website's download stopped ───────────────────────────────
 *
 * Paused, or stopped at a page the site would not give: remembered by the
 * address of the book's contents page, apart from Build's list and its
 * leftovers -- so clearing either loses nothing, and listing the same book
 * again offers to resume from that chapter or start from the beginning.
 * A build that downloads to the end forgets it.
 */
let webStops = [];
store.settings().then((settings) => {
  webStops = Array.isArray(settings.webStops) ? settings.webStops : [];
}).catch(() => {});
const saveStops = () => store.saveSettings({ webStops }).catch(() => {});

/** A contents page's address, as one book is known by: no fragment, no
 *  page number, no trailing slash. */
function stopKey(address) {
  try {
    const url = new URL(String(address || '').trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(page|p|pg|paged|pageno)$/i.test(key)) url.searchParams.delete(key);
    return url.href.replace(/\/+$/, '');
  } catch {
    return String(address || '').trim().replace(/\/+$/, '');
  }
}

const stopFor = (address) => webStops.find((stop) => stop.key === stopKey(address)) || null;

/**
 * After a build: each website in it either went to the end, and where it
 * once stopped is forgotten, or stopped again, and that is remembered --
 * with the book it stopped short of, to carry on.
 */
function rememberStops(sources, failed, book) {
  const keys = new Set(sources.map(stopKey).filter(Boolean));
  webStops = webStops.filter((stop) => !keys.has(stop.key));
  for (const failure of failed || []) {
    const links = failure.web?.links;
    const source = failure.web?.sources?.[0];
    if (!links?.length || !source) continue;
    webStops.push({
      key: stopKey(source), url: links[0].url, text: links[0].text || '', left: links.length,
      reason: failure.web.reason || failure.reason || '', at: Date.now(),
      bookId: book?.id ?? null, bookTitle: book?.title || '',
    });
  }
  webStops = webStops.slice(-50);
  saveStops();
}
const LEFTOVER_SUFFIX = /\s+— (the rest|from .*)$/;

/**
 * Builds the app was closed or killed in the middle of: each a book of the
 * chapters that had come (they were kept as they came), and what was left --
 * the website from the chapter after, and any not begun -- kept in Build to
 * carry it on, with where it stopped remembered for the website screen.
 */
async function rescueCutBuilds() {
  const unfinished = (await store.all('books')).filter((book) => book.importing && book.building);
  const saved = [];
  for (const book of unfinished) {
    try {
      const kept = await build.rescueCutBuild(book);
      if (kept) saved.push(kept);
    } catch (error) {
      console.warn('A cut-off build could not be kept', error);
    }
  }
  if (!saved.length) return saved;
  // Read fresh: this runs before anything else has loaded them.
  const settings = await store.settings();
  webLeftovers = Array.isArray(settings.webLeftovers) ? settings.webLeftovers : [];
  webStops = Array.isArray(settings.webStops) ? settings.webStops : [];
  for (const entry of saved) {
    const { book, rest } = entry;
    const reason = 'cut off when the app closed';
    const failed = rest.map((part) => ({ name: part.name, reason, web: { ...part, reason } }));
    // The leftovers that build was carrying on are settled by it.
    const left = keepLeftovers(failed, rest.map((part) => part.leftover).filter(Boolean), book);
    rememberStops(rest.map((part) => part.sources?.[0]).filter(Boolean), failed, book);
    entry.left = left;
  }
  return saved;
}

/** Take a build's failures in; returns the newest kept, or null. */
function keepLeftovers(failed, retried = [], book = null) {
  webLeftovers = webLeftovers.filter((left) => !retried.includes(left.id));
  let newest = null;
  for (const failure of failed || []) {
    if (!failure.web?.links?.length) continue;
    /* Named for the book and where it picks up -- "The Lantern — from
     * Chapter 38" -- not for how many times it has been tried, so two of
     * them on the shelf can be told apart and put in order. */
    const base = String(failure.web.name || 'From the web').replace(LEFTOVER_SUFFIX, '');
    const from = String(failure.web.links[0]?.text || '').trim();
    newest = {
      id: `left-${Date.now()}-${webLeftovers.length}`,
      name: from ? `${base} — from ${from.length > 48 ? `${from.slice(0, 47)}…` : from}` : `${base} — the rest`,
      links: failure.web.links,
      sources: failure.web.sources || [],
      pictures: failure.web.pictures !== false,
      author: failure.web.author || '',
      gap: failure.web.gap,
      jitter: failure.web.jitter,
      reason: failure.web.reason || failure.reason || '',
      at: Date.now(),
      // The book it stopped short of, to carry on rather than start another.
      bookId: book?.id ?? null,
      bookTitle: book?.title || '',
    };
    webLeftovers.push(newest);
  }
  saveLeftovers();
  return newest;
}

function paintLeftovers(parts) {
  const host = el('build-leftovers');
  if (!host) return;
  host.replaceChildren();
  const busy = parts.length > 0;
  for (const left of webLeftovers) {
    // Already in the list, being tried again.
    if (parts.some((part) => part.leftover === left.id)) continue;
    const count = left.links.length;
    const crowded = web.tooMany(left.reason);
    const book = escapeText(left.name.replace(LEFTOVER_SUFFIX, ''));
    const first = escapeText(left.links[0]?.text || 'a page');
    const box = document.createElement('div');
    box.className = 'build-leftover';
    const paused = left.reason === web.PAUSED_REASON;
    box.innerHTML = (paused
      ? `<p><b>“${book}” paused at ${first}</b>. `
        + `${count === 1 ? 'That chapter is' : `It and the ${count - 1} after it are`} kept: carry the book on with them, or download them as another book.`
      : `<p><b>“${book}” stopped at ${first}</b>`
        + (left.reason ? ` — ${escapeText(left.reason)}` : '') + '. '
        + `${count === 1 ? 'That chapter is' : `It and the ${count - 1} after it are`} kept, to download as another book that carries on where that one stops.`)
      + `<small>${crowded
        ? 'The site turned a request away. Trying again usually works straight away.'
        : 'If that page is not the book, look them over and untick it first.'}`
      + (busy ? ' Build or clear the list above first.' : '') + '</small></p>'
      + '<div class="web-row"><button class="btn ghost" data-forget>Forget</button>'
      + '<button class="btn ghost" data-look>Look over</button>'
      + (left.bookId != null
        ? '<button class="btn ghost" data-retry>As another book</button><button class="btn primary" data-carry>Carry on</button>'
        : '<button class="btn primary" data-retry>Download as another book</button>')
      + '</div>';
    box.querySelector('[data-look]').disabled = busy;
    // Stopped at a site's browser check: shown, passed, and carried on.
    if (web.wantsCheck(left.reason) && web.canOpenSite() && left.links[0]?.url) {
      const pass = document.createElement('button');
      pass.className = 'btn ghost';
      pass.textContent = 'Open the site';
      pass.disabled = busy;
      pass.onclick = async () => {
        try { await web.openSite(left.links[0].url); } catch (error) { toast(error.message, 6000); return; }
        if (left.bookId != null) await carryOnLeftover(left);
        else leftoverAsBook(left);
      };
      box.querySelector('.web-row').prepend(pass);
    }
    const carry = box.querySelector('[data-carry]');
    if (carry) {
      carry.disabled = busy;
      carry.onclick = () => carryOnLeftover(left);
    }
    box.querySelector('[data-look]').onclick = () => {
      showLeftoverInWeb(left);
      show('web');
    };
    box.querySelector('[data-retry]').disabled = busy;
    box.querySelector('[data-forget]').onclick = () => {
      webLeftovers = webLeftovers.filter((each) => each.id !== left.id);
      saveLeftovers();
      renderWorkshop();
    };
    box.querySelector('[data-retry]').onclick = () => leftoverAsBook(left);
    host.appendChild(box);
  }
}

/** Left over pages, downloaded as a book of their own. False if Build is busy. */
function leftoverAsBook(left) {
  if (build.contents().length || buildRun) return false;
  build.addWeb({
    name: left.name, links: left.links, pictures: left.pictures,
    author: left.author, sources: left.sources, leftover: left.id,
    gap: Number.isFinite(left.gap) ? left.gap : webDelay(),
    jitter: Number.isFinite(left.jitter) ? left.jitter : webJitter(),
  });
  el('build-title').value = left.name;
  buildTitleTouched = true;
  if (left.author) el('build-author').value = left.author;
  renderWorkshop();
  // Straight on: a book of its own is what was asked for.
  el('build-go').click();
  return true;
}

/**
 * The book left over pages stopped short of, and the rest after it: one
 * book again, as Build onto makes one. The shorter one stays on the shelf
 * until you are happy with the whole (overnight, it goes to the Bin). With
 * the book gone, the rest is downloaded as a book of its own.
 */
async function carryOnLeftover(left) {
  if (build.contents().length || buildRun) return false;
  const book = left.bookId != null ? await store.get('books', left.bookId) : null;
  if (!book || book.binnedAt) {
    toast(`“${left.bookTitle || 'That book'}” is no longer on the shelf — downloading the rest as another book`, 6000);
    return leftoverAsBook(left);
  }
  build.addBook(book);
  build.addWeb({
    name: left.name, links: left.links, pictures: left.pictures,
    author: left.author, sources: left.sources, leftover: left.id,
    gap: Number.isFinite(left.gap) ? left.gap : webDelay(),
    jitter: Number.isFinite(left.jitter) ? left.jitter : webJitter(),
  });
  for (const part of build.contents()) part.seamless = true;
  el('build-title').value = library.displayTitle(book);
  buildTitleTouched = true;
  if (book.author || left.author) el('build-author').value = book.author || left.author;
  renderWorkshop();
  el('build-go').click();
  return true;
}

/** The website screen, holding what was left over: its address, and the
 *  pages, ticked, ready to look over or add again. */
function showLeftoverInWeb(left) {
  clearWeb();
  webState.leftover = left.id;
  if (Number.isFinite(left.gap)) el('web-delay').value = String(left.gap);
  if (Number.isFinite(left.jitter)) el('web-jitter').value = String(left.jitter);
  paintWebRange();
  el('web-address').value = left.sources.join('\n');
  webState.links = left.links.map((link) => ({
    url: link.url, text: link.text, chrome: false, kind: null, likely: true, picked: true,
  }));
  webState.sources = left.sources;
  webState.title = left.name;
  webState.author = left.author;
  webNote(`Stopped last time at ${left.links[0]?.text || 'the first of these'}`
    + (left.reason ? ` — ${left.reason}` : '') + `. It and what comes after it are here, to add to Build as another book.`);
  drawWebList();
}

function wireWorkshop() {
  el('build-add').onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    /* Anything at all.
     *
     * Android builds the picker from the MIME types in this list and drops
     * extensions it cannot map to one. A wildcard like image/* then narrows
     * the whole picker to images, which is why zips could not be chosen once
     * pictures were added -- and .mht has no agreed type at all, so most file
     * managers report it as something unrecognisable either way.
     *
     * The workshop takes whatever it is given and works out what each file is
     * by looking inside it, so there is nothing for a filter to usefully do
     * except get in the way.
     */
    picker.accept = '*/*';
    picker.onchange = async () => {
      const files = [...(picker.files || [])];
      if (!files.length) return;

      const finish = progress.start('Reading the files');
      try {
        await build.add(files, (message, fraction) => finish.say(message, fraction || 0));
      } finally {
        finish();
      }
      renderWorkshop();
    };
    picker.click();
  };

  el('build-title').oninput = () => {
    buildTitleTouched = el('build-title').value.trim().length > 0;
    el('build-eyebrow').textContent = el('build-title').value || 'Join files into one';
  };

  el('build-clear').onclick = () => {
    build.clear();
    clearWeb();
    buildTitleTouched = false;
    el('build-title').value = '';
    el('build-author').value = '';
    buildCover = null;
    buildCoverFrom = 'first';
    renderWorkshop();
  };
  wireBuildCover();
  wireBuildNotify();
  wireBuildOvernight();

  // Pressed again while it runs: that is Pause & keep.
  el('build-go').onclick = () => (buildRun ? pauseBuild() : runBuild());
  el('build-queue-go').onclick = () => (queueState.running ? stopQueueAfterThis() : startQueue());
  /* The build itself: from the Build button, Overnight's next try, or the
   * queue (see nextInQueue). */
  runBuild = async () => {
    queueState.last = { paused: false, halt: false };
    // A try of its own: whatever overnight was waiting to do is this.
    clearTimeout(night.timer);
    night.timer = null;
    night.run = null;
    paintOvernight();
    // Carrying on a book this night made: the shorter one goes to the Bin after.
    const superseded = build.contents().filter((part) => part.bookId && part.seamless && night.made.has(part.bookId))
      .map((part) => part.bookId);
    const finish = progress.start('Building');
    // Leftovers being tried again in this build: settled by it either way.
    const retried = build.contents().map((part) => part.leftover).filter(Boolean);
    /* The screen kept on while a website is downloading. With it off the
     * phone soon pauses the app, and a download of a few hundred chapters
     * then stalls until someone looks at it again. */
    const online = build.contents().some((part) => part.web);
    // The websites in it, by contents page: where each stops is remembered.
    const webSources = build.contents().filter((part) => part.web).map((part) => part.web.sources?.[0]).filter(Boolean);
    if (online) { try { window.GrimoireNative?.keepScreenOn?.(true); } catch { /* not in a browser */ } }
    /* "Pause & keep": stop downloading after the chapters under way and make
     * the book of what has come. The rest is kept in Build, to carry the
     * book on with later. */
    // What each website's delay says a chapter should take, for an estimate from the start.
    const delays = build.contents().map((part) => (part.web
      ? { gap: Math.max(0, Number(part.web.gap) || 0), jitter: Math.max(0, Number(part.web.jitter) || 0), chapters: part.web.links?.length || 0 }
      : null));
    buildRun = { online, pausing: false, status: 'Starting…', finish, startedAt: Date.now(), at: -1, delays, samples: [] };
    buildRun.ticker = setInterval(paintTimes, 1000);
    paintBuildFoot();
    try { window.GrimoireNative?.buildRunning?.(true); } catch { /* not in the app */ }
    try {
      const { book, failed } = await build.build({
        shouldPause: () => !!buildRun?.pausing,
        title: el('build-title').value.trim() || undefined,
        author: el('build-author').value.trim() || undefined,
        // Into the folder the shelf is open at, as an import would be.
        folder: activeFolder || null,
        cover: buildCover,
        onProgress: (message, fraction, at, total, now, counts) => {
          /* The bar goes by chapters downloaded, where there are websites in
           * the build -- they are where the hours go -- not by parts: a book
           * from the shelf and a website of 450 chapters are not halves. */
          const web = buildRun?.delays || [];
          const chapters = web.reduce((sum, part) => sum + (part?.chapters || 0), 0);
          let bar = fraction;
          if (chapters && Number.isInteger(at)) {
            const before = web.slice(0, at).reduce((sum, part) => sum + (part?.chapters || 0), 0);
            bar = Math.min(1, (before + (web[at] ? counts?.done ?? 0 : 0)) / chapters);
          }
          finish.say(message, bar);
          // What it is doing this moment, on its own line under the bar.
          if (now !== undefined) finish.activity(now);
          // The pages of this part so far, for how long it has been and is to be.
          if (buildRun) {
            const nowMs = Date.now();
            if (buildRun.at !== at) {
              Object.assign(buildRun, { at, partStart: nowMs, partFrom: counts?.done || 0, lastCame: nowMs, samples: [], shown: null, done: undefined, total: undefined });
            }
            buildRun.parts = total;
            if (counts) {
              // What each chapter took, from the one before it: what the estimate goes by.
              const came = counts.done - (buildRun.done ?? counts.done);
              if (came > 0) {
                const each = (nowMs - buildRun.lastCame) / came;
                for (let i = 0; i < came; i += 1) buildRun.samples.push(each);
                buildRun.samples.splice(0, Math.max(0, buildRun.samples.length - RECENT_CHAPTERS));
                buildRun.lastCame = nowMs;
              }
              Object.assign(buildRun, { done: counts.done, total: counts.total });
              if (counts.stats) buildRun.stats = counts.stats;
            }
            // A wait the site asked for, or a pause before one more try: its end, while it lasts.
            if (now !== undefined) buildRun.waitingUntil = now?.kind === 'wait' && now.why ? now.until : 0;
            paintTimes();
          }
          // Beside the button, briefly: "120 of 669 · ~5 h left", or how far in.
          if (buildRun && !buildRun.pausing && !counts) {
            buildRun.status = /(\d+ of \d+)/.exec(message || '')?.[1]
              || (Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : 'Building…');
            paintBuildFoot();
          }
        },
      });
      /* Into the book itself, as a cover chosen in Details is: its cover page
       * shows it, and anything written out of it carries it. */
      if (buildCover) {
        try {
          await covers.placeCover(book.id, buildCover);
        } catch (error) {
          toast(`The cover is set, but could not be put into the book: ${error.message}`, 6000);
        }
      }
      build.clear();
      buildTitleTouched = false;
      el('build-title').value = '';
      el('build-author').value = '';
      buildCover = null;
      buildCoverFrom = 'first';
      /* Pages a website would not give are kept, not dropped with the
       * list: a site that said "too many requests" will usually give them an
       * hour later, as a book of their own. The website screen holds them too,
       * address and all; otherwise it starts empty for the next one. */
      const kept = keepLeftovers(failed, retried, book);
      rememberStops(webSources, failed, book);
      if (kept) showLeftoverInWeb(kept);
      else clearWeb();
      renderWorkshop();
      await refreshShelf();
      // Said with the parts that failed, not instead of them: a book short
      // three volumes should not look like a complete one.
      const filed = book.folder ? ` · in “${book.folder}”` : '';
      const later = kept ? ' — the rest is kept in Build to download as another book' : '';
      const paused = failed.length > 0 && failed.every((each) => each.paused);
      const left = failed.reduce((sum, each) => sum + (each.web?.links?.length || 0), 0);
      // For the queue: paused by hand, or stopped by the site itself -- blocked,
      // a check to pass, "too many requests" -- is no time to go on to the next.
      queueState.last = { paused, halt: failed.some((each) => queueHalts(each.reason)) };
      whenNotReading(() => toast(paused
        ? `Paused — built “${book.title}” with ${book.chapters} chapters${filed}. The other ${left} are kept in Build: “Carry on” adds them to the end.`
        : failed.length
        ? `Built “${book.title}” — ${book.chapters} chapters${filed} · skipped ${failed[0].name}${failed.length > 1 ? ` and ${failed.length - 1} more` : ''}: ${failed[0].reason}${later}`
        : `Built “${book.title}” — ${book.chapters} chapters${filed}`, 8000, { kind: 'done' }));
      /* Straight into the book that was just made, not out to the shelf to
       * go looking for it. */
      /* Only if Build is still what is on screen. Gone off to read, or to
       * the shelf, while it worked, you are not taken out of that. */
      if (overnight && superseded.length) {
        await library.binBooks(superseded).catch(() => {});
        await refreshShelf();
      }
      const again = overnightAfter({ book, failed, kept, paused });
      // A notification's title is a few words -- the popup shows one line of
      // it -- and the book and the numbers lead what is under it.
      if (!again) notifyBuild(paused
        ? { title: 'Build paused', text: `“${book.title}”: ${book.chapters} chapters kept, ${left} left in Build to carry it on.` }
        : failed.length
        ? { title: 'Build stopped short', text: `“${book.title}”: ${book.chapters} chapters. Stopped: ${failed[0].reason}` }
        : { title: 'Build done', text: `“${book.title}”: ${book.chapters} chapters${filed}, on the shelf.` });
      const made = await store.get('books', book.id);
      if (queueState.running && !again) queueState.built += 1;
      // Overnight, Build stays up between tries, saying when the next is; and
      // the queue goes on to its next website rather than into this book.
      if (made && current === 'workshop' && !again && !queueState.running) await openBook(made);
    } catch (error) {
      finish.fail();
      queueState.last = { paused: !!error.paused, halt: queueHalts(error) };
      whenNotReading(() => toast(error.message || 'That could not be built', 6000, { kind: error.paused ? 'done' : 'failed' }));
      // Overnight, nothing built is tried again as it stands, from Build's list.
      const again = overnight && online && !error.paused && !web.blocked(error) && build.contents().length > 0
        && scheduleOvernight(() => { if (!buildRun) el('build-go').click(); }, error.message || 'nothing came', `nothing:${webSources[0] || ''}`);
      if (!again) notifyBuild({ title: error.paused ? 'Build paused' : 'Build stopped', text: error.message || 'That could not be built' });
    } finally {
      finish();
      clearInterval(buildRun?.ticker);
      buildRun = null;
      try { window.GrimoireNative?.buildRunning?.(false); } catch { /* not in the app */ }
      renderWorkshop();
      // Let go again, unless a book is open to read or overnight is waiting.
      if (online && current !== 'reader' && !night.timer && !queueState.running) {
        try { window.GrimoireNative?.keepScreenOn?.(false); } catch { /* not in a browser */ }
      }
      queueAfter(queueState.last);
    }
  };
}

function wireReader() {
  reader.init({ onChange: paintReader });

  // Shared by the tap and swipe handlers below.
  const host = el('page-host');
  /* Taps, in both modes.
   *
   * The invisible zone overlay used to take these, which meant it also took
   * long presses -- so a press on a word landed on the overlay and Android's
   * Copy, Translate and Web search never came up. The layer is inert now and
   * the touch is read here instead: a tap is a finger that neither moved nor
   * lingered, and anything else is left alone for the system to make a
   * selection out of.
   */
  let tapX = 0, tapY = 0, tapAt = 0, moved = false;

  /* A touch on one of the controls floating over the page is that control's.
   *
   * They sit inside the page, so every tap on them also arrived here as a tap
   * on the page -- and the page buttons live on the right edge, which is the
   * forward tap zone. Next turned two pages, Previous turned one back and one
   * forward and so did nothing, and in scroll mode each press showed or hid
   * the bars instead of moving the text. */
  // Not the scrub rail: it only takes a drag, and a drag is never a tap. A
  // tap on it is a tap on the page's right edge, which is what it looks like.
  const onControl = (e) => !!e.target?.closest?.('#chapter-pad, #edge-hint');

  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || onControl(e)) { moved = true; return; }
    moveGuides(e.touches[0].clientY);
    tapX = e.touches[0].clientX;
    tapY = e.touches[0].clientY;
    tapAt = Date.now();
    moved = false;
  }, { passive: true });

  host.addEventListener('touchmove', (e) => {
    if (Math.abs(e.touches[0].clientX - tapX) > 8
      || Math.abs(e.touches[0].clientY - tapY) > 8) moved = true;
  }, { passive: true });

  host.addEventListener('touchend', async (e) => {
    // A press long enough to be a selection is not a page turn. 400ms is
    // comfortably under Android's own long-press threshold, so the two never
    // both fire.
    if (moved || Date.now() - tapAt > 400) return;
    // Nor is a tap that dismisses a selection the reader already has.
    if (!window.getSelection?.().isCollapsed) return;

    const settings = await store.settings();
    const box = host.getBoundingClientRect();
    if (box.width <= 0) return;

    const zone = sideZone(settings.tapZone);
    const fraction = (e.changedTouches[0].clientX - box.left) / box.width;
    const middle = fraction > zone && fraction < 1 - zone;

    /* In scroll mode every tap toggles the chrome.
     *
     * A side tap used to jump a screenful, which fights the thing scroll mode
     * is for: the text is already moving under your thumb, and a stray tap
     * snapping it a screen on -- then the scroll settling and recomputing the
     * position from where it landed -- is two mechanisms driving the same
     * axis. Paged mode has no such conflict, because a tap is the only way
     * the text moves there.
     */
    if (middle || reader.state.mode === 'scroll') {
      reader.cycleChrome();
      paintReader();
      return;
    }

    // Paged mode moves by a page, and never into another chapter.
    if (!settings.turnBySideTap) return;
    const direction = fraction <= zone ? -1 : 1;
    if (!reader.turn(direction)) await atChapterEdge(direction);
  }, { passive: true });

  // Swipe, independently toggleable from side taps in settings.
  let startX = 0, startY = 0, startAt = 0, startOnControl = false;
  host.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; startAt = Date.now();
    startOnControl = onControl(e);
  }, { passive: true });
  host.addEventListener('touchend', async (e) => {
    // Not a swipe of the page: a drag of the pad's grip or along the rail.
    if (startOnControl) return;
    // Scroll mode already has a gesture for moving through the text, and
    // hijacking horizontal swipes on top of it fights the scroller.
    if (reader.state.mode === 'scroll') return;
    // Dragging out a selection is a long horizontal movement over the text,
    // which is exactly the shape of a swipe. Turning the page out from under
    // it would make selecting anything impossible.
    if (!window.getSelection?.().isCollapsed) return;
    const settings = await store.settings();
    if (!settings.turnBySwipe) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Date.now() - startAt > 600) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (!reader.turn(dx < 0 ? 1 : -1)) await atChapterEdge(dx < 0 ? 1 : -1);
  }, { passive: true });

  el('chapter-prev').onclick = async () => {
    // Doing nothing at the first chapter is correct and indistinguishable
    // from being broken, which is how it was reported.
    if (!await reader.prevChapter()) toast('Already at the first chapter');
    paintReader();
  };
  el('chapter-next').onclick = async () => {
    if (!await reader.nextChapter()) toast('Already at the last chapter');
    paintReader();
  };

  wireCopy();
  wireOcr();

  el('translate-chapter').onclick = async () => {
    const button = el('translate-chapter');
    button.disabled = true;
    try {
      const result = await reader.toggleTranslation();
      toast(result.shown
        ? `Translated${result.characters ? ` · ${result.characters.toLocaleString()} characters` : ''}`
        : 'Showing the original');
      button.setAttribute('aria-pressed', String(result.shown));
      paintReader();
    } catch (error) {
      toast(error.message, 5000);
    } finally {
      button.disabled = false;
    }
  };

  el('bookmark-btn').onclick = async () => {
    const state = reader.state;
    if (!state.book) return;
    const marks = await store.byIndex('marks', 'bookId', state.book.id);
    const existing = marks.find((m) => m.kind === 'bookmark'
      && m.chapterIndex === state.chapterIndex
      && Math.abs(m.anchor - state.anchor) < 400);
    if (existing) {
      await store.deleteMark(existing.id);
      toast('Bookmark removed');
    } else {
      const chapter = state.chapters.find((c) => c.index === state.chapterIndex);
      await store.addMark({
        bookId: state.book.id,
        kind: 'bookmark',
        chapterIndex: state.chapterIndex,
        anchor: state.anchor,
        page: state.page,
        excerpt: `${chapter?.title || 'Chapter'} · p. ${state.page + 1}`,
      });
      toast('Bookmarked');
    }
    refreshBookmarkState();
  };

  // Scrub rail: drag to move through the chapter, bubble tracks the thumb.
  const rail = el('scrub-rail');
  const bubble = el('scrub-bubble');
  const scrub = (clientY) => {
    const box = rail.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientY - box.top) / box.height));
    bubble.hidden = false;
    bubble.style.top = `${fraction * 100}%`;
    // A page number is meaningless in scroll mode, so say percent instead.
    bubble.textContent = reader.state.mode === 'scroll'
      ? `${Math.round(fraction * 100)}%`
      : `p. ${Math.round(fraction * (reader.state.pageCount - 1)) + 1}`;
    rail.classList.add('dragging');
    reader.setScrubbing(true);
    reader.scrubTo(fraction);
  };
  /* Only a drag along it moves the book.
   *
   * The rail sits on the right edge, over the end of every line, and it used
   * to jump the moment a finger touched it: a long press on a word near the
   * margin -- the way a passage is highlighted -- landed on the rail and threw
   * the reader several pages on, and a tap on the far edge jumped instead of
   * turning one page. Now a touch that stays where it landed is left alone,
   * to be the tap or the long press it was, and the rail takes over only once
   * the finger slides along it. */
  const DRAG = 10;
  let railFrom = null;
  let railOn = false;
  rail.addEventListener('touchstart', (e) => {
    railFrom = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    railOn = false;
  }, { passive: true });
  rail.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    if (!railOn) {
      if (!railFrom) return;
      const dy = Math.abs(touch.clientY - railFrom.y);
      const dx = Math.abs(touch.clientX - railFrom.x);
      if (dy < DRAG || dy < dx) return;     // not a drag along the rail, yet
      railOn = true;
    }
    scrub(touch.clientY);
    e.preventDefault();
  });
  const railDone = () => {
    railFrom = null;
    if (!railOn) return;
    railOn = false;
    bubble.hidden = true;
    rail.classList.remove('dragging');
    reader.setScrubbing(false);
  };
  rail.addEventListener('touchend', railDone);
  rail.addEventListener('touchcancel', railDone);

  wireProgressBar();
}

/* ── the progress bar ─────────────────────────────────────────────────────
 *
 * It shows how far through the book you are, so dragging it goes anywhere in
 * the book. It used to move only within the chapter open -- the bar said 40%
 * of the book, a drag to the middle said 50% of this chapter, and the line
 * jumped back to somewhere else on release -- and it was a 4px line, which a
 * thumb rarely found at all.
 *
 * While the finger is down nothing moves but the bar: a bubble says which
 * chapter and page it is over, and the book goes there when the finger
 * lifts. Loading chapter after chapter under a moving finger would be slow
 * for nothing.
 */
let barDragging = false;

function wireProgressBar() {
  const hit = el('progress-hit');
  const track = el('progress-track');
  const bubble = el('progress-bubble');
  let at = null;

  const fractionAt = (clientX) => {
    const box = track.getBoundingClientRect();
    return box.width ? Math.max(0, Math.min(1, (clientX - box.left) / box.width)) : 0;
  };
  const preview = (fraction) => {
    barDragging = true;
    hit.classList.add('dragging');
    el('progress-fill').style.width = `${fraction * 100}%`;
    el('progress-knob').style.left = `${fraction * 100}%`;
    const place = reader.bookPlace(fraction);
    bubble.textContent = place
      ? `${place.name} · p. ${place.page} of ${place.total}`
      : `${Math.round(fraction * 100)}%`;
    el('progress-pct').textContent = `${Math.round(fraction * 100)}%`;
    bubble.hidden = false;
    // Kept on screen at either end of the bar.
    const box = track.getBoundingClientRect();
    const half = bubble.offsetWidth / 2;
    const x = Math.max(half + 8, Math.min(window.innerWidth - half - 8, box.left + fraction * box.width));
    bubble.style.left = `${x - box.left}px`;
  };
  const finish = async (go) => {
    hit.classList.remove('dragging');
    bubble.hidden = true;
    const fraction = at;
    at = null;
    try {
      if (go && fraction !== null) await reader.goToBookFraction(fraction);
    } finally {
      barDragging = false;
      paintReader();
    }
  };

  hit.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    // The bar's, not the page's: no scrolling, no tap on what is behind it.
    e.preventDefault();
    at = fractionAt(e.touches[0].clientX);
    preview(at);
  }, { passive: false });
  hit.addEventListener('touchmove', (e) => {
    if (at === null) return;
    e.preventDefault();
    at = fractionAt(e.touches[0].clientX);
    preview(at);
  }, { passive: false });
  hit.addEventListener('touchend', () => { if (at !== null) finish(true); });
  // Interrupted -- a call, the system taking the gesture -- is not a choice.
  hit.addEventListener('touchcancel', () => { if (at !== null) finish(false); });
  // A mouse, or a tap the browser delivered as a click.
  hit.addEventListener('click', (e) => {
    if (barDragging) return;
    at = fractionAt(e.clientX);
    preview(at);
    finish(true);
  });
}

/* ── the copy button ──────────────────────────────────────────────────────
 *
 * Split in two: the wide part copies, the narrow part beside it says how much
 * -- the page on screen, half the chapter, or all of it. Remembered, so it is
 * chosen once rather than on every press.
 */
const COPY_LABELS = { page: 'Copy page', half: 'Copy half', chapter: 'Copy chapter' };
let copyAmount = 'chapter';

function paintCopyAmount() {
  el('copy-chapter').textContent = COPY_LABELS[copyAmount];
  for (const option of el('copy-menu').querySelectorAll('[data-amount]')) {
    option.setAttribute('aria-checked', String(option.dataset.amount === copyAmount));
  }
}

/* The circles on the copy-amount icon move as you read.
 *
 * Every time your place changes -- a page turned, a chapter changed, a jump
 * along the progress bar -- each slides to somewhere new along its line. Kept
 * clear of the ends, and always a visible distance from where it was, so the
 * change is a change and not a twitch. */
let copyIconAt = '';

function moveCopyIconKnobs() {
  for (const knob of el('copy-amount').querySelectorAll('.knob')) {
    const was = Number(knob.dataset.x) || 12;
    let x = was;
    for (let tries = 0; tries < 8 && Math.abs(x - was) < 3; tries++) x = 6 + Math.random() * 12;
    knob.dataset.x = x.toFixed(1);
    knob.style.transform = `translateX(${x.toFixed(1)}px)`;
  }
}

function closeCopyMenu() {
  if (el('copy-menu').hidden) return false;
  el('copy-menu').hidden = true;
  el('copy-amount').setAttribute('aria-expanded', 'false');
  return true;
}

function wireCopy() {
  store.settings().then((settings) => {
    copyAmount = COPY_LABELS[settings.copyAmount] ? settings.copyAmount : 'chapter';
    paintCopyAmount();
  });

  el('copy-chapter').onclick = async () => {
    closeCopyMenu();
    // The toast is the one piece of chrome allowed in NONE, and it confirms
    // with a word count so the copy is verifiable at a glance.
    const count = (result) => `${result.words.toLocaleString()} word${result.words === 1 ? '' : 's'}`;
    if (copyAmount === 'page') {
      const result = await reader.copyPage();
      toast(result.ok ? `Page copied · ${count(result)}`
        : result.empty ? 'Nothing to copy on this page' : 'Could not copy');
    } else if (copyAmount === 'half') {
      const result = await reader.copyHalf();
      toast(result.ok ? `${result.half ? 'Second' : 'First'} half of the chapter copied · ${count(result)}`
        : result.empty ? 'Nothing to copy in this chapter' : 'Could not copy');
    } else {
      const result = await reader.copyChapter();
      toast(result.ok ? `Chapter copied · ${count(result)}`
        : result.empty ? 'Nothing to copy in this chapter' : 'Could not copy');
    }
  };

  el('copy-amount').onclick = (e) => {
    e.stopPropagation();
    if (closeCopyMenu()) return;
    paintCopyAmount();
    el('copy-menu').hidden = false;
    el('copy-amount').setAttribute('aria-expanded', 'true');
  };
  for (const option of el('copy-menu').querySelectorAll('[data-amount]')) {
    option.onclick = async (e) => {
      e.stopPropagation();
      copyAmount = option.dataset.amount;
      paintCopyAmount();
      closeCopyMenu();
      await store.saveSettings({ copyAmount });
    };
  }
  // A tap anywhere else puts the menu away.
  document.addEventListener('pointerdown', (e) => {
    if (el('copy-menu').hidden) return;
    if (e.target.closest?.('#copy-menu, #copy-amount')) return;
    closeCopyMenu();
  }, true);
}

/* ── text out of pictures ─────────────────────────────────────────────────
 *
 * The button beside Copy reads the pictures on screen (ocr.js, and ML Kit
 * underneath). Every picture on screen at once, in the order they stand; or
 * one, picked; or one bubble of it, boxed with a drag. What is read lands in
 * an editable box, to be put right where it misread and copied. Lettering the
 * phone cannot read -- drawn, stretched, run down the page -- goes to Google
 * Lens from the same sheet.
 */

const ocrState = {
  token: 0,
  book: null,
  hrefs: [],
  at: -1,             // which picture: -1 for every one on screen
  box: null,          // { x, y, w, h } as fractions of the picture shown
  choice: '',         // a script asked for, or '' for the likeliest
  direction: '',      // 'rtl' or 'ltr' as set for the book, or '' to go by the page
  reads: [],          // this run's readings, kept so a new direction needs no new reading
  cache: new Map(),
  urls: null,
  translate: false,   // translated once asked, until the sheet is closed
  asRead: false,      // the text exactly as the recogniser read it, uncorrected
  report: '',         // the last accuracy check, as text to copy
  lastCheck: null,    // ...and as shown: { summary, totals }
};

/* The icon's page is a comic page, and its panels are drawn anew as you read. */
function drawOcrPanels() {
  const group = el('ocr-btn')?.querySelector('.ocr-panels');
  if (!group) return;
  const x0 = 8.2;
  const y0 = 6.2;
  const width = 7.6;
  const height = 11.6;
  const gap = 0.9;
  const rows = 2 + Math.floor(Math.random() * 2);
  const weights = Array.from({ length: rows }, () => 0.6 + Math.random());
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const free = height - gap * (rows - 1);
  const rects = [];
  let y = y0;
  for (const weight of weights) {
    const tall = (free * weight) / total;
    if (Math.random() < 0.55) {
      const cut = (width - gap) * (0.3 + Math.random() * 0.4);
      rects.push([x0, y, cut, tall], [x0 + cut + gap, y, width - gap - cut, tall]);
    } else {
      rects.push([x0, y, width, tall]);
    }
    y += tall + gap;
  }
  group.innerHTML = rects.map(([x, top, w, h]) =>
    `<rect x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx=".5"/>`).join('');
}

function ocrStatus(message, problem = false) {
  const status = el('ocr-status');
  status.textContent = message;
  status.classList.toggle('problem', problem);
}

function closeOcr() {
  if (el('ocr-sheet').hidden) return false;
  ocrState.token++;
  el('ocr-sheet').hidden = true;
  el('ocr-btn').removeAttribute('aria-busy');
  el('ocr-img').removeAttribute('src');
  ocrState.urls?.release();
  ocrState.urls = null;
  return true;
}

async function openOcr() {
  const state = reader.state;
  const book = state.book;
  if (!book) return;
  const hrefs = reader.picturesInView({ inOrder: true }).filter((href) => state.images.get(href));
  if (!hrefs.length) return toast('No picture on this page', 3000);
  if (!ocr.available()) return toast('Reading text from pictures needs the app', 4000);
  if (ocrState.book !== book.id) { ocrState.choice = ''; ocrState.cache.clear(); }
  ocrState.book = book.id;
  const saved = await store.settings();
  ocrState.direction = saved.ocrDirections?.[book.id] || '';
  // Asked for each time: a translation is a call against the quota, made
  // only when the button is pressed (or the overlays are on).
  ocrState.translate = false;
  el('ocr-overlay').setAttribute('aria-pressed', String(overlay.on && overlay.book === book.id));
  el('ocr-translation').hidden = true;
  el('ocr-translation').value = '';
  ocrState.reads = [];
  ocrState.hrefs = hrefs;
  ocrState.at = hrefs.length === 1 ? 0 : -1;
  ocrState.box = null;
  ocrState.urls?.release();
  ocrState.urls = blobs.pool();
  el('ocr-text').value = '';
  el('ocr-lens').hidden = !ocr.lensAvailable();
  el('ocr-asread').setAttribute('aria-pressed', String(ocrState.asRead));
  showAccuracy(false);
  paintOcrPictures();
  paintOcrScripts();
  el('ocr-sheet').hidden = false;
  runOcr();
}

function paintOcrPictures() {
  const list = el('ocr-pictures');
  const { hrefs } = ocrState;
  list.hidden = hrefs.length < 2;
  list.innerHTML = '';
  if (hrefs.length > 1) {
    const chip = (label, at) => {
      const button = document.createElement('button');
      button.className = 'chip';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(ocrState.at === at));
      button.onclick = () => {
        if (ocrState.at === at) return;
        ocrState.at = at;
        ocrState.box = null;
        paintOcrPictures();
        runOcr();
      };
      list.appendChild(button);
    };
    chip(`All ${hrefs.length}`, -1);
    hrefs.forEach((href, i) => chip(`Picture ${i + 1}`, i));
  }
  // One picture to box a bubble on; for all of them at once, none.
  const stage = el('ocr-stage');
  stage.hidden = ocrState.at < 0;
  el('ocr-box').hidden = true;
  el('ocr-marks').innerHTML = '';
  // The check scores one whole picture against its key.
  el('ocr-check').hidden = ocrState.at < 0;
  if (ocrState.at < 0) showAccuracy(false);
  if (ocrState.at >= 0) {
    el('ocr-img').src = ocrState.urls.url(reader.state.images.get(hrefs[ocrState.at])) || '';
  } else {
    el('ocr-img').removeAttribute('src');
  }
}

function paintOcrScripts(found = '') {
  const list = el('ocr-scripts');
  list.innerHTML = '';
  const chip = (label, script) => {
    const button = document.createElement('button');
    button.className = 'chip';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(ocrState.choice === script));
    button.onclick = () => {
      if (ocrState.choice === script) return;
      ocrState.choice = script;
      paintOcrScripts();
      runOcr();
    };
    list.appendChild(button);
  };
  const named = ocr.SCRIPTS.find(([script]) => script === found);
  chip(!ocrState.choice && named ? `Auto · ${named[1]}` : 'Auto', '');
  for (const [script, label] of ocr.SCRIPTS) chip(label, script);
  // Which way the panels run. Tapping turns it round and keeps it for the
  // book; the text is put in the new order at once, without reading again.
  const way = ocrDirection();
  const turn = document.createElement('button');
  turn.className = 'chip ocr-direction';
  turn.id = 'ocr-direction';
  turn.textContent = way === 'rtl' ? '← Right to left' : 'Left to right →';
  turn.title = 'Which way the panels and bubbles are read';
  turn.onclick = async () => {
    ocrState.direction = ocrDirection() === 'rtl' ? 'ltr' : 'rtl';
    paintOcrText();
    const book = ocrState.book;
    const saved = (await store.settings()).ocrDirections || {};
    await store.saveSettings({ ocrDirections: { ...saved, [book]: ocrState.direction } });
  };
  list.appendChild(turn);
}

/** The way the panels run: as set for the book, else as the page suggests. */
function ocrDirection() {
  if (ocrState.direction) return ocrState.direction;
  const lang = reader.state.book?.lang || '';
  const ways = ocrState.reads.map((read) => ocr.directionOf(read.blocks, read.script, lang));
  if (ways.length) return ways.filter((way) => way === 'rtl').length > ways.length / 2 ? 'rtl' : 'ltr';
  return ocr.directionOf([], '', lang);
}

/** The readings, as text, in the order the panels run. */
function paintOcrText() {
  const direction = ocrDirection();
  const found = new Map();
  const texts = [];
  const corrected = !ocrState.asRead;
  for (const read of ocrState.reads) {
    const text = ocr.readingText(read.blocks, read.script, { direction, corrected }) || read.raw || read.text || '';
    if (!text) continue;
    texts.push(text);
    found.set(read.script, (found.get(read.script) || 0) + text.length);
  }
  const text = texts.join('\n\n');
  el('ocr-text').value = text;
  paintOcrMarks();
  el('ocr-copy').disabled = !text;
  paintOcrScripts([...found.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '');
  if (ocrState.translate) showOcrTranslation();
  return text;
}

/** Where the recogniser was unsure, outlined on the picture shown. */
function paintOcrMarks() {
  const marks = el('ocr-marks');
  marks.innerHTML = '';
  const read = ocrState.reads[0];
  if (ocrState.at < 0 || ocrState.box || !read?.width || !read?.height) return;
  for (const block of ocr.orderedBlocks(read.blocks, read.script)) {
    if (!block.unsure) continue;
    const mark = document.createElement('div');
    mark.className = 'ocr-unsure';
    mark.style.left = `${(block.x / read.width) * 100}%`;
    mark.style.top = `${(block.y / read.height) * 100}%`;
    mark.style.width = `${(block.w / read.width) * 100}%`;
    mark.style.height = `${(block.h / read.height) * 100}%`;
    marks.appendChild(mark);
  }
}

/** What to be wary of in the readings, in a few words for the status line. */
function ocrWarnings(reads) {
  const counts = { unsure: 0, corrected: 0, duplicates: 0 };
  const failed = new Set();
  for (const read of reads) {
    for (const warning of ocr.checkReading(read)) {
      if (warning.kind === 'failed') failed.add(warning.script);
      else if (warning.kind in counts) counts[warning.kind] += warning.count || 0;
    }
  }
  const out = [];
  if (counts.unsure) out.push(`${counts.unsure} unsure`);
  if (counts.corrected) out.push(`${counts.corrected} corrected`);
  if (counts.duplicates) out.push(`${counts.duplicates} repeat${counts.duplicates === 1 ? '' : 's'} dropped`);
  if (failed.size) {
    const names = [...failed].map((script) => ocr.SCRIPTS.find(([s]) => s === script)?.[1] || script);
    out.push(`${names.join(', ')} could not be read`);
  }
  return out;
}

/** The readings translated, bubble by bubble, under the text. */
async function showOcrTranslation() {
  const box = el('ocr-translation');
  const token = ocrState.token;
  const book = reader.state.book;
  if (!book || !ocrState.reads.length) { box.hidden = true; return; }
  if (!translate.status().configured) {
    box.hidden = false;
    box.classList.add('problem');
    box.value = 'Choose a translator in Settings → Translation first.';
    return;
  }
  box.hidden = false;
  box.classList.remove('problem');
  box.value = 'Translating…';
  try {
    const direction = ocrDirection();
    const parts = [];
    for (const read of ocrState.reads) {
      const blocks = await translateRead(book.id, read, direction);
      parts.push(blocks.map((block) => block.translation).filter(Boolean).join('\n\n'));
    }
    if (token !== ocrState.token) return;
    box.value = parts.filter(Boolean).join('\n\n') || 'Nothing to translate.';
  } catch (error) {
    if (token !== ocrState.token) return;
    box.classList.add('problem');
    box.value = error.message || 'The translation failed.';
  }
}

/** The picture (or the boxed part of it) to read. */
async function ocrBlobOf(href, box) {
  const blob = reader.state.images.get(href);
  if (!blob || !box) return blob;
  return ocr.cropOf(blob, box);
}

async function runOcr() {
  const token = ++ocrState.token;
  const book = reader.state.book;
  if (!book) return;
  const scripts = ocrState.choice ? [ocrState.choice] : ocr.scriptsFor(book.lang);
  const targets = ocrState.at < 0 ? ocrState.hrefs : [ocrState.hrefs[ocrState.at]];
  const box = ocrState.at < 0 ? null : ocrState.box;
  const boxKey = box ? [box.x, box.y, box.w, box.h].map((n) => n.toFixed(3)).join(',') : 'all';
  el('ocr-copy').disabled = true;
  el('ocr-btn').setAttribute('aria-busy', 'true');
  const reads = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      const href = targets[i];
      const key = `${book.id}|${href}|${boxKey}|${scripts.join(',')}`;
      let read = box ? ocrState.cache.get(key) : pictureReads.get(readKey(book.id, href, scripts));
      if (!read) {
        ocrStatus(targets.length > 1 ? `Reading picture ${i + 1} of ${targets.length}…`
          : box ? 'Reading the boxed part…' : 'Reading the picture…');
        if (box) {
          const blob = await ocrBlobOf(href, box);
          if (token !== ocrState.token) return;
          if (!blob) continue;
          read = await ocr.readPicture(blob, scripts);
          if (token !== ocrState.token) return;
          ocrState.cache.set(key, read);
        } else {
          // Whole pictures are shared with the overlays, and kept.
          read = await readWhole(book.id, href, scripts);
          if (token !== ocrState.token) return;
          if (!read) continue;
        }
      }
      // Which picture it is, for showing it to a model that can see.
      reads.push({ ...read, href });
    }
  } catch (error) {
    if (token !== ocrState.token) return;
    el('ocr-btn').removeAttribute('aria-busy');
    ocrStatus(error.message || 'The text could not be read', true);
    return;
  }
  if (token !== ocrState.token) return;
  el('ocr-btn').removeAttribute('aria-busy');
  ocrState.reads = reads;
  const text = paintOcrText();
  // The next pages, read while this one is: tapping on is then instant.
  warmAhead();
  if (!text) {
    ocrStatus(ocr.lensAvailable()
      ? 'No text found. Box one bubble, try another script, or try Google Lens.'
      : 'No text found. Box one bubble, or try another script.');
  } else {
    const characters = text.replace(/\s/g, '').length;
    const wary = ocrWarnings(reads);
    ocrStatus(`${characters.toLocaleString()} character${characters === 1 ? '' : 's'}`
      + (box ? ' · from the box' : targets.length > 1 ? ` · ${targets.length} pictures` : '')
      + (wary.length ? ` · ${wary.join(' · ')}` : ''));
  }
}

/* ── the accuracy check ────────────────────────────────────────────────
 *
 * A picture's text as it really is -- the answer key, typed or put right
 * by the reader -- and the picture read against it in four ways: by the
 * recogniser alone; as the app read before the latest steps were added;
 * and now, both as read and corrected. Each is scored in characters and
 * words wrong, bubbles left out, read twice or out of order, and time.
 * Nothing is claimed without a key: the numbers are only as good as it.
 */

const keyOf = (bookId, href) => `${bookId}:ocrkey:${href}`;

async function savedKey(bookId, href) {
  try {
    return (await store.get('translations', keyOf(bookId, href)))?.value || '';
  } catch {
    return '';
  }
}

async function saveKey(bookId, href, text) {
  const value = String(text || '').trim();
  if (!value) return store.del('translations', keyOf(bookId, href)).catch(() => {});
  return store.put('translations', {
    key: keyOf(bookId, href), bookId, field: `ocrkey:${href}`, lang: 'key', value, at: Date.now(),
  });
}

/** The ways a picture is read for the check, each with how its text is
 *  made: the steps the recogniser takes, and whether corrections apply. */
const CHECKS = [
  { label: 'Recogniser alone', steps: ocr.NO_STEPS, corrected: false },
  { label: 'Before this update', steps: ocr.EARLIER_STEPS, corrected: true },
  { label: 'Now, as read', steps: ocr.ALL_STEPS, corrected: false, same: 'now' },
  { label: 'Now, corrected', steps: ocr.ALL_STEPS, corrected: true, same: 'now' },
];

async function showAccuracy(open) {
  const panel = el('ocr-accuracy');
  panel.hidden = !open;
  el('ocr-check').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const book = reader.state.book;
  const href = ocrState.hrefs[ocrState.at];
  if (!book || !href) return;
  // A key already typed for the picture; else the reading, to be put right.
  el('ocr-key').value = (await savedKey(book.id, href)) || el('ocr-text').value;
  const result = el('ocr-key-result');
  result.hidden = !ocrState.lastCheck;
  result.classList.remove('problem');
  if (ocrState.lastCheck) paintAccuracy(result, ocrState.lastCheck.summary, ocrState.lastCheck.totals);
}

/** One picture read every way, and scored against its key. */
async function checkPicture(book, href, key, scripts, direction, token) {
  const blob = reader.state.images.get(href);
  if (!blob) throw new Error('That picture has not loaded yet.');
  const rows = [];
  const once = new Map();
  for (const check of CHECKS) {
    let read = check.same ? once.get(check.same) : null;
    if (!read) {
      read = await ocr.readPicture(blob, scripts, { steps: check.steps });
      if (token !== ocrState.token) return null;
      if (check.same) once.set(check.same, read);
    }
    const text = ocr.readingText(read.blocks, read.script, { direction, corrected: check.corrected });
    rows.push({ label: check.label, score: { ...ocrEval.score(key, text), ms: read.ms || 0 } });
  }
  return rows;
}

async function runAccuracy(all) {
  const book = reader.state.book;
  if (!book) return;
  const token = ++ocrState.token;
  const result = el('ocr-key-result');
  result.hidden = false;
  result.classList.remove('problem');
  result.textContent = 'Getting ready…';
  el('ocr-key-copy').disabled = true;
  const scripts = ocrState.choice ? [ocrState.choice] : ocr.scriptsFor(book.lang);
  const direction = ocrDirection();
  const href = ocrState.hrefs[ocrState.at];
  if (href) await saveKey(book.id, href, el('ocr-key').value);
  // The pictures to check: this one, or every one of the book with a key.
  let jobs;
  if (all) {
    const rows = await store.byIndex('translations', 'bookId', book.id).catch(() => []);
    jobs = rows.filter((row) => row.lang === 'key' && row.value)
      .map((row) => ({ href: row.field.slice('ocrkey:'.length), key: row.value }))
      .filter((job) => reader.state.images.get(job.href));
  } else {
    const key = el('ocr-key').value.trim();
    jobs = key && href ? [{ href, key }] : [];
  }
  if (!jobs.length) {
    result.classList.add('problem');
    result.textContent = all
      ? 'No picture of this book that is loaded has an answer key yet.'
      : 'Type or put right the answer key first.';
    return;
  }
  el('ocr-key-run').disabled = true;
  el('ocr-key-all').disabled = true;
  el('ocr-key-copy').disabled = true;
  const per = CHECKS.map(() => []);
  try {
    for (let i = 0; i < jobs.length; i++) {
      result.textContent = `Reading picture ${i + 1} of ${jobs.length}, ${CHECKS.length - 1} ways…`;
      const rows = await checkPicture(book, jobs[i].href, jobs[i].key, scripts, direction, token);
      if (!rows) return;
      rows.forEach((row, k) => per[k].push(row.score));
    }
  } catch (error) {
    if (token !== ocrState.token) return;
    result.classList.add('problem');
    result.textContent = error.message || 'The check could not be run.';
    return;
  } finally {
    el('ocr-key-run').disabled = false;
    el('ocr-key-all').disabled = false;
  }
  const totals = CHECKS.map((check, k) => ({ label: check.label, score: ocrEval.total(per[k]) }));
  const now = totals[totals.length - 1].score;
  const summary = `${jobs.length} picture${jobs.length === 1 ? '' : 's'} · ${now.characters} characters`
    + ` in ${now.units} bubbles · ${direction === 'rtl' ? 'right to left' : 'left to right'}`;
  paintAccuracy(result, summary, totals);
  ocrState.lastCheck = { summary, totals };
  ocrState.report = [
    `Accuracy check · ${jobs.length} picture${jobs.length === 1 ? '' : 's'} · ${now.characters} characters`
      + ` in ${now.units} bubbles · read as ${scripts.join(', ')} · ${direction === 'rtl' ? 'right to left' : 'left to right'}`,
    '',
    ocrEval.report(totals),
    '',
    'CER: characters wrong per character of the key. WER: the same in words (— where the text has no spaces).',
    'Omitted: bubbles not found. Duplicated: found twice. Out of order: found, not where read. Extra: text not in the key.',
    'Before this update: without the quarter search, the second reading of columns, or straightening.',
    'Lower is better throughout. Only as good as the answer key.',
  ].join('\n');
  el('ocr-key-copy').disabled = false;
}

/** The scores as a small table, with what each column means. */
function paintAccuracy(result, summary, totals) {
  result.innerHTML = '';
  const head = document.createElement('p');
  head.textContent = summary;
  const table = document.createElement('table');
  const columns = [
    ['Reading', (s, label) => label],
    ['CER', (s) => ocrEval.percent(s.cer)],
    ['WER', (s) => ocrEval.percent(s.wer)],
    ['Missed', (s) => `${s.omitted}/${s.units}`],
    ['Twice', (s) => String(s.duplicated)],
    ['Order', (s) => String(s.outOfOrder)],
    ['Extra', (s) => String(s.extra)],
    ['Time', (s) => (s.ms ? `${(s.ms / 1000).toFixed(1)}s` : '—')],
  ];
  const row = (cells, tag) => {
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement(tag);
      td.textContent = cell;
      tr.appendChild(td);
    }
    return tr;
  };
  const thead = document.createElement('thead');
  thead.appendChild(row(columns.map(([name]) => name), 'th'));
  const tbody = document.createElement('tbody');
  for (const { label, score } of totals) tbody.appendChild(row(columns.map(([, cell]) => cell(score, label)), 'td'));
  table.append(thead, tbody);
  const notes = document.createElement('p');
  notes.className = 'ocr-key-notes';
  notes.textContent = 'CER: characters wrong per character of the key; WER: words wrong (— where words have no spaces). '
    + 'Missed: bubbles not found. Twice: found twice. Order: found, but out of reading order. Extra: text not in the key. '
    + 'Lower is better. Before this update: without the quarter search, the second reading of columns, or straightening. '
    + 'Only as good as the answer key.';
  result.append(head, table, notes);
}

/* ── translations over the pictures ────────────────────────────────────
 *
 * Each picture on screen read and translated, bubble by bubble, and each
 * translation laid over the bubble it came from. The next two pictures are
 * read and translated before they are reached, one at a time, so turning
 * the page finds them done. Readings are kept with the book, and the
 * translator keeps its own cache, so nothing is read or paid for twice.
 */

/* Readings of whole pictures: shared by the sheet and the overlays. */
const pictureReads = new Map();
const readKey = (bookId, href, scripts) => {
  const size = reader.state.images.get(href)?.size || 0;
  // The size changes when a picture is blacked out: read again then.
  // The version: readings made before the reading changed are made again.
  return `${bookId}:ocrpic2:${href}:${size}:${scripts.join(',')}`;
};

async function readWhole(bookId, href, scripts) {
  const key = readKey(bookId, href, scripts);
  if (pictureReads.has(key)) return pictureReads.get(key);
  try {
    const kept = await store.get('translations', key);
    if (kept?.value) {
      const read = JSON.parse(kept.value);
      pictureReads.set(key, read);
      return read;
    }
  } catch { /* read it afresh */ }
  const blob = reader.state.images.get(href);
  if (!blob) return null;
  const read = await ocr.readPicture(blob, scripts);
  pictureReads.set(key, read);
  store.put('translations', {
    key, bookId, field: `ocrpic:${href}`, lang: 'ocr', value: JSON.stringify(read), at: Date.now(),
  }).catch(() => {});
  return read;
}

function textHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}${text.length}`;
}

/** A reading's bubbles in order, each with its translation. The others on
 *  the page go along as context, for names and tone. */
async function translateRead(bookId, read, direction, href = read.href) {
  // Muddle is not sent: translated, it is nonsense over the picture.
  const blocks = ocr.orderedBlocks(read.blocks, read.script, { direction })
    .filter((block) => ocr.readable(block.joined, read.script));
  if (!blocks.length) return [];
  const settings = await store.settings();
  const items = blocks.map((block) => ({ field: `ocr:${textHash(block.joined)}`, text: block.joined }));
  // An AI model that can see is shown the page itself: who is speaking, to
  // whom, with what face. Only what it has not translated already is sent.
  let image = null;
  if (href && translate.status().engine === 'llm' && settings.aiSeesPage !== false) {
    image = await pagePicture(href).catch(() => null);
  }
  // The whole page at once, so that each bubble is translated knowing the
  // others; each part comes back to its own bubble.
  const { results } = await translate.translatePage(bookId, items, settings.translateTarget,
    ocr.languageOf(read.script), { image });
  return blocks.map((block, i) => ({ ...block, translation: results.get(items[i].field) || '' }));
}

/* The page, made small enough to send: a model reads a page at about this
 * size, and a full-size scan would cost several times as much to send for
 * nothing. Kept while the book is open, so a page is shrunk once. */
const PAGE_SIDE = 1568;
const pagePictures = new Map();

async function pagePicture(href) {
  // By book as well: two comics both have a "p1.jpg".
  const key = `${reader.state.book?.id}:${href}`;
  if (pagePictures.has(key)) return pagePictures.get(key);
  const blob = reader.state.images.get(href);
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, PAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.82);
    const picture = { type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
    if (pagePictures.size > 6) pagePictures.delete(pagePictures.keys().next().value);
    pagePictures.set(key, picture);
    return picture;
  } finally {
    bitmap.close?.();
  }
}

const overlay = {
  on: false,
  book: null,
  queue: [],          // hrefs to read (and translate) next
  busy: false,
  done: new Map(),    // href -> { read, blocks }
  failed: false,
  watcher: null,
};

async function setOverlay(bookId, on) {
  const saved = (await store.settings()).ocrOverlay || {};
  await store.saveSettings({ ocrOverlay: { ...saved, [bookId]: on } });
  overlay.on = on;
  overlay.book = bookId;
  overlay.failed = false;
  // Off is off: nothing more is asked of the translator. (A request already
  // on its way is let finish, and cached; nothing new is sent.)
  if (!on) overlay.queue = [];
  el('ocr-btn').setAttribute('aria-pressed', String(on));
  if (on) refreshOverlay();
  else clearOverlays();
}

/* A new place in the book: the overlays for what is on screen, and the
 * pictures ahead put in the queue. A new book: its own setting. */
async function syncOverlay() {
  const book = reader.state.book;
  if (!book) return;
  if (overlay.book !== book.id) {
    overlay.book = book.id;
    overlay.queue = [];
    overlay.done.clear();
    overlay.failed = false;
    overlay.on = !!(await store.settings()).ocrOverlay?.[book.id];
    el('ocr-btn').setAttribute('aria-pressed', String(overlay.on));
  }
  if (overlay.on) refreshOverlay();
}

function refreshOverlay() {
  if (!overlay.on || !ocr.available()) return;
  const here = reader.picturesInView({ inOrder: true });
  for (const href of here) if (overlay.done.has(href)) drawOverlay(href);
  // On screen first, then the two ahead.
  const wanted = [...here, ...reader.picturesAhead(2)].filter((href) => !overlay.done.has(href));
  overlay.queue = [...new Set([...wanted, ...overlay.queue.filter((href) => !wanted.includes(href))])].slice(0, 6);
  pumpOverlay();
}

/* Without the overlays: the next pictures read anyway (reading is free and
 * offline), so that the sheet opens on them at once. */
function warmAhead() {
  const book = reader.state.book;
  if (!book || overlay.on) return;
  const scripts = ocrState.choice ? [ocrState.choice] : ocr.scriptsFor(book.lang);
  const ahead = reader.picturesAhead(2);
  (async () => {
    for (const href of ahead) {
      try { await readWhole(book.id, href, scripts); } catch { return; }
    }
  })();
}

async function pumpOverlay() {
  if (overlay.busy) return;
  overlay.busy = true;
  try {
    while (overlay.on && overlay.queue.length && !overlay.failed) {
      const book = reader.state.book;
      if (!book || book.id !== overlay.book) break;
      const href = overlay.queue.shift();
      if (overlay.done.has(href)) continue;
      const scripts = ocrState.book === book.id && ocrState.choice ? [ocrState.choice] : ocr.scriptsFor(book.lang);
      try {
        const read = await readWhole(book.id, href, scripts);
        if (!read) continue;
        const direction = await directionFor(book, read);
        const blocks = await translateRead(book.id, read, direction, href);
        const areas = await bubbleAreas(href, read, blocks);
        overlay.done.set(href, { read, blocks, areas });
        if (overlay.on && overlay.book === book.id) drawOverlay(href);
      } catch (error) {
        // Said once, and the queue stopped: a missing key or a spent quota
        // fails the same way for every picture after.
        overlay.failed = true;
        toast(error.message || 'The pictures could not be translated', 6000, { kind: 'failed' });
      }
    }
  } finally {
    overlay.busy = false;
  }
}

async function directionFor(book, read) {
  const set = (await store.settings()).ocrDirections?.[book.id];
  return set || ocr.directionOf(read.blocks, read.script, book.lang || '');
}

function clearOverlays() {
  for (const layer of document.querySelectorAll('.pic-translation')) layer.remove();
  for (const box of document.querySelectorAll('.pic.translated')) box.classList.remove('translated');
}

/* The picture as drawn: its box less any letterboxing from object-fit. */
function drawnRect(img) {
  const w = img.clientWidth;
  const h = img.clientHeight;
  const nw = img.naturalWidth || w;
  const nh = img.naturalHeight || h;
  let rect = { left: img.offsetLeft, top: img.offsetTop, width: w, height: h };
  const fit = getComputedStyle(img).objectFit;
  if ((fit === 'contain' || fit === 'scale-down' || fit === 'cover') && nw && nh && w && h) {
    const scale = fit === 'cover' ? Math.max(w / nw, h / nh) : Math.min(w / nw, h / nh);
    const cw = nw * scale;
    const ch = nh * scale;
    rect = { left: img.offsetLeft + (w - cw) / 2, top: img.offsetTop + (h - ch) / 2, width: cw, height: ch };
  }
  return rect;
}

/* Where each translation goes: over the whole bubble its text is in, as
 * found in the picture; or, where there is no bubble to find, over the
 * text with a margin. Two that would overlap keep to their own text. */
async function bubbleAreas(href, read, blocks) {
  const plain = blocks.map((block) => ({ x: block.x, y: block.y, w: block.w, h: block.h, round: false }));
  const blob = reader.state.images.get(href);
  if (!blob || !read.width || !read.height || typeof createImageBitmap !== 'function') return plain;
  let lum;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = read.width;
    canvas.height = read.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, read.width, read.height);
    bitmap.close?.();
    const data = ctx.getImageData(0, 0, read.width, read.height).data;
    lum = new Uint8Array(read.width * read.height);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    }
  } catch {
    return plain;
  }
  const areas = blocks.map((block) => ocr.bubbleArea(lum, read.width, read.height, block));
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      if (!overlaps(areas[i], areas[j])) continue;
      areas[i] = plain[i];
      areas[j] = plain[j];
    }
  }
  return areas;
}

function drawOverlay(href) {
  const entry = overlay.done.get(href);
  if (!entry) return;
  const { read, blocks } = entry;
  if (!read.width || !read.height) return;
  for (const img of reader.pictureElements(href)) {
    const holder = img.parentElement;
    if (!holder?.classList.contains('pic')) continue;
    holder.querySelector(':scope > .pic-translation')?.remove();
    // An ornament or an icon in the text has no bubbles to speak of.
    if (img.classList.contains('small') || holder.classList.contains('small')) continue;
    const shown = blocks.filter((block) => block.translation);
    if (!shown.length) continue;
    holder.classList.add('translated');
    const layer = document.createElement('div');
    layer.className = 'pic-translation';
    layer.setAttribute('aria-hidden', 'true');
    const areas = blocks.map((block, i) => (block.translation ? entry.areas?.[i] || block : null));
    blocks.forEach((block, i) => {
      if (!block.translation) return;
      const area = areas[i];
      const room = roomFor(areas, i, read.width, read.height);
      const box = document.createElement('div');
      box.className = 'bubble-tr';
      // Placed by its middle, so a box that has to grow for its text grows
      // evenly both ways.
      box.style.left = `${((area.x + area.w / 2) / read.width) * 100}%`;
      box.style.top = `${((area.y + area.h / 2) / read.height) * 100}%`;
      box.style.width = `${(area.w / read.width) * 100}%`;
      box.style.height = `${(area.h / read.height) * 100}%`;
      // Kept, for a box that grows to fit to grow from.
      box.style.setProperty('--w', box.style.width);
      box.style.setProperty('--h', box.style.height);
      // As far as it may grow: halfway to the next translation each way.
      box.dataset.maxw = String(room.maxW / read.width);
      box.dataset.maxh = String(room.maxH / read.height);
      // Set in ordinary lines however narrow the place: a bubble of columns
      // has its translation run down it a word or two to a line.
      const text = document.createElement('div');
      text.className = 'tr-text';
      const line = document.createElement('span');
      line.className = 'tr-line';
      line.textContent = block.translation;
      text.appendChild(line);
      box.appendChild(text);
      layer.appendChild(box);
    });
    holder.appendChild(layer);
    placeLayer(img, layer);
    watchPicture(img);
  }
}

/* How far one translation may grow, centred where it is: halfway to the
 * next translation along each side (so two neighbours can never grow into
 * each other), and no further than the picture's edge. */
function roomFor(areas, i, width, height) {
  const a = areas[i];
  let left = 0, right = width, top = 0, bottom = height;
  areas.forEach((b, j) => {
    if (!b || j === i) return;
    const besideY = Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
    const besideX = Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);
    if (besideY) {
      if (b.x >= a.x + a.w) right = Math.min(right, (a.x + a.w + b.x) / 2);
      else if (b.x + b.w <= a.x) left = Math.max(left, (b.x + b.w + a.x) / 2);
    }
    if (besideX) {
      if (b.y >= a.y + a.h) bottom = Math.min(bottom, (a.y + a.h + b.y) / 2);
      else if (b.y + b.h <= a.y) top = Math.max(top, (b.y + b.h + a.y) / 2);
    }
  });
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  return {
    maxW: Math.max(a.w, 2 * Math.min(cx - left, right - cx)),
    maxH: Math.max(a.h, 2 * Math.min(cy - top, bottom - cy)),
  };
}

function placeLayer(img, layer) {
  const rect = drawnRect(img);
  if (!rect.width || !rect.height) return;
  layer.style.left = `${rect.left}px`;
  layer.style.top = `${rect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;
  for (const box of layer.children) fitText(box, rect);
  separate(layer);
}

/* Last of all, the words as drawn: any two that still touch -- neighbours
 * on a slant, each grown its own way -- are made smaller until they do not. */
function separate(layer) {
  const boxes = [...layer.children];
  const touch = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  for (let round = 0; round < 8; round++) {
    const rects = boxes.map((box) => box.firstElementChild.getBoundingClientRect());
    const crowded = new Set();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (touch(rects[i], rects[j])) { crowded.add(boxes[i]); crowded.add(boxes[j]); }
      }
    }
    if (!crowded.size) return;
    let shrunk = false;
    for (const box of crowded) {
      const size = parseFloat(box.style.fontSize) || 10;
      if (size <= 6) continue;
      box.style.fontSize = `${Math.max(6, size * 0.88)}px`;
      shrunk = true;
    }
    if (!shrunk) return;
  }
}

/* The largest type that fits the place, with no word broken across lines;
 * no larger than a comfortable size. If it will not fit at a small but
 * readable size, the place grows -- wider for a word wider than a narrow
 * bubble of columns, then taller -- but only into the room it has (see
 * roomFor), never over the next translation. */
function fitText(box, picture) {
  box.style.width = box.style.getPropertyValue('--w') || box.style.width;
  box.style.height = box.style.getPropertyValue('--h') || box.style.height;
  box.style.overflow = '';
  const fits = () => box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1;
  let low = 8;
  let high = Math.max(9, Math.min(24, box.clientHeight * 0.5));
  box.style.fontSize = `${high}px`;
  if (fits()) return;
  for (let i = 0; i < 7; i++) {
    const mid = (low + high) / 2;
    box.style.fontSize = `${mid}px`;
    if (fits()) low = mid;
    else high = mid;
  }
  box.style.fontSize = `${low}px`;
  if (fits()) return;
  const maxW = (Number(box.dataset.maxw) || 0) * picture.width;
  const maxH = (Number(box.dataset.maxh) || 0) * picture.height;
  if (box.scrollWidth > box.clientWidth + 1 && maxW > box.clientWidth) {
    box.style.width = `${Math.min(box.scrollWidth + 2, maxW)}px`;
  }
  if (box.scrollHeight > box.clientHeight + 1 && maxH > box.clientHeight) {
    box.style.height = `${Math.min(box.scrollHeight + 2, maxH)}px`;
  }
  if (fits()) return;
  // No more room: smaller still, and what will not fit even so is shown
  // rather than cut off.
  box.style.fontSize = '7px';
  if (!fits()) box.style.overflow = 'visible';
}

/* Laid out again whenever the picture's size changes: a new page size, a
 * new fitting, the bars coming and going. */
function watchPicture(img) {
  if (typeof ResizeObserver !== 'function') return;
  if (!overlay.watcher) {
    overlay.watcher = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const layer = entry.target.parentElement?.querySelector(':scope > .pic-translation');
        if (layer) placeLayer(entry.target, layer);
      }
    });
  }
  overlay.watcher.observe(img);
}

/* A box dragged across the picture: one bubble, read on its own. A tap
 * without a drag takes the box away and reads the whole picture again. */
function wireOcrBox() {
  const stage = el('ocr-stage');
  const box = el('ocr-box');
  let start = null;
  const at = (e) => {
    const r = el('ocr-img').getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      r,
    };
  };
  const paint = (a, b) => {
    const { r } = a;
    const s = stage.getBoundingClientRect();
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    box.style.left = `${r.left - s.left + x * r.width}px`;
    box.style.top = `${r.top - s.top + y * r.height}px`;
    box.style.width = `${Math.abs(a.x - b.x) * r.width}px`;
    box.style.height = `${Math.abs(a.y - b.y) * r.height}px`;
    box.hidden = false;
  };
  stage.addEventListener('pointerdown', (e) => {
    if (ocrState.at < 0) return;
    start = at(e);
    stage.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!start) return;
    paint(start, at(e));
  });
  const finish = (e) => {
    if (!start) return;
    const end = at(e);
    const a = start;
    start = null;
    const w = Math.abs(a.x - end.x);
    const h = Math.abs(a.y - end.y);
    if (w < 0.04 || h < 0.02) {
      box.hidden = true;
      if (ocrState.box) { ocrState.box = null; runOcr(); }
      return;
    }
    ocrState.box = { x: Math.min(a.x, end.x), y: Math.min(a.y, end.y), w, h };
    paint(a, end);
    runOcr();
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', () => { start = null; });
}

function wireOcr() {
  drawOcrPanels();
  el('ocr-btn').onclick = () => { closeCopyMenu(); openOcr(); };
  el('ocr-close').onclick = closeOcr;
  el('ocr-sheet').onclick = (e) => { if (e.target === el('ocr-sheet')) closeOcr(); };
  wireOcrBox();
  el('ocr-copy').onclick = async () => {
    const text = el('ocr-text').value;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('no clipboard');
    } catch {
      const area = el('ocr-text');
      area.select();
      document.execCommand('copy');
      area.setSelectionRange(0, 0);
    }
    const characters = text.replace(/\s/g, '').length;
    toast(`Text copied · ${characters.toLocaleString()} character${characters === 1 ? '' : 's'}`);
  };
  // Once, for what is in the sheet: the same text read again (another
  // script, another picture) is translated again while the sheet is open.
  el('ocr-translate').onclick = () => {
    ocrState.translate = true;
    showOcrTranslation();
  };
  el('ocr-asread').onclick = () => {
    ocrState.asRead = !ocrState.asRead;
    el('ocr-asread').setAttribute('aria-pressed', String(ocrState.asRead));
    paintOcrText();
  };
  el('ocr-check').onclick = () => showAccuracy(el('ocr-accuracy').hidden);
  el('ocr-key').addEventListener('change', () => {
    const book = reader.state.book;
    const href = ocrState.hrefs[ocrState.at];
    if (book && href) saveKey(book.id, href, el('ocr-key').value).catch(() => {});
  });
  el('ocr-key-run').onclick = () => runAccuracy(false);
  el('ocr-key-all').onclick = () => runAccuracy(true);
  el('ocr-key-copy').onclick = async () => {
    if (!ocrState.report) return;
    try {
      await navigator.clipboard.writeText(ocrState.report);
      toast('Report copied');
    } catch {
      toast('The report could not be copied', 3000);
    }
  };
  el('ocr-overlay').onclick = async () => {
    const book = reader.state.book;
    if (!book) return;
    const on = !(overlay.on && overlay.book === book.id);
    if (on && !translate.status().configured) {
      return toast('Choose a translator in Settings → Translation first', 5000);
    }
    await setOverlay(book.id, on);
    el('ocr-overlay').setAttribute('aria-pressed', String(on));
    // On: the sheet steps aside so the pictures can be seen.
    if (on) closeOcr();
  };
  el('ocr-lens').onclick = async () => {
    const href = ocrState.hrefs[Math.max(0, ocrState.at)];
    try {
      const blob = await ocrBlobOf(href, ocrState.at < 0 ? null : ocrState.box);
      if (!blob) return toast('That picture has not loaded yet');
      await ocr.toLens(blob);
    } catch (error) {
      toast(error.message || 'Google Lens could not be opened', 5000, { kind: 'failed' });
    }
  };
}

/* ── from the web ─────────────────────────────────────────────────────────
 *
 * A contents page in, every link on it listed, the clutter taken out by the
 * reader, and the rest into Build as a part -- downloaded when the book is
 * built, beside whatever else is in the list (web.js does the fetching). Like
 * a batch link downloader, run from the app and owing nobody a subscription.
 * Reached from Build only.
 */

const webState = {
  links: [],          // { url, text, chrome, kind, likely, picked, got }
  title: '',
  author: '',
  cover: '',          // the site's picture of the book, from its link preview
  sources: [],
  reversed: false,
  pictures: true,
  titleTouched: false,
};

/* What the screen says before anything has been asked of it. */
let webIntro = null;

function webNote(message, problem = false) {
  const note = el('web-note');
  if (webIntro === null) webIntro = note.textContent;
  note.textContent = message;
  note.classList.toggle('problem', problem);
  note.hidden = !message;
}

function renderWeb() {
  paintMore();
  el('web-picked').hidden = !webState.links.length;
  el('web-foot').hidden = !webState.links.length;
  el('web-reverse').setAttribute('aria-pressed', String(webState.reversed));
  el('web-pictures').setAttribute('aria-pressed', String(webState.pictures));
  el('web-pictures').textContent = webState.pictures ? 'Pictures: on' : 'Pictures: off';
  if (!webState.titleTouched) el('web-title').value = webState.title;
  el('web-eyebrow').textContent = (el('web-title').value || '').trim() || 'Chapters from a website, for Build';
  paintWebCount();
}

function paintWebCount() {
  const picked = webState.links.filter((link) => link.picked).length;
  el('web-count').textContent = webState.links.length
    ? `${picked} of ${webState.links.length}`
    : '';
  const go = el('web-go');
  go.textContent = `Add${picked ? ` ${picked}` : ''} to Build`;
  go.disabled = picked === 0;
  /* Queued as a book of its own -- not for pages carrying on a book, or left
   * over from one, or new chapters for one: those belong with that book. */
  const queue = el('web-queue');
  if (queue) {
    queue.hidden = !!(webState.leftover || webState.carryOn != null || webState.updating != null);
    queue.disabled = picked === 0;
  }
}

/** Where a link goes, said briefly: the path, not the whole address. */
function webWhere(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(`${u.host}${u.pathname}${u.search}`).replace(/\/$/, '');
  } catch {
    return url;
  }
}

function webTag(link) {
  if (link.got === true) return 'in book';
  if (link.got === false) return 'failed';
  if (link.kind === 'picture') return 'picture';
  if (link.kind === 'file') return 'file';
  if (link.chrome) return 'menu';
  if (link.likely) return 'chapter';
  return '';
}

function webRow(link, at) {
  const row = document.createElement('li');
  row.className = 'web-link';
  row.dataset.at = String(at);
  row.setAttribute('role', 'checkbox');
  const tag = webTag(link);
  row.innerHTML = '<span class="web-tick"></span>'
    + `<span class="web-what"><b>${escapeText(link.text || '(no name)')}</b>`
    + `<small>${escapeText(webWhere(link.url))}</small></span>`
    + (tag ? `<span class="web-tag">${tag}</span>` : '');
  paintWebRow(row, link);
  return row;
}

function paintWebRow(row, link) {
  row.setAttribute('aria-checked', String(!!link.picked));
  row.classList.toggle('likely', !!link.likely);
  row.classList.toggle('got', link.got === true);
  row.classList.toggle('lost', link.got === false);
  const tag = row.querySelector('.web-tag');
  const said = webTag(link);
  if (tag) tag.textContent = said;
  else if (said) row.insertAdjacentHTML('beforeend', `<span class="web-tag">${said}</span>`);
}

function drawWebList() {
  const list = el('web-list');
  const rows = document.createDocumentFragment();
  webState.links.forEach((link, at) => rows.appendChild(webRow(link, at)));
  list.replaceChildren(rows);
  filterWebList();
  renderWeb();
}

function repaintWebRows() {
  for (const row of el('web-list').children) {
    paintWebRow(row, webState.links[Number(row.dataset.at)]);
  }
  paintWebCount();
}

/** The filter narrows what is shown, and what Tick and Untick act on. */
function filterWebList() {
  const words = (el('web-filter').value || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const row of el('web-list').children) {
    const link = webState.links[Number(row.dataset.at)];
    const haystack = `${link.text} ${link.url}`.toLowerCase();
    row.hidden = words.length > 0 && !words.every((word) => haystack.includes(word));
  }
}

const shownWebLinks = () => [...el('web-list').children]
  .filter((row) => !row.hidden)
  .map((row) => webState.links[Number(row.dataset.at)]);

/* One search of a site's list at a time. A second -- Search for more, or
 * Open the site's search again, pressed while one ran -- ran beside the
 * first: twice the requests to the site, and two counts written over each
 * other ("page 18", then "page 13"). Each search has a number; a newer one
 * stops the older at its next page, and only the newest may say anything
 * or change the list. The buttons are held while one runs. */
let webSearch = 0;
function holdSearch(on) {
  for (const id of ['web-find', 'web-more', 'web-open']) {
    const button = el(id);
    if (button) button.disabled = on;
  }
}

async function findWebLinks() {
  const addresses = web.addressesIn(el('web-address').value);
  if (!addresses.length) {
    webNote('Paste a web address first — the page that lists the chapters.', true);
    return;
  }
  if (!web.available()) {
    webNote('Downloading needs the Android app. This copy of the reader cannot reach websites.', true);
    return;
  }

  const button = el('web-find');
  const quick = webState.quickCheck;
  webState.quickCheck = false;
  const known = quick && webState.updating != null
    ? new Set((await store.byIndex('chapters', 'bookId', webState.updating)).map((chapter) => chapter.from).filter(Boolean))
    : null;
  let readPart = null;   // { read, of } when the list was read only so far
  const mine = ++webSearch;
  const current = () => mine === webSearch;
  holdSearch(true);
  try {
    let links;
    let title = '';
    let author = '';
    let cover = '';
    let newestFirstList = false;
    let wordpress = false;
    if (el('web-direct').checked) {
      // Given the chapters themselves: nothing to look for.
      links = addresses.map((url) => ({ url, text: '', chrome: false, kind: null }));
    } else {
      button.textContent = 'Finding…';
      const found = await web.findLinks(addresses, {
        // The pages of a long list are asked for at the same pace as chapters.
        listGap: webListDelay(), listJitter: webListJitter(),
        shouldStop: () => !current(),
        known: known?.size ? known : null,
        onProgress: (fraction, address, page, pages, note) => {
          if (note && current()) { webNote(note); return; }
          if (address && current()) {
            webNote(page > 1 ? `Reading page ${page}${pages ? ` of ${pages}` : ''} of the list…` : `Reading ${webWhere(address)}…`);
          }
        },
      });
      if (!current()) return;   // a newer search has it
      lastFindFailed = !found.links.length;
      if (!found.links.length) {
        webState.sources = addresses;
        webState.searches = 0;
        paintMore();
        webNote(found.failed.length
          ? (web.wantsCheck(found.failed[0].reason)
            ? `${new URL(addresses[0]).host} put up a browser check the downloader could not pass. Tap Open the site, let the check pass there (tap it if it asks), then Done — the list is read again.`
            : `That page could not be downloaded: ${found.failed[0].reason}. Search for more tries again, waiting longer.`)
          : 'No links were found on that page. If the site was still loading, Search for more looks again and waits longer. Otherwise try the site\'s plain contents page, or paste the chapter addresses themselves and tick "These are the chapters".', true);
        return;
      }
      links = found.links;
      title = found.title;
      author = found.author;
      cover = found.cover;
      newestFirstList = found.newestFirstList;
      wordpress = found.wordpress;
      if (found.failed.length) {
        toast(`${found.failed.length} of those pages could not be read: ${found.failed[0].reason}`, 6000);
      }
      if (found.stoppedEarly) readPart = { read: found.pagesRead, of: found.pagesTotal };
    }

    const likely = web.likelyChapters(links, addresses[0]);
    webState.links = links.map((link) => ({ ...link, likely: likely.has(link.url), picked: true, got: undefined }));
    webState.sources = addresses;
    webState.searches = 0;
    webState.title = title;
    webState.author = author;
    webState.cover = cover;
    webState.titleTouched = false;
    webState.manualOrder = false;
    // A contents page that lists the newest chapter first is turned round,
    // and says so: a book read from its last chapter is no book.
    // Only the chapters are put in order: the menus stay where the page had
    // them, at the top and the bottom, out of the way.
    const order = web.inReadingOrder(webState.links, (link) => link.likely, newestFirstList);
    webState.links = order.links;
    webState.reversed = order.how === 'reversed';

    const chapters = webState.links.filter((link) => link.likely).length;
    webNote(el('web-direct').checked
      ? `${webState.links.length} page${webState.links.length === 1 ? '' : 's'} to download, in the order given.`
      : `${webState.links.length} links found${chapters ? `, ${chapters} of them look like chapters` : ''}. `
        + 'Everything is ticked: untick what is not the book, or tap Just the chapters.'
        + (wordpress && newestFirstList ? ' A WordPress list of posts: every page of it was read.' : '')
        + (order.how === 'reversed' ? ' The site listed them newest first, so the order has been turned round.' : '')
        + (order.how === 'sorted' ? ' The site listed them out of order, so they have been put in chapter order.' : '')
        + (!el('web-direct').checked && chapters < 3 ? ' No chapters yet? The site may still have been loading — tap Search for more.' : ''));
    el('web-filter').value = '';
    const update = await markWhatTheBookHas(webState.links);
    if (update) {
      // Read only as far as it took: said, with how to read the rest.
      const part = readPart
        ? ` Only ${readPart.read}${readPart.of > readPart.read ? ` of ${readPart.of}` : ''} page${readPart.read === 1 ? '' : 's'} of the list ${readPart.read === 1 ? 'was' : 'were'} read, as far as the chapters it already has. Tap Find links to read every page.`
        : '';
      webNote((update.fresh
        ? `${update.fresh} chapter${update.fresh === 1 ? '' : 's'} not in “${library.displayTitle(update.book)}” yet, ticked to add to its end. The ${update.had} it has are marked “in book”.`
        : readPart
          ? `No new chapters for “${library.displayTitle(update.book)}”.`
          : `“${library.displayTitle(update.book)}” has every chapter listed (${update.had}). If it should have more, Search for more.`) + part);
    }
    drawWebList();
    paintResume();
  } catch (error) {
    if (!current()) return;
    lastFindFailed = true;
    webNote(error.message || 'Those links could not be found.', true);
  } finally {
    if (current()) {
      holdSearch(false);
      button.textContent = 'Find links';
      paintMore();
    }
  }
}

/* ── Check for new chapters ─────────────────────────────────────────────
 *
 * As WebToEpub's library does: a book remembers the website it came from
 * (and each chapter the link it came from), so listing that website again
 * can tell what the book already has from what it has not -- chapters a
 * pause, a crash or a site's lost requests left out, and chapters
 * published since. What it has is shown "in book" and unticked; the rest
 * is ticked, and added builds onto the end of the book.
 */
async function checkNewChapters(book) {
  clearWeb();
  webState.updating = book.id;
  el('web-direct').checked = false;
  el('web-title').value = library.displayTitle(book);
  webState.titleTouched = true;
  await show('web');
  if (!book.webSources?.length) {
    webNote(`Paste the address of “${library.displayTitle(book)}”'s contents page and tap Find links: what it has will be unticked, the rest ticked to add to its end.`);
    return;
  }
  el('web-address').value = book.webSources.join('\n');
  // Only as much of the list as it takes to reach what the book has (see
  // findLinks' known); Find links again reads every page.
  webState.quickCheck = true;
  await findWebLinks();
}

/** On a list found for a book being updated: what it has, and what not. */
async function markWhatTheBookHas(links) {
  const book = webState.updating != null ? await store.get('books', webState.updating) : null;
  if (!book) return null;
  const chapters = await store.byIndex('chapters', 'bookId', book.id);
  const fromLinks = new Set(chapters.map((chapter) => chapter.from).filter(Boolean));
  // Books built before chapters kept their links: by name, which for a web
  // chapter is its link's text.
  const names = new Set(chapters.map((chapter) => tidyName(chapter.title)).filter(Boolean));
  let had = 0;
  for (const link of links) {
    if (fromLinks.has(link.url) || (link.text && names.has(tidyName(link.text)))) {
      link.got = true;
      link.picked = false;
      had += 1;
    } else {
      link.got = undefined;
      link.picked = !!link.likely;
    }
  }
  webState.carryOn = book.id;
  return { book, had, fresh: links.filter((link) => link.picked).length };
}
const tidyName = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ── Open the site ─────────────────────────────────────────────────────
 *
 * A site that puts up a check ("Just a moment…", "잠시만 기다리십시오") the
 * unseen browser cannot pass -- it is not shown, and some checks want to
 * be seen or ticked. Shown here, over the app, the check passes as it does
 * in the phone's browser, and what it leaves lets the downloader in after.
 */
let lastFindFailed = false;

async function openSiteToPass() {
  const address = web.addressesIn(el('web-address').value)[0];
  if (!address) return;
  try {
    await web.openSite(address);
  } catch (error) {
    toast(error.message || 'The site could not be shown', 6000);
    return;
  }
  // Back from it: what failed before is asked again.
  if (lastFindFailed || !webState.links.some((link) => link.likely)) {
    toast('Searching again…');
    await findWebLinks();
  } else {
    toast('Done — Search for more or Find links to read the list again');
  }
}

/* ── Search for more ───────────────────────────────────────────────────
 *
 * A site that builds its contents page in script can be read before its
 * list has arrived: the menus, and no chapters. Instead of one fixed wait,
 * the page can be read again, waiting longer each time it is asked (up to
 * the longest the renderer allows), and whatever turns up is added to the
 * list -- what was ticked or unticked stays as it was.
 */
function paintMore() {
  const open = el('web-open');
  if (open) open.hidden = !web.canOpenSite() || !web.addressesIn(el('web-address').value).length;
  const forget = el('web-forget');
  if (forget) forget.hidden = !open || open.hidden;
  const button = el('web-more');
  if (!button) return;
  button.hidden = !webState.sources.length || el('web-direct').checked || !web.available();
  button.textContent = (webState.searches || 0) >= 3 ? 'Search again' : 'Search for more';
}

async function searchMore() {
  const addresses = webState.sources;
  if (!addresses.length || !web.available()) return;
  const level = Math.min(3, (webState.searches || 0) + 1);
  webState.searches = level;
  const button = el('web-more');
  const mine = ++webSearch;
  const current = () => mine === webSearch;
  holdSearch(true);
  button.textContent = 'Searching…';
  const before = new Map(webState.links.map((link) => [link.url, link]));
  try {
    const found = await web.findLinks(addresses, {
      patience: level, listGap: webListDelay(), listJitter: webListJitter(),
      shouldStop: () => !current(),
      onProgress: (fraction, address, page, pages) => {
        if (address && current()) {
          webNote(page > 1
            ? `Searching again, waiting longer — page ${page}${pages ? ` of ${pages}` : ''} of the list…`
            : `Searching ${webWhere(address)} again, waiting longer…`);
        }
      },
    });
    if (!current()) return;   // a newer search has it
    // What this look found, as it found it, and anything the last look had
    // that this one did not.
    const merged = found.links.map((link) => (before.has(link.url)
      ? { ...link, picked: before.get(link.url).picked }
      : { ...link, picked: true }));
    const now = new Set(merged.map((link) => link.url));
    for (const link of webState.links) if (!now.has(link.url)) merged.push(link);
    const likely = web.likelyChapters(merged, addresses[0]);
    let links = merged.map((link) => ({ ...link, likely: likely.has(link.url), got: undefined }));
    if (!webState.manualOrder) {
      const order = web.inReadingOrder(links, (link) => link.likely, found.newestFirstList);
      links = order.links;
      webState.reversed = order.how === 'reversed';
    }
    webState.links = links;
    if (webState.updating != null) await markWhatTheBookHas(webState.links);
    if (!webState.title && found.title) webState.title = found.title;
    if (!webState.author && found.author) webState.author = found.author;
    if (!webState.cover && found.cover) webState.cover = found.cover;
    const added = links.filter((link) => !before.has(link.url)).length;
    const chapters = links.filter((link) => link.likely).length;
    webNote(added
      ? `Searched again, waiting longer: ${added} more link${added === 1 ? '' : 's'}`
        + `${chapters ? ` — ${chapters} of them all look like chapters` : ''}.`
      : level < 3
      ? 'Nothing more turned up. Search for more again to wait longer still.'
      : 'Nothing more turned up, even waiting as long as it can. The site may need its plain contents page, or the chapter addresses pasted in.');
    if (found.failed.length) toast(`${found.failed.length} of those pages could not be read: ${found.failed[0].reason}`, 6000);
    drawWebList();
    paintResume();
  } catch (error) {
    if (current()) webNote(error.message || 'That page could not be searched again.', true);
  } finally {
    if (current()) {
      holdSearch(false);
      paintMore();
    }
  }
}

/**
 * Where this book stopped last time, if it did: resume from there -- the
 * chapters before it unticked, and the book it stopped short of carried on
 * -- or start from the beginning.
 */
function paintResume() {
  const box = el('web-resume');
  if (!box) return;
  // A book being updated already knows what it has: no resume to offer.
  if (webState.updating != null) { box.hidden = true; return; }
  webState.carryOn = null;
  const stop = !el('web-direct').checked && webState.sources.length ? stopFor(webState.sources[0]) : null;
  let at = stop ? webState.links.findIndex((link) => link.url === stop.url) : -1;
  if (stop && at < 0 && stop.text) at = webState.links.findIndex((link) => link.text === stop.text);
  if (!stop || at <= 0) { box.hidden = true; box.replaceChildren(); return; }

  const paused = stop.reason === web.PAUSED_REASON;
  const name = escapeText(stop.text || 'a page');
  const short = escapeText((stop.text || 'there').length > 32 ? `${stop.text.slice(0, 31)}…` : stop.text || 'there');
  const when = new Date(stop.at).toLocaleDateString();
  const ask = () => {
    box.innerHTML = `<p><b>Last time this ${paused ? 'was paused' : 'stopped'} at ${name}</b> · ${escapeText(when)}`
      + (!paused && stop.reason ? ` — ${escapeText(stop.reason)}` : '') + '.'
      + `<small>${stop.bookId != null
        ? `Resume adds the chapters from there to the end of “${escapeText(stop.bookTitle || 'that book')}”, as one book, if it is still on the shelf.`
        : 'Resume ticks the chapters from there on.'}</small></p>`
      + '<div class="web-row"><button class="btn ghost" data-begin>Start from the beginning</button>'
      + `<button class="btn primary" data-resume>Resume from ${short}</button></div>`;
    box.querySelector('[data-begin]').onclick = () => {
      webState.links.forEach((link) => { link.picked = true; });
      webState.carryOn = null;
      webState.leftover = null;
      repaintWebRows();
      box.hidden = true;
      toast('Starting from the beginning — every chapter is ticked');
    };
    box.querySelector('[data-resume]').onclick = () => {
      webState.links.forEach((link, n) => { if (n < at) link.picked = false; });
      webState.carryOn = stop.bookId;
      // The same pages kept in Build as left over: this settles them.
      webState.leftover = webLeftovers.find((left) => left.links[0]?.url === stop.url)?.id || null;
      repaintWebRows();
      box.innerHTML = `<p><b>Resuming from ${name}</b> — the chapters before it are unticked.</p>`
        + '<div class="web-row"><button class="btn ghost" data-undo>Start from the beginning instead</button></div>';
      box.querySelector('[data-undo]').onclick = () => {
        webState.links.forEach((link) => { link.picked = true; });
        webState.carryOn = null;
        webState.leftover = null;
        repaintWebRows();
        ask();
      };
      el('web-list').children[at]?.scrollIntoView?.({ block: 'center' });
    };
  };
  ask();
  box.hidden = false;
}

/**
 * The chosen pages, into Build as a part.
 *
 * Downloaded when the book is built, beside whatever else is in the list,
 * rather than now: only the site's picture of the book is fetched here, so
 * the workshop can offer it as the cover.
 */
async function addWebToBuild() {
  let chosen = webState.links.filter((link) => link.picked);
  if (!chosen.length) return;
  /* Put in reading order again as they go in -- what is ticked can be a
   * different set from what was ordered when the list was found -- unless
   * the order was turned round by hand, which is the reader's say. */
  if (!webState.manualOrder) chosen = web.inReadingOrder(chosen, () => true).links;
  let name = (el('web-title').value || '').trim() || webState.title || 'From the web';
  // Left over pages, looked over: named for where they now pick up.
  if (webState.leftover && !webState.titleTouched && chosen[0]?.text) {
    const from = chosen[0].text.trim();
    name = `${name.replace(LEFTOVER_SUFFIX, '')} — from ${from.length > 48 ? `${from.slice(0, 47)}…` : from}`;
  }
  const go = el('web-go');
  go.disabled = true;
  go.textContent = 'Adding…';
  try {
    /* Resumed: the book it stopped short of goes in first, so what is built
     * is that book carried on to the end, not a second one beside it. */
    const carried = webState.carryOn != null ? await store.get('books', webState.carryOn) : null;
    if (carried && !build.hasBook(carried.id)) {
      build.addBook(carried);
      build.contents().at(-1).seamless = true;
      if (!webState.titleTouched) name = library.displayTitle(carried);
      el('build-title').value = library.displayTitle(carried);
      buildTitleTouched = true;
    }
    const cover = await web.fetchCover(webState.cover);
    build.addWeb({
      name, links: chosen, pictures: webState.pictures, cover,
      author: webState.author, sources: webState.sources, gap: webDelay(), jitter: webJitter(),
      // Pages left over from an earlier build: this settles them.
      leftover: webState.leftover || null,
    });
    if (carried) build.contents().at(-1).seamless = true;
    if (webState.author && !el('build-author').value) el('build-author').value = webState.author;
    clearWeb();
    toast(carried
      ? `${chosen.length} page${chosen.length === 1 ? '' : 's'} added after “${library.displayTitle(carried)}” — built, they carry it on as one book`
      : `${chosen.length} page${chosen.length === 1 ? '' : 's'} added to Build — downloaded when it is built`);
    // Back to the workshop, which draws itself on the way in.
    back();
  } finally {
    go.disabled = false;
    paintWebCount();
  }
}

/** The pause between pages, in milliseconds, as set on the website screen. */
/** How much each pause may vary, either way, in milliseconds. */
function webJitter() {
  const value = Math.round(Number(el('web-jitter')?.value));
  return Number.isFinite(value) ? Math.max(0, Math.min(60000, value)) : 0;
}

/** "300–700 ms", beside the variation, so what it does is plain. */
function paintWebRange() {
  const range = el('web-range');
  if (!range) return;
  const delay = webDelay();
  const jitter = webJitter();
  range.textContent = jitter ? `· ${Math.max(0, delay - jitter)}–${delay + jitter} ms` : '';
}

/* The list's own pace (see index.html): reading the pages of a contents list,
 * which a reader flips through in seconds, not a chapter's full delay. */
const LIST_DELAY = 4000;
const LIST_JITTER = 2000;
function webListDelay() {
  const value = Math.round(Number(el('web-list-delay')?.value));
  return Number.isFinite(value) ? Math.max(0, Math.min(60000, value)) : LIST_DELAY;
}
function webListJitter() {
  const value = Math.round(Number(el('web-list-jitter')?.value));
  return Number.isFinite(value) ? Math.max(0, Math.min(60000, value)) : LIST_JITTER;
}
function paintWebListRange() {
  const range = el('web-list-range');
  if (!range) return;
  const delay = webListDelay();
  const jitter = webListJitter();
  range.textContent = jitter ? `· ${Math.max(0, delay - jitter)}–${delay + jitter} ms` : '';
}

function webDelay() {
  const value = Math.round(Number(el('web-delay')?.value));
  return Number.isFinite(value) ? Math.max(0, Math.min(60000, value)) : 250;
}

function clearWeb() {
  Object.assign(webState, {
    links: [], title: '', author: '', cover: '', sources: [], reversed: false, titleTouched: false, leftover: null,
    manualOrder: false, carryOn: null, searches: 0, updating: null,
  });
  const resume = el('web-resume');
  if (resume) { resume.hidden = true; resume.replaceChildren(); }
  el('web-list').replaceChildren();
  el('web-address').value = '';
  el('web-filter').value = '';
  el('web-title').value = '';
  webNote(webIntro || '');
  renderWeb();
}

function wireWeb() {
  el('web-find').onclick = findWebLinks;
  el('web-more').onclick = searchMore;
  el('web-open').onclick = openSiteToPass;
  el('web-forget').onclick = () => {
    const address = web.addressesIn(el('web-address').value)[0];
    if (!address || !web.forgetSite(address)) return;
    toast(`Forgot ${new URL(address).host}'s cookies. A check it puts up will need passing again.`, 5000);
  };
  el('web-address').addEventListener('input', paintMore);
  el('web-go').onclick = addWebToBuild;
  el('web-queue').onclick = queueWeb;
  // Remembered: a site that wants a slower pace wants it every time.
  store.settings().then((settings) => {
    if (Number.isFinite(settings.webDelay)) el('web-delay').value = String(settings.webDelay);
    if (Number.isFinite(settings.webJitter)) el('web-jitter').value = String(settings.webJitter);
    if (typeof settings.webPictures === 'boolean') webState.pictures = settings.webPictures;
    if (Array.isArray(settings.webQueue)) { webQueue = settings.webQueue; paintQueue(); }
    if (Number.isFinite(settings.webListDelay)) el('web-list-delay').value = String(settings.webListDelay);
    if (Number.isFinite(settings.webListJitter)) el('web-list-jitter').value = String(settings.webListJitter);
    paintWebRange();
    paintWebListRange();
    renderWeb();
  }).catch(() => {});
  el('web-delay').addEventListener('change', () => {
    const value = webDelay();
    el('web-delay').value = String(value);
    store.saveSettings({ webDelay: value });
    paintWebRange();
  });
  el('web-delay').addEventListener('input', paintWebRange);
  el('web-jitter').addEventListener('change', () => {
    const value = webJitter();
    el('web-jitter').value = String(value);
    store.saveSettings({ webJitter: value });
    paintWebRange();
  });
  el('web-jitter').addEventListener('input', paintWebRange);
  el('web-list-delay').addEventListener('change', () => {
    const value = webListDelay();
    el('web-list-delay').value = String(value);
    store.saveSettings({ webListDelay: value });
    paintWebListRange();
  });
  el('web-list-delay').addEventListener('input', paintWebListRange);
  el('web-list-jitter').addEventListener('change', () => {
    const value = webListJitter();
    el('web-list-jitter').value = String(value);
    store.saveSettings({ webListJitter: value });
    paintWebListRange();
  });
  el('web-list-jitter').addEventListener('input', paintWebListRange);
  el('web-clear').onclick = clearWeb;
  el('web-paste').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { el('web-address').value = text.trim(); return; }
    } catch {
      // Not allowed here: the box takes a paste the ordinary way.
    }
    el('web-address').focus();
    toast('Hold in the box and choose Paste');
  };
  el('web-address').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findWebLinks(); }
  });
  el('web-title').addEventListener('input', () => {
    webState.titleTouched = true;
    renderWeb();
  });
  el('web-filter').addEventListener('input', filterWebList);

  el('web-likely').onclick = () => {
    for (const link of webState.links) link.picked = link.likely;
    repaintWebRows();
  };
  el('web-all').onclick = () => { for (const link of shownWebLinks()) link.picked = true; repaintWebRows(); };
  el('web-none').onclick = () => { for (const link of shownWebLinks()) link.picked = false; repaintWebRows(); };
  el('web-menus').onclick = () => {
    for (const link of webState.links) if (link.chrome || link.kind === 'asset') link.picked = false;
    repaintWebRows();
  };
  el('web-reverse').onclick = () => {
    webState.links.reverse();
    webState.reversed = !webState.reversed;
    webState.manualOrder = true;
    drawWebList();
  };
  /* Remembered, for every site: on many sites every picture on a chapter
   * page is an advert, and downloading them is the larger part of the
   * book -- hundreds of megabytes of them, for a book of text. */
  el('web-pictures').onclick = () => {
    webState.pictures = !webState.pictures;
    store.saveSettings({ webPictures: webState.pictures }).catch(() => {});
    renderWeb();
    toast(webState.pictures
      ? 'Pictures on — the pictures on each page are downloaded too'
      : 'Pictures off — text only, from every site, until you turn them on again');
  };

  /* A tap ticks one; a hold and a drag ticks a run.
   *
   * Hold a link until it changes, then drag up or down: every link the
   * finger passes over is set the way the first one went, and dragging back
   * puts them as they were. A contents page of five hundred chapters with
   * the menus above and "other novels" below is two drags, not five hundred
   * taps. Near the top or bottom of the screen the list scrolls on by
   * itself. */
  const list = el('web-list');
  const scroller = el('web-body');
  const rowAt = (target) => target?.closest?.('.web-link');
  let holdTimer = null;
  let heldAt = 0;
  let startX = 0;
  let startY = 0;
  let paint = null;   // { value, rows, from, was: Map(at -> picked), x, y }
  let creep = null;

  const paintTo = (row) => {
    const to = paint.rows.indexOf(row);
    if (to < 0) return;
    const [low, high] = paint.from < to ? [paint.from, to] : [to, paint.from];
    paint.rows.forEach((each, pos) => {
      const at = Number(each.dataset.at);
      const want = pos >= low && pos <= high ? paint.value : paint.was.get(at);
      if (webState.links[at].picked !== want) {
        webState.links[at].picked = want;
        paintWebRow(each, webState.links[at]);
      }
    });
    paintWebCount();
  };
  const rowUnder = () => {
    const hit = document.elementFromPoint(paint.x, paint.y);
    return rowAt(hit) && list.contains(rowAt(hit)) ? rowAt(hit) : null;
  };
  const stopCreep = () => { if (creep) cancelAnimationFrame(creep); creep = null; };
  const creepOn = () => {
    creep = null;
    if (!paint) return;
    const box = scroller.getBoundingClientRect();
    const edge = 72;
    let by = 0;
    if (paint.y < box.top + edge) by = -Math.ceil((box.top + edge - paint.y) / 6);
    else if (paint.y > box.bottom - edge) by = Math.ceil((paint.y - (box.bottom - edge)) / 6);
    if (by) {
      scroller.scrollTop += by;
      const row = rowUnder();
      if (row) paintTo(row);
      creep = requestAnimationFrame(creepOn);
    }
  };
  const endPaint = () => {
    stopCreep();
    if (!paint) return;
    list.classList.remove('painting');
    paint = null;
    heldAt = Date.now();
  };

  list.addEventListener('touchstart', (e) => {
    const row = rowAt(e.target);
    if (!row || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const rows = [...list.children].filter((each) => !each.hidden);
      const at = Number(row.dataset.at);
      paint = {
        value: !webState.links[at].picked,
        rows,
        from: rows.indexOf(row),
        was: new Map(rows.map((each) => [Number(each.dataset.at), !!webState.links[Number(each.dataset.at)].picked])),
        x: startX,
        y: startY,
      };
      list.classList.add('painting');
      paintTo(row);
    }, 380);
  }, { passive: true });

  // Not passive: once a drag is ticking links, it must not also scroll.
  list.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    if (holdTimer && (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10)) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (!paint) return;
    if (e.cancelable) e.preventDefault();
    paint.x = touch.clientX;
    paint.y = touch.clientY;
    const row = rowUnder();
    if (row) paintTo(row);
    if (!creep) creep = requestAnimationFrame(creepOn);
  }, { passive: false });

  const lift = (e) => {
    clearTimeout(holdTimer);
    holdTimer = null;
    const painted = !!paint;
    endPaint();
    // The lift that ends a drag is not also a tap on the row under it.
    if (painted && e.cancelable) e.preventDefault();
  };
  list.addEventListener('touchend', lift);
  list.addEventListener('touchcancel', lift);
  // The system's own long press -- a menu, a text selection -- is this one's.
  list.addEventListener('contextmenu', (e) => { if (rowAt(e.target)) e.preventDefault(); });

  list.addEventListener('click', (e) => {
    const row = rowAt(e.target);
    if (!row) return;
    // The lift that ended a drag is already swallowed; this is only for a
    // browser that sends the click anyway.
    if (Date.now() - heldAt < 300) return;
    const link = webState.links[Number(row.dataset.at)];
    link.picked = !link.picked;
    paintWebRow(row, link);
    paintWebCount();
  });

  // Reached from Build, and only from there: what is chosen becomes a part.
  el('build-web').onclick = () => show('web');
  el('build-from-shelf').onclick = () => { pickNext = true; show('library'); };
}

/* ── global wiring ────────────────────────────────────────────────────── */

/* The three tab screens sit in a row you can swipe between, in the order the
 * bar shows them. The reader is deliberately not in this set: a horizontal
 * swipe there already means turn the page. */
const TABS = ['library', 'folders', 'workshop', 'bin', 'sort', 'stats', 'settings'];

/** Whether a sideways drag starting here is the element's own: text being
 *  edited or scrolled through, or a row with more in it sideways. */
function swipesItself(target) {
  for (let node = target; node && node.nodeType === 1 && node.id !== 'screens'; node = node.parentElement) {
    if (node.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

function wireSwipeBetweenTabs() {
  let startX = 0, startY = 0, startAt = 0, tracking = false;

  document.getElementById('screens').addEventListener('touchstart', (e) => {
    // A touchstart with no touch list is not a swipe. It should not be
    // possible, and it threw here rather than being ignored -- one stray
    // event of the wrong shape and the whole gesture layer stops working for
    // the rest of the session.
    if (!TABS.includes(current) || e.touches?.length !== 1) { tracking = false; return; }
    // A drag that belongs to what it starts on: along a long title in a
    // text box (to see the rest of it), or along a row that scrolls
    // sideways of its own accord.
    if (swipesItself(e.target)) { tracking = false; return; }
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startAt = Date.now();
  }, { passive: true });

  document.getElementById('screens').addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const went = e.changedTouches?.[0];
    if (!went) return;
    const dx = went.clientX - startX;
    const dy = went.clientY - startY;

    // Strict on purpose, and stricter than it was: a shelf is a tall scrolling
    // grid, and a flick down with any lean to it was changing screens.
    //   - long: 110px, not 70
    //   - almost flat: under 45px of vertical drift in absolute terms, as well
    //     as a 3:1 ratio, so a fast diagonal cannot pass on ratio alone
    //   - quick: still under half a second
    if (Date.now() - startAt > 450) return;
    if (Math.abs(dx) < 110) return;
    if (Math.abs(dy) > 45 || Math.abs(dx) < Math.abs(dy) * 3) return;

    const index = TABS.indexOf(current);
    const next = TABS[index + (dx < 0 ? 1 : -1)];
    // The ends do not wrap. Wrapping from the last screen back to the first
    // makes it impossible to tell where you are by swiping.
    if (next) show(next, { replace: true });
  }, { passive: true });
}

/* Shelf, tapped twice: back to the top of it.
 *
 * A long shelf is a long way down, and the tab that leads to it is the
 * obvious thing to press to get back -- as it is in most apps. A second tap
 * soon after the first goes to the shelf and up to its first row. */
let shelfTapAt = 0;
function shelfTapped() {
  const now = Date.now();
  if (now - shelfTapAt > 400) { shelfTapAt = now; return; }
  shelfTapAt = 0;
  const scroller = el('shelf-scroll');
  if (!scroller) return;
  const reduce = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  else scroller.scrollTop = 0;
}

function wireChrome() {
  document.addEventListener('click', (event) => {
    /* A named screen, and only a named screen.
     *
     * An empty data-go used to reach here and navigate to nothing, which
     * switched the current screen off and left the app blank. The selector
     * excludes it and the guard below covers anything else that ever carries
     * the attribute without a value -- a blank page is the worst failure this
     * app has, and it should not be one typo away. */
    const go = event.target.closest('[data-go]:not([data-go=""])');
    if (go) {
      const name = go.dataset.go;
      if (name && screenNode(name)) {
        show(name, { replace: TABS.includes(name) });
        if (name === 'library' && go.closest('#tabbar')) shelfTapped();
      }
      return;
    }
    if (event.target.closest('[data-back]')) { back(); return; }
    if (event.target.closest('[data-import]')) { pickFiles(); }
  });

  el('file-input').addEventListener('change', async (event) => {
    const input = event.target;
    const files = [...input.files];
    /* Cleared after the import, not before it.
     *
     * Clearing the input is what lets the same file be picked twice in a row,
     * and it also drops the input's own hold on what was picked. The File
     * objects are supposed to outlive that, and in a WebView reading one
     * afterwards is exactly the kind of thing that comes back refused -- so
     * the hold is kept until there is nothing left to read. */
    try {
      await handleFiles(files);
    } finally {
      input.value = '';
    }
  });

  el('density-btn').onclick = async () => {
    const settings = await store.settings();
    const next = settings.columns >= 4 ? 2 : settings.columns + 1;
    await store.saveSettings({ columns: next });
    refreshShelf();
  };

  el('translate-pill').onclick = () => show('language');

  el('sort-apply').onclick = async () => { await screens.applySort(); back(); refreshShelf(); };
  el('sort-save').onclick = async () => {
    const name = await screens.saveAsView();
    if (name) toast(`Saved “${name}”`);
  };

  el('layout-reset').onclick = async () => {
    if (!reader.state.book) return;
    const layout = await store.resetLayout(reader.state.book.id);
    reader.applyLayout(layout);
    reader.repaginate();
    screens.openLayout(reader.state.book.id);
    toast('Back to the app default');
  };
  el('layout-default').onclick = async () => {
    if (!reader.state.book) return;
    // Set as the default for every book without its own override.
    const layout = await store.layoutFor(reader.state.book.id);
    await store.put('layout', { bookId: 0, value: layout });
    toast('Saved as the app default');
  };

  el('toc-rebuild').onclick = () => {
    // Re-derives page numbers, which is what changes after a layout override.
    reader.repaginate();
    screens.openToc(goToChapter);
    toast('Index rebuilt');
  };

  panels.onThemeChange(() => { if (reader.state.book) reader.repaginate(); });
}

/* ── the shell's two hooks ────────────────────────────────────────────── */

/**
 * A name the importer can work out a format from.
 *
 * Some providers hand over a name with no extension at all. The first bytes
 * say what the file is well enough to get it as far as the parser, which will
 * give a proper reason if it turns out to be something else. Only those bytes
 * are read, not the file.
 */
/* ── writing files out ────────────────────────────────────────────────────
 *
 * A file is sent to the native side a few megabytes at a time.
 *
 * Handing it over in one piece means holding the whole thing three times over
 * -- the bytes, the base64, and what Java decodes back out -- which is what
 * killed the app when files came the other way. A book can be hundreds of
 * megabytes, so it goes in pieces.
 */

const EXPORT_CHUNK = 3 * 1024 * 1024;

/** Bytes to base64, in pieces: String.fromCharCode on a whole chunk at once
 *  overflows the argument list. */
function base64Of(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

async function writeOut(blob, name, mimeType, { share = false, toPictures = false, onProgress } = {}) {
  const startedReading = inBook;
  const bridge = window.GrimoireNative;
  if (!bridge?.beginExport) {
    // In an ordinary browser there is no native side; fall back to the
    // download the browser already knows how to do.
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }

  const handle = bridge.beginExport(name);
  if (!handle) throw new Error('There was nowhere to write the file');

  for (let at = 0; at < blob.size; at += EXPORT_CHUNK) {
    const piece = blob.slice(at, Math.min(at + EXPORT_CHUNK, blob.size));
    // Not piece.arrayBuffer(): older WebViews do not have it.
    const bytes = new Uint8Array(await blobs.readArrayBuffer(piece));
    if (!bridge.appendExport(handle, base64Of(bytes))) {
      throw new Error('The file could not be written');
    }
    onProgress?.(Math.min(1, (at + EXPORT_CHUNK) / blob.size));
    // Yields, so the progress bar paints and the app answers taps.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Android's save screen, not over a page being read.
  await untilNotReading(startedReading);
  // Straight into the phone's pictures, where the gallery shows it. A shell
  // from before this existed asks where to put it instead.
  if (toPictures && bridge.saveToPictures) bridge.saveToPictures(handle, mimeType);
  else bridge.finishExport(handle, mimeType, share);
  return true;
}

/**
 * What to do with a picture that was held down.
 *
 * Saving into Pictures is the one most people want, so it comes first and
 * needs no more choosing; "Save as" is for putting it somewhere particular,
 * and Share hands the picture itself to another app.
 */
async function offerPicture(blob, { title = '', href = '' } = {}) {
  if (!blob) return toast('That picture has not loaded yet');
  const type = await pictureType(blob, href);
  const name = pictureName(title, href, type);
  const typed = blob.type === type ? blob : blob.slice(0, blob.size, type);

  const sheet = el('picture-sheet');
  const urls = blobs.pool();
  const url = urls.url(typed);
  el('picture-preview').innerHTML = url ? `<img src="${url}" alt="">` : '';
  const size = blob.size >= 1048576
    ? `${(blob.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
  el('picture-name').textContent = `${name} · ${size}`;

  const list = el('picture-list');
  list.innerHTML = '';
  const native = !!window.GrimoireNative?.beginExport;
  const close = () => { sheet.hidden = true; el('picture-preview').innerHTML = ''; urls.release(); };
  const choice = (text, note, how) => {
    const button = document.createElement('button');
    button.innerHTML = `<span>${escapeText(text)}</span><span>${escapeText(note)}</span>`;
    button.onclick = async () => {
      close();
      try {
        await writeOut(typed, name, type, how);
        if (!native) toast(`Downloaded ${name}`, 4000);
      } catch (error) {
        toast(error.message || 'That picture could not be saved', 6000, { kind: 'failed' });
      }
    };
    list.appendChild(button);
  };

  if (native) {
    choice('Save to Pictures', 'Into Pictures/Quire, where the gallery finds it', { toPictures: true });
    choice('Save as…', 'Choose the folder and name', {});
    choice('Share', 'Send the picture to another app', { share: true });
  } else {
    choice('Download', 'Save the picture', {});
  }
  el('picture-cancel').onclick = close;
  sheet.hidden = false;
}

window.Grimoire = {
  /** Called from Java once a file has been written where it was asked for. */
  exportSaved(name) { toast(`Saved ${name}`, 5000); },
  /** Called from Java once a picture is in the phone's Pictures folder. */
  pictureSaved(name) { toast(`Saved to Pictures/Quire — ${name}`, 5000, { kind: 'done' }); },

  /* Something the shell needs to say, said once the page can say it.
   *
   * Used when the render process has died and the view has been rebuilt: the
   * app comes back on the shelf, and without a word about it that reads as
   * the app having thrown away whatever was being read. */
  notice(message) { toast(message, 8000); },
  exportFailed(reason) { toast(reason || 'That file could not be saved', 6000); },


  /** Called from Java to settle an async bridge call. Not a reader API. */
  settle: translate.settle,
  settleFile,
  /** Called from Java when a page asked for has been downloaded. */
  settleWeb: web.settleWeb,
  /** Called from Java with Android's answer to "may Grimoire notify?". */
  notifyAnswer: (allowed) => answerNotify(allowed),
  /** Called from Java when a picture has been read for its text. */
  settleOcr: ocr.settleOcr,

  /** Return true to swallow the back gesture. */
  onBack() {
    if (frames.closeFrameEditor()) return true;
    // Above everything else, so it is the first thing back leaves.
    if (!el('redact').hidden) {
      if (!el('redact-leave').hidden) el('redact-leave').hidden = true;
      else if (!el('redact-text').hidden) finishText();
      else leaveRedact();
      return true;
    }
    if (!el('redact-pick').hidden) { closeRedactPick(); return true; }
    if (!el('remove-look').hidden) { closeRemoveLook(); return true; }
    if (!el('remove-confirm').hidden) { el('remove-confirm').hidden = true; return true; }
    if (closeCopyMenu()) return true;
    // Picking for Build is a mode, and back leaves it -- to the build.
    if (buildPicks) { endPicking(); show('workshop'); return true; }
    if (closeGlossary()) return true;
    if (closeCoverPick()) return true;
    if (tags.closeTagPicker()) return true;
    if (!el('ocr-sheet').hidden) { closeOcr(); return true; }
    if (!el('picture-sheet').hidden) { el('picture-sheet').hidden = true; return true; }
    if (!el('folder-actions').hidden) { el('folder-actions').hidden = true; return true; }
    if (!el('export-sheet').hidden) { el('export-sheet').hidden = true; return true; }
    if (!el('merge-sheet').hidden) { el('merge-sheet').hidden = true; return true; }
    if (!el('bundle-sheet').hidden) { el('bundle-sheet').hidden = true; return true; }
    if (!el('confirm-bar').hidden) { el('confirm-bar').hidden = true; resetConfirm(); return true; }
    // Selection is a mode, and back should leave a mode before leaving a
    // screen -- otherwise deselecting means backing out of the library.
    if (clearSelection()) return true;
    if (document.querySelector('.viewer')) {
      document.querySelector('.viewer').remove();
      return true;
    }
    return back();
  },

  /** A book tapped in a file manager or sent from a share sheet. */
  /**
   * A file handed over from elsewhere on the phone.
   *
   * Read, not collected. It is opened straight away and never appears on the
   * shelf; closing the reader forgets it. "Keep in library" is there for when
   * it turns out to be worth keeping, which is the right way round -- opening
   * something to look at it should not quietly add it to a library.
   */
  /** The staging step could not even copy the file. */
  handoffFailed(reason) {
    toast(reason || 'That file could not be read', 8000);
  },

  /**
   * A file handed over from elsewhere on the phone.
   *
   * It arrives as a URL rather than as its bytes. Passing it through the
   * JavaScript bridge as base64 meant holding the whole thing three times
   * over — the bytes, the string built from them, and the array decoded back
   * out of it — which is why anything of a normal size for this library was
   * refused, and why it killed the app before that.
   *
   * Read, not collected: it is opened straight away and never joins the
   * shelf. "Keep in library" is there for when it turns out to be worth
   * keeping, which is the right way round.
   */
  async openExternalBook(url, name) {
    toast('Opening…', 2000);

    let file;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`the file could not be fetched (${response.status})`);
      const blob = await response.blob();
      file = new File([blob], await nameWithFormat(name || 'book', blob));
    } catch (error) {
      return toast(error.message || 'That file could not be read', 8000);
    }

    const results = await handleFiles([file], { transient: true });
    // The copy has served its purpose either way.
    window.GrimoireNative?.clearHandoff?.();

    // Already on the shelf: that copy is the one to open.
    if (!results?.added && results?.existing?.length) {
      const kept = await store.get('books', results.existing[0]);
      if (kept && !kept.inVault) return openBook(kept);
    }

    if (!results?.added) {
      // Never silent: this is the point at which the app had simply done
      // nothing, with no way to tell whether it had even received the file.
      const why = results?.failed?.[0]?.reason;
      return toast(why ? `${name}: ${why}` : `${name} could not be opened`, 8000);
    }

    const passing = (await store.all('books'))
      .filter((b) => b.transient)
      .sort((a, b) => b.addedAt - a.addedAt)[0];
    if (passing) openBook(passing);
  },
};

/* ── boot ─────────────────────────────────────────────────────────────── */

async function boot() {
  const settings = await store.settings();
  theme.apply(settings);
  reader.setPictureFrame(settings.pictureFrame || null);
  activeFolder = settings.shelfFolder ?? null;
  /* A hidden folder left open is not what the app opens on next time:
   * hiding it would mean little if the shelf came back up showing it. */
  if (activeFolder && library.hiddenBy(activeFolder, library.hiddenFolderList(settings))) {
    activeFolder = null;
    await store.saveSettings({ shelfFolder: null });
  }
  // A build cut off by the app closing is a book of what had come, and the
  // rest is kept to carry it on; anything else a crash left half-written is
  // cleared before the shelf is drawn.
  const rescued = await rescueCutBuilds().catch(() => []);
  await library.sweepUnfinishedImports();
  // Books left unread for days go On hold before the shelf shows them.
  const held = await library.holdQuietBooks().catch(() => 0);
  // Locked only if a passphrase exists to unlock it with.
  await library.initVaultGate();
  reader.setChrome('full');

  wireChrome();
  wireReader();
  wireSwipeBetweenTabs();
  wireSelection();
  wireAnnotations();
  wireDesk();
  wireWorkshop();
  wireWeb();
  wireDivide();
  wireRemove();
  wireRedact();
  wireGlossary();
  wireBin();
  wireChapterPad();
  paintChapterPad(settings);
  screens.onLongPressBook(openBookMenu);
  refreshGuides();

  /* If the app died last time, say so.
   *
   * A crash takes the process with it, so from the outside the app simply
   * goes away and whatever launched it comes back -- indistinguishable from
   * it refusing to do anything. The reason is kept and reported here. */
  if (rescued.length) {
    const { book, left } = rescued[0];
    toast(`A build was cut off when the app closed. “${book.title}” is on the shelf with the ${book.chapters} chapter${book.chapters === 1 ? '' : 's'} that had come; the rest is in Build — Carry on picks up from there.`, 12000);
    // Overnight: carried on, as any build that stopped is.
    if (settings.buildOvernight === true && left) {
      overnight = true;
      night.made.add(book.id);
      scheduleOvernight(() => carryOnLeftover(left), 'the app was closed', left.links[0]?.url || '');
    }
  }
  const crash = window.GrimoireNative?.lastCrash?.();
  if (crash) {
    await store.saveSettings({ lastCrash: crash });
    const line = crash.split('\n').find((l) => /Exception|Error/.test(l)) || 'an error';
    toast(`The app stopped unexpectedly last time: ${line.trim().slice(0, 90)}`, 10000);
  }

  // Anything handed to the app from elsewhere has been waiting for this.
  window.GrimoireNative?.ready?.();
  panels.onSettingsChange(() => panels.openSettings(refreshShelf));
  panels.onGuides(refreshGuides);
  panels.onWrite((blob, name, type, opts) => writeOut(blob, name, type, opts));
  panels.onFolderMenu(openFolderActions);


  await refreshShelf();
  heldNote(held, settings.autoHoldDays ?? 5);


  // Re-flow when the window changes shape: rotation, keyboard, the insets
  // MainActivity pushes in. The anchor is preserved, so nobody loses a page.
  let resizeTimer = null;
  const reflow = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (reader.state.book) reader.repaginate(); }, 120);
  };
  window.addEventListener('resize', reflow);
  window.addEventListener('grimoire:insets', reflow);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    const now = await store.settings();
    if (now.themeMode === 'system') { theme.apply(now); reflow(); }
  });

  // The vault re-locks whenever the app leaves the foreground, and the
  // position is flushed so being killed costs at most one page.
  document.addEventListener('visibilitychange', () => {
    // Back after days away: what went quiet meanwhile goes On hold.
    if (document.visibilityState === 'visible') { putQuietOnHold(); return; }
    if (document.visibilityState !== 'hidden') return;
    reader.pauseSession();
    if (library.vaultUnlocked) { library.setVaultUnlocked(false); refreshShelf(); }
  });
  window.addEventListener('pagehide', () => { reader.endSession(); reader.releaseImages(); });
}

boot();
