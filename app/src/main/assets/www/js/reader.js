/* The reader.
 *
 * Two layouts of the same text, sharing one idea of where you are.
 *
 *   paged   CSS multi-column. The flow is laid out in columns exactly one
 *           viewport wide and translated sideways by exactly that width.
 *   scroll  ordinary vertical scrolling, optionally continuing straight into
 *           the next chapter rather than stopping at the end of one.
 *
 * Position is stored as a character offset into the chapter, never as a page
 * number or a scroll offset. Pages are a function of type size, margins and
 * screen width; scroll offsets are a function of all that plus the mode
 * itself. The character offset survives all of it, which is why switching
 * between paged and scroll mid-chapter lands you on the same sentence.
 */

import * as store from './store.js';
import { countWords } from './parse.js';
import { pool } from './blobs.js';
import * as translate from './translate.js';

const el = (id) => document.getElementById(id);

export const state = {
  book: null,
  chapters: [],
  chapterIndex: 0,
  page: 0,
  pageCount: 1,
  anchor: 0,
  chrome: 'full',
  layout: null,
  pagesBefore: [],   // running page total at the start of each chapter
  totalPages: 1,

  images: new Map(), // href -> Blob, for the open book
  names: new Map(),  // chapter index -> translated name, when enabled
  translated: null,  // chapter index whose body is currently shown translated

  mode: 'paged',     // 'paged' | 'scroll'
  endless: true,     // scroll mode only: run on into the next chapter
  loaded: [],        // chapter indices currently in the DOM, ascending
};

let viewport, flow, session = null, onChange = () => {};

/* One pool of image URLs per rendered chapter, keyed by chapter index.
 *
 * Chapter HTML stores an href, not a blob: URL, because those die with the
 * document (see js/blobs.js). Per chapter rather than one shared pool because
 * endless scroll drops chapters off the far end as you read, and a single
 * pool could not release just that chapter's URLs. */
const sectionPools = new Map();

function releaseSection(index) {
  sectionPools.get(index)?.release();
  sectionPools.delete(index);
}

function releaseAllSections() {
  for (const p of sectionPools.values()) p.release();
  sectionPools.clear();
}
let scrollTimer = null;
let extending = false;

/** How many chapters may sit in the DOM at once in endless mode. */
const WINDOW = 5;

export function init(handlers) {
  viewport = el('page-viewport');
  flow = el('page-flow');
  onChange = handlers.onChange || (() => {});

  viewport.addEventListener('scroll', () => {
    if (state.mode !== 'scroll') return;
    // Reading position is recomputed on a trailing edge: doing it per scroll
    // event would walk every text node sixty times a second.
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(onScrolled, 90);
    extendIfNeeded();
  }, { passive: true });
}

/* ── mode ─────────────────────────────────────────────────────────────── */

const isScroll = () => state.mode === 'scroll';

export async function setMode(mode) {
  if (mode === state.mode) return;
  const anchor = state.anchor;
  const chapter = state.chapterIndex;
  state.mode = mode;
  viewport.classList.toggle('scrolling', isScroll());
  flow.classList.toggle('scrolling', isScroll());
  // Reload rather than re-measure: the two modes hold different numbers of
  // chapters in the DOM, and the anchor is what carries the place across.
  await loadChapter(chapter, anchor);
}

export function setEndless(on) {
  state.endless = on;
  if (isScroll() && on) extendIfNeeded();
}

/* ── measurement ──────────────────────────────────────────────────────── */

function pageWidth() {
  // The viewport's border box: one column plus one gap equals exactly this.
  return viewport.getBoundingClientRect().width;
}

