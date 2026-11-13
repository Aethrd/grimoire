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
import { countWords, chapterHtml, spacedByLines } from './parse.js';
import { pool } from './blobs.js';
import * as translate from './translate.js';
import * as frames from './frame.js';

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

  markDensity: 'full',
  mergeMarks: true,

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
let scrubbing = false;

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
  await store.saveSettings({ readingMode: mode });
  // The stylesheet needs to know before anything is drawn in the new mode.
  document.body.dataset.mode = mode;
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
  store.saveSettings({ endlessScroll: on });
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

/**
 * The height of a page, for pictures to be sized against.
 *
 * The page, not the screen: with the reader's bars showing the page is a good
 * deal shorter than the screen, and with them hidden it is nearly all of it.
 * A picture sized against the screen was either cut off by the bars or left
 * a band of empty page below it.
 */
function measurePage() {
  const cs = getComputedStyle(viewport);
  const inner = viewport.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
  if (inner > 0) flow.style.setProperty('--page-h', `${Math.floor(inner)}px`);
  placeFrame(cs);
}

/* ── the picture frame ───────────────────────────────────────────────────
 *
 * Where on the screen pictures go, and what shape that is, chosen in
 * Settings by dragging its four corners. Kept as fractions of the screen so
 * it means the same thing on any phone and either way up.
 *
 * Turned into a box for each picture: its size, and how far it sits from the
 * top-left of the page it is on. The box is held to what the page can show
 * -- the screen's full width, the page's height -- and where the frame is
 * more than that it is shrunk to fit, keeping its shape.
 */
let pictureFrame = null;
let watchingTurns = false;

/** @param frame {l, t, r, b} as fractions of the screen held upright, or null. */
export function setPictureFrame(frame) {
  pictureFrame = frame && frame.r > frame.l && frame.b > frame.t ? { ...frame } : null;
  document.body.toggleAttribute('data-frame', !!pictureFrame);
  if (viewport && flow) placeFrame(getComputedStyle(viewport));
  /* Turned straight from one side to the other, the screen keeps its size and
     nothing re-flows -- but the frame has moved to the other end of it. */
  if (!watchingTurns && window.screen?.orientation?.addEventListener) {
    watchingTurns = true;
    window.screen.orientation.addEventListener('change', () => {
      if (pictureFrame && viewport && flow) placeFrame(getComputedStyle(viewport));
    });
  }
}

export const pictureFrameOf = () => pictureFrame;

function placeFrame(cs) {
  if (!pictureFrame) {
    for (const name of ['--pic-x', '--pic-y', '--pic-w', '--pic-h']) flow.style.removeProperty(name);
    return;
  }
  const box = viewport.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const screenW = window.innerWidth || box.width;
  const screenH = window.innerHeight || box.height;

  // What a picture can occupy on this page: the full width (the text's
  // margins do not apply to pictures) and the height inside the padding.
  const padTop = parseFloat(cs.paddingTop || 0);
  const padBottom = parseFloat(cs.paddingBottom || 0);
  const padLeft = parseFloat(cs.paddingLeft || 0);
  const room = { left: box.left, right: box.right, top: box.top + padTop, bottom: box.bottom - padBottom };

  // The frame belongs to the glass: turned with the phone, it is the same
  // shape on the same part of the screen, now running the other way.
  const turn = frames.screenTurn();
  const frame = frames.toScreen(pictureFrame, turn);
  // Exactly the shape that was drawn, turned: the screen is not quite the
  // same size both ways round, so the fractions alone would drift from it.
  const shape = pictureFrame.ratio ? (turn % 180 ? 1 / pictureFrame.ratio : pictureFrame.ratio) : 0;
  let { left, top, right, bottom } = frames.holdShape({
    left: frame.l * screenW, right: frame.r * screenW, top: frame.t * screenH, bottom: frame.b * screenH,
  }, shape);

  /* Where it does not fit -- the reader's bars are up, or a phone on its
     side has little height to spare -- it is made smaller, not cut down: the
     shape is what was chosen, so a 2:3 frame stays 2:3. As near to where it
     was drawn as the page allows. */
  const roomW = room.right - room.left;
  const roomH = room.bottom - room.top;
  const scale = Math.min(1, roomW / (right - left), roomH / (bottom - top));
  if (scale < 1) {
    const w = (right - left) * scale;
    const h = (bottom - top) * scale;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    left = cx - w / 2; right = cx + w / 2; top = cy - h / 2; bottom = cy + h / 2;
  }
  const shiftX = Math.max(0, room.left - left) - Math.max(0, right - room.right);
  const shiftY = Math.max(0, room.top - top) - Math.max(0, bottom - room.bottom);
  left += shiftX; right += shiftX; top += shiftY; bottom += shiftY;
  if (right - left < 20 || bottom - top < 20) return;

  flow.style.setProperty('--pic-x', `${Math.round(left - (box.left + padLeft))}px`);
  flow.style.setProperty('--pic-y', `${Math.round(top - room.top)}px`);
  flow.style.setProperty('--pic-w', `${Math.floor(right - left)}px`);
  flow.style.setProperty('--pic-h', `${Math.floor(bottom - top)}px`);
  indentPictures();
}

/* How far in from the page's edge each picture's container starts.
 *
 * The frame is measured from the edge of the page, but a picture is laid out
 * inside whatever holds it: a figure (every comic page is one) is indented by
 * the browser, a quotation by its rule, a list by its bullets. Without taking
 * that back off, a framed picture sat that far to the right of where the
 * frame was drawn and ran off the side of its page onto the next.
 *
 * Read from the containers' styles rather than measured from the layout,
 * because in paged mode the layout is in columns and a position on screen
 * says as much about which page a picture is on as where on it. */
