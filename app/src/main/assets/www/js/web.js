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
  clearInterval(entry.timer);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(payload || 'That page could not be downloaded'));
}

/* ── time off screen ──────────────────────────────────────────────────
 *
 * A long download outlives the screen staying on. When the app goes to the
 * background, or the phone sleeps, Android pauses it -- and when it comes
 * back, every timer that was running fires at once, as though the site had
 * kept it waiting all that while. That is what cut downloads short at a page
 * that then came perfectly well when asked for again. So time off screen is
 * not counted against a site, and a page that failed while the app was away
 * is asked for again once it is back, without counting as a try.
 */
let interruptions = 0;
if (typeof document !== 'undefined') {
  const away = () => { interruptions += 1; };
  document.addEventListener('visibilitychange', () => { if (offScreen()) away(); });
  document.addEventListener('freeze', away);
}
/* Asked as "hidden", not by document.hidden: a page still being set up --
 * and a test's pretend document -- reports itself as not yet visible, which
 * is not the same as having been put away. */
function offScreen() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Resolves once the app is on screen again (at once if it is). */
export function whenOnScreen() {
  if (!offScreen()) return Promise.resolve();
  return new Promise((resolve) => {
    const back = () => {
      if (offScreen()) return;
      document.removeEventListener('visibilitychange', back);
      resolve();
    };
    document.addEventListener('visibilitychange', back);
  });
}

/** Whether this build can download at all: the app can, a plain browser not. */
export const available = () => typeof window.GrimoireWeb?.fetch === 'function';

/**
 * One address, fetched.
 *
 * @returns {{ url, status, type, blob }} -- url is where it ended up, after
 *   any redirects, which is what its own links are relative to.
 */
export async function download(url, options = {}) {
  /* A picture (or any file) is fetched as it is, always: the renderer is
   * for pages, and would wait out a page's settling for every picture and
   * hand it back wrapped in one. */
  if (!canRender() || options.picture || FILE_ADDRESS.test(url)) return fetchNative('fetch', url, options);
  let host = '';
  try { host = new URL(url).host; } catch { /* the fetch says what is wrong with it */ }
  /* A site already found to build its pages in script is rendered from the
   * start: asking it twice for every chapter would be twice the load. */
  if (host && renderedHosts.has(host)) return fetchNative('render', url, options);
  let page;
  try {
    page = await fetchNative('fetch', url, options);
  } catch (error) {
    // A bot check lets a browser through, and the renderer is one.
    if (!BOT_CHECK.test(error.message)) throw error;
    if (host) renderedHosts.add(host);
    return fetchNative('render', url, options);
  }
  if (!looksLikeHtml(page)) return page;
  const html = decodePage(await bytesOf(page.blob), page.type);
  if (!scriptBuilt(html)) return page;
  try {
    const rendered = await fetchNative('render', page.url || url, options);
    if (host) renderedHosts.add(host);
    return rendered;
  } catch {
    return page; // what the site sent is still better than nothing
  }
}

/* ── pages built by script ────────────────────────────────────────────
 *
 * Some sites send an empty frame and build the page in the browser: the
 * contents page arrives as a title and a script, without one link, and a
 * chapter without a line of the story. What the reader sees on such a site
 * is only there once its script has run. So a page like that is asked for
 * again from the renderer (WebBridge.render): an unseen browser in the app
 * that opens the page as the phone's browser would, waits for it to settle,
 * and hands back the page as it then stands.
 */
