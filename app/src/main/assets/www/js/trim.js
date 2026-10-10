/* Taking things out of a book.
 *
 * The workshop joins files into a book, dividing cuts a book into books, and
 * building adds to one that already exists. All three make more than they
 * started with. This is the only direction left: taking content out and
 * keeping the book.
 *
 * It is wanted for the things that arrive attached to a download rather than
 * belonging to the work -- a scanlator's credit page every chapter, the
 * advertisement spread bound into a volume, the duplicated scan, the
 * translator's afterword, the sample chapter for a different series. None of
 * it is worth re-importing the file to be rid of, and all of it is worth
 * being rid of.
 *
 *
 * Nothing is destroyed on the way out.
 *
 * Removing is the one operation here that reaches into a book that already
 * exists; every other one leaves its source alone, so a bad result costs a
 * delete rather than a re-import. There is no such consolation here, and a
 * page taken out by mistake is a page gone -- so a removal is kept, and can
 * be put back, until it is discarded on purpose. What that costs is the
 * markup of the removed pages, which is bytes, and leaving the pictures where
 * they are, which is already paid for.
 *
 * Put back works newest-first, as an undo does. That is not a limitation
 * worth engineering around: it is the only order in which the recorded
 * positions still mean what they said. Re-inserting a page from two removals
 * ago, into a book that has changed shape twice since, would be a guess
 * dressed as a restore.
 */

import * as store from './store.js';
import { chapterHtml, countWords } from './parse.js';
import { unitsOf, pagesOf } from './library.js';

/* ── what there is to take out ────────────────────────────────────────── */

/**
 * Everything a book could be trimmed at, both ways at once.
 *
 * A comic wants pages, a novel wants chapters, and plenty of books want
 * both -- an omnibus with an afterword per volume is a chapter removal, and
 * the credit page inside each of those volumes is a page removal. So the
 * screen offers whichever the book can support and this says which those are.
 */
export async function inspect(bookId) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);

  const images = await store.byIndex('images', 'bookId', bookId);
  const live = images.filter((image) => !image.removed);

  const pages = removablePages(chapters);

  return {
    book,
    chapters,
    pages,
    rows: removableChapters(chapters),
    // Blobs, so a page can be looked at rather than read about. The same
    // reason the divide screen carries them.
    pictures: new Map(live.filter((i) => i.blob).map((i) => [i.href, i.blob])),
    canChapters: chapters.length > 1,
    canPages: pages.length > 1,
    history: book.trimmed || [],
  };
}

/** The chapters of a book, described well enough to choose between. */
export function removableChapters(chapters) {
  return chapters.map((chapter) => {
    const units = unitsOf(chapterHtml(chapter));
    const text = units.map((u) => u.text).filter(Boolean).join(' ');
    return {
      index: chapter.index,
      title: chapter.title || `Chapter ${chapter.index + 1}`,
      pages: units.length,
      pictures: units.filter((u) => u.picture).length,
      words: chapter.words || 0,
      // A chapter of pictures has no words to show, so its first page stands
      // for it instead -- which is the only thing worth seeing anyway.
      picture: units.find((u) => u.picture)?.picture || null,
      preview: text ? `${text.split(/\s+/).slice(0, 18).join(' ')}…` : null,
      /* Enough to recognise the chapter by, for looking at it properly rather
       * than picking it off a list. Eighteen words is a label; this is a
       * paragraph, which is what it takes to tell an afterword from a
       * chapter. */
      extract: text ? `${text.split(/\s+/).slice(0, 80).join(' ')}${
        text.split(/\s+/).length > 80 ? '…' : ''}` : null,
      // Every page of it, so a chapter can be looked through as well as read about.
      pictureHrefs: units.filter((u) => u.picture).map((u) => u.picture),
    };
  });
}

/**
 * Every page of a book, numbered across the whole of it.
 *
 * `at` is the number the screen shows and the number removal takes, so the
 * two cannot drift apart -- the position in the flattened list, which is what
 * "page 412" means to someone looking at a comic.
 */
export function removablePages(chapters) {
  return pagesOf(chapters).map((page, at) => ({ ...page, at }));
}

/* ── taking it out ────────────────────────────────────────────────────── */

