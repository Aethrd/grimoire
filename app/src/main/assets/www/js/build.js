/* The workshop.
 *
 * Several files in, one book out.
 *
 * A serial arrives as a folder of parts: volume 1, volume 2, an image archive
 * of the colour pages, a zip someone made of chapters 40 to 60. Reading it
 * means opening each in turn, losing your place at every boundary and
 * watching progress reset to nothing a dozen times.
 *
 * Joining books already on the shelf was the wrong shape for that. The parts
 * are files, not library entries -- importing thirty volumes only to join
 * them and delete thirty leftovers is a lot of work to arrive where you
 * wanted to start. So this takes the files directly.
 *
 * What it does not do is hide the order. Order is the whole point of a
 * serial, so it is shown, numbered, and movable before anything is built.
 */

import { isRar, rarToZip, zipNameFor } from './rar.js';
import * as store from './store.js';
import {
  parse, parseChapters, formatOf, expandArchive, asEpubName, nameWithFormat, chapterHtml, UNSUPPORTED_REASON,
  coverOf, picturesInFile,
} from './parse.js';
import { planBooks } from './group.js';
import { readPages, PAUSED_REASON } from './web.js';

/** The parts waiting to be built, in the order they will be joined. */
let parts = [];

export const contents = () => parts;

/* The first part's cover, looked up once per part rather than on every
 * redraw of the workshop: finding it can mean opening the file. */
const covers = new WeakMap();

/**
 * The pictures a part holds, for choosing a cover from: [{ name, load() }].
 * A book on the shelf has them stored already; a file is looked into without
 * being read through (see picturesInFile).
 */
export async function picturesOf(part) {
  if (part.bookId) {
    const stored = (await store.byIndex('images', 'bookId', part.bookId))
      .filter((image) => image.blob && !image.removed && image.blob.size >= 1024)
      .sort((a, b) => a.order - b.order);
    return stored.map((image) => ({ name: image.href.split('/').pop(), load: async () => image.blob }));
  }
  if (part.web) return part.coverBlob ? [{ name: 'cover', load: async () => part.coverBlob }] : [];
  if (part.pictures?.length) return part.pictures.map((file) => ({ name: file.name, load: async () => file }));
  if (part.file && !part.prefix) return picturesInFile(part.file);
  return [];
}

/** The cover a build gets when none is chosen: the first part's. */
export function firstCover() {
  const first = parts[0];
  if (!first) return Promise.resolve(null);
  if (!covers.has(first)) {
    covers.set(first, (async () => {
      if (first.coverBlob) return first.coverBlob;
      if (first.bookId) return (await store.get('books', first.bookId))?.coverBlob || null;
      if (first.pictures?.length) return first.pictures[0];
      if (first.file && !first.prefix) return coverOf(first.file);
      return null;
    })().catch(() => null));
  }
  return covers.get(first);
}
export const isEmpty = () => parts.length === 0;

/** 'Volume 2' before 'Volume 10', which plain text sorting gets backwards. */
export const naturalOrder = (a, b) => String(a || '').localeCompare(String(b || ''),
  undefined, { numeric: true, sensitivity: 'base' });

/**
 * Take files in, expanding any archive that holds books.
 *
 * A zip of volumes is the usual way a serial is kept, and treating it as one
 * part would join it to itself. Its contents become parts instead, so what is
 * listed is what will actually be joined.
 */
const IS_PICTURE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

