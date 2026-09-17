/* Library: import, shelf, sort and group. */

import * as store from './store.js';
import { urlCache } from './blobs.js';
import { parse, formatOf, expandArchive, chapterHtml, countWords, SUPPORTED, UNSUPPORTED_REASON } from './parse.js';
import * as translate from './translate.js';
import * as mix from './mix.js';

const el = (id) => document.getElementById(id);

export const SORT_KEYS = {
  bundle: 'Bundle',
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
    // How many editions are gathered here. Descending puts bundles first,
    // which is the useful direction; a lone book counts as one.
    case 'bundle': return book.bundle ? book.bundle.length : 1;
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
    case 'status': return STATUS_LABELS[statusOf(book)];
    case 'format': return book.format || 'Unknown';
    case 'author': return book.author || 'Unknown author';
    case 'tag': return (book.tags && book.tags[0]) || 'Untagged';
    case 'language': return book.lang || 'Undeclared';
    default: return 'All';
  }
}

/**
 * Levels whose groups have a natural order that is not alphabetical.
 *
 * Status is the one that matters: sorted by name it reads Finished, Reading,
 * Unread -- the books you have already finished at the top and the one you
 * are in the middle of buried beneath them. What you want first is what you
 * are reading, then what you have not started, and the finished ones last.
 */
/**
 * The reading states, in the order they belong on a shelf.
 *
 * `null` is not a state: it means no one has said, and the state is worked out
 * from whether the book has been opened and whether it was finished. Setting
 * one of these pins it; reverting to Automatic lets it follow the reading
 * again.
 */
export const STATUSES = [
  ['reading', 'Reading'],
  ['unread', 'Unread'],
  ['onHold', 'On hold'],
  ['dropped', 'Dropped'],
  ['finished', 'Finished'],
];

export const STATUS_LABELS = Object.fromEntries(STATUSES);

/* ── bundles ──────────────────────────────────────────────────────────────
 *
 * Several editions of one book kept together: a translation and its original,
 * a revised text beside the one you started, a paperback scan next to an
 * EPUB. One tile on the shelf, several things to open.
 *
 * A bundle is just a shared id on the members, and it is the id of whichever
 * book leads it -- so there is no separate record to go stale, and deleting
 * the lot leaves nothing behind. The leader supplies the cover and title.
 */

export const isBundled = (book) => !!book.bundleId;
export const leadsBundle = (book) => book.bundleId === book.id;

/**
 * Reduce a list to one entry per bundle.
 *
 * The leader stands for the group, with its members attached. A member whose
 * leader is missing -- deleted on its own, say -- stands for itself rather
 * than vanishing.
 */
export function collapseBundles(books, levels = []) {
  const byId = new Map(books.map((b) => [b.id, b]));
  const members = new Map();
  const out = [];

  for (const book of books) {
    // A leader that has been unbundled on its own no longer leads: its former
    // members stand for themselves rather than re-forming a group around a
    // book that is not in one, which would list the leader twice.
    const leader = byId.get(book.bundleId);
    if (!book.bundleId || !leader || leader.bundleId !== book.bundleId) {
      out.push(book);
      continue;
    }
    if (!members.has(book.bundleId)) members.set(book.bundleId, []);
    members.get(book.bundleId).push(book);
  }

  for (const [id, group] of members) {
    const leader = byId.get(id);

    /* A bundle collapses only while its members belong in the same place.
       Group by language and an English edition and its raw belong under two
       headings, not one -- so the bundle comes apart for as long as that
       grouping is on, rather than filing both under whichever one leads. */
    const splits = levels.some((level) => {
      const first = groupLabel(leader, level);
      return group.some((member) => groupLabel(member, level) !== first);
    });
    if (splits) { out.push(leader, ...group.filter((b) => b.id !== id)); continue; }
    // Ordered so the leader is first, then by title: the sheet reads the same
    // way every time.
    const rest = group.filter((b) => b.id !== id)
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    out.push(Object.assign(Object.create(Object.getPrototypeOf(leader)), leader,
      { bundle: [leader, ...rest] }));
  }

  return out;
}

/** The state a book is actually in: what was set, or what can be inferred. */
export function statusOf(book) {
  if (book.status && STATUS_LABELS[book.status]) return book.status;
  if (book.finishedAt) return 'finished';
  if (book.lastReadAt) return 'reading';
  return 'unread';
}

/** Whether the state was set by hand rather than inferred. */
export const statusIsPinned = (book) => !!(book.status && STATUS_LABELS[book.status]);

const GROUP_ORDER = {
  status: STATUSES.map(([, label]) => label),
};

