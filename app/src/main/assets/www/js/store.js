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

/* Storage that stops answering is said, not left as buttons that do nothing.
 *
 * The WebView can drop the connection to the library (its storage running
 * into trouble underneath), and an opening can fail. Either was for good:
 * the dropped connection was kept and every read and write after it failed,
 * and a failed opening was remembered, so nothing tried again until the app
 * was closed -- a folder tapped did nothing, as the setting it saves first
 * failed. A dropped connection is now let go of and opened again at the next
 * read or write; a failed opening is tried again the next time. If it still
 * cannot be had, app.js is told (grimoire:storage-trouble), to say so. */
const STORAGE_SLOW_MS = 20000;
function storageTrouble(why) {
  try {
    window.dispatchEvent(new CustomEvent('grimoire:storage-trouble', { detail: String(why?.message || why || 'storage not answering') }));
  } catch { /* no window: tests in Node */ }
}

function open() {
  if (dbPromise) return dbPromise;
  const opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // An opening that has not answered in a while is said; it is still waited on.
    const slow = setTimeout(() => storageTrouble('the library has not opened'), STORAGE_SLOW_MS);
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
    req.onsuccess = () => {
      clearTimeout(slow);
      const db = req.result;
      // Dropped by the WebView: let go of, so the next read or write opens it again.
      db.onclose = () => { if (dbPromise === opening) dbPromise = null; };
      db.onversionchange = () => { db.close(); if (dbPromise === opening) dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(slow);
      // Not remembered: the next read or write tries again.
      if (dbPromise === opening) dbPromise = null;
      storageTrouble(req.error);
      reject(req.error);
    };
  });
  dbPromise = opening;
  return opening;
}

/** The connection closed as the WebView closes it under the app: for the tests. */
export async function dropConnectionForTest() { (await open()).close(); }

/** A transaction, begun again on a fresh connection if the one held was closing under it. */
function transaction(stores, mode = 'readonly') {
  return open().then((db) => {
    try {
      return db.transaction(stores, mode);
    } catch (error) {
      if (error?.name !== 'InvalidStateError') throw error;
      dbPromise = null;
      return open().then((again) => again.transaction(stores, mode))
        .catch((still) => { storageTrouble(still); throw still; });
    }
  });
}

