/* MOBI, AZW3 and their older relatives, as books like any other.
 *
 * Kindle books come in two layouts inside the same Palm database container:
 * the original MOBI, one long stream of HTML cut into chapters at page
 * breaks, and KF8 (AZW3), which is close to an EPUB packed into records.
 * Most .mobi files made in the last decade carry both, and the KF8 half is
 * the better one; foliate-js's reader (vendor/foliate/mobi.js) opens either,
 * and prefers KF8 where there is a choice.
 *
 * What comes out of it is HTML per chapter, with pictures named by record
 * number. Each chapter goes through the same reader every other format goes
 * through (parse.js's readChapter) -- so nothing a Kindle file carries can do
 * more on the page than an EPUB can -- and its pictures are taken out of the
 * file as it goes, the way an EPUB's are.
 *
 * Not opened: books locked to a Kindle (DRM). Those are encrypted, and are
 * said to be so rather than read as nonsense.
 */

import { readChapter, countWords, plainTextOf, boundedChapters } from './parse.js';

const EMBED = /kindle:embed:(\w+)/i;
const FLOW = /kindle:flow:(\w+)/i;

/* A File, as the reader asks for one: slices that read as ArrayBuffers.
 * Read through FileReader where an old WebView has no Blob.arrayBuffer. */
function source(file, onRead) {
  const read = (blob) => (typeof blob.arrayBuffer === 'function'
    ? blob.arrayBuffer()
    : new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    }));
  return {
    size: file.size,
    slice: (start, end) => {
      const piece = file.slice(start, end);
      return {
        arrayBuffer: async () => {
          const bytes = await read(piece);
          onRead?.();
          return bytes;
        },
      };
    },
  };
}

const ascii = (bytes) => String.fromCharCode(...bytes);

/** What kind of Palm book this is, read from its first record. */
async function inspect(file) {
  const read = (start, end) => source(file).slice(start, end).arrayBuffer();
  const head = new Uint8Array(await read(0, 86));
  if (head.length < 86) throw new Error('This file is too short to be a Kindle book.');
  const type = ascii(head.subarray(60, 68));
  const view = new DataView(head.buffer);
  const first = view.getUint32(78);
  const record = new DataView(await read(first, first + 16));
  return {
    type,
    compression: record.getUint16(0),
    encryption: record.getUint16(12),
    textRecords: record.getUint16(8),
    first,
  };
}

/* ── old Palm text (TEXtREAd) ────────────────────────────────────────────
 *
 * Before Mobipocket there was PalmDOC: the same container holding plain text,
 * sometimes compressed. A few of these turn up named .mobi or .prc. They are
 * text and nothing else, so they are read as text. */
function unpackPalmDoc(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    const c = bytes[i++];
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) out.push(c);
    else if (c >= 0x01 && c <= 0x08) for (let n = 0; n < c && i < bytes.length; n++) out.push(bytes[i++]);
    else if (c >= 0xc0) out.push(0x20, c ^ 0x80);
    else if (i < bytes.length) {
      const pair = (c << 8) | bytes[i++];
      const distance = (pair >> 3) & 0x07ff;
      const length = (pair & 7) + 3;
      for (let n = 0; n < length; n++) out.push(out[out.length - distance]);
    }
  }
  return new Uint8Array(out);
}

async function palmText(file, info) {
  const { parseText } = await import('./parse.js');
  const offsets = new DataView(await source(file).slice(78, 78 + (info.textRecords + 2) * 8).arrayBuffer());
  const pieces = [];
  for (let i = 1; i <= info.textRecords; i++) {
    const start = offsets.getUint32(i * 8);
    const end = i + 1 < offsets.byteLength / 8 ? offsets.getUint32((i + 1) * 8) : file.size;
    const raw = new Uint8Array(await source(file).slice(start, end).arrayBuffer());
    pieces.push(info.compression === 2 ? unpackPalmDoc(raw) : raw);
  }
  const name = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');
  /* Mobipocket's own early files are this container holding HTML, not
   * text: read as text, they came out as a page of tags. */
  const lead = ascii(pieces[0]?.subarray(0, 400) || []).toLowerCase();
  const markup = /<(html|head|body|p|div|h[1-6])[\s>]/.test(lead);
  if (!markup) return { ...(await parseText(new File(pieces, `${name}.txt`))), format: 'MOBI' };
  // Pictures in these point at records the format never had: left out
  // rather than shown as broken.
  const whole = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  pieces.reduce((at, p) => { whole.set(p, at); return at + p.length; }, 0);
  const html = new TextDecoder('windows-1252').decode(whole).replace(/<img\b[^>]*>/gi, '');
  const book = await parseText(new File([html], `${name}.html`));
  // Nothing but the file's own header, before the first heading, is not a chapter.
  book.chapters = book.chapters.filter((c) => plainTextOf(c.html).trim())
    .map((c, index) => ({ ...c, index }));
  return { ...book, format: 'MOBI' };
}

/* ── pictures ─────────────────────────────────────────────────────────── */

