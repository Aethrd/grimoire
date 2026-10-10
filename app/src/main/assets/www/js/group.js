/* Which files are one book.
 *
 * A web novel does not arrive as a book. It arrives as two hundred saved
 * pages, one per chapter, usually zipped into a folder per novel -- and the
 * importer treated every one of them as a book of its own. Importing one
 * series put two hundred one-chapter "books" on the shelf, and importing a
 * zip of three series put six hundred, filed into folders, each with its own
 * progress bar stuck at zero. That is not a library, and doing the work two
 * hundred times over is most of why it took so long.
 *
 * So before anything is parsed, the files are sorted into what they actually
 * are: whole books (an EPUB, a PDF, a comic) and chapters of a work (saved
 * pages, numbered text files). Chapters of the same work become one book,
 * in reading order.
 *
 * Deciding that from names alone is a judgement, and it is made
 * conservatively. A saved web page is a chapter -- nobody saves a whole
 * novel as one browser page. A folder of text files is only treated as
 * chapters when the names say so: a chapter marker, or a shared title with a
 * number after it. Thirty differently named novels in one folder stay thirty
 * novels.
 */

/** Formats that are only ever a whole book. */
const WHOLE = new Set(['EPUB', 'PDF', 'CBZ', 'FB2']);

/** Formats that are a chapter when the names say so. A saved page always is. */
const PIECE = new Set(['MHT', 'HTML', 'TXT', 'MD']);

const extensionOf = (name) => String(name).split('.').pop().toLowerCase();
const leafOf = (path) => String(path).split('/').pop();
const dirOf = (path) => {
  const parts = String(path).split('/');
  parts.pop();
  return parts.join('/');
};
const bare = (name) => leafOf(name).replace(/\.[^.]+$/, '');

export const naturalOrder = (a, b) => String(a || '').localeCompare(String(b || ''),
  undefined, { numeric: true, sensitivity: 'base' });

/* ── reading a chapter's place off its name ──────────────────────────── */

/*
 * The markers a chapter is numbered by, in the languages these libraries are
 * actually in. "Chapter 12", "Ch. 12", "Ep 12", Korean "12화", Japanese and
 * Chinese "第12話" / "第12章", and a bare "#12".
 */
const MARKERS = [
  /\b(?:chapter|chap|ch)\.?\s*0*(\d+)/i,
  /\b(?:episode|ep)\.?\s*0*(\d+)/i,
  /\bpart\s*0*(\d+)/i,
  /0*(\d+)\s*(?:화|話|章|회|话)/,
  /第\s*0*(\d+)\s*[章話话回화]/,
  /#\s*0*(\d+)\b/,
];

/** The chapter number a name carries, or null. */
export function chapterNumber(name) {
  const text = bare(name);
  for (const marker of MARKERS) {
    const found = marker.exec(text);
    if (found) return Number(found[1]);
  }
  return null;
}

/* The pieces of a novel that are not numbered chapters, in the same
 * languages: a side story is still part of the work, and so is the prologue. */
const SPECIAL = /\b(prologue|epilogue|interlude|intermission|afterword|postscript|side\s*story|extra|bonus)\b|(프롤로그|에필로그|외전|번외|후기|序章|終章|番外|あとがき|外传|后记)/i;

/** Whether a name says it is one piece of something larger. */
function soundsLikeAChapter(name) {
  const text = bare(name);
  return chapterNumber(text) != null || SPECIAL.test(text);
}

/**
 * Where a chapter sits in its book, from its name.
 *
 * The order a novel is read in, which is not the order its files sort in:
 * the cover and illustrations first, the prologue, the numbered chapters,
 * the epilogue, then side stories and the afterword. Sorting by name puts
 * "Epilogue" between "Chapter 4" and "Chapter 5" and "Prologue" after all
 * of them.
 */
export function chapterRank(name) {
  const text = bare(name).toLowerCase();
  const number = chapterNumber(text);

  if (/\bcover\b|표지/.test(text)) return [0, 0];
  if (/illustration|insert|colou?r page|일러스트|口絵/.test(text)) return [1, 0];
  if (/prologue|프롤로그|序章/.test(text)) return [2, 0];
  if (number != null && !/side\s*story|extra|bonus|외전|番外/.test(text)) return [10, number];
  if (/epilogue|에필로그|終章/.test(text)) return [900, 0];
  if (/side\s*story|extra|bonus|외전|番外/.test(text)) return [950, number ?? 0];
  if (/afterword|postscript|후기|あとがき/.test(text)) return [970, 0];

  // Nothing to go on but whatever number is in it, which beats nothing.
  const last = /(\d+)(?!.*\d)/.exec(text);
  return [500, last ? Number(last[1]) : 0];
}

/** Items in reading order, by the name each one has. */
export function inReadingOrder(items, nameOf = (item) => item.name) {
  return [...items].sort((a, b) => {
    const [ra, na] = chapterRank(nameOf(a));
    const [rb, nb] = chapterRank(nameOf(b));
    return ra - rb || na - nb || naturalOrder(nameOf(a), nameOf(b));
  });
}

