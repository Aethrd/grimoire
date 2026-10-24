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

import * as store from './store.js';
import {
  parse, parseChapters, formatOf, expandArchive, asEpubName, nameWithFormat, chapterHtml, UNSUPPORTED_REASON,
} from './parse.js';
import { planBooks } from './group.js';

/** The parts waiting to be built, in the order they will be joined. */
let parts = [];

export const contents = () => parts;
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
  for (const file of files) {
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
  parts = [...parts, {
    id: `book-${book.id}-${Date.now()}`,
    name: book.title || 'Book',
    bookId: book.id,
    chapterCount: book.chapters || 0,
    words: book.words || 0,
    fromShelf: true,
  }];
  return parts;
}

export const hasBook = (bookId) => parts.some((part) => part.bookId === bookId);

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
export async function build({ title, author, folder = null, onProgress } = {}) {
  /* One part is a book too.
   *
   * A zip of a volume's saved pages, or a folder of a chapter's images, is a
   * whole book on its own -- and the two-part minimum turned the commonest
   * case away at the door. Joining several is what the workshop is for, not
   * what it requires.
   */
  if (!parts.length) throw new Error('Add something to build from.');

  const name = title || commonName(parts.map((p) => p.name)) || 'Built book';

  /* Filed where it was asked for -- the folder the shelf is open at -- or,
   * when it was not, where the book it was built onto is filed. A volume
   * added to a book in "Manhwa" belongs in "Manhwa", not loose on the shelf. */
  let filed = folder || '';
  if (!filed) {
    for (const part of parts) {
      if (!part.bookId) continue;
      filed = (await store.get('books', part.bookId))?.folder || '';
      break;
    }
  }

  const bookId = await store.add('books', {
    title: name,
    folder: filed,
    // Set here rather than left to be corrected later: a book named at the
    // moment it is made is named everywhere -- on the shelf, in its own
    // metadata, and in anything written out of it afterwards.
    author: author || null,
    fingerprint: `built:${Date.now()}`,
    addedAt: Date.now(),
    words: 0,
    importing: true,
    builtFrom: parts.map((p) => (p.bookId ? { name: p.name, bookId: p.bookId } : { name: p.name })),
  });

  let index = 0;
  let words = 0;
  // Pictures are numbered across the whole book. Each part numbers its own
  // from zero, and left that way the reel sorts them into one interleaved
  // run: the first picture of every volume, then the second of every volume.
  let picture = 0;
  let cover = null;
  const failed = [];

  for (let at = 0; at < parts.length; at++) {
    const part = parts[at];
    onProgress?.(`Reading ${part.name}`, at / parts.length, at, parts.length);

    let parsed;
    try {
      parsed = part.bookId
        ? await readShelfBook(part)
        : part.pictures
        ? await readPictures(part)
        : part.pages
        ? await parseChapters(part.pages, (fraction) =>
          onProgress?.(`Reading ${part.name}`, (at + fraction) / parts.length, at, parts.length),
          { title: part.name })
        : await parse(
          part.file || new File([await part.read()], part.name),
          (fraction) =>
            onProgress?.(`Reading ${part.name}`, (at + fraction) / parts.length, at, parts.length),
          { prefix: part.prefix ?? null });
    } catch (error) {
      // One part that will not open should cost that part, not the build.
      failed.push({ name: part.name, reason: error.message });
      continue;
    }

    const prefix = `p${at}/`;
    // Where this part's chapters begin in the finished book. Its pictures
    // number their chapters from zero, as every part does, and left that way
    // they all claim to belong to the opening chapters of the book.
    const base = index;
    const volume = stripExtension(part.name);
    if (!cover && parsed.coverBlob) cover = parsed.coverBlob;

    await store.putAll('chapters', parsed.chapters.map((chapter, n) => ({
      bookId,
      index: index++,
      // The part's name above its first chapter, so the seams are findable in
      // a book that is now thousands of chapters long.
      /* The part's name above its first chapter marks the seam between one
         part and the next. With a single part there is no seam, and the label
         would just repeat the book's own title on its first chapter. */
      title: n === 0 && parts.length > 1
        ? `${stripExtension(part.name)} — ${chapter.title}`
        : chapter.title,
      volume,
      fromToc: chapter.fromToc,
      words: chapter.words || 0,
      base: prefix + (chapter.base || ''),
      /* A part whose chapters arrive as finished markup -- a comic, a text
         file -- has its picture references already resolved, so they need the
         prefix applying too. One that arrives as source resolves them later,
         against the prefixed base above. */
      ...(chapter.source != null
        ? { source: chapter.source }
        : { html: reKeyImages(chapter.html || '', prefix) }),
    })));

    words += parsed.chapters.reduce((n, c) => n + (c.words || 0), 0);

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
    throw new Error(why
      ? `None of those parts could be read — ${failed[0].name}: ${why}`
      : 'None of those parts could be read.');
  }

  const finished = await store.get('books', bookId);
  finished.words = words;
  finished.chapters = index;
  finished.coverBlob = cover;
  finished.coverBytes = cover?.size ?? null;
  delete finished.importing;
  await store.put('books', finished);

  return { book: finished, failed };
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