function indentPictures(root = flow) {
  if (!pictureFrame || !root) return;
  for (const pic of root.querySelectorAll('.pic')) {
    let indent = 0;
    for (let node = pic.parentElement; node && node !== flow; node = node.parentElement) {
      const style = getComputedStyle(node);
      indent += (parseFloat(style.marginLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0)
        + (parseFloat(style.paddingLeft) || 0);
    }
    if (indent) pic.style.setProperty('--pic-in', `${Math.round(indent)}px`);
    else pic.style.removeProperty('--pic-in');
    markLead(pic);
  }
}

/* The containers a framed picture opens.
 *
 * A picture starts a page of its own, and whatever it is the first thing in
 * -- the figure round every comic page, a paragraph, the chapter -- starts
 * with it. Their top spacing then lands either at the top of the picture's
 * page, pushing it below the frame and off the bottom, or just before the
 * page break, where the browser took it as reason enough to leave a whole
 * page empty. So those containers are marked, and lose their top spacing
 * while a frame is in use. */
function markLead(pic) {
  const lead = !!pictureFrame && !pic.classList.contains('small');
  let child = pic;
  for (let node = pic.parentElement; node && node !== flow; node = node.parentElement) {
    if (!lead || !opens(node, child)) {
      if (!node.classList.contains('pic-lead')) break;
      node.classList.remove('pic-lead');
    } else {
      node.classList.add('pic-lead');
    }
    child = node;
  }
}

/** Whether nothing comes before `child` inside `node` -- no words, no element. */
function opens(node, child) {
  for (let before = child.previousSibling; before; before = before.previousSibling) {
    if (before.nodeType === Node.ELEMENT_NODE) return false;
    if (before.nodeType === Node.TEXT_NODE && before.nodeValue.trim()) return false;
  }
  return true;
}

function relayout() {
  measurePage();
  if (isScroll()) {
    flow.style.columnWidth = '';
    flow.style.columnGap = '';
    // "Pages" stay meaningful in scroll mode so the counters and the scrub
    // rail keep working: one page is one screenful.
    state.pageCount = Math.max(1, Math.ceil(viewport.scrollHeight / viewportHeight()));
    return;
  }
  const width = contentWidth();

  /* A page cannot be measured while there is nothing to measure.
   *
   * Showing or hiding the chrome re-flows the text, and for a frame or two
   * during that the flow has no width. Measured then, a chapter of forty
   * pages comes back as one -- and the position, being clamped to what exists,
   * lands on page one. That is why a tap in the middle of the screen sent the
   * reader back to the beginning: not a lost position, a lost measurement.
   *
   * Keeping the previous count until there is something to measure is right
   * either way. It is still correct if the width has not really changed, and
   * the next re-flow corrects it if it has.
   */
  if (width <= 0) return;

  const gap = pageWidth() - width;
  flow.style.columnWidth = `${width}px`;
  flow.style.columnGap = `${gap}px`;
  // n columns measure n*w + (n-1)*gap, so invert that rather than dividing.
  const total = flow.scrollWidth + gap;
  if (total <= 0) return;

  const count = Math.round(total / (width + gap));
  if (Number.isFinite(count) && count > 0) state.pageCount = count;
}

/** Suppress the turn animation around a jump that is not a page turn. */
function withoutMotion(fn) {
  flow.classList.add('no-motion');
  fn();
  // Two frames: one for the style to apply, one for it to have taken effect.
  requestAnimationFrame(() => requestAnimationFrame(() => flow.classList.remove('no-motion')));
}

function show(page, { animate = true, keepAnchor = false } = {}) {
  // A page count that has not measured yet would otherwise clamp every
  // arrival to "the last page" of a one-page chapter.
  const pages = Number.isFinite(state.pageCount) && state.pageCount > 0
    ? state.pageCount : 1;
  state.page = Math.max(0, Math.min(Number.isFinite(page) ? page : 0, pages - 1));

  if (isScroll()) {
    viewport.scrollTo({
      top: state.page * viewportHeight(),
      behavior: animate && !reducedMotion() ? 'smooth' : 'auto',
    });
  } else {
    const move = () => { flow.style.transform = `translateX(${-state.page * pageWidth()}px)`; };
    if (animate) move(); else withoutMotion(move);
  }

  /* A re-flow keeps the place it was given rather than taking the top of the
   * new page as the place. Taken from the top, every re-flow moved it back to
   * wherever the page now began -- and showing and hiding the bars, which
   * re-flows each time, walked the reader backwards a part-page per tap. */
  if (!keepAnchor) state.anchor = currentAnchor();
  save();
  onChange(state);
}

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/* ── chapters in the DOM ──────────────────────────────────────────────── */

function sectionFor(index) {
  return flow.querySelector(`[data-chapter="${index}"]`);
}

/* ── annotations ──────────────────────────────────────────────────────── */

export const MARK_STYLES = [
  ['highlight', 'Highlight'],
  ['underline', 'Underline'],
  ['double', 'Double underline'],
  ['wavy', 'Wavy underline'],
  ['box', 'Box'],
];

export const MARK_COLOURS = [
  ['yellow', '#e8c14a'], ['green', '#5aa469'], ['blue', '#5b8fd6'],
  ['pink', '#d4779b'], ['purple', '#9b7bd4'],
];

/** Marks for the open book, by chapter. Loaded with the book. */
let marksByChapter = new Map();

export async function reloadMarks() {
  marksByChapter = new Map();
  if (!state.book) return;
  for (const mark of await store.byIndex('marks', 'bookId', state.book.id)) {
    if (mark.kind !== 'highlight') continue;
    if (!marksByChapter.has(mark.chapterIndex)) marksByChapter.set(mark.chapterIndex, []);
    marksByChapter.get(mark.chapterIndex).push(mark);
  }
  for (const [, list] of marksByChapter) list.sort((a, b) => a.anchor - b.anchor);
}

/**
 * Wrap the marked ranges in the rendered chapter.
 *
 * Anchors are character offsets into the chapter, the same ones the reader
 * uses to keep a place, so a mark survives a change of type size, a switch
 * between paged and scrolling, and a re-import of the same book.
 */
function paintMarks(section, chapterIndex) {
  const marks = marksByChapter.get(chapterIndex);
  if (!marks?.length || state.markDensity === 'hidden') return;

  for (const mark of marks) {
    const nodes = textNodes(section);
    const range = document.createRange();
    const from = nodes.find((n) => mark.anchor >= n.start && mark.anchor < n.start + n.length);
    const to = nodes.find((n) => mark.end > n.start && mark.end <= n.start + n.length);
    if (!from || !to) continue;

    try {
      range.setStart(from.node, mark.anchor - from.start);
      range.setEnd(to.node, mark.end - to.start);
    } catch {
      continue;      // the text moved under it; skip rather than throw
    }

    const wrap = document.createElement('mark');
    wrap.className = `hl hl-${mark.style || 'highlight'} hl-${mark.colour || 'yellow'}`;
    wrap.dataset.mark = String(mark.id);
    if (mark.note) wrap.dataset.note = mark.note;

    try {
      // surroundContents fails across element boundaries, which a highlight
      // spanning two paragraphs does. Falling back to wrapping each text node
      // in the range keeps those working rather than dropping them.
      range.surroundContents(wrap);
    } catch {
      wrapPiecewise(range, mark);
    }
  }
}

/** A highlight that crosses elements becomes one wrapper per text node. */
function wrapPiecewise(range, mark) {
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  const pieces = [];
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) pieces.push(node);
  }
  for (const piece of pieces) {
    const slice = document.createRange();
    slice.selectNodeContents(piece);
    if (piece === range.startContainer) slice.setStart(piece, range.startOffset);
    if (piece === range.endContainer) slice.setEnd(piece, range.endOffset);
    if (slice.collapsed) continue;
    const wrap = document.createElement('mark');
    wrap.className = `hl hl-${mark.style || 'highlight'} hl-${mark.colour || 'yellow'}`;
    wrap.dataset.mark = String(mark.id);
    if (mark.note) wrap.dataset.note = mark.note;
    try { slice.surroundContents(wrap); } catch { /* leave that piece plain */ }
  }
}

/**
 * Where the current selection sits, as offsets into the chapter.
 *
 * Returns null when there is no selection or it lies outside the text, so a
 * stray tap on the chrome cannot produce a mark over nothing.
 */
export function selectionRange() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  const section = sectionFor(state.chapterIndex);
  if (!section || !section.contains(range.commonAncestorContainer)) return null;

  const nodes = textNodes(section);
  const at = (node, offset) => {
    const entry = nodes.find((n) => n.node === node);
    return entry ? entry.start + offset : null;
  };
  const start = at(range.startContainer, range.startOffset);
  const end = at(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;

  return {
    chapterIndex: state.chapterIndex,
    anchor: start,
    end,
    text: selection.toString().replace(/\s+/g, ' ').trim(),
    rect: range.getBoundingClientRect(),
  };
}

function chapterSection(chapter) {
  const section = document.createElement('section');
  section.className = 'chapter';
  section.dataset.chapter = String(chapter.index);
  const html = chapterHtml(chapter);
  section.innerHTML = html;
  // Its blank lines its spacing (see spacedByLines): no gap after each line, nor an indent added.
  if (spacedByLines(html)) section.classList.add('lines');
  flattenLayoutIndents(section);
  hydrateImages(section, chapter.index);
  paintMarks(section, chapter.index);
  return section;
}

/**
 * The book's own margins, taken out, so the reader's are the only ones.
 *
 * A book's stylesheet is dropped at import, but some of its margins are not
 * in the stylesheet: they are in the markup. A Kindle book in particular
 * indents by wrapping the text in quotation blocks -- the whole chapter in
 * one, or two, nested -- and a list of definitions indents its every entry
 * by the browser's default. Each of those added its own band of space inside
 * the reader's margin, so the text sat well in from where the margin said it
 * should, and narrowing the margin to nothing still left it there.
 *
 * A real quotation is a few lines. A block holding paragraph after paragraph
 * is not a quotation; it is the book's margin, and it is flattened.
 */