function groupRank(level, label) {
  const order = GROUP_ORDER[level];
  if (!order) return -1;
  const at = order.indexOf(label);
  // Anything unlisted sorts after the listed ones, then alphabetically.
  return at === -1 ? order.length : at;
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
    .sort((a, b) => {
      const rank = groupRank(head, a[0]) - groupRank(head, b[0]);
      return rank || a[0].localeCompare(b[0]);
    })
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
/**
 * @param options.transient  Marks the book as passing through rather than
 *   collected: it is kept out of the shelf and removed when the reader is
 *   closed. Opening a file from elsewhere on the phone should not silently
 *   add it to someone's library.
 */
export async function importFiles(files, { onProgress, onDone, transient = false } = {}) {
  /* Timed, in phases.
   *
   * Judging an import from a benchmark on a desktop was a mistake: jsdom
   * parses XML in JavaScript where a WebView uses Blink's native parser, so
   * the cost of parsing is far smaller on a phone than any measurement taken
   * here suggests. The only numbers worth trusting come off the device, so
   * the app takes them itself.
   */
  const started = Date.now();
  const spent = { read: 0, parse: 0, write: 0 };
  /* One line per book.
   *
   * Averages hide the thing worth knowing. A shelf that imports in four
   * minutes might be a hundred books at two seconds each or one book at three
   * minutes, and only one of those is worth optimising. Size, chapter count
   * and picture count are recorded beside the time so the outliers can be
   * recognised rather than guessed at.
   */
  const perBook = [];
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
      const readAt = performance.now();
      const file = entry.file || new File([await entry.read()], name);
      spent.read += performance.now() - readAt;
      const bookAt = performance.now();

      /* The book row is created first so images can be written as they are
         extracted rather than piling up in memory. A heavily illustrated book
         is well over a hundred megabytes of blobs, and holding all of them
         until the parse finished is what killed the app partway through a
         shelf. `importing` marks it incomplete until the rest lands. */
      const bookId = await store.add('books', {
        title: name, fingerprint, folder, importing: true, transient,
        addedAt: Date.now(), lastReadAt: null, finishedAt: null,
        percent: 0, inVault: false, tags: [],
      });

      let parsed;
      try {
        const buffered = [];
        const flush = async () => {
          if (buffered.length) await store.putAll('images', buffered.splice(0));
        };

      const parseAt = performance.now();
        parsed = await parse(file, (p) =>
          onProgress?.(`Parsing ${name}`, (i + p) / queue.length, i, queue.length), {
          onImage: async (record) => {
            buffered.push({ bookId, ...record });
            // Written in batches: one transaction per image is as wasteful as
            // holding them all, just in the other direction.
            if (buffered.length >= 12) await flush();
          },
        });
        await flush();
        spent.parse += performance.now() - parseAt;
      } catch (error) {
        // No half-imported book left on the shelf.
        await store.deleteBook(bookId).catch(() => {});
        throw error;
      }

      await store.put('books', {
        id: bookId,
        title: parsed.title,
        author: parsed.author,
        series: parsed.series,
        seriesIndex: parsed.seriesIndex,
        lang: parsed.lang,
        format: parsed.format,
        coverBlob: parsed.coverBlob,
        // Recorded so a redraw can tell one cover from another without
        // reading the Blob back; see coverUrlFor.
        coverBytes: parsed.coverBlob?.size ?? null,
        words: parsed.words,
        chapterCount: parsed.chapters.length,
        imageCount: parsed.imageCount ?? parsed.images.length,
        tocSource: parsed.tocSource,
        fingerprint,
        folder,
        importing: false,
        transient,
        addedAt: Date.now(),
        lastReadAt: null,
        finishedAt: null,
        percent: 0,
        inVault: false,
        tags: [],
      });

      // One transaction rather than one per chapter: a long book has hundreds
      // of them, and a transaction apiece is what made importing a shelf take
      // minutes.
      const writeAt = performance.now();
      await store.putAll('chapters', parsed.chapters.map((c) => ({ bookId, ...c })));
      const writeMs = performance.now() - writeAt;
      spent.write += writeMs;

      perBook.push({
        name,
        format: parsed.format || null,
        bytes: file.size,
        chapters: parsed.chapters.length,
        images: parsed.imageCount || 0,
        words: parsed.words || 0,
        ms: Math.round(performance.now() - bookAt),
        writeMs: Math.round(writeMs),
      });
      results.added += 1;
    } catch (error) {
      results.failed.push({ name, reason: error.message || 'Could not be parsed' });
    }
  }

  results.elapsedMs = Date.now() - started;
  results.spent = spent;

  // Kept so one import can be compared with the next, which is the only way
  // to tell whether a change to the importer actually helped.
  if (results.added) {
    // Kept as a short history rather than only the latest, so a change to the
    // importer can be judged against what came before it.
    const settings = await store.settings();
    const history = [...(settings.importHistory || [])].slice(-9);
    history.push({
      at: Date.now(),
      books: results.added,
      ms: results.elapsedMs,
      spent: { ...spent },
      slowest: perBook.slice(0, 3),
    });

    await store.saveSettings({
      importHistory: history,
      lastImport: {
        at: Date.now(),
        books: results.added,
        ms: results.elapsedMs,
        spent,
        // Slowest first: the top of this list is where any further work
        // belongs, and the rest is context for judging it.
        perBook: perBook.sort((a, b) => b.ms - a.ms).slice(0, 40),
      },
    });
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

/**
 * A book as it looks on the shelf, for use outside the shelf.
 *
 * Search results were a list of names, and a name is not how anyone
 * recognises a book they own -- the cover is. This is the same tile, without
 * the selection and long-press machinery that only the shelf needs.
 */
export function bookTile(book, onOpen) {
  return tile(book, onOpen, null, null, false);
}

function tile(book, onOpen, onLongPress, selection, selecting) {
  const coverUrl = coverUrlFor(book);
  const node = document.createElement('button');
  node.className = selection?.has(book.id) ? 'tile selected' : 'tile';
  if (book.bundle) node.classList.add('bundled');
  node.dataset.book = String(book.id);
  // A cover you would rather not have on screen. Nothing is changed in the
  // file; it is the tile that is blurred.
  if (book.coverBlur) node.dataset.blur = '';
  node.innerHTML = `
    <span class="tile-cover">
      ${coverUrl
        ? `<img src="${coverUrl}" alt="${escape(book.title)}">`
        : `<span class="tile-title">${escape(displayTitle(book))}</span>`}
      <span class="tile-badge">${escape(book.format || '?')}</span>
      <span class="tile-bar"><span style="width:${Math.round((book.percent || 0) * 100)}%"></span></span>
      ${selecting ? '<span class="tile-check"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L19 7"/></svg></span>' : ''}
      ${book.bundle
        ? `<span class="tile-bundle"><img src="img/bundle.png" alt="">${book.bundle.length}</span>`
        : ''}
    </span>
    <span class="tile-name${isTranslatedTitle(book) ? ' translated-text' : ''}">${escape(displayTitle(book))}</span>
    <span class="tile-meta">${escape(cleanAuthor(book.author))}</span>`;

  node.addEventListener('click', () => onOpen(book));

  if (!onLongPress) return node;

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
/* Cover URLs, kept between renders.
 *
 * They used to be released and re-minted on every render, so each refresh
 * meant the browser decoding a hundred and forty images again -- and until
 * they landed, every tile was a placeholder rectangle. That is the bright
 * flash: not a transition, just the shelf briefly having no covers on it.
 *
 * The signature comes off the book record rather than the Blob: a stored Blob
 * comes back from IndexedDB as a new object every time, so identity is no
 * use, and not every platform hands back one that still reports its size.
 */
const covers = urlCache();
const coverUrlFor = (book) =>
  covers.url(book.id, book.coverBlob, book.coverBytes ?? book.coverBlob?.size);

/* Translated titles, keyed by book id. Held here rather than written into the
   DOM after the fact: the shelf tile has no title element when a book has
   cover art, so patching it silently did nothing. */
const titles = new Map();
export const displayTitle = (book) => titles.get(book.id) || book.title;
/** Whether the title on screen is a machine translation rather than the
 *  book's own. Used to mark it, so the two are never mistaken. */
export const isTranslatedTitle = (book) => titles.has(book.id);

export async function renderShelf(handlers) {
  lastHandlers = handlers;
  const { onOpen, onLongPress, selection, selecting, folder } = handlers;
  const settings = await store.settings();
  const all = await store.all('books');

  // Vault contents stay out of the shelf until the vault is unlocked. The
  // same filter is applied in search, the reel and the stats totals.
  // A hard kill during import leaves a row with no chapters behind it. It is
  // not a book yet, so it does not belong on the shelf.
  let visible = all.filter((b) =>
    !b.importing && !b.transient && (!b.inVault || vaultUnlocked));

  // Filtered to one folder, and to anything nested under it.
  if (folder != null) {
    visible = visible.filter((b) => folder === ''
      ? !b.folder
      : b.folder === folder || (b.folder || '').startsWith(`${folder}/`));
  }

  // Collapsed first, then sorted: a bundle is one entry on the shelf, so it
  // sorts like one -- including on how many editions it holds.
  const sorted = sortBooks(
    collapseBundles(visible, settings.sort.group), settings.sort.keys);
  const groups = groupBooks(sorted, settings.sort.group);

  const shelf = el('shelf');
  const empty = el('library-empty');
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
  const reading = sorted.filter((b) => statusOf(b) === 'reading').length;
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

  // Only after the render, so a cover still on screen is never revoked.
  covers.forget(new Set(visible.map((b) => b.id)));

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
  // Anything opened and not put aside. A book marked finished, dropped or on
  // hold is not what you want offered next, whatever its dates say.
  // Opened, whether or not a page was turned: Continue is about where you
  // were, not about what counts as reading.
  const openedAt = (b) => b.lastOpenedAt || b.lastReadAt || 0;
  const candidates = books
    .filter((b) => openedAt(b) && !['finished', 'dropped', 'onHold'].includes(statusOf(b)))
    .sort((a, b) => openedAt(b) - openedAt(a));

  // Hidden entirely when nothing is in progress. It is never shown empty.
  if (!candidates.length) { card.hidden = true; return; }

  const book = candidates[0];
  const position = await store.get('positions', book.id);
  const coverUrl = coverUrlFor(book);

  card.hidden = false;
  el('continue-title').textContent = displayTitle(book);
  el('continue-title').classList.toggle('translated-text', isTranslatedTitle(book));
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
/**
 * Clear out anything a crash left behind: a half-written import, or a book
 * that was only ever passing through and never got tidied up.
 */
export async function sweepUnfinishedImports() {
  const stale = (await store.all('books')).filter((b) => b.importing || b.transient);
  for (const book of stale) await store.deleteBook(book.id).catch(() => {});
  return stale.length;
}

export async function initVaultGate() {
  const settings = await store.settings();
  vaultUnlocked = !settings.vaultPassphrase;
  return vaultUnlocked;
}


/* ── merging ──────────────────────────────────────────────────────────────
 *
 * Several volumes read as one book.
 *
 * A serial arrives as a folder of files -- volume 1, volume 2, volume 10 --
 * and reading it means opening each in turn, losing your place at every
 * boundary and seeing progress reset to nothing twelve times over. Bundling
 * groups them on the shelf; this makes them a single book with one spine, one
 * position and one percentage.
 *
 * The volumes are left alone. Merging copies, so a merge that turns out badly
 * costs a delete rather than a re-import.
 */

/** 'Volume 2' before 'Volume 10', which plain text sorting gets backwards. */
export const naturalOrder = (a, b) => String(a || '').localeCompare(String(b || ''),
  undefined, { numeric: true, sensitivity: 'base' });

/**
 * Build one book from several.
 *
 * @param ids      the books to join, in the order given
 * @param options.title  what to call the result
 * @param options.markVolumes  put each volume's name above its first chapter
 */
export async function mergeBooks(ids, { title, markVolumes = true, onProgress } = {}) {
  const sources = [];
  for (const id of ids) {
    const book = await store.get('books', id);
    if (book) sources.push(book);
  }
  if (sources.length < 2) throw new Error('Pick two or more books to join.');

  const name = title || sources[0].title;
  const merged = {
    title: name,
    author: sources.find((b) => b.author)?.author || null,
    lang: sources[0].lang || null,
    format: sources[0].format || null,
    // Its own fingerprint, from what went into it: importing the volumes
    // again should not look like a duplicate of the merged book.
    fingerprint: `merged:${ids.join('+')}`,
    // Fingerprints as well as ids, so splitting can tell whether a volume is
    // still on the shelf after the ids have changed underneath it.
    mergedFrom: sources.map((b) => ({ id: b.id, title: b.title, fingerprint: b.fingerprint })),
    coverBlob: sources[0].coverBlob || null,
    coverBytes: sources[0].coverBytes ?? null,
    coverCustom: !!sources[0].coverCustom,
    folder: sources[0].folder || null,
    addedAt: Date.now(),
    words: 0,
    importing: true,
  };
  const bookId = await store.add('books', merged);

  let index = 0;
  let words = 0;

  for (let volume = 0; volume < sources.length; volume++) {
    const source = sources[volume];
    onProgress?.(`Joining ${source.title}`, (volume + 1) / sources.length, volume, sources.length);

    /* Every path gains a per-volume prefix.
     *
     * Two volumes of the same serial almost always name their pictures the
     * same way -- OEBPS/images/001.jpg in both -- so without this the second
     * volume's pictures quietly replace the first's. Prefixing the chapter's
     * base and the image's href by the same amount keeps them pointing at
     * each other, since one is resolved against the other.
     */
    const prefix = `v${volume}/`;

    const chapters = await store.byIndex('chapters', 'bookId', source.id);
    chapters.sort((a, b) => a.index - b.index);

    const rows = chapters.map((chapter, at) => ({
      bookId,
      index: index++,
      title: markVolumes && at === 0 && sources.length > 1
        ? `${source.title} — ${chapter.title}`
        : chapter.title,
      volume: source.title,
      fromToc: chapter.fromToc,
      words: chapter.words || 0,
      base: prefix + (chapter.base || ''),
      // Books imported before chapters kept their source hold finished markup
      // instead, and its picture references are already resolved.
      ...(chapter.source != null
        ? { source: chapter.source }
        : { html: reKeyImages(chapter.html || '', prefix) }),
    }));
    words += rows.reduce((n, r) => n + r.words, 0);
    await store.putAll('chapters', rows);

    const images = await store.byIndex('images', 'bookId', source.id);
    await store.putAll('images', images.map((image) => ({
      ...image,
      id: undefined,
      bookId,
      href: prefix + image.href,
    })));
  }

  const finished = await store.get('books', bookId);
  finished.words = words;
  finished.chapters = index;
  delete finished.importing;
  await store.put('books', finished);

  return finished;
}

/** Point already-resolved picture references at their prefixed copies. */
function reKeyImages(html, prefix) {
  return html.replace(/data-img="([^"]*)"/g, (_, href) => `data-img="${prefix}${href}"`);
}


/** Whether a book was made by joining others, and so can be taken apart. */
export const wasJoined = (book) =>
  (Array.isArray(book?.mergedFrom) && book.mergedFrom.length > 1)
  || (Array.isArray(book?.builtFrom) && book.builtFrom.length > 1);

/**
 * Take a joined book apart again.
 *
 * Two cases, and the difference matters. Usually the volumes are still on the
 * shelf, because joining copies rather than consumes -- then splitting is
 * simply removing the joined copy, and recreating them would leave two of
 * everything. Where they have since been deleted, they are rebuilt out of the
 * joined book: every chapter still carries the volume it came from and the
 * per-volume prefix on its paths, which is exactly what is needed to undo it.
 */
export async function splitBook(bookId) {
  const book = await store.get('books', bookId);
  if (!wasJoined(book)) throw new Error('That book was not made by joining others.');

  const shelf = await store.all('books');
  const present = new Set(shelf.map((b) => b.fingerprint));
  const missing = book.mergedFrom.filter((v) => !v.fingerprint || !present.has(v.fingerprint));

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);
  const images = await store.byIndex('images', 'bookId', bookId);

  const restored = [];
  for (let volume = 0; volume < book.mergedFrom.length; volume++) {
    const source = book.mergedFrom[volume];
    const stillThere = source.fingerprint && present.has(source.fingerprint);
    if (stillThere) continue;

    const prefix = `v${volume}/`;
    const mine = chapters.filter((c) => (c.base || '').startsWith(prefix));
    if (!mine.length) continue;

    const rebuilt = await store.add('books', {
      title: source.title,
      author: book.author || null,
      lang: book.lang || null,
      format: book.format || null,
      fingerprint: source.fingerprint || `split:${bookId}:${volume}`,
      folder: book.folder || null,
      addedAt: Date.now(),
      words: mine.reduce((n, c) => n + (c.words || 0), 0),
    });

    await store.putAll('chapters', mine.map((chapter, at) => ({
      bookId: rebuilt,
      index: at,
      // The volume marker put on the first chapter when joining belongs to
      // the joined book, not to the volume standing on its own again.
      title: at === 0 ? (chapter.title.split(' — ').pop() || chapter.title) : chapter.title,
      fromToc: chapter.fromToc,
      words: chapter.words || 0,
      base: (chapter.base || '').slice(prefix.length),
      ...(chapter.source != null
        ? { source: chapter.source }
        : { html: unKeyImages(chapter.html || '', prefix) }),
    })));

    await store.putAll('images', images
      .filter((image) => image.href.startsWith(prefix))
      .map((image) => ({ ...image, id: undefined, bookId: rebuilt, href: image.href.slice(prefix.length) })));

    restored.push(source.title);
  }

  await store.deleteBook(bookId);
  return { restored, kept: book.mergedFrom.length - missing.length };
}

/** Undo the per-volume prefix on already-resolved picture references. */
function unKeyImages(html, prefix) {
  return html.replace(/data-img="([^"]*)"/g, (whole, href) =>
    (href.startsWith(prefix) ? `data-img="${href.slice(prefix.length)}"` : whole));
}


