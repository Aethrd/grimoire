/* The reader.
 *
 * Pagination is CSS multi-column: the flow is laid out in columns exactly one
 * viewport wide, and turning a page translates it sideways by exactly that
 * width. No per-word measuring, no reflow on every turn.
 *
 * Position is stored as a character offset into the chapter, never as a page
 * number. Pages are a function of type size, margins and screen width, all of
 * which change; the offset does not. Every re-pagination re-derives the page
 * from the anchor, which is why changing the font size does not lose someone's
 * place.
 */

import * as store from './store.js';
import { countWords } from './parse.js';

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
};

let viewport, flow, session = null, onChange = () => {};

export function init(handlers) {
  viewport = el('page-viewport');
  flow = el('page-flow');
  onChange = handlers.onChange || (() => {});
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

function relayout() {
  const gap = pageWidth() - contentWidth();
  flow.style.columnWidth = `${contentWidth()}px`;
  flow.style.columnGap = `${gap}px`;
  // n columns measure n*w + (n-1)*gap, so invert that rather than dividing.
  const total = flow.scrollWidth + gap;
  state.pageCount = Math.max(1, Math.round(total / (contentWidth() + gap)));
}

function show(page) {
  state.page = Math.max(0, Math.min(page, state.pageCount - 1));
  flow.style.transform = `translateX(${-state.page * pageWidth()}px)`;
  state.anchor = anchorAtPage(state.page);
  save();
  onChange(state);
}

/* ── anchors ──────────────────────────────────────────────────────────── */

function textNodes() {
  const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: offset, length: node.nodeValue.length });
    offset += node.nodeValue.length;
  }
  return nodes;
}

/** Column index a DOM range currently sits in. */
function pageOfRange(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const origin = viewport.getBoundingClientRect().left;
  const x = rect.left - origin + state.page * pageWidth();
  return Math.floor(x / pageWidth());
}

function anchorAtPage(page) {
  const nodes = textNodes();
  for (const entry of nodes) {
    const range = document.createRange();
    range.setStart(entry.node, 0);
    range.setEnd(entry.node, Math.min(1, entry.length));
    if (pageOfRange(range) >= page) return entry.start;
  }
  return 0;
}