function flattenLayoutIndents(section) {
  for (const block of section.querySelectorAll('blockquote, dd, dl')) {
    const paragraphs = block.querySelectorAll('p, div, blockquote').length;
    const words = (block.textContent || '').length;
    if (paragraphs >= 3 || words > 700) block.classList.add('book-indent');
  }
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
    if (url) {
      img.src = url;

      /* Somewhere for a picture to be bigger than the page.
       *
       * A page in paged mode is one column of fixed width with the overflow
       * hidden, so a picture larger than it simply disappears -- which is why
       * Original, Fit height and Smart all had to be clamped back down to
       * Fit screen there, leaving four of the six settings doing the same
       * thing. Giving each picture a box of its own that can scroll means it
       * can exceed the page and still be reachable: the box stays inside the
       * column and the picture pans within it.
       */
      /* Pictures still on their way.
       *
       * Each one that arrives changes the height of the chapter, and in
       * scroll mode the reading position is derived from exactly that height
       * -- so a position recorded while they are still arriving is measured
       * against a page that is about to be a different size. On a comic that
       * is forty reflows in a row, each one moving the recorded position, and
       * it reads as the progress jumping about on its own.
       */
      if (!img.complete) {
        arriving += 1;
        if (!arrivingTimer) arrivingTimer = setTimeout(stopWaitingForPictures, 4000);
        const done = () => {
          arriving = Math.max(0, arriving - 1);
          // The last one settles the position once, properly.
          if (arriving === 0) {
            clearTimeout(arrivingTimer);
            arrivingTimer = null;
            if (isScroll()) onScrolled();
          }
        };
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }

      if (img.parentElement?.classList.contains('pic')) continue;
      const box = document.createElement('span');
      box.className = 'pic';
      img.replaceWith(box);
      box.appendChild(img);
      /* Marked once it has loaded, so the two-page-spread mode has something
         to act on. Measured here rather than at import: the cost belongs on
         the page that actually shows the picture. */
      /* The shape of a picture is only known once it has loaded, and the
         smart fitting needs it: a tall strip wants the width, a wide spread
         wants the height, and anything near square is fitted whole. */
      const shape = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return;
        img.classList.toggle('landscape', w > h * 1.2);
        img.classList.toggle('tall', h > w * 1.4);
        // Its shape, so it can be sized to fill the page whichever way it
        // runs out of room first.
        img.style.setProperty('--ar', (w / h).toFixed(4));
        // A divider or an ornament keeps its own size -- and, in a picture
        // frame, is not given a page of its own. Small both ways, or a thin
        // line of any length: a rule drawn as a picture is 600 by 30.
        const small = (w < 200 && h < 200) || Math.min(w, h) < 100;
        img.classList.toggle('small', small);
        img.parentElement?.classList.toggle('small', small);
        // One among words -- an emoji, a glyph, a little moving icon --
        // stays in its sentence instead of breaking the line round it.
        const holder = img.parentElement?.parentElement;
        // Only something the size of a letter or two: a bigger one forced
        // into a line opens a hole in the paragraph and reads worse.
        const icon = Math.max(w, h) <= 96;
        img.parentElement?.classList.toggle('in-text', icon && !!holder && /\S/.test(holder.textContent || ''));
        if (img.parentElement?.classList.contains('pic')) markLead(img.parentElement);
      };
      if (img.complete && img.naturalWidth) shape();
      else img.addEventListener('load', shape, { once: true });
    } else {
      img.remove();
    }
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

/**
 * Column index a range sits in. Paged mode only.
 *
 * Measured from the start of the flow of columns, not from the edge of the
 * screen. The two agree once a page turn has finished -- but the place is
 * recorded the moment a turn begins, while the slide is still under way and
 * the columns are still where the last page left them. Measured from the
 * screen, the new page's first line came out a page late, the place was
 * recorded as one page back (on page two of a chapter: its very start), and
 * the next re-flow -- a tap in the middle to show or hide the bars -- put the
 * reader there. The flow moves with its columns, so measured from it the
 * answer is the same whether the slide has finished or not.
 */
function pageOfRange(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const width = pageWidth();
  if (width <= 0) return null;
  const origin = flow.getBoundingClientRect().left;
  return Math.floor((rect.left - origin) / width);
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
  // Measured, or the last thing measured: never a position derived from a
  // page that is not laid out.
  if (!measurable()) return state.anchor || 0;

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

/**
 * Where an offset sits in the scrollable content, in pixels.
 *
 * Scroll mode has no pages, so rounding a position to the nearest screenful
 * is a real movement of the text -- which is what made a tap on the chrome
 * jump the page.
 */
function anchorOffset(anchor, chapterIndex = state.chapterIndex) {
  const section = sectionFor(chapterIndex);
  if (!section) return null;
  for (const entry of textNodes(section)) {
    if (anchor >= entry.start && anchor <= entry.start + entry.length) {
      const top = scrollTopOfRange(rangeAt(entry, anchor - entry.start));
      if (top !== null) return top;
    }
  }
  return null;
}

/** Which page shows a given offset in a given chapter. */
/**
 * Which page an offset is on, or null if that cannot be measured.
 *
 * Null rather than zero, and the difference matters a great deal. Every
 * caller used to take "could not measure" as "page one", so anything that
 * re-flowed the page and then asked again -- showing the chrome, hiding it,
 * a change of type size -- sent the reader back to the start of the chapter
 * whenever the measurement did not come back. A tap in the middle of the
 * screen does exactly that, every time.
 */
function pageAtAnchor(anchor, chapterIndex = state.chapterIndex) {
  const section = sectionFor(chapterIndex);
  if (!section) return null;
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
  return null;
}

/* ── loading ──────────────────────────────────────────────────────────── */

/**
 * The last book's pages taken off the screen, before another is opened.
 *
 * The reader is shown first and the book read into it after -- a page laid
 * out where it cannot be seen measures nothing -- so for that moment it
 * showed whatever was left in it: the last book's page, flashing up before
 * the new one replaced it.
 */
export function blank() {
  clearTimeout(arrivingTimer);
  arrivingTimer = null;
  arriving = 0;
  releaseAllSections();
  flow?.replaceChildren();
  if (flow) withoutMotion(() => { flow.style.transform = 'translateX(0)'; });
  if (viewport) viewport.scrollTop = 0;
}

export async function open(bookId, opts = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library');

  state.book = book;
  state.chapters = await store.byIndex('chapters', 'bookId', bookId);
  state.chapters.sort((a, b) => a.index - b.index);

  const images = (await store.byIndex('images', 'bookId', bookId))
    .filter((image) => !image.removed);
  state.images = new Map(images.filter((i) => i.blob).map((i) => [i.href, i.blob]));
  // The book and its chapters are in: its index and picture reel can be drawn (app.js, bookReady).
  opts.onBook?.(book);
  state.layout = await store.layoutFor(bookId);
  applyLayout(state.layout, await store.settings());

  const saved = await store.get('positions', bookId);
  const chapterIndex = opts.chapter ?? saved?.chapterIndex ?? 0;
  const anchor = opts.anchor ?? (opts.chapter != null ? 0 : saved?.anchor ?? 0);

  await reloadMarks();
  await loadChapter(chapterIndex, anchor);

  /* A chapter of pictures has no text to anchor to.
   *
   * Position is kept as a character offset into the chapter, which is exactly
   * right for prose and meaningless for a comic: every page is offset zero,
   * so a book of pictures always reopened at its first page however far
   * through it you were. The page number is saved alongside and is the only
   * thing that carries here.
   */
  if (opts.chapter == null && saved && !chapterHasText()) {
    const page = Number(saved.page);
    if (Number.isFinite(page) && page > 0) show(page, { animate: false });
  }

  startSession();
  loadChapterNames();     // not awaited: the book opens now, names follow
  return book;
}

export async function loadChapter(index, anchor = 0) {
  // Whatever the previous chapter was still waiting for is no longer on
  // screen, so it must not hold up the new one.
  clearTimeout(arrivingTimer);
  arrivingTimer = null;
  arriving = 0;

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
  /* Shown before the pictures arrive.
   *
   * Waiting for every image to load before painting anything meant the whole
   * reader -- title, position, chapter buttons, the keep-in-library button --
   * stayed blank until they had, and a single slow or broken picture held it
   * for the full timeout. The text is already in the document at this point;
   * only the page count needs the pictures, and that is settled below.
   */
  onChange(state);

  await imagesSettled();
  relayout();
  estimateTotals();
  // A chapter being opened does begin at its start when nothing can be
  // measured; a re-flow of the chapter already open does not.
  show(pageAtAnchor(anchor) ?? 0, { animate: false });
  if (isScroll()) extendIfNeeded();
}

function imagesSettled() {
  const images = [...flow.querySelectorAll('img')];
  if (!images.length) return Promise.resolve();

  /* Bounded. An image that fires neither load nor error -- a decode that
     stalls, a blob that went away -- would otherwise leave the chapter
     waiting forever, and a book that never opens is a worse outcome than one
     measured a moment before its pictures arrive. */
  const settled = Promise.all(images.map((img) => (img.complete ? Promise.resolve()
    : new Promise((res) => { img.onload = img.onerror = res; }))));

  return Promise.race([
    settled,
    new Promise((res) => setTimeout(res, 3000)),
  ]);
}

/** The display name for a chapter: translated if that is switched on. */
/** Whether the name shown for a chapter is a translation. */
export function isTranslatedName(index) { return state.names.has(index); }

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
      state.book.id, state.chapters, settings.translateTarget,
      translate.sourceFor(state.book, state.chapters.slice(0, 12).map((c) => c.title || '').join(' ')));
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
/** A little of a chapter's text, for telling what language it is in. */
function textSample(chapter) {
  const html = String(chapter?.html || '');
  return html.slice(0, 6000).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').slice(0, 600);
}

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
    state.book.id, chapter, settings.translateTarget,
    translate.sourceFor(state.book, `${chapter.title || ''} ${textSample(chapter)}`));

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

  /* Shown before the pictures arrive.
   *
   * Waiting for every image to load before painting anything meant the whole
   * reader -- title, position, chapter buttons, the keep-in-library button --
   * stayed blank until they had, and a single slow or broken picture held it
   * for the full timeout. The text is already in the document at this point;
   * only the page count needs the pictures, and that is settled below.
   */
  onChange(state);

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
  if (!isScroll() || !state.endless || extending || scrubbing) return;

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