function contentWidth() {
  const cs = getComputedStyle(viewport);
  return pageWidth() - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

function viewportHeight() {
  return viewport.clientHeight;
}

function relayout() {
  if (isScroll()) {
    flow.style.columnWidth = '';
    flow.style.columnGap = '';
    // "Pages" stay meaningful in scroll mode so the counters and the scrub
    // rail keep working: one page is one screenful.
    state.pageCount = Math.max(1, Math.ceil(viewport.scrollHeight / viewportHeight()));
    return;
  }
  const gap = pageWidth() - contentWidth();
  flow.style.columnWidth = `${contentWidth()}px`;
  flow.style.columnGap = `${gap}px`;
  // n columns measure n*w + (n-1)*gap, so invert that rather than dividing.
  const total = flow.scrollWidth + gap;
  state.pageCount = Math.max(1, Math.round(total / (contentWidth() + gap)));
}

/** Suppress the turn animation around a jump that is not a page turn. */
function withoutMotion(fn) {
  flow.classList.add('no-motion');
  fn();
  // Two frames: one for the style to apply, one for it to have taken effect.
  requestAnimationFrame(() => requestAnimationFrame(() => flow.classList.remove('no-motion')));
}

function show(page, { animate = true } = {}) {
  state.page = Math.max(0, Math.min(page, state.pageCount - 1));

  if (isScroll()) {
    viewport.scrollTo({
      top: state.page * viewportHeight(),
      behavior: animate && !reducedMotion() ? 'smooth' : 'auto',
    });
  } else {
    const move = () => { flow.style.transform = `translateX(${-state.page * pageWidth()}px)`; };
    if (animate) move(); else withoutMotion(move);
  }

  state.anchor = currentAnchor();
  save();
  onChange(state);
}

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/* ── chapters in the DOM ──────────────────────────────────────────────── */

function sectionFor(index) {
  return flow.querySelector(`[data-chapter="${index}"]`);
}

function chapterSection(chapter) {
  const section = document.createElement('section');
  section.className = 'chapter';
  section.dataset.chapter = String(chapter.index);
  section.innerHTML = chapter.html;
  hydrateImages(section, chapter.index);
  return section;
}

/**
 * Turn the stored href references into URLs this document can load.
 *
 * An image whose blob is missing -- a book imported before blobs were stored,
 * say -- is removed rather than left as a broken-image icon in the middle of
 * a paragraph.
 */
function hydrateImages(section, index) {
  releaseSection(index);
  const urls = pool();
  sectionPools.set(index, urls);
  for (const img of section.querySelectorAll('img[data-img]')) {
    const url = urls.url(state.images.get(img.getAttribute('data-img')));
    if (url) img.src = url;
    else img.remove();
  }
}

/** The chapter occupying the top of the viewport right now. */
function chapterAtViewport() {
  if (!isScroll()) return state.chapterIndex;
  const top = viewport.getBoundingClientRect().top;
  let current = state.loaded[0] ?? state.chapterIndex;
  for (const index of state.loaded) {
    const section = sectionFor(index);
    if (section && section.getBoundingClientRect().top - top <= 1) current = index;
  }
  return current;
}

/* ── anchors ──────────────────────────────────────────────────────────── */

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: offset, length: node.nodeValue.length });
    offset += node.nodeValue.length;
  }
  return nodes;
}

/** Column index a range sits in. Paged mode only. */
function pageOfRange(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const origin = viewport.getBoundingClientRect().left;
  const x = rect.left - origin + state.page * pageWidth();
  return Math.floor(x / pageWidth());
}

/** Distance from the top of the scrollable content. Scroll mode only. */
function scrollTopOfRange(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const origin = viewport.getBoundingClientRect().top;
  return rect.top - origin + viewport.scrollTop;
}

function rangeAt(entry, offset = 0) {
  const range = document.createRange();
  const at = Math.min(offset, entry.length);
  range.setStart(entry.node, at);
  range.setEnd(entry.node, Math.min(at + 1, entry.length));
  return range;
}

