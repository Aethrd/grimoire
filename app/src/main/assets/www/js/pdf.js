/* PDF.
 *
 * Text is extracted rather than the pages being drawn as pictures. A PDF read
 * as images would lose search, the layout override, translation, copy and
 * reflow -- everything that makes the rest of this a reader rather than a
 * viewer. The trade is that a PDF laid out in columns, or one that is really
 * a scan, extracts poorly; there is no fixing that from this side.
 *
 * pdf.js is vendored (about 1.8MB before compression) because the app fetches
 * nothing at runtime. It is loaded on demand, so a library with no PDFs in it
 * never pays for it.
 */

import { readArrayBuffer } from './blobs.js';

let pdfjs = null;

/**
 * pdf.js 4.x calls Promise.withResolvers, which needs Chrome 119. WebView
 * updates through Play so most devices have it, but minSdk here is 26 and a
 * device that has never updated would fail on PDFs alone. Three lines is
 * cheaper than finding that out from a bug report.
 */
function polyfill() {
  if (typeof Promise.withResolvers === 'function') return;
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

/** Loaded the first time a PDF is opened, not before. */
async function library() {
  if (pdfjs) return pdfjs;
  polyfill();
  pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

/* ── text assembly ────────────────────────────────────────────────────── */

/**
 * Turn a page's text items into lines.
 *
 * pdf.js hands back positioned fragments, not lines: a single line often
 * arrives as several items, and only `hasEOL` says where one ends.
 */
export function itemsToLines(items) {
  const lines = [];
  let current = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    current += item.str;
    if (item.hasEOL) {
      lines.push(current.replace(/\s+/g, ' ').trim());
      current = '';
    }
  }
  if (current.trim()) lines.push(current.replace(/\s+/g, ' ').trim());
  return lines;
}

/**
 * Join lines back into paragraphs.
 *
 * A PDF records where each line was drawn, not where a paragraph began, so
 * this is a guess: a line noticeably shorter than the ones around it is
 * usually the end of a paragraph, and a blank line always is. It is wrong
 * sometimes, and it is still far better than one paragraph per line.
 */
export function linesToParagraphs(lines) {
  const widths = lines.filter((l) => l.length > 0).map((l) => l.length);
  if (!widths.length) return [];
  const typical = widths.sort((a, b) => a - b)[Math.floor(widths.length * 0.6)] || 0;
  const shortEnough = typical * 0.72;

  const paragraphs = [];
  let current = [];
  const flush = () => {
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const line of lines) {
    if (!line) { flush(); continue; }
    current.push(line);
    // A short line ends a paragraph, unless it is the only thing in it --
    // headings and one-line paragraphs are both short by nature.
    if (line.length < shortEnough) flush();
  }
  flush();
  return paragraphs.filter(Boolean);
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export const paragraphsToHtml = (paragraphs) =>
  paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');

/* ── chapters ─────────────────────────────────────────────────────────── */

/** Pages per chapter when a PDF carries no outline to divide it by. */
const PAGES_PER_CHAPTER = 20;

/**
 * Work out where chapters begin.
 *
 * The document's own outline is used when it has one and its destinations
 * resolve; otherwise the pages are cut into even runs, which at least gives
 * the index something to list and the reader something to jump between.
 */
export function chapterRanges(starts, pageCount) {
  if (!starts.length) {
    const ranges = [];
    for (let page = 1; page <= pageCount; page += PAGES_PER_CHAPTER) {
      const last = Math.min(page + PAGES_PER_CHAPTER - 1, pageCount);
      ranges.push({ title: `Pages ${page}–${last}`, from: page, to: last, fromOutline: false });
    }
    return ranges;
  }

  const sorted = [...starts].sort((a, b) => a.page - b.page);
  if (sorted[0].page > 1) sorted.unshift({ title: 'Front matter', page: 1 });

  return sorted.map((entry, i) => ({
    title: entry.title,
    from: entry.page,
    to: i + 1 < sorted.length ? sorted[i + 1].page - 1 : pageCount,
    fromOutline: true,
  })).filter((range) => range.to >= range.from);
}

async function outlineStarts(doc) {
  try {
    const outline = await doc.getOutline();
    if (!outline?.length) return [];

    const starts = [];
    for (const entry of outline) {
      try {
        const dest = typeof entry.dest === 'string'
          ? await doc.getDestination(entry.dest)
          : entry.dest;
        if (!Array.isArray(dest) || !dest[0]) continue;
        const index = await doc.getPageIndex(dest[0]);
        const title = (entry.title || '').replace(/\s+/g, ' ').trim();
        if (title) starts.push({ title, page: index + 1 });
      } catch {
        // A single unresolvable destination should not cost the whole outline.
      }
    }
    return starts;
  } catch {
    return [];
  }
}

/* ── cover ────────────────────────────────────────────────────────────── */

/**
 * Render the first page as the cover. A PDF carries no cover image, and a
 * shelf of identical typeset placeholders is no use for telling them apart.
 */
async function renderCover(doc) {
  try {
    const page = await doc.getPage(1);
    const scale = 600 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: Math.min(scale, 2) });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;           // no canvas support; not worth failing over
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    await page.render({ canvasContext: context, viewport }).promise;
    return await new Promise((resolve) => {
      if (!canvas.toBlob) return resolve(null);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82);
    });
  } catch {
    return null;
  }
}