export async function add(files, onProgress) {
  const found = [];

  /* Every file is identified before anything is decided about it.
   *
   * The picker accepts anything, so a file may arrive with no extension or a
   * misleading one. What it actually is comes from its first bytes, and that
   * answer is what the rest of this works from.
   */
  const identified = [];
  for (const picked of files) {
    let file = picked;
    /* A RAR is unpacked into the ZIP it could have been, and is a part like
     * any .cbz or .zip from then on (see rar.js). By its first bytes, not
     * only its name: a .cbr is as often a ZIP that was renamed. */
    if (/\.(rar|cbr|cbz|zip)$/i.test(file.name || '') || !/\.[a-z0-9]{1,10}$/i.test(file.name || '')) {
      if (await isRar(file).catch(() => false)) {
        file = await rarToZip(file, (fraction, inner) => onProgress?.(`Unpacking ${inner || file.name}`, fraction));
      } else if (/\.(rar|cbr)$/i.test(file.name || '')) {
        file = new File([file], zipNameFor(file.name), { type: file.type });
      }
    }
    identified.push({ file, named: await nameWithFormat(file.name || 'file', file) });
  }

  /* Loose pictures are one chapter, not one chapter each.
   *
   * Manga and manhwa are downloaded as a folder of numbered images, and a
   * hundred and eighty separate parts is not a workshop anyone can use. They
   * are pages: gathered into a single part, in the order they are numbered.
   */
  const pictures = identified.filter((f) => IS_PICTURE.test(f.named)).map((f) => f.file);
  // Loose files are one group, and numbered names within it belong in
  // numbered order: "Volume 10" after "Volume 2", not before it.
  const rest = identified
    .filter((f) => !IS_PICTURE.test(f.named))
    .sort((a, b) => naturalOrder(a.named, b.named));

  if (pictures.length) {
    pictures.sort((a, b) => naturalOrder(a.name, b.name));
    found.push({
      name: commonName(pictures.map((p) => p.name)) || 'Pictures',
      pictures,
      size: pictures.reduce((n, p) => n + (p.size || 0), 0),
    });
  }

  /* Loose saved pages are one part, not one part each.
   *
   * The same judgement the importer makes, for the same reason: two hundred
   * chapter files picked from one folder are a novel, and two hundred rows
   * in a list to be put in order by hand is not a workshop anyone can use. */
  const plan = planBooks(rest.map(({ file, named }) => ({ file, named, name: named })));

  // In the order they were chosen, with a run of chapters where its first
  // chapter was -- not gathered up and put at the end.
  for (const step of plan) {
    if (step.kind !== 'book') {
      found.push({
        name: step.title,
        pages: step.items.map(({ file, named }) => (named === file.name ? file : new File([file], named))),
        size: step.items.reduce((n, { file }) => n + (file.size || 0), 0),
      });
      continue;
    }

    const { file, named } = step.item;
    const format = formatOf(named);

    if (format === 'ZIP') {
      try {
        const archive = await expandArchive(file, (fraction, name) =>
          onProgress?.(`Opening ${name}`, fraction));
        // An EPUB named ".zip" is one part -- the book -- not its pages.
        if (archive.epub) {
          const asEpub = asEpubName(named);
          found.push({ file: new File([file], asEpub), name: asEpub });
          continue;
        }
        if (archive.comic) {
          /* A zip of pictures is a comic, and has to say so.
           *
           * Kept under its .zip name it went to the parser as an archive, and
           * the parser refuses those outright -- it expects them expanded.
           * Naming it for what the expander just decided it is routes it to
           * the comic reader instead. Two series side by side are two parts,
           * each reading its own part of the archive. */
          const asComic = named.replace(/\.zip$/i, '.cbz');
          const comics = archive.comics || [];
          if (comics.length > 1) {
            for (const comic of comics) {
              found.push({
                file: new File([file], asComic), name: `${comic.title}.cbz`,
                prefix: comic.prefix, from: file.name,
              });
            }
          } else {
            found.push({ file: new File([file], asComic), name: asComic, from: null });
          }
          continue;
        }

        /* A folder of saved pages is one part, not two hundred.
         *
         * Web novels arrive that way -- a folder of .mht chapters, zipped,
         * often several novels to a zip. The expander has already gathered
         * each work's chapters in reading order; each becomes one part, so a
         * zip of three novels is three parts rather than one run of all of
         * them or six hundred of each. */
        /* The importer puts a zip on the shelf as it is; Build is where
         * chapters become a book. So the gathering happens here: each work's
         * chapter files are one part, in reading order, and everything else
         * is a part of its own, in natural order. */
        const ordered = [...archive.books].sort((a, b) => naturalOrder(a.path || a.name, b.path || b.name));
        for (const step of planBooks(ordered, { pathOf: (book) => book.path || book.name })) {
          if (step.kind === 'chapters') {
            found.push({
              name: step.title,
              pages: step.items,
              size: step.items.reduce((n, item) => n + (item.size || 0), 0),
              from: file.name,
            });
            continue;
          }
          const book = step.item;
          found.push({ read: book.read, name: book.name, from: file.name, size: book.size });
        }
        continue;
      } catch (error) {
        found.push({ file, name: named, error: error.message });
        continue;
      }
    }

    found.push({ file, name: named });
  }

  /* Sorted within each source, never across them.
   *
   * Sorting everything together by name is what made a build read Chapter 1
   * of book one, Chapter 1 of book two, Chapter 2 of book one -- two volumes
   * whose chapters are both numbered from one interleave perfectly. Each
   * archive's contents are ordered among themselves when it is opened, and
   * the sources stay in the order they were chosen.
   */
  parts = [...parts, ...found.map((part, at) => ({ ...part, id: `${Date.now()}-${at}` }))];
  return parts;
}