/** The character offset currently at the top of the view. */
function currentAnchor() {
  const index = chapterAtViewport();
  const section = sectionFor(index);
  if (!section) return 0;
  state.chapterIndex = index;

  const nodes = textNodes(section);
  if (isScroll()) {
    const top = viewport.scrollTop;
    for (const entry of nodes) {
      const at = scrollTopOfRange(rangeAt(entry));
      if (at !== null && at >= top - 2) return entry.start;
    }
  } else {
    for (const entry of nodes) {
      if (pageOfRange(rangeAt(entry)) >= state.page) return entry.start;
    }
  }
  return 0;
}

/** Which page shows a given offset in a given chapter. */
function pageAtAnchor(anchor, chapterIndex = state.chapterIndex) {
  const section = sectionFor(chapterIndex);
  if (!section) return 0;
  for (const entry of textNodes(section)) {
    if (anchor >= entry.start && anchor <= entry.start + entry.length) {
      const range = rangeAt(entry, anchor - entry.start);
      if (isScroll()) {
        const top = scrollTopOfRange(range);
        if (top !== null) return Math.floor(top / viewportHeight());
      } else {
        const page = pageOfRange(range);
        if (page !== null) return page;
      }
    }
  }
  return 0;
}

/* ── loading ──────────────────────────────────────────────────────────── */

export async function open(bookId, opts = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library');

  state.book = book;
  state.chapters = await store.byIndex('chapters', 'bookId', bookId);
  state.chapters.sort((a, b) => a.index - b.index);

  const images = await store.byIndex('images', 'bookId', bookId);
  state.images = new Map(images.filter((i) => i.blob).map((i) => [i.href, i.blob]));
  state.layout = await store.layoutFor(bookId);
  applyLayout(state.layout);

  const saved = await store.get('positions', bookId);
  const chapterIndex = opts.chapter ?? saved?.chapterIndex ?? 0;
  const anchor = opts.anchor ?? (opts.chapter != null ? 0 : saved?.anchor ?? 0);

  await loadChapter(chapterIndex, anchor);
  startSession();
  loadChapterNames();     // not awaited: the book opens now, names follow
  return book;
}

export async function loadChapter(index, anchor = 0) {
  const chapter = state.chapters[Math.max(0, Math.min(index, state.chapters.length - 1))];
  if (!chapter) return;

  state.chapterIndex = chapter.index;
  state.loaded = [chapter.index];
  // Everything on screen is about to be replaced, so its URLs go with it.
  releaseAllSections();
  flow.replaceChildren(chapterSection(chapter));
  withoutMotion(() => { flow.style.transform = 'translateX(0)'; });
  viewport.scrollTop = 0;

  // Images decode asynchronously and change the layout when they land, so
  // wait for them before measuring or the page count is wrong on arrival.
  await imagesSettled();
  relayout();
  estimateTotals();
  show(pageAtAnchor(anchor), { animate: false });
  if (isScroll()) extendIfNeeded();
}

function imagesSettled() {
  const images = [...flow.querySelectorAll('img')];
  if (!images.length) return Promise.resolve();
  return Promise.all(images.map((img) => (img.complete ? Promise.resolve()
    : new Promise((res) => { img.onload = img.onerror = res; }))));
}

/** The display name for a chapter: translated if that is switched on. */
export function chapterName(index) {
  const chapter = state.chapters.find((c) => c.index === index);
  return state.names.get(index) || chapter?.title || `Chapter ${index + 1}`;
}

async function loadChapterNames() {
  state.names = new Map();
  const settings = await store.settings();
  if (!settings.translateChapters || !translate.status().configured) return;
  try {
    const { results } = await translate.translateChapterNames(
      state.book.id, state.chapters, settings.translateTarget, state.book.lang);
    for (const chapter of state.chapters) {
      const value = results.get(`chapter:${chapter.index}`);
      if (value && value !== chapter.title) state.names.set(chapter.index, value);
    }
    onChange(state);
  } catch {
    // No key, no quota, or no network. The original names are already shown.
  }
}