/* ── which chapters belong together ──────────────────────────────────── */

/**
 * The work a chapter belongs to, from its name.
 *
 * Everything before the chapter marker: "Witch City - Chapter 12 - NovelSite"
 * belongs to "witch city". A name with no marker belongs to whatever comes
 * before its last number. Two novels saved into one folder therefore come
 * apart again, which they would not if the folder alone decided.
 */
export function workOf(name) {
  const text = bare(name);
  let cut = -1;
  /* Whichever comes first, a number or a word like "side story": in
   * "마녀의 도시 외전 1화" the work ends before 외전, not before 1화, or the
   * side stories would be filed as a different novel. */
  for (const marker of [...MARKERS, SPECIAL]) {
    const found = marker.exec(text);
    if (found && (cut === -1 || found.index < cut)) cut = found.index;
  }
  if (cut === -1) {
    const last = /\d+(?!.*\d)/.exec(text);
    if (last) cut = last.index;
  }
  const head = cut === -1 ? text : text.slice(0, cut);
  return head
    .replace(/[\s\-–—_:|.,()[\]]+$/g, '')
    .replace(/^[\s\-–—_:|.,()[\]]+/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * What a run of chapters is called: the title they share.
 *
 * The longest prefix a clear majority agree on, with any trailing "Chapter"
 * taken off -- the same rule as the conversion script this replaced, so a
 * book comes out named as it would have been there.
 */
export function commonLabel(names) {
  const titles = names.map((name) => bare(name));
  if (!titles.length) return '';
  const need = Math.max(2, Math.ceil((titles.length * 2) / 3));
  let best = '';
  for (const candidate of titles) {
    for (let k = candidate.length; k > 3; k--) {
      const prefix = candidate.slice(0, k);
      if (titles.filter((t) => t.startsWith(prefix)).length >= need) {
        if (prefix.length > best.length) best = prefix;
        break;
      }
    }
  }
  return best
    .replace(/[\s\-–—:,|_]+$/g, '')
    .replace(/\s+(chapter|chapters|part|vol|volume|ch|ep|episode)\.?$/i, '')
    .replace(/[\s\-–—:,|_]+$/g, '')
    .trim();
}

/**
 * Sort files into books.
 *
 * @param items  anything with a `name` (and an archive path, where there is
 *               one, in `path`): loose files from the picker, or the entries
 *               of a zip.
 * @returns [{ kind: 'book', item }] for whole books, and
 *          [{ kind: 'chapters', title, folder, items }] for a work that
 *          arrived in pieces -- in the order the items were given, with each
 *          group's own items in reading order.
 */
export function planBooks(items, { pathOf = (item) => item.path || item.name } = {}) {
  const plan = [];
  const byFolder = new Map();
  /* Where each item was in what it arrived in, so a work made of pieces sits
   * where its first piece did. A workshop list of "Volume 1.epub", the
   * chapters of volume two, "Volume 3.epub" has to come out in that order,
   * not with volume two moved to the end because it was assembled last. */
  const position = new Map(items.map((item, at) => [item, at]));

  for (const item of items) {
    const format = formatName(pathOf(item));
    if (!PIECE.has(format)) {
      plan.push({ kind: 'book', item, at: position.get(item) });
      continue;
    }
    const folder = dirOf(pathOf(item));
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(item);
  }

  for (const [folder, pieces] of byFolder) {
    /* Within a folder, by work: two novels saved into one folder are two
     * books. Saved pages with no work to read off their names still belong
     * together -- they are pages of something, and the folder is the best
     * evidence of what. */
    const byWork = new Map();
    for (const item of pieces) {
      const key = workOf(pathOf(item)) || '\u0000';
      if (!byWork.has(key)) byWork.set(key, []);
      byWork.get(key).push(item);
    }

    /* Saved pages that name no work they belong to.
     *
     * The conversion script this replaces put every saved page into one
     * volume unless told otherwise, and that is the right default: a folder
     * of saved pages is somebody's copy of one serial. So a page whose name
     * gives nothing away joins the work the rest of the folder is -- unless
     * the folder plainly holds two works, when there is no telling which. */
    const isPage = (item) => formatName(pathOf(item)) === 'MHT';
    const works = [...byWork.entries()];
    const big = works.filter(([, members]) => members.length >= 2 && members.every(isPage));
    const lonePages = works.filter(([, members]) => members.length === 1 && isPage(members[0]));
    if (lonePages.length && big.length <= 1) {
      const into = big.length ? big[0][0] : '\u0000pages';
      if (!byWork.has(into)) byWork.set(into, []);
      for (const [key, [item]] of lonePages) {
        byWork.delete(key);
        byWork.get(into).push(item);
      }
    }

    for (const [key, members] of byWork) {
      const pages = members.every((item) => formatName(pathOf(item)) === 'MHT');
      /* A lone file is a book, not a one-chapter work. And text files are
       * only chapters when their names say they are chapters -- a shared
       * title and a number is not enough. "Volume 2.txt" and "Volume 10.txt"
       * share both and are two whole books; joining volumes is what the
       * workshop is for, and it asks. */
      const chapters = members.length >= 2 && (pages
        || members.filter((item) => soundsLikeAChapter(pathOf(item))).length
          >= Math.ceil(members.length / 2));

      if (!chapters) {
        for (const item of members) plan.push({ kind: 'book', item, at: position.get(item) });
        continue;
      }

      const ordered = inReadingOrder(members, (item) => pathOf(item));
      plan.push({
        kind: 'chapters',
        title: titleFor(ordered.map((item) => pathOf(item)), folder),
        folder,
        items: ordered,
        at: Math.min(...members.map((item) => position.get(item))),
      });
    }
  }

  return plan.sort((a, b) => a.at - b.at);
}

/**
 * The name of a book that arrived in pieces.
 *
 * The title the files share, where they share one; otherwise the folder they
 * were in, which is what somebody named it when they saved it.
 */
function titleFor(paths, folder) {
  const shared = commonLabel(paths);
  // A label that is only a chapter word is no title at all.
  if (shared && !/^(chapter|ch|ep|episode|part|\d+)$/i.test(shared)) return shared;
  const leaf = folder ? leafOf(folder) : '';
  return leaf || shared || 'Chapters';
}

const FORMAT_OF = {
  epub: 'EPUB', pdf: 'PDF', cbz: 'CBZ', fb2: 'FB2',
  mht: 'MHT', mhtml: 'MHT',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML',
  txt: 'TXT', md: 'MD', markdown: 'MD',
};
const formatName = (name) => FORMAT_OF[extensionOf(name)] || 'OTHER';

export const isWholeBook = (name) => WHOLE.has(formatName(name));

/* ── comics that arrive as folders ───────────────────────────────────── */

const PICTURE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

/** Whether a folder name is a chapter or a volume rather than a title. */
const looksNumbered = (name) => /^\s*(?:vol(?:ume)?|v|ch(?:apter)?|ep(?:isode)?|part|book|season|s)\.?\s*\d+/i.test(name)
  || /^\s*\d+(\s|$|[.\-_])/.test(name)
  || chapterNumber(name) != null;

/**
 * The comics in a zip of pictures, and their chapters.
 *
 * A manga series is downloaded as a folder per chapter, and the importer read
 * the whole lot as one chapter called "Pages" -- two thousand four hundred
 * pictures with nowhere to stop, nothing in the index, and no way back to
 * chapter thirty except scrolling. Each folder of pictures is a chapter.
 *
 * And a zip holding two series side by side is two comics, each with its own
 * chapters, rather than one comic whose chapter list runs from the first
 * series into the second. Told apart by their names: top-level folders called
 * "Vol 1", "Vol 2" are volumes of one thing; folders called something else
 * are separate things.
 *
 * @param paths  every picture's path in the archive.
 * @returns [{ title, prefix, chapters: [{ title, folder }] }]
 */
export function planComics(paths, fallbackTitle) {
  const pictures = paths.filter((p) => PICTURE.test(p));
  const folders = [...new Set(pictures.map(dirOf))];

  // A shared wrapper folder is not a level of anything.
  const root = sharedRoot(folders);
  const strip = (folder) => (root ? folder.slice(root.length).replace(/^\//, '') : folder);

  const relative = folders.map((folder) => ({ folder, rel: strip(folder) }));
  const nested = relative.some(({ rel }) => rel.includes('/'));
  const tops = [...new Set(relative.map(({ rel }) => rel.split('/')[0]).filter(Boolean))];

  const chaptersOf = (members) => members
    .sort((a, b) => naturalOrder(a.rel, b.rel))
    .map(({ folder, rel }) => ({
      folder,
      title: rel ? rel.split('/').join(' · ') : (root ? leafOf(root) : fallbackTitle),
    }));

  const separate = nested && tops.length > 1 && !tops.every(looksNumbered);
  if (!separate) {
    return [{
      title: root ? leafOf(root) : fallbackTitle,
      prefix: root,
      chapters: chaptersOf(relative),
    }];
  }

  return tops.sort(naturalOrder).map((top) => {
    const members = relative.filter(({ rel }) => rel === top || rel.startsWith(`${top}/`));
    return {
      title: top,
      prefix: root ? `${root}/${top}` : top,
      chapters: members
        .sort((a, b) => naturalOrder(a.rel, b.rel))
        .map(({ folder, rel }) => ({
          folder,
          title: rel === top ? top : rel.slice(top.length + 1).split('/').join(' · '),
        })),
    };
  });
}

function sharedRoot(folders) {
  if (!folders.length) return '';
  if (folders.length === 1) return folders[0];
  const split = folders.map((f) => (f ? f.split('/') : []));
  const shared = [];
  for (let i = 0; ; i++) {
    const part = split[0][i];
    if (part == null || split.some((s) => s[i] !== part)) break;
    shared.push(part);
  }
  return shared.join('/');
}
