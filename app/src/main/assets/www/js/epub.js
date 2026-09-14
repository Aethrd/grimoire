/* Writing a book back out.
 *
 * A book built in the workshop exists only inside this app, which is fine
 * until you want it somewhere else -- another reader, a backup, a computer.
 * So it can be written out as an ordinary EPUB 3: the same artefact anything
 * else would produce, readable by anything that reads EPUBs.
 *
 * Nothing clever is attempted with the typography. The chapters go back out
 * as the sanitised markup the reader shows, wrapped in the skeleton the
 * format requires, and the pictures go with them. What comes out is what was
 * read, not a reconstruction of whatever the parts looked like going in.
 */

import * as store from './store.js';
import { chapterHtml } from './parse.js';

const escapeXml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const MEDIA = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
};

const mediaFor = (name) => MEDIA[String(name).split('.').pop().toLowerCase()] || 'image/jpeg';

/**
 * Turn a stored book into an EPUB.
 *
 * @param onProgress  called with a fraction, because a long book is a lot of
 *   files and a silent wait is indistinguishable from a hang.
 */
export async function buildEpub(bookId, { onProgress, title, author } = {}) {
  const stored = await store.get('books', bookId);
  if (!stored) throw new Error('That book is no longer in the library.');

  /* What goes inside the file, not just what it is called.
   *
   * Renaming the file on disk leaves the book still calling itself whatever
   * it called itself before, and every other reader shows that name rather
   * than the one on the file. The title written here is the one that
   * travels.
   */
  const book = {
    ...stored,
    title: (title ?? stored.title) || 'Untitled',
    author: author ?? stored.author,
  };

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);
  if (!chapters.length) throw new Error('That book has no chapters to write out.');

  const images = await store.byIndex('images', 'bookId', bookId);
  const zip = new JSZip();

  /* The mimetype entry must come first and must not be compressed. It is the
   * one part of the format that is a rule about the archive rather than about
   * its contents, and a reader that checks will reject the file without it. */
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file('META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
    + 'media-type="application/oebps-package+xml"/></rootfiles></container>');

  /* Pictures are renamed on the way out.
   *
   * Inside the app a picture's name carries wherever it came from -- a
   * per-part prefix, a publisher's directory layout, sometimes both. None of
   * that means anything in a new archive, and some of it is not legal in a
   * path, so each gets a plain serial name and the chapters are pointed at
   * it. */
  const renamed = new Map();
  let at = 0;
  for (const image of images) {
    /* Only pictures that can actually be written.
     *
     * One that cannot -- a record whose data did not survive, a blob the
     * archive will not take -- should cost its own place on the page, not the
     * whole export. Leaving it out of this map is also what drops its
     * reference from the markup below, so nothing points at a picture the
     * file does not contain.
     */
    if (typeof image.blob?.size !== 'number' || image.blob.size <= 0) continue;

    const extension = String(image.href).split('.').pop().toLowerCase().slice(0, 4) || 'jpg';
    const name = `images/img${String(++at).padStart(4, '0')}.${extension}`;
    try {
      zip.file(`OEBPS/${name}`, image.blob);
      renamed.set(image.href, name);
    } catch {
      // Skipped rather than fatal, for the same reason.
    }
    onProgress?.(at / (images.length + chapters.length) * 0.5);
  }

  const manifest = [];
  const spine = [];
  const nav = [];

  for (const [at, chapter] of chapters.entries()) {
    const file = `text/ch${String(at + 1).padStart(4, '0')}.xhtml`;
    const id = `ch${at + 1}`;

    let body = chapterHtml(chapter);
    // Point the markup at the renamed pictures, and drop any reference whose
    // picture is not here rather than writing a broken one.
    body = body.replace(/<img\b[^>]*\bdata-img="([^"]*)"[^>]*>/g, (whole, href) => {
      const target = renamed.get(href);
      if (!target) return '';
      return `<img src="../${target}" alt=""/>`;
    });

    zip.file(`OEBPS/${file}`,
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE html>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="'
      + escapeXml(book.lang || 'en') + '">\n'
      + `<head><title>${escapeXml(chapter.title)}</title>`
      + '<meta charset="utf-8"/>'
      + '<link rel="stylesheet" type="text/css" href="../style.css"/></head>\n'
      + `<body><section epub:type="chapter" xmlns:epub="http://www.idpf.org/2007/ops">\n${body}\n</section></body>\n</html>`);

    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    nav.push(`<li><a href="${file}">${escapeXml(chapter.title)}</a></li>`);
    onProgress?.(0.5 + ((at + 1) / chapters.length) * 0.45);
  }

  zip.file('OEBPS/style.css',
    'body { margin: 0 5%; line-height: 1.5; }\n'
    + 'h1, h2, h3 { line-height: 1.25; }\n'
    + 'img { max-width: 100%; height: auto; }\n');

  for (const [href, name] of renamed) {
    const image = images.find((i) => i.href === href);
    if (image?.blob) {
      manifest.push(`<item id="${name.replace(/[^a-z0-9]/gi, '')}" href="${name}" `
        + `media-type="${mediaFor(name)}"/>`);
    }
  }

  if (typeof book.coverBlob?.size === 'number' && book.coverBlob.size > 0) {
    try {
      zip.file('OEBPS/cover.jpg', book.coverBlob);
      manifest.push('<item id="cover" href="cover.jpg" media-type="image/jpeg" '
        + 'properties="cover-image"/>');
    } catch {
      // A cover that will not write is not worth losing the book over.
    }
  }

  zip.file('OEBPS/nav.xhtml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
    + '<head><title>Contents</title><meta charset="utf-8"/></head>\n'
    + `<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${nav.join('')}</ol></nav></body>\n`
    + '</html>');
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" '
    + 'properties="nav"/>');

  zip.file('OEBPS/content.opf',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    + `<dc:identifier id="pub-id">grimoire-${bookId}-${Date.now()}</dc:identifier>\n`
    + `<dc:title>${escapeXml(book.title)}</dc:title>\n`
    + `<dc:language>${escapeXml(book.lang || 'en')}</dc:language>\n`
    + (book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>\n` : '')
    + `<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>\n`
    + '</metadata>\n'
    + `<manifest>${manifest.join('')}</manifest>\n`
    + `<spine>${spine.join('')}</spine>\n`
    + '</package>');

  const blob = await zip.generateAsync(
    { type: 'blob', mimeType: 'application/epub+zip' },
    (state) => onProgress?.(0.95 + (state.percent / 100) * 0.05));

  onProgress?.(1);
  return { blob, name: `${safeName(book.title)}.epub` };
}

/** A filename a file system will accept, from a title that may be anything. */
export function safeName(title) {
  return String(title || 'book')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'book';
}
