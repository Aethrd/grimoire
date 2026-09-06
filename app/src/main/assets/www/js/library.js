/* Library: import, shelf, sort and group. */

import * as store from './store.js';
import { parse, formatOf, expandArchive, SUPPORTED, UNSUPPORTED_REASON } from './parse.js';
import { pool } from './blobs.js';
import * as translate from './translate.js';

const el = (id) => document.getElementById(id);

export const SORT_KEYS = {
  folder: 'Folder',
  author: 'Author',
  added: 'Date added',
  lastRead: 'Last read',
  series: 'Series order',
  title: 'Title',
  progress: 'Progress',
  format: 'Format',
  words: 'Word count',
};

export const GROUP_LEVELS = {
  folder: 'Folder', series: 'Series', status: 'Status', format: 'Format',
  author: 'Author', tag: 'Tag', language: 'Language',
};

export const MAX_GROUP_DEPTH = 3;

/* ── sorting ──────────────────────────────────────────────────────────── */

function valueOf(book, key) {
  switch (key) {
    case 'folder': return book.folder?.toLowerCase() || null;
    case 'author': return book.author?.toLowerCase() ?? null;
    case 'added': return book.addedAt ?? null;
    case 'lastRead': return book.lastReadAt ?? null;
    case 'series': return book.seriesIndex ?? null;
    case 'title': return book.title?.toLowerCase() ?? null;
    case 'progress': return book.percent ?? null;
    case 'format': return book.format ?? null;
    case 'words': return book.words ?? null;
    default: return null;
  }
}

/**
 * Stable multi-key sort: keys applied in order, direction per key, and nulls
 * always last regardless of direction. That last rule is why this cannot be a
 * simple comparator chain with a reverse — flipping a descending key would
 * float every null to the top, which is exactly where a missing value should
 * never be.
 */