/* ── dividing a book ──────────────────────────────────────────────────────
 *
 * The workshop joins files into one book; this is the other direction.
 *
 * A single file often holds what are really several things -- a bound set of
 * volumes, a year of serialised chapters, an omnibus -- and reading it means
 * one enormous spine with no sense of where you are. Dividing it gives each
 * part its own place, its own progress and its own percentage.
 *
 * The original is left alone, as joining leaves its parts alone: a division
 * that turns out badly costs a delete rather than a re-import.
 */

/**
 * A few words from each side of a proposed cut.
 *
 * The point of showing them is that a chapter list does not tell you what a
 * cut actually separates -- "Chapter 12" and "Chapter 13" look like a safe
 * place to divide until you see that one runs straight into the other.
 */
export function previewCut(chapters, at, words = 22) {
  const before = chapters[at - 1];
  const after = chapters[at];

  const tail = (chapter) => {
    if (!chapter) return null;
    const text = plainTextOf(chapter);
    if (!text) return chapter.title || null;
    return `…${text.split(/\s+/).slice(-words).join(' ')}`;
  };
  const head = (chapter) => {
    if (!chapter) return null;
    const text = plainTextOf(chapter);
    if (!text) return chapter.title || null;
    return `${text.split(/\s+/).slice(0, words).join(' ')}…`;
  };

  /* A chapter of pictures has no words to preview.
   *
   * Repeating its title tells you nothing about where the cut falls -- for a
   * comic that is the only thing worth knowing. The last page before the cut
   * and the first page after it are what a reader would actually look at.
   */
  return {
    endsWith: tail(before),
    beginsWith: head(after),
    endsAt: before?.title || null,
    beginsAt: after?.title || null,
    endsPicture: lastPicture(before),
    beginsPicture: firstPicture(after),
    pictures: countPictures(before) + countPictures(after),
  };
}