const renderedHosts = new Set();
/* An address that names a file, not a page. */
const FILE_ADDRESS = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico|css|js|mjs|json|xml|woff2?|ttf|otf|mp[34]|webm|zip|pdf|epub)(?:[?#]|$)/i;
/** Fewer characters than this, and no picture, is a chapter not yet loaded. */
const MIN_RENDERED_STORY = 200;
const BOT_CHECK = /bot check|only lets a browser/i;

/* How patiently the renderer waits on a page: more each time the same page
 * came back without its story, up to the most it allows (3). */
const patience = new Map();
const patienceFor = (url) => patience.get(url) || 0;

/** A rendered page whose story had not arrived: ask more patiently next time.
 *  What the page did hold goes into the message -- a sign-in, an age check,
 *  a "loading…" -- since that is what says why. */
export function notLoadedYet(url, held = '') {
  patience.set(url, Math.min(3, patienceFor(url) + 1));
  const text = tidy(held);
  const sample = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return Object.assign(new Error(`the chapter had not finished loading on the site (the page held ${text.length} characters${sample ? `: "${sample}"` : ''})`),
    { notLoaded: true });
}

/** Whether this address's site is one rendered page by page. */
function renderedHere(url) {
  try { return renderedHosts.has(new URL(url).host); } catch { return false; }
}

/* ── the site, shown ─────────────────────────────────────────────────── */

/** Whether this build can show a site, to pass its check by hand. */
export const canOpenSite = () => typeof window.GrimoireWeb?.showSite === 'function';

/** An error that is a site's browser check, which showing the site can pass. */
export const wantsCheck = (error) => /bot check|browser check|only lets a browser/i
  .test(String(error?.message || error || ''));

/**
 * The site shown over the app, in a browser like the unseen one and with
 * its cookies, until Done (or back): a check passed there -- by itself, or
 * by a tap -- lets the unseen browser in after. Resolves when it is closed.
 */
export function openSite(url) {
  return new Promise((resolve, reject) => {
    if (!canOpenSite()) {
      reject(new Error('This copy of the app cannot show a site.'));
      return;
    }
    const id = `s${Date.now().toString(36)}${++counter}`;
    pending.set(id, {
      timer: null,
      reject,
      resolve: (payload) => {
        try { resolve(JSON.parse(payload || '{}')); } catch { resolve({}); }
      },
    });
    try {
      window.GrimoireWeb.showSite(id, url);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

/** Whether this build of the app has the renderer. */
export const canRender = () => typeof window.GrimoireWeb?.render === 'function';

function looksLikeHtml(page) {
  const type = String(page.type || '').toLowerCase();
  return !type || type.includes('html') || type.includes('xml');
}

/* The frame a script fills: the roots the common page builders draw into. */
const APP_ROOTS = '#__next, #__nuxt, #app, #root, #svelte, #___gatsby, app-root, [data-reactroot], [data-server-rendered]';

/**
 * Whether a page as sent is only a frame that its script fills: scripts, and
 * next to nothing to read or follow. Nothing a reader would read is this
 * empty -- a chapter is thousands of characters, a contents page dozens of
 * links -- so asking the renderer for such a page loses nothing.
 */
export function scriptBuilt(html) {
  if (!/<script\b/i.test(html)) return false;
  const doc = parseHtml(html);
  for (const node of doc.querySelectorAll('script, style, noscript, template')) node.remove();
  const body = doc.body;
  if (!body) return true;
  const root = body.querySelector(APP_ROOTS);
  if (root && tidy(root.textContent).length < 40 && root.querySelectorAll('a[href]').length < 3) return true;
  return tidy(body.textContent).length < 400 && body.querySelectorAll('a[href]').length < 8;
}

function fetchNative(method, url, { timeout = 90000, list = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) {
      reject(new Error('Downloading needs the app: this copy of the reader cannot reach the web.'));
      return;
    }
    const id = `w${Date.now().toString(36)}${++counter}`;
    /* An answer that never comes would stop a download for good -- but only
     * time the app is on screen and running counts towards giving up. A
     * jump of more than a few seconds between ticks is the app having been
     * paused, not the site being slow. */
    let waited = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const step = now - last;
      last = now;
      if (offScreen() || step > 5000) return;
      waited += step;
      if (waited < timeout) return;
      clearInterval(timer);
      pending.delete(id);
      reject(new Error('the site took too long to answer'));
    }, Math.min(1000, Math.max(10, timeout / 4)));
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
          resolve({ url: info.url || url, status: info.status, type: info.type || '', blob: new Blob([bytes], { type }),
            rendered: !!info.rendered });
        } catch (error) {
          reject(error);
        } finally {
          try { window.GrimoireWeb.release(id); } catch { /* left for the next run to clear */ }
        }
      },
    });
    try {
      // A contents page may be scrolled for more of its list; a chapter
      // never is (some readers add the next chapter under it at the end).
      if (method === 'render') window.GrimoireWeb.render(id, url, String(patienceFor(url)), list ? '1' : '0');
      else window.GrimoireWeb.fetch(id, url);
    } catch (error) {
      pending.delete(id);
      clearInterval(timer);
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

/* ── WordPress ────────────────────────────────────────────────────────
 *
 * A great many translated serials live on WordPress sites, and WordPress is
 * regular enough to be read properly rather than guessed at. Its posts keep
 * the writing in one known place (.entry-content), its clutter has known
 * names -- the share buttons, "Like this:", related posts, the ads, the
 * links to the chapters either side -- and its lists of posts run newest
 * first, a page at a time, with a link to the older ones. So a WordPress
 * contents page or category is followed through all of its pages, turned
 * into reading order, and each chapter is read from its post alone.
 */

/** Whether a page was made by WordPress, by any of the marks it leaves. */
export function isWordPress(doc, html = '') {
  const generator = doc.querySelector('meta[name="generator"]')?.getAttribute('content') || '';
  return /wordpress/i.test(generator)
    || !!doc.querySelector('link[rel="https://api.w.org/"], link[href*="/wp-json/"], link[href*="/wp-content/"], script[src*="/wp-includes/"], script[src*="/wp-content/"]')
    || /\/wp-content\/|\/wp-includes\/|wp-json/.test(html.slice(0, 200000));
}

/* Where a WordPress post keeps its writing, across the themes in use: the
 * classic themes, the block themes, and the page builders' own names. */
const WP_STORY = [
  '.entry-content', '.wp-block-post-content', '.post-content', '.single-content',
  '.post-entry', '.entry-body', '.td-post-content', '.elementor-widget-theme-post-content',
  '.chapter-content', '#chapter-content', '.text_story', '.reading-content',
].join(', ');

/* What WordPress and its usual plugins put in and around a post that is not
 * the post: sharing, likes, related posts, subscription boxes, ads, the
 * links to the posts either side, the comments. */
export const WP_CLUTTER = [
  '.sharedaddy', '.sd-sharing-enabled', '.sd-like', '#jp-post-flair', '.jp-relatedposts', '#jp-relatedposts',
  '.wpcnt', '.wordads-ad-wrapper', '.wordads-tag', '.wpa', '.wpadcenter-ad-container', '.code-block',
  '.adsbygoogle', 'ins.adsbygoogle', '[id^="div-gpt-ad"]', '.ezoic-ad', '[class*="ezoic"]', '.mv-ad-box',
  '.post-navigation', '.nav-links', '.navigation', '.wp-block-post-navigation-link', '.single-navigation',
  '.entry-meta', '.entry-footer', '.post-meta', '.byline', '.cat-links', '.tags-links', '.edit-link',
  '.author-box', '.author-bio', '.wp-block-jetpack-subscriptions', '.jetpack_subscription_widget',
  '.wp-block-buttons', '.comments-area', '#comments', '.comment-respond', '#respond',
  '.wpdiscuz_top_clearing', '#wpdcom', '.yarpp-related', '.crp_related', '.addtoany_share_save_container',
  '.a2a_kit', '.heateor_sss_sharing_container', '.wp-block-jetpack-like', '.patreon-button',
  '.saboxplugin-wrap', '.nv-author-biography', '.nv-post-navigation', '[class*="patreon"]', '.ko-fi-button',
  'script', 'style', 'noscript', 'iframe', 'form',
].join(', ');

/** A WordPress page that lists posts -- a category, a tag, the blog -- as
 *  opposed to a single post or page. */
function isWordPressList(doc, pageUrl = '') {
  const classes = doc.body?.className || '';
  if (/\b(single|single-post|page-template)\b/.test(classes) && !/\b(archive|blog|category|tag|search)\b/.test(classes)) return false;
  return /\b(archive|category|tag|blog|search|paged)\b/.test(classes)
    || /\/(category|tag|series|author)\//.test(pageUrl)
    || doc.querySelectorAll('.entry-title a, .wp-block-post-title a, .post-title a').length >= 3;
}

/** The page of older posts after this one, if WordPress offers one. */
function olderPostsOf(doc, pageUrl) {
  const found = doc.querySelector(
    'link[rel="next"], a.next.page-numbers, .nav-previous a, .pagination a.next, a.next, '
    + '.wp-block-query-pagination-next, a[rel="next"], .older-posts a, .nav-links .next');
  const href = found?.getAttribute('href');
  if (!href) return null;
  try {
    const url = new URL(href, pageUrl);
    url.hash = '';
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** The writing of a WordPress post, with the post's clutter taken out. */
function wordPressStory(doc) {
  for (const node of doc.querySelectorAll(WP_CLUTTER)) node.remove();
  const candidates = [...doc.querySelectorAll(WP_STORY)];
  // The longest, not the first: a theme may put an excerpt or a sidebar
  // post in the same kind of box before the post itself.
  let best = null;
  let length = 0;
  for (const candidate of candidates) {
    const size = (candidate.textContent || '').trim().length + candidate.querySelectorAll('img').length * 200;
    if (size > length) { best = candidate; length = size; }
  }
  return length > 0 ? best : null;
}

/* Words that mark a link as the site's own furniture on a WordPress page --
 * the share buttons and the like, whose class names are their own. */
const WP_CHROME = /sharedaddy|sd-sharing|sd-like|jp-relatedposts|jp-post-flair|wpcnt|wordads|post-navigation|nav-links|comment|respond|widget|wp-block-navigation|menu-item|site-header|site-footer|entry-meta|entry-footer|cat-links|tags-links|author-box|subscri|addtoany|a2a_|heateor/i;

/** Whether a link sits in the site's furniture: a menu, a header, a footer. */
function inChrome(node) {
  for (let at = node.parentElement; at && at.tagName !== 'BODY'; at = at.parentElement) {
    if (/^(NAV|HEADER|FOOTER|ASIDE|FORM)$/.test(at.tagName)) return true;
    const label = `${typeof at.className === 'string' ? at.className : ''} ${at.id || ''}`;
    if (CHROME_WORDS.test(label) || WP_CHROME.test(label)) return true;
  }
  return false;
}

/* What a link to a post says when it is not the post's name: the "read
 * more" under an excerpt, the comment count beside it. The post's title,
 * found elsewhere in the list, is the better name. */
const WEAK_TEXT = /^(continue reading|read more|read the rest|more|leave a comment|\d+\s+comments?|comments?|reply|permalink|→|»)\b/i;

/** What a link points at, when it is a file rather than a page. */
function fileKind(path) {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(path)?.[1] || '').toLowerCase();
  if (/^(jpe?g|png|gif|webp|avif|bmp|svg)$/.test(ext)) return 'picture';
  if (/^(epub|mobi|azw3?|pdf|cbz|cbr|zip|rar|txt|fb2)$/.test(ext)) return 'file';
  if (/^(css|js|json|xml|ico|woff2?|ttf|mp3|mp4|webm)$/.test(ext)) return 'asset';
  return null;
}

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/* A row of decoration in a name: "=====", "-----", "~~~~". */
const DECORATION = /([=~\-_*#·•─━])\1{3,}/g;
/* A piece of a link with no word in it: a counter on a thumbnail, a date,
 * "👁 0" views. */
const FIGURES = /^(?=.*[\d\p{Extended_Pictographic}])[^\p{L}]+$/u;

/**
 * What a link says, read as a person reads it.
 *
 * A list row is often one link holding several things -- a thumbnail with a
 * counter on it, the title, the date, the views -- each in its own element
 * and nothing between them, so its text runs them together: a counter of
 * 656 beside "14화" read "65614화". Here text from different elements is kept
 * apart, decoration is dropped, and where the name gives its chapter in so
 * many words ("14화", "Chapter 14", "第十四章"), the bare figures around it
 * -- counter, date, views -- are left out.
 */
function linkName(anchor) {
  const pieces = [];
  const walker = anchor.ownerDocument.createTreeWalker(anchor, 0x4);   // text
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('script, style')) continue;
    pieces.push({ text: String(node.nodeValue || '').replace(DECORATION, ' '), from: node.parentElement });
  }
  const named = pieces.some((piece) => markedNumber(tidy(piece.text)) !== null);
  let out = '';
  let last = null;
  for (const piece of pieces) {
    const words = tidy(piece.text);
    if (named && FIGURES.test(words)) continue;
    if (!words) { out += ' '; continue; }
    if (last && piece.from !== last && /[\p{L}\p{N}]$/u.test(out) && /^[\p{L}\p{N}]/u.test(piece.text)) out += ' ';
    out += piece.text;
    last = piece.from;
  }
  // The row's "›" at the end is where it leads, not what it is called.
  const name = tidy(out);
  return name.replace(/\s*[›»→]+$/, '') || name;
}

/** A name that starts with its chapter, as a row of a contents list does:
 *  "14화 북쪽 숲 정벌", "Chapter 3: …", "第三章". */
function rowName(text) {
  return /^\s*(?:(?:제\s*)?\d+(?:\.\d+)?\s*(?:화|회|장)(?![가-힣])|(?:chapters?|chaps?|ch\.?|episodes?|ep\.?)\s*\d|第\s*\S{1,8}?[章话話回])/i.test(String(text || ''));
}

/** A chapter number a name gives in so many words, not just a figure. */
function markedNumber(text) {
  const cjk = new RegExp(`第\\s*(${NUMERAL})\\s*[章话話回节節]`).exec(text);
  if (cjk) return cjkNumber(cjk[1]);
  const korean = KOREAN_EPISODE.exec(text);
  if (korean) return parseFloat(korean[1]);
  const marked = /(?:chapters?|chaps?|ch|episodes?|eps?)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(text);
  return marked ? parseFloat(marked[1]) : null;
}

/* Korean: "14화", "제14화", "3회", "2장" -- not the start of a longer word. */
const KOREAN_EPISODE = /(?:제\s*)?(\d+(?:\.\d+)?)\s*(?:화|회|장)(?![가-힣])/;

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
  const contexts = contextOf(doc);
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const raw = (anchor.getAttribute('href') || '').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data|sms):/i.test(raw)) continue;
    let url;
    try { url = new URL(raw, base); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const href = url.href;
    if (href === self) continue;
    const own = linkName(anchor) || tidy(anchor.getAttribute('title'))
      || tidy(anchor.querySelector('img')?.getAttribute('alt'));
    const text = labelled(own, contexts.get(anchor));
    // A post's title in a list of posts: a chapter, whatever it is called.
    const post = !!anchor.closest('.entry-title, .wp-block-post-title, .post-title, h2.title');
    const known = seen.get(href);
    if (known) {
      // The same chapter linked twice -- a thumbnail and its title, a title
      // and its "read more" -- keeps the first place it appeared and the
      // better of the names.
      if (text && (!known.text || (WEAK_TEXT.test(known.text) && !WEAK_TEXT.test(text)))) known.text = text;
      else if (rowName(text) && !rowName(known.text)) {
        /* A button above the list that leads to a chapter -- "최신화 보기
         * 669화", "첫화부터 정주행", "Read the first chapter" -- and then the
         * chapter's own row: the row's name is the chapter's, and the row's
         * place in the list is where it stands. */
        known.text = text;
        known.chrome = !post && inChrome(anchor);
        links.splice(links.indexOf(known), 1);
        links.push(known);
      }
      if (post) { known.post = true; known.chrome = false; }
      continue;
    }
    const link = { url: href, text, chrome: !post && inChrome(anchor), kind: fileKind(url.pathname), post };
    seen.set(href, link);
    links.push(link);
  }
  const wordpress = isWordPress(doc, html);
  const list = wordpress && isWordPressList(doc, pageUrl);
  // A list that goes on over numbered pages: those pages, not chapters.
  const paging = list ? null : pagesOf(links, pageUrl);
  return {
    links: paging ? links.filter((link) => !paging.links.has(link.url)) : links,
    title: pageTitle(doc), author: pageAuthor(doc), cover: pageCover(doc, base),
    wordpress, list, older: list ? olderPostsOf(doc, pageUrl) : null,
    pages: paging ? paging.pages : [],
  };
}

