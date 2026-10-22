/* Parsers.
 *
 * Every parser returns the same shape, so the import pipeline never branches
 * on format after the sniff:
 *
 *   { title, author, series, seriesIndex, lang, coverBlob, chapters[], images[] }
 *
 * Images travel as Blobs, never as blob: URLs. Those URLs belong to the
 * document that made them and stop resolving once the app is closed, so
 * storing one is storing a dangling handle -- see js/blobs.js.
 *
 * Chapters carry sanitised HTML, not the publisher's markup. Scripts, styles,
 * link tags and event handlers are stripped at parse time rather than trusted
 * at render time — a book is untrusted input, and it renders inside the same
 * origin as the app.
 */

import { openZip } from './zipreader.js';
import { planComics, commonLabel, naturalOrder } from './group.js';

const DOMP = new DOMParser();

/**
 * Open an archive, reading only its directory.
 *
 * The streaming reader slices entries out of the Blob as they are asked for;
 * JSZip loads the whole file first. For a 463MB book that is the difference
 * between 26MB of heap and half a gigabyte, which on a phone is the
 * difference between importing it and the process being killed.
 *
 * JSZip stays as the fallback for archives the streaming reader will not
 * touch -- zip64, unusual compression -- so nothing that used to import
 * stops importing.
 */
async function openArchive(file) {
  /* A refusal is not a format problem.
   *
   * Anything the streaming reader cannot handle falls back to JSZip -- but a
   * file the page is not allowed to read will not read for JSZip either, and
   * the fallback turned the one error worth recognising into "corrupted zip".
   * That one is passed on as it is, so it can be rescued. */
  const streamed = await openZip(file).catch((error) => {
    // A damaged file is not handed on: JSZip forgives exactly the damage
    // that makes an archive read as the wrong thing.
    if (isUnreadable(error) || error.damaged) throw error;
    return null;
  });
  if (streamed) return streamed;

  const zip = await JSZip.loadAsync(file);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  return {
    entries: new Map(files.map((f) => [f.name, f])),
    has: (name) => !!zip.file(name),
    names: () => files.map((f) => f.name),
    sizeOf: (name) => zip.file(name)?._data?.uncompressedSize ?? 0,
    async text(name) { return zip.file(name)?.async('string') ?? null; },
    async blob(name, type) {
      const data = await zip.file(name)?.async('blob');
      return data ? new Blob([data], { type }) : null;
    },
  };
}

/**
 * An illustration larger than this is skipped.
 *
 * The book that prompted it carries 83MB animated GIFs. Nothing on a phone
 * will decode one, and merely holding it is enough to end the import -- so it
 * is left out and the reader shows the chapter without it, rather than the
 * whole book failing.
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const FORMATS = {
  epub: 'EPUB', cbz: 'CBZ', cbr: 'CBR', txt: 'TXT', md: 'MD',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML', fb2: 'FB2', zip: 'ZIP',
  pdf: 'PDF', docx: 'DOCX', mobi: 'MOBI', azw3: 'AZW3', rtf: 'RTF',
  mht: 'MHT', mhtml: 'MHT',
};

/** Formats with a working parser today. The rest are refused with a reason. */
export const SUPPORTED = new Set(['EPUB', 'PDF', 'CBZ', 'TXT', 'MD', 'HTML', 'FB2', 'MHT']);

/** Book formats that can live inside an archive. ZIP is not one of them:
 *  nested archives are refused rather than recursed into. */
export const ARCHIVE_CONTENTS =
  new Set(['EPUB', 'PDF', 'CBZ', 'TXT', 'MD', 'HTML', 'FB2', 'MHT']);

export const UNSUPPORTED_REASON = {
  DOCX: 'DOCX is OOXML in a zip. Readable with JSZip, but the styling model is a project of its own.',
  MOBI: 'MOBI is a PalmDOC container. No parser yet.',
  AZW3: 'AZW3 shares the MOBI container. No parser yet.',
  RTF: 'RTF needs a control-word stripper. No parser yet.',
  CBR: 'CBR is RAR, which JSZip cannot open. Repack as CBZ, or vendor a RAR reader.',
};

export function formatOf(name) {
  const ext = name.split('.').pop().toLowerCase();
  return FORMATS[ext] || 'UNKNOWN';
}

/**
 * A saved web page as a chapter.
 *
 * Web novels are commonly kept this way -- one file per chapter, saved
 * straight from the browser. The file carries the whole page, so the site has
 * to be stripped off the story before it is worth reading; mht.js does that,
 * and this turns what is left into the same shape every other format produces.
 */
async function parseMht(file, onProgress, { onImage } = {}) {
  const { readMht } = await import('./mht.js');
  const page = readMht(await readText(file), stripExtension(file.name));

  const images = [];
  let order = 0;
  const resolveImage = (src) => {
    // The markup refers to a picture by the address it had on the web; the
    // file carries it under that same address, or under a content id.
    const blob = page.images.get(src)
      || page.images.get(src.replace(/^about:blank/, ''))
      || page.images.get(`cid:${src.replace(/^cid:/, '')}`);
    if (!blob) return null;

    const href = `mht/${order}-${src.split('/').pop().split('?')[0] || 'image'}`;
    const record = {
      href, blob, order: order++, chapterIndex: 0,
      animated: /\.gif($|\?)/i.test(src),
      width: 0, height: 0,
    };
    if (onImage) onImage(record);
    else images.push(record);
    return href;
  };

  const { html, text } = readChapter(page.body, resolveImage);
  onProgress?.(1);

  if (!text.trim() && !images.length) {
    throw new Error('Nothing readable was found in that saved page.');
  }

  return {
    title: page.title,
    author: null,
    lang: null,
    format: 'MHT',
    chapters: [{
      index: 0,
      title: page.title,
      fromToc: false,
      html,
      words: countWords(text, null),
    }],
    words: countWords(text, null),
    images,
    imageCount: order,
    coverBlob: null,
  };
}

const stripExtension = (name) => String(name).replace(/\.[a-z0-9]{2,5}$/i, '');

/* ── shared helpers ───────────────────────────────────────────────────── */

const ALLOWED = new Set([
  'P', 'DIV', 'SPAN', 'EM', 'I', 'STRONG', 'B', 'U', 'S', 'SUB', 'SUP',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE',
  'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'HR', 'BR', 'IMG', 'FIGURE',
  'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SMALL', 'A',
]);

/** Elements with no closing tag. */
const VOID = new Set(['br', 'hr', 'img']);

const escapeText = (value) => (/[&<>]/.test(value)
  ? value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  : value);
const escapeAttr = (value) => value.replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Read a chapter once and produce everything needed from it.
 *
 * This used to be four passes over the same chapter: build a sanitised DOM,
 * serialise it, re-parse to rewrite images, serialise again, then parse a
 * third time to extract text for the word count. Measured on a 200-chapter
 * novel, that was 5.9ms per chapter against 0.19ms for doing it in one --
 * about sixty per cent of the whole import spent re-reading work already
 * done. A shelf of 150 books is where that stops being academic.
 *
 * So: one walk of the source tree, emitting markup into an array, collecting
 * text for the word count, and noting image references as they go. Publisher
 * CSS is dropped on the way past, because the layout override re-flows the
 * text with the reader's own type scale and the file's stylesheet would
 * fight it.
 */