export function sortBooks(books, keys) {
  const withIndex = books.map((b, i) => ({ b, i }));
  withIndex.sort((x, y) => {
    for (const [key, dir] of keys) {
      const a = valueOf(x.b, key);
      const c = valueOf(y.b, key);
      if (a == null && c == null) continue;
      if (a == null) return 1;
      if (c == null) return -1;
      if (a === c) continue;
      const cmp = a < c ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return x.i - y.i;   // ties keep insertion order, so the shelf never shuffles
  });
  return withIndex.map((w) => w.b);
}

function groupLabel(book, level) {
  switch (level) {
    // Folders come from the directory structure inside an imported archive,
    // or are set by hand. Nested paths stay whole rather than being split
    // across grouping levels: "Fiction/Le Guin" is one folder, and the user
    // can add Author as a second level if they want it broken down.
    case 'folder': return book.folder || 'Unfiled';
    case 'series': return book.series || 'Standalone';
    case 'status': return book.finishedAt ? 'Finished' : book.lastReadAt ? 'Reading' : 'Unread';
    case 'format': return book.format || 'Unknown';
    case 'author': return book.author || 'Unknown author';
    case 'tag': return (book.tags && book.tags[0]) || 'Untagged';
    case 'language': return book.lang || 'Undeclared';
    default: return 'All';
  }
}

export function groupBooks(books, levels) {
  if (!levels.length) return [{ label: 'All books', count: books.length, books, children: [] }];
  const [head, ...rest] = levels;
  const map = new Map();
  for (const book of books) {
    const key = groupLabel(book, head);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(book);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => ({
      label,
      count: list.length,
      books: rest.length ? [] : list,
      children: rest.length ? groupBooks(list, rest) : [],
    }));
}

export function sortSummary(keys) {
  if (!keys.length) return 'Unsorted';
  return keys
    .map(([k, d]) => `${SORT_KEYS[k]}${d === 'desc' ? ' ↓' : ' ↑'}`)
    .join(' · ');
}

/* ── import ───────────────────────────────────────────────────────────── */

/**
 * One file at a time, awaited, so a fifty-file import never locks the UI
 * thread for the whole batch and each file reports its own outcome. A failure
 * is confined to its own tile: the rest of the batch still lands.
 */
export async function importFiles(files, { onProgress, onDone } = {}) {
  const results = { added: 0, failed: [], folders: new Set() };

  // Archives are flattened first, so the loop below never has to know whether
  // a book arrived on its own or came out of a zip. Each expanded book carries
  // the folder it was filed under inside the archive.
  const queue = [];
  for (const file of files) {
    if (formatOf(file.name) !== 'ZIP') {
      queue.push({ file, name: file.name, folder: '' });
      continue;
    }
    try {
      onProgress?.(`Opening ${file.name}`, 0);
      const archive = await expandArchive(file, (fraction, name) =>
        onProgress?.(`Unpacking ${name}`, fraction));

      if (archive.comic) {
        // A zip of images is a comic, not a container.
        queue.push({ file, name: file.name, folder: '' });
        continue;
      }
      for (const book of archive.books) {
        queue.push({
          // read() rather than a File: the entry is extracted when its turn
          // comes and released straight after, so a big archive never has more
          // than one book unpacked at a time.
          read: book.read,
          name: book.name,
          folder: book.folder,
          // The entry's own size, so re-importing the same archive is a no-op
          // rather than a second copy of everything.
          fingerprint: `${book.name}:${book.size}`,
        });
        if (book.folder) results.folders.add(book.folder);
      }
    } catch (error) {
      results.failed.push({ name: file.name, reason: error.message || 'Could not be opened' });
    }
  }

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const folder = entry.folder;
    const name = entry.name || entry.file?.name || 'book';
    onProgress?.(`Reading ${name}`, i / queue.length, i, queue.length);

    const format = formatOf(name);
    if (UNSUPPORTED_REASON[format]) {
      results.failed.push({ name, reason: UNSUPPORTED_REASON[format] });
      continue;
    }

    try {
      // A file the user picked twice is the same book, not a second copy.
      const fingerprint = entry.fingerprint || `${name}:${entry.file.size}`;
      const existing = (await store.byIndex('books', 'fingerprint', fingerprint))[0];
      if (existing) continue;

      // Extracted only now, and only this one.
      const file = entry.file || new File([await entry.read()], name);
      const parsed = await parse(file, (p) =>
        onProgress?.(`Parsing ${name}`, (i + p) / queue.length, i, queue.length));

      const bookId = await store.add('books', {
        title: parsed.title,
        author: parsed.author,
        series: parsed.series,
        seriesIndex: parsed.seriesIndex,
        lang: parsed.lang,
        format: parsed.format,
        coverBlob: parsed.coverBlob,
        words: parsed.words,
        chapterCount: parsed.chapters.length,
        imageCount: parsed.images.length,
        tocSource: parsed.tocSource,
        fingerprint,
        folder,
        addedAt: Date.now(),
        lastReadAt: null,
        finishedAt: null,
        percent: 0,
        inVault: false,
        tags: [],
      });

      // One transaction each rather than one per record: a long book has
      // hundreds of chapters, and a transaction apiece is what made importing
      // a shelf take minutes.
      await store.putAll('chapters', parsed.chapters.map((c) => ({ bookId, ...c })));
      await store.putAll('images', parsed.images.map((i) => ({ bookId, ...i })));
      results.added += 1;
    } catch (error) {
      results.failed.push({ name, reason: error.message || 'Could not be parsed' });
    }
  }

  onDone?.(results);
  return results;
}

/* ── shelf rendering ──────────────────────────────────────────────────── */

const DENSITY_ICONS = {
  2: '<rect x="3" y="4" width="8" height="16"/><rect x="13" y="4" width="8" height="16"/>',
  3: '<rect x="2" y="5" width="5" height="14"/><rect x="9" y="5" width="5" height="14"/><rect x="16" y="5" width="5" height="14"/>',
  4: '<rect x="2" y="6" width="4" height="12"/><rect x="7" y="6" width="4" height="12"/><rect x="12" y="6" width="4" height="12"/><rect x="17" y="6" width="4" height="12"/>',
};

function tile(book, onOpen, onLongPress, selection, selecting) {
  const coverUrl = covers.url(book.coverBlob);
  const node = document.createElement('button');
  node.className = selection?.has(book.id) ? 'tile selected' : 'tile';
  node.dataset.book = String(book.id);
  node.innerHTML = `
    <span class="tile-cover">
      ${coverUrl
        ? `<img src="${coverUrl}" alt="${escape(book.title)}">`
        : `<span class="tile-title">${escape(displayTitle(book))}</span>`}
      <span class="tile-badge">${escape(book.format || '?')}</span>
      <span class="tile-bar"><span style="width:${Math.round((book.percent || 0) * 100)}%"></span></span>
      ${selecting ? '<span class="tile-check"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L19 7"/></svg></span>' : ''}
    </span>
    <span class="tile-name">${escape(displayTitle(book))}</span>
    <span class="tile-meta">${escape(cleanAuthor(book.author))}</span>`;

  node.addEventListener('click', () => onOpen(book));

  // Long press starts selection. The click listener above still fires on
  // touchend, so it checks whether selection mode is on and toggles instead
  // of opening -- which is also what makes a second tap deselect.
  let timer = null;
  node.addEventListener('touchstart', () => {
    timer = setTimeout(() => {
      timer = null;
      onLongPress(book, node);
    }, 500);
  }, { passive: true });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchmove', cancel, { passive: true });

  return node;
}