const PICTURE_REF = /data-img="([^"]*)"/g;

function picturesOf(chapter) {
  const markup = chapter?.html ?? chapter?.source ?? '';
  return [...String(markup).matchAll(PICTURE_REF)].map((m) => m[1]);
}

const firstPicture = (chapter) => picturesOf(chapter)[0] || null;
const lastPicture = (chapter) => picturesOf(chapter).slice(-1)[0] || null;

const countPictures = (chapter) =>
  ((chapter?.html || chapter?.source || '').match(/<img\b/gi) || []).length;

function plainTextOf(chapter) {
  const markup = chapter.html ?? chapter.source ?? '';
  return String(markup)
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Divide a book at the given chapter indexes.
 *
 * @param cuts  indexes a part begins at; 0 is implied and ignored.
 */
export async function fragmentBook(bookId, cuts, { name, onProgress } = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);
  if (chapters.length < 2) throw new Error('That book has only one chapter.');

  const points = [...new Set(cuts.map(Number).filter((n) => n > 0 && n < chapters.length))]
    .sort((a, b) => a - b);
  if (!points.length) throw new Error('Choose at least one place to divide it.');

  const images = await store.byIndex('images', 'bookId', bookId);
  const bounds = [0, ...points, chapters.length];
  const made = [];

  for (let part = 0; part < bounds.length - 1; part++) {
    const from = bounds[part];
    const to = bounds[part + 1];
    const mine = chapters.slice(from, to);
    onProgress?.(`Part ${part + 1}`, (part + 1) / (bounds.length - 1));

    const title = `${name || book.title} — ${part + 1}`;
    const partId = await store.add('books', {
      title,
      author: book.author || null,
      lang: book.lang || null,
      format: book.format || null,
      folder: book.folder || null,
      // Its own fingerprint, so re-importing the whole book later does not
      // look like a duplicate of one of its parts.
      fingerprint: `part:${bookId}:${part}`,
      dividedFrom: { id: bookId, title: book.title, part: part + 1, of: bounds.length - 1 },
      addedAt: Date.now() + part,
      words: mine.reduce((n, c) => n + (c.words || 0), 0),
      chapters: mine.length,
      coverBlob: part === 0 ? book.coverBlob || null : null,
      coverBytes: part === 0 ? book.coverBytes ?? null : null,
    });

    await store.putAll('chapters', mine.map((chapter, n) => ({
      ...chapter,
      id: undefined,
      bookId: partId,
      index: n,
    })));

    /* Pictures follow their chapters.
     *
     * They are numbered against the book they were in, so a picture from
     * chapter forty has to be renumbered against a part that starts there --
     * otherwise it claims to belong to a chapter the part does not have.
     */
    await store.putAll('images', images
      .filter((image) => image.chapterIndex >= from && image.chapterIndex < to)
      .map((image) => ({
        ...image,
        id: undefined,
        bookId: partId,
        chapterIndex: image.chapterIndex - from,
      })));

    made.push({ id: partId, title, chapters: mine.length });
  }

  return made;
}