/**
 * A book already on the shelf, as a part.
 *
 * Building was files-only, which left the commonest case of all out: the
 * series you have been reading for a year, and volume thirty-one has just
 * come out. Re-importing thirty volumes to put one on the end is not a thing
 * anybody should be asked to do.
 *
 * It goes in as a part like any other, so it can be moved, removed, and
 * joined to files of any format. The book itself is untouched -- building
 * makes a new book, as it always has, and the original is still on the shelf
 * if the result is not what was wanted.
 */
export function addBook(book) {
  parts = [...parts, bookPart(book)];
  return parts;
}

/** A book from the shelf as a part, not put in the workshop (the queue's own builds). */
export function bookPart(book) {
  return {
    id: `book-${book.id}-${Date.now()}`,
    name: book.title || 'Book',
    bookId: book.id,
    chapterCount: book.chapters || 0,
    words: book.words || 0,
    fromShelf: true,
  };
}

export const hasBook = (bookId) => parts.some((part) => part.bookId === bookId);

/**
 * The pages of a website part that did not come, kept to try again: where
 * they are, what they were called, and what the part was set to.
 */
function leftOf(part, pages, reason = '') {
  if (!part.web) return {};
  // Each as kept: its other sources, and whether it is a missing chapter's placeholder (never asked for).
  const links = (pages || part.web.links).map(({ url, text, alts, placeholder }) => ({ url, text, ...(alts?.length ? { alts } : {}), ...(placeholder != null ? { placeholder } : {}) }));
  if (!links.length) return {};
  return {
    web: {
      name: part.name, links, sources: part.web.sources || [], pictures: part.web.pictures !== false,
      author: part.web.author || '', gap: part.web.gap, jitter: part.web.jitter, reason,
    },
  };
}

/**
 * Chapters from a website, as a part.
 *
 * Listed and ordered like any file, and downloaded when the book is built,
 * not before -- so the pages chosen can sit in the list beside the volumes
 * they continue, and nothing is fetched for a build that never happens.
 *
 * @param links  [{ url, text }] in reading order
 * @param cover  the site's picture of the book, already fetched, or null
 */
export function addWeb(options) {
  parts = [...parts, webPart(options)];
  return parts;
}

/** Chapters from a website as a part, not put in the workshop (the queue's own builds). */
export function webPart({
  name, links, pictures = true, cover = null, author = '', sources = [], leftover = null, gap = 250, jitter = 0,
}) {
  return {
    id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    // Pages left over from an earlier build, being tried again.
    leftover,
    name: name || 'From the web',
    web: { links: links.map(({ url, text, alts, placeholder }) => ({ url, text, ...(alts?.length ? { alts } : {}), ...(placeholder != null ? { placeholder } : {}) })), pictures, author, sources, gap, jitter },
    coverBlob: cover,
    chapterCount: links.length,
  };
}

export function move(id, by) {
  const at = parts.findIndex((p) => p.id === id);
  const to = at + by;
  if (at === -1 || to < 0 || to >= parts.length) return parts;
  const [part] = parts.splice(at, 1);
  parts.splice(to, 0, part);
  return parts;
}

export function drop(id) {
  parts = parts.filter((p) => p.id !== id);
  return parts;
}

export function clear() {
  parts = [];
  return parts;
}

