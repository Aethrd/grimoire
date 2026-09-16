/* App shell: routing, gestures, and the two hooks MainActivity calls. */

import * as store from './store.js';
import * as theme from './theme.js';
import * as reader from './reader.js';
import * as library from './library.js';
import * as screens from './screens.js';
import * as panels from './panels.js';
import { nameWithFormat, chapterHtml } from './parse.js';
import * as build from './build.js';
import * as epub from './epub.js';
import * as translate from './translate.js';
import * as blobs from './blobs.js';

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

async function show(name, { replace = false } = {}) {
  if (name === current) return;

  // Leaving the reader ends the session, so the log never counts the time
  // someone spent on the stats page as reading.
  // Await it: the stats screen reads the log the moment it opens, and an
  // unawaited flush would land just after it had rendered the old numbers.
  if (current === 'divide' && name !== 'divide') dividePages.release();

  if (current === 'reader' && name !== 'reader') {
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
  // The tab bar is app furniture; it has no business over a page of prose.
  document.body.dataset.view = name;
  el('tabbar').hidden = name === 'reader' || selecting();
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
    case 'divide': return renderDivide();
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
    case 'stats': return panels.openStats();
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
  screenNode(current)?.removeAttribute('data-active');
  screenNode(target)?.setAttribute('data-active', '');
  const previous = current;
  current = target;
  document.body.dataset.view = target;
  if (previous === 'reader') reader.pauseSession();   // back() is sync; the
  // stats screen re-reads on every open, so a late arrival still shows up.
  el('tabbar').hidden = target === 'reader';
  enter(target);
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
const BESIDE_THE_BOOK = new Set(['toc', 'reel', 'find', 'layout', 'settings', 'marks']);

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

async function refreshShelf() {
  await library.renderShelf({
    onOpen: onTileTap, onLongPress: onTileHold, selection,
    selecting: selectMode, folder: activeFolder,
    onNotice: (message) => toast(message, 6000),
    onClearFolder: () => openFolder(null),
  });
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
  await show('reader');
  try {
    // Opened, not read. Continue follows this; the status does not, because
    // glancing at a book is not reading it.
    book.lastOpenedAt = Date.now();
    await store.put('books', book);
    await reader.open(book.id, opts);
    paintReader();
    if ((await store.settings()).keepScreenOn) window.GrimoireNative?.keepScreenOn?.(true);
  } catch (error) {
    toast(error.message);
    back();
  }
}

/* ── selection ────────────────────────────────────────────────────────────
 * Long press starts it; tapping adds and removes. Actions are buttons in a
 * bar, because choosing the books and then describing what to do with them in
 * words was the wrong way round.
 */

const selection = new Set();
let selectMode = false;

function selecting() { return selectMode; }

function onTileTap(book) {
  if (!selectMode) {
    // A bundle is one thing on the shelf and several things to open, so it
    // asks which rather than guessing.
    if (book.bundle) return openBundleSheet(book.bundle);
    return openBook(book);
  }
  if (selection.has(book.id)) selection.delete(book.id);
  else selection.add(book.id);
  // Deliberately stays in the mode at zero: dropping out because you
  // deselected the last one loses your place in a long shelf.
  paintSelection();
  refreshShelf();
}

function onTileHold(book) {
  selectMode = true;
  selection.add(book.id);
  paintSelection();
  refreshShelf();
}

function paintSelection() {
  const on = selectMode;
  const count = selection.size;

  el('select-head').hidden = !on;
  el('library-head').hidden = on;
  el('select-actions').hidden = !on;
  el('tabbar').hidden = on || current === 'reader';
  if (!on) el('confirm-bar').hidden = true;

  el('select-count').textContent = count === 0
    ? 'Select books'
    : `${count} selected`;

  // Actions that only make sense for one book, or for any book at all.
  for (const button of el('select-actions').children) {
    const act = button.dataset.act;
    const single = act === 'open' || act === 'details';
    button.disabled = single ? count !== 1 : count === 0;
  }
}

function clearSelection() {
  if (!selectMode) return false;
  selectMode = false;
  selection.clear();
  paintSelection();
  refreshShelf();
  return true;
}

async function selectedBooks() {
  const books = await store.all('books');
  return books.filter((b) => selection.has(b.id));
}

function wireSelection() {
  el('select-cancel').onclick = () => clearSelection();

  el('select-all').onclick = async () => {
    /* Everything on the shelf as it stands, not everything you own.
     *
     * Filtered to a folder, "select all" that reaches past the filter is a
     * trap: what it selects is not what is in front of you, and the next
     * thing pressed -- move, delete -- happens to books you cannot see.
     */
    const books = (await store.all('books')).filter((book) =>
      (!book.inVault || library.vaultUnlocked)
      && !book.importing && !book.transient
      && (!activeFolder || book.folder === activeFolder));

    // A second press clears, so the same button undoes itself.
    const all = books.every((book) => selection.has(book.id));
    if (all) for (const book of books) selection.delete(book.id);
    else for (const book of books) selection.add(book.id);

    paintSelection();
    refreshShelf();
  };

  const actions = {
    open: async () => {
      const [book] = await selectedBooks();
      if (!book) return;
      clearSelection();
      openBook(book);
    },

    folder: () => openFolderSheet(),

    /* Writing a book out is a thing you do to a book, so it belongs with the
       other things you do to a book. It was only inside the details sheet,
       which is a long press and a scroll away -- far enough that it may as
       well not have been there. */
    export: async () => {
      const books = await selectedBooks();
      if (!books.length) return;
      if (books.length === 1) return askAboutExport(books[0]);
      return exportMany(books);
    },

    details: async () => {
      const [book] = await selectedBooks();
      if (book) openDetails(book);
    },

    status: () => openStatusSheet(),

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
    merge: async () => {
      const books = await selectedBooks();
      if (books.length !== 1) return toast('Choose one book to take apart');
      const [book] = books;

      /* A book that was built can be taken apart two different ways, and
       * choosing for the reader was wrong: it went straight to undoing the
       * join, so a built comic could never be divided at all. */
      if (library.wasJoined(book) || book.builtFrom) return offerTakeApart(book);
      return openDivide(book);
    },

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
        return toast(`${all.length} editions taken out of ${ids.size === 1 ? 'their bundle' : 'their bundles'}`);
      }

      if (books.length < 2) return toast('Select two or more books to bundle them');

      // The first by the shelf's own order leads, so the bundle keeps the
      // cover and title you were already looking at.
      const leader = books[0];
      for (const book of books) { book.bundleId = leader.id; await store.put('books', book); }
      clearSelection();
      toast(`${books.length} editions bundled under “${leader.title}”`);
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

    delete: () => {
      el('confirm-text').textContent =
        `Delete ${selection.size} book${selection.size === 1 ? '' : 's'}?`;
      el('confirm-bar').hidden = false;
    },
  };

  for (const button of el('select-actions').children) {
    button.onclick = () => actions[button.dataset.act]?.();
  }

  el('confirm-no').onclick = () => { el('confirm-bar').hidden = true; };
  el('confirm-yes').onclick = async () => {
    const ids = [...selection];
    el('confirm-bar').hidden = true;
    for (const id of ids) await store.deleteBook(id);
    clearSelection();
    toast(`${ids.length} book${ids.length === 1 ? '' : 's'} removed`);
  };

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

  el('status-cancel').onclick = () => { el('status-sheet').hidden = true; };
  el('status-sheet').onclick = (e) => {
    if (e.target === el('status-sheet')) el('status-sheet').hidden = true;
  };

  el('folder-cancel').onclick = () => { el('folder-sheet').hidden = true; };
  el('folder-sheet').onclick = (e) => {
    // Dismiss on the scrim, not on the sheet itself.
    if (e.target === el('folder-sheet')) el('folder-sheet').hidden = true;
  };
  el('folder-create').onclick = () => moveTo(el('folder-new').value.trim());
}

async function openDetails(book) {
  const body = el('details-body');
  const urls = blobs.pool();
  const coverUrl = urls.url(book.coverBlob);

  body.innerHTML = `
    <p class="eyebrow">Book details</p>
    <div class="details-head">
      <span class="details-cover" id="details-cover">
        ${coverUrl ? `<img src="${coverUrl}" alt="">` : ''}
      </span>
      <span class="col">
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

  const statusField = document.createElement('div');
  statusField.className = 'field';
  statusField.innerHTML = `<label><span>Status</span><span class="muted">${
    library.statusIsPinned(book) ? 'set by hand' : 'from your reading'}</span></label>`;
  const statusChips = document.createElement('div');
  statusChips.className = 'chip-row wrap';
  let pickedStatus;   // undefined = leave as it is
  for (const [value, label] of [...library.STATUSES, [null, 'Automatic']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    const active = value === null
      ? !library.statusIsPinned(book)
      : library.statusOf(book) === value && library.statusIsPinned(book);
    chip.setAttribute('aria-pressed', String(active));
    chip.onclick = () => {
      pickedStatus = value;
      for (const other of statusChips.children) other.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
    };
    statusChips.appendChild(chip);
  }
  statusField.appendChild(statusChips);
  body.appendChild(statusField);

  const fields = [
    ['title', 'Title', book.title || ''],
    ['author', 'Author', book.author || ''],
    ['series', 'Series', book.series || ''],
    ['seriesIndex', 'Series number', book.seriesIndex ?? ''],
    ['folder', 'Folder', book.folder || ''],
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
    if (pickedStatus !== undefined) {
      if (pickedStatus === null) delete book.status;
      else book.status = pickedStatus;
    }

    await store.put('books', book);
    // Titles were translated from the old text, so that cache is now wrong.
    await translate.clearCache(book.id).catch(() => {});
    close();
    clearSelection();
    toast('Details saved');
  };

  el('details-sheet').hidden = false;
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
function openBundleSheet(members) {
  const list = el('bundle-list');
  list.innerHTML = '';

  for (const book of members) {
    const row = document.createElement('button');
    // Language and format are what actually tell two editions apart.
    const marks = [book.lang ? book.lang.toUpperCase() : null, book.format]
      .filter(Boolean).join(' · ');
    row.innerHTML = `<span>${escapeText(library.displayTitle(book))}</span>`
      + `<span>${escapeText(marks)}</span>`;
    row.onclick = () => { el('bundle-sheet').hidden = true; openBook(book); };
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

  sheet.hidden = false;
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
  const panel = el('import-progress');
  el('import-label').textContent = `Writing ${books.length} books`;
  panel.hidden = false;

  const bundle = new JSZip();
  const failed = [];

  try {
    for (const [at, book] of books.entries()) {
      el('import-count').textContent = `${at + 1} of ${books.length}`;
      el('import-label').textContent = `Writing ${library.displayTitle(book)}`;
      try {
        const { blob, name } = await epub.buildEpub(book.id, {
          onProgress: (fraction) => {
            const done = (at + fraction) / books.length;
            el('import-bar').style.width = `${Math.round(done * 90)}%`;
          },
        });
        // Two books of the same name would otherwise replace each other.
        let entry = name;
        let n = 2;
        while (bundle.file(entry)) entry = name.replace(/\.epub$/i, ` (${n++}).epub`);
        bundle.file(entry, blob);
      } catch (error) {
        // One book that will not write costs that book, not the batch.
        failed.push({ title: library.displayTitle(book), reason: error.message });
      }
    }

    if (!bundle.file(/.*/).length) {
      throw new Error(failed[0] ? `${failed[0].title}: ${failed[0].reason}` : 'Nothing could be written');
    }

    const archive = await bundle.generateAsync({ type: 'blob', mimeType: 'application/zip' });
    await writeOut(archive, `${epub.safeName(commonTitle(books.map((b) => b.title)) || 'Books')}.zip`,
      'application/zip', {
        onProgress: (fraction) => {
          el('import-bar').style.width = `${90 + Math.round(fraction * 10)}%`;
        },
      });

    clearSelection();
    await refreshShelf();
    toast(failed.length
      ? `${books.length - failed.length} written · ${failed.length} skipped — ${failed[0].title}: ${failed[0].reason}`
      : `${books.length} books written out`, 7000);
  } catch (error) {
    toast(error.message || 'Those books could not be written out', 6000);
  } finally {
    panel.hidden = true;
  }
}

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

  const go = (share) => () => {
    el('export-sheet').hidden = true;
    exportBook(book, {
      share,
      title: el('export-title').value.trim() || book.title,
      author: el('export-author').value.trim() || null,
      filename: el('export-file').value.trim(),
    });
  };
  el('export-save').onclick = go(false);
  el('export-send').onclick = go(true);
  el('export-sheet').hidden = false;
}

async function exportBook(book, { share = false, title, author, filename } = {}) {
  const panel = el('import-progress');
  el('import-label').textContent = `Writing ${book.title}`;
  el('import-count').textContent = '';
  panel.hidden = false;
  try {
    const { blob, name } = await epub.buildEpub(book.id, {
      title,
      author,
      onProgress: (fraction) => {
        el('import-bar').style.width = `${Math.round(fraction * 90)}%`;
      },
    });
    const saveAs = filename && /\.epub$/i.test(filename) ? filename : name;
    await writeOut(blob, saveAs, 'application/epub+zip', {
      share,
      onProgress: (fraction) => {
        el('import-bar').style.width = `${90 + Math.round(fraction * 10)}%`;
      },
    });
    if (share) toast(`${saveAs} ready to send`, 5000);
  } catch (error) {
    toast(error.message || 'That book could not be written out', 6000);
  } finally {
    panel.hidden = true;
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
    const panel = el('import-progress');
    panel.hidden = false;
    try {
      const made = await library.mergeBooks(ordered.map((b) => b.id), {
        title: el('merge-title').value.trim() || ordered[0].title,
        onProgress: (message, fraction) => {
          el('import-label').textContent = message;
          el('import-bar').style.width = `${Math.round(fraction * 100)}%`;
        },
      });
      clearSelection();
      await refreshShelf();
      toast(`Joined into “${made.title}” — ${made.chapters} chapters`, 6000);
    } catch (error) {
      toast(error.message || 'Those books could not be joined', 6000);
    } finally {
      panel.hidden = true;
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
    if (activeFolder === folder) await openFolder(null);
    await refreshShelf();
    await panels.openFolders(openFolder);
    toast(`${books.length} book${books.length === 1 ? '' : 's'} taken out of “${label}”`);
  });

  const remove = choice(`Delete all ${count}`, 'The books themselves, permanently', async () => {
    // Asked twice, because there is no undo and a folder can hold a lot.
    remove.innerHTML = `<span>Really delete ${count} book${count === 1 ? '' : 's'}?</span>`
      + '<span>Tap again</span>';
    remove.onclick = async () => {
      sheet.hidden = true;
      const books = (await store.all('books')).filter((b) => (b.folder || '') === folder);

      const panel = el('import-progress');
      el('import-label').textContent = `Deleting ${label}`;
      panel.hidden = false;
      try {
        for (const [at, book] of books.entries()) {
          await store.deleteBook(book.id);
          el('import-bar').style.width = `${Math.round(((at + 1) / books.length) * 100)}%`;
          el('import-count').textContent = `${at + 1} of ${books.length}`;
        }
      } finally {
        panel.hidden = true;
      }

      if (activeFolder === folder) await openFolder(null);
      await refreshShelf();
      await panels.openFolders(openFolder);
      toast(`${books.length} book${books.length === 1 ? '' : 's'} deleted`);
    };
  });
  remove.classList.add('danger');

  sheet.hidden = false;
}

async function openStatusSheet() {
  const books = await selectedBooks();
  if (!books.length) return;

  const list = el('status-list');
  list.innerHTML = '';

  const current = new Set(books.map((b) => library.statusOf(b)));
  const pinned = books.filter((b) => library.statusIsPinned(b)).length;

  for (const [value, label] of library.STATUSES) {
    const button = document.createElement('button');
    const shared = current.size === 1 && current.has(value);
    button.innerHTML = `<span>${label}</span><span>${shared ? '✓' : ''}</span>`;
    button.onclick = () => applyStatus(books, value);
    list.appendChild(button);
  }

  // Only offered when there is something to revert.
  if (pinned) {
    const revert = document.createElement('button');
    revert.innerHTML = `<span>Automatic</span><span>${pinned} set by hand</span>`;
    revert.onclick = () => applyStatus(books, null);
    list.appendChild(revert);
  }

  el('status-sheet').hidden = false;
}

async function applyStatus(books, status) {
  for (const book of books) {
    if (status === null) delete book.status;
    else book.status = status;

    // The dates stay coherent with the state, so a book marked finished by
    // hand behaves like one that was read to the end.
    if (status === 'finished') { book.finishedAt = book.finishedAt || Date.now(); book.percent = 1; }
    if (status === 'reading' || status === 'unread') book.finishedAt = null;
    if (status === 'unread') book.percent = 0;

    await store.put('books', book);
  }
  el('status-sheet').hidden = true;
  clearSelection();
  toast(status === null
    ? `${books.length} book${books.length === 1 ? '' : 's'} back to automatic`
    : `${books.length} marked ${library.STATUS_LABELS[status].toLowerCase()}`);
}

async function openFolderSheet() {
  const list = el('folder-list');
  list.innerHTML = '';
  el('folder-new').value = '';

  // Existing folders first, so the common case is one tap and no typing.
  const folders = await library.folderCounts();
  for (const [folder, count] of folders) {
    const button = document.createElement('button');
    button.innerHTML = `<span>${folder || 'Unfiled'}</span><span>${count}</span>`;
    button.onclick = () => moveTo(folder);
    list.appendChild(button);
  }
  if (!folders.some(([f]) => f === '')) {
    const button = document.createElement('button');
    button.innerHTML = '<span>Unfiled</span><span>—</span>';
    button.onclick = () => moveTo('');
    list.appendChild(button);
  }

  el('folder-sheet').hidden = false;
}

async function moveTo(folder) {
  const clean = String(folder || '').trim().replace(/^\/+|\/+$/g, '');
  const books = await selectedBooks();
  for (const book of books) {
    book.folder = clean;
    await store.put('books', book);
  }
  el('folder-sheet').hidden = true;
  const count = books.length;
  clearSelection();
  toast(clean
    ? `${count} book${count === 1 ? '' : 's'} moved to ${clean}`
    : `${count} book${count === 1 ? '' : 's'} unfiled`);
}

/* ── import ───────────────────────────────────────────────────────────── */

function pickFiles() {
  // The shell turns this into the system document picker, multi-select.
  el('file-input').click();
}

async function handleFiles(files, { transient = false } = {}) {
  if (!files.length) return;

  const panel = el('import-progress');
  panel.hidden = false;
  el('import-label').textContent = 'Opening…';
  el('import-count').textContent = '';
  el('import-bar').style.width = '0%';

  el('import-minimise').onclick = () => panel.classList.toggle('minimised');

  /* The shelf is refreshed as books land rather than only at the end, so an
     import can be watched -- and used -- while it runs. Not per book: on a
     large shelf that is a redraw a second competing with the parsing. */
  let shownAt = 0;

  const results = await library.importFiles(files, {
    transient,
    onProgress: (message, fraction, done, total) => {
      el('import-label').textContent = message;
      el('import-bar').style.width = `${Math.round((fraction || 0) * 100)}%`;
      el('import-count').textContent = total ? `${done + 1} of ${total}` : '';

      if (Date.now() - shownAt > 3000) {
        shownAt = Date.now();
        refreshShelf();
      }
    },
  });
  panel.hidden = true;
  panel.classList.remove('minimised');
  await refreshShelf();

  if (results.failed.length) {
    // A parse failure is confined to its own file; the rest of the batch
    // still lands, and the reason is shown rather than swallowed.
    toast(`${results.added} added · ${results.failed[0].name}: ${results.failed[0].reason}`, 6000);
  } else {
    const folders = results.folders?.size || 0;
    const seconds = (results.elapsedMs || 0) / 1000;
    const each = results.added ? seconds / results.added : 0;
    // The time is part of the result. Without it there is no way to tell
    // whether a change to the importer helped, and no way to say where the
    // time actually went on a real phone.
    const took = seconds > 2 ? ` · ${seconds.toFixed(0)}s, ${each.toFixed(1)}s a book` : '';
    toast(folders
      ? `${results.added} book${results.added === 1 ? '' : 's'} added across ${folders} folder${folders === 1 ? '' : 's'}${took}`
      : `${results.added} book${results.added === 1 ? '' : 's'} added${took}`, 6000);
  }

  return results;
}

/* ── reader wiring ────────────────────────────────────────────────────── */

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
  el('progress-fill').style.width = `${pct * 100}%`;
  el('progress-page').textContent = `p. ${reader.pageInBook()}`;
  el('progress-pct').textContent = `${Math.round(pct * 100)}%`;
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
    await store.put('books', book);
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
      toast(`End of the chapter — use ${direction > 0 ? 'Ch \u203a' : '\u2039 Ch'} to carry on`);
    }
    return;
  }

  // A second tap the same way, soon after the first, is the confirmation.
  const asked = how === 'immediate'
    || (edgeDirection === direction && Date.now() - edgeToldAt < 4000);

  if (!asked) {
    edgeToldAt = Date.now();
    edgeDirection = direction;
    toast(direction > 0 ? 'End of the chapter — tap again to carry on'
      : 'Start of the chapter — tap again to go back', 4000);
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
  const images = await store.byIndex('images', 'bookId', book.id);
  const pictures = new Map(images.filter((i) => i.blob).map((i) => [i.href, i.blob]));

  /* Two ways of cutting, and a comic wants both.
   *
   * At chapter boundaries, which is how it was put together, and at any page,
   * which is how volumes actually fall. A book of one chapter has no
   * boundaries to use, so it only has the second.
   */
  const pages = library.pagesOf(chapters);
  const canCutChapters = chapters.length > 1;
  const canCutPages = pages.length > 1;

  if (!canCutChapters && !canCutPages) return toast('There is nothing in that book to divide');

  divideMode = mode || (canCutChapters ? 'chapters' : 'pages');
  if (divideMode === 'chapters' && !canCutChapters) divideMode = 'pages';
  if (divideMode === 'pages' && !canCutPages) divideMode = 'chapters';

  dividing = { book, chapters, pictures, pages, canCutChapters, canCutPages };
  divideCuts = new Set();
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

function renderDivide() {
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
  let part = 1;

  rows.forEach((row, at) => {
    // A cut sits between two of them, so one is offered above every row
    // except the first.
    if (at > 0) {
      if (divideCuts.has(at)) part += 1;
      body.appendChild(cutControl(at));
    }

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
    body.appendChild(line);
  });

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
    renderDivide();
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
    const panel = el('import-progress');
    panel.hidden = false;
    try {
      const divide = divideMode === 'pages' ? library.fragmentPages : library.fragmentBook;
      const made = await divide(dividing.book.id, [...divideCuts], {
        name: library.displayTitle(dividing.book),
        onProgress: (label, fraction) => {
          el('import-label').textContent = label;
          el('import-bar').style.width = `${Math.round(fraction * 100)}%`;
        },
      });
      dividing = null;
      divideCuts = new Set();
      dividePages.release();
      await refreshShelf();
      await show('library');
      toast(`Divided into ${made.length} parts — the original is still here`, 7000);
    } catch (error) {
      toast(error.message || 'That book could not be divided', 6000);
    } finally {
      panel.hidden = true;
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

function renderWorkshop() {
  const list = el('build-list');
  const parts = build.contents();

  el('build-empty').hidden = parts.length > 0;
  el('build-naming').hidden = parts.length === 0;
  el('build-foot').hidden = parts.length === 0;
  el('build-count').textContent = parts.length
    ? `${parts.length} part${parts.length === 1 ? '' : 's'}` : '';

  /* The suggested name follows what has been added, until it is typed over.
   *
   * Adding three more volumes should improve the suggestion; it should not
   * throw away a name someone has already chosen. */
  const suggested = parts.length
    ? build.commonName(parts.map((p) => p.name)) || 'Built book'
    : '';
  if (!buildTitleTouched) el('build-title').value = suggested;
  el('build-eyebrow').textContent = parts.length
    ? (el('build-title').value || suggested) : 'Join files into one';

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

      const panel = el('import-progress');
      panel.hidden = false;
      try {
        await build.add(files, (message, fraction) => {
          el('import-label').textContent = message;
          el('import-bar').style.width = `${Math.round((fraction || 0) * 100)}%`;
        });
      } finally {
        panel.hidden = true;
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
    buildTitleTouched = false;
    el('build-title').value = '';
    el('build-author').value = '';
    renderWorkshop();
  };

  el('build-go').onclick = async () => {
    const panel = el('import-progress');
    panel.hidden = false;
    try {
      const { book, failed } = await build.build({
        title: el('build-title').value.trim() || undefined,
        author: el('build-author').value.trim() || undefined,
        onProgress: (message, fraction, done, total) => {
          el('import-label').textContent = message;
          el('import-bar').style.width = `${Math.round(fraction * 100)}%`;
          el('import-count').textContent = total ? `${done + 1} of ${total}` : '';
        },
      });
      build.clear();
      buildTitleTouched = false;
      el('build-title').value = '';
      el('build-author').value = '';
      renderWorkshop();
      await refreshShelf();
      // Said with the parts that failed, not instead of them: a book short
      // three volumes should not look like a complete one.
      toast(failed.length
        ? `Built “${book.title}” — ${book.chapters} chapters · ${failed.length} part${failed.length === 1 ? '' : 's'} skipped: ${failed[0].reason}`
        : `Built “${book.title}” — ${book.chapters} chapters`, 8000);
      await show('library');
    } catch (error) {
      toast(error.message || 'That could not be built', 6000);
    } finally {
      panel.hidden = true;
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

  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { moved = true; return; }
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

    if (middle) {
      reader.cycleChrome();
      paintReader();
      return;
    }
    // Scroll mode moves by a screen; paged mode by a page. Neither crosses
    // into another chapter.
    if (!settings.turnBySideTap) return;
    const direction = fraction <= zone ? -1 : 1;
    if (!reader.turn(direction)) await atChapterEdge(direction);
  }, { passive: true });

  // Swipe, independently toggleable from side taps in settings.
  let startX = 0, startY = 0, startAt = 0;
  host.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; startAt = Date.now();
  }, { passive: true });
  host.addEventListener('touchend', async (e) => {
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

  el('copy-chapter').onclick = async () => {
    const result = await reader.copyChapter();
    // The toast is the one piece of chrome allowed in NONE, and it confirms
    // with a word count so the copy is verifiable at a glance.
    toast(result.ok ? `Chapter copied · ${result.words.toLocaleString()} words` : 'Could not copy');
  };

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
  rail.addEventListener('touchmove', (e) => { scrub(e.touches[0].clientY); e.preventDefault(); });
  rail.addEventListener('touchstart', (e) => scrub(e.touches[0].clientY), { passive: true });
  rail.addEventListener('touchend', () => {
    bubble.hidden = true;
    rail.classList.remove('dragging');
    reader.setScrubbing(false);
  });

  // The progress bar is draggable too, and releases to a page boundary.
  const track = el('progress-track');
  const seek = (clientX) => {
    const box = track.getBoundingClientRect();
    reader.scrubTo((clientX - box.left) / box.width);
  };
  track.addEventListener('touchmove', (e) => { seek(e.touches[0].clientX); e.preventDefault(); });
  track.addEventListener('click', (e) => seek(e.clientX));
}

/* ── global wiring ────────────────────────────────────────────────────── */

/* The three tab screens sit in a row you can swipe between, in the order the
 * bar shows them. The reader is deliberately not in this set: a horizontal
 * swipe there already means turn the page. */
const TABS = ['library', 'folders', 'workshop', 'sort', 'stats', 'settings'];

function wireSwipeBetweenTabs() {
  let startX = 0, startY = 0, startAt = 0, tracking = false;

  document.getElementById('screens').addEventListener('touchstart', (e) => {
    if (!TABS.includes(current) || e.touches.length !== 1) { tracking = false; return; }
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startAt = Date.now();
  }, { passive: true });

  document.getElementById('screens').addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

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

function wireChrome() {
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go) { show(go.dataset.go, { replace: TABS.includes(go.dataset.go) }); return; }
    if (event.target.closest('[data-back]')) { back(); return; }
    if (event.target.closest('[data-import]')) { pickFiles(); }
  });

  el('file-input').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    handleFiles(files);
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

async function writeOut(blob, name, mimeType, { share = false, onProgress } = {}) {
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
    const bytes = new Uint8Array(await piece.arrayBuffer());

    // Built in pieces too: String.fromCharCode on a whole chunk at once
    // overflows the argument list.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    if (!bridge.appendExport(handle, btoa(binary))) {
      throw new Error('The file could not be written');
    }
    onProgress?.(Math.min(1, (at + EXPORT_CHUNK) / blob.size));
    // Yields, so the progress bar paints and the app answers taps.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  bridge.finishExport(handle, mimeType, share);
  return true;
}

window.Grimoire = {
  /** Called from Java once a file has been written where it was asked for. */
  exportSaved(name) { toast(`Saved ${name}`, 5000); },
  exportFailed(reason) { toast(reason || 'That file could not be saved', 6000); },


  /** Called from Java to settle an async bridge call. Not a reader API. */
  settle: translate.settle,

  /** Return true to swallow the back gesture. */
  onBack() {
    if (!el('folder-actions').hidden) { el('folder-actions').hidden = true; return true; }
    if (!el('export-sheet').hidden) { el('export-sheet').hidden = true; return true; }
    if (!el('merge-sheet').hidden) { el('merge-sheet').hidden = true; return true; }
    if (!el('bundle-sheet').hidden) { el('bundle-sheet').hidden = true; return true; }
    if (!el('status-sheet').hidden) { el('status-sheet').hidden = true; return true; }
    if (!el('folder-sheet').hidden) { el('folder-sheet').hidden = true; return true; }
    if (!el('confirm-bar').hidden) { el('confirm-bar').hidden = true; return true; }
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
  activeFolder = settings.shelfFolder ?? null;
  // Anything a crash left half-written is cleared before the shelf is drawn.
  await library.sweepUnfinishedImports();
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
  wireDivide();
  refreshGuides();

  /* If the app died last time, say so.
   *
   * A crash takes the process with it, so from the outside the app simply
   * goes away and whatever launched it comes back -- indistinguishable from
   * it refusing to do anything. The reason is kept and reported here. */
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
    if (document.visibilityState !== 'hidden') return;
    reader.pauseSession();
    if (library.vaultUnlocked) { library.setVaultUnlocked(false); refreshShelf(); }
  });
  window.addEventListener('pagehide', () => { reader.endSession(); reader.releaseImages(); });
}

boot();