function typeOf(bytes) {
  const b = new Uint8Array(bytes.slice ? bytes.slice(0, 12) : bytes);
  const text = ascii(b);
  if (text.startsWith('GIF8')) return ['image/gif', 'gif'];
  if (b[0] === 0x89 && text.slice(1, 4) === 'PNG') return ['image/png', 'png'];
  if (b[0] === 0xff && b[1] === 0xd8) return ['image/jpeg', 'jpg'];
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return ['image/webp', 'webp'];
  if (text.startsWith('BM')) return ['image/bmp', 'bmp'];
  return [null, null];
}

/**
 * @returns the same shape parse() does: title, author, lang, chapters,
 *   images (or each handed to onImage as it is found), coverBlob.
 */
export async function parseMobi(file, onProgress, { onImage } = {}) {
  const info = await inspect(file);
  if (info.encryption) {
    throw new Error('This book is locked to a Kindle (DRM), so it cannot be opened here.');
  }
  if (info.type === 'TEXtREAd') return palmText(file, info);
  if (info.type !== 'BOOKMOBI') throw new Error('This is not a Kindle book this app can read.');

  const { MOBI } = await import('../vendor/foliate/mobi.js');
  const mobi = new MOBI({ unzlib: null });
  /* Opening reads and unpacks all of the text before anything else can
   * happen -- for an omnibus, a thousand records and several seconds on a
   * phone. Counted as it goes, so the progress bar moves through it instead
   * of sitting at nothing. */
  let reads = 0;
  const counted = source(file, () => {
    reads += 1;
    if (reads % 20 === 0) onProgress?.(Math.min(0.25, (0.25 * reads) / Math.max(1, info.textRecords)));
  });
  let book;
  try {
    book = await mobi.open(counted);
  } catch (error) {
    throw new Error(`This Kindle book could not be read: ${error.message || error}`);
  }
  const kf8 = typeof book.loadFlow === 'function';
  const meta = book.metadata || {};
  // A list where the book names more than one; the first is its own.
  const lang = (Array.isArray(meta.language) ? meta.language[0] : meta.language) || null;
  const title = (meta.title || '').trim() || file.name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const author = Array.isArray(meta.author) ? meta.author.filter(Boolean).join(', ') : (meta.author || null);

  /* Pictures, by the record they are in. Each is taken out once, however
   * many chapters show it, and handed on as soon as the chapter it is first
   * in has its number. */
  const pictures = new Map();          // record -> { href, blob, animated }
  let order = 0;
  const picture = async (record) => {
    if (!Number.isFinite(record) || record < 0) return null;
    if (pictures.has(record)) return pictures.get(record);
    let found = null;
    try {
      const bytes = await mobi.loadResource(record);
      const [type, ext] = typeOf(bytes);
      if (type) {
        found = {
          href: `mobi/${record}.${ext}`,
          blob: new Blob([bytes], { type }),
          animated: type === 'image/gif',
          handed: false,
        };
      }
    } catch { /* a missing record is a missing picture, not a missing book */ }
    pictures.set(record, found);
    return found;
  };
  /* Where a src points: the record of a picture, by whichever spelling the
   * book uses -- recindex in MOBI, kindle:embed in KF8, or a KF8 SVG "flow"
   * that wraps a picture to fill the page, which is unwrapped to it. */
  const recordOf = async (src) => {
    const recindex = /^recindex:(\d+)/.exec(src);
    if (recindex) return Number(recindex[1]) - 1;
    const embed = EMBED.exec(src);
    if (embed) return parseInt(embed[1], 32) - 1;
    const flow = FLOW.exec(src);
    if (flow && kf8) {
      try {
        const svg = mobi.decode(await book.loadFlow(parseInt(flow[1], 32)));
        const inner = EMBED.exec(svg);
        if (inner) return parseInt(inner[1], 32) - 1;
      } catch { /* not a picture, then */ }
    }
    return null;
  };

  /* Where chapters begin, and what they are called.
   *
   * The older layout carries an index of every chapter by its place in the
   * text (the NCX); its contents page often links only a handful of them --
   * seven, in an omnibus of a hundred and thirty chapters. The index is used
   * where there is one, and the contents page where there is not. Each entry
   * is placed in the section it falls in, and at the element it points to
   * where that can be found, so a section holding several chapters is cut
   * where each begins. */
  const entries = [];
  const place = async (label, href) => {
    try {
      const where = await book.resolveHref(href);
      if (!where || where.index == null || where.index < 0) return;
      entries.push({ label: String(label || '').replace(/\s+/g, ' ').trim(), index: where.index, anchor: where.anchor });
    } catch { /* an entry that points nowhere names nothing */ }
  };
  if (!kf8) {
    let ncx = null;
    try { ncx = await mobi.getNCX(); } catch { ncx = null; }
    for (const entry of ncx || []) {
      if (entry?.offset != null && entry.label) await place(entry.label, `filepos:${entry.offset}`);
    }
  }
  if (!entries.length) {
    const walk = async (items) => {
      for (const item of items || []) {
        await place(item.label, item.href);
        await walk(item.subitems);
      }
    };
    await walk(book.toc);
  }
  const marksBySection = new Map();
  for (const entry of entries) {
    if (!marksBySection.has(entry.index)) marksBySection.set(entry.index, []);
    marksBySection.get(entry.index).push(entry);
  }
  const named = entries.length > 0;

  const chapters = [];
  const images = [];
  /* A chapter is gathered until the next one begins. A page break inside a
   * chapter -- before an illustration, say -- does not start a new one when
   * the book says where its chapters are; without that, every break does. */
  let open = null;
  const firstLine = (text) => text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l) || '';
  const finish = async () => {
    if (!open) return;
    const chapter = open;
    open = null;
    // A chapter can still be a whole novel; long ones are cut as a text
    // file's would be, so no chapter is too long to lay out.
    for (const part of boundedChapters([{ title: chapter.title, html: chapter.html.join('') }])) {
      const index = chapters.length;
      chapters.push({
        index,
        title: part.title,
        fromToc: chapter.fromToc,
        html: part.html,
        words: countWords(plainTextOf(part.html), lang),
      });
      for (const found of chapter.wanted.values()) {
        if (found.handed || !part.html.includes(`data-img="${found.href}"`)) continue;
        found.handed = true;
        const record = {
          href: found.href, blob: found.blob, order: order++, chapterIndex: index,
          animated: found.animated, width: 0, height: 0,
        };
        if (onImage) await onImage(record);
        else images.push(record);
      }
    }
  };

  const sections = book.sections || [];
  for (let s = 0; s < sections.length; s++) {
    onProgress?.(0.25 + 0.7 * (s / sections.length));
    // A breath now and then, so the progress bar is drawn as it moves.
    if (s % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const section = sections[s];
    if (!section?.createDocument) continue;
    let doc;
    try { doc = await section.createDocument(); } catch { continue; }
    const root = doc.body || doc.documentElement;
    if (!root) continue;

    // Pictures given a src the reader can follow.
    for (const img of root.querySelectorAll('img[recindex]')) {
      img.setAttribute('src', `recindex:${img.getAttribute('recindex')}`);
    }

    // Cut at each entry that lands in this section. One whose element cannot
    // be found names the section from its start.
    const here = marksBySection.get(s) || [];
    const marks = [];
    let atStart = null;
    for (const entry of here) {
      let el = null;
      try { el = entry.anchor?.(doc) || null; } catch { el = null; }
      if (el) marks.push({ label: entry.label, el });
      else if (atStart == null) atStart = entry.label;
    }
    const groups = [];
    let current = { label: atStart, nodes: [] };
    for (const node of [...root.childNodes]) {
      const mark = marks.find((m) => m.el === node || (node.contains && node.contains(m.el)));
      if (mark) {
        const hasContent = current.nodes.some((n) => (n.textContent || '').trim() || (n.querySelector && n.querySelector('img, image')));
        if (hasContent) groups.push(current);
        current = hasContent ? { label: mark.label, nodes: [] } : { label: current.label || mark.label, nodes: current.nodes };
      }
      current.nodes.push(node);
    }
    groups.push(current);

    for (const group of groups) {
      const box = doc.createElement('div');
      for (const node of group.nodes) box.appendChild(node);

      // Every picture this part shows, taken out before it is read.
      const wanted = new Map();
      for (const el of box.querySelectorAll('img, image')) {
        const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href')
          || el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || '';
        if (!src || wanted.has(src)) continue;
        const found = await picture(await recordOf(src));
        if (found) wanted.set(src, found);
      }

      const { html, text } = readChapter(box, (src) => wanted.get(src)?.href || null);
      if (!text.trim() && !wanted.size) continue;

      if (group.label || !open || !named) {
        await finish();
        const heading = box.querySelector('h1, h2, h3')?.textContent?.replace(/\s+/g, ' ').trim();
        const line = firstLine(text);
        open = {
          title: group.label || heading || (line && line.length <= 70 ? line : '')
            || (chapters.length ? `Section ${chapters.length + 1}` : title),
          fromToc: !!group.label,
          html: [],
          wanted: new Map(),
        };
      }
      open.html.push(html);
      for (const [src, found] of wanted) open.wanted.set(src, found);
    }
  }
  await finish();
  onProgress?.(1);

  let coverBlob = null;
  try {
    const cover = await book.getCover?.();
    if (cover) {
      const bytes = await source(cover).slice(0, cover.size).arrayBuffer();
      const [type] = typeOf(bytes);
      if (type) coverBlob = new Blob([bytes], { type });
    }
  } catch { /* no cover is no cover */ }

  if (!chapters.length) throw new Error('Nothing readable was found in this Kindle book.');

  return {
    title,
    author: author || null,
    lang,
    // Called what the file is called; which layout was read is kept apart.
    format: /\.azw3$/i.test(file.name) ? 'AZW3' : 'MOBI',
    layout: kf8 ? 'KF8' : 'MOBI',
    chapters,
    images,
    imageCount: order,
    coverBlob,
    tocSource: named ? 'the book\'s own contents' : 'page breaks in the book',
  };
}
