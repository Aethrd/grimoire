/* IndexedDB wrapper.
 *
 * The page is served from https://appassets.androidplatform.net, a real
 * origin, so storage is durable. That is the whole reason MainActivity uses
 * WebViewAssetLoader instead of file:// — opaque origins make IndexedDB
 * behave unpredictably, which is fatal for something that stores a library.
 */

const DB_NAME = 'grimoire';
const DB_VERSION = 3;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;

      /*
       * v2: images are stored as Blobs, not as blob: URLs.
       *
       * A blob: URL belongs to the document that created it, so every one
       * persisted by v1 stopped resolving the moment the app was closed --
       * covers came back blank, in-book illustrations vanished, the reel was
       * empty. The blob data itself was never written anywhere, so it cannot
       * be recovered: v1 books keep their text and lose their pictures.
       *
       * The dead references are cleared rather than left in place, so a book
       * falls back to its typeset cover instead of showing a broken image.
       * Re-importing the file restores everything.
       */
      // v3: the translation cache. Translating costs characters against a
      // quota, so nothing is ever translated twice.
      if (e.oldVersion >= 1 && !db.objectStoreNames.contains('translations')) {
        const translations = db.createObjectStore('translations', { keyPath: 'key' });
        translations.createIndex('bookId', 'bookId');
      }

      if (e.oldVersion === 1) {
        const books = req.transaction.objectStore('books');
        books.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const book = cursor.value;
          if (typeof book.cover === 'string') {
            delete book.cover;
            book.coverBlob = null;
            book.imagesLost = true;
            cursor.update(book);
          }
          cursor.continue();
        };
        const images = req.transaction.objectStore('images');
        images.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          if (cursor.value.blob === undefined) cursor.delete();
          else cursor.continue();
        };
        return;
      }

      const books = db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
      books.createIndex('lastReadAt', 'lastReadAt');
      books.createIndex('addedAt', 'addedAt');
      books.createIndex('inVault', 'inVault');
      books.createIndex('fingerprint', 'fingerprint', { unique: false });

      // Chapter text is stored parsed, not the original file. Re-parsing an
      // EPUB on every open would cost seconds on a mid-range phone.
      const chapters = db.createObjectStore('chapters', { keyPath: ['bookId', 'index'] });
      chapters.createIndex('bookId', 'bookId');

      const images = db.createObjectStore('images', { keyPath: ['bookId', 'href'] });
      images.createIndex('bookId', 'bookId');

      const marks = db.createObjectStore('marks', { keyPath: 'id', autoIncrement: true });
      marks.createIndex('bookId', 'bookId');

      db.createObjectStore('positions', { keyPath: 'bookId' });

      const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      events.createIndex('day', 'day');

      db.createObjectStore('settings', { keyPath: 'key' });
      const translations = db.createObjectStore('translations', { keyPath: 'key' });
      translations.createIndex('bookId', 'bookId');
      db.createObjectStore('views', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('layout', { keyPath: 'bookId' }); // bookId 0 = app default
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode = 'readonly') {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put(store, value) {
  const s = await tx(store, 'readwrite');
  return wrap(s.put(value));
}

export async function add(store, value) {
  const s = await tx(store, 'readwrite');
  return wrap(s.add(value));
}

/**
 * Write many records in one transaction.
 *
 * put() opens a transaction per call, so importing a 200-chapter book meant
 * 200 of them. Batching is most of the difference between an import that
 * takes minutes and one that does not.
 */
export async function putAll(store, values) {
  if (!values.length) return;
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  for (const value of values) s.put(value);
  return new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function get(store, key) {
  const s = await tx(store);
  return wrap(s.get(key));
}

export async function all(store) {
  const s = await tx(store);
  return wrap(s.getAll());
}

export async function byIndex(store, indexName, value) {
  const s = await tx(store);
  return wrap(s.index(indexName).getAll(value));
}

export async function del(store, key) {
  const s = await tx(store, 'readwrite');
  return wrap(s.delete(key));
}

/** Delete a book and everything hanging off it, in one pass. */
export async function deleteBook(bookId) {
  const db = await open();
  const t = db.transaction(['books', 'chapters', 'images', 'marks', 'positions'], 'readwrite');
  t.objectStore('books').delete(bookId);
  t.objectStore('positions').delete(bookId);
  for (const store of ['chapters', 'images', 'marks']) {
    const idx = t.objectStore(store).index('bookId');
    idx.openCursor(IDBKeyRange.only(bookId)).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
  }
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/* ── settings ──────────────────────────────────────────────────────────
 * Theme, background, veil, font roles, translation scope and reader input
 * preferences are one object, so exporting them is a single read.
 */

export const DEFAULT_SETTINGS = {
  themeMode: 'dark',              // both themes are pastel; dark is default
  accent: '#b4b0d6',
  backgroundImage: null,
  veil: 0.62,                     // 62% in dark, 28% in light
  columns: 2,
  // Which folder the shelf is filtered to: null for everything, '' for
  // unfiled. Kept with the rest of the shelf's arrangement rather than in a
  // module variable, which forgot it on every launch.
  shelfFolder: null,
  sort: { keys: [['lastRead', 'desc'], ['author', 'asc']], group: [] },
  turnBySwipe: true,
  turnBySideTap: true,
  tapZone: 0.18,                  // adjustable 12–40% in Settings, Behaviour
  keepScreenOn: true,
  translateTitles: false,
  translateChapters: true,
  translateBody: false,
  /* How you read, not how one book is set.
   *
   * Paged or scrolling is a habit rather than a property of a particular
   * book, so it lives with the settings and applies everywhere. It used to
   * sit in the per-book layout, where choosing it on one book left every
   * other one unchanged -- which reads as the app forgetting. */
  /* Annotations.
   *
   * Style is separate from colour on purpose: once a colour carries a meaning
   * -- disagree, look up, quote -- you want a second axis for how loud it is.
   */
  markStyle: 'highlight',   // highlight | underline | double | wavy | box
  markColour: 'yellow',
  markOpacity: 0.35,
  markDensity: 'full',      // full | markers | hidden

  /* How pictures are fitted to the page. Fit is the only one that neither
     crops nor distorts, so it is the default. */
  // screen | width | height | stretch | original | smart
  imageFit: 'screen',

  /* What a forward tap does once a chapter has run out.
   *
   * Turning a whole chapter is a much larger movement than a page, and
   * sharing one gesture with the page turn means doing the larger one by
   * accident every time a chapter ends. Asking for it twice keeps the two
   * apart without making the buttons the only way through — the second tap
   * is a page turn that happens to land on nothing, not a decision.
   */
  chapterOnEdge: 'confirm', // confirm | immediate | buttons
  mergeMarks: true,         // two marks that touch become one

  /* Guides. Both are off by default: they help a great deal with dense
     non-fiction, textbooks, dyslexia and tired eyes, and are a distraction
     for anyone who does not need them. */
  readingRuler: false,
  focusMode: 'off',         // off | paragraph | line

  /* Typography that only matters at a page boundary. */
  keepParagraphs: false,    // never split a paragraph across a page

  readingMode: 'paged',
  endlessScroll: true,

  translateTarget: 'EN-GB',
  streakPages: 10,
  streakMinutes: 10,
  heatRamp: 'ink',
  imageThreshold: 64,             // hides decorative rules
  vaultPassphrase: null,          // stored as a hash, never plaintext
  vaultHideFromStats: true,
};

let cache = null;

export async function settings() {
  if (cache) return cache;
  const row = await get('settings', 'app');
  cache = Object.assign({}, DEFAULT_SETTINGS, row ? row.value : {});
  return cache;
}

export async function saveSettings(patch) {
  const current = await settings();
  cache = Object.assign({}, current, patch);
  await put('settings', { key: 'app', value: cache });
  return cache;
}

export const DEFAULT_LAYOUT = {
  face: 'Newsreader',
  size: 17,          // 13–30
  leading: 1.62,     // 1.1–2.6
  para: 12,          // 0–44
  margin: 24,        // 8–64
  justified: false,
  ink: null,         // null inherits the theme's text colour
};

/** Per-book override wins over the app default; deleting the row inherits again. */
export async function layoutFor(bookId) {
  const [own, base] = await Promise.all([get('layout', bookId), get('layout', 0)]);
  return Object.assign({}, DEFAULT_LAYOUT, base ? base.value : {}, own ? own.value : {});
}

export async function saveLayout(bookId, patch) {
  const current = await layoutFor(bookId);
  const next = Object.assign({}, current, patch);
  await put('layout', { bookId, value: next });
  return next;
}

export async function resetLayout(bookId) {
  await del('layout', bookId);
  return layoutFor(bookId);
}

/* ── marks ───────────────────────────────────────────────────────────── */

export async function addMark(mark) {
  return add('marks', { createdAt: Date.now(), ...mark });
}

export async function deleteMark(id) {
  return del('marks', id);
}

/* ── positions ─────────────────────────────────────────────────────────
 * Written on every page turn, debounced, and flushed on pagehide, so being
 * killed by the system costs at most one page.
 */

let writeTimer = null;
let pending = null;

export function queuePosition(position) {
  pending = position;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushPosition, 2000);
}

export async function flushPosition() {
  clearTimeout(writeTimer);
  if (!pending) return;
  const row = pending;
  pending = null;
  await put('positions', row);
  const book = await get('books', row.bookId);
  if (book) {
    /* Opened, not read. Saving a position happens the moment a book is
       displayed, so setting lastReadAt here marked everything you glanced at
       as Reading. Progress is recorded by markRead, which the reader calls
       only when a page has actually been turned. */
    book.lastOpenedAt = Date.now();
    book.percent = row.percent;
    if (row.percent >= 0.999) book.finishedAt = book.finishedAt || Date.now();
    await put('books', book);
  }
}

/* ── reading events ────────────────────────────────────────────────────
 * The append-only log every stat is computed from. Nothing leaves the
 * device; the whole log exports as JSON.
 */

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Someone has actually read some of this, not merely opened it. */
export async function markRead(bookId) {
  const book = await get('books', bookId);
  if (!book) return;
  book.lastReadAt = Date.now();
  book.lastOpenedAt = book.lastReadAt;
  await put('books', book);
}

export async function recordEvent({
  bookId, activeMs = 0, pages = 0, words = 0, chapters = 0, elsewhere = false, lang,
}) {
  /* Words count as reading on their own.
   *
   * This used to require pages or time, which are the two things a chapter
   * copied out to be read somewhere else produces none of -- so the reading
   * that happens away from the app recorded nothing at all, which is the
   * opposite of what the log is for.
   */
  if (pages <= 0 && activeMs <= 0 && words <= 0) return;

  await add('events', {
    bookId, activeMs, pages, words, chapters, elsewhere,
    lang: lang || 'und',
    day: dayKey(),
    at: Date.now(),
  });
}


/* ── backup ───────────────────────────────────────────────────────────────
 *
 * Everything except the books themselves.
 *
 * The text and pictures are not here on purpose: they are tens of gigabytes
 * for a shelf this size, and they already exist as the files they were
 * imported from. What cannot be re-imported is everything you did afterwards
 * -- the folders, the statuses, the bundles, where you were in each book,
 * every bookmark, and the reading log. That is what this carries.
 *
 * Books are matched on re-import by fingerprint, which is the file's name and
 * size, so importing the same files again puts it all back.
 */

const BACKUP_VERSION = 1;

/** Fields worth keeping. Everything else is derived from the file itself. */
const BOOK_FIELDS = [
  'title', 'author', 'series', 'seriesIndex', 'lang', 'folder', 'status',
  'tags', 'inVault', 'percent', 'addedAt', 'lastReadAt', 'lastOpenedAt',
  'finishedAt', 'coverBytes', 'coverCustom',
];

/**
 * A cover picked by hand, small enough to carry in a backup.
 *
 * Returns null rather than throwing on anything it cannot read. A cover that
 * will not encode is a cover lost; a backup that throws part-way through is
 * everything lost, which is not a trade worth making.
 */
function readAsDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

function dataUrlToBlob(url) {
  const [head, data] = String(url).split(',');
  const type = /:(.*?);/.exec(head)?.[1] || 'image/webp';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function exportBackup() {
  const books = await all('books');
  const byId = new Map(books.map((b) => [b.id, b]));

  return {
    format: 'grimoire-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: await settings(),
    // Kept out of the settings blob as well, so an export is a record of how
    // imports have actually behaved rather than only the most recent one.
    imports: (await settings()).importHistory || [],
    views: await all('views'),
    events: await all('events'),
    layout: await all('layout'),

    books: books
      .filter((b) => !b.importing && !b.transient && b.fingerprint)
      .map((book) => {
        const kept = { fingerprint: book.fingerprint };
        for (const field of BOOK_FIELDS) {
          if (book[field] !== undefined) kept[field] = book[field];
        }
        // Bundles are ids, which will not survive a re-import. Recorded as
        // the leader's fingerprint instead, which will.
        const leader = book.bundleId ? byId.get(book.bundleId) : null;
        if (leader?.fingerprint) kept.bundleLeader = leader.fingerprint;
        return kept;
      }),

    /* Covers chosen by hand.
     *
     * The rest of a book comes back by re-importing the file, but a cover
     * someone went and found does not — it exists nowhere else. They are
     * capped at a thousand pixels on import, so carrying them costs little,
     * and only the replaced ones are carried.
     */
    covers: await Promise.all(books
      .filter((b) => b.coverCustom && b.fingerprint
        && typeof b.coverBlob?.type === 'string' && b.coverBlob.size > 0)
      .map(async (b) => ({
        fingerprint: b.fingerprint,
        dataUrl: await readAsDataUrl(b.coverBlob),
      }))).then((list) => list.filter((c) => c.dataUrl)),

    positions: (await all('positions'))
      .map((p) => ({ ...p, fingerprint: byId.get(p.bookId)?.fingerprint }))
      .filter((p) => p.fingerprint),

    marks: (await all('marks'))
      .map((m) => ({ ...m, fingerprint: byId.get(m.bookId)?.fingerprint }))
      .filter((m) => m.fingerprint),
  };
}

/**
 * Put a backup back.
 *
 * Additive: books already present are updated, books not present are noted
 * and skipped rather than invented. Importing the files first and the backup
 * second is the order that restores everything; the other way round still
 * works for settings and the reading log.
 */
export async function importBackup(data) {
  if (data?.format !== 'grimoire-backup') {
    throw new Error('That is not a Grimoire backup file.');
  }
  if (data.version > BACKUP_VERSION) {
    throw new Error('That backup was made by a newer version of the app.');
  }

  const report = { settings: false, books: 0, missing: 0, marks: 0, events: 0, covers: 0 };

  if (data.settings) {
    // Merged over the defaults, so a backup from an older version does not
    // remove settings it had never heard of.
    cache = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    await put('settings', { key: 'app', value: cache });
    report.settings = true;
  }

  for (const view of data.views || []) await put('views', view);
  for (const row of data.layout || []) await put('layout', row);

  const books = await all('books');
  const byFingerprint = new Map(books.map((b) => [b.fingerprint, b]));

  for (const saved of data.books || []) {
    const book = byFingerprint.get(saved.fingerprint);
    if (!book) { report.missing += 1; continue; }
    for (const field of BOOK_FIELDS) {
      if (saved[field] !== undefined) book[field] = saved[field];
    }
    await put('books', book);
    report.books += 1;
  }

  // A second pass: a bundle's leader may not have existed on the first.
  for (const saved of data.books || []) {
    if (!saved.bundleLeader) continue;
    const book = byFingerprint.get(saved.fingerprint);
    const leader = byFingerprint.get(saved.bundleLeader);
    if (!book || !leader) continue;
    book.bundleId = leader.id;
    await put('books', book);
  }

  for (const cover of data.covers || []) {
    const book = byFingerprint.get(cover.fingerprint);
    if (!book || !cover.dataUrl) continue;
    try {
      const blob = dataUrlToBlob(cover.dataUrl);
      book.coverBlob = blob;
      book.coverBytes = blob.size;
      book.coverCustom = true;
      await put('books', book);
      report.covers = (report.covers || 0) + 1;
    } catch {
      // A cover that will not decode is not worth failing a restore over.
    }
  }

  for (const position of data.positions || []) {
    const book = byFingerprint.get(position.fingerprint);
    if (!book) continue;
    const { fingerprint, ...row } = position;
    await put('positions', { ...row, bookId: book.id });
  }

  /* Restoring twice must not leave two of everything.
   *
   * Marks and log entries were added outright, so a second restore -- after a
   * failed one, or simply to be sure -- doubled every bookmark and every
   * reading session. Both carry enough to recognise themselves: a mark is
   * where it sits in a book, and a session is when it happened.
   */
  const markSeen = new Set((await all('marks'))
    .map((m) => `${m.bookId}:${m.kind}:${m.chapterIndex}:${m.anchor}`));

  for (const mark of data.marks || []) {
    const book = byFingerprint.get(mark.fingerprint);
    if (!book) continue;
    const { fingerprint, id, ...row } = mark;

    const signature = `${book.id}:${row.kind}:${row.chapterIndex}:${row.anchor}`;
    if (markSeen.has(signature)) continue;
    markSeen.add(signature);

    await add('marks', { ...row, bookId: book.id });
    report.marks += 1;
  }

  // The log is keyed by book too, but a reading history is worth keeping even
  // for books no longer on the shelf.
  const eventSeen = new Set((await all('events')).map((e) => `${e.bookId}:${e.at}`));

  for (const event of data.events || []) {
    const { id, ...row } = event;
    const book = books.find((b) => b.id === event.bookId);
    const bookId = book ? book.id : null;

    const signature = `${bookId}:${row.at}`;
    if (eventSeen.has(signature)) continue;
    eventSeen.add(signature);

    await add('events', { ...row, bookId });
    report.events += 1;
  }

  return report;
}
