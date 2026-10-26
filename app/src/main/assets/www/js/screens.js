/* Screens that hang off a book: sort, layout, reel, find, index. */

import * as store from './store.js';
import { chapterPlainText } from './parse.js';
import * as reader from './reader.js';
import * as library from './library.js';
import { SORT_KEYS, GROUP_LEVELS, MAX_GROUP_DEPTH, sortSummary, sortBooks, groupBooks, collapseBundles, vaultUnlocked, offShelf, hiddenFolderList } from './library.js';
import { pool, measure } from './blobs.js';
import { holdPicture } from './picturesave.js';
import { tagKey, tagsOf, usedTags, withEveryTag } from './tags.js';

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
  const hidden = hiddenFolderList(await store.settings());
  const all = (await store.all('books'))
    .filter((b) => !b.binnedAt && !b.importing && (!b.inVault || vaultUnlocked) && !offShelf(b, hidden));
  // As the shelf will draw it: a bundle is one book unless the grouping
  // splits its editions apart.
  const tree = groupBooks(sortBooks(collapseBundles(all, draft.group), draft.keys), draft.group);
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
  vmargin: [0, 80, 1, 'px'],
};

const LABELS = {
  size: 'Font size', leading: 'Line spacing',
  para: 'Paragraph spacing', margin: 'Side margins',
  vmargin: 'Top and bottom margins',
};
/* Margins are the same for every book (see SCREEN_KEYS in store.js), and the
   sheet says so: a margin changed here that turned up in the next book would
   otherwise look like a fault. */
const EVERY_BOOK = new Set(['margin', 'vmargin']);

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

  /* How pictures are fitted, here as well as in settings.
   *
   * It is a decision made while looking at a page -- this volume is a scan of
   * a two-page spread, that one is a long strip -- and a setting three screens
   * away from the page is a setting nobody finds. */
  const picturesField = document.createElement('div');
  picturesField.className = 'field';
  picturesField.innerHTML = '<label><span>Pictures</span></label>';
  const pictureRow = document.createElement('div');
  pictureRow.className = 'chip-row wrap';
  for (const [value, label] of [
    ['screen', 'Fit screen'],
    ['width', 'Fit width'],
    ['height', 'Fit height'],
    ['stretch', 'Stretch'],
    ['original', 'Original'],
    ['smart', 'Smart'],
    ['fill', 'Fill'],
  ]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String((settings.imageFit || 'screen') === value));
    chip.onclick = async () => {
      await store.saveSettings({ imageFit: value });
      document.body.dataset.images = value;
      openLayout(bookId);
    };
    pictureRow.appendChild(chip);
  }
  picturesField.appendChild(pictureRow);
  body.appendChild(picturesField);

  /* Greying, here too. Whether a volume reads better in grey is a decision
     made looking at a page, like the fitting above it. */
  const greyField = document.createElement('div');
  greyField.className = 'field';
  greyField.innerHTML = '<label><span>Colour pages</span></label>';
  const greyRow = document.createElement('div');
  greyRow.className = 'chip-row wrap';
  for (const [value, label] of [
    ['off', 'As they are'],
    ['plain', 'Grey'],
    ['contrast', 'Grey, lifted'],
    ['crisp', 'Grey, crisp'],
    ['eink', 'E-ink'],
  ]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String((settings.greyscale || 'off') === value));
    chip.onclick = async () => {
      await store.saveSettings({ greyscale: value });
      document.body.dataset.grey = value;
      openLayout(bookId);
    };
    greyRow.appendChild(chip);
  }
  greyField.appendChild(greyRow);
  body.appendChild(greyField);

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
    field.innerHTML = `<label><span>${LABELS[key]}${EVERY_BOOK.has(key)
      ? ' <small class="muted">· every book</small>' : ''}</span><span>${layout[key]}${unit}</span></label>`;
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
/** The volume the reel is narrowed to, or null for every one of them. */
let reelVolume = null;
/** Which book the reel is currently showing, so a change of book resets it. */
let reelBook = null;

/* The reel rebuilds wholesale on every filter change, so its URLs are
   released and re-minted with it. */
const reelUrls = pool();

/* What the reel is showing, for a press on one of its pictures. */
let reelVisible = [];
let reelTitle = '';