/* ── a contents page over several pages ───────────────────────────────
 *
 * A long serial's contents are often split -- thirty chapters a page, a row
 * of numbered links under them: "1 2 3 4 5 … › »", the last of them to page
 * 23. Only the first page's chapters would be listed. So the page's own
 * links to itself with another page number are found, the highest number
 * among them is taken as the last page, and every page from the first to
 * that is read: the row shows five of twenty-three, the last link says how
 * many there are.
 *
 * Each is asked for as the address given, with only the page number
 * changed -- the order and anything else it was given stay as they were, so
 * every page lists the chapters the same way round as the first.
 */
const PAGE_KEYS = ['page', 'p', 'pg', 'paged', 'pageno', 'page_no', 'pagenum', 'pn', 'cpage', 'currentpage', 'pageindex'];
const MAX_LIST_PAGES = 200;

/**
 * The other pages of a contents page split over several: { pages, links } --
 * the addresses to read, first to last without this one, and the links on
 * this page that only lead to them. Null when it has no such pages.
 */
export function pagesOf(links, pageUrl) {
  let here;
  try { here = new URL(pageUrl); } catch { return null; }
  const keyOf = (url) => [...url.searchParams.keys()].find((key) => PAGE_KEYS.includes(key.toLowerCase()));
  const found = new Map();   // key -> { highest, links }
  for (const link of links) {
    let url;
    try { url = new URL(link.url); } catch { continue; }
    if (url.origin !== here.origin || url.pathname.replace(/\/+$/, '') !== here.pathname.replace(/\/+$/, '')) continue;
    const key = keyOf(url);
    if (!key) continue;
    const number = Number(url.searchParams.get(key));
    if (!Number.isInteger(number) || number < 1) continue;
    const entry = found.get(key) || { highest: 0, links: new Set() };
    entry.highest = Math.max(entry.highest, number);
    entry.links.add(link.url);
    found.set(key, entry);
  }
  // The key most of the row uses.
  const [key, entry] = [...found].sort((a, b) => b[1].links.size - a[1].links.size)[0] || [];
  if (!key) return null;
  const current = Number(here.searchParams.get(key)) || 1;
  const last = Math.min(entry.highest, MAX_LIST_PAGES);
  const pages = [];
  for (let number = 1; number <= last; number += 1) {
    if (number === current) continue;
    const url = new URL(here.href);
    url.searchParams.set(key, String(number));
    url.hash = '';
    pages.push(url.href);
  }
  return pages.length ? { pages, links: entry.links } : null;
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
  const archive = doc.querySelector('.archive-title, .page-title, .wp-block-query-title')?.textContent;
  // "Category: The Lantern" is the book's name with WordPress's label on it.
  const named = tidy(og) || tidy(archive) || tidy(titleOf(doc, '')) || '';
  return named.replace(/^(category|tag|series|archives?)\s*:\s*/i, '').replace(/\s+archives?$/i, '');
}

/* ── telling the chapters apart ──────────────────────────────────────── */

const CHAPTER_WORDS = /\b(chapters?|chaps?|ch|episodes?|eps?|parts?|vols?|volumes?|book|prologue|epilogue|interlude|intermission|side[ -]?stor(y|ies)|extras?|afterword|foreword|preface|special)\b\.?/i;
const CJK_CHAPTER = /第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章话話回节節卷部篇幕]/;
const LEADING_NUMBER = /^\s*[#№]?\s*\d+(\.\d+)?\s*([:.)\-–—]|$|\s)/;

/* The other parts of a Chinese, Japanese or Korean serial: side stories,
 * extras, the prologue, the ending and the afterword. */
const CJK_PARTS = /番外|外[傳传]|特別篇|特别篇|特典|序章|楔子|引子|尾[聲声]|終章|终章|後記|后记|完結感言|完结感言|외전|에필로그|프롤로그|番外編|閑話|閒話|幕間/;

export const looksLikeChapter = (text) =>
  CHAPTER_WORDS.test(text) || CJK_CHAPTER.test(text) || CJK_PARTS.test(text) || LEADING_NUMBER.test(text);

/* ── numbers in any script ───────────────────────────────────────────── */

const CJK_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CJK_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 萬: 10000 };

/** "十二" is 12, "一百零五" is 105, "１２" is 12, "12" is 12. */
export function cjkNumber(text) {
  const plain = String(text || '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
  if (/^\d+(\.\d+)?$/.test(plain)) return parseFloat(plain);
  if (!/^[零〇一二两兩三四五六七八九十百千万萬]+$/.test(plain)) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of plain) {
    if (ch in CJK_DIGITS) { digit = CJK_DIGITS[ch]; continue; }
    const unit = CJK_UNITS[ch];
    if (unit === 10000) { total += (section + digit) * unit; section = 0; digit = 0; continue; }
    // "十二" starts with the unit: one ten.
    section += (digit || 1) * unit;
    digit = 0;
  }
  return total + section + digit;
}

