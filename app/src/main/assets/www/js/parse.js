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

const DOMP = new DOMParser();

export const FORMATS = {
  epub: 'EPUB', cbz: 'CBZ', cbr: 'CBR', txt: 'TXT', md: 'MD',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML', fb2: 'FB2', zip: 'ZIP',
  pdf: 'PDF', docx: 'DOCX', mobi: 'MOBI', azw3: 'AZW3', rtf: 'RTF',
};

/** Formats with a working parser today. The rest are refused with a reason. */
export const SUPPORTED = new Set(['EPUB', 'PDF', 'CBZ', 'TXT', 'MD', 'HTML', 'FB2']);

/** Book formats that can live inside an archive. ZIP is not one of them:
 *  nested archives are refused rather than recursed into. */
export const ARCHIVE_CONTENTS = new Set(['EPUB', 'PDF', 'CBZ', 'TXT', 'MD', 'HTML', 'FB2']);

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

/** The first heading in already-sanitised markup, without re-parsing it. */
function firstHeading(html) {
  const match = /<(h[1-3])>([\s\S]*?)<\/\1>/.exec(html);
  if (!match) return null;
  return match[2].replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim() || null;
}

/** Text from markup this module produced, for the block parsers that build
 *  their markup as strings rather than by walking a tree. */