/**
 * Swap the current chapter between its own words and a translation.
 *
 * The original is never overwritten -- what is stored stays as it was parsed,
 * and this re-renders from a translated copy held only for as long as it is on
 * screen. Toggling back is exact, not a re-translation.
 */
export async function toggleTranslation() {
  const chapter = state.chapters.find((c) => c.index === state.chapterIndex);
  if (!chapter) return { shown: false };

  if (state.translated === state.chapterIndex) {
    state.translated = null;
    await loadChapter(state.chapterIndex, state.anchor);
    return { shown: false };
  }

  const settings = await store.settings();
  const { html, characters } = await translate.translateChapterBody(
    state.book.id, chapter, settings.translateTarget, state.book.lang);

  state.translated = state.chapterIndex;
  const anchor = state.anchor;
  releaseAllSections();
  const section = document.createElement('section');
  section.className = 'chapter translated';
  section.dataset.chapter = String(chapter.index);
  section.innerHTML = html;
  hydrateImages(section, chapter.index);
  flow.replaceChildren(section);
  state.loaded = [chapter.index];

  await imagesSettled();
  relayout();
  // A character offset into the original does not map onto a translation of
  // a different length, so the chapter opens at its start rather than at a
  // position that would be quietly wrong. Toggling back restores the place.
  state.anchor = anchor;
  show(0, { animate: false });
  return { shown: true, characters };
}

/* ── endless scrolling ────────────────────────────────────────────────── */

/**
 * Append or prepend a neighbouring chapter as the edges come into view.
 *
 * Prepending is the awkward direction: inserting content above the viewport
 * moves everything down, so the scroll position has to be corrected by
 * exactly the inserted height or the text jumps under the reader's eyes.
 */
async function extendIfNeeded() {
  if (!isScroll() || !state.endless || extending) return;

  const margin = viewportHeight() * 1.25;
  const nearBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - margin;
  const nearTop = viewport.scrollTop <= margin;

  const last = state.loaded[state.loaded.length - 1];
  const first = state.loaded[0];

  if (nearBottom && last < state.chapters.length - 1) {
    extending = true;
    try {
      const next = state.chapters[last + 1];
      flow.appendChild(chapterSection(next));
      state.loaded.push(next.index);
      await imagesSettled();
      trimWindow('start');
      relayout();
      onChange(state);
    } finally { extending = false; }
    return;
  }

  if (nearTop && first > 0) {
    extending = true;
    try {
      const previous = state.chapters[first - 1];
      const before = viewport.scrollHeight;
      flow.insertBefore(chapterSection(previous), flow.firstChild);
      state.loaded.unshift(previous.index);
      await imagesSettled();
      // Correct for the content that appeared above.
      viewport.scrollTop += viewport.scrollHeight - before;
      trimWindow('end');
      relayout();
      onChange(state);
    } finally { extending = false; }
  }
}

/**
 * Keep the DOM bounded. A long book held entirely in memory is how a reader
 * becomes unusable three hours in.
 */
function trimWindow(from) {
  while (state.loaded.length > WINDOW) {
    if (from === 'start') {
      const index = state.loaded.shift();
      const section = sectionFor(index);
      if (!section) continue;
      // Removing from above moves everything up, so compensate.
      const height = section.getBoundingClientRect().height;
      section.remove();
      releaseSection(index);
      viewport.scrollTop -= height;
    } else {
      const index = state.loaded.pop();
      sectionFor(index)?.remove();
      releaseSection(index);
    }
  }
}

function onScrolled() {
  const previous = state.chapterIndex;
  state.anchor = currentAnchor();
  state.page = Math.round(viewport.scrollTop / viewportHeight());
  if (state.chapterIndex !== previous) estimateTotals();
  save();
  onChange(state);
}

/* ── book-level position ──────────────────────────────────────────────── */