/* ── dividing inside a chapter ────────────────────────────────────────────
 *
 * A book does not have to arrive in chapters. A comic volume is usually one
 * archive of three hundred pages, and a scraped novel is often one long
 * chapter -- and neither can be divided at a chapter boundary, because there
 * are none.
 *
 * So where there is a single chapter, the pieces it is made of become the
 * things to cut between: the pages of a comic, the paragraphs of prose. Both
 * are top-level blocks in the chapter's own markup, so one mechanism covers
 * them.
 */

/**
 * The blocks a chapter is made of.
 *
 * @returns [{ html, text, picture }] in order, where picture is the href of
 *   an illustration when the block is one.
 */
export function unitsOf(html) {
  const doc = DOMP.parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const body = doc.body;
  const units = [];

  for (const node of [...body.children]) {
    const picture = node.tagName === 'IMG'
      ? node.getAttribute('data-img')
      : node.querySelector?.('img[data-img]')?.getAttribute('data-img') || null;

    units.push({
      html: node.outerHTML,
      text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
      picture,
    });
  }
  return units;
}

const DOMP = new DOMParser();

/** What a cut inside a chapter separates. */
export function previewUnitCut(units, at, words = 22) {
  const before = units[at - 1];
  const after = units[at];
  const say = (unit, end) => {
    if (!unit) return null;
    if (!unit.text) return null;
    const parts = unit.text.split(/\s+/);
    return end
      ? `…${parts.slice(-words).join(' ')}`
      : `${parts.slice(0, words).join(' ')}…`;
  };
  return {
    endsWith: say(before, true),
    beginsWith: say(after, false),
    endsAt: before?.picture ? 'page' : null,
    beginsAt: after?.picture ? 'page' : null,
    endsPicture: before?.picture || null,
    beginsPicture: after?.picture || null,
  };
}