function readChapter(root, resolveImage) {
  const html = [];
  const text = [];

  const walk = (node) => {
    // firstChild/nextSibling rather than childNodes: no array is allocated
    // per element, and there are a great many elements.
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue;
        if (!value) continue;
        html.push(escapeText(value));
        text.push(value);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'IFRAME') continue;
      /* A picture drawn through SVG -- <svg><image xlink:href=...></svg> --
         is how a great many illustrated and fixed-layout books place a page
         that should fill the screen. SVG itself is not let through, so the
         picture inside it is taken out and treated as the picture it is;
         otherwise it went the way of the SVG and the page came out blank. */
      if (tag === 'IMAGE') {
        const src = svgImageSource(child);
        const href = src && resolveImage(src);
        if (href) html.push(`<img data-img="${escapeAttr(href)}">`);
        continue;
      }

      // Not allowed, but its contents might be: unwrap rather than drop.
      if (!ALLOWED.has(tag)) { walk(child); continue; }

      if (tag === 'IMG') {
        const src = child.getAttribute('src');
        if (!src) continue;
        const href = resolveImage(src);
        if (!href) continue;                     // missing from the archive
        const alt = child.getAttribute('alt');
        html.push(`<img data-img="${escapeAttr(href)}"`
          + (alt ? ` alt="${escapeAttr(alt)}"` : '') + '>');
        continue;
      }

      // Links become spans: the destination is meaningless once the book is
      // a set of records, and a live href is a way out of the reader.
      const name = tag === 'A' ? 'span' : tag.toLowerCase();
      html.push(`<${name}>`);
      walk(child);
      if (!VOID.has(name)) html.push(`</${name}>`);
    }
  };

  walk(root);
  return {
    html: html.join('').trim(),
    text: text.join(' ').replace(/\s+/g, ' ').trim(),
  };
}

const XLINK = 'http://www.w3.org/1999/xlink';

/** Where an SVG <image> takes its picture from: xlink:href, or plain href. */
function svgImageSource(node) {
  return node.getAttribute('xlink:href') || node.getAttributeNS?.(XLINK, 'href')
    || node.getAttribute('href') || null;
}

/** Image sources named in markup, without parsing it -- <img src>, and the
 *  <image href> an SVG-wrapped page uses -- in the order they appear. */
function imageRefs(markup) {
  const out = [];
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']|<image\b[^>]*?\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(markup)) !== null) out.push(match[1] || match[2]);
  return out;
}

/** The first heading in markup, without parsing it. */
function headingIn(markup) {
  const match = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(markup);
  if (!match) return null;
  return plainTextOf(match[1]) || null;
}

/** Text from markup this module produced, for the block parsers that build
 *  their markup as strings rather than by walking a tree. */