/** What a part is, said plainly enough to spot the odd one out. */
export function describe(part) {
  if (part.error) return `Could not be opened — ${part.error}`;
  if (part.fromShelf) {
    const chapters = part.chapterCount
      ? `${part.chapterCount} chapter${part.chapterCount === 1 ? '' : 's'}`
      : 'on the shelf';
    return `From the shelf · ${chapters}`;
  }
  if (part.web) {
    let site = '';
    try { site = ` · ${new URL(part.web.sources[0] || part.web.links[0].url).host}`; } catch { /* no address to name */ }
    const count = part.web.links.length;
    const spread = part.web.jitter > 0 ? ` ± ${part.web.jitter}` : '';
    const rate = Number.isFinite(part.web.gap) ? ` · ${part.web.gap}${spread} ms apart` : '';
    const pictures = part.web.pictures === false ? ' · text only, no pictures' : '';
    return `From the web · ${count} page${count === 1 ? '' : 's'}, downloaded when built${site}${rate}${pictures}`;
  }
  if (part.pictures) {
    const size = part.size ? ` · ${(part.size / 1048576).toFixed(1)}MB` : '';
    return `${part.pictures.length} pages${size}`;
  }
  if (part.pages) {
    const size = part.size ? ` · ${(part.size / 1048576).toFixed(1)}MB` : '';
    return `${part.pages.length} saved pages${size}`;
  }
  const format = formatOf(part.name);
  const reason = UNSUPPORTED_REASON?.[format];
  if (reason) return reason;
  const size = part.size ? ` · ${(part.size / 1048576).toFixed(1)}MB` : '';
  const where = part.from ? ` · from ${part.from}` : '';
  return `${format}${size}${where}`;
}

/**
 * Build one book from the parts.
 *
 * Each part is parsed as it comes -- nothing is held beyond the one being
 * worked on, which is what lets a shelf of long volumes go through a phone.
 * Paths are prefixed per part for the same reason they are when joining:
 * two volumes of a serial name their pictures identically, and without a
 * prefix the later ones quietly replace the earlier.
 */