const label = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ── planning it, before any of it happens ───────────────────────────────
 *
 * The plan is worked out separately from carrying it out, and both the
 * confirmation and the removal itself are built from the same one. That is
 * the point: a preview computed by a second piece of code that is *supposed*
 * to agree with the first is a preview that will eventually lie about what is
 * going, and the whole reason to show one is to be able to trust it.
 */

/** What removing these chapters would do. Touches nothing. */
function planChapters(book, chapters, indexes) {
  const going = new Set([...indexes].map(Number)
    .filter((n) => chapters.some((c) => c.index === n)));
  if (!going.size) throw new Error('Choose something to take out.');
  if (going.size >= chapters.length) {
    throw new Error('That would empty the book. Delete it instead, and it goes to the bin.');
  }

  const keep = chapters.filter((c) => !going.has(c.index));
  const lost = chapters.filter((c) => going.has(c.index));

  // Where each surviving chapter ends up, so marks and pictures can follow.
  const moved = new Map(keep.map((chapter, index) => [chapter.index, index]));

  const next = keep.map((chapter, index) => ({ ...chapter, index }));

  const record = {
    at: Date.now(),
    mode: 'chapters',
    what: label(lost.length, 'chapter', 'chapters'),
    count: lost.length,
    words: lost.reduce((n, c) => n + (c.words || 0), 0),
    chapters: lost.map((chapter) => ({
      index: chapter.index,
      title: chapter.title || null,
      fromToc: !!chapter.fromToc,
      words: chapter.words || 0,
      html: chapterHtml(chapter),
    })),
  };

  return {
    next,
    record,
    lost,
    // A surviving chapter is untouched, so its marks keep their offsets and
    // only need their chapter number brought forward.
    moved,
    touched: new Set(),
    dropped: [...going],
  };
}

/**
 * Remove whole chapters.
 *
 * @param indexes chapter indexes as the book has them now.
 */
export async function removeChapters(bookId, indexes, { onProgress } = {}) {
  const { book, chapters } = await load(bookId);
  onProgress?.('Reading the book', 0.1);
  const plan = planChapters(book, chapters, indexes);
  return commit(book, chapters, plan.next, { ...plan, onProgress });
}

/**
 * What removing these pages would do. Touches nothing.
 *
 * A chapter that loses pages keeps its name and its remaining pages. A
 * chapter that loses all of them goes with them: an empty chapter in the list
 * is worse than one chapter fewer, because it reads as a book that failed to
 * load.
 */
