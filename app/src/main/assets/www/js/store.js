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
  sort: { keys: [['lastRead', 'desc'], ['author', 'asc']], group: [] },
  turnBySwipe: true,
  turnBySideTap: true,
  tapZone: 0.18,                  // adjustable 12–40% in Settings, Behaviour
  keepScreenOn: true,
  translateTitles: false,
  translateChapters: true,
  translateBody: false,
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
  mode: 'paged',     // 'paged' | 'scroll'
  endless: true,     // scroll mode: run on into the next chapter
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
    book.lastReadAt = Date.now();
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

export async function recordEvent({ bookId, activeMs, pages, words, lang }) {
  if (pages <= 0 && activeMs <= 0) return;
  await add('events', {
    bookId, activeMs, pages, words,
    lang: lang || 'und',
    day: dayKey(),
    at: Date.now(),
  });
}
