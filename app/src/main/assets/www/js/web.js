/* Books from the web.
 *
 * A serial on a website is a contents page and a few hundred chapter pages.
 * Paste the address of the contents page and every link on it is listed --
 * the chapters, and everything else the site put there besides: menus,
 * sign-in, other novels, the footer. Nothing is guessed away. The reader
 * takes out what is not the book, and the rest is downloaded, one page per
 * chapter, with the site stripped off each, and becomes a book on the shelf.
 *
 * The pages are fetched natively (WebBridge.java): a page cannot read another
 * site's answers, and the shell can. Nothing here touches the network itself.
 */

import * as store from './store.js';
import { readChapter, countWords, guessEncoding } from './parse.js';
import { findStory, titleOf, CHROME_WORDS } from './mht.js';

/* ── the bridge ───────────────────────────────────────────────────────── */

const pending = new Map();
let counter = 0;

/** Called from Java when a fetch has finished. Not a reader API. */
export function settleWeb(id, ok, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(payload || 'That page could not be downloaded'));
}

/** Whether this build can download at all: the app can, a plain browser not. */
export const available = () => typeof window.GrimoireWeb?.fetch === 'function';

/**
 * One address, fetched.
 *
 * @returns {{ url, status, type, blob }} -- url is where it ended up, after
 *   any redirects, which is what its own links are relative to.
 */
export function download(url, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) {
      reject(new Error('Downloading needs the app: this copy of the reader cannot reach the web.'));
      return;
    }
    const id = `w${Date.now().toString(36)}${++counter}`;
    // An answer that never comes would stop a download for good.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('the site took too long to answer'));
    }, timeout);
    pending.set(id, {
      timer,
      reject,
      resolve: async (payload) => {
        try {
          const info = typeof payload === 'string' ? JSON.parse(payload) : payload;
          // Read over the app's own origin, where the shell left it.
          const response = await fetch(info.path);
          if (!response.ok) throw new Error(`the downloaded copy could not be read (${response.status})`);
          const bytes = await response.arrayBuffer();
          const type = String(info.type || '').split(';')[0].trim().toLowerCase();
          resolve({ url: info.url || url, status: info.status, type: info.type || '', blob: new Blob([bytes], { type }) });
        } catch (error) {
          reject(error);
        } finally {
          try { window.GrimoireWeb.release(id); } catch { /* left for the next run to clear */ }
        }
      },
    });
    try {
      window.GrimoireWeb.fetch(id, url);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/* ── reading a page ──────────────────────────────────────────────────── */

async function bytesOf(blob) {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * A page's text, in the encoding it was written in.
 *
 * Said by the server, or by the page itself in a <meta>; failing both, UTF-8
 * if it reads as UTF-8, and otherwise the likeliest of the encodings Chinese,
 * Japanese and Korean sites still use.
 */
export function decodePage(bytes, type = '') {
  const [a, b, c] = bytes;
  if (a === 0xEF && b === 0xBB && c === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  const declared = /charset=["']?([\w-]+)/i.exec(type)?.[1]
    || /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096)))?.[1];
  if (declared) {
    try { return new TextDecoder(declared.toLowerCase()).decode(bytes); } catch { /* not a name it knows */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder(guessEncoding(bytes)).decode(bytes);
  }
}

const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

/** Whether a link sits in the site's furniture: a menu, a header, a footer. */
function inChrome(node) {
  for (let at = node.parentElement; at && at.tagName !== 'BODY'; at = at.parentElement) {
    if (/^(NAV|HEADER|FOOTER|ASIDE|FORM)$/.test(at.tagName)) return true;
    const label = `${typeof at.className === 'string' ? at.className : ''} ${at.id || ''}`;
    if (CHROME_WORDS.test(label)) return true;
  }
  return false;
}

/** What a link points at, when it is a file rather than a page. */
function fileKind(path) {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(path)?.[1] || '').toLowerCase();
  if (/^(jpe?g|png|gif|webp|avif|bmp|svg)$/.test(ext)) return 'picture';
  if (/^(epub|mobi|azw3?|pdf|cbz|cbr|zip|rar|txt|fb2)$/.test(ext)) return 'file';
  if (/^(css|js|json|xml|ico|woff2?|ttf|mp3|mp4|webm)$/.test(ext)) return 'asset';
  return null;
}

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * Every link on a page, in the order the page gives them, once each.
 *
 * Nothing is left out for looking unimportant -- that is the reader's call,
 * and a guess that drops a chapter is worse than a list with a menu in it.
 * Only what cannot be a page is skipped: a jump within this page, a script,
 * an email address.
 */
export function linksOf(html, pageUrl) {
  const doc = parseHtml(html);
  const declared = doc.querySelector('base[href]')?.getAttribute('href');
  let base = pageUrl;
  try { if (declared) base = new URL(declared, pageUrl).href; } catch { /* the page's own */ }
  const self = pageUrl.split('#')[0];

  const seen = new Map();
  const links = [];
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const raw = (anchor.getAttribute('href') || '').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data|sms):/i.test(raw)) continue;
    let url;
    try { url = new URL(raw, base); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const href = url.href;
    if (href === self) continue;
    const text = tidy(anchor.textContent) || tidy(anchor.getAttribute('title'))
      || tidy(anchor.querySelector('img')?.getAttribute('alt'));
    const known = seen.get(href);
    if (known) {
      // The same chapter linked twice -- a thumbnail and its title -- keeps
      // the first place it appeared and the better of the two names.
      if (!known.text && text) known.text = text;
      continue;
    }
    const link = { url: href, text, chrome: inChrome(anchor), kind: fileKind(url.pathname) };
    seen.set(href, link);
    links.push(link);
  }
  return { links, title: pageTitle(doc), author: pageAuthor(doc), cover: pageCover(doc, base) };
}