/** Scraped EPUBs routinely carry a literal "<unknown>" as the author. */
function cleanAuthor(author) {
  const value = (author || '').trim();
  if (!value || /^<?unknown>?$/i.test(value) || value === '---') return '—';
  return value;
}

const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let lastHandlers = {};

/* URLs for the covers currently on screen. Released and re-minted on every
   render: holding them forever would leak one per cover per refresh. */
const covers = pool();

/* Translated titles, keyed by book id. Held here rather than written into the
   DOM after the fact: the shelf tile has no title element when a book has
   cover art, so patching it silently did nothing. */
const titles = new Map();
export const displayTitle = (book) => titles.get(book.id) || book.title;

export async function renderShelf(handlers) {
  lastHandlers = handlers;
  const { onOpen, onLongPress, selection, selecting, folder } = handlers;
  const settings = await store.settings();
  const all = await store.all('books');

  // Vault contents stay out of the shelf until the vault is unlocked. The
  // same filter is applied in search, the reel and the stats totals.
  let visible = all.filter((b) => !b.inVault || vaultUnlocked);

  // Filtered to one folder, and to anything nested under it.
  if (folder != null) {
    visible = visible.filter((b) => folder === ''
      ? !b.folder
      : b.folder === folder || (b.folder || '').startsWith(`${folder}/`));
  }

  const sorted = sortBooks(visible, settings.sort.keys);
  const groups = groupBooks(sorted, settings.sort.group);

  const shelf = el('shelf');
  const empty = el('library-empty');
  covers.release();
  shelf.innerHTML = '';
  shelf.style.setProperty('--cols', settings.columns);
  shelf.className = `shelf cols-${settings.columns}`;

  empty.hidden = visible.length > 0;

  const flat = [];
  const collect = (nodes, depth) => {
    for (const group of nodes) {
      if (group.books.length) flat.push(group);
      if (group.children.length) collect(group.children, depth + 1);
    }
  };
  collect(groups, 0);

  if (settings.sort.group.length) {
    for (const group of flat) {
      const head = document.createElement('div');
      head.className = 'list-head';
      head.style.gridColumn = '1 / -1';
      head.innerHTML = `<span>${escape(group.label)}</span><span>${group.count}</span>`;
      shelf.appendChild(head);
      for (const book of group.books) shelf.appendChild(tile(book, onOpen, onLongPress, selection, selecting));
    }
  } else {
    for (const book of sorted) shelf.appendChild(tile(book, onOpen, onLongPress, selection, selecting));
  }

  const shelves = new Set(sorted.map((b) => b.series).filter(Boolean)).size;
  const reading = sorted.filter((b) => b.lastReadAt && !b.finishedAt).length;
  el('library-counts').textContent = visible.length
    ? `${visible.length} titles · ${shelves} series · ${reading} reading`
    : 'No books yet';

  el('sort-summary').textContent = sortSummary(settings.sort.keys);
  el('group-title').textContent = folder != null
    ? (folder || 'Unfiled')
    : settings.sort.group.length
    ? settings.sort.group.map((g) => GROUP_LEVELS[g]).join(' → ')
    : 'All books';
  el('group-count').textContent = `${visible.length} shown`;
  el('density-icon').innerHTML = DENSITY_ICONS[settings.columns];

  await renderContinueCard(sorted, onOpen);
  await renderViewChips(folder);
  applyTitleTranslations(sorted, settings);
}

/** Saved views are filter, sort and group snapshots kept as chips above the
 *  control strip. Tapping one applies it; holding one deletes it. */