export async function openReel(bookId, onJump) {
  /* A different book starts afresh.
   *
   * The grid element outlives the pictures in it, so it kept whatever offset
   * the last book left behind -- open the reel a long way into one book and
   * then in another, and you land at that same depth in a reel that may not
   * even be that long. The filters were kept too, so a volume chosen in one
   * book could leave the next one looking empty.
   */
  const changedBook = reelBook !== bookId;
  if (changedBook) {
    reelBook = bookId;
    reelVolume = null;
    reelFilter = 'all';
  }

  const settings = await store.settings();
  /* The pictures the book still shows.
   *
   * A page taken out of the book keeps its row so the removal can be put
   * back, so the strip has to skip the flagged ones -- otherwise the page is
   * gone from the book and still here, which is the one place it would be
   * most obvious. */
  const images = (await store.byIndex('images', 'bookId', bookId))
    .filter((image) => !image.removed)
    .sort((a, b) => a.order - b.order);

  // Dimensions are not recorded at import -- decoding a whole book's artwork
  // to fill in two numbers is minutes nobody asked for. They are measured
  // here instead, once, and written back.
  const unmeasured = images.filter((i) => i.blob && !i.width);
  if (unmeasured.length) {
    /* Measured several at a time, not one after another.
     *
     * Each measurement gives up after a few seconds if a picture will not
     * decode, and taken in turn that is a few seconds *each* -- a book with
     * two hundred illustrations could sit there for minutes before drawing
     * anything. In parallel the wait is the slowest picture rather than the
     * sum of them all.
     *
     * One that will not decode still costs its own thumbnail and no more.
     */
    const AT_ONCE = 8;
    for (let at = 0; at < unmeasured.length; at += AT_ONCE) {
      await Promise.all(unmeasured.slice(at, at + AT_ONCE).map(async (image) => {
        try {
          const dims = await measure(image.blob);
          image.width = dims.width;
          image.height = dims.height;
        } catch {
          image.width = 0;
          image.height = 0;
        }
      }));
    }
    await store.putAll('images', unmeasured).catch(() => {});
  }
  const stills = images.filter((i) => !i.animated).length;

  el('reel-counts').textContent = `${stills} stills · ${images.length - stills} animated`;

  /* Volumes first, chapters second.
   *
   * A book built from a dozen volumes has hundreds of pictures, and running
   * them together in one strip is the same as not sorting them at all: the
   * question anyone asks of a reel is "what was in volume four", not "what
   * was in chapter ninety-one". Where a book has volumes they lead; where it
   * has none, nothing is lost, because there is only one group.
   */
  const volumes = [...new Set(images.map((i) => i.volume).filter(Boolean))];

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

  // One chip per volume, so a long book can be narrowed to the part wanted.
  if (volumes.length > 1) {
    for (const volume of volumes) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = volume;
      chip.style.textTransform = 'none';
      chip.setAttribute('aria-pressed', String(reelVolume === volume));
      chip.onclick = () => {
        reelVolume = reelVolume === volume ? null : volume;
        openReel(bookId, onJump);
      };
      filters.appendChild(chip);
    }
  }

  const grid = el('reel-grid');
  reelUrls.release();
  reelTitle = (await store.get('books', bookId))?.title || '';
  if (!grid.dataset.holds) {
    grid.dataset.holds = '1';
    // Once for the grid: it is redrawn, its listener need not be.
    holdPicture(grid, 'img[data-reel]', (img) => {
      const image = reelVisible[Number(img.dataset.reel)];
      if (image) onPictureHeld?.(image.blob, { title: reelTitle, href: image.href });
    });
  }
  grid.innerHTML = '<div class="reel-grid"></div>';
  const inner = grid.firstElementChild;

  /* The threshold hides decorative rules and spacer pixels rather than
     padding the reel with things nobody wants to look at.
     It applies only to pictures whose size is known. One that could not be
     measured -- an unusual format, a decoder that gave up -- has a size of
     zero, which is below every threshold, and it was being dropped from the
     reel entirely. A real picture shown at an unknown size is a far better
     outcome than "No images in this book". */
  const visible = reelVisible = images.filter((image) => {
    const known = Math.max(image.width || 0, image.height || 0);
    if (known > 0 && known < settings.imageThreshold) return false;
    if (reelVolume && image.volume !== reelVolume) return false;
    if (reelFilter === 'still') return !image.animated;
    if (reelFilter === 'animated') return image.animated;
    return true;
  });

  if (!visible.length) {
    grid.innerHTML = '<p class="muted" style="padding:24px 0">No images in this book.</p>';
    return;
  }

  /* Laid out under volume headings where a book has them.
     A heading per volume, and the pictures of that volume beneath it, answers
     "what was in volume four" at a glance -- which is the question a reel is
     opened to answer. */
  let heading = null;
  let strip = inner;
  let first = null;
  let atReading = null;
  // Where the reader is, when the reel is of the book being read.
  const readingAt = reader.state.book?.id === bookId ? reader.state.chapterIndex : 0;

  for (const image of visible) {
    const url = reelUrls.url(image.blob);
    if (!url) continue;   // imported before blobs were stored; nothing to show

    if (volumes.length > 1 && image.volume && image.volume !== heading) {
      heading = image.volume;
      const label = document.createElement('h2');
      label.className = 'reel-volume';
      label.textContent = heading;
      grid.appendChild(label);
      strip = document.createElement('div');
      strip.className = 'reel-grid';
      grid.appendChild(strip);
    }

    const figure = document.createElement('figure');
    figure.className = 'reel-item';
    // The chapter is named rather than numbered where a name is to hand: "Ch.
    // 91" means nothing in a book of a dozen volumes.
    const where = image.volume
      ? `${image.volume} · ch. ${image.chapterIndex + 1}`
      : `Ch. ${image.chapterIndex + 1}`;
    figure.innerHTML = `
      ${image.animated ? '<span class="gif">GIF</span>' : ''}
      <img src="${url}" alt="" loading="lazy">
      <figcaption>${escape(where)} · ${image.width}×${image.height}</figcaption>`;
    figure.querySelector('img').onclick = () => viewer(url, image, () => onJump(image));
    figure.querySelector('img').dataset.reel = String(visible.indexOf(image));
    if (!first) first = figure;
    if (!atReading && image.chapterIndex >= readingAt) atReading = figure;
    strip.appendChild(figure);
  }

  /* Opened at the part of the book being read.
   *
   * Per-book by definition, and the place you actually want: a reel that
   * opens at picture one when you are three volumes in is no more use than
   * one that opens at someone else's position.
   */
  if (changedBook || !grid.scrollTop) {
    const target = atReading || first;
    grid.scrollTop = target
      ? Math.max(0, target.offsetTop - grid.clientHeight / 3)
      : 0;
  }
}