/** Who wrote it, where the page says so in a way meant to be read by
 *  machines. A guess from the prose would as often be the translator. */
function pageAuthor(doc) {
  const meta = doc.querySelector('meta[name="author"], meta[property="book:author"], meta[name="twitter:creator"]')
    ?.getAttribute('content');
  const marked = doc.querySelector('[itemprop="author"]');
  const named = marked?.querySelector('[itemprop="name"]')?.textContent || marked?.getAttribute('content') || marked?.textContent;
  const author = tidy(named) || tidy(meta);
  return author && author.length <= 80 && !/^@/.test(author) ? author : '';
}

/** The picture the site shows for the book: what it gives a link preview. */
function pageCover(doc, base) {
  const src = doc.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')
    ?.getAttribute('content') || doc.querySelector('link[rel="image_src"]')?.getAttribute('href');
  if (!src) return '';
  try {
    const url = new URL(src.trim(), base);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

/** The name of the book a contents page is for. */
function pageTitle(doc) {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  return tidy(og) || tidy(titleOf(doc, '')) || '';
}

/* ── telling the chapters apart ──────────────────────────────────────── */

const CHAPTER_WORDS = /\b(chapter|chap|ch|episode|ep|part|vol(ume)?|book|prologue|epilogue|interlude|intermission|side ?story|extra|afterword|foreword|preface)\b\.?/i;
const CJK_CHAPTER = /第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章话話回节節卷部篇幕]/;
const LEADING_NUMBER = /^\s*[#№]?\s*\d+(\.\d+)?\s*([:.)\-–—]|$|\s)/;

export const looksLikeChapter = (text) =>
  CHAPTER_WORDS.test(text) || CJK_CHAPTER.test(text) || LEADING_NUMBER.test(text);

/**
 * A link's shape: its site and path with the numbers taken out. Chapters of
 * one book share a shape -- /novel/x/chapter-1, /novel/x/chapter-2 -- and the
 * site's other links mostly do not.
 */
export function shapeOf(href) {
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/+$/, '')
      .split('/')
      .map((part) => (/\d/.test(part) ? '#' : part))
      .join('/');
    const query = [...url.searchParams.keys()].sort().join('&');
    return `${url.host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return href;
  }
}

/** The chapter number a link's name gives, if it gives one. */
export function numberIn(text) {
  const match = /(?:chapter|chap|ch|episode|ep|part|第)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(text)
    || /^\s*[#№]?\s*(\d+(?:\.\d+)?)/.exec(text);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Which links are most likely the chapters.
 *
 * Only ever a suggestion, offered as a button -- the reader decides. The
 * largest family of links sharing a shape, away from the menus, is taken as
 * the chapters, with anything whose name says "chapter" added to it.
 *
 * @returns a Set of the urls
 */
export function likelyChapters(links, pageUrl = '') {
  let host = '';
  try { host = new URL(pageUrl).host; } catch { /* none to prefer */ }
  const families = new Map();
  for (const link of links) {
    if (link.chrome || link.kind) continue;
    const shape = shapeOf(link.url);
    if (!families.has(shape)) families.set(shape, []);
    families.get(shape).push(link);
  }
  let best = null;
  let bestScore = 0;
  for (const [, family] of families) {
    if (family.length < 3) continue;
    const named = family.filter((link) => looksLikeChapter(link.text)).length;
    let score = family.length + named * 2;
    // The site the contents page is on, over somewhere it merely links to.
    if (host && family[0].url.includes(`//${host}/`)) score *= 1.5;
    if (score > bestScore) { bestScore = score; best = family; }
  }
  const likely = new Set((best || []).map((link) => link.url));
  for (const link of links) {
    if (link.chrome || link.kind) continue;
    if (host && !link.url.includes(`//${host}/`)) continue;
    if (looksLikeChapter(link.text) && !/^\s*(next|previous|prev|last|first|latest)\b/i.test(link.text)) {
      likely.add(link.url);
    }
  }
  return likely;
}