/** How many of the chapter's pictures have not arrived yet. */
let arriving = 0;
let arrivingTimer = null;

/**
 * Stop waiting for pictures, whether or not they came.
 *
 * A picture that fires neither load nor error -- a decode that stalls, a blob
 * that went away -- would otherwise hold the reading position still for the
 * rest of the session, which is a worse fault than the one this is here to
 * prevent. Four seconds is long enough for a chapter of a comic to settle on
 * a slow phone and short enough not to lose a real position.
 */
function stopWaitingForPictures() {
  clearTimeout(arrivingTimer);
  arrivingTimer = null;
  if (arriving === 0) return;
  arriving = 0;
  if (isScroll()) onScrolled();
}

function onScrolled() {
  /* Not while the chapter is still growing.
   *
   * Every picture that arrives changes the height this position is measured
   * against. Waiting costs a second at the top of a chapter and saves the
   * position wandering while the page settles. */
  if (arriving > 0) return;

  /* Nothing to read from a page that is not on screen.
   *
   * A scroll settle can arrive after the reader has been hidden -- leaving
   * mid-scroll does exactly that -- and a hidden element reports a scroll
   * position of zero, which would record the top of the chapter over the
   * position just held on the way out.
   */
  if (!measurable()) return;

  const previous = state.chapterIndex;
  state.anchor = currentAnchor();
  state.page = Math.round(viewport.scrollTop / viewportHeight());
  /* Counted again when the chapter has changed size, not only when another
   * chapter is reached. The pictures of a comic are still arriving when the
   * count is first made, and a book that is one long chapter of them never
   * reaches another chapter -- so the count from opening stood all the way
   * through, and the end of the book was some pages short of its total. */
  if (state.chapterIndex !== previous || screensInChapter() !== state.measuredPages) estimateTotals();

  /* Scrolling is reading.
   *
   * This is the only thing that moves the text in scroll mode -- taps toggle
   * the chrome and nothing else -- so without it nothing recorded progress
   * there at all: no time, no pages, no words, and the book stayed Unread
   * however far you got through it. countPage only counts ground not already
   * covered, so calling it on every scroll settle costs nothing.
   */
  countPage();

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
/** Whether the chapter on screen is words or pictures. */
function chapterHasText() {
  const section = sectionFor(state.chapterIndex);
  if (!section) return true;
  return (section.textContent || '').trim().length > 0;
}

/** How many pictures a chapter holds, for books that are made of them. */
function picturesIn(chapter) {
  const html = chapter.html || chapter.source || '';
  return (html.match(/<img\b|<image\b/gi) || []).length;
}

/** How many screenfuls the open chapter is in scroll mode, as it stands now.
 *  Pictures arriving change it, so it is asked again rather than kept. */
function screensInChapter() {
  return Math.max(1, Math.ceil((sectionFor(state.chapterIndex)?.getBoundingClientRect().height || 0) / viewportHeight()));
}

function estimateTotals() {
  const current = state.chapters.find((c) => c.index === state.chapterIndex);
  const measured = isScroll() ? screensInChapter() : state.pageCount;
  state.measuredPages = measured;
  /* A book of pictures is measured in pictures.
   *
   * The estimate works from word counts, and a comic has none -- so every
   * chapter counted as one page, the total came to less than the page already
   * being read, and the percentage saturated at a hundred before the first
   * page was turned. Counting pictures gives the same shape of answer for a
   * book that has no words in it.
   */
  const byWords = state.chapters.some((c) => (c.words || 0) > 0);
  const density = current && current.words ? current.words / measured : 280;

  let running = 0;
  state.pagesBefore = [];
  for (const chapter of state.chapters) {
    state.pagesBefore[chapter.index] = running;

    if (chapter.index === state.chapterIndex) {
      running += measured;
      continue;
    }
    running += byWords
      ? Math.max(1, Math.round((chapter.words || 0) / density) || 1)
      : Math.max(1, picturesIn(chapter));
  }
  state.totalPages = Math.max(1, running);
}

export function pageInBook() {
  /* The bottom of the last chapter is the end of the book, whichever chapter
   * the top of the view is still in: a closing chapter shorter than a screen
   * never reaches the top, and the book would stop a page from its end. */
  if (isScroll() && atBottomOfBook()) return state.totalPages;
  return (state.pagesBefore[state.chapterIndex] || 0) + pageInChapter() + 1;
}

/** Scrolled as far down as what is loaded goes. */
function scrolledToEnd() {
  return viewport.clientHeight > 0
    && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
}

function atBottomOfBook() {
  const last = state.chapters.length ? state.chapters[state.chapters.length - 1].index : -1;
  // Not while pictures are still arriving: a chapter of them is short until
  // they have, and every comic would be at its end the moment it opened.
  if (arriving > 0 || !state.loaded.includes(last)) return false;
  return scrolledToEnd();
}

function pageInChapter() {
  if (!isScroll()) return state.page;
  const section = sectionFor(state.chapterIndex);
  const height = viewportHeight();
  if (!section || height <= 0) return 0;
  const screens = screensInChapter();
  const top = section.offsetTop || 0;
  /* The end of a chapter is its last page.
   *
   * The page was the screenful at the top of the view, and a chapter counted
   * as however many screens it is tall, rounded up -- so scrolled as far as
   * it goes, the top of the view was still a screen short of the end, and the
   * last page was never reached. A book of pictures read by scrolling, which
   * is often one long chapter, stopped at 97% and never became Finished. When
   * the bottom of the view is at the end of the chapter, that is its last
   * page. */
  const bottom = top + (section.offsetHeight || 0);
  const atEnd = viewport.scrollTop + viewport.clientHeight >= Math.min(bottom, viewport.scrollHeight) - 2;
  if (atEnd) return screens - 1;
  const within = Math.round(Math.max(0, viewport.scrollTop - top) / height);
  return Math.min(screens - 1, within);
}

export function percent() {
  return Math.min(1, pageInBook() / state.totalPages);
}

/* ── layout override ──────────────────────────────────────────────────── */

export function applyLayout(layout, settings) {
  state.layout = layout;
  const root = document.documentElement.style;
  root.setProperty('--read-size', `${layout.size}px`);
  root.setProperty('--read-leading', String(layout.leading));
  root.setProperty('--read-para', `${layout.para}px`);
  root.setProperty('--read-margin', `${layout.margin}px`);
  root.setProperty('--read-vmargin', `${Number.isFinite(layout.vmargin) ? layout.vmargin : 16}px`);
  root.setProperty('--read-align', layout.justified ? 'justify' : 'left');
  // Justified text needs a first-line indent or the paragraph breaks vanish.
  root.setProperty('--read-indent', layout.justified ? '1.2em' : '0');
  root.setProperty('--read-face', layout.face === 'Archivo'
    ? 'var(--font-heading)' : 'var(--font-body)');
  if (layout.ink) root.setProperty('--read-ink', layout.ink);
  else root.removeProperty('--read-ink');

  /* Reading mode comes from the settings, not the book. An older install may
     still carry it in a per-book layout row; that is honoured once so nobody
     loses the mode they had, and the setting takes over from then on. */
  state.markDensity = settings?.markDensity || 'full';
  state.mergeMarks = settings ? settings.mergeMarks !== false : true;
  document.body.dataset.marks = state.markDensity;

  /* Without the settings, the mode already showing stands. The layout sheet
     re-applies the layout on every move of a slider and passes no settings,
     and taking that as "paged" turned a book being read by scrolling into
     pages part-way through -- so the margins, the type size, everything on
     that sheet seemed not to work in scroll mode. */
  const mode = settings
    ? settings.readingMode || layout.mode || 'paged'
    : (state.book ? state.mode : layout.mode || state.mode || 'paged');
  if (settings) state.endless = settings.endlessScroll !== false;
  else if (!state.book) state.endless = layout.endless !== false;

  if (mode !== state.mode) {
    state.mode = mode;
    viewport.classList.toggle('scrolling', isScroll());
    flow.classList.toggle('scrolling', isScroll());
  }

  /* Set here, not only when the reader repaints.
   *
   * The stylesheet keeps pictures inside the column in paged mode, and it can
   * only do that if it knows which mode it is in. Before the first paint the
   * attribute was missing, so a picture wider than the column was free to
   * overflow -- and be clipped away to nothing.
   */
  document.body.dataset.mode = state.mode;
}

/** Re-flow at the current anchor, so the reader never jumps. */
export function repaginate(opts = {}) {
  if (!state.book) return;
  const anchor = state.anchor;
  const chapter = state.chapterIndex;

  if (isScroll()) {
    /* Keep the anchor exactly where it sits on screen.
     *
     * Going through pages here rounded the position to the nearest whole
     * screenful, so showing or hiding the chrome -- which changes the
     * viewport's height and re-flows the text -- moved the page under the
     * reader. Measuring how far down the view the anchor currently is, and
     * putting it back the same distance down, leaves it where it was. */
    const before = anchorOffset(anchor, chapter);
    const within = before === null ? 0 : viewport.scrollTop - before;
    /* At the end, kept at the end. A page of pictures has no words to
     * anchor to, so showing the bars -- which makes the view shorter --
     * left the last screen hanging part-way up it, and a book just finished
     * was put back on the shelf at 88%. */
    const atEnd = typeof opts.atEnd === 'boolean' ? opts.atEnd : scrolledToEnd();

    requestAnimationFrame(() => {
      relayout();
      estimateTotals();
      const after = anchorOffset(anchor, chapter);
      /* And kept where it is on the screen, not only in the view. The bar at
       * the top going moves the top of the view up; held the same distance
       * from it, the text moved up with it -- a tap to put the bars away
       * scrolled the page. Moved back by as much, nothing moves, and the
       * room gained shows more text above and below. */
      const shift = Number.isFinite(opts.viewTop) ? viewport.getBoundingClientRect().top - opts.viewTop : 0;
      if (atEnd) viewport.scrollTop = viewport.scrollHeight;
      else if (after !== null) viewport.scrollTop = Math.max(0, after + within + shift);
      state.page = Math.round(viewport.scrollTop / viewportHeight());
      // The same place, kept: see show().
      if (after === null) state.anchor = currentAnchor();
      save();
      onChange(state);
    });
    return;
  }

  requestAnimationFrame(() => {
    // A page held for the bars (holdPageAt) is let go: anything else that
    // re-flows the chapter -- a new type size, the phone turned -- wants the
    // pages as they fall.
    releaseHeldPage(sectionFor(chapter));
    relayout();
    estimateTotals();
    // Staying put is the right answer when the measurement fails: the text
    // has not moved, only the chrome around it.
    show(pageAtAnchor(anchor, chapter) ?? state.page, { animate: false, keepAnchor: true });
    keepPassageWhole(anchor, chapter);
  });
}

/**
 * Stop the passage being read from landing across a page break.
 *
 * Changing the type size re-flows everything, and the paragraph someone was
 * halfway through can end up with two lines on one page and the rest on the
 * next -- which is precisely the paragraph that should not be split, because
 * it is the one being read.
 *
 * Only that paragraph is protected, and only until the next re-flow. Applying
 * it to every paragraph is the `keepParagraphs` setting, which costs space at
 * the foot of every page; this costs nothing anywhere else.
 */
function keepPassageWhole(anchor, chapterIndex) {
  const section = sectionFor(chapterIndex);
  if (!section || isScroll()) return;

  for (const held of section.querySelectorAll('.keep-whole')) held.classList.remove('keep-whole');

  const entry = textNodes(section).find((n) => anchor >= n.start && anchor <= n.start + n.length);
  const block = entry?.node.parentElement?.closest('p, li, blockquote');
  if (!block) return;

  // Only worth doing when it is actually split: a paragraph whose top and
  // bottom sit in different columns.
  const rect = block.getBoundingClientRect();
  const width = pageWidth();
  if (width <= 0) return;
  const startsIn = Math.floor((rect.left - viewport.getBoundingClientRect().left) / width);
  const endsIn = Math.floor((rect.right - viewport.getBoundingClientRect().left - 1) / width);
  if (startsIn === endsIn) return;

  block.classList.add('keep-whole');
  // One correction, not a loop: re-flowing to fix a break can create another,
  // and chasing it would be a good way to never stop.
  relayout();
  show(pageAtAnchor(anchor, chapterIndex) ?? state.page, { animate: false, keepAnchor: true });
}

/* ── navigation ───────────────────────────────────────────────────────── */

/**
 * Move within the current chapter. Never beyond it.
 *
 * Taps and swipes stop at the chapter's edges in both modes; only the chapter
 * buttons cross that line. Turning a whole chapter is a much larger movement
 * than a page, and having the same gesture do both means doing the larger one
 * by accident every time you reach the end of a chapter.
 *
 * Returns false when it could not move, so the caller can say why rather than
 * appearing to have missed the tap.
 */
export function turn(delta) {
  if (isScroll()) {
    const step = viewportHeight() * 0.9 * delta;
    const limit = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const target = Math.max(0, Math.min(limit, viewport.scrollTop + step));
    if (Math.abs(target - viewport.scrollTop) < 1) return false;
    viewport.scrollTo({ top: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
    countPage();
    return true;
  }

  // Guarded against a page count that never measured. NaN fails every
  // comparison silently, so an unmeasured chapter would let a turn straight
  // through the check that is meant to stop it.
  const pages = Number.isFinite(state.pageCount) ? state.pageCount : 1;
  const next = state.page + delta;
  if (!Number.isFinite(next) || next < 0 || next >= pages) return false;
  // Counted after the move, not before it. Measuring first meant every turn
  // recorded the position it was leaving, so the first turn of a session
  // counted nothing and the last was never counted at all.
  show(next);
  countPage();
  return true;
}

export function goToPage(page) { show(page, { animate: false }); }

/** Whether a turn by `delta` stays inside this chapter -- the same test
 *  turn() makes, asked without moving anything. */
export function canTurn(delta) {
  if (isScroll()) {
    const limit = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    return delta > 0 ? viewport.scrollTop < limit - 1 : viewport.scrollTop > 1;
  }
  const pages = Number.isFinite(state.pageCount) ? state.pageCount : 1;
  const next = state.page + delta;
  return Number.isFinite(next) && next >= 0 && next < pages;
}

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
  if (!viewport.scrollHeight) return 1;
  // Clamped: a viewport taller than its content gives a ratio above one, and
  // a handle longer than its rail overhangs the bottom of it.
  return Math.min(1, viewport.clientHeight / viewport.scrollHeight);
}

/**
 * Held while the rail is being dragged.
 *
 * Endless scroll appends the next chapter as the end approaches, which changes
 * scrollHeight -- and a thumb positioned as a fraction of that height jumps
 * backwards the instant it does. Dragging to the bottom therefore fought
 * itself. Loading is suspended for the drag and resumes when the finger lifts.
 */
export function setScrubbing(on) {
  scrubbing = on;
  if (!on) extendIfNeeded();
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

export function hasNextChapter() { return state.chapterIndex < state.chapters.length - 1; }
export function hasPrevChapter() { return state.chapterIndex > 0; }

export async function nextChapter() {
  if (!hasNextChapter()) return false;
  noteReading();
  if (session) session.chapters += 1;
  countPage();
  // In endless mode the next chapter may already be below; scroll to it
  // rather than tearing the view down and rebuilding it.
  if (isScroll() && state.loaded.includes(state.chapterIndex + 1)) {
    const section = sectionFor(state.chapterIndex + 1);
    state.chapterIndex += 1;
    viewport.scrollTo({ top: section.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
    onChange(state);
    return true;
  }
  await loadChapter(state.chapterIndex + 1, 0);

  /* Stated, not measured.
   *
   * loadChapter works out the page from where the anchor's rectangle lands,
   * which depends on the column layout having settled. Arriving at a fresh
   * chapter it sometimes has not, and a measurement that comes back too large
   * is clamped to the last page -- so going forward landed at the end of the
   * new chapter instead of its beginning. The first page of a chapter you
   * have just moved forward into needs no measuring: it is the first page.
   */
  if (!isScroll()) show(0, { animate: false });
  return true;
}

export async function prevChapter(toEnd = false) {
  if (!hasPrevChapter()) return false;
  noteReading();
  countPage();
  if (isScroll() && state.loaded.includes(state.chapterIndex - 1)) {
    const section = sectionFor(state.chapterIndex - 1);
    state.chapterIndex -= 1;
    viewport.scrollTo({ top: section.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' });
    onChange(state);
    return true;
  }
  await loadChapter(state.chapterIndex - 1, 0);
  // Going back lands at the end of the previous chapter, which is where you
  // were reading; going back by button lands at its start.
  if (!isScroll()) show(toEnd ? state.pageCount - 1 : 0, { animate: false });
  return true;
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

/**
 * The pictures on screen now, most of the screen first.
 *
 * Measured, not worked out from the page number: in paged mode the pages
 * beside this one are laid out in columns off to the side, and in scroll mode
 * the chapters above and below are there too -- only what is actually inside
 * the viewport counts.
 */
export function picturesInView({ inOrder = false } = {}) {
  if (!viewport || !flow) return [];
  const box = viewport.getBoundingClientRect();
  const seen = new Map();
  for (const img of flow.querySelectorAll('img[data-img]')) {
    const r = img.getBoundingClientRect();
    const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
    const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
    if (w <= 0 || h <= 0) continue;
    const href = img.getAttribute('data-img');
    seen.set(href, Math.max(seen.get(href) || 0, w * h));
  }
  // Found in the order they stand in the chapter, which is the order they
  // are read in; otherwise the one taking most of the screen first.
  if (inOrder) return [...seen.keys()];
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([href]) => href);
}

/**
 * The pictures that come after the ones on screen, in the order they stand:
 * the next pages of a comic, to be read before they are reached.
 */
export function picturesAhead(count = 2) {
  if (!flow) return [];
  const all = [];
  for (const img of flow.querySelectorAll('img[data-img]')) {
    const href = img.getAttribute('data-img');
    if (!all.includes(href)) all.push(href);
  }
  const here = picturesInView({ inOrder: true });
  const last = here.length ? Math.max(...here.map((href) => all.indexOf(href))) : -1;
  return all.slice(last + 1, last + 1 + count);
}

/** Every place a picture stands in the open chapters, to draw over it. */
export function pictureElements(href) {
  if (!flow) return [];
  return [...flow.querySelectorAll('img[data-img]')].filter((img) => img.getAttribute('data-img') === href);
}

/**
 * A picture in the open book has changed -- blacked out, or put back.
 *
 * Swapped in where it already stands rather than by reloading the chapter:
 * the picture is the same size it was, so the page does not move, and a
 * reload would have lost the place on it. The old URL goes with its section's
 * pool when that section leaves; the new one joins the same pool.
 */
export function refreshPicture(bookId, href, blob) {
  if (!state.book || state.book.id !== bookId || !blob) return;
  state.images.set(href, blob);
  if (!flow) return;
  // Compared rather than put in a selector: an href is whatever the book
  // called the file, quotes and brackets included.
  for (const img of flow.querySelectorAll('img[data-img]')) {
    if (img.getAttribute('data-img') !== href) continue;
    const section = img.closest('[data-chapter]');
    const index = section ? Number(section.getAttribute('data-chapter')) : NaN;
    let urls = sectionPools.get(index);
    if (!urls) { urls = pool(); sectionPools.set(index, urls); }
    img.src = urls.url(blob);
  }
}

/* ── chrome ───────────────────────────────────────────────────────────── */

const CYCLE = { full: 'copy', copy: 'none', none: 'full' };

export function cycleChrome() {
  // Asked before the bars change the height of the view, which is the
  // question repaginate would otherwise answer after it.
  const atEnd = isScroll() && scrolledToEnd();
  const viewTop = measurable() ? viewport.getBoundingClientRect().top : null;
  const top = isScroll() ? null : topOfPage();
  state.chrome = CYCLE[state.chrome];
  document.body.dataset.chrome = state.chrome;
  // The column width does not change, but the viewport height does, so the
  // page count does too.
  if (top) holdPageAt(top);
  else repaginate({ atEnd, viewTop });
  onChange(state);
  return state.chrome;
}

/* ── the page held still while the bars come and go ──────────────────────
 *
 * Showing or hiding the bars changes how tall the page is, and every page
 * break in the chapter moves with it. Re-paginated, the page on screen was
 * whichever new page held the place -- which began a few lines earlier or
 * later than the one being read, so a tap meant to put the bars away
 * scrolled the text instead, and a second tap jumped to a different page
 * altogether.
 *
 * So the page is made to begin where it already began. The paragraph the
 * page starts in is divided at that character, and the second part is told
 * to start a new page; everything after it flows on into pages of the new
 * height. The line at the top stays at the top -- and where the bars going
 * has freed space above it, it is held down by that much on this page, so
 * nothing moves at all and the room gained shows as more text at the bottom.
 * Turn the page and the pages are full height again.
 */

const BLOCKS_SELECTOR = 'p, li, blockquote, div, h1, h2, h3, h4, h5, h6, dd, dt, pre, figcaption, td, th, figure';

/** The first character on the page and where on the screen it sits. */
function topOfPage() {
  if (!state.book || isScroll() || !measurable()) return null;
  const span = pageSpan();
  if (!span || span.end <= span.start) return null;
  // Only a page that begins with words: a page of a picture has nothing to
  // hold, and no paragraph to divide.
  let offset = span.start;
  let rect = null;
  for (; offset < Math.min(span.end, span.start + 64); offset++) {
    const entry = span.entryAt(offset);
    const box = rangeAt(entry, offset - entry.start).getBoundingClientRect();
    if (box.width || box.height) { rect = box; break; }
  }
  if (!rect || span.side(offset) !== 0) return null;
  return { chapter: span.index, offset, y: rect.top };
}

/** Undo a page held earlier: the divided paragraph made whole again. */
function releaseHeldPage(section) {
  if (!section) return;
  for (const part of [...section.querySelectorAll('.page-start')]) {
    if (part.classList.contains('continued')) {
      const whole = part.previousElementSibling;
      if (whole) {
        while (part.firstChild) whole.appendChild(part.firstChild);
        part.remove();
        whole.normalize();
        continue;
      }
      part.classList.remove('continued');
    }
    part.classList.remove('page-start');
    part.style.removeProperty('padding-top');
  }
}

/** Make the page begin at a character: see above. */
function holdPageAt(top) {
  const section = sectionFor(top.chapter);
  releaseHeldPage(section);
  const entry = section && textNodes(section).find((n) => top.offset >= n.start && top.offset < n.start + n.length);
  const block = entry?.node.parentElement?.closest(BLOCKS_SELECTOR);
  if (!block || !section.contains(block) || block === section) {
    repaginate();
    return;
  }

  // At the very start of its paragraph, the paragraph itself starts the page.
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(entry.node, top.offset - entry.start);
  let starts = block;
  if (before.toString().trim()) {
    const rest = document.createRange();
    rest.setStart(entry.node, top.offset - entry.start);
    rest.setEnd(block, block.childNodes.length);
    const part = block.cloneNode(false);
    part.removeAttribute('id');
    part.classList.add('continued');
    part.appendChild(rest.extractContents());
    block.after(part);
    starts = part;
  }
  starts.classList.add('page-start');

  /* The page the held character is on, asked of the character itself. The
   * text it is in now begins exactly there, and asking by offset would find
   * the end of the text before it -- on the page before. */
  const pageOfHeld = () => {
    const held = textNodes(section).find((n) => top.offset >= n.start && top.offset < n.start + n.length);
    return held ? pageOfRange(rangeAt(held, top.offset - held.start)) : null;
  };
  const settle = () => {
    relayout();
    estimateTotals();
    show(pageOfHeld() ?? state.page, { animate: false, keepAnchor: true });
  };
  settle();

  // Held down by however far the top of the page moved up, so the line
  // stays where the eye left it.
  const now = topOfPage();
  const lift = now && now.offset === top.offset ? Math.round(top.y - now.y) : 0;
  if (lift > 0) {
    starts.style.paddingTop = `${lift}px`;
    settle();
  }
  state.anchor = top.offset;
  save();
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
  holder.innerHTML = chapterHtml(chapter);
  return plainText(holder);
}

/** Elements that begin a new block of text: what a paragraph break is made of. */
const BLOCKS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL',
  'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'FIGURE', 'FIGCAPTION', 'HR',
]);

/**
 * The words in some markup, a paragraph to a paragraph, as copying wants
 * them: footnote marks kept as [1], pictures left out.
 *
 * Read in order, the whole of it. This used to collect only paragraphs,
 * headings, list items and quotations -- so a book that sets its text in
 * plain blocks, or as lines with breaks between them, as a great many web
 * novels do, copied its chapter heading and nothing else. And a quotation
 * holding paragraphs was copied twice, once whole and once a paragraph at a
 * time. Now every piece of text is taken once, where it stands, and the
 * breaks between blocks -- and blank lines made of line breaks -- are the
 * paragraph breaks.
 */
function plainText(holder) {
  for (const sup of holder.querySelectorAll('sup')) {
    sup.replaceWith(document.createTextNode(` [${sup.textContent.trim()}]`));
  }
  for (const img of holder.querySelectorAll('img')) img.remove();

  const blocks = [];
  let line = '';
  const flush = () => {
    // A single line break inside a block is kept as one; two or more, a
    // paragraph break.
    for (const part of line.split(/\n[ \t]*\n[\s]*/)) {
      const text = part.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
      if (text) blocks.push(text);
    }
    line = '';
  };
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) { line += child.nodeValue.replace(/\n/g, ' '); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === 'BR') { line += '\n'; continue; }
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      if (BLOCKS.has(tag)) { flush(); walk(child); flush(); } else walk(child);
    }
  };
  walk(holder);
  flush();
  return blocks.join('\n\n');
}

export async function copyChapter() {
  return copyText(chapterText(), { finishes: true });
}

/**
 * Where the page on screen begins and ends, as character offsets into its
 * chapter: the first character on it, and the first after it.
 *
 * Worked out from the page itself rather than from the chapter's source:
 * where a page begins and ends is a matter of layout. Each character's box is
 * asked which page it is on, and the first and last on this one are found by
 * halving -- a few dozen measurements, not one per character.
 */
function pageSpan() {
  if (!measurable()) return null;
  const index = isScroll() ? chapterAtViewport() : state.chapterIndex;
  const section = sectionFor(index);
  if (!section) return null;
  const nodes = textNodes(section).filter((entry) => entry.length);
  if (!nodes.length) return null;
  const last = nodes[nodes.length - 1];
  const total = last.start + last.length;

  const entryAt = (offset) => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    return nodes[lo];
  };
  const box = viewport.getBoundingClientRect();
  // Before this page (-1), on it (0), after it (1); null for a character
  // with no box, such as a space the layout folded away.
  const side = (offset) => {
    const entry = entryAt(offset);
    const range = rangeAt(entry, offset - entry.start);
    if (isScroll()) {
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      // A line cut off at either edge belongs to the screen it is whole on.
      if (rect.top < box.top - 1) return -1;
      if (rect.bottom > box.bottom + 1) return 1;
      return 0;
    }
    const page = pageOfRange(range);
    if (page === null) return null;
    return page < state.page ? -1 : page > state.page ? 1 : 0;
  };
  const sideNear = (offset) => {
    for (let at = offset; at < Math.min(total, offset + 64); at++) {
      const found = side(at);
      if (found !== null) return found;
    }
    return 1;
  };
  const firstWhere = (test) => {
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(sideNear(mid))) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
  const start = firstWhere((where) => where >= 0);
  const end = firstWhere((where) => where > 0);
  return { index, section, nodes, entryAt, side, start, end, total, last };
}

/**
 * The text on the page being read -- what is on screen, cut where the page
 * cuts it, so a paragraph running on to the next page is copied up to the
 * edge and the rest goes with the next page.
 */
export function pageText() {
  const span = pageSpan();
  if (!span) return '';
  const { start, end, total, last, entryAt } = span;
  if (end <= start) return '';

  const range = document.createRange();
  const from = entryAt(start);
  range.setStart(from.node, start - from.start);
  if (end >= total) range.setEnd(last.node, last.length);
  else {
    const to = entryAt(end);
    range.setEnd(to.node, end - to.start);
  }
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  return plainText(holder);
}

/** Whether the page being read is the chapter's last. */
function onLastPage() {
  if (isScroll()) {
    const section = sectionFor(chapterAtViewport());
    if (!section) return false;
    return viewport.scrollTop + viewport.clientHeight >= section.offsetTop + section.offsetHeight - 2;
  }
  return state.page >= state.pageCount - 1;
}

export async function copyPage() {
  return copyText(pageText(), { finishes: onLastPage() });
}

/* Copying half a chapter: the half being read -- and pressed again without
 * moving on, the next half, so a chapter can be copied out in two goes from
 * wherever it was begun. */
let lastHalf = null;

/** The chapter in two, split between paragraphs as near the middle as it goes. */
export function chapterHalves(index = state.chapterIndex) {
  const text = chapterText(index);
  if (!text) return ['', ''];
  const blocks = text.split('\n\n');
  if (blocks.length < 2) {
    // One long paragraph: split at the sentence nearest the middle.
    const middle = Math.floor(text.length / 2);
    const after = text.slice(middle).search(/[.!?。！？]\s/);
    const at = after === -1 ? middle : middle + after + 1;
    return [text.slice(0, at).trim(), text.slice(at).trim()];
  }
  let running = 0;
  let split = 1;
  for (let i = 0; i < blocks.length; i++) {
    running += blocks[i].length + 2;   // and the break after it
    if (running >= text.length / 2) { split = Math.max(1, Math.min(blocks.length - 1, i + 1)); break; }
  }
  return [blocks.slice(0, split).join('\n\n'), blocks.slice(split).join('\n\n')];
}

export async function copyHalf() {
  const halves = chapterHalves();
  const anchor = state.anchor || 0;
  const section = sectionFor(state.chapterIndex);
  const length = section ? (section.textContent || '').length : 0;
  let half = length && anchor / length >= 0.5 ? 1 : 0;
  const book = state.book?.id;
  if (lastHalf && lastHalf.book === book && lastHalf.chapter === state.chapterIndex
    && lastHalf.anchor === anchor && lastHalf.half === 0) half = 1;
  const result = await copyText(halves[half], { finishes: half === 1 });
  if (result.ok) lastHalf = { book, chapter: state.chapterIndex, anchor, half };
  return { ...result, half };
}

/** Onto the clipboard, and counted as read where it is read: elsewhere. */
async function copyText(text, { finishes = false } = {}) {
  if (!text) return { ok: false, words: 0, empty: true };
  try {
    // A secure origin, so the async clipboard is available. execCommand is the
    // fallback for older WebViews, which are common on Android 8 devices.
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else legacyCopy(text);
  } catch {
    try { legacyCopy(text); } catch { return { ok: false, words: 0 }; }
  }
  const words = countWords(text, state.book?.lang);
  await recordCopiedChapter(words, finishes ? 1 : 0);
  return { ok: true, words };
}

/* ── the progress bar: anywhere in the book ───────────────────────────── */

/**
 * Where a point along the progress bar falls: which chapter, how far into it,
 * and which page of the book.
 *
 * The bar shows the whole book, so dragging it moves through the whole book.
 * Pages beyond the chapter open are estimates -- from the words in each
 * chapter, at the density of the one being read -- so the page a drag lands
 * on can be a page or two off what it said, and the bar settles on the real
 * number once the chapter is open.
 */
export function bookPlace(fraction) {
  if (!state.chapters.length) return null;
  const total = Math.max(1, state.totalPages || 1);
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));

  /* The chapter is found by words, not by page estimates.
   *
   * The estimates are rescaled to the density of whichever chapter is open,
   * so a point chosen against one chapter's estimates was somewhere else by
   * the estimates of the chapter it opened -- a tap at 15% landed at 10%.
   * Words do not move, and they are what the percentage is made of once the
   * chapter is open. A book of pictures is measured in pictures, as the
   * estimates are. */
  const byWords = state.chapters.some((c) => (c.words || 0) > 0);
  const weights = state.chapters.map((c) => (byWords
    ? Math.max(1, c.words || 0) : Math.max(1, picturesIn(c))));
  const sum = weights.reduce((n, w) => n + w, 0);
  const goal = f * sum;
  let at = state.chapters.length - 1;
  let before = 0;
  for (let i = 0; i < weights.length; i++) {
    if (before + weights[i] >= goal) { at = i; break; }
    before += weights[i];
  }
  const chapter = state.chapters[at];
  return {
    position: at,
    chapterIndex: chapter.index,
    within: Math.max(0, Math.min(1, (goal - before) / weights[at])),
    page: Math.max(1, Math.min(total, Math.round(f * total) || 1)),
    total,
    name: chapterName(chapter.index),
  };
}