export function plainTextOf(html) {
  return html
    // Whatever is inside these is not prose. Stripping tags alone leaves the
    // stylesheet's own text behind, which then counts as words.
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

let lastTick = 0;

/**
 * Report progress and hand the main thread back.
 *
 * Both matter. Without the yield the UI cannot paint and Android eventually
 * decides the app is not responding; without the throttle the painting costs
 * more than the parsing.
 */
async function tick(onProgress, fraction) {
  const now = Date.now();
  if (now - lastTick < 100) return;
  lastTick = now;
  onProgress?.(fraction);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const CJK_FACTOR = { zh: 2.1, ja: 2.0, ko: 1.6 };

/**
 * Word counts have to be script-aware or a mixed shelf's stats are
 * meaningless: space-delimited languages count tokens, CJK counts characters
 * over a per-language factor. The stats screen says which it did.
 */
export function countWords(text, lang) {
  const base = (lang || '').slice(0, 2).toLowerCase();
  const factor = CJK_FACTOR[base];
  if (factor) return Math.round(text.replace(/\s/g, '').length / factor);
  return text.split(/\s+/).filter(Boolean).length;
}

function resolve(base, href) {
  const parts = base.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
};

function mimeOf(path) {
  return IMAGE_MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

/* ── EPUB ─────────────────────────────────────────────────────────────── */

/** Children of <parent> with the given local name, prefix-agnostic. */
function byLocalName(doc, parentName, childName) {
  const parent = doc.getElementsByTagName(parentName)[0];
  if (!parent) return [];
  return [...parent.children].filter((c) => c.localName === childName);
}

export /**
 * @param options.onImage  Called with each extracted image. When given, the
 *   images are not collected into the returned object -- a book with three
 *   hundred illustrations is a hundred and fifty megabytes of blobs, and
 *   holding all of them until the parse finishes is what makes the app die
 *   partway through a shelf.
 */
async function parseEpub(file, onProgress, { onImage } = {}) {
  const zip = await openArchive(file);

  const containerXml = await zip.text('META-INF/container.xml');
  if (!containerXml) throw new Error('Not an EPUB: META-INF/container.xml is missing');
  const opfPath = DOMP.parseFromString(containerXml, 'application/xml')
    .querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB container names no OPF file');

  const opf = DOMP.parseFromString(await zip.text(opfPath), 'application/xml');

  // Dublin Core elements are namespaced (dc:title, dc:creator), and the
  // prefix is not guaranteed to be "dc". Matching on localName sidesteps both
  // the prefix and the selector engine's namespace handling.
  const metadata = opf.getElementsByTagName('metadata')[0]
    || opf.documentElement.getElementsByTagName('metadata')[0];
  const meta = (name) => {
    if (!metadata) return null;
    for (const child of metadata.children) {
      if (child.localName === name) return child.textContent.trim();
    }
    return null;
  };
  const title = meta('title') || file.name.replace(/\.[^.]+$/, '');
  const author = meta('creator') || null;
  // A book this app wrote out names the book it came from; see exportId in
  // epub.js. Any of the identifiers may be it.
  let sourceId = null;
  for (const child of metadata ? metadata.children : []) {
    const text = child.localName === 'identifier' ? child.textContent.trim() : '';
    if (text.startsWith('urn:grimoire:')) {
      try { sourceId = decodeURIComponent(text.slice('urn:grimoire:'.length)) || null; } catch { sourceId = null; }
      break;
    }
  }
  const lang = meta('language') || null;

  // Calibre writes series into a meta tag; it is the only reliable source.
  const seriesMeta = metadata ? [...metadata.children].filter((c) => c.localName === 'meta') : [];
  const series = seriesMeta.find((m) => m.getAttribute('name') === 'calibre:series')?.getAttribute('content') || null;
  const seriesIndexRaw = seriesMeta.find((m) => m.getAttribute('name') === 'calibre:series_index')?.getAttribute('content');
  const seriesIndex = seriesIndexRaw ? parseFloat(seriesIndexRaw) : null;

  // manifest id -> { href, type, properties }
  const manifest = {};
  for (const item of byLocalName(opf, 'manifest', 'item')) {
    manifest[item.getAttribute('id')] = {
      href: resolve(opfPath, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    };
  }

  const spine = byLocalName(opf, 'spine', 'itemref')
    .map((ref) => manifest[ref.getAttribute('idref')])
    .filter((it) => it && /html/.test(it.type));

  // Cover: the EPUB3 property, then the EPUB2 meta pointer, then a guess.
  let coverItem = Object.values(manifest).find((m) => m.props.includes('cover-image'));
  if (!coverItem) {
    const id = seriesMeta.find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    if (id && manifest[id]) coverItem = manifest[id];
  }
  if (!coverItem) {
    coverItem = Object.values(manifest).find((m) => m.type.startsWith('image/') && /cover/i.test(m.href));
  }
  const coverBlob = coverItem ? await blobOf(zip, coverItem.href) : null;

  // Table of contents: EPUB3 nav document first, EPUB2 NCX second.
  const tocMap = await readToc(zip, opf, manifest, opfPath);

  const chapters = [];
  const images = [];
  let order = 0;

  // Images are extracted once each, not once per reference.
  const seen = new Map();
  let imageCount = 0;

  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    const raw = await zip.text(item.href);
    if (!raw) continue;

    /* Importing does not parse the chapter.
     *
     * Building a DOM costs 1.6ms a chapter and produces nothing an import
     * needs: the word count and the list of pictures can both be had from the
     * markup as text for a fifth of that, and the sanitised HTML is only
     * wanted when someone actually opens the chapter -- at which point 1.6ms
     * is invisible. On a shelf of a hundred and fifty long books it is the
     * difference between minutes and not.
     *
     * The source is kept as it came. Nothing is ever inserted from it without
     * going through the same sanitiser as before; that step has moved, not
     * gone.
     */
    const text = plainTextOf(raw);

    for (const src of imageRefs(raw)) {
      const href = resolve(item.href, src);
      if (seen.has(href)) continue;
      seen.set(href, true);

      const blob = await blobOf(zip, href);
      if (!blob) continue;          // referenced but not in the archive
      const record = {
        href, blob, order: order++, chapterIndex: i,
        animated: href.toLowerCase().endsWith('.gif'),
        // Left unmeasured on purpose. Decoding every illustration in every
        // book at import time is minutes of work for a number only the image
        // reel ever reads, and it measures them itself on first open.
        width: 0, height: 0,
      };
      imageCount += 1;
      // Handed straight on where there is somewhere to put it, so the blob
      // can be released as soon as it has been written.
      if (onImage) await onImage(record);
      else images.push(record);
    }

    if (!text && !/<img\b|<image\b/i.test(raw)) continue;

    chapters.push({
      index: chapters.length,
      title: tocMap.get(item.href) || headingIn(raw) || `Chapter ${chapters.length + 1}`,
      fromToc: tocMap.has(item.href),
      source: raw,
      // Where the chapter sits in the archive, so image references can be
      // resolved again when it is read.
      base: item.href,
      words: countWords(text, lang),
    });

    // Reported at most ten times a second: a progress bar redrawn once per
    // chapter is hundreds of layouts a book, and it competes with the work it
    // is describing. The yield is the point as much as the throttle -- it
    // lets the bar actually paint, and keeps the app answering taps.
    await tick(onProgress, (i + 1) / spine.length);
  }

  if (!chapters.length) throw new Error('EPUB spine produced no readable chapters');

  return {
    title, author, series, seriesIndex, lang, coverBlob, chapters, images,
    imageCount, sourceId,
    tocSource: tocMap.size ? 'the file\u2019s own table of contents'
                           : 'headings, because the file carries no table of contents',
  };
}

async function readToc(zip, opf, manifest, opfPath) {
  const map = new Map();
  const nav = Object.values(manifest).find((m) => m.props.includes('nav'));
  if (nav) {
    const raw = await zip.text(nav.href);
    if (raw) {
      const doc = DOMP.parseFromString(raw, 'application/xhtml+xml');
      for (const a of doc.querySelectorAll('nav a')) {
        const href = resolve(nav.href, (a.getAttribute('href') || '').split('#')[0]);
        const label = a.textContent.trim();
        if (href && label && !map.has(href)) map.set(href, label);
      }
    }
  }
  if (map.size) return map;

  const ncxId = opf.getElementsByTagName('spine')[0]?.getAttribute('toc');
  const ncx = ncxId && manifest[ncxId];
  if (ncx) {
    const raw = await zip.text(ncx.href);
    if (raw) {
      const doc = DOMP.parseFromString(raw, 'application/xml');
      for (const point of doc.querySelectorAll('navPoint')) {
        const src = point.querySelector('content')?.getAttribute('src') || '';
        const href = resolve(ncx.href, src.split('#')[0]);
        const label = point.querySelector('navLabel > text')?.textContent?.trim();
        if (href && label && !map.has(href)) map.set(href, label);
      }
    }
  }
  return map;
}

async function blobOf(zip, path) {
  if (!zip.has(path)) return null;
  if (zip.sizeOf(path) > MAX_IMAGE_BYTES) return null;   // see MAX_IMAGE_BYTES
  return zip.blob(path, mimeOf(path));
}


/* ── CBZ ──────────────────────────────────────────────────────────────── */

export async function parseCbz(file, onProgress, { onImage, prefix = null } = {}) {
  const zip = await openArchive(file);
  const fallback = file.name.replace(/\.[^.]+$/, '');
  const pictures = zip.names()
    .filter((name) => /\.(jpe?g|png|gif|webp|avif)$/i.test(name))
    .filter((name) => !name.startsWith('__MACOSX/') && !name.split('/').pop().startsWith('.'));

  if (!pictures.length) throw new Error('No images in this archive');

  /* A chapter per folder of pictures.
   *
   * A series downloaded as a folder per chapter used to come out as one
   * chapter called "Pages": every page of every chapter in a single run,
   * nothing in the index, and no way back to chapter thirty except
   * scrolling. The folders were the chapters all along. A comic with no
   * folders is still one chapter, as it was. */
  const comics = planComics(pictures, fallback);
  const comic = (prefix != null && comics.find((c) => c.prefix === prefix)) || comics[0];

  const dirOf = (path) => path.split('/').slice(0, -1).join('/');
  const order = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const runs = comic.chapters
    .map((chapter) => ({
      title: chapter.title,
      // Comic archives are ordered by filename and nothing else, so a natural
      // sort is the difference between page 2 and page 10 being adjacent.
      pages: pictures.filter((p) => dirOf(p) === chapter.folder).sort(order),
    }))
    .filter((run) => run.pages.length);

  const total = runs.reduce((n, run) => n + run.pages.length, 0);
  const images = [];
  const chapters = [];
  let coverBlob = null;
  let i = 0;

  for (const run of runs) {
    let html = '';
    for (const name of run.pages) {
      onProgress?.((i + 1) / total);
      const blob = await blobOf(zip, name);
      // Kept before the record is handed on: with a sink, images is empty by
      // the time the cover is needed.
      if (i === 0) coverBlob = blob;
      const record = {
        href: name, blob, order: i, chapterIndex: chapters.length,
        animated: /\.gif$/i.test(name),
        width: 0, height: 0,   // measured lazily by the reel; see parseEpub
      };
      if (onImage) await onImage(record); else images.push(record);
      html += `<figure><img data-img="${name.replace(/"/g, '&quot;')}" alt="Page ${i + 1}"></figure>`;
      i += 1;
    }
    chapters.push({
      index: chapters.length,
      // One run of pages is the whole comic, and keeps the name it always had.
      title: runs.length === 1 ? 'Pages' : run.title,
      fromToc: false,
      html,
      words: 0,
    });
  }

  return {
    // One comic is called what its file is called; one of several side by
    // side in a zip is called what its folder is called.
    title: comics.length === 1 ? fallback : (comic.title || fallback),
    author: null, series: null, seriesIndex: null, lang: null,
    coverBlob,
    chapters,
    images,
    imageCount: total,
    tocSource: runs.length > 1
      ? 'the folders in the archive, one chapter each'
      : 'the archive order — a comic has no chapters to derive',
  };
}

/* ── plain text, Markdown, HTML, FB2 ──────────────────────────────────── */

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Blob.text() needs Chrome 76. minSdk is 26, and a device that has never
 * updated its WebView can be older than that, so fall back to FileReader.
 */
function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

/* ── which encoding a text file is in ──────────────────────────────────
 *
 * Every text file used to be read as UTF-8, which is right for most and
 * ruinous for the rest: a Chinese novel saved as GBK, a Japanese one as
 * Shift-JIS, came out as a page of question-mark diamonds. So the bytes are
 * read first and the encoding chosen from them -- a byte-order mark if there
 * is one, UTF-8 if the file is valid UTF-8, and otherwise whichever of the
 * East Asian encodings makes the most sense of it, judged by how much of
 * what it produces is ordinary text in that language.
 */

/** The name a book called ".zip" should be read under: ".epub". */
export const asEpubName = (name) => {
  const base = String(name || 'book').replace(/\.zip$/i, '');
  return /\.epub$/i.test(base) ? base : `${base}.epub`;
};

/** The commonest Chinese characters, shared by simplified and traditional. */
/* The three hundred commonest Chinese characters -- about two thirds of any
 * Chinese text -- with the traditional forms of the ones that differ. Kept
 * short on purpose: a long list matches the characters a wrong encoding
 * produces as readily as the right ones. */
const COMMON_HAN = new Set([...'的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体相见被利什二等产或新己制身果加西月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活更别打女变四神总何电数安少报才结反受目太量再感建做接必场件计管期直命山金指许保至形便空决展马五基眼书非则听白却界光放强即像难且思王象完设色路记南住告类求程北边死张该交万取們這個來時會說對過發後裡經麼現當動還進樣開從實與長機無點業將兩間問應戰頭體見產']);

/** The commonest Korean syllables, for the same purpose. */
const COMMON_HANGUL = new Set([...'이다는의에하고를가지은서기사리도대한로아자수나해그어시일으인라게것을만들보요니정면장상우주있없했었습니고와부전과위내적말여때소생제동무원회성또많년할하여거간신모경저오두중데되치']);

/** How much like ordinary text a decoding is, per character that is not ASCII. */
function scoreDecoding(text) {
  let score = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;
    wide += 1;
    if (code === 0xFFFD) score -= 20;                                  // could not be read at all
    else if (COMMON_HAN.has(text[i])) score += 3;                      // an everyday Chinese character
    else if (code >= 0x3040 && code <= 0x30FF) score += 2.5;           // kana: Japanese
    else if (COMMON_HANGUL.has(text[i])) score += 3;                   // an everyday Korean syllable
    else if (code >= 0xAC00 && code <= 0xD7A3) score += 0.3;           // a rarer one
    else if (code >= 0x3000 && code <= 0x303F) score += 1;             // CJK punctuation
    else if (code >= 0xFF01 && code <= 0xFF5E) score += 1;             // full-width punctuation
    else if (code >= 0x4E00 && code <= 0x9FFF) score += 0.3;           // a rarer character
    else if (code >= 0xFF61 && code <= 0xFF9F) score -= 3;             // half-width katakana: almost always a misreading
    else if (code < 0xA0 || (code >= 0xE000 && code <= 0xF8FF)) score -= 5;  // control or private-use
    else if (code >= 0xD800 && code <= 0xDFFF) score -= 2;             // a character outside the common plane
  }
  return wide ? score / wide : 0;
}

/** The likeliest encoding for bytes that are not UTF-8. */
export function guessEncoding(bytes) {
  const sample = bytes.subarray(0, 256 * 1024);
  let best = 'windows-1252';
  let bestScore = 0.5;           // below this, none of them read as language
  // UTF-16 competes too: a file of Chinese in UTF-16 with no mark has no
  // zero bytes to give it away, and reads as nonsense in anything else.
  for (const name of ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'utf-16le', 'utf-16be']) {
    let text;
    try { text = new TextDecoder(name).decode(sample); } catch { continue; }
    const score = scoreDecoding(text);
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best;
}

function readBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

/** A text file's words, in whatever encoding it was saved in. */
export async function decodeText(file) {
  if (typeof TextDecoder !== 'function') return readText(file);
  const bytes = new Uint8Array(await readBytes(file));
  const [a, b, c] = bytes;
  if (a === 0xEF && b === 0xBB && c === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (a === 0xFF && b === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (a === 0xFE && b === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));

  // UTF-16 without a mark: every other byte is zero in anything mostly ASCII.
  const head = bytes.subarray(0, 4096);
  let evenZero = 0; let oddZero = 0;
  for (let i = 0; i < head.length; i++) if (!head[i]) { if (i % 2) oddZero += 1; else evenZero += 1; }
  if (oddZero > head.length / 4 && evenZero < head.length / 50) return new TextDecoder('utf-16le').decode(bytes);
  if (evenZero > head.length / 4 && oddZero < head.length / 50) return new TextDecoder('utf-16be').decode(bytes);

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder(guessEncoding(bytes)).decode(bytes);
  }
}

/**
 * Whether text arrived already ruined: a file that was once in another
 * encoding, read as UTF-8 by something along the way and saved like that,
 * so that most of its characters are the replacement mark. Nothing can bring
 * those characters back -- they are not in the file any more -- so the most
 * that can be done is to say so, rather than let it look like this reader's
 * mistake.
 */
export function looksDamaged(text) {
  const sample = text.slice(0, 200000);
  let lost = 0; let wide = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 0x80) continue;
    wide += 1;
    if (code === 0xFFFD) lost += 1;
  }
  return wide > 200 && lost / wide > 0.2;
}