function viewer(url, image, onGo) {
  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.innerHTML = `
    <img src="${url}" alt="">
    <div class="viewer-bar">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn ghost" data-save>Save…</button>
      ${onRedactPicture && image?.bookId && image?.href ? '<button class="btn ghost" data-redact>Black out…</button>' : ''}
      <button class="btn primary" data-goto-page>Go to page</button>
    </div>`;
  /* Blacking out part of it, from where you are already looking at it full
     size. The editor is the app's; the viewer only hands over which picture,
     and closes, because what it shows is about to stop being true. */
  const redactButton = overlay.querySelector('[data-redact]');
  if (redactButton) {
    redactButton.onclick = () => { overlay.remove(); onRedactPicture(image.bookId, image.href); };
  }
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  /* data-goto-page, not data-go.
   *
   * data-go is the app's router attribute and the handler for it is on the
   * document: a bare `data-go` with no value read as "go to the screen called
   * nothing", which switched the current screen off, found no screen to switch
   * on, and left the app a blank page -- reported as the app crashing when
   * jumping to a page. The jump is not a navigation; it should never have been
   * wearing the router's attribute. */
  overlay.querySelector('[data-goto-page]').onclick = () => { overlay.remove(); onGo(); };
  /* Save, Save as, or Share -- the picture itself. Share used to send only
   * the words "Image from" and the book's title, with no picture at all. */
  const save = () => onPictureHeld?.(image?.blob, { title: reelTitle, href: image?.href });
  overlay.querySelector('[data-save]').onclick = save;
  holdPicture(overlay, 'img', save);
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

/** Whether the search screen is searching a book or the shelf. */
let findInBook = false;

/* A long press on a search result.
 *
 * Everything you can do to a book was behind selecting it on the shelf, so
 * finding a book by name and then wanting to move it, rename it or write it
 * out meant leaving the search, clearing the query and hunting for the same
 * book on the grid. A press gives the same menu where the book already is.
 */
let onBookMenu = null;

export function onLongPressBook(fn) { onBookMenu = fn; }

/** The tags picked in the shelf search's Tags scope: books with all of them. */
let findTags = [];

/* The same books the shelf shows: nothing from the vault while it is locked,
 * nothing still being imported, and nothing deleted -- a book in the bin is
 * found in the bin, not offered back as if it were on the shelf. Nor anything
 * in a folder hidden from the shelf: that is found by opening the folder, not
 * by a search anyone could type. */
async function searchableBooks() {
  const hidden = hiddenFolderList(await store.settings());
  return (await store.all('books'))
    .filter((b) => !b.importing && !b.transient && !b.binnedAt && (!b.inVault || vaultUnlocked)
      && !offShelf(b, hidden));
}

/* Shown the way the shelf shows them: cover first, then the name.
 *
 * A list of names is not how anyone recognises a book they own. The title is
 * the one on the shelf, translated or not, so what you search for and what
 * you see are the same thing. */
function bookGrid(hits, onGoToMatch, noteOf) {
  const grid = document.createElement('div');
  grid.className = 'shelf find-shelf';
  for (const book of hits) {
    const node = library.bookTile(
      book,
      () => onGoToMatch({ bookId: book.id }),
      onBookMenu ? (pressed) => onBookMenu(pressed) : null);
    const text = noteOf?.(book);
    if (text) {
      const note = document.createElement('span');
      note.className = 'tile-meta';
      note.textContent = text;
      node.appendChild(note);
    }
    grid.appendChild(node);
  }
  return grid;
}

/**
 * Finding books by their tags.
 *
 * The tags this shelf uses sit in one scrolling line above the results --
 * only those, not the long list they may have been picked from. Typing
 * narrows the line and finds books with a tag like what was typed; picking
 * tags finds the books with every one picked, so a second tag narrows.
 */
async function runTagFind(query, onGoToMatch) {
  const results = el('find-results');
  el('find-stepper').hidden = true;
  const books = await searchableBooks();
  const used = usedTags(books);
  const key = tagKey(query);
  results.innerHTML = '';

  if (!used.length) {
    results.innerHTML = '<p class="muted" style="padding:20px 16px">No tags yet. Hold a book on the shelf, '
      + 'choose Details, and add some under Tags.</p>';
    return;
  }

  const picked = (tag) => findTags.some((t) => tagKey(t) === tagKey(tag));
  const row = document.createElement('div');
  row.className = 'chip-row find-tags';
  const offered = [
    ...used.filter(([tag]) => picked(tag)),
    ...used.filter(([tag]) => !picked(tag) && (!key || tagKey(tag).includes(key))),
  ];
  for (const [tag, count] of offered) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', String(picked(tag)));
    chip.textContent = tag;
    const small = document.createElement('small');
    small.textContent = String(count);
    chip.appendChild(small);
    chip.onclick = () => {
      findTags = picked(tag)
        ? findTags.filter((t) => tagKey(t) !== tagKey(tag))
        : [...findTags, tag];
      // A tag picked from what was typed has done the typing's job.
      if (key) el('find-input').value = '';
      runTagFind(el('find-input').value, onGoToMatch);
    };
    row.appendChild(chip);
  }
  results.appendChild(row);

  let hits;
  if (findTags.length) hits = withEveryTag(books, findTags);
  else if (key) hits = books.filter((b) => tagsOf(b).some((t) => tagKey(t).includes(key)));
  else {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.style.padding = '12px 16px';
    hint.textContent = 'Pick a tag, or type to find one. Pick more than one to narrow it down.';
    results.appendChild(hint);
    return;
  }

  if (findTags.length && key) hits = hits.filter((b) => tagsOf(b).some((t) => tagKey(t).includes(key)));
  hits.sort((a, b) => String(library.displayTitle(a)).localeCompare(String(library.displayTitle(b))));
  if (!hits.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.style.padding = '12px 16px';
    none.textContent = findTags.length > 1 ? 'No book has all of those tags.' : 'No book has that tag.';
    results.appendChild(none);
    return;
  }
  results.appendChild(bookGrid(hits, onGoToMatch, (book) => {
    const wanted = new Set(findTags.map(tagKey));
    const shown = tagsOf(book).filter((t) => wanted.has(tagKey(t)) || (key && tagKey(t).includes(key)));
    const rest = tagsOf(book).length - shown.length;
    return shown.join(', ') + (rest > 0 ? ` +${rest}` : '');
  }));
}