export async function goToBookFraction(fraction) {
  const place = bookPlace(fraction);
  if (!place) return null;
  if (!sectionFor(place.chapterIndex)) await loadChapter(place.position, 0);
  if (isScroll()) {
    const section = sectionFor(place.chapterIndex);
    if (section) {
      const span = Math.max(0, section.offsetHeight - viewport.clientHeight);
      viewport.scrollTop = section.offsetTop + place.within * span;
      state.chapterIndex = place.chapterIndex;
      state.anchor = currentAnchor();
      save();
      onChange(state);
    }
  } else {
    show(Math.round(place.within * Math.max(0, state.pageCount - 1)), { animate: false });
  }
  return place;
}

/**
 * A chapter copied out is a chapter read.
 *
 * Reading happens elsewhere often enough to matter: the text is copied into a
 * translator or another app and read there. None of that comes back as page
 * turns, so time and pages say a reader did almost nothing on a day they got
 * through six chapters. The words are what actually happened, so they are
 * recorded, marked as read away from the app, and counted separately where
 * the distinction matters.
 */
async function recordCopiedChapter(words, chapters = 1) {
  if (!state.book || !words) return;
  noteReading();
  await store.recordEvent({
    bookId: state.book.id,
    activeMs: 0,
    pages: 0,
    words,
    // A chapter is counted when what was copied reaches its end.
    chapters,
    elsewhere: true,
    lang: state.book.lang,
  });
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
    start: Date.now(), last: Date.now(), active: 0, pages: 0, words: 0, chapters: 0,
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
/**
 * This is being read, not merely looked at.
 *
 * Separate from counting pages because moving by chapter is plainly reading
 * even though it credits no pages -- jumping to chapter five does not mean
 * chapters one to four were read.
 */
/** A status was just set by hand: the next page read is reading again, even
 *  in a session that has already been noted as reading. */
export function noteStatusSet(bookId) {
  if (session && state.book?.id === bookId) session.marked = false;
}

function noteReading() {
  if (!session || session.marked || !state.book) return;
  session.marked = true;
  store.markRead(state.book.id);
}

function countPage() {
  if (!session) return;
  const now = Date.now();
  // A gap longer than three minutes is stripped rather than counted.
  const gap = now - session.last;
  if (gap < IDLE_MS) session.active += gap;
  session.last = now;

  const reached = pageInBook();
  if (reached <= session.furthest) return;

  noteReading();

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
    start: Date.now(), last: done.last, active: 0, pages: 0, words: 0, chapters: 0,
    furthest: done.furthest,
  };

  await store.recordEvent({
    bookId: state.book.id,
    activeMs: done.active,
    pages: done.pages,
    words: done.words,
    chapters: done.chapters,
    elsewhere: false,
    lang: state.book.lang,
  });
}