/**
 * Divide a book whose content is one chapter.
 *
 * Each part keeps the blocks between two cuts, and the pictures those blocks
 * refer to -- filtered rather than copied wholesale, or every part would
 * carry the whole volume's artwork.
 */
export async function fragmentChapter(bookId, cuts, { name, onProgress } = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);
  if (chapters.length !== 1) throw new Error('That book already has chapters to divide at.');

  const chapter = chapters[0];
  const units = unitsOf(chapterHtml(chapter));
  if (units.length < 2) throw new Error('There is nothing in that chapter to divide.');

  const points = [...new Set(cuts.map(Number).filter((n) => n > 0 && n < units.length))]
    .sort((a, b) => a - b);
  if (!points.length) throw new Error('Choose at least one place to divide it.');

  const images = await store.byIndex('images', 'bookId', bookId);
  const byHref = new Map(images.map((image) => [image.href, image]));
  const bounds = [0, ...points, units.length];
  const made = [];

  for (let part = 0; part < bounds.length - 1; part++) {
    const mine = units.slice(bounds[part], bounds[part + 1]);
    onProgress?.(`Part ${part + 1}`, (part + 1) / (bounds.length - 1));

    const title = `${name || book.title} — ${part + 1}`;
    const words = countWords(mine.map((u) => u.text).join(' '), book.lang);

    const partId = await store.add('books', {
      title,
      author: book.author || null,
      lang: book.lang || null,
      format: book.format || null,
      folder: book.folder || null,
      fingerprint: `part:${bookId}:${part}`,
      dividedFrom: { id: bookId, title: book.title, part: part + 1, of: bounds.length - 1 },
      addedAt: Date.now() + part,
      words,
      chapters: 1,
      coverBlob: part === 0 ? book.coverBlob || null : null,
      coverBytes: part === 0 ? book.coverBytes ?? null : null,
    });

    await store.put('chapters', {
      bookId: partId,
      index: 0,
      title,
      fromToc: false,
      words,
      html: mine.map((u) => u.html).join('\n'),
    });

    // Only the pictures these blocks actually use.
    const used = mine.map((u) => u.picture).filter(Boolean);
    await store.putAll('images', used
      .map((href, order) => {
        const image = byHref.get(href);
        return image ? { ...image, id: undefined, bookId: partId, order, chapterIndex: 0 } : null;
      })
      .filter(Boolean));

    made.push({ id: partId, title, units: mine.length, pictures: used.length });
  }

  return made;
}


