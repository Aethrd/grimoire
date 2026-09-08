/* Screens that hang off a book: sort, layout, reel, find, index. */

import * as store from './store.js';
import * as reader from './reader.js';
import * as library from './library.js';
import { SORT_KEYS, GROUP_LEVELS, MAX_GROUP_DEPTH, sortSummary, sortBooks, groupBooks, vaultUnlocked } from './library.js';
import { pool, measure } from './blobs.js';

const el = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── SCR-02 Sort & group ──────────────────────────────────────────────── */

let draft = null;

export async function openSort() {
  const settings = await store.settings();
  // The draft is a copy: applying commits it, backing out discards it.
  draft = JSON.parse(JSON.stringify(settings.sort));
  renderSort();
}

function renderSort() {
  const keys = el('sort-keys');
  keys.innerHTML = '';
  draft.keys.forEach(([key, dir], i) => {
    const li = document.createElement('li');
    // Priority is the order of this list, so it has to be movable in both
    // directions -- a promote-only control makes demoting a key a matter of
    // promoting everything else past it.
    li.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="name">${SORT_KEYS[key]}</span>
      <span class="move">
        <button class="up" ${i === 0 ? 'disabled' : ''} aria-label="Higher priority">↑</button>
        <button class="down" ${i === draft.keys.length - 1 ? 'disabled' : ''} aria-label="Lower priority">↓</button>
      </span>
      <button class="dir">${dir === 'desc' ? 'DESC' : 'ASC'}</button>
      <button class="drop" aria-label="Remove">✕</button>`;

    const swap = (a, b) => {
      [draft.keys[a], draft.keys[b]] = [draft.keys[b], draft.keys[a]];
      renderSort();
    };
    li.querySelector('.up').onclick = () => { if (i > 0) swap(i, i - 1); };
    li.querySelector('.down').onclick = () => {
      if (i < draft.keys.length - 1) swap(i, i + 1);
    };
    // Direction is per key and independent of every other key.
    li.querySelector('.dir').onclick = () => {
      draft.keys[i][1] = dir === 'desc' ? 'asc' : 'desc';
      renderSort();
    };
    li.querySelector('.drop').onclick = () => { draft.keys.splice(i, 1); renderSort(); };
    keys.appendChild(li);
  });

  const pool = el('sort-pool');
  pool.innerHTML = '';
  for (const [key, label] of Object.entries(SORT_KEYS)) {
    if (draft.keys.some(([k]) => k === key)) continue;
    const chip = document.createElement('button');
    chip.className = 'chip dashed';
    chip.textContent = `+ ${label}`;
    // Added at the top, not the bottom. Appending it put the key you just
    // asked to sort by behind every existing one, where it changed nothing
    // visible unless the leading keys happened to tie -- which reads exactly
    // like sorting being broken.
    chip.onclick = () => { draft.keys.unshift([key, 'asc']); renderSort(); };
    pool.appendChild(chip);
  }

  const levels = el('group-levels');
  levels.innerHTML = '';
  for (const [key, label] of Object.entries(GROUP_LEVELS)) {
    const chip = document.createElement('button');
    const on = draft.group.includes(key);
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', String(on));
    chip.textContent = on ? `${draft.group.indexOf(key) + 1}. ${label}` : label;
    chip.onclick = () => {
      if (on) draft.group = draft.group.filter((g) => g !== key);
      // Depth is refused at the picker rather than silently truncated later.
      else if (draft.group.length >= MAX_GROUP_DEPTH) return toast(`Grouping stops at ${MAX_GROUP_DEPTH} levels`);
      else draft.group.push(key);
      renderSort();
    };
    levels.appendChild(chip);
  }

  previewTree();
}

async function previewTree() {
  const all = (await store.all('books')).filter((b) => !b.inVault || vaultUnlocked);
  const tree = groupBooks(sortBooks(all, draft.keys), draft.group);
  const host = el('group-preview');
  host.innerHTML = '';
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const row = document.createElement('div');
      if (depth) row.className = `d${depth}`;
      row.innerHTML = `<span>${escape(node.label)}</span><span>${node.count}</span>`;
      host.appendChild(row);
      if (node.children.length && depth < 2) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
}

export async function applySort() {
  await store.saveSettings({ sort: draft });
  return draft;
}

export async function saveAsView() {
  const name = prompt('Name this view');
  if (!name) return null;
  await store.add('views', { name, rules: JSON.parse(JSON.stringify(draft)) });
  return name;
}

/* ── SCR-05 Layout override ───────────────────────────────────────────── */

const RANGES = {
  size: [13, 30, 1, 'px'],
  leading: [1.1, 2.6, 0.05, ''],
  para: [0, 44, 1, 'px'],
  margin: [8, 64, 1, 'px'],
};

const LABELS = {
  size: 'Font size', leading: 'Line spacing',
  para: 'Paragraph spacing', margin: 'Side margins',
};

export async function openLayout(bookId) {
  const layout = await store.layoutFor(bookId);
  // Reading mode lives here rather than in the layout: it applies to every
  // book, not to the one in front of you.
  const settings = await store.settings();
  const body = el('layout-body');
  body.innerHTML = '';

  // Reading mode first: it changes what every control below means.
  const modeField = document.createElement('div');
  modeField.className = 'field';
  modeField.innerHTML = '<label><span>Reading mode</span></label>';
  const modeSeg = document.createElement('div');
  modeSeg.className = 'seg';
  for (const [value, label] of [['paged', 'Paged'], ['scroll', 'Scroll']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String(settings.readingMode === value));
    button.onclick = async () => {
      // Saved by setMode, and applied everywhere: choosing how to read is a
      // habit, not a property of the book in front of you. Switching rebuilds
      // the view; the anchor carries the place across, so you land on the
      // same sentence either way.
      await reader.setMode(value);
      openLayout(bookId);
    };
    modeSeg.appendChild(button);
  }
  modeField.appendChild(modeSeg);
  body.appendChild(modeField);

  if (settings.readingMode === 'scroll') {
    const endless = document.createElement('div');
    endless.className = 'row';
    endless.innerHTML = `<div class="row-text"><b>Endless scroll</b>
      <small>Run straight into the next chapter instead of stopping at the end of one.
      Chapters load as you reach them and are dropped again once well behind you.</small></div>`;
    const sw = document.createElement('button');
    sw.className = 'switch';
    sw.setAttribute('aria-pressed', String(settings.endlessScroll !== false));
    sw.onclick = async () => {
      const on = sw.getAttribute('aria-pressed') !== 'true';
      sw.setAttribute('aria-pressed', String(on));
      reader.setEndless(on);
    };
    endless.appendChild(sw);
    body.appendChild(endless);
  }

  const faces = document.createElement('div');
  faces.innerHTML = '<p class="eyebrow">Face</p>';
  const faceRow = document.createElement('div');
  faceRow.className = 'chip-row wrap';
  for (const [face, family] of [['Newsreader', 'var(--font-body)'], ['Archivo', 'var(--font-heading)']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.fontFamily = family;      // each chip is set in its own face
    chip.style.textTransform = 'none';
    chip.textContent = face;
    chip.setAttribute('aria-pressed', String(layout.face === face));
    chip.onclick = async () => {
      const next = await store.saveLayout(bookId, { face });
      reader.applyLayout(next);
      reader.repaginate();
      openLayout(bookId);
    };
    faceRow.appendChild(chip);
  }
  faces.appendChild(faceRow);
  body.appendChild(faces);

  for (const [key, [min, max, step, unit]] of Object.entries(RANGES)) {
    const field = document.createElement('label');
    field.className = 'field';
    field.innerHTML = `<label><span>${LABELS[key]}</span><span>${layout[key]}${unit}</span></label>`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: layout[key] });
    // The page behind re-flows live on every move, at the current anchor.
    input.oninput = async () => {
      const next = await store.saveLayout(bookId, { [key]: parseFloat(input.value) });
      field.querySelector('label span:last-child').textContent = `${next[key]}${unit}`;
      reader.applyLayout(next);
      reader.repaginate();
    };
    field.appendChild(input);
    body.appendChild(field);
  }

  const align = document.createElement('div');
  align.className = 'field';
  align.innerHTML = '<label><span>Alignment</span></label>';
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [label, justified] of [['Flush left', false], ['Justified', true]]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String(layout.justified === justified));
    button.onclick = async () => {
      const next = await store.saveLayout(bookId, { justified });
      reader.applyLayout(next);
      reader.repaginate();
      openLayout(bookId);
    };
    seg.appendChild(button);
  }
  align.appendChild(seg);
  body.appendChild(align);

  const ink = document.createElement('div');
  ink.className = 'field';
  ink.innerHTML = '<label><span>Ink</span><small class="muted">From the theme ramp</small></label>';
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  const steps = ['', '--accent-900', '--accent-700', '--accent-600', '--accent-400'];
  for (const step of steps) {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.style.background = step ? `var(${step})` : 'var(--text)';
    button.setAttribute('aria-pressed', String((layout.ink || '') === step));
    button.onclick = async () => {
      const value = step ? getComputedStyle(document.documentElement).getPropertyValue(step).trim() : null;
      const next = await store.saveLayout(bookId, { ink: value });
      reader.applyLayout(next);
      openLayout(bookId);
    };
    swatches.appendChild(button);
  }
  ink.appendChild(swatches);
  body.appendChild(ink);
}

/* ── SCR-06 Image reel ────────────────────────────────────────────────── */

let reelFilter = 'all';

/* The reel rebuilds wholesale on every filter change, so its URLs are
   released and re-minted with it. */
const reelUrls = pool();

export async function openReel(bookId, onJump) {
  const settings = await store.settings();
  const images = (await store.byIndex('images', 'bookId', bookId)).sort((a, b) => a.order - b.order);

  // Dimensions are not recorded at import -- decoding a whole book's artwork
  // to fill in two numbers is minutes nobody asked for. They are measured
  // here instead, once, and written back.
  const unmeasured = images.filter((i) => i.blob && !i.width);
  if (unmeasured.length) {
    for (const image of unmeasured) {
      const dims = await measure(image.blob);
      image.width = dims.width;
      image.height = dims.height;
    }
    await store.putAll('images', unmeasured);
  }
  const stills = images.filter((i) => !i.animated).length;

  el('reel-counts').textContent = `${stills} stills · ${images.length - stills} animated`;

  const filters = el('reel-filters');
  filters.innerHTML = '';
  for (const [key, label] of [['all', 'All'], ['still', 'Stills'], ['animated', 'Animated']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(reelFilter === key));
    chip.onclick = () => { reelFilter = key; openReel(bookId, onJump); };
    filters.appendChild(chip);
  }

  const grid = el('reel-grid');
  reelUrls.release();
  grid.innerHTML = '<div class="reel-grid"></div>';
  const inner = grid.firstElementChild;

  // The threshold hides decorative rules and spacer pixels rather than
  // padding the reel with things nobody wants to look at.
  const visible = images.filter((image) => {
    if (Math.max(image.width, image.height) < settings.imageThreshold) return false;
    if (reelFilter === 'still') return !image.animated;
    if (reelFilter === 'animated') return image.animated;
    return true;
  });

  if (!visible.length) {
    grid.innerHTML = '<p class="muted" style="padding:24px 0">No images in this book.</p>';
    return;
  }

  for (const image of visible) {
    const url = reelUrls.url(image.blob);
    if (!url) continue;   // imported before blobs were stored; nothing to show
    const figure = document.createElement('figure');
    figure.className = 'reel-item';
    figure.innerHTML = `
      ${image.animated ? '<span class="gif">GIF</span>' : ''}
      <img src="${url}" alt="" loading="lazy">
      <figcaption>Ch. ${image.chapterIndex + 1} · ${image.width}×${image.height}</figcaption>`;
    figure.querySelector('img').onclick = () => viewer(url, image, () => onJump(image));
    inner.appendChild(figure);
  }
}

function viewer(url, image, onGo) {
  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.innerHTML = `
    <img src="${url}" alt="">
    <div class="viewer-bar">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn ghost" data-share>Share</button>
      <button class="btn primary" data-go>Go to page</button>
    </div>`;
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  overlay.querySelector('[data-go]').onclick = () => { overlay.remove(); onGo(); };
  overlay.querySelector('[data-share]').onclick = () => {
    // The shell exposes a share intent; there is no web share in a WebView.
    window.GrimoireNative?.shareText?.(`Image from ${reader.state.book?.title || 'a book'}`);
  };
  document.body.appendChild(overlay);
}

/* ── SCR-07 Find in book ──────────────────────────────────────────────── */

let findScope = 'book';
/** Shelf search: everything, or narrowed to one field. */
let shelfScope = 'all';
let matches = [];
let matchCursor = 0;
let findTimer = null;
const MAX_HITS = 500;

const foldDiacritics = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function initFind(onGoToMatch, fromReader = false) {
  const input = el('find-input');
  // Told, not inferred: the reader keeps its book so reading can be resumed.
  const inBook = fromReader && !!reader.state.book;

  /* Opening the screen resets it.
   *
   * initFind runs on every visit, but it only ever re-registered handlers --
   * so the field still held the last query while the list below it showed
   * that query's results from whatever was open at the time. Coming from the
   * shelf it starts empty; inside a book the query and the stepper's place
   * are kept, which is the point of being able to dismiss and come back. */
  if (!inBook) {
    input.value = '';
    matches = [];
    matchCursor = 0;
    el('find-results').innerHTML =
      '<p class="muted" style="padding:20px 16px">Search your library by title or author.</p>';
    el('find-stepper').hidden = true;
  }

  // The keyboard should be up: the screen exists to be typed into.
  requestAnimationFrame(() => input.focus());

  input.oninput = () => {
    // Debounced: typing should not run the whole book on every keystroke.
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(input.value, onGoToMatch), 250);
  };

  /* The scopes depend on what is being searched. Whole book and this chapter
     mean nothing over a shelf; titles and authors mean nothing inside a book.
     Chapter names sit inside, where they are a way of finding a chapter
     without scrolling the index. */
  const scope = el('find-scope');
  scope.innerHTML = '';
  scope.hidden = false;

  const options = inBook
    ? [['book', 'Whole book'], ['chapter', 'This chapter'],
       ['names', 'Chapter names'], ['marked', 'Bookmarked']]
    : [['all', 'Everything'], ['title', 'Titles'], ['author', 'Authors']];
  const selected = () => (inBook ? findScope : shelfScope);

  for (const [key, label] of options) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(selected() === key));
    chip.onclick = () => {
      if (inBook) findScope = key; else shelfScope = key;
      for (const other of scope.children) {
        other.setAttribute('aria-pressed', String(other === chip));
      }
      runFind(input.value, onGoToMatch);
    };
    scope.appendChild(chip);
  }

  // The stepper keeps its place when the panel is dismissed and reopened.
  el('find-prev').onclick = () => step(-1, onGoToMatch);
  el('find-next').onclick = () => step(1, onGoToMatch);
}

function step(delta, onGoToMatch) {
  if (!matches.length) return;
  matchCursor = (matchCursor + delta + matches.length) % matches.length;
  el('find-count').textContent = `${matchCursor + 1} of ${matches.length}`;
  onGoToMatch(matches[matchCursor]);
}

async function runFind(query, onGoToMatch) {
  const results = el('find-results');
  const stepper = el('find-stepper');
  matches = [];
  matchCursor = 0;

  const needle = foldDiacritics(query.trim());
  if (needle.length < 2) {
    results.innerHTML = '<p class="muted" style="padding:20px 16px">Type at least two characters.</p>';
    stepper.hidden = true;
    return;
  }

  // No book open: search the shelf by title and author instead of the text.
  if (!reader.state.book) {
    // The same books the shelf shows: nothing from the vault while it is
    // locked, and nothing still being imported.
    const books = (await store.all('books'))
      .filter((b) => !b.importing && (!b.inVault || vaultUnlocked));
    // Both the book's own title and the translated one shown on the shelf:
    // searching for what is on screen should find it.
    const titleMatches = (b) => foldDiacritics(b.title).includes(needle)
      || foldDiacritics(library.displayTitle(b)).includes(needle);
    const authorMatches = (b) => foldDiacritics(b.author || '').includes(needle);

    const hits = books.filter((b) => {
      if (shelfScope === 'title') return titleMatches(b);
      if (shelfScope === 'author') return authorMatches(b);
      return titleMatches(b) || authorMatches(b);
    });
    results.innerHTML = hits.length ? '' : '<p class="muted" style="padding:20px 16px">Nothing found.</p>';
    for (const book of hits) {
      const row = document.createElement('button');
      row.className = 'list-row';
      row.innerHTML = `<span class="body"><b>${escape(library.displayTitle(book))}</b>`
        + `<small>${escape(book.author || '')}</small></span>`;
      row.onclick = () => onGoToMatch({ bookId: book.id });
      results.appendChild(row);
    }
    stepper.hidden = true;
    return;
  }

  /* Chapter names. A book of a thousand chapters is not something you find
     your way around by scrolling the index. */
  if (findScope === 'names') {
    const hits = reader.state.chapters.filter((c) =>
      foldDiacritics(reader.chapterName(c.index)).includes(needle)
      || foldDiacritics(c.title || '').includes(needle));

    results.innerHTML = hits.length ? ''
      : '<p class="muted" style="padding:20px 16px">No chapter with that in its name.</p>';
    for (const chapter of hits) {
      const row = document.createElement('button');
      row.className = 'list-row';
      row.innerHTML = `<span class="body"><b>${escape(reader.chapterName(chapter.index))}</b>`
        + `<small>Chapter ${chapter.index + 1}</small></span>`;
      row.onclick = () => onGoToMatch({ chapter: chapter.index, anchor: 0 });
      results.appendChild(row);
    }
    stepper.hidden = true;
    return;
  }

  const chapters = reader.state.chapters.filter((c) => {
    if (findScope === 'chapter') return c.index === reader.state.chapterIndex;
    return true;
  });

  let markedChapters = null;
  if (findScope === 'marked') {
    const marks = await store.byIndex('marks', 'bookId', reader.state.book.id);
    markedChapters = new Set(marks.map((m) => m.chapterIndex));
  }

  const grouped = [];
  for (const chapter of chapters) {
    if (markedChapters && !markedChapters.has(chapter.index)) continue;
    const text = plainText(chapter.html);
    const folded = foldDiacritics(text);
    const hits = [];
    let from = 0;
    while (matches.length < MAX_HITS) {
      const at = folded.indexOf(needle, from);
      if (at === -1) break;
      const hit = {
        chapter: chapter.index,
        chapterTitle: chapter.title,
        anchor: at,
        snippet: snippetAt(text, at, query.trim().length),
      };
      hits.push(hit);
      matches.push(hit);
      from = at + needle.length;
    }
    if (hits.length) grouped.push({ chapter, hits });
  }

  results.innerHTML = '';
  if (!grouped.length) {
    results.innerHTML = '<p class="muted" style="padding:20px 16px">Nothing found.</p>';
    stepper.hidden = true;
    return;
  }

  for (const group of grouped) {
    const head = document.createElement('div');
    head.className = 'list-head';
    head.innerHTML = `<span>${escape(group.chapter.title)}</span><span>${group.hits.length}</span>`;
    results.appendChild(head);
    for (const hit of group.hits) {
      const row = document.createElement('button');
      row.className = 'list-row';
      row.innerHTML = `<span class="body"><small>${hit.snippet}</small></span>`;
      // Tapping a hit goes there and keeps the list behind it.
      row.onclick = () => { matchCursor = matches.indexOf(hit); onGoToMatch(hit); };
      results.appendChild(row);
    }
  }

  stepper.hidden = false;
  el('find-count').textContent = matches.length >= MAX_HITS
    ? `${MAX_HITS}+ — refine your search`
    : `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
}

function plainText(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return holder.textContent;
}

function snippetAt(text, at, length) {
  const start = Math.max(0, at - 46);
  const end = Math.min(text.length, at + length + 46);
  const before = escape(text.slice(start, at));
  const hit = escape(text.slice(at, at + length));
  const after = escape(text.slice(at + length, end));
  return `${start ? '…' : ''}${before}<mark>${hit}</mark>${after}${end < text.length ? '…' : ''}`;
}

/* ── SCR-08 Index & marks ─────────────────────────────────────────────── */

let tocTab = 'chapters';

/**
 * Put the chapter being read at the top of the index.
 *
 * The list is rebuilt on every open but the container is not, so it kept
 * whatever offset the last book left behind -- open the index on chapter 50
 * of one book and then on another, and you land at 50 there too. Scrolling to
 * the current chapter is both per-book by definition and the place you
 * actually want: an index that opens at chapter 1 when you are a hundred in
 * is no more use than one that opens at someone else's chapter 50.
 */
function revealCurrentChapter(list) {
  const current = list.querySelector('.list-row.current');
  if (!current) { list.scrollTop = 0; return; }
  // A couple of rows of lead-in, so it reads as a position in a list rather
  // than the list starting there.
  list.scrollTop = Math.max(0, current.offsetTop - list.clientHeight / 3);
}

export async function openToc(onGoToChapter) {
  const book = reader.state.book;
  const list = el('toc-list');
  const tabs = el('toc-tabs');

  if (!book) {
    el('toc-source').textContent = '';
    tabs.innerHTML = '';
    list.innerHTML = '<p class="muted" style="padding:24px 16px">Open a book to see its index and marks.</p>';
    return;
  }

  // Say where the index came from: a real TOC, headings, or nothing at all.
  el('toc-source').textContent = `Built from ${book.tocSource || 'the file structure'}`;

  const marks = await store.byIndex('marks', 'bookId', book.id);
  const bookmarks = marks.filter((m) => m.kind === 'bookmark');
  const highlights = marks.filter((m) => m.kind === 'highlight');

  tabs.innerHTML = '';
  const counts = { chapters: reader.state.chapters.length, bookmarks: bookmarks.length, highlights: highlights.length };
  for (const [key, label] of [['chapters', 'Chapters'], ['bookmarks', 'Bookmarks'], ['highlights', 'Highlights']]) {
    const button = document.createElement('button');
    button.textContent = `${label} ${counts[key]}`;
    button.setAttribute('aria-pressed', String(tocTab === key));
    button.onclick = () => { tocTab = key; openToc(onGoToChapter); };
    tabs.appendChild(button);
  }

  list.innerHTML = '';

  if (tocTab === 'chapters') {
    for (const chapter of reader.state.chapters) {
      const row = document.createElement('button');
      row.className = `list-row${chapter.index === reader.state.chapterIndex ? ' current' : ''}`;
      const status = chapter.index < reader.state.chapterIndex ? 'Read'
        : chapter.index === reader.state.chapterIndex ? 'Reading' : 'Unread';
      const markCount = marks.filter((m) => m.chapterIndex === chapter.index).length;
      row.innerHTML = `
        <span class="lead">${chapter.index + 1}</span>
        <span class="body"><b class="${reader.isTranslatedName(chapter.index) ? 'translated-text' : ''}">${escape(reader.chapterName(chapter.index))}</b>
          <small>${status}${markCount ? ` · ${markCount} mark${markCount === 1 ? '' : 's'}` : ''}</small></span>
        <span class="trail">p. ${(reader.state.pagesBefore[chapter.index] || 0) + 1}</span>`;
      row.onclick = () => onGoToChapter({ chapter: chapter.index });
      list.appendChild(row);
    }
    revealCurrentChapter(list);
    return;
  }

  list.scrollTop = 0;

  // Bookmarks and highlights are the same list filtered, so a mark is always
  // reachable from one screen.
  const rows = (tocTab === 'bookmarks' ? bookmarks : highlights)
    .sort((a, b) => a.chapterIndex - b.chapterIndex || a.anchor - b.anchor);

  if (!rows.length) {
    list.innerHTML = `<p class="muted" style="padding:24px 16px">No ${tocTab} yet.</p>`;
    return;
  }

  for (const mark of rows) {
    const chapter = reader.state.chapters.find((c) => c.index === mark.chapterIndex);
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <span class="body"><b class="${chapter && reader.isTranslatedName(chapter.index) ? 'translated-text' : ''}">${escape(chapter ? reader.chapterName(chapter.index) : 'Chapter')}</b>
        <small>${escape(mark.excerpt || 'Bookmark')}</small></span>
      <button class="trail" data-del>✕</button>`;
    row.onclick = (e) => {
      if (e.target.dataset.del !== undefined) return;
      onGoToChapter({ chapter: mark.chapterIndex, anchor: mark.anchor });
    };
    row.querySelector('[data-del]').onclick = async () => {
      await store.deleteMark(mark.id);
      openToc(onGoToChapter);
      toast('Mark deleted');
    };
    list.appendChild(row);
  }
}

/* ── shared ───────────────────────────────────────────────────────────── */

let toastTimer = null;

export function toast(message, ms = 2200) {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}