const NUMERAL = '[0-9０-９]+(?:\\.[0-9]+)?|[零〇一二两兩三四五六七八九十百千万萬]+';

/* What kind of chapter a name is, and its number among its kind.
 *   prologue  the prologue, 序章, 楔子
 *   main      "Chapter 12", "第十二章", "12."
 *   side      side stories and extras: "番外三", "Side Story 2", "Extra 1"
 *   after     the ending's afterword, 後記, 完結感言
 */
export function chapterKind(text) {
  const name = String(text || '');
  if (/後記|后记|完結感言|完结感言|作者的話|作者的话|\bafterword\b|\bauthor'?s? note\b/i.test(name)) return { kind: 'after', number: null };
  const side = new RegExp(`(?:番外(?:篇|編)?|外[傳传]|特別篇|特别篇|特典|閑話|閒話|외전|\\bside[ -]?stor(?:y|ies)\\b|\\bextras?\\b|\\bspecial\\b|\\bbonus\\b|\\bSS\\b)\\s*[:：.·・\\-–—]?\\s*(?:第\\s*)?(${NUMERAL})?`, 'i').exec(name);
  if (side) {
    // A side story in a chapter's place ("Chapter 64: Side-story") is
    // that chapter's, and reads where it stands.
    const own = mainNumber(name.slice(0, side.index));
    if (own !== null) return { kind: 'main', number: own };
    return { kind: 'side', number: side[1] ? cjkNumber(side[1]) : null };
  }
  if (/序章|楔子|引子|프롤로그|\bprologue\b/i.test(name) && mainNumber(name) === null) return { kind: 'prologue', number: 0 };
  const number = mainNumber(name);
  return number === null ? { kind: null, number: null } : { kind: 'main', number };
}

function mainNumber(name) {
  const cjk = new RegExp(`第\\s*(${NUMERAL})\\s*[章话話回节節]`).exec(name);
  if (cjk) return cjkNumber(cjk[1]);
  return numberIn(name);
}

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

/** The chapter a name gives by itself -- "Chapter 16", "Ep. 4", "12." --
 *  as opposed to a part of one ("part 2"), which means nothing without the
 *  chapter it is a part of. */
function ownNumber(text) {
  const korean = KOREAN_EPISODE.exec(text || '');
  if (korean) return parseFloat(korean[1]);
  const match = /(?:chapters?|chaps?|ch|episodes?|eps?|第)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(text)
    || /^\s*[#№]?\s*(\d+(?:\.\d+)?)\s*([:.)\-–—]|$|\s)/.exec(text);
  return match ? parseFloat(match[1]) : null;
}

/* A line that names what the links after it belong to: "Chapter 16:",
 * "Side-story 1:", "第十六章". Short, and a heading in all but markup. */
const CONTEXT_LINE = /^(chapters?|chaps?|ch\.?|episodes?|ep\.?|side[ -]?stor(y|ies)|extras?|special|vol(ume)?\.?|book|part|arc)\b.{0,40}$|^第.{1,12}[章话話回卷部]|:\s*$/i;

/**
 * What each link is called, with the line it sits under where its own name
 * means nothing alone.
 *
 * A contents page that splits chapters into parts lists them as "Chapter 16:
 * part 1 · part 2", and a book of a hundred and twenty chapters is then two
 * hundred and forty links called "part 1" and "part 2" -- in the list, as
 * chapter titles, and to anything trying to put them in order, where every
 * "part 1" sorted ahead of every "part 2". Named "Chapter 16: part 1", each
 * says which it is.
 */
function contextOf(doc) {
  const contexts = new Map();
  const body = doc.body;
  if (!body) return contexts;
  const walker = doc.createTreeWalker(body, 0x1 | 0x4);   // elements and text
  let last = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (node.tagName === 'A') contexts.set(node, last);
      // A new section of the page starts afresh.
      else if (/^(H[1-6])$/.test(node.tagName)) last = '';
      continue;
    }
    if (node.parentElement?.closest('a, script, style')) continue;
    const words = tidy(node.nodeValue);
    if (!/[\p{L}\p{N}]/u.test(words)) continue;
    last = words.length <= 80 ? words : '';
  }
  return contexts;
}

/** A link's name, with the line it sits under when it needs one. */
function labelled(text, context) {
  if (!context || ownNumber(text) !== null || !CONTEXT_LINE.test(context)) return text;
  const lead = context.replace(/[:：]\s*$/, '').trim();
  if (!lead || lead.length > 60) return text;
  return text ? `${lead}: ${text}` : lead;
}