async function renderViewChips(folder) {
  const host = el('view-chips');
  const views = await store.all('views');
  host.innerHTML = '';
  host.hidden = views.length === 0 && folder == null;

  /* A filter that survives a relaunch needs a way out that is visible from
     the shelf. Without one, "why can I only see nine books" is answered two
     screens away. */
  if (folder != null) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', 'true');
    chip.style.textTransform = 'none';
    chip.textContent = `${folder || 'Unfiled'}  ✕`;
    chip.onclick = () => lastHandlers.onClearFolder?.();
    host.appendChild(chip);
  }

  for (const view of views) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = view.name;
    chip.onclick = async () => {
      await store.saveSettings({ sort: view.rules });
      renderShelf(lastHandlers);
    };

    let timer = null;
    chip.addEventListener('touchstart', () => {
      timer = setTimeout(async () => {
        timer = null;
        await store.del('views', view.id);
        renderViewChips();
      }, 550);
    }, { passive: true });
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    chip.addEventListener('touchend', cancel);
    chip.addEventListener('touchmove', cancel, { passive: true });

    host.appendChild(chip);
  }
}

async function renderContinueCard(books, onOpen) {
  const card = el('continue-card');

  // Anything opened and not finished, most recent first. The old rule also
  // demanded progress above zero, which meant the book you opened a minute
  // ago was not the one offered until you had turned a page -- so "last
  // opened" and "continue reading" disagreed.
  const candidates = books
    .filter((b) => b.lastReadAt && !b.finishedAt)
    .sort((a, b) => b.lastReadAt - a.lastReadAt);

  // Hidden entirely when nothing is in progress. It is never shown empty.
  if (!candidates.length) { card.hidden = true; return; }

  const book = candidates[0];
  const position = await store.get('positions', book.id);
  const coverUrl = covers.url(book.coverBlob);

  card.hidden = false;
  el('continue-title').textContent = displayTitle(book);
  el('continue-cover').style.backgroundImage = coverUrl ? `url("${coverUrl}")` : '';
  el('continue-meta').textContent = position
    ? `Ch. ${position.chapterIndex + 1} · p. ${position.pageInBook} of ${position.totalPages} · ${Math.round(position.percent * 100)}%`
    : 'Not started';
  el('continue-bar').style.width = `${Math.round((book.percent || 0) * 100)}%`;
  card.onclick = () => onOpen(book);
}

/**
 * Translated titles land after the shelf has drawn, not before it. A cached
 * one arrives in the same frame; an uncached one costs a round trip, and
 * blocking the shelf on that would mean staring at nothing.
 */
async function applyTitleTranslations(books, settings) {
  if (!settings.translateTitles) {
    if (!titles.size) return;
    titles.clear();
    return renderShelf(lastHandlers);
  }

  // Switched on but not usable. This returned silently before, which is
  // indistinguishable from translation being broken -- and it is the most
  // likely state to be in, because the engine needs setting up first.
  const state = translate.status();
  if (!state.configured) {
    lastHandlers.onNotice?.(state.unavailable
      ? 'Translation is unavailable in this build.'
      : 'Translation is on but no engine is set up — Settings, then Translate.');
    return;
  }
  const lang = settings.translateTarget;
  let changed = false;

  for (const book of books) {
    if (titles.has(book.id)) continue;
    try {
      const { results } = await translate.translateBatch(
        book.id, [{ field: 'title', text: book.title }], lang,
        translate.sourceFor(book));
      const value = results.get('title');
      if (value && value !== book.title) { titles.set(book.id, value); changed = true; }
    } catch (error) {
      // Swallowing this was the whole reason translation looked like it did
      // nothing: no key, no quota or -- most often -- no language pack, and
      // not a word about it. Reported once, then the loop stops rather than
      // failing forty more times.
      lastHandlers.onNotice?.(error.message);
      break;
    }
  }

  // One re-render at the end rather than forty DOM pokes, and it puts the
  // translated title in the continue card too.
  if (changed) await renderShelf(lastHandlers);
}

/** Every folder currently in use, with how many books are in each. */
export async function folderCounts() {
  const books = await store.all('books');
  const counts = new Map();
  for (const book of books) {
    if (book.inVault && !vaultUnlocked) continue;
    const folder = book.folder || '';
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/* The vault gate, read by every list that must not leak a vault title before
   it is unlocked.
 *
 * It starts unlocked when no passphrase has been set, because a vault with no
 * lock on it is not a vault -- and the alternative was books vanishing with no
 * way to get them back: hidden from the shelf, and only listable from a screen
 * that first demands a passphrase which does not exist. */
export let vaultUnlocked = true;
export function setVaultUnlocked(value) { vaultUnlocked = value; }

/** Called at boot: locked only if there is something to unlock. */
export async function initVaultGate() {
  const settings = await store.settings();
  vaultUnlocked = !settings.vaultPassphrase;
  return vaultUnlocked;
}