function planPages(book, chapters, pages, ats) {
  const bookId = book.id;
  if (!pages.length) throw new Error('There is nothing in that book to take out.');

  const going = new Set([...ats].map(Number).filter((n) => n >= 0 && n < pages.length));
  if (!going.size) throw new Error('Choose something to take out.');
  if (going.size >= pages.length) {
    throw new Error('That would empty the book. Delete it instead, and it goes to the bin.');
  }

  const keep = pages.filter((page) => !going.has(page.at));
  const lost = pages.filter((page) => going.has(page.at));

  /* Consecutive survivors from one chapter become that chapter again.
   *
   * The same grouping dividing uses. Without it a book trimmed in three
   * places comes back as one undifferentiated run, and the chapter names --
   * the only thing telling you where you are in six hundred pages -- are
   * gone.
   */
  const grouped = [];
  for (const page of keep) {
    const last = grouped[grouped.length - 1];
    if (last && last.from === page.chapterIndex) last.pages.push(page);
    else grouped.push({ from: page.chapterIndex, title: page.chapterTitle, pages: [page] });
  }

  const source = new Map(chapters.map((c) => [c.index, c]));
  const next = grouped.map((group, index) => ({
    bookId,
    index,
    title: group.title || source.get(group.from)?.title || null,
    fromToc: !!source.get(group.from)?.fromToc,
    words: countWords(group.pages.map((p) => p.text).join(' '), book.lang),
    html: group.pages.map((p) => p.html).join('\n'),
  }));

  /* Which old chapter became which new one, and which lost pages on the way.
   *
   * A chapter that kept every page it had is the same chapter at a new
   * number, so its marks survive the move. One that lost a page is not: every
   * offset after the gap has shifted, and a mark left pointing at the old one
   * would highlight the wrong sentence. Those are carried out with the
   * removal instead of being quietly wrong.
   */
  const had = new Map();
  for (const page of pages) had.set(page.chapterIndex, (had.get(page.chapterIndex) || 0) + 1);

  const moved = new Map();
  const touched = new Set();
  const seen = new Map();
  grouped.forEach((group, index) => {
    // A chapter split into two runs by a removal in the middle is not the
    // same chapter either; only the first run claims the number.
    if (!moved.has(group.from)) moved.set(group.from, index);
    seen.set(group.from, (seen.get(group.from) || 0) + group.pages.length);
  });
  for (const [from, count] of seen) {
    if (count !== had.get(from)) touched.add(from);
  }
  const dropped = [...had.keys()].filter((from) => !seen.has(from));

  const record = {
    at: Date.now(),
    mode: 'pages',
    what: label(lost.length, 'page', 'pages'),
    count: lost.length,
    words: countWords(lost.map((p) => p.text).join(' '), book.lang),
    pages: lost.map((page) => ({
      at: page.at,
      chapterIndex: page.chapterIndex,
      chapterTitle: page.chapterTitle || null,
      html: page.html,
      picture: page.picture || null,
    })),

    /* How the book was divided into chapters before any of this.
     *
     * Titles and page counts, not markup -- a few bytes a chapter. It is what
     * makes a put-back exact: the pages go back at their old numbers, and
     * these say where the chapter boundaries fell between them.
     *
     * Rebuilding the boundaries from the pages themselves does not work. A
     * page remembers which chapter it was in by number, and the surviving
     * pages have been renumbered, so a page from old chapter 1 and a page
     * from new chapter 1 both claim to be chapter 1 -- and a volume removed
     * whole came back fused to the one after it.
     */
    was: chapters.map((chapter) => ({
      title: chapter.title || null,
      fromToc: !!chapter.fromToc,
      pages: had.get(chapter.index) || 0,
    })),
  };

  return { next, record, lost, moved, touched, dropped: [...dropped, ...touched] };
}

/**
 * Remove individual pages, wherever their chapters happen to fall.
 *
 * @param ats page numbers from removablePages().
 */
export async function removePages(bookId, ats, { onProgress } = {}) {
  const { book, chapters, pages } = await load(bookId);
  onProgress?.('Reading the book', 0.1);
  const plan = planPages(book, chapters, pages, ats);
  return commit(book, chapters, plan.next, { ...plan, onProgress });
}

/** The book and the two lists every one of these works from. */
async function load(bookId) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');
  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);
  return { book, chapters, pages: removablePages(chapters) };
}

/* ── what you are about to lose ──────────────────────────────────────────
 *
 * Taking pages out of a book is the one operation here that cannot be
 * undone by deleting the result, so it is the one that has to be looked at
 * before it happens -- and "12 pages" is not something anybody can check. A
 * credit page and the first page of a chapter look identical in a count.
 *
 * This is the same plan the removal itself runs, read rather than written, so
 * what is shown is what will happen rather than a second opinion about it.
 */
export async function preview(bookId, mode, picks) {
  const { book, chapters, pages } = await load(bookId);

  const plan = mode === 'chapters'
    ? planChapters(book, chapters, picks)
    : planPages(book, chapters, pages, picks);

  /* Which pictures would stop being used, and which marks would be carried
   * out with the removal. Both are read from the store exactly as commit()
   * reads them, and neither is written. */
  const images = await store.byIndex('images', 'bookId', bookId);
  const used = new Set();
  for (const chapter of plan.next) {
    for (const unit of unitsOf(chapterHtml(chapter))) {
      if (unit.picture) used.add(unit.picture);
    }
  }
  const letGo = images.filter((image) => !used.has(image.href) && !image.removed);

  const marks = (await store.byIndex('marks', 'bookId', bookId)).filter((mark) =>
    plan.dropped.includes(mark.chapterIndex) || plan.touched.has(mark.chapterIndex));

  const pagesLeft = plan.next.reduce((n, c) => n + unitsOf(chapterHtml(c)).length, 0);

  return {
    mode,
    what: plan.record.what,
    count: plan.record.count,
    words: plan.record.words || 0,
    pictures: letGo.length,
    marks: marks.length,

    chaptersLeft: plan.next.length,
    chaptersWas: chapters.length,
    pagesLeft,
    pagesWas: pages.length,

    /* The items themselves, in the order they sit in the book, so the list
     * can be looked through rather than counted. */
    items: mode === 'chapters'
      ? plan.lost.map((chapter) => ({
        label: chapter.title || `Chapter ${chapter.index + 1}`,
        note: describeChapter(chapter),
        picture: firstPictureOf(chapterHtml(chapter)),
        text: extractOf(chapterHtml(chapter)),
      }))
      : plan.lost.map((page) => ({
        label: `Page ${page.at + 1}`,
        note: page.chapterTitle || (page.picture ? 'page' : 'section'),
        picture: page.picture || null,
        text: page.text ? `${page.text.split(/\s+/).slice(0, 40).join(' ')}…` : null,
      })),
  };
}