/**
 * Whether a list of chapters runs newest first, as many sites' contents
 * pages do. Read off the numbers in their names: mostly falling, it is.
 */
export function newestFirst(links) {
  const numbers = links.map((link) => numberIn(link.text)).filter((n) => n !== null);
  if (numbers.length < 3) return false;
  let falling = 0;
  let rising = 0;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] < numbers[i - 1]) falling += 1;
    else if (numbers[i] > numbers[i - 1]) rising += 1;
  }
  return falling > rising * 2;
}

/** The items that pass a test, in reverse order, in the places they held;
 *  the rest left where they are. */
export function reverseWhere(items, test) {
  const places = [];
  items.forEach((item, at) => { if (test(item)) places.push(at); });
  const turned = places.map((at) => items[at]).reverse();
  const out = items.slice();
  places.forEach((at, n) => { out[at] = turned[n]; });
  return out;
}

/** All the web addresses in what was pasted, in order, once each. */
export function addressesIn(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
  const out = [];
  for (const raw of found) {
    const clean = raw.replace(/[).,;\]]+$/, '');
    if (!out.includes(clean)) out.push(clean);
  }
  // A bare "example.com/novel" is an address too.
  if (!out.length) {
    const bare = String(text || '').trim();
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(bare)) out.push(`https://${bare}`);
  }
  return out;
}

/**
 * The links on each of the pages given, together.
 *
 * Several contents pages -- page 1, page 2 of a long list -- read as one.
 */
export async function findLinks(addresses, { onProgress } = {}) {
  const links = [];
  const seen = new Set();
  const failed = [];
  let title = '';
  let author = '';
  let cover = '';
  for (const [at, address] of addresses.entries()) {
    onProgress?.(at / addresses.length, address);
    try {
      const page = await download(address);
      const html = decodePage(await bytesOf(page.blob), page.type);
      const found = linksOf(html, page.url);
      if (!title) title = found.title;
      if (!author) author = found.author;
      if (!cover) cover = found.cover;
      for (const link of found.links) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        links.push({ ...link, from: at });
      }
    } catch (error) {
      failed.push({ url: address, reason: error.message });
    }
  }
  onProgress?.(1, '');
  return { links, title, author, cover, failed };
}