/**
 * Every page of a book, in order, with the chapter it came from.
 *
 * A comic can be divided two ways and both are wanted: at chapter boundaries,
 * which is how it was put together, and at any page, which is how volumes
 * actually fall. Flattening the pages gives the second without giving up the
 * first -- each page still knows its chapter, so the parts can be rebuilt
 * with their chapter structure intact.
 */
export function pagesOf(chapters) {
  const pages = [];
  for (const chapter of chapters) {
    for (const unit of unitsOf(chapterHtml(chapter))) {
      pages.push({
        ...unit,
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
      });
    }
  }
  return pages;
}

/**
 * Divide a book at page boundaries, wherever its chapters happen to fall.
 *
 * A part that spans whole chapters keeps them as chapters. A cut inside a
 * chapter splits that one and no other, so the chapter names either side stay
 * meaningful instead of collapsing into one undifferentiated run.
 */
export async function fragmentPages(bookId, cuts, { name, onProgress } = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);
  const pages = pagesOf(chapters);
  if (pages.length < 2) throw new Error('There is nothing in that book to divide.');

  const points = [...new Set(cuts.map(Number).filter((n) => n > 0 && n < pages.length))]
    .sort((a, b) => a - b);
  if (!points.length) throw new Error('Choose at least one place to divide it.');

  const images = await store.byIndex('images', 'bookId', bookId);
  const byHref = new Map(images.map((image) => [image.href, image]));
  const bounds = [0, ...points, pages.length];
  const made = [];

  for (let part = 0; part < bounds.length - 1; part++) {
    const mine = pages.slice(bounds[part], bounds[part + 1]);
    onProgress?.(`Part ${part + 1}`, (part + 1) / (bounds.length - 1));

    // Consecutive pages from one chapter become one chapter again.
    const grouped = [];
    for (const page of mine) {
      const last = grouped[grouped.length - 1];
      if (last && last.from === page.chapterIndex) last.pages.push(page);
      else grouped.push({ from: page.chapterIndex, title: page.chapterTitle, pages: [page] });
    }

    const title = `${name || book.title} — ${part + 1}`;
    const words = mine.reduce((n, p) => n + countWords(p.text, book.lang), 0);

    const partId = await store.add('books', {
      title,
      author: book.author || null,
      lang: book.lang || null,
      format: book.format || null,
      folder: book.folder || null,
      fingerprint: `part:${bookId}:${part}`,
      dividedFrom: { id: bookId, title: book.title, part: part + 1, of: bounds.length - 1 },
      addedAt: Date.now() + part,
      words,
      chapters: grouped.length,
      coverBlob: part === 0 ? book.coverBlob || null : null,
      coverBytes: part === 0 ? book.coverBytes ?? null : null,
    });

    await store.putAll('chapters', grouped.map((group, index) => ({
      bookId: partId,
      index,
      title: group.title,
      fromToc: false,
      words: group.pages.reduce((n, p) => n + countWords(p.text, book.lang), 0),
      html: group.pages.map((p) => p.html).join('\n'),
    })));

    // Only the pictures these pages use, numbered against their new chapter.
    const carried = [];
    grouped.forEach((group, index) => {
      for (const page of group.pages) {
        const image = page.picture ? byHref.get(page.picture) : null;
        if (image) {
          carried.push({
            ...image, id: undefined, bookId: partId,
            chapterIndex: index, order: carried.length,
          });
        }
      }
    });
    await store.putAll('images', carried);

    made.push({ id: partId, title, chapters: grouped.length, pages: mine.length });
  }

  return made;
}