/**
 * Only the open chapter is truly measured; the rest are estimated from their
 * word counts against the current chapter's density. The estimate is
 * re-derived whenever a chapter is opened, so the number converges as someone
 * reads rather than being wrong in a fixed way.
 */
function estimateTotals() {
  const current = state.chapters.find((c) => c.index === state.chapterIndex);
  const measured = isScroll()
    ? Math.max(1, Math.ceil((sectionFor(state.chapterIndex)?.getBoundingClientRect().height || 0) / viewportHeight()))
    : state.pageCount;
  const density = current && current.words ? current.words / measured : 280;

  let running = 0;
  state.pagesBefore = [];
  for (const chapter of state.chapters) {
    state.pagesBefore[chapter.index] = running;
    running += chapter.index === state.chapterIndex
      ? measured
      : Math.max(1, Math.round((chapter.words || 0) / density) || 1);
  }
  state.totalPages = Math.max(1, running);
}

export function pageInBook() {
  const within = isScroll()
    ? Math.round(Math.max(0, viewport.scrollTop
        - (sectionFor(state.chapterIndex)?.offsetTop || 0)) / viewportHeight())
    : state.page;
  return (state.pagesBefore[state.chapterIndex] || 0) + within + 1;
}

export function percent() {
  return Math.min(1, pageInBook() / state.totalPages);
}

/* ── layout override ──────────────────────────────────────────────────── */

export function applyLayout(layout) {
  state.layout = layout;
  const root = document.documentElement.style;
  root.setProperty('--read-size', `${layout.size}px`);
  root.setProperty('--read-leading', String(layout.leading));
  root.setProperty('--read-para', `${layout.para}px`);
  root.setProperty('--read-margin', `${layout.margin}px`);
  root.setProperty('--read-align', layout.justified ? 'justify' : 'left');
  // Justified text needs a first-line indent or the paragraph breaks vanish.
  root.setProperty('--read-indent', layout.justified ? '1.2em' : '0');
  root.setProperty('--read-face', layout.face === 'Archivo'
    ? 'var(--font-heading)' : 'var(--font-body)');
  if (layout.ink) root.setProperty('--read-ink', layout.ink);
  else root.removeProperty('--read-ink');

  state.endless = layout.endless !== false;
  if (layout.mode && layout.mode !== state.mode) {
    state.mode = layout.mode;
    viewport.classList.toggle('scrolling', isScroll());
    flow.classList.toggle('scrolling', isScroll());
  }
}

/** Re-flow at the current anchor, so the reader never jumps. */
export function repaginate() {
  if (!state.book) return;
  const anchor = state.anchor;
  const chapter = state.chapterIndex;
  requestAnimationFrame(() => {
    relayout();
    estimateTotals();
    show(pageAtAnchor(anchor, chapter), { animate: false });
  });
}

/* ── navigation ───────────────────────────────────────────────────────── */

