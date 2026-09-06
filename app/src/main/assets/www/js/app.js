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
  return document.querySelector(`[data-screen="${name}"]`);
}

async function show(name, { replace = false } = {}) {
  if (name === current) return;

  // Leaving the reader ends the session, so the log never counts the time
  // someone spent on the stats page as reading.
  // Await it: the stats screen reads the log the moment it opens, and an
  // unawaited flush would land just after it had rendered the old numbers.
  if (current === 'reader' && name !== 'reader') await reader.pauseSession();

  screenNode(current)?.removeAttribute('data-active');
  screenNode(name)?.setAttribute('data-active', '');
  current = name;

  if (replace) stack[stack.length - 1] = name;
  else if (stack[stack.length - 1] !== name) stack.push(name);

  // Leaving the library ends selection: the bar refers to books you can no
  // longer see.
  if (name !== 'library') clearSelection();
  // The tab bar is app furniture; it has no business over a page of prose.
  document.body.dataset.screen = name;
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
    case 'find': return screens.initFind(goToMatch);
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
  document.body.dataset.screen = target;
  if (previous === 'reader') reader.pauseSession();   // back() is sync; the
  // stats screen re-reads on every open, so a late arrival still shows up.
  el('tabbar').hidden = target === 'reader';
  enter(target);
  return true;
}

/* ── library ──────────────────────────────────────────────────────────── */

/** The folder the shelf is filtered to, or null for everything. */
let activeFolder = null;

function openFolder(folder) {
  activeFolder = folder;
  show('library', { replace: true });
}

async function refreshShelf() {
  await library.renderShelf({
    onOpen: onTileTap, onLongPress: onTileHold, selection,
    selecting: selectMode, folder: activeFolder,
    onNotice: (message) => toast(message, 6000),
  });
}

async function openBook(book, opts) {
  await show('reader');
  try {
    // Opening is itself an event worth recording: otherwise a book you opened
    // but did not turn a page in never becomes the one Continue offers, and
    // "last opened" and "continue reading" disagree.
    book.lastReadAt = Date.now();
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
  if (!selectMode) return openBook(book);
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

    // Finished or not. Both directions from one button, because a shelf has
    // both and a one-way "mark read" is half a control.
    status: async () => {
      const books = await selectedBooks();
      if (!books.length) return;
      const anyUnfinished = books.some((b) => !b.finishedAt);
      for (const book of books) {
        book.finishedAt = anyUnfinished ? Date.now() : null;
        if (anyUnfinished) book.percent = 1;
        await store.put('books', book);
      }
      clearSelection();
      toast(anyUnfinished
        ? `${books.length} marked as finished`
        : `${books.length} marked as unread`);
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
    picker.accept = 'image/*';
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (!file) return;
      newCover = file;
      const preview = urls.url(file);
      body.querySelector('#details-cover').innerHTML = `<img src="${preview}" alt="">`;
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
    if (newCover !== undefined) book.coverBlob = newCover;

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

async function handleFiles(files) {
  if (!files.length) return;

  const panel = el('import-progress');
  panel.hidden = false;
  el('import-label').textContent = 'Opening…';
  el('import-count').textContent = '';
  el('import-bar').style.width = '0%';

  const results = await library.importFiles(files, {
    onProgress: (message, fraction, done, total) => {
      el('import-label').textContent = message;
      el('import-bar').style.width = `${Math.round((fraction || 0) * 100)}%`;
      el('import-count').textContent = total ? `${done + 1} of ${total}` : '';
    },
  });
  panel.hidden = true;
  await refreshShelf();

  if (results.failed.length) {
    // A parse failure is confined to its own file; the rest of the batch
    // still lands, and the reason is shown rather than swallowed.
    toast(`${results.added} added · ${results.failed[0].name}: ${results.failed[0].reason}`, 6000);
  } else {
    const folders = results.folders?.size || 0;
    toast(folders
      ? `${results.added} book${results.added === 1 ? '' : 's'} added across ${folders} folder${folders === 1 ? '' : 's'}`
      : `${results.added} book${results.added === 1 ? '' : 's'} added`);
  }
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
  el('reader-pos').textContent =
    `${name} · ${within} · ` +
    `${reader.pageInBook()} of ${state.totalPages} · ${Math.round(reader.percent() * 100)}%`;

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

  refreshBookmarkState();
  refreshTranslateButton();
}

/** Re-checked on every paint, so turning body translation on in settings does
 *  not require closing and reopening the book. */
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

function wireReader() {
  reader.init({ onChange: paintReader });

  const layer = el('tap-layer');
  for (const zone of layer.children) {
    zone.addEventListener('click', () => {
      const action = zone.dataset.tap;
      if (action === 'chrome') { reader.cycleChrome(); paintReader(); return; }
      reader.turn(action === 'forward' ? 1 : -1);
    });
  }

  // Swipe, independently toggleable from side taps in settings.
  let startX = 0, startY = 0, startAt = 0;
  const host = el('page-host');
  host.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; startAt = Date.now();
  }, { passive: true });
  host.addEventListener('touchend', async (e) => {
    // Scroll mode already has a gesture for moving through the text, and
    // hijacking horizontal swipes on top of it fights the scroller.
    if (reader.state.mode === 'scroll') return;
    const settings = await store.settings();
    if (!settings.turnBySwipe) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Date.now() - startAt > 600) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    reader.turn(dx < 0 ? 1 : -1);
  }, { passive: true });

  /* Scroll mode taps.
   *
   * The tap layer is inert there -- it covered the scrollable area and
   * swallowed every drag -- so taps are recognised here instead, and only
   * when the finger did not travel. Anything else is a scroll and is left
   * well alone. */
  let tapX = 0, tapY = 0, tapAt = 0, moved = false;
  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { moved = true; return; }
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
    if (reader.state.mode !== 'scroll' || moved || Date.now() - tapAt > 400) return;
    const settings = await store.settings();
    const width = host.getBoundingClientRect().width;
    const fraction = (e.changedTouches[0].clientX - host.getBoundingClientRect().left) / width;

    if (fraction > settings.tapZone && fraction < 1 - settings.tapZone) {
      reader.cycleChrome();
      paintReader();
    } else if (settings.turnBySideTap) {
      reader.turn(fraction <= settings.tapZone ? -1 : 1);
    }
  }, { passive: true });

  el('chapter-prev').onclick = () => reader.prevChapter();
  el('chapter-next').onclick = () => reader.nextChapter();

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

window.Grimoire = {
  /** Called from Java to settle an async bridge call. Not a reader API. */
  settle: translate.settle,

  /** Return true to swallow the back gesture. */
  onBack() {
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
  async openExternalBook(contentUri) {
    const base64 = window.GrimoireNative?.readContentUri?.(contentUri);
    if (!base64) return toast('That file could not be read');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const name = decodeURIComponent(contentUri.split('/').pop() || 'book.epub');
    const file = new File([bytes], name);
    await handleFiles([file]);
    // Land the reader on what was just opened rather than the shelf.
    const books = await store.all('books');
    const newest = books.sort((a, b) => b.addedAt - a.addedAt)[0];
    if (newest) openBook(newest);
  },
};

/* ── boot ─────────────────────────────────────────────────────────────── */

async function boot() {
  const settings = await store.settings();
  theme.apply(settings);
  // Locked only if a passphrase exists to unlock it with.
  await library.initVaultGate();
  reader.setChrome('full');

  wireChrome();
  wireReader();
  wireSwipeBetweenTabs();
  wireSelection();
  panels.onSettingsChange(() => panels.openSettings(refreshShelf));


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