export async function build({
  title, author, folder = null, cover: chosenCover = null, onProgress, shouldPause = null,
  /* Built from these rather than the workshop's list: a queued website, built
   * on its own beside whatever is in Build. */
  parts: given = null,
  // Kept on the book while it is built: the queue's job it is, for a cut-off
  // build to go back to that job rather than to Build's leftovers.
  tag = null,
} = {}) {
  const list = given || parts;
  /* One part is a book too.
   *
   * A zip of a volume's saved pages, or a folder of a chapter's images, is a
   * whole book on its own -- and the two-part minimum turned the commonest
   * case away at the door. Joining several is what the workshop is for, not
   * what it requires.
   */
  if (!list.length) throw new Error('Add something to build from.');

  const name = title || suggestedName(list);

  /* Filed where it was asked for -- the folder the shelf is open at -- or,
   * when it was not, where the book it was built onto is filed. A volume
   * added to a book in "Manhwa" belongs in "Manhwa", not loose on the shelf. */
  /* The websites the book comes from -- its own parts', and those of any
   * book it is built onto -- kept on it, as WebToEpub's library keeps a
   * story's address: "Check for new chapters" lists them again. */
  const webSources = [];
  for (const part of list) {
    const from = part.web ? part.web.sources || [] : part.bookId ? (await store.get('books', part.bookId))?.webSources || [] : [];
    for (const address of from) if (address && !webSources.includes(address)) webSources.push(address);
  }

  let filed = folder || '';
  if (!filed) {
    for (const part of list) {
      if (!part.bookId) continue;
      filed = (await store.get('books', part.bookId))?.folder || '';
      break;
    }
  }

  /* Its cover from the start -- the one chosen, else the first part's (a
   * website's picture, fetched before it began; a book carried on, its own) --
   * so a book still downloading, or paused, is its cover on the shelf, not a
   * blank. */
  const first = list[0];
  let early = chosenCover || first?.coverBlob || null;
  if (!early && first?.bookId) early = (await store.get('books', first.bookId).catch(() => null))?.coverBlob || null;
  if (!early && first?.pictures?.length) early = first.pictures[0];
  // A book carried on that never had one: the website's own, if it brought one.
  if (!early) early = list.find((part) => part.coverBlob)?.coverBlob || null;

  const bookId = await store.add('books', {
    title: name,
    folder: filed,
    ...(early ? { coverBlob: early, coverBytes: early.size ?? null } : {}),
    // Set here rather than left to be corrected later: a book named at the
    // moment it is made is named everywhere -- on the shelf, in its own
    // metadata, and in anything written out of it afterwards.
    author: author || null,
    fingerprint: `built:${Date.now()}`,
    addedAt: Date.now(),
    words: 0,
    importing: true,
    ...(tag ? { queueJob: tag } : {}),
    builtFrom: list.map((p) => (p.bookId ? { name: p.name, bookId: p.bookId } : { name: p.name })),
    ...(webSources.length ? { webSources } : {}),
    /* What a website part is downloading, kept on the book until it is
     * built: should the app be closed or killed meanwhile, the chapters
     * that had come are a book on the next start, and the rest -- from
     * `building.at.next` -- is kept to carry it on. */
    building: {
      webParts: list.map((p, at) => (p.web ? { at, ...leftOf(p, p.web.links).web, leftover: p.leftover || null } : null))
        .filter(Boolean),
      at: null,
    },
  });
  /* A chapter as it is kept: the part's name above its first, when the book
   * has more than one part. */
  const recordOf = (part, chapter, n, prefix, volume) => ({
    bookId,
    index: index++,
    /* The part's name above its first chapter marks the seam between one
       part and the next. With a single part there is no seam, and the label
       would just repeat the book's own title on its first chapter. */
    /* Not where a book is carried on from where its download stopped: the
       parts are one serial, and the seam would be named again at every
       carry -- "Title — Title — 1화". */
    title: n === 0 && list.length > 1 && !part.seamless
      ? `${stripExtension(part.name)} — ${chapter.title}`
      : chapter.title,
    volume,
    fromToc: chapter.fromToc,
    words: chapter.words || 0,
    base: prefix + (chapter.base || ''),
    // The link a web chapter came from: how "Check for new chapters" knows
    // what the book already has.
    ...(chapter.from ? { from: chapter.from } : {}),
    /* A part whose chapters arrive as finished markup -- a comic, a text
       file -- has its picture references already resolved, so they need the
       prefix applying too. One that arrives as source resolves them later,
       against the prefixed base above. */
    ...(chapter.source != null
      ? { source: chapter.source }
      : { html: reKeyImages(chapter.html || '', prefix) }),
  });

  let index = 0;
  let words = 0;
  // Pictures are numbered across the whole book. Each part numbers its own
  // from zero, and left that way the reel sorts them into one interleaved
  // run: the first picture of every volume, then the second of every volume.
  let picture = 0;
  let cover = null;
  const failed = [];

  /* "Pause & keep": the website being downloaded stops after the chapters
   * under way, and a website not yet begun is not begun -- both kept whole
   * as what is left, to carry on with. Files are still read: they take
   * moments, and a book missing its own volumes is not what was asked for. */
  const pausing = () => typeof shouldPause === 'function' && !!shouldPause();

  for (let at = 0; at < list.length; at++) {
    const part = list[at];
    if (part.web && pausing()) {
      const count = part.web.links.length;
      failed.push({
        name: `${part.name}: all ${count} page${count === 1 ? '' : 's'}`,
        reason: PAUSED_REASON,
        paused: true,
        ...leftOf(part, part.web.links, PAUSED_REASON),
      });
      continue;
    }
    onProgress?.(`Reading ${part.name}`, at / list.length, at, list.length);

    const prefix = `p${at}/`;
    // Where this part's chapters begin in the finished book. Its pictures
    // number their chapters from zero, as every part does, and left that way
    // they all claim to belong to the opening chapters of the book.
    const base = index;
    const volume = stripExtension(part.name);

    /* Pictures written as the part is read, a dozen at a time, as an import
     * writes them -- not gathered up and written at the end. A volume of an
     * illustrated omnibus is fifty megabytes of pictures; held all at once,
     * on top of reading the rest, that is what stalled a build on a phone
     * that imported the same file without trouble. */
    const pending = [];
    const flush = async () => {
      if (pending.length) await store.putAll('images', pending.splice(0));
    };
    const onImage = async (image) => {
      pending.push({
        ...image,
        bookId,
        order: picture++,
        href: prefix + image.href,
        chapterIndex: base + (image.chapterIndex || 0),
        volume,
      });
      if (pending.length >= 12) await flush();
    };

    /* A website's chapters are kept as they come, each with where to resume
     * from, not all at the end: a build of six hundred is an hour or two,
     * and the app can be closed, or killed, in the middle of it. */
    let streamed = 0;
    /* Where to resume, noted on the book -- not after every chapter. The note
     * is a rewrite of the whole book record (its every link, its cover), and
     * with several novels downloading that was a stream of large writes
     * competing with everything else the library does. Resuming does not
     * rest on it: rescueCutBuild works out where a cut build stopped from the
     * chapters actually kept. So it is noted at a part's first chapter, then
     * every CHECKPOINT_EVERY chapters or CHECKPOINT_MS, whichever comes first. */
    let notedAt = 0;
    const onChapter = part.web ? async (chapter, next) => {
      const record = recordOf(part, chapter, streamed, prefix, volume);
      streamed += 1;
      words += record.words;
      await store.put('chapters', record);
      const now = Date.now();
      if (streamed !== 1 && streamed % CHECKPOINT_EVERY !== 0 && now - notedAt < CHECKPOINT_MS) return;
      notedAt = now;
      const book = await store.get('books', bookId);
      if (book?.building) {
        // `came`: this part's own chapters so far -- apart from any a book carried on already had.
        book.building.at = { part: at, next, chapters: index, words, came: streamed };
        await store.put('books', book);
      }
    } : null;

    let parsed;
    // How this website's pages are going, for the time-left estimate.
    const partStats = {};
    try {
      parsed = part.web
        ? await readPages(part.web.links, {
          stats: partStats,
          title: part.name,
          author: part.web.author,
          cover: part.coverBlob,
          pictures: part.web.pictures,
          fetchPage: part.web.fetchPage,
          gap: part.web.gap,
          jitter: part.web.jitter,
          patience: part.web.patience,
          shouldStop: pausing,
          onChapter,
          onImage,
          // How far it has got, on the line with the bar; what it is doing
          // this moment (waiting out the delay, reading, another try) apart.
          onProgress: (fraction, done, total, note, now) => onProgress?.(
            // The chapters are counted beside it (app.js, paintTimes); which part this is, here.
            `Downloading ${part.name}${list.length > 1 ? ` · part ${at + 1} of ${list.length}` : ''}`,
            (at + fraction) / list.length, at, list.length, now, { done, total, stats: partStats }),
        })
        : part.bookId
        ? await readShelfBook(part)
        : part.pictures
        ? await readPictures(part)
        : part.pages
        ? await parseChapters(part.pages, (fraction) =>
          onProgress?.(`Reading ${part.name}`, (at + fraction) / list.length, at, list.length),
          { title: part.name, onImage })
        : await parse(
          part.file || new File([await part.read()], part.name),
          (fraction) =>
            onProgress?.(`Reading ${part.name}`, (at + fraction) / list.length, at, list.length),
          { prefix: part.prefix ?? null, onImage });
      await flush();
    } catch (error) {
      // One part that will not open should cost that part, not the build --
      // nor leave its pictures behind without it.
      pending.length = 0;
      for (const image of await store.byIndex('images', 'bookId', bookId)) {
        if (image.href.startsWith(prefix)) await store.del('images', [bookId, image.href]);
      }
      const paused = error.failed?.[0]?.reason === PAUSED_REASON;
      failed.push({
        name: part.name, reason: paused ? PAUSED_REASON : error.message, paused,
        ...leftOf(part, error.rest, error.failed?.[0]?.reason),
      });
      continue;
    }
    if (!cover && parsed.coverBlob) cover = parsed.coverBlob;
    /* A website that stopped at a page it would not give: built up to there,
     * and the rest -- that page on -- said, and kept to try again. */
    if (parsed.rest?.length) {
      const count = parsed.rest.length;
      const at = parsed.failed[0];
      const paused = at?.reason === PAUSED_REASON;
      failed.push({
        name: `${part.name}: the last ${count} page${count === 1 ? '' : 's'}`,
        reason: paused ? PAUSED_REASON : `stopped at ${at?.text || at?.url} — ${at?.reason}`,
        paused,
        ...leftOf(part, parsed.rest, at?.reason),
      });
    }

    // A website's were kept as they came; the rest are kept now.
    if (!part.web) {
      await store.putAll('chapters', parsed.chapters.map((chapter, n) => recordOf(part, chapter, n, prefix, volume)));
      words += parsed.chapters.reduce((n, c) => n + (c.words || 0), 0);
    }

    if (parsed.images?.length) {
      await store.putAll('images', parsed.images.map((image) => ({
        ...image,
        bookId,
        order: picture++,
        href: prefix + image.href,
        // Counted from where this part starts, and stamped with the part it
        // came from, so the reel can group by volume and jumping from a
        // picture lands in the chapter it actually belongs to.
        chapterIndex: base + (image.chapterIndex || 0),
        volume,
      })));
    }
  }

  if (!index) {
    await store.deleteBook(bookId);
    /* With the reason, not without it.
     *
     * "None of those parts could be read" is true and useless: every part had
     * a reason, and throwing them away left nothing to act on. */
    const why = failed[0]?.reason;
    // Paused before a single chapter had come: nothing to keep, nothing wrong.
    const paused = failed.length > 0 && failed.every((each) => each.paused);
    // With what failed, so pages from a website can be tried again.
    throw Object.assign(new Error(paused
      ? 'Paused before any chapter had come, so there is no book yet. The list is still here to build.'
      : why
      ? `None of those parts could be read — ${failed[0].name}: ${why}`
      : 'None of those parts could be read.'), { failed, paused });
  }

  const finished = await store.get('books', bookId);
  finished.words = words;
  finished.chapters = index;
  // A cover chosen in Build wins over the first part's; the app then puts it
  // into the book itself (coverpage.js), as a cover chosen in Details is.
  finished.coverBlob = chosenCover || cover || early;
  finished.coverBytes = (chosenCover || cover || early)?.size ?? null;
  if (chosenCover) finished.coverCustom = true;
  delete finished.importing;
  delete finished.building;
  await store.put('books', finished);

  return { book: finished, failed };
}