export async function parseText(file) {
  const raw = await decodeText(file);
  const format = formatOf(file.name);
  let blocks;

  if (format === 'HTML') {
    const doc = DOMP.parseFromString(raw, 'text/html');
    const { html } = readChapter(doc.body, (src) => src);
    blocks = splitOnHeadings(html);
  } else if (format === 'FB2') {
    blocks = parseFb2(raw);
  } else {
    blocks = splitPlainText(raw, format === 'MD');
  }

  const lang = null;
  blocks = boundedChapters(blocks);
  return {
    title: file.name.replace(/\.[^.]+$/, ''),
    author: null, series: null, seriesIndex: null, lang, coverBlob: null,
    damaged: looksDamaged(raw),
    chapters: blocks.map((b, i) => ({
      index: i, title: b.title, fromToc: false, html: b.html,
      words: countWords(plainTextOf(b.html), lang),
    })),
    images: [],
    tocSource: format === 'HTML' || format === 'MD'
      ? 'heading levels in the file'
      : 'the chapter headings in the text, or parts of an even length where it has none',
  };
}

/* Where a paragraph ends, in plain text.
 *
 * Two conventions, and a book uses one or the other. English text from
 * Project Gutenberg and the like is wrapped at seventy characters with a blank
 * line between paragraphs; a Chinese or Japanese web novel, and plenty of
 * others, puts each paragraph on a line of its own and never leaves a line
 * blank. Read the second way as the first, a whole novel became one paragraph
 * -- a million characters in a single block, which a phone spends the better
 * part of a minute laying out, if it does not give up first.
 *
 * So: where the lines between blank lines mostly end a sentence, each line is
 * a paragraph; where they mostly stop mid-sentence, they are wrapping and the
 * blank lines are the breaks. */