function tx(store, mode = 'readonly') {
  return transaction(store, mode).then((t) => t.objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** How many books there are, without reading them. */
export async function countBooks() {
  return wrap((await tx('books')).count());
}

/* A book's chapters a few at a time, in order: for writing out a book too
 * long to hold every chapter of at once (epub.js). Keyed [bookId, index], so
 * a range of keys is a run of chapters, in their order. */
export async function chapterCount(bookId) {
  return wrap((await tx('chapters')).count(IDBKeyRange.bound([bookId, -Infinity], [bookId, Infinity])));
}
export async function chapterBatch(bookId, after = -Infinity, count = 100) {
  return wrap((await tx('chapters')).getAll(IDBKeyRange.bound([bookId, after], [bookId, Infinity], true, false), count));
}

/** A reading session by when it was and what it counted -- not by its book, whose number can change. */
export function eventSignature(event) {
  return `${event.at}:${event.activeMs || 0}:${event.pages || 0}:${event.words || 0}:${event.elsewhere ? 1 : 0}`;
}

/**
 * The log tidied, once: a session there twice (restored twice, under two
 * books) kept once -- the copy under a book on the shelf, if either is. Said
 * how many were taken out.
 */
export async function dedupeEvents() {
  const events = await all('events');
  const books = new Set((await all('books')).filter((b) => !b.binnedAt).map((b) => b.id));
  const best = new Map();
  for (const event of events) {
    const key = eventSignature(event);
    const kept = best.get(key);
    if (!kept) { best.set(key, event); continue; }
    const better = !books.has(kept.bookId) && books.has(event.bookId);
    const loser = better ? kept : event;
    if (better) best.set(key, event);
    await del('events', loser.id);
  }
  return events.length - best.size;
}

/**
 * The log made right, as far as it can be: each session there once
 * (dedupeEvents), and none counting more pages than its time allows -- a
 * page a second and a half, as the reader now counts (reader.js countPage).
 * Sessions recorded before that counted jumps as reading: thousands of
 * pages in a few seconds. Those are brought down to what the time allows,
 * their words with them in the same proportion. Copied-out reading, which
 * has no pages, is left as it is. Returns what was changed.
 */
export async function repairEvents() {
  const doubled = await dedupeEvents();
  let capped = 0;
  for (const event of await all('events')) {
    if (event.elsewhere || !(event.pages > 0)) continue;
    const most = Math.max(1, Math.ceil((event.activeMs || 0) / 1500));
    if (event.pages <= most) continue;
    const share = most / event.pages;
    await put('events', { ...event, pages: most, words: Math.round((event.words || 0) * share) });
    capped += 1;
  }
  return { doubled, capped };
}

/** The newest book's id (books only ever get higher ones), without reading them all. */
export async function lastBookId() {
  const request = (await tx('books')).openKeyCursor(null, 'prev');
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ? request.result.key : 0);
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
  const t = await transaction(store, 'readwrite');
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
  const t = await transaction(['books', 'chapters', 'images', 'marks', 'positions'], 'readwrite');
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
  // The theme's gradient (marks, pause and resume, progress): null follows the accent,
  // else { from, to, stops: [{ color, share }] } -- two to five colours (theme.gradientOf).
  gradient: null,
  // Its direction everywhere: 'auto' (each place its own), or an angle in degrees, 0 to 359 (theme.gradientAngle).
  gradientDir: 'auto',
  // The app's buttons and edges in the gradient's colours, each solid by its role, or in the gradient itself.
  colourStyle: 'solid',
  // Kinds of notice that do not pop up, only kept under the bell (screens.js NOTICE_TOPICS).
  noticesOff: [],
  // Fonts of your own, to read in: [{ id, name }] (the files themselves kept apart, see fonts.js).
  fonts: [],
  veil: 0.62,                     // 62% in dark, 28% in light
  columns: 2,
  // Which folder the shelf is filtered to: null for everything, '' for
  // unfiled. Kept with the rest of the shelf's arrangement rather than in a
  // module variable, which forgot it on every launch.
  shelfFolder: null,
  // How much the copy button copies: 'page', 'half' (of the chapter) or 'chapter'.
  copyAmount: 'chapter',
  // Folders kept off the main shelf. Their books are still in them, and the
  // folder is still listed under Folders; opening it there shows them.
  hiddenFolders: [],
  sort: { keys: [['lastRead', 'desc'], ['author', 'asc']], group: [] },
  // A book being read and not read for this many days goes On hold by
  // itself, the one read last excepted (library.holdQuietBooks). 0 for never.
  autoHoldDays: 5,
  // Looks saved by name, to switch between (theme.js, themesField in panels).
  savedThemes: [],
  // The reader's own instructions for an AI model, by the language translated
  // from (ko, ja, zh, other); none is the usual (translate.DEFAULT_PROMPT).
  translatePrompts: {},
  // An AI model that can see is shown the page when translating its text.
  aiSeesPage: true,
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
  // Where pictures go and what shape, as fractions of the screen; null for the whole page.
  pictureFrame: null,

  /* Showing colour pages in grey.
   *
   * off | plain | contrast | crisp | eink. Not a saving of anything -- the file is
   * unchanged and the original is one tap away -- but a coloured page greyed
   * naively reads flatter than the black-and-white it was drawn as, and the
   * contrast is recoverable.
   */
  greyscale: 'off',

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

  /* Turning a chapter, put where the thumb is.
   *
   * The footer is the one place a tall phone cannot be reached without
   * regripping, and in a comic -- where a chapter is a whole volume -- it is
   * the control used most. So it can float: dragged anywhere, resized, and
   * flipped to whichever side the hand is on.
   *
   * Vertical with up as onward, because that is how a thumb reads a stack.
   * Locked by default, because an unlocked control over the page is one that
   * moves every time you meant to press it. The copy button is not part of
   * this and stays in the footer: copying is done with two hands.
   */
  chapterPad: {
    on: false,
    x: 88,            // percentages, so rotation does not lose it
    y: 64,
    scale: 1,         // 0.7–1.6
    vertical: true,   // up is the next chapter
    locked: true,
    side: 'right',
  },

  /* Guides. Both are off by default: they help a great deal with dense
     non-fiction, textbooks, dyslexia and tired eyes, and are a distraction
     for anyone who does not need them. */
  readingRuler: false,
  focusMode: 'off',         // off | paragraph | line

  /* Typography that only matters at a page boundary. */
  keepParagraphs: false,    // never split a paragraph across a page

  readingMode: 'paged',
  endlessScroll: true,

  translateTarget: 'EN-US',
  streakPages: 10,
  streakMinutes: 10,
  heatRamp: 'ink',
  imageThreshold: 64,             // hides decorative rules
  vaultPassphrase: null,          // stored as a hash, never plaintext
  vaultHideFromStats: true,
};

let cache = null;

/**
 * Settings from a file this app exported: each one the app knows, of the
 * kind it takes (a number for a number, a list for a list), taken; anything
 * else left as it is. A background picture is taken only when it is carried
 * in the file itself.
 *
 * @returns how many were taken
 */
export async function importSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('That file is not a settings file.');
  const patch = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(key in DEFAULT_SETTINGS) || key === 'lastCrash' || DEVICE_SETTINGS.includes(key)) continue;
    const wanted = DEFAULT_SETTINGS[key];
    if (key === 'backgroundImage') {
      if (value === null || (typeof value === 'string' && /^data:image\//i.test(value))) patch[key] = value;
      continue;
    }
    const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    if (wanted === null || wanted === undefined || kind(value) === kind(wanted)) patch[key] = value;
  }
  if (!Object.keys(patch).length) throw new Error('There are no settings of this app in that file.');
  await saveSettings(patch);
  return Object.keys(patch).length;
}