function pageAtAnchor(anchor) {
  const nodes = textNodes();
  for (const entry of nodes) {
    if (anchor >= entry.start && anchor <= entry.start + entry.length) {
      const range = document.createRange();
      const offset = Math.min(anchor - entry.start, entry.length);
      range.setStart(entry.node, offset);
      range.setEnd(entry.node, Math.min(offset + 1, entry.length));
      const page = pageOfRange(range);
      if (page !== null) return page;
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
  state.layout = await store.layoutFor(bookId);
  applyLayout(state.layout);

  const saved = await store.get('positions', bookId);
  const chapterIndex = opts.chapter ?? saved?.chapterIndex ?? 0;
  const anchor = opts.anchor ?? (opts.chapter != null ? 0 : saved?.anchor ?? 0);

  await loadChapter(chapterIndex, anchor);
  startSession();
  return book;
}

export async function loadChapter(index, anchor = 0) {
  const chapter = state.chapters[Math.max(0, Math.min(index, state.chapters.length - 1))];
  if (!chapter) return;
  state.chapterIndex = chapter.index;
  flow.innerHTML = chapter.html;
  flow.style.transform = 'translateX(0)';

  // Images decode asynchronously and change the column count when they land,
  // so wait for them before measuring or the page count is wrong on arrival.
  await imagesSettled();
  relayout();
  estimateTotals();
  show(pageAtAnchor(anchor));
}

function imagesSettled() {
  const images = [...flow.querySelectorAll('img')];
  if (!images.length) return Promise.resolve();
  return Promise.all(images.map((img) => (img.complete ? Promise.resolve()
    : new Promise((res) => { img.onload = img.onerror = res; }))));
}

/**
 * Book-level page numbers. Only the open chapter is truly paginated; the rest
 * are estimated from their word counts against the current chapter's density.
 * The estimate is re-derived every time a chapter is opened, so the number
 * converges as someone reads rather than being wrong in a fixed way.
 */
function estimateTotals() {
  const current = state.chapters.find((c) => c.index === state.chapterIndex);
  const density = current && current.words ? current.words / state.pageCount : 280;
  let running = 0;
  state.pagesBefore = [];
  for (const chapter of state.chapters) {
    state.pagesBefore[chapter.index] = running;
    running += chapter.index === state.chapterIndex
      ? state.pageCount
      : Math.max(1, Math.round((chapter.words || 0) / density) || 1);
  }
  state.totalPages = Math.max(1, running);
}

export function pageInBook() {
  return (state.pagesBefore[state.chapterIndex] || 0) + state.page + 1;
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
}

/** Re-flow at the current anchor, so the reader never jumps. */
export function repaginate() {
  if (!state.book) return;
  const anchor = state.anchor;
  requestAnimationFrame(() => {
    relayout();
    estimateTotals();
    show(pageAtAnchor(anchor));
  });
}

/* ── navigation ───────────────────────────────────────────────────────── */

export function turn(delta) {
  const next = state.page + delta;
  if (next < 0) return prevChapter(true);
  if (next >= state.pageCount) return nextChapter();
  countPage();
  show(next);
}

export function goToPage(page) { show(page); }

export async function nextChapter() {
  if (state.chapterIndex >= state.chapters.length - 1) return;
  countPage();
  await loadChapter(state.chapterIndex + 1, 0);
}

export async function prevChapter(toEnd = false) {
  if (state.chapterIndex <= 0) return;
  countPage();
  await loadChapter(state.chapterIndex - 1, 0);
  if (toEnd) show(state.pageCount - 1);
}

export async function goTo({ chapter, anchor = 0, flash = false }) {
  await loadChapter(chapter, anchor);
  if (flash) flashAt(anchor);
}

/** Return from the image reel and mark the figure once, then leave it alone. */
function flashAt(anchor) {
  const nodes = textNodes();
  const entry = nodes.find((n) => anchor >= n.start && anchor <= n.start + n.length);
  const target = (entry?.node.parentElement || flow).closest('figure, p, img') || flow.firstElementChild;
  if (!target) return;
  target.classList.add('fig-flash');
  setTimeout(() => target.classList.remove('fig-flash'), 1200);
}

export function flashImage(href) {
  const img = flow.querySelector(`img[src="${CSS.escape(href)}"]`);
  if (!img) return;
  const page = pageOfRange(rangeAround(img));
  if (page !== null) show(page);
  img.classList.add('fig-flash');
  setTimeout(() => img.classList.remove('fig-flash'), 1200);
}

function rangeAround(node) {
  const r = document.createRange();
  r.selectNode(node);
  return r;
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

function startSession() {
  session = { start: Date.now(), last: Date.now(), active: 0, pages: 0, words: 0 };
}

function countPage() {
  if (!session) return;
  const now = Date.now();
  // Time only counts while someone is actually turning pages; a gap longer
  // than three minutes is stripped rather than counted as reading.
  const gap = now - session.last;
  if (gap < IDLE_MS) session.active += gap;
  session.last = now;
  session.pages += 1;
  const chapter = state.chapters.find((c) => c.index === state.chapterIndex);
  if (chapter && state.pageCount) session.words += Math.round((chapter.words || 0) / state.pageCount);
}

export async function endSession() {
  if (!session || !state.book) return;
  const s = session;
  session = null;
  await store.flushPosition();
  await store.recordEvent({
    bookId: state.book.id,
    activeMs: s.active,
    pages: s.pages,
    words: s.words,
    lang: state.book.lang,
  });
}

export function pauseSession() {
  if (session) session.last = Date.now();
  store.flushPosition();
}