/**
 * A build the app was closed (or killed) in the middle of, made a book of
 * what had come -- or null when nothing had, or it was not a website.
 *
 * Its chapters were kept as they came, in order; this counts them, takes
 * the book off "importing", and says what is left: the website being read,
 * from the chapter after the last kept, and any website not begun.
 *
 * @returns {{ book, rest: [{ name, links, sources, pictures, author, gap,
 *   jitter, leftover }] }} or null
 */
/** How often a download notes where to resume (see onChapter): every so many chapters, or so long. */
const CHECKPOINT_EVERY = 20;
const CHECKPOINT_MS = 30000;

export async function rescueCutBuild(book) {
  if (!book?.importing || !book.building?.webParts?.length) return null;
  const chapters = await store.byIndex('chapters', 'bookId', book.id);
  if (!chapters.length) return null;
  const { webParts, at } = book.building;
  // Where to resume, from what was kept: the checkpoint is written just
  // after each chapter, so a chapter kept with the app killed before its
  // checkpoint would otherwise be downloaded, and be in the book, twice.
  const have = new Set(chapters.map((chapter) => chapter.from).filter(Boolean));
  const rest = [];
  for (const part of webParts) {
    if (at && part.at < at.part) continue;                 // read to its end
    let next = at && part.at === at.part ? at.next : 0;
    for (let n = part.links.length - 1; n >= next; n -= 1) {
      if (have.has(part.links[n].url)) { next = n + 1; break; }
    }
    const links = part.links.slice(next);
    if (links.length) rest.push({ ...part, links });
  }
  book.chapters = chapters.length;
  book.words = chapters.reduce((n, c) => n + (c.words || 0), 0);
  book.cutOff = Date.now();
  delete book.importing;
  delete book.building;
  await store.put('books', book);
  return { book, rest };
}