function plainTextOf(html) {
  return html.replace(/<[^>]*>/g, ' ')
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
  const zip = await JSZip.loadAsync(file);

  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('Not an EPUB: META-INF/container.xml is missing');
  const opfPath = DOMP.parseFromString(containerXml, 'application/xml')
    .querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB container names no OPF file');

  const opf = DOMP.parseFromString(await zip.file(opfPath).async('string'), 'application/xml');

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
    const raw = await zip.file(item.href)?.async('string');
    if (!raw) continue;

    const doc = DOMP.parseFromString(raw, 'application/xhtml+xml');
    const body = doc.querySelector('body') || doc.documentElement;

    /* Image references are resolved during the walk rather than afterwards.
       The extraction itself is deferred: doing it here would make the walk
       async, and awaiting inside a tight recursive function is what turns a
       few hundred microseconds into a few hundred milliseconds. */
    const wanted = [];
    const { html, text } = readChapter(body, (src) => {
      const href = resolve(item.href, src);
      if (!seen.has(href)) { seen.set(href, null); wanted.push({ href, chapterIndex: i }); }
      return href;
    });

    for (const { href, chapterIndex } of wanted) {
      const blob = await blobOf(zip, href);
      if (!blob) continue;          // referenced but not in the archive
      seen.set(href, true);
      const record = {
        href, blob, order: order++, chapterIndex,
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

    if (!text && !html.includes('<img')) continue;

    chapters.push({
      index: chapters.length,
      title: tocMap.get(item.href) || firstHeading(html) || `Chapter ${chapters.length + 1}`,
      fromToc: tocMap.has(item.href),
      html,
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
    imageCount,
    tocSource: tocMap.size ? 'the file\u2019s own table of contents'
                           : 'headings, because the file carries no table of contents',
  };
}

async function readToc(zip, opf, manifest, opfPath) {
  const map = new Map();
  const nav = Object.values(manifest).find((m) => m.props.includes('nav'));
  if (nav) {
    const raw = await zip.file(nav.href)?.async('string');
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
    const raw = await zip.file(ncx.href)?.async('string');
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
  const entry = zip.file(path);
  if (!entry) return null;
  const data = await entry.async('blob');
  return new Blob([data], { type: mimeOf(path) });
}


/* ── CBZ ──────────────────────────────────────────────────────────────── */

export async function parseCbz(file, onProgress, { onImage } = {}) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && /\.(jpe?g|png|gif|webp|avif)$/i.test(f.name))
    // Comic archives are ordered by filename and nothing else, so a natural
    // sort is the difference between page 2 and page 10 being adjacent.
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  if (!entries.length) throw new Error('No images in this archive');

  const images = [];
  let coverBlob = null;
  let html = '';
  for (let i = 0; i < entries.length; i++) {
    onProgress?.((i + 1) / entries.length);
    const blob = await blobOf(zip, entries[i].name);
    // Kept before the record is handed on: with a sink, images is empty by
    // the time the cover is needed.
    if (i === 0) coverBlob = blob;
    const record = {
      href: entries[i].name, blob, order: i, chapterIndex: 0,
      animated: /\.gif$/i.test(entries[i].name),
      width: 0, height: 0,   // measured lazily by the reel; see parseEpub
    };
    if (onImage) await onImage(record); else images.push(record);
    html += `<figure><img data-img="${entries[i].name.replace(/"/g, '&quot;')}" alt="Page ${i + 1}"></figure>`;
  }

  return {
    title: file.name.replace(/\.[^.]+$/, ''),
    author: null, series: null, seriesIndex: null, lang: null,
    coverBlob,
    chapters: [{ index: 0, title: 'Pages', fromToc: false, html, words: 0 }],
    images,
    imageCount: entries.length,
    tocSource: 'the archive order — a comic has no chapters to derive',
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

export async function parseText(file) {
  const raw = await readText(file);
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
  return {
    title: file.name.replace(/\.[^.]+$/, ''),
    author: null, series: null, seriesIndex: null, lang, coverBlob: null,
    chapters: blocks.map((b, i) => ({
      index: i, title: b.title, fromToc: false, html: b.html,
      words: countWords(plainTextOf(b.html), lang),
    })),
    images: [],
    tocSource: format === 'HTML' || format === 'MD'
      ? 'heading levels in the file'
      : 'blank-line breaks, because plain text carries no structure',
  };
}

function splitPlainText(raw, markdown) {
  const paragraphs = raw.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chapters = [];
  let current = null;

  const push = (title) => { current = { title, html: '' }; chapters.push(current); };

  for (const p of paragraphs) {
    const md = markdown && /^(#{1,3})\s+(.*)$/.exec(p);
    // Even without Markdown, a short all-caps line on its own is a heading in
    // practice — it is how nearly every plain-text book marks a chapter.
    const looksLikeHeading = !markdown && p.length < 60 && !/[.!?]$/.test(p)
      && (/^(chapter|part|book)\b/i.test(p) || p === p.toUpperCase());

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

const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/**
 * True when a .zip is a comic rather than a container of books.
 *
 * A CBZ is a zip of images and nothing else, and plenty of them are named
 * .zip. The distinction cannot be made from the extension, so it is made from
 * the contents: any recognisable book file inside means it is a container.
 */
function looksLikeComic(entries) {
  const books = entries.filter((e) => ARCHIVE_CONTENTS.has(formatOf(e.name)));
  if (books.length) return false;
  return entries.some((e) => /\.(jpe?g|png|gif|webp|avif)$/i.test(e.name));
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
  const zip = await JSZip.loadAsync(file);

  const entries = Object.values(zip.files).filter((f) => !f.dir
    // Skip macOS resource forks and Windows thumbnail junk, which otherwise
    // import as empty "books" or invent a __MACOSX folder.
    && !f.name.startsWith('__MACOSX/')
    && !f.name.split('/').pop().startsWith('._')
    && f.name.split('/').pop() !== 'Thumbs.db'
    && !f.name.split('/').pop().startsWith('.'));

  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`That archive holds ${entries.length} files. Split it up — this is meant for a library, not a disk image.`);
  }

  if (looksLikeComic(entries)) return { comic: true, books: [] };

  const books = entries.filter((e) => ARCHIVE_CONTENTS.has(formatOf(e.name)));
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
  const out = books.map((entry, i) => {
    const uncompressed = entry._data?.uncompressedSize ?? 0;
    const relative = folders[i];
    const parts = relative.split('/');
    const name = parts.pop();
    return {
      name,
      folder: parts.join('/'),          // "" when the book sat at the root
      size: uncompressed,
      async read() {
        if (uncompressed > MAX_ENTRY_BYTES) {
          throw new Error(`${name} unpacks to something implausibly large; refusing.`);
        }
        return entry.async('blob');
      },
    };
  });

  onProgress?.(1, `${out.length} books found`);
  return { comic: false, books: out };
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
    : await parseText(file);

  result.format = SUPPORTED.has(format) ? format : 'TXT';
  result.words = result.chapters.reduce((n, c) => n + c.words, 0);
  return result;
}