export function turn(delta) {
  if (isScroll()) {
    // A tap moves by just under a screen, so a line or two carries over and
    // you can see you have not skipped anything.
    const step = viewportHeight() * 0.9 * delta;
    const target = viewport.scrollTop + step;
    if (target < 0 && !state.endless && state.chapterIndex > 0) return prevChapter(true);
    viewport.scrollTo({ top: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
    countPage();
    return;
  }

  const next = state.page + delta;
  if (next < 0) return prevChapter(true);
  if (next >= state.pageCount) return nextChapter();
  countPage();
  show(next);
}

export function goToPage(page) { show(page, { animate: false }); }

/* ── the scrub rail ───────────────────────────────────────────────────────
 * Paged mode has discrete pages, so the rail marks which one you are on.
 * Scroll mode has no pages, so it behaves as a scrollbar: a proportional
 * handle over the whole scrollable height. Same control, two readings.
 */

/** 0..1 through the loaded text. */
export function scrollFraction() {
  if (!isScroll()) return state.pageCount > 1 ? state.page / (state.pageCount - 1) : 0;
  const max = viewport.scrollHeight - viewport.clientHeight;
  return max > 0 ? Math.min(1, viewport.scrollTop / max) : 0;
}

/** How much of the text is on screen, as a fraction. Sizes the handle. */
export function viewportRatio() {
  if (!isScroll()) return 1 / Math.max(1, state.pageCount);
  return viewport.scrollHeight ? viewport.clientHeight / viewport.scrollHeight : 1;
}

/** Drag target for the rail and the progress bar. */
export function scrubTo(fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  if (isScroll()) {
    const max = viewport.scrollHeight - viewport.clientHeight;
    // Dragging is a direct manipulation: smooth-scrolling it would lag the
    // thumb behind the finger.
    viewport.scrollTop = f * max;
    return;
  }
  show(Math.round(f * (state.pageCount - 1)), { animate: false });
}

export async function nextChapter() {
  if (state.chapterIndex >= state.chapters.length - 1) return;
  countPage();
  // In endless mode the next chapter may already be below; scroll to it
  // rather than tearing the view down and rebuilding it.
  if (isScroll() && state.loaded.includes(state.chapterIndex + 1)) {
    const section = sectionFor(state.chapterIndex + 1);
    viewport.scrollTo({ top: section.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  await loadChapter(state.chapterIndex + 1, 0);
}

export async function prevChapter(toEnd = false) {
  if (state.chapterIndex <= 0) return;
  countPage();
  if (isScroll() && state.loaded.includes(state.chapterIndex - 1)) {
    const section = sectionFor(state.chapterIndex - 1);
    viewport.scrollTo({ top: section.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  await loadChapter(state.chapterIndex - 1, 0);
  if (toEnd && !isScroll()) show(state.pageCount - 1, { animate: false });
}

export async function goTo({ chapter, anchor = 0, flash = false }) {
  await loadChapter(chapter, anchor);
  if (flash) flashAt(anchor);
}

/** Return from the image reel and mark the figure once, then leave it alone. */
function flashAt(anchor) {
  const section = sectionFor(state.chapterIndex) || flow;
  const entry = textNodes(section).find((n) => anchor >= n.start && anchor <= n.start + n.length);
  const target = (entry?.node.parentElement || section).closest('figure, p, img')
    || section.firstElementChild;
  if (!target) return;
  target.classList.add('fig-flash');
  setTimeout(() => target.classList.remove('fig-flash'), 1200);
}

export function flashImage(href) {
  const img = flow.querySelector(`img[data-img="${CSS.escape(href)}"]`);
  if (!img) return;
  const range = document.createRange();
  range.selectNode(img);
  const page = isScroll()
    ? Math.floor((scrollTopOfRange(range) ?? 0) / viewportHeight())
    : pageOfRange(range);
  if (page !== null) show(page, { animate: false });
  img.classList.add('fig-flash');
  setTimeout(() => img.classList.remove('fig-flash'), 1200);
}

/* ── chrome ───────────────────────────────────────────────────────────── */

const CYCLE = { full: 'copy', copy: 'none', none: 'full' };

export function cycleChrome() {
  state.chrome = CYCLE[state.chrome];
  document.body.dataset.chrome = state.chrome;
  // The column width does not change, but the viewport height does, so the
  // page count does too.
  repaginate();
  onChange(state);
  return state.chrome;
}

export function setChrome(chrome) {
  state.chrome = chrome;
  document.body.dataset.chrome = chrome;
}

/* ── copy ─────────────────────────────────────────────────────────────── */

/**
 * Flatten footnotes to inline brackets, drop image placeholders, keep
 * paragraph breaks, normalise whitespace. What lands on the clipboard should
 * be readable prose, not a DOM dump.
 */
export function chapterText(index = state.chapterIndex) {
  const chapter = state.chapters.find((c) => c.index === index);
  if (!chapter) return '';
  const holder = document.createElement('div');
  holder.innerHTML = chapter.html;

  for (const sup of holder.querySelectorAll('sup')) {
    sup.replaceWith(document.createTextNode(` [${sup.textContent.trim()}]`));
  }
  for (const img of holder.querySelectorAll('img')) img.remove();

  const blocks = [];
  for (const node of holder.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, pre')) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n');
}

export async function copyChapter() {
  const text = chapterText();
  if (!text) return { ok: false, words: 0 };
  try {
    // A secure origin, so the async clipboard is available. execCommand is the
    // fallback for older WebViews, which are common on Android 8 devices.
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else legacyCopy(text);
    return { ok: true, words: countWords(text, state.book?.lang) };
  } catch {
    try { legacyCopy(text); return { ok: true, words: countWords(text, state.book?.lang) }; }
    catch { return { ok: false, words: 0 }; }
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/* ── persistence and the reading log ──────────────────────────────────── */

function save() {
  if (!state.book) return;
  store.queuePosition({
    bookId: state.book.id,
    chapterIndex: state.chapterIndex,
    anchor: state.anchor,
    page: state.page,
    pageInBook: pageInBook(),
    totalPages: state.totalPages,
    percent: percent(),
    updatedAt: Date.now(),
  });
}

const IDLE_MS = 3 * 60 * 1000;
const FLUSH_EVERY_PAGES = 25;

function startSession() {
  session = {
    start: Date.now(), last: Date.now(), active: 0, pages: 0, words: 0,
    // The furthest point reached so far, so re-reading is not counted twice.
    furthest: pageInBook(),
  };
}

/**
 * Record a page turn.
 *
 * Time and pages are counted differently on purpose. Flipping back to re-read
 * a paragraph is reading, so the clock keeps running whichever way you go.
 * But pages and words are *progress*, and counting every turn meant going
 * back and forth in one chapter inflated the stats indefinitely -- the number
 * went up for doing nothing. Only ground you have not already covered this
 * session counts.
 */
function countPage() {
  if (!session) return;
  const now = Date.now();
  // A gap longer than three minutes is stripped rather than counted.
  const gap = now - session.last;
  if (gap < IDLE_MS) session.active += gap;
  session.last = now;

  const reached = pageInBook();
  if (reached <= session.furthest) return;

  const advanced = reached - session.furthest;
  session.furthest = reached;
  session.pages += advanced;

  const chapter = state.chapters.find((c) => c.index === state.chapterIndex);
  if (chapter && state.pageCount) {
    session.words += Math.round(((chapter.words || 0) / state.pageCount) * advanced);
  }

  // Long reads should survive being killed by the system, not vanish.
  if (session.pages >= FLUSH_EVERY_PAGES) flushSession();
}

/** Called when the reader is left, so a closed book holds nothing open. */
export function releaseImages() {
  releaseAllSections();
  state.images = new Map();
}

/**
 * Write what has been read so far to the log and reset the counters.
 *
 * This used to happen only on pagehide, which meant the stats page showed
 * nothing until the app had been closed and reopened -- you could read for an
 * hour, open Stats, and see the same numbers as before you started. Flushing
 * on every exit from the reader, and periodically while reading, makes the
 * page reflect the session you are actually in.
 */
export async function flushSession() {
  if (!session || !state.book) return;
  if (session.pages <= 0 && session.active <= 0) return;

  const done = session;
  // Replaced rather than nulled, so reading continues to accumulate against a
  // fresh window and nothing is counted twice.
  session = {
    start: Date.now(), last: done.last, active: 0, pages: 0, words: 0,
    furthest: done.furthest,
  };

  await store.recordEvent({
    bookId: state.book.id,
    activeMs: done.active,
    pages: done.pages,
    words: done.words,
    lang: state.book.lang,
  });
}

export async function endSession() {
  await store.flushPosition();
  await flushSession();
  session = null;
}

export async function pauseSession() {
  if (session) session.last = Date.now();
  await store.flushPosition();
  await flushSession();
}