/* ── a chapter out of a page ─────────────────────────────────────────── */

/* The links a chapter page puts round its own text: to the chapters either
 * side, and back to the contents. In the chapter they would be a line of
 * "Previous Chapter Next Chapter" above and below every one. */
const PAGE_LINKS = /^[\s<«‹←]*(previous|prev|next|back|table of contents|contents|index|toc|chapter list|all chapters|home|上一[章页頁]|下一[章页頁]|目录|目錄|返回)(?![a-z]).{0,24}$/i;

function stripPageLinks(story) {
  for (const anchor of [...story.querySelectorAll('a')]) {
    if (PAGE_LINKS.test(tidy(anchor.textContent))) anchor.remove();
  }
  // Whatever held only those links is empty now.
  for (const block of [...story.querySelectorAll('p, div, span, li, ul, ol, td, tr, table')].reverse()) {
    if (!tidy(block.textContent) && !block.querySelector('img')) block.remove();
  }
}

/** Where a picture really is: sites that load pictures late keep the
 *  address in an attribute of their own until it scrolls into view. */
function pictureSource(img) {
  for (const name of ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-orig-file']) {
    const value = img.getAttribute(name);
    if (value && !value.startsWith('data:')) return value;
  }
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    // The largest offered.
    const best = srcset.split(',').map((part) => part.trim().split(/\s+/))
      .filter(([u]) => u)
      .sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0))[0];
    if (best) return best[0];
  }
  return img.getAttribute('src');
}

const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };

/**
 * One page, read as a chapter.
 *
 * @param link  { url, text }
 * @param index the chapter's place in the book
 * @param getPicture  fetches a picture, or null to leave pictures out
 * @returns { chapter, images, lang }
 */
