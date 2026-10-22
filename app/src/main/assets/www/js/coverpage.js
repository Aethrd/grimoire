/* A chosen cover, made part of the book.
 *
 * Replacing a cover used to change one thing: the picture the shelf showed,
 * kept beside the book as a preference the app remembered. The book itself
 * was untouched -- it still opened on its old cover page, exported with it,
 * and a backup had to carry the new picture separately or it was lost.
 *
 * Now the picture goes into the book. Where the book opens on a cover page --
 * a picture on its own at the very start, which is how nearly every EPUB and
 * every comic begins -- that picture is swapped for the new one. Where it
 * does not, a cover page is added in front of the first chapter. Either way
 * it is recorded what was done, so choosing another cover replaces this one
 * rather than stacking up, and removing it puts the book back as it came.
 *
 * Added inside the first chapter rather than as a chapter of its own: a page
 * with no words on it moves no text, so every bookmark, mark and reading
 * position -- all of them counted in characters from a chapter's start --
 * stays exactly where it was. A new chapter in front would have renumbered
 * every one of them.
 */

import * as store from './store.js';
import { chapterHtml } from './parse.js';

/** Where chosen covers are kept among the book's pictures. */
export const COVER_PREFIX = 'grimoire-cover/';

const TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };

/** The picture in this element, if it is a picture and nothing else. */
function onlyPicture(node) {
  if (!node || (node.textContent || '').trim()) return null;
  if (node.tagName === 'IMG') return node.hasAttribute('data-img') ? node : null;
  const pictures = node.querySelectorAll('img[data-img]');
  return pictures.length === 1 ? pictures[0] : null;
}

const pictureNamed = (body, href) =>
  [...body.querySelectorAll('img[data-img]')].find((img) => img.getAttribute('data-img') === href) || null;

/**
 * Make `blob` the book's cover, in the book -- or, with null, take a chosen
 * cover back out and leave the book as it came.
 *
 * @returns what was done: 'swapped' (the cover page now shows it), 'added'
 *   (a cover page was put in front), 'removed', or null when there was
 *   nothing to do it to.
 */
export async function placeCover(bookId, blob) {
  const book = await store.get('books', bookId);
  if (!book) return null;
  const chapters = (await store.byIndex('chapters', 'bookId', bookId)).sort((a, b) => a.index - b.index);
  const first = chapters[0];
  if (!first) return null;

  const doc = new DOMParser().parseFromString(`<body>${chapterHtml(first)}</body>`, 'text/html');
  const body = doc.body;
  let imageCount = book.imageCount || 0;

  // Whatever an earlier choice put in comes out first, so choices replace
  // each other rather than piling up at the front of the book.
  const earlier = book.coverPage || null;
  if (earlier) {
    const img = pictureNamed(body, earlier.href);
    if (img) {
      if (earlier.swapped) img.setAttribute('data-img', earlier.swapped);
      else (img.closest('figure.grimoire-cover') || img).remove();
    }
    await store.del('images', [bookId, earlier.href]);
    imageCount = Math.max(0, imageCount - 1);
  }

  let placed = null;
  let did = earlier ? 'removed' : null;
  if (blob) {
    const href = `${COVER_PREFIX}${Date.now()}.${TYPES[blob.type] || 'jpg'}`;
    await store.put('images', {
      bookId, href, blob, order: -1, chapterIndex: 0, cover: true,
      animated: false, width: 0, height: 0,
    });
    imageCount += 1;

    const lead = onlyPicture(body.firstElementChild);
    if (lead) {
      placed = { href, swapped: lead.getAttribute('data-img') };
      lead.setAttribute('data-img', href);
      did = 'swapped';
    } else {
      const figure = doc.createElement('figure');
      figure.className = 'grimoire-cover';
      figure.innerHTML = `<img data-img="${href}" alt="Cover">`;
      body.insertBefore(figure, body.firstChild);
      placed = { href, swapped: null };
      did = 'added';
    }
  }

  /* Written back as markup. A chapter kept as the file's own source is read
   * through the sanitiser on the way to the page; this is that same result,
   * with the cover in it, so nothing it already did is undone. */
  const { source, base, ...rest } = first;
  await store.put('chapters', { ...rest, html: body.innerHTML });

  const fresh = await store.get('books', bookId);
  if (placed) fresh.coverPage = placed; else delete fresh.coverPage;
  fresh.imageCount = imageCount;
  await store.put('books', fresh);
  return did;
}