/* ── entry point ──────────────────────────────────────────────────────── */

export async function parsePdf(file, onProgress) {
  const pdf = await library();
  const data = new Uint8Array(await readArrayBuffer(file));

  const doc = await pdf.getDocument({
    data,
    // Character maps, for PDFs whose CJK fonts are referenced rather than
    // embedded -- which is most Korean and Japanese ones. Without these their
    // text extracts as mojibake or as nothing at all.
    cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
    cMapPacked: true,
    // The base fourteen fonts, likewise referenced rather than embedded in a
    // great many PDFs.
    standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
    // The reader treats a book as untrusted input everywhere else; there is no
    // reason to hand a PDF a scripting engine either.
    isEvalSupported: false,
    disableAutoFetch: true,
  }).promise;

  const pageCount = doc.numPages;
  const ranges = chapterRanges(await outlineStarts(doc), pageCount);

  const info = await doc.getMetadata().catch(() => null);
  const meta = info?.info || {};

  const chapters = [];
  let read = 0;

  for (const range of ranges) {
    const paragraphs = [];
    for (let number = range.from; number <= range.to; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      paragraphs.push(...linesToParagraphs(itemsToLines(content.items)));
      // Pages hold on to a lot; letting each go keeps a long PDF from
      // accumulating the whole document in memory.
      page.cleanup();
      read += 1;
      onProgress?.(read / pageCount);
    }
    const html = paragraphsToHtml(paragraphs);
    chapters.push({
      index: chapters.length,
      title: range.title,
      fromToc: range.fromOutline,
      html,
      words: paragraphs.join(' ').split(/\s+/).filter(Boolean).length,
    });
  }

  const coverBlob = await renderCover(doc);
  const withText = chapters.filter((c) => c.html.length > 0);

  await doc.cleanup().catch(() => {});

  if (!withText.length) {
    throw new Error('No text in that PDF. It is probably a scan, which needs '
      + 'optical character recognition rather than a reader.');
  }

  return {
    title: (meta.Title || '').trim() || file.name.replace(/\.[^.]+$/, ''),
    author: (meta.Author || '').trim() || null,
    series: null,
    seriesIndex: null,
    lang: (meta.Language || '').trim() || null,
    coverBlob,
    chapters: withText.map((c, i) => ({ ...c, index: i })),
    images: [],
    tocSource: ranges[0]?.fromOutline
      ? 'the PDF\u2019s own outline'
      : 'even runs of pages, because the file carries no outline',
  };
}