export async function endSession() {
  await store.flushPosition();
  await flushSession();
  session = null;
}

/**
 * Take the reading position now, while the page can still be measured.
 *
 * Called by the shell on the way out of the reader. Scrolling settles on a
 * timer, so leaving straight after a scroll could otherwise flush a position
 * from before it -- and once the screen is hidden nothing can be measured at
 * all, because a hidden element reports a scroll position of zero.
 */
export function holdPosition() {
  if (!state.book || !measurable()) return;
  state.anchor = currentAnchor();
  if (isScroll()) state.page = Math.round(viewport.scrollTop / viewportHeight());
  save();
}

/** Whether the page is laid out, and so whether anything can be measured. */
function measurable() {
  return viewport && viewport.clientHeight > 0;
}

export async function pauseSession() {
  if (session) session.last = Date.now();
  await store.flushPosition();
  await flushSession();
}

/** Marks that touch or overlap, close enough to be one. */
const MERGE_GAP = 8;

/**
 * An existing mark the selection falls entirely inside.
 *
 * Used to offer a split rather than a second mark on top of the first, which
 * would leave two overlapping ranges saying different things about the same
 * words.
 */
export function markAround({ chapterIndex, anchor, end }) {
  const marks = marksByChapter.get(chapterIndex) || [];
  return marks.find((m) => anchor >= m.anchor && end <= m.end
    && !(anchor === m.anchor && end === m.end)) || null;
}