export async function settings() {
  if (cache) return cache;
  const row = await get('settings', 'app');
  cache = Object.assign({}, DEFAULT_SETTINGS, row ? row.value : {});
  return cache;
}

/* Each change put onto the settings as they are when it lands, and written in
 * turn, the newest whole. Two saves at once -- the queue's and the leftovers',
 * say -- each merged onto the same copy read before either, and whichever
 * wrote last undid the other. */
let settingsWrite = Promise.resolve();
export async function saveSettings(patch) {
  await settings();
  cache = Object.assign({}, cache, patch);
  const write = settingsWrite.then(() => put('settings', { key: 'app', value: cache }));
  settingsWrite = write.catch(() => {});
  await write;
  return cache;
}

export const DEFAULT_LAYOUT = {
  face: 'Newsreader',
  size: 17,          // 13–30
  leading: 1.62,     // 1.1–2.6
  para: 12,          // 0–44
  margin: 24,        // 8–64, left and right
  vmargin: 16,       // 0–80, top and bottom
  edges: null,       // { l, r, t, b } px: the text border drawn on the page, over the two above
  justified: false,
  ink: null,         // null inherits the theme's text colour
};

/* Margins belong to the screen, not the book.
 *
 * How far the text sits from the edges of the phone is a matter of the phone
 * and the hand holding it, and it is the same for every book. Kept per book,
 * a margin set once in one book and changed later in Settings never reached
 * it -- which is how the margin setting came to look as though it did
 * nothing. So these are always the app's, wherever they are changed from. */
export const SCREEN_KEYS = ['margin', 'vmargin', 'edges'];

/**
 * What a book has been set to itself.
 *
 * Only the settings changed in that book. Every row used to be a full copy of
 * the layout as it stood when anything at all was changed, so moving the font
 * size once in a book froze every other setting for it, and the defaults in
 * Settings stopped reaching it. A row from then is read for what differs from
 * the defaults now, which is the most that can be told of what was meant.
 */
function ownOf(row, base) {
  if (!row || !row.value) return {};
  const own = {};
  const keys = Array.isArray(row.own) ? row.own : Object.keys(row.value);
  for (const key of keys) {
    if (SCREEN_KEYS.includes(key) || !(key in row.value)) continue;
    if (!Array.isArray(row.own) && row.value[key] === base[key]) continue;
    own[key] = row.value[key];
  }
  return own;
}

/** Per-book override wins over the app default; deleting the row inherits again. */
export async function layoutFor(bookId) {
  const [own, base] = await Promise.all([bookId ? get('layout', bookId) : null, get('layout', 0)]);
  const defaults = Object.assign({}, DEFAULT_LAYOUT, base ? base.value : {});
  return Object.assign({}, defaults, bookId ? ownOf(own, defaults) : {});
}