const describeChapter = (chapter) => {
  const units = unitsOf(chapterHtml(chapter));
  const pictures = units.filter((u) => u.picture).length;
  return [units.length === 1 ? '1 page' : `${units.length} pages`,
    pictures ? `${pictures} pictures` : null,
    chapter.words ? `${chapter.words} words` : null].filter(Boolean).join(' · ');
};

const firstPictureOf = (html) => unitsOf(html).find((u) => u.picture)?.picture || null;

function extractOf(html, words = 40) {
  const text = unitsOf(html).map((u) => u.text).filter(Boolean).join(' ');
  if (!text) return null;
  const parts = text.split(/\s+/);
  return parts.length > words ? `${parts.slice(0, words).join(' ')}…` : text;
}

/**
 * Write the trimmed book back.
 *
 * The new chapters are written before the leftovers are deleted, not after.
 * Either order ends in the same place, but only this one leaves a readable
 * book at every moment in between -- the other spends a moment with no
 * chapters at all, and a book that is killed by the system in that moment is
 * a book destroyed by a tidy-up.
 */
async function commit(book, before, next, { onProgress, record, moved, touched, dropped }) {
  const bookId = book.id;
  onProgress?.('Rewriting the chapters', 0.4);

  await store.putAll('chapters', next.map((chapter) => ({ ...chapter, bookId, id: undefined })));

  for (const chapter of before) {
    if (chapter.index >= next.length) await store.del('chapters', [bookId, chapter.index]);
  }

  /* ── pictures ──
   *
   * A removed picture keeps its row. The markup that referred to it is gone,
   * so nothing displays it, and nothing but the row itself knows it was ever
   * there -- which is exactly what a put-back needs and what re-importing the
   * file would otherwise be the only way to get. It is flagged rather than
   * deleted, and the flag is what the reel and the export skip.
   */
  onProgress?.('Settling the pictures', 0.7);

  const images = await store.byIndex('images', 'bookId', bookId);
  const used = new Map();
  next.forEach((chapter, index) => {
    // chapterHtml, not .html: a chapter kept whole still holds its source
    // rather than resolved markup, and reading the wrong field makes every
    // picture in it look unreferenced.
    for (const unit of unitsOf(chapterHtml(chapter))) {
      if (unit.picture && !used.has(unit.picture)) used.set(unit.picture, index);
    }
  });

  let order = 0;
  const writes = [];
  // Numbered in reading order, so the reel runs the way the book does.
  for (const [href, index] of used) {
    const image = images.find((i) => i.href === href);
    if (image) writes.push({ ...image, chapterIndex: index, order: order++, removed: false });
  }
  const letGo = [];
  for (const image of images) {
    if (used.has(image.href) || image.removed) continue;
    letGo.push(image.href);
    writes.push({
      ...image,
      removed: true,
      wasAt: { chapterIndex: image.chapterIndex, order: image.order },
    });
  }
  await store.putAll('images', writes);

  record.pictures = letGo;

  /* ── marks ──
   *
   * Carried out with the removal rather than left pointing at text that has
   * moved, and put back with it.
   */
  const marks = await store.byIndex('marks', 'bookId', bookId);
  record.marks = [];
  for (const mark of marks) {
    const at = mark.chapterIndex;
    if (dropped.includes(at) || touched.has(at)) {
      const { id, ...kept } = mark;
      record.marks.push(kept);
      await store.del('marks', mark.id);
      continue;
    }
    const to = moved.get(at);
    if (to != null && to !== at) await store.put('marks', { ...mark, chapterIndex: to });
  }

  /* ── where the reader was ──
   *
   * A saved position can now point past the end of the book, or into a
   * chapter whose text has shifted under it. Clamped, and reset to the top of
   * its chapter when that chapter is no longer the one it was measured
   * against -- which is a page or two lost, against reopening at a sentence
   * that is not there.
   */
  const position = await store.get('positions', bookId);
  if (position) {
    const at = position.chapterIndex || 0;
    const to = moved.has(at) ? moved.get(at) : Math.min(at, next.length - 1);
    const same = moved.get(at) != null && !touched.has(at);
    await store.put('positions', {
      ...position,
      chapterIndex: Math.max(0, Math.min(to, next.length - 1)),
      anchor: same ? position.anchor : 0,
      page: same ? position.page : 0,
    });
  }

  onProgress?.('Done', 1);

  const history = [...(book.trimmed || []), record];
  const words = next.reduce((n, c) => n + (c.words || 0), 0);
  await store.put('books', {
    ...book,
    words,
    chapters: next.length,
    trimmed: history,
    trimmedCount: history.reduce((n, r) => n + (r.count || 0), 0),
  });

  return {
    removed: record.count,
    what: record.what,
    pictures: record.pictures.length,
    marks: record.marks.length,
    chapters: next.length,
    pages: next.reduce((n, c) => n + unitsOf(c.html).length, 0),
  };
}

