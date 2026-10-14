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
import { SIZES, shrinkPicture, describeSaving } from './shrink.js';

const escapeXml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const MEDIA = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
};

const mediaFor = (name) => MEDIA[String(name).split('.').pop().toLowerCase()] || 'image/jpeg';

/**
 * A chapter's markup as XHTML, which is what an EPUB's chapters are.
 *
 * The book keeps its chapters as HTML, where a line break is "<br>" and
 * nothing closes it. Written as they were into an .xhtml file, that is not
 * XML at all: an EPUB of four hundred chapters went out with four hundred
 * and forty unclosed line breaks, and a strict reader -- or this app's own
 * importer, on a slow day -- has to fall back or give up on every one.
 * Parsed as HTML and written out again as XML, a break comes out as
 * "<br/>", an ampersand as "&amp;", and nothing is left unclosed.
 */
const XHTML_NS = / xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g;
export function toXhtml(html) {
  if (typeof DOMParser !== 'function' || typeof XMLSerializer !== 'function') return html;
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const out = new XMLSerializer();
  let xml = '';
  for (const node of doc.body.childNodes) xml += out.serializeToString(node);
  // Declared once, on <html>, by the file around it -- not on every paragraph.
  return xml.replace(XHTML_NS, '');
}

/* The extension a picture is written under.
 *
 * Read off what the picture now is, where that is known, and only then off
 * the name it came in under. A blacked-out GIF is saved back as a PNG; filed
 * under .gif the reader at the other end is told one thing and handed
 * another, and the stricter ones show nothing. */
const BY_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg',
};
export function extensionFor(blob, href) {
  const known = BY_TYPE[String(blob?.type || '').toLowerCase()];
  if (known) return known;
  return String(href).split('.').pop().toLowerCase().slice(0, 4) || 'jpg';
}

/**
 * Turn a stored book into an EPUB.
 *
 * @param onProgress  called with a fraction, because a long book is a lot of
 *   files and a silent wait is indistinguishable from a hang.
 * @param size  a key from shrink.SIZES. The pictures are downscaled on the
 *   way into the file and the book on the shelf is left exactly as it is: a
 *   smaller copy is a copy, not an edit.
 */
export async function buildEpub(bookId, { onProgress, title, author, size } = {}) {
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

  // Pages taken out of the book keep their rows so they can be put back;
  // writing them into the file would be exporting what was removed.
  const images = (await store.byIndex('images', 'bookId', bookId))
    .filter((image) => !image.removed);
  const zip = new JSZip();

  /* The mimetype entry must come first and must not be compressed. It is the
   * one part of the format that is a rule about the archive rather than about
   * its contents, and a reader that checks will reject the file without it. */
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  /* Everything else is compressed.
   *
   * It was not, which is why a book came out roughly the size of its own
   * markup: an EPUB is a zip, and a zip that stores rather than deflates is
   * just a container. Prose compresses to about a quarter, and the repeated
   * per-chapter boilerplate -- the same fifteen lines of XHTML around every
   * chapter -- compresses to almost nothing, which is what makes a book of
   * two thousand short chapters so much worse than a book of ten long ones.
   */
  const TEXT = { compression: 'DEFLATE', compressionOptions: { level: 6 } };

  /* Pictures are stored as they are.
   *
   * JPEG, PNG and WebP are compressed already; deflating them again costs
   * real time on a phone and saves a fraction of a percent, and for a comic
   * that time is most of the export. */
  const PICTURE = { compression: 'STORE' };

  zip.file('META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
    + 'media-type="application/oebps-package+xml"/></rootfiles></container>', TEXT);

  /* Pictures are renamed on the way out.
   *
   * Inside the app a picture's name carries wherever it came from -- a
   * per-part prefix, a publisher's directory layout, sometimes both. None of
   * that means anything in a new archive, and some of it is not legal in a
   * path, so each gets a plain serial name and the chapters are pointed at
   * it. */
  const renamed = new Map();
  /* Null for a full-size copy, which is also the only case that touches no
   * picture at all: an export nobody asked to shrink must be byte-identical
   * to the one before this existed. */
  const wanted = size && size !== 'full' && SIZES[size] ? SIZES[size] : null;
  let saved = 0;
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

    /* Smaller, where a smaller copy was asked for.
     *
     * shrinkPicture hands back the original whenever shrinking would not
     * help -- an animation, a page already under the target, a re-encode that
     * came out bigger -- so the extension has to be read off what comes back
     * rather than off what went in. */
    const written = wanted ? await shrinkPicture(image.blob, wanted) : image.blob;
    saved += Math.max(0, image.blob.size - written.size);

    const extension = extensionFor(written, written === image.blob ? image.href : 'x.jpg');
    const name = `images/img${String(++at).padStart(4, '0')}.${extension}`;
    try {
      zip.file(`OEBPS/${name}`, written, PICTURE);
      renamed.set(image.href, name);
    } catch {
      // Skipped rather than fatal, for the same reason.
    }
    onProgress?.(at / (images.length + chapters.length) * 0.5,
      saved ? `Writing pictures · ${describeSaving(saved)} saved` : undefined);
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

    body = toXhtml(body);

    /* The namespace declared once on <html> rather than on every section,
       and no newlines between the parts: with a chapter per scraped page this
       boilerplate is repeated thousands of times. */
    zip.file(`OEBPS/${file}`,
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<html xmlns="http://www.w3.org/1999/xhtml"'
      + ' xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="'
      + escapeXml(book.lang || 'en') + '">'
      + `<head><title>${escapeXml(chapter.title)}</title>`
      + '<meta charset="utf-8"/>'
      + '<link rel="stylesheet" type="text/css" href="../style.css"/></head>'
      + `<body><section epub:type="chapter">${body}</section></body></html>`,
      TEXT);

    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    nav.push(`<li><a href="${file}">${escapeXml(chapter.title)}</a></li>`);
    onProgress?.(0.5 + ((at + 1) / chapters.length) * 0.45);
  }

  zip.file('OEBPS/style.css',
    'body { margin: 0 5%; line-height: 1.5; }\n'
    + 'h1, h2, h3 { line-height: 1.25; }\n'
    + 'img { max-width: 100%; height: auto; }\n', TEXT);

  for (const [href, name] of renamed) {
    const image = images.find((i) => i.href === href);
    if (image?.blob) {
      manifest.push(`<item id="${name.replace(/[^a-z0-9]/gi, '')}" href="${name}" `
        + `media-type="${mediaFor(name)}"/>`);
    }
  }

  if (typeof book.coverBlob?.size === 'number' && book.coverBlob.size > 0) {
    try {
      zip.file('OEBPS/cover.jpg', book.coverBlob, PICTURE);
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
    + '</html>', TEXT);
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
    + '</package>', TEXT);

  const blob = await zip.generateAsync(
    {
      type: 'blob',
      mimeType: 'application/epub+zip',
      // The default for anything not told otherwise, which is all the markup.
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (state) => onProgress?.(0.95 + (state.percent / 100) * 0.05));

  onProgress?.(1);
  // The saving is reported rather than assumed: it is the whole reason a
  // smaller copy was asked for, and on line art it can come out near zero.
  return { blob, name: `${safeName(book.title)}.epub`, saved };
}

/** A filename a file system will accept, from a title that may be anything. */
export function safeName(title) {
  return String(title || 'book')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'book';
}
