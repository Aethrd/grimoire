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
import { parse, formatOf, expandArchive, nameWithFormat, UNSUPPORTED_REASON } from './parse.js';

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
export async function add(files, onProgress) {
  const found = [];

  for (const file of files) {
    const named = await nameWithFormat(file.name || 'book', file);
    const format = formatOf(named);

    if (format === 'ZIP') {
      try {
        const archive = await expandArchive(file, (fraction, name) =>
          onProgress?.(`Opening ${name}`, fraction));
        if (archive.comic) {
          found.push({ file, name: named, from: null });
        } else {
          for (const book of archive.books) {
            found.push({ read: book.read, name: book.name, from: file.name, size: book.size });
          }
        }
        continue;
      } catch (error) {
        found.push({ file, name: named, error: error.message });
        continue;
      }
    }

    found.push({ file, name: named });
  }

  // Numbered parts belong in numbered order; anything already here keeps the
  // place it was put.
  found.sort((a, b) => naturalOrder(a.name, b.name));
  parts = [...parts, ...found.map((part, at) => ({ ...part, id: `${Date.now()}-${at}` }))];
  return parts;
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
export async function build({ title, onProgress } = {}) {
  if (parts.length < 2) throw new Error('Add two or more parts to build a book.');

  const name = title || commonName(parts.map((p) => p.name)) || 'Built book';
  const bookId = await store.add('books', {
    title: name,
    fingerprint: `built:${Date.now()}`,
    addedAt: Date.now(),
    words: 0,
    importing: true,
    builtFrom: parts.map((p) => ({ name: p.name })),
  });

  let index = 0;
  let words = 0;
  let cover = null;
  const failed = [];

  for (let at = 0; at < parts.length; at++) {
    const part = parts[at];
    onProgress?.(`Reading ${part.name}`, at / parts.length, at, parts.length);

    let parsed;
    try {
      const file = part.file || new File([await part.read()], part.name);
      parsed = await parse(file, (fraction) =>
        onProgress?.(`Reading ${part.name}`, (at + fraction) / parts.length, at, parts.length));
    } catch (error) {
      // One part that will not open should cost that part, not the build.
      failed.push({ name: part.name, reason: error.message });
      continue;
    }

    const prefix = `p${at}/`;
    if (!cover && parsed.coverBlob) cover = parsed.coverBlob;

    await store.putAll('chapters', parsed.chapters.map((chapter, n) => ({
      bookId,
      index: index++,
      // The part's name above its first chapter, so the seams are findable in
      // a book that is now thousands of chapters long.
      title: n === 0 ? `${stripExtension(part.name)} — ${chapter.title}` : chapter.title,
      volume: stripExtension(part.name),
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
        href: prefix + image.href,
      })));
    }
  }

  if (!index) {
    await store.deleteBook(bookId);
    throw new Error('None of those parts could be read.');
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

/** Point already-resolved picture references at their prefixed copies. */
function reKeyImages(html, prefix) {
  return html.replace(/data-img="([^"]*)"/g, (_, href) => `data-img="${prefix}${href}"`);
}

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