/**
 * Any mark the selection touches, whether or not it covers it exactly.
 *
 * markAround only answers for a selection strictly inside a mark, which is
 * the case for splitting one. Removing one wants the looser question: is
 * there a mark here at all.
 */
export function markAt({ chapterIndex, anchor, end }) {
  const marks = marksByChapter.get(chapterIndex) || [];
  const found = marks.find((m) => anchor < m.end && end > m.anchor);
  if (!found) return null;
  return { ...found, exact: anchor >= found.anchor && end <= found.end };
}

/**
 * Take a phrase out of a longer mark and give it its own.
 *
 * The remainder stays as it was, in up to two pieces. Splitting a paragraph's
 * worth of highlight to pick out one sentence is otherwise a matter of
 * deleting the lot and redoing it by hand.
 */
export async function splitMark(mark, { anchor, end }, style, colour, note) {
  await removeMark(mark.id);

  const pieces = [];
  if (anchor - mark.anchor > 1) {
    pieces.push({ anchor: mark.anchor, end: anchor, style: mark.style, colour: mark.colour, note: mark.note });
  }
  pieces.push({ anchor, end, style, colour, note: note || null });
  if (mark.end - end > 1) {
    pieces.push({ anchor: end, end: mark.end, style: mark.style, colour: mark.colour, note: mark.note });
  }

  const made = [];
  for (const piece of pieces) {
    made.push(await storeMark({
      chapterIndex: mark.chapterIndex,
      anchor: piece.anchor,
      end: piece.end,
      text: null,
    }, piece.style, piece.colour, piece.note, { merge: false }));
  }
  repaintChapter();
  return made;
}