export async function saveLayout(bookId, patch) {
  const screen = {};
  const book = {};
  for (const [key, value] of Object.entries(patch)) {
    if (bookId && SCREEN_KEYS.includes(key)) screen[key] = value;
    else book[key] = value;
  }
  if (Object.keys(screen).length) await saveLayout(0, screen);
  if (!bookId) {
    const current = await layoutFor(0);
    await put('layout', { bookId: 0, value: Object.assign({}, current, book) });
    return layoutFor(0);
  }
  if (Object.keys(book).length) {
    const row = await get('layout', bookId);
    const base = await layoutFor(0);
    const own = Object.assign(ownOf(row, base), book);
    await put('layout', { bookId, value: own, own: Object.keys(own) });
  }
  return layoutFor(bookId);
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

/* The book's record is read, changed and written back by both of these.
 * Run side by side -- the first page turned, and the book left straight
 * after -- one wrote over the other: the status the reading set came back,
 * or the position was lost. So they take turns. */
let bookWrites = Promise.resolve();
function inTurn(work) {
  const run = bookWrites.then(work, work);
  bookWrites = run.catch(() => {});
  return run;
}

export async function flushPosition() {
  clearTimeout(writeTimer);
  if (!pending) return inTurn(() => {});   // still waits for a reading being noted
  const row = pending;
  pending = null;
  await put('positions', row);
  return inTurn(() => positionOnBook(row));
}

async function positionOnBook(row) {
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
export function markRead(bookId) {
  return inTurn(() => noteRead(bookId));
}

async function noteRead(bookId) {
  const book = await get('books', bookId);
  if (!book) return;
  book.lastReadAt = Date.now();
  book.lastOpenedAt = book.lastReadAt;
  /* A status set by hand is set once, not pinned for good.
   *
   * Marking a book "On hold" says where it stands now. Picking it up again
   * says otherwise, and having to go back and set it to Automatic before the
   * shelf would believe it was being read was a chore nobody remembered. So
   * the status stands until the book is next read, and the reading takes
   * over from there. */
  delete book.status;
  delete book.heldAt;
  delete book.heldAutomatically;
  await put('books', book);
  /* Its other editions too: a bundle is one book, so a status set on it --
   * by hand on the bundle, or On hold when it was left -- is over for all of
   * them once any is read, not left on the editions not opened. */
  if (book.bundleId != null) {
    for (const other of await all('books')) {
      if (other.id === book.id || other.bundleId !== book.bundleId) continue;
      if (other.status === undefined && !other.heldAt) continue;
      delete other.status;
      delete other.heldAt;
      delete other.heldAutomatically;
      await put('books', other);
    }
  }
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
  /* In the bin, and blurred on the shelf.
   *
   * Both are things done to a book rather than properties of its file, so
   * neither comes back from re-importing it -- and a restore that put every
   * binned book back on the shelf, uncovered, would undo exactly the two
   * decisions somebody made deliberately. */
  'binnedAt', 'coverBlur',
  /* Put on hold by the app (not read for days), not by hand: kept apart in a
   * backup as on the shelf, so a restore does not turn one into the other. */
  'heldAt', 'heldAutomatically',
];

/* A book's reading as it stands: where it is, how far, whether being read.
 * A restore puts these back only onto a book not read since the backup --
 * restored over a book read since, it took the book back to then, its place
 * and its shelf (Reading to On hold) with it. */
const READING_FIELDS = new Set(['status', 'percent', 'lastReadAt', 'lastOpenedAt', 'finishedAt', 'heldAt', 'heldAutomatically']);

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

/**
 * What a backup leaves alone: this phone's downloads and folders, not your
 * settings. The queue, Build's leftovers and where each website stopped name
 * books by their number in this phone's storage -- numbers that mean other
 * books once storage is wiped and the books imported again, so a restored
 * queue carried on and binned the wrong books. The automatic backup's and
 * export's state names folders this phone was given, and the files written
 * there. Never written into a backup; one from before that has them, they
 * are passed over and this phone's own kept.
 */
// exportRun too: the books an export cut off had saved, by this phone's numbers for them.
export const DEVICE_SETTINGS = ['webQueue', 'queueRunning', 'webLeftovers', 'webStops', 'autoExport', 'autoBackup', 'exportRun', 'translateJobs', 'restoredAt'];
const withoutDevice = (value) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));

