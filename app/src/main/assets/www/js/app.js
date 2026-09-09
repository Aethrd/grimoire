/* App shell: routing, gestures, and the two hooks MainActivity calls. */

import * as store from './store.js';
import * as theme from './theme.js';
import * as reader from './reader.js';
import * as library from './library.js';
import * as screens from './screens.js';
import * as panels from './panels.js';
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
  if (current === 'reader' && name !== 'reader') {
    if (desk) await closeDesk({ returnHome: false });
    await reader.pauseSession();
    await forgetTransientBook();
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
    const books = (await store.all('books')).filter((b) => !b.inVault || library.vaultUnlocked);
    // A second press clears, so the same button undoes itself.
    if (selection.size === books.length) selection.clear();
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

    details: async () => {
      const [book] = await selectedBooks();
      if (book) openDetails(book);
    },

    status: () => openStatusSheet(),

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
function atChapterEdge(direction) {
  if (Date.now() - edgeToldAt < 2500) return;
  edgeToldAt = Date.now();
  const more = direction > 0 ? reader.hasNextChapter() : reader.hasPrevChapter();
  const which = direction > 0 ? 'next' : 'previous';
  toast(more
    ? `End of the chapter — use ${direction > 0 ? 'Ch \u203a' : '\u2039 Ch'} for the ${which} one`
    : `That is the ${direction > 0 ? 'last' : 'first'} chapter`);
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
  const host = el('page-host').getBoundingClientRect();
  const roomAbove = rect.top - host.top;

  bar.hidden = false;
  bar.style.top = '';
  bar.style.bottom = '';

  // Room above means the system menu goes there, so this goes below.
  if (roomAbove > 120) bar.style.top = `${Math.min(rect.bottom + 16, host.bottom - 170)}px`;
  else bar.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 16)}px`;
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
    button.style.background = hex;
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
  document.addEventListener('selectionchange', () => {
    if (current !== 'reader') return;
    // Typing in the note field selects text too; that is not a passage to
    // mark, and reacting to it would close the bar being typed into.
    if (document.activeElement === noteField) return;
    const found = reader.selectionRange();
    if (!found) { hideAnnotateBar(); return; }
    pendingSelection = found;
    // The button says which of the two it will do.
    el('annotate-save').textContent = reader.markAround(found) ? 'Split out' : 'Mark';
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
    const fraction = (e.changedTouches[0].clientX - box.left) / box.width;
    const middle = fraction > settings.tapZone && fraction < 1 - settings.tapZone;

    if (middle) {
      reader.cycleChrome();
      paintReader();
      return;
    }
    // Scroll mode moves by a screen; paged mode by a page. Neither crosses
    // into another chapter.
    if (!settings.turnBySideTap) return;
    const direction = fraction <= settings.tapZone ? -1 : 1;
    if (!reader.turn(direction)) atChapterEdge(direction);
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
    if (!reader.turn(dx < 0 ? 1 : -1)) atChapterEdge(dx < 0 ? 1 : -1);
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
const TABS = ['library', 'folders', 'sort', 'stats', 'settings'];

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

/* Files handed over from elsewhere arrive asynchronously.
 *
 * Reading one used to be a blocking call that returned the whole file as
 * base64, so the app sat frozen for as long as it took. */
const pendingFiles = new Map();

function readHandedFile(uri) {
  return new Promise((resolve, reject) => {
    const bridge = window.GrimoireNative;
    if (!bridge?.readContentUri) {
      return reject(new Error('This build cannot open files from elsewhere'));
    }

    const id = `f${Date.now()}`;
    const timer = setTimeout(() => {
      pendingFiles.delete(id);
      reject(new Error('Reading that file took too long'));
    }, 120000);
    pendingFiles.set(id, { resolve, reject, timer });

    try {
      /* Called on the bridge object, never through a reference taken off it.
       * An injected method pulled out into a variable loses the object it
       * belongs to, and Android refuses it: "Java bridge method can't be
       * invoked on a non-injected object". */
      bridge.readContentUri(id, uri);
    } catch (error) {
      pendingFiles.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * A name the importer can work out a format from.
 *
 * Some providers hand over a name with no extension at all. The first bytes
 * say what the file is well enough to get it as far as the parser, which will
 * give a proper reason if it is something else.
 */
function nameWithFormat(name, bytes) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head.startsWith('%PDF')) return `${name}.pdf`;
  if (head.startsWith('PK')) return `${name}.epub`;   // EPUB and CBZ are both zips
  return `${name}.txt`;
}

window.Grimoire = {
  /** Called from Java to settle a file read. */
  settleFile(id, ok, payload) {
    const entry = pendingFiles.get(id);
    if (!entry) return;
    pendingFiles.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(payload);
    else entry.reject(new Error(payload));
  },

  /** Called from Java to settle an async bridge call. Not a reader API. */
  settle: translate.settle,

  /** Return true to swallow the back gesture. */
  onBack() {
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
  async openExternalBook(contentUri) {
    /* Says so the moment the file arrives.
     *
     * Without this there is no way to tell a file that never reached the app
     * from one that reached it and failed — which are entirely different
     * problems with entirely different fixes, and both look like nothing
     * happening. */
    toast('Opening…', 2000);

    let base64;
    try {
      base64 = await readHandedFile(contentUri);
    } catch (error) {
      return toast(error.message === 'TOO_LARGE'
        ? 'That file is too large to open this way. Import it instead — the shelf '
          + 'reads it straight from disk.'
        : error.message || 'That file could not be read', 8000);
    }

    // The provider knows the real name; a content:// URI's last segment is a
    // document id, and taking it for a filename left the reader with no
    // extension to go on and nothing to say about why it gave up.
    const name = window.GrimoireNative?.displayName?.(contentUri)
      || decodeURIComponent(contentUri.split('/').pop() || '')
      || 'book';

    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([bytes], nameWithFormat(name, bytes));

    const results = await handleFiles([file], { transient: true });
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