const SENTENCE_END = /[.!?。！？…”"」』）)\]～~—:：]$/;

export function paragraphsOf(raw) {
  const text = raw.replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let byLine = false;
  if (lines.length > blocks.length) {
    const ended = lines.filter((l) => SENTENCE_END.test(l)).length / lines.length;
    const perBlock = lines.length / Math.max(1, blocks.length);
    // A block of many lines that end sentences is many paragraphs; one block
    // holding the whole book is never meant as one paragraph.
    byLine = blocks.length === 1 || (perBlock > 1.5 && ended > 0.5);
  }
  const paragraphs = byLine ? lines : blocks.map((b) => b.replace(/\s*\n\s*/g, ' '));
  return paragraphs.flatMap(splitLongParagraph);
}

/* No paragraph longer than a few screens.
 *
 * Even with the breaks found, a file can hold a block with no breaks in it at
 * all, and one enormous paragraph is the thing a page layout handles worst.
 * Cut at a sentence end near the limit, or at a space, or -- in a language
 * without spaces -- wherever the limit falls. */
const LONG_PARAGRAPH = 4000;

function splitLongParagraph(text) {
  if (text.length <= LONG_PARAGRAPH) return [text];
  const out = [];
  let rest = text;
  while (rest.length > LONG_PARAGRAPH) {
    const window = rest.slice(0, LONG_PARAGRAPH);
    let cut = -1;
    for (const mark of ['。', '！', '？', '. ', '! ', '? ', '…', '\u3000', ' ']) {
      const at = window.lastIndexOf(mark);
      if (at > LONG_PARAGRAPH / 2) { cut = at + mark.length; break; }
    }
    if (cut <= 0) cut = LONG_PARAGRAPH;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out.filter(Boolean);
}

/* A heading, in a book with no markup to say so.
 *
 * "Chapter 12", "PART TWO", and their equivalents elsewhere: 第十二章, 第3回,
 * 序章, 番外, プロローグ, 제12장. The all-capitals rule only applies where letters have
 * capitals -- Chinese has none, so every short line used to pass it, and a
 * novel read a line at a time became thousands of one-line chapters. */
const CJK_HEADING = /^(第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节回卷部集篇话話幕]|序章|序言|楔子|引子|尾声|尾聲|后记|後記|番外|终章|終章|プロローグ|エピローグ|あとがき|제\s*[0-9]+\s*[장화부권]|프롤로그|에필로그)/;

function looksLikeHeadingLine(p) {
  if (p.length > 60) return false;
  if (CJK_HEADING.test(p)) return true;
  if (/[.!?。！？]$/.test(p)) return false;
  if (/^(chapter|part|book|prologue|epilogue|interlude)\b/i.test(p)) return true;
  // All capitals, in a line that is mostly letters that have capitals.
  const cased = (p.match(/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g) || []).length;
  return cased >= 3 && cased / p.replace(/\s/g, '').length > 0.6 && p === p.toUpperCase();
}

function splitPlainText(raw, markdown) {
  const paragraphs = markdown
    ? raw.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    : paragraphsOf(raw);
  const chapters = [];
  let current = null;

  const push = (title) => { current = { title, html: '' }; chapters.push(current); };

  for (const p of paragraphs) {
    const md = markdown && /^(#{1,3})\s+(.*)$/.exec(p);
    // Even without Markdown, a short line that names itself a chapter is a
    // heading in practice; see looksLikeHeadingLine.
    const looksLikeHeading = !markdown && looksLikeHeadingLine(p);

    if (md) { push(md[2].trim()); continue; }
    if (looksLikeHeading) { push(p); continue; }
    if (!current) push('Beginning');

    if (markdown) {
      const inline = escapeHtml(p)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
      current.html += `<p>${inline.replace(/\n/g, ' ')}</p>`;
    } else {
      current.html += `<p>${escapeHtml(p).replace(/\n/g, ' ')}</p>`;
    }
  }

  if (!chapters.length) chapters.push({ title: 'Text', html: `<p>${escapeHtml(raw)}</p>` });
  return chapters;
}

/* No chapter longer than a reader can lay out quickly.
 *
 * A text with no headings it can find is one chapter, and one chapter is laid
 * out in one go -- for a whole novel, tens of seconds on a phone, and the page
 * holds every word of the book in memory while it is open. So a chapter over
 * the limit is cut into parts at paragraph boundaries, each named for the one
 * it came from. */
const LONG_CHAPTER = 64 * 1024;

export function boundedChapters(chapters) {
  const out = [];
  for (const chapter of chapters) {
    if (chapter.html.length <= LONG_CHAPTER) { out.push(chapter); continue; }
    const paragraphs = chapter.html.split(/(?<=<\/p>)/);
    const parts = [];
    let html = '';
    for (const p of paragraphs) {
      if (html && html.length + p.length > LONG_CHAPTER) { parts.push(html); html = ''; }
      html += p;
    }
    if (html) parts.push(html);
    const base = chapter.title === 'Beginning' || chapter.title === 'Text' ? 'Part' : chapter.title;
    parts.forEach((part, n) => out.push({
      ...chapter,
      title: parts.length === 1 ? chapter.title : `${base} ${n + 1}`,
      html: part,
    }));
  }
  return out;
}

function splitOnHeadings(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const chapters = [];
  let current = null;
  for (const node of [...holder.children]) {
    if (/^H[12]$/.test(node.tagName)) {
      current = { title: node.textContent.trim() || `Section ${chapters.length + 1}`, html: '' };
      chapters.push(current);
      continue;
    }
    if (!current) { current = { title: 'Beginning', html: '' }; chapters.push(current); }
    current.html += node.outerHTML;
  }
  return chapters.length ? chapters : [{ title: 'Document', html }];
}

function parseFb2(raw) {
  const doc = DOMP.parseFromString(raw, 'application/xml');
  const sections = [...doc.querySelectorAll('body > section')];
  if (!sections.length) return [{ title: 'Text', html: `<p>${escapeHtml(doc.textContent)}</p>` }];
  return sections.map((section, i) => {
    const title = section.querySelector('title')?.textContent?.trim() || `Section ${i + 1}`;
    const html = [...section.querySelectorAll('p')]
      .map((p) => `<p>${escapeHtml(p.textContent.trim())}</p>`).join('');
    return { title, html };
  });
}

/* ── archives ─────────────────────────────────────────────────────────── */

/** A book found inside an archive, with the folder path it was filed under. */
// { name, folder, blob }

/* Fifty thousand, not two thousand.
 *
 * The limit was there to refuse disk images, and it refused manga instead: a
 * series of sixty chapters at forty pages is two thousand four hundred
 * pictures, which is an ordinary download. Entries are read one at a time
 * as they are needed, so the number of them costs a list of names rather
 * than memory. */
const MAX_ARCHIVE_ENTRIES = 50000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/**
 * True when a .zip is a comic rather than a container of books.
 *
 * A CBZ is a zip of images and nothing else, and plenty of them are named
 * .zip. The distinction cannot be made from the extension, so it is made from
 * the contents: any recognisable book file inside means it is a container.
 */
/* Files that come along with a download and are not the thing downloaded.
 *
 * A folder of scanned pages almost always has one of these in it -- a readme,
 * a credits file, the scanlation group's note. They are plain text, and plain
 * text is a format this reader can open, so a single readme.txt was enough to
 * make an archive of six hundred images look like an archive containing one
 * book: the readme. Building it produced exactly that.
 */
const INCIDENTAL = /^(read ?me|readme|licen[cs]e|copying|credits?|info|notes?|desc(ription)?|changelog|source|links?|urls?)\b/i;
const INCIDENTAL_KIND = /\.(nfo|url|json|xml|ini|db|log|sfv|md5|torrent)$/i;

function isIncidental(name) {
  const leaf = String(name).split('/').pop();
  return INCIDENTAL.test(leaf) || INCIDENTAL_KIND.test(leaf);
}

/**
 * Whether an archive is a comic rather than a container of books.
 *
 * Judged on what the archive is mostly made of, not on whether a single
 * readable file can be found in it. One text file beside six hundred pages
 * does not make a library.
 */
/** What an archive is: 'comic' for pages, 'books' for a container. */
export function classifyArchive(entries) {
  return looksLikeComic(entries) ? 'comic' : 'books';
}

function looksLikeComic(entries) {
  const pictures = entries.filter((e) => /\.(jpe?g|png|gif|webp|avif)$/i.test(e.name));
  if (!pictures.length) return false;

  const books = entries.filter((e) =>
    ARCHIVE_CONTENTS.has(formatOf(e.name)) && !isIncidental(e.name));
  if (books.length) return false;

  // Pictures have to be the substance of it, not an illustration or two
  // among a pile of something else.
  return pictures.length >= (entries.length - pictures.length);
}

/**
 * Strip a wrapper directory shared by every entry.
 *
 * Zips made by right-clicking a folder put everything under one directory of
 * the same name. Keeping it would file every book under "My Books / …", which
 * is a folder level carrying no information.
 */
export function stripCommonRoot(paths) {
  if (paths.length < 2) {
    // With one file there is no evidence a leading directory is a wrapper
    // rather than a real folder, so leave it alone.
    return paths;
  }
  const split = paths.map((p) => p.split('/'));
  if (split.some((parts) => parts.length < 2)) return paths;
  const first = split[0][0];
  if (!split.every((parts) => parts[0] === first)) return paths;

  const stripped = split.map((parts) => parts.slice(1).join('/'));

  // If removing this directory leaves every book at the root, it was not a
  // wrapper -- it was the filing. A zip of one folder called "Fiction" should
  // produce a Fiction folder, not a pile of unfiled books.
  if (stripped.every((path) => !path.includes('/'))) return paths;

  return stripCommonRoot(stripped);
}

/**
 * Open a zip and return the books inside, each tagged with its folder.
 *
 * Directory structure is the point: a zip organised into folders is someone's
 * existing filing, and rebuilding it by hand after import is exactly the
 * tedium this avoids.
 */
export async function expandArchive(file, onProgress) {
  const zip = await openArchive(file);

  /* A book called a zip is a book.
   *
   * An EPUB is a zip, and a file manager, a cloud drive or a download can
   * hand one over named ".zip". Unpacked as an archive, every page inside it
   * -- ch0001.xhtml, ch0002.xhtml, the contents page -- came out as a book of
   * its own. Its container file says what it is; that is believed over the
   * name. */
  if (zip.has('META-INF/container.xml')) return { epub: true, comic: false, books: [] };

  const entries = zip.names().map((name) => ({ name })).filter((f) =>
    // Skip macOS resource forks and Windows thumbnail junk, which otherwise
    // import as empty "books" or invent a __MACOSX folder.
    !f.name.startsWith('__MACOSX/')
    && !f.name.split('/').pop().startsWith('._')
    && f.name.split('/').pop() !== 'Thumbs.db'
    && !f.name.split('/').pop().startsWith('.'));

  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`That archive holds ${entries.length} files. Split it up — this is meant for a library, not a disk image.`);
  }

  if (looksLikeComic(entries)) {
    /* One comic, or several side by side.
     *
     * A zip of two series, each a folder of chapter folders, is two comics.
     * Each is parsed from the same archive with its own part of the tree. */
    const fallback = file.name.replace(/\.[^.]+$/, '');
    const comics = planComics(entries.map((e) => e.name), fallback)
      .map(({ title, prefix }) => ({ title, prefix }));
    return { comic: true, comics, books: [] };
  }

  const books = entries.filter((e) =>
    ARCHIVE_CONTENTS.has(formatOf(e.name)) && !isIncidental(e.name));
  if (!books.length) {
    const nested = entries.some((e) => /\.zip$/i.test(e.name));
    throw new Error(nested
      ? 'That archive contains only more archives. Extract it once and import what is inside.'
      : 'No books found in that archive.');
  }

  // Folders come from the paths as they already are, minus any wrapper.
  const folders = stripCommonRoot(books.map((e) => e.name));

  // Deliberately NOT extracted here. Unpacking forty EPUBs up front holds all
  // of them in memory at once -- a few hundred megabytes for an ordinary
  // library archive, which is enough to have the WebView killed mid-import.
  // Each book is handed back with a read() that extracts it on demand, so the
  // importer can take one, store it, and let it go before touching the next.
  const entryOf = (entry, relative) => {
    const uncompressed = zip.sizeOf(entry.name);
    const parts = relative.split('/');
    const name = parts.pop();
    return {
      name,
      path: relative,
      folder: parts.join('/'),          // "" when the book sat at the root
      size: uncompressed,
      async read() {
        if (uncompressed > MAX_ENTRY_BYTES) {
          throw new Error(`${name} unpacks to something implausibly large; refusing.`);
        }
        return zip.blob(entry.name);
      },
    };
  };
  /* Every book in the archive is a book, filed in the folder it sat in.
   *
   * This is what the importer did in September, and it is right: a zip is
   * somebody's filing, and the importer's job is to put it on the shelf as
   * it is. For a while the importer also gathered chapter files into one
   * book -- and in doing so joined "Dune Part 1" to "Dune Part 2" and lifted
   * books out of the folders they were filed in. Joining is what Build is
   * for, where the parts are shown and the joining is asked for. */
  const out = books.map((entry, i) => entryOf(entry, folders[i]));

  const count = out.length;
  onProgress?.(1, `${count} book${count === 1 ? '' : 's'} found`);
  // Read from the front because its index was damaged; see recover() in
  // zipreader.js. Said, so a damaged file is not mistaken for a whole one.
  return { comic: false, books: out, recovered: !!zip.recovered };
}