/** The chapter number a link's name gives, if it gives one. */
export function numberIn(text) {
  const cjk = new RegExp(`第\\s*(${NUMERAL})\\s*[章话話回节節]`).exec(text || '');
  if (cjk) return cjkNumber(cjk[1]);
  const korean = KOREAN_EPISODE.exec(text || '');
  if (korean) return parseFloat(korean[1]);
  const match = /(?:chapters?|chaps?|ch|episodes?|eps?|parts?|第)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(text)
    || /^\s*[#№]?\s*(\d+(?:\.\d+)?)/.exec(text);
  return match ? parseFloat(match[1]) : null;
}

/** The chapters a link says it holds when it holds several: "Chapters
 *  74-83" is [74, 83]. Null for a single chapter. */
export function rangeIn(text) {
  const match = /(?:chapters?|chaps?|ch|episodes?|eps?|第)?\s*\.?\s*(\d+)\s*(?:-|–|—|to|~|〜)\s*(\d+)/i.exec(String(text || ''));
  if (!match) return null;
  const from = parseInt(match[1], 10);
  const to = parseInt(match[2], 10);
  return to > from ? [from, to] : null;
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
    // A post in a WordPress list of posts is one of the chapters.
    if (link.post && !link.kind) { likely.add(link.url); continue; }
    if (link.chrome || link.kind) continue;
    if (!looksLikeChapter(link.text) || /^\s*(next|previous|prev|last|first|latest)\b/i.test(link.text)) continue;
    /* On another site only when it is a document that says which chapters
     * it holds: authors move a run of chapters elsewhere -- a Google Doc of
     * "Chapters 74-83" -- and link it from the contents in its place. A
     * link to a listing site's page about the book is not the chapters. */
    if (host && !link.url.includes(`//${host}/`)
      && !(numberIn(link.text) !== null && /\/\/(docs|drive)\.google\.com\//.test(link.url))) continue;
    likely.add(link.url);
  }

  /* Chapters already held by a run listed before them are left out. A
   * contents page that moved chapters 74 to 300 into collections keeps the
   * old one-chapter links further down, under "old links", and those pages
   * are mostly gone; downloaded, they would be the same chapters twice. */
  const covered = [];
  const copies = new Set();
  const late = [];
  let highest = -Infinity;
  for (const link of links) {
    if (!likely.has(link.url)) continue;
    const run = rangeIn(link.text);
    const number = run ? run[0] : numberIn(link.text);
    if (number === null) continue;
    if (!run && covered.some(([from, to]) => number >= from && number <= to)) copies.add(link.url);
    // Listed after a later chapter: part of a section listed again.
    if (number < highest) late.push(link.url);
    if (run) covered.push(run);
    highest = Math.max(highest, run ? run[1] : number);
  }
  for (const url of copies) likely.delete(url);
  /* A section listed again further down that is mostly copies is a list of
   * old links, all of it -- including the odd chapter no collection names,
   * whose page has gone the same way as the rest. */
  const lateCopies = late.filter((url) => copies.has(url)).length;
  if (late.length >= 5 && lateCopies >= late.length * 0.8) for (const url of late) likely.delete(url);
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

/**
 * The chapters put in the order they are read, in the places they held.
 *
 * Contents pages are not always in order. Some run newest first; some put a
 * block of the latest chapters at the top; some grow by sections added over
 * the years; and side stories are as often listed in the order they were
 * posted as in their own order -- 番外三 before 番外一, "Extra 10" before
 * "Extra 2". So each chapter is told by what it is -- prologue, chapter,
 * side story, afterword -- and its number among its kind:
 *
 *   - already in order, nothing moves;
 *   - numbered chapters running backwards are turned round;
 *   - otherwise they are put in order: the prologue, the chapters by
 *     number, then the side stories by theirs, then the afterword. A chapter
 *     with no number stays just after the one listed before it.
 *
 * Where nothing is numbered, a WordPress list of posts, newest first by its
 * nature, is turned round.
 *
 * @returns { links, how } -- how is 'sorted', 'reversed' or null (as it was)
 */
const SECTION = { prologue: 0, main: 1, side: 2, after: 3 };

export function inReadingOrder(links, isChapter, newestFirstList = false) {
  const places = [];
  links.forEach((link, at) => { if (isChapter(link)) places.push(at); });
  const chapters = places.map((at) => links[at]);
  const kinds = chapters.map((link) => chapterKind(link.text));
  const known = kinds.filter((k) => k.kind && k.number !== null);

  // Keys: [section, number, place]. Unnumbered ones follow what was before.
  let carried = [SECTION.main, -Infinity];
  const keyed = chapters.map((link, at) => {
    const { kind, number } = kinds[at];
    if (kind && (number !== null || kind === 'after')) {
      carried = [SECTION[kind], number === null ? Infinity : number];
    } else if (kind === 'side') {
      carried = [SECTION.side, carried[0] === SECTION.side ? carried[1] : -Infinity];
    }
    return { link, key: carried, at };
  });
  const ascending = (list) => list.every((each, i) => i === 0
    || each.key[0] > list[i - 1].key[0]
    || (each.key[0] === list[i - 1].key[0] && each.key[1] >= list[i - 1].key[1]));

  /* In order already: each kind in its own order, the prologue before the
   * chapters and the afterword after them. A side story the author placed
   * between two chapters, in its turn, reads where it was put. */
  const ofKind = (kind) => keyed.filter((each) => kinds[each.at].kind === kind);
  const rising = (list) => list.every((each, i) => i === 0 || each.key[1] >= list[i - 1].key[1]);
  const placeOf = (list, pick) => (list.length ? pick(list.map((each) => each.at)) : null);
  const firstMain = placeOf(ofKind('main'), (ats) => Math.min(...ats));
  const lastMain = placeOf(ofKind('main'), (ats) => Math.max(...ats));
  const inOrder = rising(ofKind('main')) && rising(ofKind('side'))
    && ofKind('prologue').every((each) => firstMain === null || each.at < firstMain)
    && ofKind('after').every((each) => lastMain === null || each.at > lastMain);

  let ordered = null;
  let how = null;
  if (chapters.length >= 3 && known.length >= chapters.length * 0.6) {
    if (!inOrder) {
      const mains = keyed.filter((each) => kinds[each.at].kind === 'main');
      const backwards = mains.length >= 3 && mains.every((each, i) => i === 0 || each.key[1] <= mains[i - 1].key[1]);
      const reversed = [...keyed].reverse();
      if (backwards && ascending(reversed)) {
        ordered = reversed.map((each) => each.link);
        how = 'reversed';
      } else {
        const sorted = [...keyed].sort((x, y) => (x.key[0] - y.key[0]) || (x.key[1] - y.key[1]) || (x.at - y.at));
        ordered = sorted.map((each) => each.link);
        how = 'sorted';
      }
    }
  } else if (newestFirstList && chapters.length > 1) {
    ordered = [...chapters].reverse();
    how = 'reversed';
  }
  if (!ordered) return { links, how: null };
  const out = links.slice();
  places.forEach((at, n) => { out[at] = ordered[n]; });
  return { links: out, how };
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
export async function findLinks(addresses, {
  onProgress, fetchPage = download, maxPages = MAX_LIST_PAGES, listGap = 250, listJitter = 0,
  // "Search for more": how patiently each page is rendered from the start
  // (0 as usual, up to 3, the longest the renderer waits).
  patience: startPatience = 0,
} = {}) {
  const links = [];
  const seen = new Map();
  const failed = [];
  let title = '';
  let author = '';
  let cover = '';
  let wordpress = false;
  // A list of posts, newest first: its chapters want turning round.
  let newestFirstList = false;
  const visited = new Set();
  let shut = false;   // a site that blocked the connection: nothing more is asked of it
  for (const [at, address] of addresses.entries()) {
    if (shut) break;
    /* A WordPress list of posts goes on, a page at a time, to the oldest
     * post: each page's "older posts" is followed, so the whole serial is
     * listed from its contents page alone rather than its newest ten. */
    let next = address;
    let pages = 0;
    // The other pages of a contents page split over numbered pages.
    const queue = [];
    let numbered = false;
    let total = 0;
    while (next && pages < maxPages) {
      // Already read (a numbered page that was also the next "older"): on.
      if (visited.has(next)) { next = nextOf(queue); continue; }
      visited.add(next);
      pages += 1;
      onProgress?.(at / addresses.length, next, pages, numbered ? total : 0);
      try {
        // The pause between pages is counted from when this one was asked
        // for: a page that took four seconds to come has waited two already.
        const askedAt = Date.now();
        const level = Math.max(0, Math.min(3, Math.round(Number(startPatience) || 0)));
        if (level) patience.set(next, level);
        let page = await fetchPage(next, { list: true });
        let found = linksOf(decodePage(await bytesOf(page.blob), page.type), page.url);
        /* A contents page built in script, caught before its list arrived:
         * the site's menus and not one chapter. Asked for again, more
         * patiently each time, as a chapter caught early is. */
        for (let more = 1; page.rendered && more <= 2 && level + more <= 3 && !listsChapters(found, page.url); more += 1) {
          patience.set(next, level + more);
          patience.set(page.url, level + more);
          page = await fetchPage(next, { list: true });
          found = linksOf(decodePage(await bytesOf(page.blob), page.type), page.url);
        }
        patience.delete(next);
        patience.delete(page.url);
        visited.add(page.url);
        if (!title) title = found.title;
        if (!author) author = found.author;
        if (!cover) cover = found.cover;
        if (found.wordpress) wordpress = true;
        if (found.list) newestFirstList = true;
        for (const link of found.links) {
          if (visited.has(link.url)) continue;
          const known = seen.get(link.url);
          if (known) {
            // A button on one page, its chapter's row on a later one: the
            // row's name, and the row's place (as on a single page).
            if (rowName(link.text) && !rowName(known.text)) {
              Object.assign(known, link);
              links.splice(links.indexOf(known), 1);
              links.push(known);
            }
            continue;
          }
          const entry = { ...link, from: at };
          seen.set(link.url, entry);
          links.push(entry);
        }
        if (pages === 1) for (const page of found.pages || []) if (!visited.has(page)) { queue.push(page); numbered = true; }
        if (numbered && !total) total = 1 + queue.length;
        next = found.list ? found.older : nextOf(queue);
        // Gently, as the chapters are: a site with a hundred pages of posts.
        if (next) {
          const left = spacing(listGap, listJitter) - (Date.now() - askedAt);
          if (left > 0) await pause(left);
        }
      } catch (error) {
        // The first page failing is the address failing; a later one of a
        // WordPress list is the end of what could be listed. A numbered page
        // that fails is passed over, and said.
        if (pages === 1 || numbered) failed.push({ url: next, reason: error.message });
        // Blocked: the rest of the list is not asked for either.
        if (blocked(error)) { queue.length = 0; next = null; shut = true; break; }
        next = nextOf(queue);
      }
    }
  }
  // The pages of the list themselves are not chapters.
  const listed = links.filter((link) => !visited.has(link.url));
  onProgress?.(1, '');
  return { links: listed, title, author, cover, failed, wordpress, newestFirstList };
}

/** Whether a contents page shows any chapters yet: three or more links that
 *  give a chapter in their name ("14화", "Chapter 3"), or that lie under
 *  the page's own address (/novel/47997/2136099 under /novel/47997), or a
 *  row of numbered pages. */
function listsChapters(found, pageUrl) {
  if (found.pages?.length || found.list) return true;
  let base = null;
  try {
    const url = new URL(pageUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (path) base = `${url.origin}${path}/`;
  } catch { /* named ones only */ }
  const chapters = found.links.filter((link) => markedNumber(link.text) !== null || (base && link.url.startsWith(base)));
  return chapters.length >= 3;
}

/** The next of the numbered pages waiting, if any. */
const nextOf = (queue) => queue.shift() || null;

/**
 * Whether the chapters as listed run newest first.
 *
 * Read off the numbers in their names where they have them. Where they do
 * not, a WordPress list of posts is newest first by its nature.
 */
export function readsBackwards(chapters, newestFirstList = false) {
  const numbered = chapters.filter((link) => numberIn(link.text) !== null).length;
  if (numbered >= 3) return newestFirst(chapters);
  return !!newestFirstList && chapters.length > 1;
}

/* ── a chapter out of a page ─────────────────────────────────────────── */

/* "Next page", as opposed to "next chapter". */
const NEXT_PAGE = /^[\s<«‹]*(下一[頁页]|下[頁页]|下一分[頁页]|next page|next part|continue reading|继续阅读|繼續閱讀)[\s>»›→]*$/i;

/** The address of the rest of this chapter, if the page is one of several. */
export function nextPageOf(doc, pageUrl) {
  for (const anchor of doc.querySelectorAll('a[href]')) {
    if (!NEXT_PAGE.test(tidy(anchor.textContent))) continue;
    let url;
    try { url = new URL(anchor.getAttribute('href'), pageUrl); } catch { continue; }
    url.hash = '';
    if (url.href !== pageUrl && sameChapter(pageUrl, url.href)) return url.href;
  }
  return null;
}

/** Whether two addresses are pages of one chapter: the same page asked
 *  for with another page number, or the chapter's address with one added. */
function sameChapter(a, b) {
  let x;
  let y;
  try { x = new URL(a); y = new URL(b); } catch { return false; }
  if (x.host !== y.host) return false;
  if (x.pathname === y.pathname) return x.search !== y.search;
  const bare = (path) => path.replace(/\.(html?|php|aspx?)$/i, '').replace(/\/+$/, '');
  const stem = (path) => bare(path).replace(/[_-]?\d+$/, '');
  const [pa, pb] = [bare(x.pathname), bare(y.pathname)];
  if (stem(pa) === stem(pb) && /[_-]\d+$/.test(pb)) return true;
  return pb.startsWith(`${pa}_`) || pb.startsWith(`${pa}-`) || pb.startsWith(`${pa}/`);
}

/* The links a chapter page puts round its own text: to the chapters either
 * side, and back to the contents. In the chapter they would be a line of
 * "Previous Chapter Next Chapter" above and below every one. */
const PAGE_LINKS = /^[\s<«‹←]*(previous|prev|next|back|table of contents|contents|index|toc|chapter list|all chapters|home|上一[章页頁]|下一[章页頁]|目录|目錄|返回)(?![a-z]).{0,24}$/i;

function stripPageLinks(story) {
  for (const anchor of [...story.querySelectorAll('a')]) {
    if (!PAGE_LINKS.test(tidy(anchor.textContent))) continue;
    // Marked where it was, so what is left around it can be judged.
    anchor.parentElement?.setAttribute('data-had-nav', '');
    anchor.remove();
  }
  /* Whatever held only those links is empty now -- or holds only the bars
   * and arrows that sat between them, or the words of a link that was not
   * linked: "Table of Contents – Next Chapter" on a first chapter, where
   * there is no previous one and the contents are not a link either.
   *
   * Only a line that held such links, or that names them outright, is taken.
   * A scene break -- "—–", "* * *" -- is part of the chapter and stays, and
   * so does a line of dialogue that happens to be "Next!" or "Home." */
  for (const block of [...story.querySelectorAll('p, div, span, li, ul, ol, td, tr, table, center, h3, h4, h5, h6')].reverse()) {
    if (block.querySelector('img')) continue;
    const words = tidy(block.textContent);
    if (words.length > 90) continue;
    const held = block.hasAttribute('data-had-nav') || !!block.querySelector('[data-had-nav]');
    if (!held && !NAV_NAMED.test(words)) continue;
    const left = words.replace(NAV_WORDS, ' ').replace(/[\s|/\\·•\-–—:<>«»‹›←→()[\]]+/g, '');
    if (!left) block.remove();
  }
  for (const marked of story.querySelectorAll('[data-had-nav]')) marked.removeAttribute('data-had-nav');
}

/* The links between chapters named outright, linked or not. */
const NAV_NAMED = /table of contents|(previous|next|prev)\s+chapter|chapter list|all chapters|目录|目錄|上一[章页頁]|下一[章页頁]/i;

/* The words of the links between chapters, linked or not. */
const NAV_WORDS = /(previous|prev|next|back to|back)\s*(chapter|page|post|part|episode)?|table of contents|contents|index|toc|chapter list|all chapters|home|上一[章页頁]|下一[章页頁]|目录|目錄|返回/gi;

/** Where a picture really is: sites that load pictures late keep the
 *  address in an attribute of their own until it scrolls into view. */
function pictureSource(img) {
  for (const name of ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-orig-file', 'data-large-file']) {
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
export async function readPage(link, index, {
  pictures = true, fetchPage = download, chapterUrls = null, listedNumbers = null,
} = {}) {
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
  // What a reader would see on it, before anything is taken out: said if
  // the chapter turns out not to be there.
  let heldText = '';
  if (page.rendered) {
    const copy = doc.body?.cloneNode(true);
    for (const node of copy?.querySelectorAll('script, style, noscript, template') || []) node.remove();
    if (copy) {
      // Piece by piece, so neighbouring links do not run together.
      const walker = doc.createTreeWalker(copy, 0x4);
      const words = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) words.push(node.nodeValue);
      heldText = words.join(' ');
    }
  }
  // On WordPress, the post's own title, which the theme marks as such.
  const wordpress = isWordPress(doc, html);
  const postTitle = wordpress
    ? tidy(doc.querySelector('.entry-title, .wp-block-post-title, h1.post-title')?.textContent) : '';
  const heading = postTitle || tidy(titleOf(doc, ''));
  // A chapter a site splits across pages: "下一页" to the rest of it.
  let further = nextPageOf(doc, page.url);
  const story = (wordpress && wordPressStory(doc)) || findStory(doc);
  stripPageLinks(story);
  /* A chapter a site loads after the page opens can be caught before it has
   * arrived, the page all there but the story. Nothing so short is a
   * chapter, so it is asked for again, more patiently each time, and the
   * download stops there if it never comes -- never a blank chapter kept. */
  // A picture counts as the chapter only where pictures are wanted: on a
  // site whose every page carries a row of adverts, an empty chapter has
  // pictures too.
  if (page.rendered && tidy(story?.textContent).length < MIN_RENDERED_STORY && (!pictures || !story?.querySelector('img'))) {
    throw notLoadedYet(link.url, heldText);
  }
  /* A rendered page that opens with another chapter than the one asked for
   * -- the link says 5화, the page begins "6화 …" -- is not kept: the site
   * mixed up two requests. Asked for again, as one not yet loaded is. */
  if (page.rendered) {
    const asked = markedNumber(link.text || '');
    const opening = tidy(story?.textContent).slice(0, 120);
    const given = rowName(opening) ? markedNumber(opening) : null;
    if (asked !== null && given !== null && Number.isInteger(asked) && Number.isInteger(given) && asked !== given) {
      throw Object.assign(notLoadedYet(link.url, heldText), {
        message: `the site gave another chapter for ${link.text} (the page began “${opening.slice(0, 40)}”)`,
      });
    }
  }
  patience.delete(link.url);

  /* The rest of a chapter split across pages, joined on, in order. Many
   * Chinese serial sites give a chapter as two or three pages, each ending
   * "下一页"; downloaded a page at a time, every chapter stopped a third of
   * the way through. Only a page of the same chapter is followed -- never
   * the next chapter, which is a link of its own in the list. */
  const visited = new Set([page.url, link.url]);
  // Never a page that is itself one of the chapters being downloaded.
  const another = (url) => !!chapterUrls && chapterUrls.has(url);
  for (let more = 0; further && !visited.has(further) && !another(further) && more < 30; more += 1) {
    visited.add(further);
    let next;
    try {
      next = await fetchPage(further);
    } catch {
      break;
    }
    const nextDoc = parseHtml(decodePage(await bytesOf(next.blob), next.type));
    const then = nextPageOf(nextDoc, next.url);
    const rest = (isWordPress(nextDoc) && wordPressStory(nextDoc)) || findStory(nextDoc);
    stripPageLinks(rest);
    // The chapter's heading, repeated on each page, said once.
    const repeat = rest.querySelector('h1, h2, h3');
    if (repeat && heading && tidy(repeat.textContent).startsWith(heading.slice(0, 12))) repeat.remove();
    for (const img of rest.querySelectorAll('img')) {
      const src = pictureSource(img);
      if (src) { try { img.setAttribute('src', new URL(src, next.url).href); } catch { /* left */ } }
    }
    // Moved, not copied: appended, each leaves the page it came from.
    for (const node of [...rest.childNodes]) story.appendChild(doc.adoptNode(node));
    further = then;
  }

  // Pictures found as the chapter is read, fetched once it has been.
  const wanted = [];
  let part = 0;
  const resolveImage = (src) => {
    if (!pictures) return null;
    let absolute;
    try { absolute = new URL(src, page.url).href; } catch { return null; }
    if (!/^https?:/.test(absolute)) return null;
    const href = `web/${index}-${wanted.length}`;
    wanted.push({ href, url: absolute, part });
    return href;
  };
  for (const img of story.querySelectorAll('img')) {
    const src = pictureSource(img);
    if (src) img.setAttribute('src', src);
  }

  /* A page that holds several chapters -- a Google Doc of "Chapters 74-83",
   * a post of two -- is divided at its chapter headings, so the book has
   * each as a chapter of its own rather than one long one named for ten. */
  const own = markedNumber(link.text || '');
  let several = rangeIn(link.text) || /docs\.google\.com\/document\//.test(page.url)
    ? chaptersIn(story) : null;
  /* A post that carries the chapters after it -- "00005 정하연 =====" and
   * a hundred more under 4화 -- is cut at those lines. This chapter keeps
   * what comes before the first; of the rest, only a chapter the list does
   * not have a link of its own for is kept (as a chapter, placed by its
   * number), so nothing is in the book twice. */
  if (!several) {
    const posted = postedTogether(story, own);
    if (posted) {
      several = posted.filter((piece, at) => at === 0 || !listedNumbers?.has(piece.number));
    }
  }
  const read = (several || [{ node: story, title: '' }]).map((each, at) => {
    part = at;
    return { ...readChapter(each.node, resolveImage), title: each.title, extra: !!each.extra, number: each.number };
  });

  const images = [];
  for (const [n, picture] of wanted.entries()) {
    try {
      const got = await fetchPage(picture.url, { picture: true });
      const kind = String(got.type || '').split(';')[0].toLowerCase();
      if (!kind.startsWith('image/') || !got.blob.size) throw new Error('not a picture');
      images.push({
        // Numbered across the book, so the picture reel runs in reading order.
        href: picture.href, blob: got.blob, order: index * 1000 + n, chapterIndex: index,
        part: picture.part, animated: kind === 'image/gif', width: 0, height: 0,
      });
    } catch {
      // A picture that will not come costs its place, not the chapter.
      const piece = read[picture.part];
      if (piece) piece.html = piece.html.split(`<img data-img="${picture.href}">`).join('');
    }
  }
  let { html: body, text } = read[0];

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
  const chapter = {
    index, title, fromToc: true, html: body, words: countWords(text, lang), url: page.url, from: link.url,
    ...(own !== null ? { number: own } : {}),
  };
  return {
    chapter,
    // Each chapter the page held, when it held several.
    chapters: several ? read.map((each, at) => ({
      index, title: each.title || title, fromToc: true, html: each.html, words: countWords(each.text, lang), url: page.url,
      // The link it came from -- a chapter cut out of another's post has none of its own.
      ...(at === 0 ? { from: link.url } : {}),
      // A chapter posted under another, kept: placed by its number.
      ...(each.extra ? { extra: true, number: each.number } : at === 0 && own !== null ? { number: own } : {}),
    })) : [chapter],
    images,
    lang,
  };
}

/* A line that starts a chapter: "Chapter 75", "Ch. 75 – The Gate", "第七十五章". */
const CHAPTER_HEADING = /^(chapter|ch\.?|episode|ep\.?)\s*\d+|^第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章话話回]/i;

/**
 * A page that holds several chapters, divided at the line that starts each.
 *
 * The line is a heading, or a short paragraph that says nothing but which
 * chapter it is -- which is how most documents mark them. Anything before
 * the first is the document's own title, and is left out unless it is
 * writing. Null when there are not at least two to divide at.
 */
function chaptersIn(story) {
  const starts = [...story.querySelectorAll('h1, h2, h3, h4, h5, p, div')]
    .filter((node) => {
      const words = tidy(node.textContent);
      if (!words || words.length > 90 || !CHAPTER_HEADING.test(words)) return false;
      // The innermost: a heading inside a <div> is the heading.
      return ![...node.children].some((child) => CHAPTER_HEADING.test(tidy(child.textContent)) && /^(H\d|P|DIV)$/.test(child.tagName));
    });
  if (starts.length < 2) return null;
  const doc = story.ownerDocument;
  const pieces = [];
  const before = doc.createRange();
  before.setStart(story, 0);
  before.setEndBefore(starts[0]);
  const opening = doc.createElement('div');
  opening.appendChild(before.cloneContents());
  if (tidy(opening.textContent).length > 400) pieces.push({ node: opening, title: 'Before the first chapter' });
  starts.forEach((start, at) => {
    const range = doc.createRange();
    range.setStartBefore(start);
    if (starts[at + 1]) range.setEndBefore(starts[at + 1]);
    else range.setEnd(story, story.childNodes.length);
    const node = doc.createElement('div');
    node.appendChild(range.cloneContents());
    pieces.push({ node, title: tidy(start.textContent) });
  });
  return pieces;
}

/* A line inside a post that starts the next chapter: its number (often
 * padded, "00005"), maybe a name, and a row of "=====" -- the way some
 * uploaders run several chapters together in one post. */
const POSTED_MARK = /^[^\S\n]*(?:제[^\S\n]*)?0*(\d{1,5})[^\S\n]*(?:화|회|장)?(?:[^\S\n]+([^\n]{0,60}?))?[^\S\n]*(?:={5,}|-{5,}|~{5,}|\*{5,}|#{5,})[^\S\n]*$/gm;

/**
 * The chapters a post carries after its own, cut at the lines that start
 * them -- or null when it carries none.
 *
 * Only lines that count on from the post's own chapter, one after another
 * (a gap of a chapter or two allowed), are cuts: a number in the story is
 * not a chapter. The first piece is the post's own chapter, up to the first
 * cut; each after it is { node, title, number, extra }.
 */
export function postedTogether(story, own = null) {
  const doc = story.ownerDocument;
  const found = [];
  const walker = doc.createTreeWalker(story, 0x4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('script, style')) continue;
    POSTED_MARK.lastIndex = 0;
    for (let m = POSTED_MARK.exec(node.data); m; m = POSTED_MARK.exec(node.data)) {
      found.push({ node, start: m.index, end: m.index + m[0].length, number: Number(m[1]), name: tidy(m[2]) });
    }
  }
  const cuts = [];
  let last = Number.isFinite(own) ? own : null;
  for (const mark of found) {
    if (last === null || (mark.number > last && mark.number <= last + 3)) {
      cuts.push(mark);
      last = mark.number;
    }
  }
  if (!cuts.length) return null;
  const pieceBetween = (startAt, endAt) => {
    const range = doc.createRange();
    if (startAt) range.setStart(startAt.node, startAt.offset); else range.setStart(story, 0);
    if (endAt) range.setEnd(endAt.node, endAt.offset); else range.setEnd(story, story.childNodes.length);
    const node = doc.createElement('div');
    node.appendChild(range.cloneContents());
    return node;
  };
  const after = (mark) => ({ node: mark.node, offset: mark.node.data[mark.end] === '\n' ? mark.end + 1 : mark.end });
  const pieces = [{ node: pieceBetween(null, { node: cuts[0].node, offset: cuts[0].start }), title: '', number: own }];
  cuts.forEach((mark, at) => {
    const next = cuts[at + 1];
    pieces.push({
      node: pieceBetween(after(mark), next ? { node: next.node, offset: next.start } : null),
      title: `${mark.number}화${mark.name ? ` ${mark.name}` : ''}`,
      number: mark.number,
      extra: true,
    });
  });
  return pieces;
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
      const got = await fetchPage(coverUrl, { picture: true });
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
          // hundred usually takes the next. Not one that has blocked us.
          if (stop() || blocked(error)) throw error;
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
  fetchPage = download, gap = 250, jitter = 0, patience = {}, shouldStop = null,
  // Each chapter as it goes into the book, in order, with the link to resume
  // from should everything stop now: Build writes it there and then, so a
  // build the app is closed in the middle of keeps what had come.
  onChapter = null,
} = {}) {
  const wait = { ...PATIENCE, ...patience };
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

  /* Paused by hand ("Pause & keep"): no page is begun after it, the ones
   * under way are finished, and it stops where the first not begun is --
   * the same as a page that would not come, so what came is a book and the
   * rest is kept to carry on with. */
  const pausing = () => typeof shouldStop === 'function' && !!shouldStop();
  const PAUSED = () => Object.assign(new Error(PAUSED_REASON), { paused: true, tries: 1 });
  const pauseAt = (at) => {
    if (at >= stopAt || at >= links.length) return;
    stopAt = at;
    stopped = { at, url: links[at].url, text: links[at].text, reason: PAUSED_REASON };
  };

  /* Chapters posted under another and kept (the list has no link of its
   * own for them) wait here, in number order, and go into the book before
   * the first chapter after them -- not straight after the post they came
   * in, which may be a hundred chapters early. */
  const parked = [];
  const place = async (chapter, images) => {
    const index = chapters.length;
    for (const image of images) {
      imageCount += 1;
      const { part, ...picture } = image;
      await onImage?.({ ...picture, chapterIndex: index });
    }
    words += chapter.words || 0;
    const placed = { ...chapter, index };
    chapters.push(placed);
    await onChapter?.(placed, handed);
  };
  const unpark = async (before = Infinity) => {
    while (parked.length && parked[0].chapter.number < before) {
      const { chapter, images } = parked.shift();
      await place(chapter, images);
    }
  };

  const handOn = async () => {
    while (handed < stopAt && waiting[handed] !== undefined) {
      const got = waiting[handed];
      waiting[handed] = null;
      handed += 1;
      if (!got) continue;
      if (!lang && got.lang) lang = got.lang;
      for (const [at, chapter] of (got.chapters || [got.chapter]).entries()) {
        const images = got.images.filter((image) => (image.part || 0) === at);
        if (chapter.extra) {
          parked.push({ chapter, images });
          parked.sort((a, b) => a.chapter.number - b.chapter.number);
          continue;
        }
        if (Number.isFinite(chapter.number)) await unpark(chapter.number);
        await place(chapter, images);
      }
    }
  };

  /* The rate is the reader's: `gap` milliseconds between one page being
   * asked for and the next, give or take `jitter` (see spacing), across both
   * of the requests that run at once. Nought is as fast as the two will go. */
  let nextAt = 0;
  const myTurn = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + spacing(gap, jitter);
    if (wait) await pause(wait);
  };

  /* Asked again before it is given up on -- patiently.
   *
   * Stopping the whole download at a page means a page has to really be
   * refusing, not having a bad moment: a dropped connection, a site busy for
   * a few seconds, a "too many requests" that a refresh clears. So a page is
   * asked for again and again, a little longer between each, for up to about
   * a minute, before it counts as failed. A site turning requests away is
   * asked again at once first, as a refresh would. Only a page that plainly
   * is not there gets a single second try. And a try that was cut off by the
   * app going off screen does not count at all.
   */
  const chapterUrls = new Set(links.map((link) => link.url));
  // The chapters the list has links of their own for, by number: a post that
  // carries them as well is not let put them in the book twice.
  const listedNumbers = new Set(links.map((link) => markedNumber(link.text || '')).filter(Number.isFinite));
  const nameOf = (link, at) => link.text || `page ${at + 1}`;
  onProgress?.(0, 0, links.length);
  const fetchAgain = async (link, at) => {
    let lastError = null;
    let waits = null;
    let tries = 0;
    let uncounted = 0;
    while (true) {
      if (at > stopAt) throw new Error('stopped');
      await whenOnScreen();
      const before = interruptions;
      try {
        if (tries === 0 && uncounted === 0) await myTurn();
        if (pausing()) throw PAUSED();
        // Said while it is read: on a site rendered page by page, a chapter
        // can take a while, and the count only moves once one is done.
        onProgress?.(Math.min(1, settled / links.length), Math.min(settled, links.length), links.length,
          `${tries ? `trying ${nameOf(link, at)} again` : `reading ${nameOf(link, at)}`}…`);
        return await readPage(link, at, { pictures, fetchPage, chapterUrls, listedNumbers });
      } catch (error) {
        if (error?.paused) throw error;
        // Blocked: not asked again, and the download stops here.
        if (blocked(error)) throw Object.assign(error, { tries: tries + 1 });
        lastError = error;
        // Paused meanwhile: this page is where it stops, not tried again.
        if (pausing()) throw PAUSED();
        // Failed while the app was away: asked again once it is back.
        if (interruptions !== before && uncounted < 20) { uncounted += 1; continue; }
        if (!waits) {
          // A chapter that had not loaded: twice more, more patiently each
          // time -- not the minute and more a refusing site is given.
          // So is a page of a site rendered page by page: each try is a
          // whole browser's worth of waiting.
          waits = error?.notLoaded || renderedHere(link.url) ? wait.backoff.slice(0, 2)
            : gone(error) ? [wait.retry]
            : tooMany(error) ? [...wait.refresh, ...wait.backoff]
            : [...wait.backoff];
        }
        if (tries >= waits.length) break;
        onProgress?.(Math.min(1, settled / links.length), Math.min(settled, links.length), links.length,
          `${nameOf(link, at)}: ${error?.message || 'could not be read'} — trying again`);
        await pause(waits[tries]);
        tries += 1;
      }
    }
    throw Object.assign(lastError || new Error('could not be read'), { tries: tries + 1 });
  };

  const worker = async () => {
    while (next < stopAt) {
      if (pausing()) { pauseAt(next); break; }
      const at = next++;
      const link = links[at];
      let got = false;
      try {
        got = await fetchAgain(link, at);
      } catch (error) {
        // The earliest page to fail is where it stops; a later one that
        // fails meanwhile is part of the rest anyway.
        if (error?.paused) pauseAt(at);
        else if (at < stopAt) {
          stopAt = at;
          const tried = error.tries > 1 ? ` (tried ${error.tries} times)` : '';
          stopped = { at, url: link.url, text: link.text, reason: `${error.message || 'could not be read'}${tried}` };
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
  await unpark();

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

/** What a download stopped by hand says where it stopped. */
export const PAUSED_REASON = 'paused';

/** How long to wait between tries of a page, in milliseconds. */
export const PATIENCE = {
  retry: 1000,                          // a page that is not there: once more
  refresh: [300, 1000, 2500],           // a site turning requests away: at once
  backoff: [1500, 4000, 8000, 15000, 30000],   // anything else: longer each time
};

/** A site that has blocked the connection outright (Cloudflare's "Sorry, you
 *  have been blocked"): every request now only keeps the block up longer, so
 *  nothing is asked again -- not a retry, not the next page. */
export const blocked = (error) => /has blocked this connection/i.test(String(error?.message || error || ''));

/** A page that is not there, which no amount of asking will change. */
export const gone = (error) => /\b(404|410)\b|does not exist|not a web address|only web addresses/i
  .test(String(error?.message || error || ''));

/**
 * The pause before the next page: the delay set, give or take the variation
 * set, anywhere in between and different every time -- 500 give or take 200
 * is anything from 300 to 700. Requests at a fixed beat are the easiest thing
 * for a site to notice; a reader's pace is not a metronome. Never below
 * nothing.
 */
export function spacing(gap = 0, jitter = 0, random = Math.random) {
  const base = Math.max(0, Number(gap) || 0);
  const spread = Math.max(0, Number(jitter) || 0);
  return Math.max(0, Math.round(base + (random() * 2 - 1) * spread));
}

/** A site asking to be asked less often. */
export const tooMany = (error) => /\b429\b|too many requests/i.test(String(error?.message || error || ''));

/** The site's picture of the book, fetched, or null. */
export async function fetchCover(url, { fetchPage = download } = {}) {
  if (!url) return null;
  try {
    // Briefly: adding pages to Build should not sit waiting on a picture.
    const got = await fetchPage(url, { timeout: 15000, picture: true });
    return String(got.type || '').toLowerCase().startsWith('image/') && got.blob.size > 2048 ? got.blob : null;
  } catch {
    return null;
  }
}