/** Who opens the black-out editor for a picture in the reel. */
let onRedactPicture = null;

export function onRedact(fn) { onRedactPicture = fn; }

/** Who offers to save a picture held down in the reel or its viewer. */
let onPictureHeld = null;

export function onPicture(fn) { onPictureHeld = fn; }

export function initFind(onGoToMatch, fromReader = false) {
  const input = el('find-input');
  // Told, not inferred: the reader keeps its book so reading can be resumed.
  /* Which search this is, decided once when the screen opens.
   *
   * Kept here rather than worked out while searching: a book stays loaded
   * after you leave it, so asking "is a book open" at search time made the
   * shelf search search inside whatever had been read last. */
  const inBook = fromReader && !!reader.state.book;
  findInBook = inBook;

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
      '<p class="muted" style="padding:20px 16px">Search your library by title, author or tag.</p>';
    findTags = [];
    // Opened on Tags, the tags are there to pick before anything is typed.
    if (shelfScope === 'tags') runFind('', onGoToMatch);
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
    : [['all', 'Everything'], ['title', 'Titles'], ['author', 'Authors'], ['tags', 'Tags']];
  const selected = () => (inBook ? findScope : shelfScope);

  for (const [key, label] of options) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(selected() === key));
    chip.onclick = () => {
      if (inBook) findScope = key; else shelfScope = key;
      if (key !== 'tags') findTags = [];
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

  // Tags are picked as much as typed, so this search starts with nothing typed.
  if (!findInBook && shelfScope === 'tags') return runTagFind(query, onGoToMatch);

  const needle = foldDiacritics(query.trim());
  if (needle.length < 2) {
    results.innerHTML = '<p class="muted" style="padding:20px 16px">Type at least two characters.</p>';
    stepper.hidden = true;
    return;
  }

  /* No book open: find a book, which is the whole job of this search.
   *
   * Pinpointing a book on a shelf is a different question from finding a
   * sentence inside one, and they want different answers. This looks at
   * everything that identifies a book -- its title, the translated title
   * shown on the shelf, its author, its series, its folder and its tags --
   * and puts the best match first.
   */
  /* Which search this is was decided when the screen opened.
   *
   * It used to be decided here, from whether a book happened to be loaded --
   * and a book stays loaded after you leave it, so searching from the shelf
   * searched inside whatever you had read last. The shelf search then found
   * no books at all, because it was never running.
   */
  if (!findInBook) {
    // The same books the shelf shows: nothing from the vault while it is
    // locked, nothing still being imported, and nothing deleted -- a book in
    // the bin is found in the bin, not offered back as if it were on the shelf.
    // Nor anything in a folder hidden from the shelf: that is found by
    // opening the folder, not by a search anyone could type.
    const books = await searchableBooks();

    const only = shelfScope === 'title' ? ['title', 'shown']
      : shelfScope === 'author' ? ['author']
      : null;

    const hits = library.findBooks(books, query, only);
    results.innerHTML = hits.length
      ? '' : '<p class="muted" style="padding:20px 16px">No book found.</p>';

    /* Why each book is in the list.
     *
     * A book matched on its folder or its series looks like a mistake beside
     * one matched on its title, unless it says so. */
    const words = foldDiacritics(query).split(/\s+/).filter(Boolean);
    results.appendChild(bookGrid(hits, onGoToMatch, (book) => {
      const where = library.matchedOn(book, query, only);
      if (!where || where === 'author') return '';
      if (where === 'tags') {
        const matched = tagsOf(book).filter((t) => words.some((w) => tagKey(t).includes(w)));
        return `tagged ${matched.join(', ')}`;
      }
      return `in ${String(book[where] ?? where)}`;
    }));
    stepper.hidden = true;
    return;
  }

  /* No book open: find a book, which is the whole job of this search.
   *
   * Pinpointing a book on a shelf is a different question from finding a
   * sentence inside one, and they want different answers. This looks at
   * everything that identifies a book -- its title, the translated title
   * shown on the shelf, its author, its series, its folder and its tags --
   * and puts the best match first.
   */
  /* Which search this is was decided when the screen opened.
   *
   * It used to be decided here, from whether a book happened to be loaded --
   * and a book stays loaded after you leave it, so searching from the shelf
   * searched inside whatever you had read last. The shelf search then found
   * no books at all, because it was never running.
   */
  if (!findInBook) {
    // The same books the shelf shows: nothing from the vault while it is
    // locked, nothing still being imported, and nothing deleted -- a book in
    // the bin is found in the bin, not offered back as if it were on the shelf.
    // Nor anything in a folder hidden from the shelf: that is found by
    // opening the folder, not by a search anyone could type.
    const hidden = hiddenFolderList(await store.settings());
    const books = (await store.all('books'))
      .filter((b) => !b.importing && !b.transient && !b.binnedAt && (!b.inVault || vaultUnlocked)
        && !offShelf(b, hidden));

    const only = shelfScope === 'title' ? ['title', 'shown']
      : shelfScope === 'author' ? ['author']
      : null;

    const hits = library.findBooks(books, query, only);
    results.innerHTML = hits.length
      ? '' : '<p class="muted" style="padding:20px 16px">No book found.</p>';

    for (const book of hits) {
      const row = document.createElement('button');
      row.className = 'list-row';

      /* Why this book is in the list.
       *
       * A result matched on its folder or its series looks like a mistake
       * next to one matched on its title, unless it says so. */
      const where = library.matchedOn(book, query, only);
      const note = [
        book.author || '',
        where && where !== 'author' ? `in ${escape(String(book[where] ?? where))}` : '',
      ].filter(Boolean).join(' · ');

      row.innerHTML = `<span class="body"><b>${escape(library.displayTitle(book))}</b>`
        + `<small>${note}</small></span>`;
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
    // Only the words are wanted here; sanitising every chapter to throw the
    // markup away again cost about a second a keystroke on a long book.
    const text = chapterPlainText(chapter);
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

/* ── notices that arrive together ────────────────────────────────────────
 *
 * There is one banner, and a second notice used to replace the first. Two
 * builds finishing a second apart showed only the later one: the first
 * book's "Built — 40 chapters" was on screen for a moment and gone, and
 * whether it had worked at all had to be checked on the shelf.
 *
 * So a notice that arrives while another is showing joins it as a line of
 * its own, and each line stays for as long as it was asked to -- the banner
 * shrinks as the older ones run out rather than everything vanishing at the
 * time of the newest. Notices about operations say whether they finished or
 * failed, so a stack of three reads at a glance.
 */
let toastTimer = null;
const lines = [];
const MOST = 4;

/**
 * @param message  what to say
 * @param ms       how long this line stays
 * @param options  { kind: 'done' | 'failed' } for the outcome of an operation
 *                 -- or pass the options in place of ms.
 */
export function toast(message, ms = 2200, options = {}) {
  if (ms && typeof ms === 'object') { options = ms; ms = 2200; }
  const node = el('toast');
  if (!node) return;
  const now = Date.now();
  const text = String(message ?? '');

  // Whatever is on screen is still on screen; a hidden banner starts afresh.
  if (node.hidden) lines.length = 0;

  /* The same thing said twice is said once, with a count -- a page turn that
   * keeps landing on the last chapter is one notice, not a column of them. */
  const last = lines[lines.length - 1];
  if (last && last.text === text) {
    last.repeat += 1;
    last.until = Math.max(last.until, now + ms);
  } else {
    lines.push({ text, kind: options.kind || null, repeat: 1, until: now + ms });
  }
  while (lines.length > MOST) lines.shift();

  if (!node.onclick) {
    // Tapping it puts it away: four lines of notices over the page are worth
    // dismissing without waiting for them.
    node.onclick = () => { lines.length = 0; clearTimeout(toastTimer); node.hidden = true; };
  }

  paintToast(node);
}

function paintToast(node) {
  clearTimeout(toastTimer);
  const now = Date.now();
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].until <= now) lines.splice(i, 1);
  if (!lines.length) { node.hidden = true; return; }

  const one = lines.length === 1 && !lines[0].kind;
  node.classList.toggle('stack', !one);
  if (one) {
    // A single plain notice looks exactly as it always did.
    node.textContent = lines[0].repeat > 1 ? `${lines[0].text} (×${lines[0].repeat})` : lines[0].text;
  } else {
    node.innerHTML = '';
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = `toast-line${line.kind ? ` ${line.kind}` : ''}`;
      if (line.kind) {
        const mark = document.createElement('span');
        mark.className = 'toast-mark';
        mark.textContent = line.kind === 'failed' ? '✕' : '✓';
        row.appendChild(mark);
      }
      const words = document.createElement('span');
      words.textContent = line.repeat > 1 ? `${line.text} (×${line.repeat})` : line.text;
      row.appendChild(words);
      node.appendChild(row);
    }
  }
  node.hidden = false;

  // Woken again when the next line runs out, not when the newest does.
  const next = Math.min(...lines.map((line) => line.until)) - now;
  toastTimer = setTimeout(() => paintToast(node), Math.max(50, next));
}