/* ── entry point ──────────────────────────────────────────────────────── */

export async function parse(file, onProgress, options = {}) {
  let format = formatOf(file.name);

  // A .zip is either a comic or a container of books, and only its contents
  // can say which. The import pipeline resolves that before it gets here, so
  // reaching this with a container means a caller skipped a step.
  if (format === 'ZIP') {
    throw new Error('Archives are expanded before parsing; call expandArchive first.');
  }

  if (UNSUPPORTED_REASON[format]) {
    const err = new Error(UNSUPPORTED_REASON[format]);
    err.format = format;
    throw err;
  }

  const result = format === 'EPUB' ? await parseEpub(file, onProgress, options)
    // Loaded on demand: pdf.js is 1.8MB, and a library with no PDFs in it
    // should never pay for it.
    : format === 'PDF' ? await (await import('./pdf.js')).parsePdf(file, onProgress)
    : format === 'CBZ' ? await parseCbz(file, onProgress, options)
    : format === 'MHT' ? await parseMht(file, onProgress, options)
    : await parseText(file);

  result.format = SUPPORTED.has(format) ? format : 'TXT';
  result.words = result.chapters.reduce((n, c) => n + c.words, 0);
  return result;
}


/**
 * Several chapter files, as one book.
 *
 * The pieces of a work that arrived one file per chapter -- saved web pages,
 * numbered text files -- parsed in turn and laid end to end. Each piece is
 * parsed and let go before the next, and its pictures go straight to the sink
 * rather than accumulating, so a two-hundred-chapter novel costs one chapter's
 * worth of memory at a time.
 *
 * Pictures are re-keyed per piece. Every saved page names its pictures by the
 * address they had on the site, and two chapters of one novel routinely share
 * a banner or a divider: left as they were, the later one quietly replaces the
 * earlier.
 *
 * @param parts  [{ name, read() }] or Files, already in reading order.
 * @returns the same shape parse() does, plus `skipped` for pieces that would
 *   not read -- which cost their own chapter, never the book.
 */