/* ── putting it back ──────────────────────────────────────────────────── */

/** Whether the newest removal can still be undone. */
export const canPutBack = (book) => !!(book?.trimmed || []).length;

/** A sentence for each removal, newest last. */
export function removalSummary(book) {
  return (book?.trimmed || []).map((record, at) => ({
    at,
    when: record.at,
    what: record.what,
    count: record.count || 0,
    pictures: (record.pictures || []).length,
    newest: at === (book.trimmed.length - 1),
  }));
}

/**
 * Undo the newest removal.
 *
 * Only the newest, and that is the whole reason it is exact: nothing has
 * happened to the book since, so the positions the record kept still describe
 * the book it is going back into.
 */
export async function putBack(bookId, { onProgress } = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');

  const history = [...(book.trimmed || [])];
  const record = history.pop();
  if (!record) throw new Error('There is nothing to put back.');

  onProgress?.('Reading the book', 0.1);

  const chapters = (await store.byIndex('chapters', 'bookId', bookId))
    .sort((a, b) => a.index - b.index);

  const next = record.mode === 'chapters'
    ? restoreChapters(chapters, record, book)
    : restorePages(chapters, record, book);

  onProgress?.('Putting it back', 0.5);

  await store.putAll('chapters', next.map((chapter, index) => ({
    bookId, index,
    title: chapter.title || null,
    fromToc: !!chapter.fromToc,
    words: chapter.words || 0,
    html: chapter.html,
  })));

  for (const chapter of chapters) {
    if (chapter.index >= next.length) await store.del('chapters', [bookId, chapter.index]);
  }

  // The pictures never left; the flag did the hiding, so clearing it is the
  // whole of putting them back.
  const images = await store.byIndex('images', 'bookId', bookId);
  const back = new Set(record.pictures || []);
  const restored = images
    .filter((image) => back.has(image.href))
    .map(({ wasAt, ...image }) => ({ ...image, removed: false }));
  await store.putAll('images', restored);

  // Renumbered against the book as it is now, which is the book it was.
  await renumber(bookId, next);

  for (const mark of record.marks || []) {
    await store.add('marks', { ...mark, bookId });
  }

  onProgress?.('Done', 1);

  const words = next.reduce((n, c) => n + (c.words || 0), 0);
  await store.put('books', {
    ...book,
    words,
    chapters: next.length,
    trimmed: history,
    trimmedCount: history.reduce((n, r) => n + (r.count || 0), 0),
  });

  return {
    back: record.count,
    what: record.what,
    pictures: restored.length,
    marks: (record.marks || []).length,
    chapters: next.length,
  };
}

