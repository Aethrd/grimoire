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
export const SUPPORTED = new Set(['EPUB', 'CBZ', 'TXT', 'MD', 'HTML', 'FB2']);

/** Book formats that can live inside an archive. ZIP is not one of them:
 *  nested archives are refused rather than recursed into. */
export const ARCHIVE_CONTENTS = new Set(['EPUB', 'CBZ', 'TXT', 'MD', 'HTML', 'FB2']);

export const UNSUPPORTED_REASON = {
  PDF: 'PDF needs a renderer. Vendor pdf.js into www/vendor, or add a native bridge method backed by PdfRenderer.',
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

/**
 * Strip everything the reader will not render. Publisher CSS goes too: the
 * layout override re-flows the text with the reader's own type scale, and
 * keeping the file's stylesheet would fight it.
 */
function sanitise(root, doc) {
  const out = doc.createElement('div');
  const walk = (node, into) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(doc.createTextNode(child.nodeValue));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'IFRAME') continue;
      if (!ALLOWED.has(tag)) { walk(child, into); continue; }

      const el = doc.createElement(tag === 'A' ? 'span' : tag.toLowerCase());
      if (tag === 'IMG') {
        const src = child.getAttribute('src');
        if (!src) continue;
        el.setAttribute('data-src', src);           // resolved to a blob later
        const alt = child.getAttribute('alt');
        if (alt) el.setAttribute('alt', alt);
      }
      walk(child, el);
      into.appendChild(el);
    }
  };
  walk(root, out);
  return out.innerHTML.trim();
}

function textOf(html) {
  const d = DOMP.parseFromString(`<body>${html}</body>`, 'text/html');
  return d.body.textContent.replace(/\s+/g, ' ').trim();
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

export async function parseEpub(file, onProgress) {
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

  for (let i = 0; i < spine.length; i++) {
    onProgress?.((i + 1) / spine.length);
    const item = spine[i];
    const raw = await zip.file(item.href)?.async('string');
    if (!raw) continue;

    const doc = DOMP.parseFromString(raw, 'application/xhtml+xml');
    const body = doc.querySelector('body') || doc.documentElement;
    let html = sanitise(body, document);

    // Rewrite every image reference to a blob the reader can show offline.
    const holder = document.createElement('div');
    holder.innerHTML = html;
    for (const img of holder.querySelectorAll('img[data-src]')) {
      const href = resolve(item.href, img.getAttribute('data-src'));
      let record = images.find((im) => im.href === href);
      if (!record) {
        const blob = await blobOf(zip, href);
        if (!blob) { img.remove(); continue; }
        record = {
          href, blob, order: order++, chapterIndex: i,
          animated: href.toLowerCase().endsWith('.gif'),
          // Left unmeasured on purpose. Decoding every illustration in every
          // book at import time is minutes of work for a number only the
          // image reel ever reads, and it measures them itself on first open.
          width: 0, height: 0,
        };
        images.push(record);
      }
      // The chapter keeps a reference, not a URL. The reader resolves it
      // against the stored blobs each time it renders the chapter.
      img.setAttribute('data-img', record.href);
      img.removeAttribute('data-src');
    }
    html = holder.innerHTML;

    const text = textOf(html);
    if (!text && !holder.querySelector('img')) continue;

    const heading = holder.querySelector('h1, h2, h3')?.textContent?.trim();
    chapters.push({
      index: chapters.length,
      title: tocMap.get(item.href) || heading || `Chapter ${chapters.length + 1}`,
      fromToc: tocMap.has(item.href),
      html,
      words: countWords(text, lang),
    });
  }

  if (!chapters.length) throw new Error('EPUB spine produced no readable chapters');

  return {
    title, author, series, seriesIndex, lang, coverBlob, chapters, images,
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

export async function parseCbz(file, onProgress) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && /\.(jpe?g|png|gif|webp|avif)$/i.test(f.name))
    // Comic archives are ordered by filename and nothing else, so a natural
    // sort is the difference between page 2 and page 10 being adjacent.
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  if (!entries.length) throw new Error('No images in this archive');

  const images = [];
  let html = '';
  for (let i = 0; i < entries.length; i++) {
    onProgress?.((i + 1) / entries.length);
    const blob = await blobOf(zip, entries[i].name);
    images.push({
      href: entries[i].name, blob, order: i, chapterIndex: 0,
      animated: /\.gif$/i.test(entries[i].name),
      width: 0, height: 0,   // measured lazily by the reel; see parseEpub
    });
    html += `<figure><img data-img="${entries[i].name.replace(/"/g, '&quot;')}" alt="Page ${i + 1}"></figure>`;
  }

  return {
    title: file.name.replace(/\.[^.]+$/, ''),
    author: null, series: null, seriesIndex: null, lang: null,
    coverBlob: images[0].blob,
    chapters: [{ index: 0, title: 'Pages', fromToc: false, html, words: 0 }],
    images,
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
    const html = sanitise(doc.body, document);
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
      words: countWords(textOf(b.html), lang),
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

export async function parse(file, onProgress) {
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

  const result = format === 'EPUB' ? await parseEpub(file, onProgress)
    : format === 'CBZ' ? await parseCbz(file, onProgress)
    : await parseText(file);

  result.format = SUPPORTED.has(format) ? format : 'TXT';
  result.words = result.chapters.reduce((n, c) => n + c.words, 0);
  return result;
}
