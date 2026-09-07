/* Screens that hang off a book: sort, layout, reel, find, index. */

import * as store from './store.js';
import * as reader from './reader.js';
import { SORT_KEYS, GROUP_LEVELS, MAX_GROUP_DEPTH, sortSummary, sortBooks, groupBooks, vaultUnlocked } from './library.js';

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
    li.innerHTML = `
      <span class="grab">⠿</span>
      <span class="name">${SORT_KEYS[key]}</span>
      <button class="dir">${dir === 'desc' ? 'DESC' : 'ASC'}</button>
      <button class="drop">✕</button>`;
    // Direction is per key and independent of every other key.
    li.querySelector('.dir').onclick = () => {
      draft.keys[i][1] = dir === 'desc' ? 'asc' : 'desc';
      renderSort();
    };
    li.querySelector('.drop').onclick = () => { draft.keys.splice(i, 1); renderSort(); };
    li.querySelector('.grab').onclick = () => {
      if (i === 0) return;
      [draft.keys[i - 1], draft.keys[i]] = [draft.keys[i], draft.keys[i - 1]];
      renderSort();
    };
    keys.appendChild(li);
  });

  const pool = el('sort-pool');
  pool.innerHTML = '';
  for (const [key, label] of Object.entries(SORT_KEYS)) {
    if (draft.keys.some(([k]) => k === key)) continue;
    const chip = document.createElement('button');
    chip.className = 'chip dashed';
    chip.textContent = `+ ${label}`;
    chip.onclick = () => { draft.keys.push([key, 'asc']); renderSort(); };
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
  const body = el('layout-body');
  body.innerHTML = '';

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

export async function openReel(bookId, onJump) {
  const settings = await store.settings();
  const images = (await store.byIndex('images', 'bookId', bookId)).sort((a, b) => a.order - b.order);
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
    const figure = document.createElement('figure');
    figure.className = 'reel-item';
    figure.innerHTML = `
      ${image.animated ? '<span class="gif">GIF</span>' : ''}
      <img src="${image.url}" alt="" loading="lazy">
      <figcaption>Ch. ${image.chapterIndex + 1} · ${image.width}×${image.height}</figcaption>`;
    figure.querySelector('img').onclick = () => viewer(image, () => onJump(image));
    inner.appendChild(figure);
  }
}

function viewer(image, onGo) {
  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.innerHTML = `
    <img src="${image.url}" alt="">
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
let matches = [];
let matchCursor = 0;
let findTimer = null;
const MAX_HITS = 500;

const foldDiacritics = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function initFind(onGoToMatch) {
  const input = el('find-input');

  input.oninput = () => {
    // Debounced: typing should not run the whole book on every keystroke.
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(input.value, onGoToMatch), 250);
  };

  const scope = el('find-scope');
  scope.innerHTML = '';
  for (const [key, label] of [['book', 'Whole book'], ['chapter', 'This chapter'], ['marked', 'Bookmarked']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(findScope === key));
    chip.onclick = () => {
      findScope = key;
      [...scope.children].forEach((c, i) => c.setAttribute('aria-pressed',
        String(['book', 'chapter', 'marked'][i] === key)));
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
    const books = (await store.all('books')).filter((b) => !b.inVault || vaultUnlocked);
    const hits = books.filter((b) =>
      foldDiacritics(b.title).includes(needle) || foldDiacritics(b.author || '').includes(needle));
    results.innerHTML = hits.length ? '' : '<p class="muted" style="padding:20px 16px">Nothing found.</p>';
    for (const book of hits) {
      const row = document.createElement('button');
      row.className = 'list-row';
      row.innerHTML = `<span class="body"><b>${escape(book.title)}</b><small>${escape(book.author || '')}</small></span>`;
      row.onclick = () => onGoToMatch({ bookId: book.id });
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
        <span class="body"><b>${escape(chapter.title)}</b>
          <small>${status}${markCount ? ` · ${markCount} mark${markCount === 1 ? '' : 's'}` : ''}</small></span>
        <span class="trail">p. ${(reader.state.pagesBefore[chapter.index] || 0) + 1}</span>`;
      row.onclick = () => onGoToChapter({ chapter: chapter.index });
      list.appendChild(row);
    }
    return;
  }

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
      <span class="body"><b>${escape(chapter?.title || 'Chapter')}</b>
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