/** Removed chapters go back at the numbers they were taken from. */
function restoreChapters(chapters, record) {
  const next = chapters.map((chapter) => ({
    title: chapter.title,
    fromToc: chapter.fromToc,
    words: chapter.words,
    html: chapterHtml(chapter),
  }));
  // Ascending, so each insertion lands before the next one is measured.
  for (const chapter of [...record.chapters].sort((a, b) => a.index - b.index)) {
    next.splice(Math.min(chapter.index, next.length), 0, {
      title: chapter.title,
      fromToc: chapter.fromToc,
      words: chapter.words,
      html: chapter.html,
    });
  }
  return next;
}

/** Removed pages go back at the page numbers they were taken from. */
function restorePages(chapters, record, book) {
  const pages = pagesOf(chapters).map((page) => ({
    html: page.html,
    text: page.text,
    chapterIndex: page.chapterIndex,
    chapterTitle: page.chapterTitle,
  }));

  for (const page of [...record.pages].sort((a, b) => a.at - b.at)) {
    pages.splice(Math.min(page.at, pages.length), 0, {
      html: page.html,
      text: '',
      chapterIndex: page.chapterIndex,
      chapterTitle: page.chapterTitle,
    });
  }

  const chapter = (title, fromToc, mine) => ({
    title: title || null,
    fromToc: !!fromToc,
    words: countWords(mine.map((p) => p.text).join(' '), book.lang),
    html: mine.map((p) => p.html).join('\n'),
  });

  /* Cut back into chapters where the boundaries were, not where the page
   * numbers suggest. See the note on `was` where it is recorded.
   */
  const was = record.was || [];
  if (was.reduce((n, c) => n + c.pages, 0) === pages.length) {
    const next = [];
    let at = 0;
    for (const old of was) {
      if (!old.pages) continue;
      next.push(chapter(old.title, old.fromToc, pages.slice(at, at + old.pages)));
      at += old.pages;
    }
    return next;
  }

  /* A removal recorded before the boundaries were. Grouping by the chapter
   * each page remembers is not exact -- two chapters can claim one number --
   * but it keeps the pages and most of the names, which beats refusing.
   */
  const grouped = [];
  for (const page of pages) {
    const last = grouped[grouped.length - 1];
    if (last && last.from === page.chapterIndex) last.pages.push(page);
    else grouped.push({ from: page.chapterIndex, title: page.chapterTitle, pages: [page] });
  }
  return grouped.map((group) => chapter(group.title, false, group.pages));
}

/** Point every live picture at the chapter it now sits in, in reading order. */
async function renumber(bookId, chapters) {
  const images = await store.byIndex('images', 'bookId', bookId);
  const byHref = new Map(images.map((image) => [image.href, image]));

  let order = 0;
  const writes = [];
  chapters.forEach((chapter, index) => {
    for (const unit of unitsOf(chapter.html)) {
      const image = unit.picture ? byHref.get(unit.picture) : null;
      if (image && !writes.some((w) => w.href === image.href)) {
        writes.push({ ...image, chapterIndex: index, order: order++, removed: false });
      }
    }
  });
  await store.putAll('images', writes);
}

/* ── discarding for good ──────────────────────────────────────────────── */

/**
 * Give up the removal and the space with it.
 *
 * The bin draws the same line: out of sight is not the same as gone, and the
 * second one has to be asked for. Here it is the pictures that matter --
 * three hundred advertisement pages are the only part of a removal with any
 * size to it, and until this is called they are all still on the phone.
 */
export async function discard(bookId, { onProgress } = {}) {
  const book = await store.get('books', bookId);
  if (!book) throw new Error('That book is no longer in the library.');

  const history = book.trimmed || [];
  if (!history.length) throw new Error('There is nothing to discard.');

  onProgress?.('Discarding', 0.3);

  const hrefs = new Set(history.flatMap((record) => record.pictures || []));
  let pictures = 0;
  for (const href of hrefs) {
    const image = await store.get('images', [bookId, href]);
    if (image?.removed) {
      await store.del('images', [bookId, href]);
      pictures += 1;
    }
  }

  onProgress?.('Done', 1);

  await store.put('books', { ...book, trimmed: [], trimmedCount: 0 });

  return {
    removals: history.length,
    pictures,
    count: history.reduce((n, r) => n + (r.count || 0), 0),
  };
}