/* A file the page is not allowed to read.
 *
 * Chromium's NotReadableError: the renderer was refused the file descriptor
 * behind the content:// URI, though the app's own process can usually still
 * open it. Recognised by name and, for WebViews that report it only as a
 * message, by the message. */
export const isUnreadable = (error) => error?.name === 'NotReadableError'
  || /could not be read, typically due to permission/i.test(error?.message || '');

/**
 * Do something with a file, and if the page is refused it, with a copy the
 * shell made instead.
 *
 * Tried first and rescued only on failure. Checking every file up front
 * meant a read per file before the first book had started -- for a few
 * hundred files from a slow provider, that was a long pause doing nothing.
 */
export async function withRescue(file, use, rescue) {
  try {
    return await use(file);
  } catch (error) {
    if (!rescue || !isUnreadable(error)) throw error;
    const copy = await rescue(file);
    return use(copy);
  }
}

/** A Blob's bytes, where arrayBuffer() is missing on an old WebView. */
export function bytesOf(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export async function parseChapters(parts, onProgress, { onImage, title, rescue } = {}) {
  const chapters = [];
  const images = [];
  const skipped = [];
  let order = 0;
  let coverBlob = null;

  /* Reading ahead.
   *
   * Every chapter is a separate read from wherever the file lives -- for a
   * pick from the phone's storage, a round trip through a content provider
   * each time -- and doing them strictly in turn meant the parser sat idle
   * through every one. The next few are fetched while the current one is
   * parsed, so the waiting overlaps the work. Three ahead: chapters are small,
   * and three is enough to hide a slow provider without holding a volume's
   * worth in memory. */
  const AHEAD = 3;
  const fetching = new Map();
  const isFile = (part) => part instanceof Blob && part.name != null;
  const fetchPart = (index) => {
    if (index >= parts.length || fetching.has(index)) return;
    const part = parts[index];
    fetching.set(index, (async () => (isFile(part)
      ? new File([await bytesOf(part)], part.name, { type: part.type })
      : new File([await part.read()], part.name)))()
      // Kept as a value, not thrown: a refused read is retried below, from
      // the original, where a rescue can see it.
      .catch((error) => ({ error })));
  };

  for (const [at, part] of parts.entries()) {
    for (let k = at; k <= at + AHEAD; k++) fetchPart(k);
    let parsed;
    try {
      const got = await fetching.get(at);
      fetching.delete(at);
      if (got?.error && !isFile(part)) throw got.error;
      const file = got?.error ? part : got;
      parsed = await withRescue(file,
        (readable) => parse(readable, (fraction) => onProgress?.((at + fraction) / parts.length)),
        rescue);
    } catch (error) {
      skipped.push({ name: part.name, reason: error.message || 'could not be read' });
      continue;
    }

    const prefix = `p${at}/`;
    const firstIndex = chapters.length;

    for (const chapter of parsed.chapters) {
      chapters.push({
        index: chapters.length,
        // A saved page's own heading, which is the chapter's real name; the
        // file name only where the page has none.
        title: chapter.title || stripExtension(part.name),
        fromToc: false,
        words: chapter.words || 0,
        ...(chapter.source != null
          ? { source: chapter.source, base: prefix + (chapter.base || '') }
          : {
            html: String(chapter.html || '').replace(
              /data-img="([^"]*)"/g, (_, href) => `data-img="${prefix}${href}"`),
          }),
      });
    }

    for (const image of parsed.images || []) {
      const record = {
        ...image,
        href: prefix + image.href,
        order: order++,
        chapterIndex: firstIndex + (image.chapterIndex || 0),
      };
      if (!coverBlob && record.blob) coverBlob = record.blob;
      if (onImage) await onImage(record); else images.push(record);
    }
    onProgress?.((at + 1) / parts.length);
  }

  if (!chapters.length) {
    throw new Error(skipped[0]
      ? `None of those chapters could be read — ${skipped[0].name}: ${skipped[0].reason}`
      : 'None of those chapters could be read.');
  }

  /* Named by what the chapters say they are, where the files did not.
   *
   * A folder of pages saved as "page.mht", "page (1).mht" gives the files
   * nothing to share, but the pages themselves usually do -- every one of
   * them is titled "Witch City - Chapter N". */
  const shared = commonLabel(chapters.map((c) => c.title || ''));
  const name = title && title !== 'Chapters' ? title : (shared || title || 'Chapters');

  return {
    title: name,
    author: null, series: null, seriesIndex: null, lang: null,
    coverBlob,
    chapters,
    images,
    imageCount: order,
    words: chapters.reduce((n, c) => n + (c.words || 0), 0),
    format: formatOf(parts[0]?.name || '') === 'MHT' ? 'MHT' : 'TXT',
    tocSource: 'one chapter per file, in the order their names give',
    skipped,
  };
}