/* ── finding a book ───────────────────────────────────────────────────────
 *
 * The shelf search exists to pinpoint a book, not to find a sentence inside
 * one -- that is what the search inside a book is for. So it looks at
 * everything that identifies a book on a shelf, not only its title.
 *
 * Three things it was getting wrong. It ignored the series and the folder, so
 * a library organised into "Manhwa" could not be searched for manhwa. It
 * required the words in the order they were typed, so "almanac salt" found
 * nothing while "salt almanac" worked. And it returned matches in shelf
 * order, which buries the book whose title you typed under one that happens
 * to share an author.
 */

const FIELDS = [
  ['title', 6],
  ['shown', 6],      // the translated title, where there is one
  ['author', 4],
  ['series', 3],
  ['folder', 2],
  ['tags', 2],
];

const fold = (text) => String(text ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

function fieldsOf(book) {
  return {
    title: fold(book.title),
    shown: fold(displayTitle(book)),
    author: fold(book.author),
    series: fold(book.series),
    folder: fold(book.folder),
    tags: fold(Array.isArray(book.tags) ? book.tags.join(' ') : book.tags),
  };
}

/**
 * Score a book against the words typed.
 *
 * Every word has to match something, or the result is noise: typing two words
 * should narrow, not widen. Where a word matches decides how well the book
 * scores, and a word starting a field counts for more than one buried in the
 * middle of it.
 */
function scoreBook(book, words, only) {
  const fields = fieldsOf(book);
  const wanted = only ? FIELDS.filter(([name]) => only.includes(name)) : FIELDS;

  let score = 0;
  for (const word of words) {
    let best = 0;
    for (const [name, weight] of wanted) {
      const value = fields[name];
      if (!value) continue;
      const at = value.indexOf(word);
      if (at === -1) continue;
      // Starting the field, or starting a word in it, is a better match than
      // landing in the middle of one.
      const edge = at === 0 ? 2 : /\s|[-–—:,.]/.test(value[at - 1] || '') ? 1.5 : 1;
      best = Math.max(best, weight * edge);
    }
    if (!best) return 0;          // every word must match something
    score += best;
  }

  // The whole phrase, as typed, in the title: the strongest signal there is.
  const phrase = words.join(' ');
  if (fields.title.includes(phrase) || fields.shown.includes(phrase)) score += 8;
  return score;
}

/** Which field a book matched on, so a result can say why it is there. */
export function matchedOn(book, query, only) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const fields = fieldsOf(book);
  const wanted = only ? FIELDS.filter(([name]) => only.includes(name)) : FIELDS;

  for (const [name] of wanted) {
    if (name === 'title' || name === 'shown') continue;
    if (words.every((word) => fields[name] && fields[name].includes(word))) return name;
  }
  return null;
}

/**
 * Books matching what was typed, best first.
 *
 * @param only  field names to search, or null for all of them
 */
export function findBooks(books, query, only = null) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  return books
    .map((book) => ({ book, score: scoreBook(book, words, only) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score
      || String(displayTitle(a.book)).localeCompare(String(displayTitle(b.book))))
    .map((hit) => hit.book);
}


/**
 * Work out, once, how a book's colour should become grey.
 *
 * Remembered on the book, because the measurement costs a canvas pass and a
 * slow screen cannot afford one per page turn -- and a book is drawn by one
 * person in one palette, so the answer does not change from page to page.
 */
export async function greyMixFor(book) {
  if (book.greyMix) return book.greyMix;

  const images = await store.byIndex('images', 'bookId', book.id);
  const blobs = images.map((image) => image.blob).filter(Boolean);
  if (!blobs.length) return null;

  const chosen = await mix.measureBook(blobs);
  if (!chosen) return null;

  const stored = await store.get('books', book.id);
  if (stored) {
    stored.greyMix = chosen.name;
    await store.put('books', stored);
  }
  return chosen.name;
}


/**
 * Hide, or stop hiding, the covers of some books.
 *
 * A shelf is looked at in public. Some covers are fine on a train and some
 * are not, and the choice belongs to the reader rather than to whoever drew
 * the cover. Only the tile is blurred: the file is untouched, and the book
 * opens exactly as it did.
 *
 * @param on  true to blur, false to show, or undefined to flip each one
 */
export async function blurCovers(ids, on) {
  let changed = 0;
  for (const id of ids) {
    const book = await store.get('books', id);
    if (!book) continue;

    const wanted = on === undefined ? !book.coverBlur : !!on;
    if (!!book.coverBlur === wanted) continue;

    if (wanted) book.coverBlur = true;
    else delete book.coverBlur;
    await store.put('books', book);
    changed += 1;
  }
  return changed;
}

/** The books in a folder, or the unfiled ones when the folder is null. */
export async function booksInFolder(folder) {
  return (await store.all('books')).filter((book) => (book.folder || null) === (folder || null));
}