/** Record a highlight over a selection, and show it immediately. */
export async function addMark(selection, style, colour, note, options = {}) {
  const mark = await storeMark(selection, style, colour, note, options);
  repaintChapter();
  return mark;
}

async function storeMark({ chapterIndex, anchor, end, text }, style, colour, note, options = {}) {
  const mark = {
    bookId: state.book.id,
    kind: 'highlight',
    chapterIndex, anchor, end, text,
    style, colour,
    note: note || null,
    at: Date.now(),
  };
  /* Two marks that touch become one.
   *
   * Marking a sentence, then the next, then the next leaves three ranges that
   * are really one passage -- and they render with seams between them where
   * the gap falls. Only marks that agree on style and colour are joined:
   * differing ones are saying different things and should stay apart. */
  if (options.merge !== false && state.mergeMarks) {
    const neighbours = (marksByChapter.get(chapterIndex) || []).filter((m) =>
      m.style === style && m.colour === colour
      && anchor - MERGE_GAP <= m.end && end + MERGE_GAP >= m.anchor);

    if (neighbours.length) {
      mark.anchor = Math.min(mark.anchor, ...neighbours.map((m) => m.anchor));
      mark.end = Math.max(mark.end, ...neighbours.map((m) => m.end));
      // A note on either survives the join rather than being thrown away.
      mark.note = mark.note || neighbours.map((m) => m.note).filter(Boolean).join(' · ') || null;
      for (const gone of neighbours) {
        await store.del('marks', gone.id);
        const list = marksByChapter.get(chapterIndex);
        list.splice(list.indexOf(gone), 1);
      }
    }
  }

  mark.id = await store.add('marks', mark);

  if (!marksByChapter.has(chapterIndex)) marksByChapter.set(chapterIndex, []);
  marksByChapter.get(chapterIndex).push(mark);
  marksByChapter.get(chapterIndex).sort((a, b) => a.anchor - b.anchor);
  return mark;
}

/** A few words from around an offset, to say what a pin is a pin of. */
export function excerptAt(anchor, length = 60) {
  const section = sectionFor(state.chapterIndex);
  if (!section) return null;
  const text = section.textContent || '';
  return text.slice(anchor, anchor + length).replace(/\s+/g, ' ').trim() || null;
}

/** Every mark in the book, in reading order. */
export function marksInOrder() {
  return [...marksByChapter.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, list]) => list);
}

/**
 * Step to the mark before or after the one given, wherever it is in the book.
 *
 * The point is to move between them without leaving the page for a list and
 * losing the thread of what they were about.
 */
export async function stepToMark(fromId, delta) {
  const all = marksInOrder();
  if (!all.length) return null;
  const at = all.findIndex((m) => m.id === fromId);
  const next = all[(at === -1 ? 0 : at + delta + all.length) % all.length];
  if (!next) return null;

  if (next.chapterIndex !== state.chapterIndex) {
    await loadChapter(next.chapterIndex, next.anchor);
  } else {
    show(pageAtAnchor(next.anchor, next.chapterIndex) ?? state.page, { animate: false });
  }
  return next;
}

/** Remove one, by id. */
export async function removeMark(id) {
  await store.del('marks', id);
  for (const [, list] of marksByChapter) {
    const at = list.findIndex((m) => m.id === id);
    if (at !== -1) list.splice(at, 1);
  }
  repaintChapter();
}

export const markById = (id) => {
  for (const [, list] of marksByChapter) {
    const found = list.find((m) => m.id === id);
    if (found) return found;
  }
  return null;
};

/** How loud annotations are, from every one to none at all. */
export async function setMarkDensity(density) {
  state.markDensity = density;
  document.body.dataset.marks = density;
  await store.saveSettings({ markDensity: density });
  repaintChapter();
}

/** Re-render the open chapter in place, keeping the reader's position. */
function repaintChapter() {
  const anchor = state.anchor;
  const chapter = state.chapters.find((c) => c.index === state.chapterIndex);
  if (!chapter) return;

  releaseSection(chapter.index);
  const section = chapterSection(chapter);
  const existing = sectionFor(chapter.index);
  if (existing) existing.replaceWith(section);
  else flow.replaceChildren(section);

  relayout();
  // Repainting in place: the marks changed, the position did not.
  show(pageAtAnchor(anchor, chapter.index) ?? state.page, { animate: false });
}