/**
 * Loose pictures, as one comic.
 *
 * A chapter of a manga is a folder of numbered pictures, and picking the lot
 * to import made a book of each one: two hundred "books", every one of them a
 * picture's bytes read as if they were text. They are the pages of one thing,
 * in the order their numbers give.
 */
export async function parsePictures(files, onProgress, { onImage, title } = {}) {
  const pages = [...files].sort((a, b) => naturalOrder(a.name, b.name));
  if (!pages.length) throw new Error('No pictures to make a comic of.');

  let html = '';
  const images = [];
  for (const [at, file] of pages.entries()) {
    const href = `page${String(at + 1).padStart(4, '0')}-${file.name}`;
    const record = {
      href, blob: file, order: at, chapterIndex: 0,
      animated: /\.gif$/i.test(file.name), width: 0, height: 0,
    };
    if (onImage) await onImage(record); else images.push(record);
    html += `<figure><img data-img="${href.replace(/"/g, '&quot;')}" alt="Page ${at + 1}"></figure>`;
    onProgress?.((at + 1) / pages.length);
  }

  const shared = commonLabel(pages.map((p) => p.name));
  return {
    title: title || shared || `${pages.length} pages`,
    author: null, series: null, seriesIndex: null, lang: null,
    coverBlob: pages[0],
    chapters: [{ index: 0, title: 'Pages', fromToc: false, html, words: 0 }],
    images,
    imageCount: pages.length,
    words: 0,
    format: 'CBZ',
    tocSource: 'the pictures, in the order their names give',
  };
}

/**
 * A chapter as plain text, for anything that only wants the words.
 *
 * Searching a book asked for the sanitised HTML and then threw the markup
 * away again -- which meant parsing every chapter on every keystroke, about a
 * second on a long book. Stripping the source is forty times cheaper and
 * gives the same answer.
 */
export function chapterPlainText(chapter) {
  return plainTextOf(chapter.source ?? chapter.html ?? '');
}

/**
 * The chapter as HTML the reader can insert.
 *
 * Books imported before this returned already-sanitised HTML and keep it.
 * Newer ones hold their source as it came out of the archive, and it is
 * sanitised here, on the way to the page -- the same walk as before, moved
 * from import time to read time.
 */
export function chapterHtml(chapter) {
  if (chapter.html != null) return chapter.html;
  if (chapter.source == null) return '';

  const doc = DOMP.parseFromString(chapter.source, 'application/xhtml+xml');
  // A malformed chapter parses as an error document under the XML rules; the
  // HTML parser will take anything, and a book that will not open is worse
  // than one that renders a little loosely.
  const failed = doc.querySelector('parsererror');
  const tree = failed
    ? DOMP.parseFromString(chapter.source, 'text/html')
    : doc;

  const body = tree.querySelector('body') || tree.documentElement;
  const { html } = readChapter(body, (src) => resolve(chapter.base || '', src));
  return html;
}


/**
 * A filename the importer can work out a format from.
 *
 * Some providers hand a file over with no extension at all, and the first
 * bytes only get so far: an EPUB and a comic archive are both zips, so
 * guessing from the magic number alone turns every unnamed comic into a
 * broken EPUB. The archive's own directory says which it is, and reading a
 * directory is cheap — it is the tail of the file, not the file.
 */
export async function nameWithFormat(name, blob) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;

  const head = new Uint8Array(await firstBytes(blob, 4));
  const magic = String.fromCharCode(...head);

  if (magic.startsWith('%PDF')) return `${name}.pdf`;

  /* Pictures, by their first bytes.
   *
   * Now that the workshop accepts anything, a picture can arrive with no
   * extension at all -- plenty of downloaders name them by id. Without this
   * it would be offered to the text reader and refused.
   */
  const bytes = new Uint8Array(await firstBytes(blob, 12));
  const starts = (...values) => values.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return `${name}.png`;
  if (starts(0xff, 0xd8, 0xff)) return `${name}.jpg`;
  if (starts(0x47, 0x49, 0x46, 0x38)) return `${name}.gif`;
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return `${name}.webp`;
  }

  // A saved web page is a MIME message, and says so in its first lines.
  if (/^(from|mime-version|content-type|snapshot-content-location):/im.test(magicText(bytes))) {
    return `${name}.mht`;
  }

  if (magic.startsWith('PK')) {
    const zip = await openArchive(blob).catch(() => null);
    if (zip?.has('META-INF/container.xml')) return `${name}.epub`;

    const names = (zip?.names() || []).filter((n) => !n.startsWith('__MACOSX/'));

    /* A zip holding books is a container, not a book.
     *
     * Called an EPUB it goes to the EPUB reader, which finds no container.xml
     * and refuses the whole thing -- so a folder of volumes zipped together,
     * which is how a serial usually arrives, could not be opened at all.
     * Named for what it is, the importer unpacks it instead.
     */
    if (names.some((n) => /\.(epub|cbz|pdf|txt|md|html?|fb2|mht(ml)?)$/i.test(n))) return `${name}.zip`;

    // Mostly pictures is a comic. Requiring every last entry to be one meant
    // a readme alongside the pages was enough to rule it out.
    const pictures = names.filter((n) => /\.(jpe?g|png|gif|webp|avif)$/i.test(n));
    const others = names.filter((n) => !/\.(jpe?g|png|gif|webp|avif)$/i.test(n) && !isIncidental(n));
    if (pictures.length && pictures.length >= others.length) return `${name}.cbz`;
    return `${name}.epub`;
  }

  return `${name}.txt`;
}

const magicText = (bytes) => String.fromCharCode(...bytes);

/** The opening bytes of a blob, without depending on Blob.arrayBuffer. */
function firstBytes(blob, count) {
  const slice = blob.slice(0, count);
  if (typeof slice.arrayBuffer === 'function') return slice.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(slice);
  });
}