export async function readPage(link, index, { pictures = true, fetchPage = download } = {}) {
  const page = await fetchPage(link.url);
  const type = String(page.type || '').toLowerCase();

  // A picture linked directly is a page with that picture on it.
  if (type.startsWith('image/')) {
    const href = `web/${index}-0.${EXT_OF_TYPE[type.split(';')[0]] || 'jpg'}`;
    return {
      chapter: { index, title: link.text || `Picture ${index + 1}`, fromToc: true,
        html: `<p><img data-img="${href}"></p>`, words: 0, url: page.url },
      images: [{ href, blob: page.blob, order: index * 1000, chapterIndex: index, animated: /gif/.test(type), width: 0, height: 0 }],
      lang: null,
    };
  }

  const html = decodePage(await bytesOf(page.blob), page.type);
  const doc = parseHtml(html);
  const lang = doc.documentElement.getAttribute('lang') || null;
  const heading = tidy(titleOf(doc, ''));
  const story = findStory(doc);
  stripPageLinks(story);

  // Pictures found as the chapter is read, fetched once it has been.
  const wanted = [];
  const resolveImage = (src) => {
    if (!pictures) return null;
    let absolute;
    try { absolute = new URL(src, page.url).href; } catch { return null; }
    if (!/^https?:/.test(absolute)) return null;
    const href = `web/${index}-${wanted.length}`;
    wanted.push({ href, url: absolute });
    return href;
  };
  for (const img of story.querySelectorAll('img')) {
    const src = pictureSource(img);
    if (src) img.setAttribute('src', src);
  }
  let { html: body, text } = readChapter(story, resolveImage);

  const images = [];
  for (const [n, picture] of wanted.entries()) {
    try {
      const got = await fetchPage(picture.url);
      const kind = String(got.type || '').split(';')[0].toLowerCase();
      if (!kind.startsWith('image/') || !got.blob.size) throw new Error('not a picture');
      images.push({
        // Numbered across the book, so the picture reel runs in reading order.
        href: picture.href, blob: got.blob, order: index * 1000 + n, chapterIndex: index,
        animated: kind === 'image/gif', width: 0, height: 0,
      });
    } catch {
      // A picture that will not come costs its place, not the chapter.
      body = body.split(`<img data-img="${picture.href}">`).join('');
    }
  }

  /* Named by the link it was reached from: that is the name it had in the
   * list, where it was chosen. Without one, by the page's title with the
   * site's name taken off -- a page's first heading is as often the site's
   * name as the chapter's, so it comes after a title that names a chapter. */
  const named = link.text && link.text.length <= 140 ? link.text : '';
  const titled = tidy(doc.querySelector('title')?.textContent)
    .replace(/\s*[|\u2013\u2014\u00b7-]\s*[^|\u2013\u2014\u00b7-]{1,40}$/, '').trim();
  const title = named
    || (looksLikeChapter(titled) ? titled : '')
    || heading || titled || `Page ${index + 1}`;

  if (!tidy(text) && !images.length) {
    body = `<p>Nothing readable came from this page: ${escapeHtml(page.url)}</p>`;
    text = '';
  }
  return {
    chapter: { index, title, fromToc: true, html: body, words: countWords(text, lang), url: page.url },
    images,
    lang,
  };
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── the whole book ──────────────────────────────────────────────────── */

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download the chosen pages into a new book.
 *
 * Written as it goes -- chapters and pictures land in the library as each
 * page arrives -- so a book of a thousand chapters is never held in memory
 * whole, and a download cut short by the app being closed is cleared away
 * like any unfinished import rather than left half-made.
 *
 * Two pages at a time, with a pause between: quick, and not so quick that a
 * site takes it for an attack and starts refusing.
 *
 * @param links     [{ url, text }] in the order the book should have them
 * @param cover     the address of the site's picture of the book, if any
 * @param stop      () => true to stop; what has come so far is kept
 * @param onPage    (link, ok, reason) as each page lands or fails
 * @returns { bookId, done, failed: [{ url, text, reason }], stopped }
 */
export async function downloadBook({
  title, author = '', cover: coverUrl = '', links, folder = '', pictures = true, sources = [],
  onProgress, onPage, stop = () => false, fetchPage = download, gap = 250,
}) {
  if (!links.length) throw new Error('Pick at least one link to download.');
  const bookId = await store.add('books', {
    title: title || 'Downloaded book', author: author || null, folder, importing: true,
    fingerprint: `web:${sources[0] || links[0].url}:${Date.now()}`,
    format: 'WEB', addedAt: Date.now(), lastReadAt: null, finishedAt: null,
    percent: 0, inVault: false, tags: [], words: 0,
  });

  const results = new Array(links.length);
  const failed = [];
  let next = 0;
  let finished = 0;
  let stopped = false;
  let lang = null;
  /* The site's own picture of the book, if it shows one. Not the first
   * picture in the first chapter: that is as likely a map or a divider. */
  let cover = null;
  if (coverUrl) {
    try {
      const got = await fetchPage(coverUrl);
      if (String(got.type || '').toLowerCase().startsWith('image/') && got.blob.size > 2048) cover = got.blob;
    } catch {
      // A book with no cover is still the book.
    }
  }

  const worker = async () => {
    while (next < links.length) {
      if (stop()) { stopped = true; return; }
      const at = next++;
      const link = links[at];
      try {
        let got;
        try {
          got = await readPage(link, at, { pictures, fetchPage });
        } catch (error) {
          // Once more, after a breath: a site that refused one request of a
          // hundred usually takes the next.
          if (stop()) throw error;
          await pause(1500);
          got = await readPage(link, at, { pictures, fetchPage });
        }
        if (!lang && got.lang) lang = got.lang;
        if (got.images.length) {
          await store.putAll('images', got.images.map((image) => ({ bookId, ...image })));
        }
        await store.put('chapters', { bookId, ...got.chapter });
        results[at] = { words: got.chapter.words, pictures: got.images.length };
        onPage?.(link, true);
      } catch (error) {
        const reason = error.message || 'could not be read';
        failed.push({ at, url: link.url, text: link.text, reason });
        onPage?.(link, false, reason);
      }
      finished += 1;
      onProgress?.(finished / links.length, finished, links.length, link);
      if (gap) await pause(gap);
    }
  };
  await Promise.all([worker(), worker()]);

  const kept = results.map((result, at) => (result ? at : -1)).filter((at) => at >= 0);
  if (!kept.length) {
    await store.deleteBook(bookId).catch(() => {});
    const why = failed[0]?.reason;
    throw new Error(stopped ? 'Stopped before any page had come.'
      : `None of those pages could be downloaded${why ? ` — ${why}` : ''}.`);
  }

  /* Numbered without gaps. A page that failed, or one not reached before a
   * stop, leaves a hole in the numbering, and the reader steps through a
   * book by its chapter numbers. */
  if (kept.length !== links.length) await closeGaps(bookId, kept);

  const words = kept.reduce((n, at) => n + (results[at].words || 0), 0);
  const imageCount = kept.reduce((n, at) => n + (results[at].pictures || 0), 0);
  const book = await store.get('books', bookId);
  Object.assign(book, {
    words, lang, chapterCount: kept.length, chapters: kept.length, imageCount,
    coverBlob: cover, coverBytes: cover?.size ?? null,
    // Where it came from, so the book can say -- and, one day, look for
    // chapters added since.
    webSource: { pages: sources, links: links.map((link) => link.url) },
  });
  delete book.importing;
  await store.put('books', book);
  failed.sort((a, b) => a.at - b.at);
  return { bookId, done: kept.length, failed, stopped };
}

async function closeGaps(bookId, kept) {
  const place = new Map(kept.map((old, now) => [old, now]));
  const chapters = await store.byIndex('chapters', 'bookId', bookId);
  for (const chapter of chapters) await store.del('chapters', [bookId, chapter.index]);
  await store.putAll('chapters', chapters
    .filter((chapter) => place.has(chapter.index))
    .map((chapter) => ({ ...chapter, index: place.get(chapter.index) })));
  const images = await store.byIndex('images', 'bookId', bookId);
  const moved = images.filter((image) => place.has(image.chapterIndex)
    && place.get(image.chapterIndex) !== image.chapterIndex);
  if (moved.length) {
    await store.putAll('images', moved.map((image) => ({ ...image, chapterIndex: place.get(image.chapterIndex) })));
  }
}

/**
 * Pages read into chapters for Build, as a part like any file.
 *
 * Shaped as a parsed file is, so the workshop treats a website the way it
 * treats a volume: joined, in order, with whatever else is in the list.
 * Pages are fetched two at a time but handed on strictly in order, each one
 * as soon as every page before it has come or failed -- so a page that fails
 * leaves no hole in the numbering, and nothing is held for longer than it
 * takes the pages ahead of it to arrive.
 *
 * @param onImage  called with each picture, numbered to its final chapter
 * @returns { title, author, chapters, images: [], imageCount, coverBlob,
 *   words, format, failed: [{ url, text, reason }] }
 */
export async function readPages(links, {
  title = '', author = '', cover = null, pictures = true, onImage, onProgress,
  fetchPage = download, gap = 250, patience = { retry: 1000, refresh: [400, 1200, 3000] },
} = {}) {
  const chapters = [];
  const waiting = new Array(links.length);
  let handed = 0;        // the next page to hand on
  let next = 0;
  let settled = 0;
  let imageCount = 0;
  let words = 0;
  let lang = null;

  /* Stopped at the first page that will not come.
   *
   * What is built is then the chapters up to it, whole and in order, and
   * the page that failed is where the rest begins -- kept to download as a
   * book of its own, which continues this one exactly. Nothing has to be
   * taken out of the middle before the two can sit side by side, or be
   * built together later. */
  let stopAt = links.length;
  let stopped = null;    // { at, url, text, reason } of the page it stopped at

  const handOn = async () => {
    while (handed < stopAt && waiting[handed] !== undefined) {
      const got = waiting[handed];
      waiting[handed] = null;
      handed += 1;
      if (!got) continue;
      const index = chapters.length;
      for (const image of got.images) {
        imageCount += 1;
        await onImage?.({ ...image, chapterIndex: index });
      }
      if (!lang && got.lang) lang = got.lang;
      words += got.chapter.words || 0;
      chapters.push({ ...got.chapter, index });
    }
  };

  /* The rate is the reader's: `gap` milliseconds between one page being
   * asked for and the next, across both of the requests that run at once.
   * Nought is as fast as the two will go. */
  let nextAt = 0;
  const myTurn = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + Math.max(0, gap || 0);
    if (wait) await pause(wait);
  };

  /* Asked again, at once, as a refresh would.
   *
   * A smaller site that says "too many requests" mostly means that one
   * request: asked again a moment later it answers, with no need to wait
   * minutes. So a refused page is fetched afresh a few times in quick
   * succession before it counts as failed. Anything else (a page that is
   * not there) gets one more try. */
  const fetchAgain = async (link, at) => {
    let lastError = null;
    const waits = [patience.retry];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      if (at > stopAt) throw new Error('stopped');
      try {
        if (attempt === 0) await myTurn();
        return await readPage(link, at, { pictures, fetchPage });
      } catch (error) {
        lastError = error;
        if (attempt === 0 && tooMany(error)) waits.splice(0, waits.length, ...patience.refresh);
        if (attempt < waits.length) await pause(waits[attempt]);
      }
    }
    throw lastError;
  };

  const worker = async () => {
    while (next < stopAt) {
      const at = next++;
      const link = links[at];
      let got = false;
      try {
        got = await fetchAgain(link, at);
      } catch (error) {
        // The earliest page to fail is where it stops; a later one that
        // fails meanwhile is part of the rest anyway.
        if (at < stopAt) {
          stopAt = at;
          stopped = { at, url: link.url, text: link.text, reason: error.message || 'could not be read' };
        }
        got = false;
      }
      // Past the stop, a page that came is left for the rest, not kept.
      waiting[at] = at < stopAt ? got : null;
      settled += 1;
      onProgress?.(Math.min(1, settled / links.length), Math.min(settled, links.length), links.length);
      await handOn();
    }
  };
  await Promise.all([worker(), worker()]);
  await handOn();

  const failed = stopped ? [stopped] : [];
  const rest = stopped
    ? links.slice(stopAt).map(({ url, text }, n) => ({ url, text, ...(n === 0 ? { reason: stopped.reason } : {}) }))
    : [];
  if (!chapters.length) {
    const why = stopped?.reason;
    // With the pages, so they can be tried again as they are.
    throw Object.assign(new Error(`none of its pages could be downloaded${why ? ` — ${why}` : ''}`), { failed, rest });
  }
  return {
    title, author: author || null, lang, format: 'WEB',
    chapters, images: [], imageCount, words, coverBlob: cover, failed, rest,
  };
}

/** A site asking to be asked less often. */
export const tooMany = (error) => /\b429\b|too many requests/i.test(String(error?.message || error || ''));

/** The site's picture of the book, fetched, or null. */
export async function fetchCover(url, { fetchPage = download } = {}) {
  if (!url) return null;
  try {
    // Briefly: adding pages to Build should not sit waiting on a picture.
    const got = await fetchPage(url, { timeout: 15000 });
    return String(got.type || '').toLowerCase().startsWith('image/') && got.blob.size > 2048 ? got.blob : null;
  } catch {
    return null;
  }
}