export async function exportBackup() {
  const books = await all('books');
  const byId = new Map(books.map((b) => [b.id, b]));

  const out = {
    format: 'grimoire-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: withoutDevice(await settings()),
    // Kept out of the settings blob as well, so an export is a record of how
    // imports have actually behaved rather than only the most recent one.
    imports: (await settings()).importHistory || [],
    views: await all('views'),
    /* Each session with the book it was of, by what lasts (its fingerprint):
     * the number it has here means another book on a phone whose storage was
     * started afresh, and restored by number the log went to the wrong books. */
    events: (await all('events')).map((e) => ({ ...e, fingerprint: byId.get(e.bookId)?.fingerprint || e.fingerprint || null })),
    layout: await all('layout'),

    books: books
      .filter((b) => !b.importing && !b.transient && b.fingerprint)
      .map((book) => {
        const kept = { fingerprint: book.fingerprint };
        /* What it was imported from, when it was imported from one of this
         * app's own exports: that is what an export of it carries again, so a
         * book imported afresh is matched by it exactly -- where its
         * fingerprint, its file's name and size, is another every time. */
        if (book.sourceId) kept.sourceId = book.sourceId;
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

    /* Glossaries: typed by hand, or found at the cost of a model's time --
     * like a chosen cover, they exist nowhere else. A series' glossary is
     * the series'; a book's goes with the book it belongs to. */
    glossaries: (await all('translations'))
      .filter((row) => row.lang === 'glossary')
      .map((row) => ({ key: row.key, value: row.value, fingerprint: byId.get(row.bookId)?.fingerprint || null })),
  };

  /* Carried on, not dropped: a restore still waiting for some of its books
   * to be imported holds things no other copy of the app has. A backup made
   * in the meantime keeps them. */
  const pending = await pendingRestore();
  const present = new Set(out.books.map((b) => b.fingerprint));
  for (const [fingerprint, record] of Object.entries(pending.books)) {
    if (present.has(fingerprint)) continue;
    if (record.saved) out.books.push(record.saved);
    if (record.cover) out.covers.push({ fingerprint, dataUrl: record.cover });
    out.positions.push(...record.positions);
    out.marks.push(...record.marks);
  }
  return out;
}

/* ── a restore, one book at a time ─────────────────────────────────────── */

/** Everything a backup says about each book, gathered by fingerprint. */
function recordsOf(data) {
  const records = new Map();
  const of = (fingerprint) => {
    if (!records.has(fingerprint)) records.set(fingerprint, { saved: null, cover: null, positions: [], marks: [] });
    return records.get(fingerprint);
  };
  for (const saved of data.books || []) if (saved.fingerprint) of(saved.fingerprint).saved = saved;
  for (const cover of data.covers || []) if (cover.fingerprint && cover.dataUrl) of(cover.fingerprint).cover = cover.dataUrl;
  for (const position of data.positions || []) if (position.fingerprint) of(position.fingerprint).positions.push(position);
  for (const mark of data.marks || []) if (mark.fingerprint) of(mark.fingerprint).marks.push(mark);
  return records;
}

/**
 * Put one book's record back onto it: what was done to it, its cover if one
 * was chosen, where it was read to, and its marks.
 *
 * @returns how many marks were added.
 */
async function restoreInto(book, record, report = null) {
  const { saved } = record;
  const readSince = !!saved && (book.lastReadAt || 0) > (saved.lastReadAt || 0);
  if (saved) {
    for (const field of BOOK_FIELDS) {
      if (readSince && READING_FIELDS.has(field)) continue;
      if (saved[field] !== undefined) book[field] = saved[field];
    }
    /* Put on hold here by the app, and not so in the backup: as backed up.
     * (A hold set by hand here stays.) */
    if (!readSince && book.heldAutomatically && saved.heldAt === undefined) {
      if (book.status === 'onHold' && saved.status === undefined) delete book.status;
      delete book.heldAt;
      delete book.heldAutomatically;
    }
    /* Absent means it was not in the bin, not "leave it as it is".
     *
     * Every other field here is additive, and for the bin that is wrong: a
     * book put back on the shelf after the backup was made would come out of
     * a restore still in the bin, because nothing was written to say
     * otherwise. A restore is meant to reproduce what was recorded. The same
     * goes for a blur taken off since. */
    if (saved.binnedAt === undefined) delete book.binnedAt;
    if (saved.coverBlur === undefined) delete book.coverBlur;
  }

  let coverBack = false;
  if (record.cover) {
    try {
      const blob = dataUrlToBlob(record.cover);
      book.coverBlob = blob;
      book.coverBytes = blob.size;
      book.coverCustom = true;
      coverBack = true;
      if (report) report.covers = (report.covers || 0) + 1;
    } catch {
      // A cover that will not decode is not worth failing a restore over.
    }
  }
  await put('books', book);

  /* And into the book, as it was when the backup was made: a chosen cover is
   * part of the book now, not only the picture on the shelf (see
   * coverpage.js). Loaded when needed, which keeps the store free of a
   * dependency on the reader's markup. */
  if (coverBack) {
    try {
      const { placeCover } = await import('./coverpage.js');
      await placeCover(book.id, book.coverBlob);
      const fresh = await get('books', book.id);
      // Carried onto the copy the caller holds, which it may write again.
      book.coverPage = fresh.coverPage;
      book.imageCount = fresh.imageCount;
    } catch (error) {
      console.warn('Could not put the chosen cover into the book', error);
    }
  }

  // A place read on to here since the backup is kept: never taken back to the backup's.
  const here = await get('positions', book.id).catch(() => null);
  for (const position of record.positions) {
    const { fingerprint, ...row } = position;
    if (readSince || (here?.updatedAt && row.updatedAt && here.updatedAt > row.updatedAt)) continue;
    await put('positions', { ...row, bookId: book.id });
  }

  /* Restoring twice must not leave two of everything.
   *
   * Marks were added outright, so a second restore -- after a failed one, or
   * simply to be sure -- doubled every bookmark. A mark carries enough to
   * recognise itself: where it sits in its book. */
  let added = 0;
  if (record.marks.length) {
    const seen = new Set((await byIndex('marks', 'bookId', book.id))
      .map((m) => `${m.kind}:${m.chapterIndex}:${m.anchor}`));
    for (const mark of record.marks) {
      const { fingerprint, id, ...row } = mark;
      const signature = `${row.kind}:${row.chapterIndex}:${row.anchor}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      await add('marks', { ...row, bookId: book.id });
      added += 1;
    }
  }
  return added;
}

/* What a restore could not hand over yet, kept until the book arrives.
 * Held beside the settings rather than in them: it can carry marks and
 * covers, and the settings are read on every screen. */
const PENDING_KEY = 'pendingRestore';
let pendingCache = null;

async function pendingRestore() {
  if (!pendingCache) {
    const row = await get('settings', PENDING_KEY);
    pendingCache = row?.value || { books: {}, leaders: {} };
    if (!pendingCache.books) pendingCache.books = {};
    if (!pendingCache.leaders) pendingCache.leaders = {};
  }
  return pendingCache;
}

async function savePending(pending) {
  pendingCache = pending;
  if (!Object.keys(pending.books).length && !Object.keys(pending.leaders).length) {
    await del('settings', PENDING_KEY);
  } else {
    await put('settings', { key: PENDING_KEY, value: pending });
  }
}

/** How many books a restore is still waiting to see imported. */
export async function pendingRestoreCount() {
  const pending = await pendingRestore();
  return Object.values(pending.books).filter((record) => record.saved).length;
}

/* ── matching a backup's books to the books here ───────────────────────
 *
 * A backup knows each book by its fingerprint: the file's name and size as
 * it was imported ("name.epub:65465871"). The same book can come back under
 * another: imported from inside a zip, its path in the zip goes in front
 * ("Books/slop/name.epub:65465871"); written out by this app and imported
 * again, it is a new file that names the old one inside it (sourceId); built
 * in the app and downloaded again, it is "built:" and a new time. Matched
 * only on the exact fingerprint, a restore after importing again found none
 * of them, and said every book was not there. So, in turn: the fingerprint;
 * the one the file names; the file's own name and size wherever it sat; and,
 * where there is only one book of that title on each side, the title. */
export const looseKey = (fingerprint) => {
  const text = String(fingerprint || '');
  if (/^(built|merged|part|split|pictures):/.test(text)) return '';
  const m = /^(.*?):(\d+)(?::.*)?$/.exec(text);
  return m ? `${m[1].split('/').pop().normalize('NFC').toLowerCase()}:${m[2]}` : '';
};
export const titleKey = (title) => String(title || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Finds, for a backup's fingerprint and title, the one book here that is it -- or null. */
function bookMatcher(books) {
  const live = books.filter((b) => !b.transient && !b.importing);
  const byPrint = new Map(live.map((b) => [b.fingerprint, b]));
  const bySource = new Map(live.filter((b) => b.sourceId).map((b) => [b.sourceId, b]));
  const group = (keyOf) => {
    const map = new Map();
    for (const b of live) {
      const key = keyOf(b);
      if (!key) continue;
      map.set(key, map.has(key) ? null : b);   // null: more than one, so none
    }
    return map;
  };
  const byLoose = group((b) => looseKey(b.fingerprint));
  const byTitle = group((b) => titleKey(b.title));
  const match = (fingerprint, title, titleUnique = true, sourceId = null) => byPrint.get(fingerprint)
    || bySource.get(fingerprint)
    || (sourceId ? byPrint.get(sourceId) || bySource.get(sourceId) : null)
    || byLoose.get(looseKey(fingerprint))
    || (titleUnique ? byTitle.get(titleKey(title)) : null)
    || null;
  /** The one book here of this title, or null (none, or more than one). */
  match.byTitle = (title) => byTitle.get(titleKey(title)) || null;
  return match;
}

/* Of several of a backup's records for one book here, the one to put back:
 * the furthest along -- read last, then read furthest, then given a status,
 * then added last. A library imported twice over held each book twice (the
 * book and its copy, the same in all but name), and every such title was
 * left unmatched rather than guessed at: a restore into the books imported
 * afresh put back a third of them, and the books being read none at all. */
/** Records that are copies of one book: added at the same moment -- or,
 *  where when is not known, kept in the same folder. */
function sameBook(list) {
  return new Set(list.map(([, r]) => (Number.isFinite(r.saved?.addedAt) ? `a:${r.saved.addedAt}` : `f:${r.saved?.folder ?? ''}`))).size === 1;
}

/** How far a record's book was filed: in a bundle, then how deep its folder. */
function filing(record) {
  const saved = record.saved || {};
  return (saved.bundleLeader ? 100 : 0) + String(saved.folder || '').split('/').filter(Boolean).length;
}

function furthestRecord(records) {
  const score = (r) => [r.saved?.lastReadAt || 0, r.saved?.percent || 0, r.saved?.status ? 1 : 0, r.positions.length, r.saved?.addedAt || 0];
  return records.slice().sort((a, b) => {
    const x = score(a); const y = score(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0] || null;
}

/** The waiting record a book just imported is, by the same steps, from its side. */
function pendingFor(book, pending) {
  if (pending.books[book.fingerprint]) return book.fingerprint;
  if (book.sourceId && pending.books[book.sourceId]) return book.sourceId;
  const keys = Object.keys(pending.books);
  if (book.sourceId) {
    const bySource = keys.find((key) => pending.books[key].saved?.sourceId === book.sourceId);
    if (bySource) return bySource;
  }
  const loose = looseKey(book.fingerprint);
  const title = titleKey(book.title);
  const one = (list) => (list.length === 1 ? list[0] : null);
  if (loose) {
    const found = one(keys.filter((key) => looseKey(key) === loose));
    if (found) return found;
  }
  if (!title) return null;
  // Of a title held more than once (a book and its copy), the furthest along.
  const named = keys.filter((key) => titleKey(pending.books[key].saved?.title) === title);
  if (named.length <= 1) return named[0] || null;
  // Copies of one book only (added together, into one folder): two books of one title are not guessed between.
  if (new Set(named.map((key) => `${pending.books[key].saved?.addedAt ?? ''}|${pending.books[key].saved?.folder ?? ''}`)).size > 1) return null;
  const best = furthestRecord(named.map((key) => pending.books[key]));
  return named.find((key) => pending.books[key] === best) || null;
}

/**
 * A book has just been imported: give it whatever a restore was holding for
 * it, and join it to its bundle if that was waiting too.
 *
 * Cheap when there is nothing waiting, which is nearly always: one lookup in
 * memory.
 *
 * @returns whether anything was restored onto it.
 */
export async function restorePending(book) {
  if (!book?.fingerprint || book.transient) return false;
  const pending = await pendingRestore();
  const key = pendingFor(book, pending);
  const record = key ? pending.books[key] : null;
  const members = pending.leaders[book.fingerprint] || (key && key !== book.fingerprint ? pending.leaders[key] : null);
  if (!record && !members) return false;

  if (record) {
    delete pending.books[key];
    await restoreInto(book, record);
    const leaderPrint = record.saved?.bundleLeader;
    if (leaderPrint) {
      const leader = leaderPrint === book.fingerprint
        ? book
        : (await byIndex('books', 'fingerprint', leaderPrint)).find((b) => !b.transient);
      if (leader) {
        book.bundleId = leader.id;
        await put('books', book);
      } else {
        if (!pending.leaders[leaderPrint]) pending.leaders[leaderPrint] = [];
        pending.leaders[leaderPrint].push(book.fingerprint);
      }
    }
  }

  if (members) {
    delete pending.leaders[book.fingerprint];
    if (key) delete pending.leaders[key];
    for (const fingerprint of members) {
      for (const member of await byIndex('books', 'fingerprint', fingerprint)) {
        if (member.transient) continue;
        member.bundleId = book.id;
        await put('books', member);
      }
    }
  }

  await savePending(pending);
  return !!record;
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
    throw new Error('That is not a backup file from this app.');
  }
  if (data.version > BACKUP_VERSION) {
    throw new Error('That backup was made by a newer version of the app.');
  }

  const report = { settings: false, books: 0, missing: 0, marks: 0, events: 0, covers: 0 };

  if (data.settings) {
    // Merged over the defaults, so a backup from an older version does not
    // remove settings it had never heard of.
    // This phone's queue, leftovers and folders kept as they are (DEVICE_SETTINGS).
    const here = await settings();
    const own = Object.fromEntries(DEVICE_SETTINGS.filter((key) => key in here).map((key) => [key, here[key]]));
    cache = Object.assign({}, DEFAULT_SETTINGS, withoutDevice(data.settings), own);
    await put('settings', { key: 'app', value: cache });
    report.skipped = DEVICE_SETTINGS.filter((key) => key in data.settings && (Array.isArray(data.settings[key]) ? data.settings[key].length : data.settings[key] != null));
    report.settings = true;
  }

  for (const view of data.views || []) await put('views', view);
  for (const row of data.layout || []) await put('layout', row);

  const books = await all('books');
  const pending = await pendingRestore();
  const records = recordsOf(data);
  // Each of the backup's books to the book here that is it (see bookMatcher).
  const match = bookMatcher(books);
  /* Every record that is a book here, gathered before any is put back.
   *
   * A book imported again from one of this app's exports is found by what it
   * came from -- and a book and its copy (the library imported over itself)
   * came from the same thing, so both their records are this one book. The
   * first found used to win, and it was mostly the original: the copy, the
   * one read on and moved and bundled, was set aside -- a book back at Nov
   * 13's 38% where it had been read to 60% on Nov 20, folders and editions as
   * they were before. Now all of a book's records are put together: its
   * reading from the one read last, its folder and its bundle from the one
   * filed furthest (bundled, then the deeper folder), its marks from them all.
   * The others are copies of it, and stand for it. */
  const claims = new Map();   // book id -> [fingerprint, record][]
  const claimed = new Set();
  const claim = (book, fingerprint, record) => {
    if (!claims.has(book.id)) claims.set(book.id, []);
    claims.get(book.id).push([fingerprint, record]);
    claimed.add(fingerprint);
  };
  // Exactly -- by fingerprint, by what it was imported from, by file.
  for (const [fingerprint, record] of records) {
    const book = match(fingerprint, null, false, record.saved?.sourceId || null);
    if (book) claim(book, fingerprint, record);
  }
  /* Then by title: the one book here of that title takes the records of it
   * that are copies of one book (added at the same moment, or kept in one
   * folder when that is not known) -- and of the book's own, when it has
   * records already. Two books of one title that are not are still not
   * guessed between. */
  const byTitle = new Map();
  for (const [fingerprint, record] of records) {
    if (claimed.has(fingerprint)) continue;
    const key = titleKey(record.saved?.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push([fingerprint, record]);
  }
  for (const [key, group] of byTitle) {
    const book = match.byTitle(key);
    if (!book) continue;
    const all = [...group, ...(claims.get(book.id) || [])];
    if (all.length > 1 && !sameBook(all)) continue;
    for (const [fingerprint, record] of group) claim(book, fingerprint, record);
  }
  const matched = new Map();
  const copies = new Set();
  const copyOf = new Map();
  const merged = new Map();   // fingerprint -> the record put back, made of all the book's
  const booksById = new Map(books.map((b) => [b.id, b]));
  for (const [bookId, list] of claims) {
    const book = booksById.get(bookId);
    const recs = list.map(([, record]) => record);
    const reading = furthestRecord(recs);
    const filed = recs.slice().sort((a, b) => filing(b) - filing(a))[0] || reading;
    const [fingerprint] = list.find(([, record]) => record === reading);
    const saved = reading.saved || filed.saved ? {
      ...(filed.saved || {}), ...(reading.saved || {}),
      folder: filed.saved?.folder ?? reading.saved?.folder,
      bundleLeader: filed.saved?.bundleLeader ?? reading.saved?.bundleLeader,
    } : null;
    if (saved && saved.folder === undefined) delete saved.folder;
    if (saved && saved.bundleLeader === undefined) delete saved.bundleLeader;
    merged.set(fingerprint, {
      saved,
      cover: reading.cover || recs.find((r) => r.cover)?.cover || null,
      positions: reading.positions.length ? reading.positions : (recs.find((r) => r.positions.length)?.positions || []),
      marks: recs.flatMap((r) => r.marks),
    });
    matched.set(fingerprint, book);
    for (const [other] of list) if (other !== fingerprint) { copies.add(other); copyOf.set(other, book); }
  }
  const byFingerprint = { get: (fingerprint) => matched.get(fingerprint) || copyOf.get(fingerprint) };

  /* A book not on the shelf yet is kept for when it is.
   *
   * A restore used to be an instant: whatever was on the shelf at that moment
   * got its blur, its folder, its place and its marks back, and everything
   * else was counted as missing and dropped. Restoring first and importing
   * second -- the natural order after a reinstall -- lost all of it, blurred
   * covers included. What cannot be matched now is held, and handed over as
   * each book is imported. */
  for (const [fingerprint, held] of records) {
    if (copies.has(fingerprint)) { report.copies = (report.copies || 0) + 1; continue; }
    const book = matched.get(fingerprint);
    const record = (book && merged.get(fingerprint)) || held;
    if (!book) {
      pending.books[fingerprint] = record;
      if (record.saved) report.missing += 1;
      continue;
    }
    report.marks += await restoreInto(book, record, report);
    if (record.saved) report.books += 1;
  }

  // Bundles last: a bundle's leader may not have existed on the first pass,
  // and may not exist until it is imported.
  for (const [fingerprint, original] of records) {
    const record = merged.get(fingerprint) || original;
    const leaderPrint = record.saved?.bundleLeader;
    const book = matched.get(fingerprint);
    if (!leaderPrint || !book) continue;
    const leader = byFingerprint.get(leaderPrint);
    if (leader) {
      book.bundleId = leader.id;
      await put('books', book);
    } else {
      if (!pending.leaders[leaderPrint]) pending.leaders[leaderPrint] = [];
      pending.leaders[leaderPrint].push(fingerprint);
    }
  }
  await savePending(pending);

  // Glossaries: a series' as it was; a book's under the book's id here.
  for (const row of data.glossaries || []) {
    if (typeof row?.key !== 'string' || typeof row.value !== 'string') continue;
    const book = row.fingerprint ? byFingerprint.get(row.fingerprint) : null;
    let key = row.key;
    if (key.startsWith('glossary:book:')) {
      if (!book) continue;
      key = `glossary:book:${book.bundleId != null ? book.bundleId : book.id}`;
    } else if (!key.startsWith('glossary:series:')) continue;
    await put('translations', { key, bookId: book ? book.id : -1, field: 'glossary', lang: 'glossary', value: row.value, at: Date.now() });
    report.glossaries = (report.glossaries || 0) + 1;
  }

  /* The log is keyed by book too, but a reading history is worth keeping
   * even for books no longer on the shelf.
   *
   * Its book found by fingerprint, as the places are -- never by the number
   * it had where the backup was made, which is another book here once
   * storage has been started afresh. A backup from before sessions carried a
   * fingerprint keeps them, of no book, rather than give them to the wrong
   * one. And a session already here is known by when it was and what it
   * counted, whichever book it is under: known by book as well, restoring the
   * same backup twice added the whole log again under other books. */
  const eventSeen = new Set((await all('events')).map(eventSignature));
  for (const event of data.events || []) {
    const { id, fingerprint, ...row } = event;
    const book = fingerprint ? byFingerprint.get(fingerprint) : null;
    const bookId = book ? book.id : null;
    const signature = eventSignature(row);
    if (eventSeen.has(signature)) continue;
    eventSeen.add(signature);
    await add('events', { ...row, bookId, ...(fingerprint && !book ? { fingerprint } : {}) });
    report.events += 1;
  }
  // What came in made right too: a backup from before carries the old counting.
  report.eventsFixed = await repairEvents().catch(() => null);

  // The shelf as backed up: nothing put on hold for days counted before now (library.goneQuiet).
  await saveSettings({ restoredAt: Date.now() });

  return report;
}