/**
 * A book on the shelf, in the shape a parsed file comes back in.
 *
 * Its chapters are read out as finished markup rather than as source: the
 * source's picture paths are relative to an archive that is not here any
 * more, and resolving them is exactly what chapterHtml already does on the
 * way to the page. What comes out is what was being read.
 */
async function readShelfBook(part) {
  const book = await store.get('books', part.bookId);
  if (!book) throw new Error('that book is no longer in the library');

  const chapters = (await store.byIndex('chapters', 'bookId', part.bookId))
    .sort((a, b) => a.index - b.index);
  if (!chapters.length) throw new Error('that book has nothing in it');

  // Pages taken out of it stay out: building onto a trimmed book should not
  // quietly bring back what was trimmed.
  const images = (await store.byIndex('images', 'bookId', part.bookId))
    .filter((image) => !image.removed)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return {
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      fromToc: !!chapter.fromToc,
      words: chapter.words || 0,
      html: chapterHtml(chapter),
      ...(chapter.from ? { from: chapter.from } : {}),
    })),
    images: images.map((image, order) => ({
      href: image.href,
      blob: image.blob,
      order,
      chapterIndex: image.chapterIndex || 0,
      width: image.width,
      height: image.height,
      animated: image.animated,
    })),
    coverBlob: book.coverBlob || null,
  };
}

/** Point already-resolved picture references at their prefixed copies. */
function reKeyImages(html, prefix) {
  return html.replace(/data-img="([^"]*)"/g, (_, href) => `data-img="${prefix}${href}"`);
}

/**
 * A chapter made of loose pictures.
 *
 * Manga and manhwa arrive as a folder of numbered images. They are one
 * chapter of pages, in the order they are numbered -- which is not the order
 * a file system gives them, since page 10 sorts before page 2.
 */
async function readPictures(part) {
  const images = part.pictures.map((file, at) => ({
    href: `page${String(at + 1).padStart(4, '0')}-${file.name}`,
    blob: file,
    order: at,
    chapterIndex: 0,
    animated: /\.gif$/i.test(file.name),
    width: 0,
    height: 0,
  }));

  const html = images
    .map((image) => `<img data-img="${image.href}" alt=""/>`)
    .join('\n');

  return {
    title: part.name,
    chapters: [{ index: 0, title: part.name, fromToc: false, html, words: 0 }],
    images,
    imageCount: images.length,
    words: 0,
    coverBlob: part.pictures[0] || null,
    format: 'CBZ',
  };
}

/**
 * A volume made of saved pages.
 *
 * Each page is one chapter, read in the order the pages are named. They are
 * parsed one at a time and their pictures gathered as they go, so a volume of
 * three hundred chapters costs one chapter's memory rather than three
 * hundred.
 */

const stripExtension = (name) => String(name).replace(/\.[a-z0-9]{2,5}$/i, '');

/**
 * A name from what the parts have in common.
 *
 * "Witch City Vol. 1" and "Witch City Vol. 2" should suggest "Witch City"
 * rather than the first part's whole filename.
 */
/**
 * What a build is called until it is named: what the parts' names share --
 * "Reincarnated" for "Reincarnated vol 1" and "Reincarnated vol 2" -- or,
 * when they share nothing, the first part's own name. Never a placeholder:
 * "Built book" told nobody which book it was.
 */
export function suggestedName(list) {
  if (!list?.length) return '';
  return commonName(list.map((p) => p.name))
    || stripExtension(list[0].name || '').trim()
    || 'Built book';
}

export function commonName(names) {
  if (!names.length) return null;
  const words = names.map((n) => stripExtension(n).split(/\s+/));
  const shared = [];
  for (let i = 0; i < words[0].length; i++) {
    const word = words[0][i];
    if (!words.every((w) => w[i] === word)) break;
    shared.push(word);
  }
  // A trailing "Vol." belongs to the part that differs, not to the whole.
  while (shared.length && /^(vol\.?|volume|part|book|ch\.?|chapter|#|-|—)$/i.test(shared[shared.length - 1])) {
    shared.pop();
  }
  return shared.join(' ').trim() || null;
}
