import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('app/src/main/assets/www/css/app.css');
const html = read('app/src/main/assets/www/index.html');
const library = read('app/src/main/assets/www/js/library.js');
const app = read('app/src/main/assets/www/js/app.js');

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok  ' + name); pass++; };

const rule = (selector) => {
  const at = css.indexOf(selector + ' ');
  const start = css.indexOf('{', at === -1 ? css.indexOf(selector) : at);
  return css.slice(start, css.indexOf('}', start));
};

console.log('cover geometry');

t('covers are a fixed ratio that content cannot override', () => {
  // aspect-ratio only sets a *preferred* size. An in-flow child taller than
  // the ratio allows stretches the box, which is how a long title used to
  // make one tile taller than its neighbour.
  const cover = rule('.tile-cover');
  assert.match(cover, /aspect-ratio:\s*2\s*\/\s*3/);
  assert.match(cover, /min-height:\s*0/,
    'without min-height:0 the automatic minimum size beats aspect-ratio');
  assert.match(cover, /overflow:\s*hidden/);
});

t('nothing inside a cover is in flow', () => {
  // Everything positioned absolutely, so no amount of text changes the size.
  for (const selector of ['.tile-title', '.tile-badge', '.tile-bar']) {
    assert.match(rule(selector), /position:\s*absolute/,
      `${selector} is in flow and can stretch the tile`);
  }
});

t('long titles are clamped rather than allowed to run', () => {
  assert.match(rule('.tile-title'), /line-clamp/);
});

t('the typeset title is only drawn when there is no cover art', () => {
  // It used to be rendered unconditionally, after the <img>, so every real
  // cover had its title painted over the top of it.
  // The two are branches of one ternary: cover art, or the typeset fallback,
  // never both stacked on top of each other.
  assert.match(library,
    /coverUrl[\s\S]{0,20}\?[\s\S]{0,140}<img[\s\S]{0,120}:[\s\S]{0,80}tile-title/,
    'the cover image and the typeset title are not exclusive branches');
});

t('images fill the cover box without distorting', () => {
  assert.match(rule('.tile-cover img'), /object-fit:\s*cover/);
});

console.log('selection');

t('long press selects rather than opening a typed menu', () => {
  assert.ok(!/prompt\(/.test(app), 'app.js still asks the user to type a choice');
  assert.match(app, /function onTileHold/);
  assert.match(app, /const selection = new Set\(\)/);
});

t('actions are labelled, not a row of bare glyphs', () => {
  // One of them is a bin. Making someone tap to find out what a glyph does is
  // not acceptable when that is a possible outcome.
  const grid = html.slice(html.indexOf('id="select-actions"'), html.indexOf('id="confirm-bar"'));
  const acts = [...grid.matchAll(/data-act="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts,
    ['open', 'folder', 'status', 'bundle', 'merge', 'export', 'details', 'vault', 'delete']);
  // Every one carries a text label beside its icon.
  assert.equal((grid.match(/<span>/g) || []).length, acts.length);
  assert.ok(html.includes('id="select-all"') && html.includes('id="select-cancel"'));
});

t('every cover shows a tick while selecting', () => {
  // Without outlines on the unselected ones there is nothing to say the mode
  // is on except the header.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /selecting \? '<span class="tile-check"/);
  assert.match(css, /\.tile\.selected \.tile-check/);
});

t('selection is a mode you leave deliberately', () => {
  // Deselecting the last book used to drop you out, which loses your place in
  // a long shelf halfway through picking.
  assert.match(app, /let selectMode = false/);
  assert.match(app, /function selecting\(\) \{ return selectMode; \}/);
  const tap = app.slice(app.indexOf('function onTileTap'), app.indexOf('function onTileHold'));
  assert.ok(!/selection\.size === 0/.test(tap), 'tapping to zero still exits the mode');
});

t('one-book actions are disabled for a batch rather than hidden', () => {
  // A control that vanishes is a control you go looking for.
  assert.match(app, /button\.disabled = single \? count !== 1 : count === 0/);
});

t('moving to an existing folder needs no typing', () => {
  // The sheet lists folders already in use; the text field is only for a new
  // one, which is the only case where typing is unavoidable.
  assert.match(app, /library\.folderCounts\(\)/);
  assert.match(library, /export async function folderCounts/);
  assert.match(app, /button\.onclick = \(\) => moveTo\(folder\)/);
});

t('deleting several books is confirmed in the app, not by a system dialog', () => {
  assert.ok(!/confirm\(/.test(app), 'app.js uses a native confirm dialog');
  assert.ok(html.includes('id="confirm-bar"'));
  assert.match(app, /Delete \$\{selection\.size\}/);
});

t('selection is a mode that back leaves before the screen', () => {
  const onBack = app.slice(app.indexOf('onBack()'), app.indexOf('openExternalBook'));
  assert.match(onBack, /clearSelection\(\)/);
  // And it must be cleared before back() is even considered.
  assert.ok(onBack.indexOf('clearSelection') < onBack.indexOf('return back()'));
});

t('the tab bar gives way to the action grid', () => {
  assert.match(app, /el\('select-actions'\)\.hidden = !on/);
  assert.match(app, /el\('tabbar'\)\.hidden = on \|\| current === 'reader'/);
  // And the library header swaps for a selection header, as the references do.
  assert.match(app, /el\('select-head'\)\.hidden = !on/);
  assert.match(app, /el\('library-head'\)\.hidden = on/);
});

t('leaving the library ends selection', () => {
  // The bar would otherwise refer to books that are no longer on screen.
  assert.match(app, /if \(name !== 'library'\) clearSelection\(\)/);
});

console.log('details');

t('a single selection can have its metadata corrected by hand', () => {
  // Scraped EPUB metadata is frequently wrong, and fixing it should not mean
  // re-making the file.
  assert.match(app, /async function openDetails\(book\)/);
  for (const field of ['title', 'author', 'series', 'seriesIndex', 'folder', 'lang']) {
    assert.ok(app.includes(`['${field}',`), `no ${field} field in the details sheet`);
  }
  assert.match(app, /details-cover-pick/);
  assert.match(app, /newCover = null/, 'a cover cannot be removed, only replaced');
});

t('the status action opens a picker, not a toggle', () => {
  // Read-or-unread is two of five states, and a two-way toggle cannot reach
  // the other three.
  assert.match(app, /status: \(\) => openStatusSheet\(\)/);
  assert.match(app, /async function openStatusSheet/);
  // A shared state is ticked, so a batch shows what it already is.
  assert.match(app, /current\.size === 1 && current\.has\(value\)/);
});

t('renaming a book drops its stale translated title', () => {
  // The cached translation was made from the old text.
  const save = app.slice(app.indexOf("details-save"), app.indexOf('Details saved'));
  assert.match(save, /translate\.clearCache\(book\.id\)/);
});

t('a refresh redraws the same covers rather than reloading them', () => {
  // Releasing and re-minting every URL meant the browser decoding a hundred
  // and forty images again, and until they landed every tile was a
  // placeholder rectangle. That is the flash.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /const covers = urlCache\(\)/);
  assert.ok(!/covers\.release\(\)/.test(library), 'the covers are still released on every render');
  // Only URLs for books that have left the shelf are released, and only after
  // the render, so nothing on screen is ever revoked.
  assert.match(library, /covers\.forget\(new Set/);
  assert.match(library, /Only after the render/);
  // The signature lives on the record: a stored Blob comes back as a new
  // object every time, so identity is no use.
  assert.match(library, /book\.coverBytes \?\? book\.coverBlob\?\.size/);
  // And the minting still lives in one place, where it can be released.
  const blobs = read('app/src/main/assets/www/js/blobs.js');
  assert.match(blobs, /export function urlCache/);
});

t('nothing waiting for an image looks like a light box', () => {
  // A shelf of pale rectangles reads as a flash every time the list redraws.
  assert.match(rule('.tile-cover'), /background: var\(--surface\)/);
  // The accent stays where it is the cover rather than a stand-in for one.
  assert.match(css, /\.tile-cover:not\(:has\(img\)\) \{ background: var\(--accent-300\)/);
  // And the tiles no longer animate in on every redraw.
  assert.ok(!/\.shelf \.tile \{ animation: tile-in/.test(css));
  assert.match(css, /@keyframes cover-in/);
});

console.log('regressions');

t('nothing inside a tile is left inline', () => {
  // A <button> and the spans inside it are inline by default, and
  // aspect-ratio does not apply to a non-replaced inline box. Leaving them
  // inline collapsed every cover and flowed the grid sideways as text.
  for (const selector of ['.tile', '.tile-cover', '.tile-meta']) {
    assert.match(rule(selector), /display:\s*block/,
      `${selector} is inline; the cover will collapse`);
  }
});

t('the continue card follows the last book opened', () => {
  const library = read('app/src/main/assets/www/js/library.js');
  const filter = library.slice(library.indexOf('const candidates'), library.indexOf('.sort('));
  assert.ok(!/percent/.test(filter),
    'a book you opened but did not page through is still excluded');
  assert.match(library, /openedAt\(b\) && !\['finished', 'dropped', 'onHold'\]\.includes\(statusOf\(b\)\)/);
  // And opening a book records that it was opened.
  assert.match(app, /book\.lastOpenedAt = Date\.now\(\)/);
});

t('translated titles reach the tile and the continue card', () => {
  // Patching a .tile-title node did nothing for any book with cover art,
  // because that element is only rendered as the no-cover fallback.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /export const displayTitle/);
  assert.match(library, /el\('continue-title'\)\.textContent = displayTitle\(book\)/);
  assert.ok(!/querySelector\(`\[data-book/.test(library),
    'still patching a DOM node that may not exist');
});

t('back leaves a tab for the shelf rather than the app', () => {
  // Tabs replace rather than stack, so there was nothing to pop and back
  // fell straight through to the system.
  const fn = app.slice(app.indexOf('function back()'), app.indexOf('stack.pop()'));
  assert.match(fn, /TABS\.includes\(current\) && current !== 'library'/);
});

t('importing reports progress rather than a silent wait', () => {
  assert.match(html, /id="import-progress"/);
  assert.match(app, /el\('import-bar'\)\.style\.width/);
  assert.match(app, /onProgress: \(message, fraction, done, total\)/);
});

t('a long author name cannot widen its column', () => {
  // Grid items default to min-width:auto, which is min-content. The author
  // line is nowrap, so one long name used to blow its column past its 1fr
  // share and push the whole grid off the side of the screen.
  assert.match(rule('.tile'), /min-width:\s*0/);
});

t('the title is shown under the cover, not only inside it', () => {
  // Drawn only inside the cover, it was invisible for every book that had
  // cover art — which is nearly all of them.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /class="tile-name\$\{/);
  assert.match(rule('.tile-name'), /line-clamp/);
});

t('a literal "<unknown>" author is not shown as one', () => {
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /function cleanAuthor/);
  assert.match(library, /\^<\?unknown>\?\$/);
});

t('folders have their own tab and filter the shelf', () => {
  assert.match(html, /data-screen="folders"/);
  assert.match(html, /data-go="folders"/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /export async function openFolders/);
  // Nested folders count towards their parent.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /startsWith\(`\$\{folder\}\/`\)/);
});

t('a swipe has to be long and flat to change tabs', () => {
  // A shelf is a tall scrolling grid; a flick down with any lean to it was
  // changing screens.
  const swipe = app.slice(app.indexOf('function wireSwipeBetweenTabs'), app.indexOf('function wireChrome'));
  assert.match(swipe, /Math\.abs\(dx\) < 110/);
  assert.match(swipe, /Math\.abs\(dy\) > 45/);
  assert.match(swipe, /Math\.abs\(dy\) \* 3/);
});

t('importing writes each book in whole transactions', () => {
  // A transaction per chapter meant hundreds per book.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /store\.putAll\('chapters'/);
  assert.match(library, /store\.putAll\('images'/);
  const store = read('app/src/main/assets/www/js/store.js');
  assert.match(store, /export async function putAll/);
});

t('a vault with no passphrase does not swallow books', () => {
  // Marking a book for the vault before setting one up hid it from the shelf
  // and left it reachable only from a screen that demands a passphrase which
  // does not exist.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /export let vaultUnlocked = true/);
  assert.match(library, /export async function initVaultGate/);
  assert.match(app, /await library\.initVaultGate\(\)/);
  // And the action refuses rather than hiding them behind a lock that is not
  // there.
  const vault = app.slice(app.indexOf('vault: async'), app.indexOf('delete: ()'));
  assert.match(vault, /!settings\.vaultPassphrase/);
});

t('a failed translation says why instead of nothing', () => {
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /onNotice\?\.\(error\.message\)/);
  assert.match(app, /onNotice: \(message\) => toast/);
});

t('a new sort key takes priority rather than going last', () => {
  // Appended, it sat behind every existing key and changed nothing visible --
  // which reads exactly like sorting being broken.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /draft\.keys\.unshift\(\[key, 'asc'\]\)/);
});

t('the toast keeps clear of the reader controls', () => {
  // At the bottom it landed on the Copy chapter button it was reporting on.
  assert.match(css, /\[data-view="reader"\] \.toast/);
  assert.match(app, /document\.body\.dataset\.view = name/);
});

t('only one screen can be active at a time', () => {
  // <body data-screen="folders"> made document.querySelector('[data-screen=…]')
  // match the body instead of the section, so screens stopped being switched
  // off and piled up on top of each other. The lookup is scoped now, and the
  // body uses a different attribute.
  assert.match(app, /getElementById\('screens'\)\.querySelector/);
  assert.ok(!/document\.body\.dataset\.screen/.test(app),
    'the body shares an attribute name with the screen sections again');
});

t('a translation that cannot run says so', () => {
  // Switched on but with no engine set up returned silently, which is
  // indistinguishable from translation being broken.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /no engine is set up/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Test translation/);
});

t('saving a view is not the loudest thing on the sort screen', () => {
  const sortScreen = html.slice(html.indexOf('data-screen="sort"'), html.indexOf('data-screen="reader"'));
  const header = sortScreen.slice(0, sortScreen.indexOf('</header>'));
  assert.ok(!/sort-save/.test(header), 'still in the header, where the eye lands first');
  assert.match(sortScreen, /class="link-btn" id="sort-save"/);
});

t('the shelf remembers how it was arranged', () => {
  // Sort keys and grouping were already persisted; the folder filter was a
  // module variable and forgotten on every launch.
  const store = read('app/src/main/assets/www/js/store.js');
  assert.match(store, /shelfFolder: null/);
  assert.match(app, /store\.saveSettings\(\{ shelfFolder: folder \}\)/);
  assert.match(app, /activeFolder = settings\.shelfFolder/);
});

t('a filter that survives a relaunch can be cleared from the shelf', () => {
  // Otherwise "why can I only see nine books" is answered two screens away.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /onClearFolder/);
  assert.match(app, /onClearFolder: \(\) => openFolder\(null\)/);
  // And clearing has to re-render: show() returns early when the screen is
  // already the one showing.
  assert.match(app, /if \(current === 'library'\) await refreshShelf\(\)/);
});

t('a half-imported book is neither shown nor kept', () => {
  // Images are written as they are extracted now, so the book row exists
  // before its chapters do. A hard kill in the middle used to leave that row
  // on the shelf as a book with nothing in it.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /!b\.importing && !b\.transient/);
  assert.match(library, /export async function sweepUnfinishedImports/);
  assert.match(app, /await library\.sweepUnfinishedImports\(\)/);
  // And a failure during parse cleans up after itself rather than waiting
  // for the next launch.
  assert.match(library, /await store\.deleteBook\(bookId\)\.catch/);
});

t('the picture reel opens where you are, not where the last book was', () => {
  // The grid element outlives the pictures in it, so it kept whatever offset
  // the last book left behind -- and the filters were kept too, so a volume
  // chosen in one book could leave the next one looking empty.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /const changedBook = reelBook !== bookId/);
  assert.match(screens, /reelVolume = null;\n    reelFilter = 'all';/);
  // Opened at the part being read, which is per-book by definition.
  assert.match(screens, /image\.chapterIndex >= readingAt/);
  assert.match(screens, /target\.offsetTop - grid\.clientHeight \/ 3/);
});

t('the index opens where you are, not where the last book was', () => {
  // The list is rebuilt on every open but the container is not, so it kept
  // whatever offset the previous book left behind: open the index on chapter
  // 50 of one book and you land at 50 in the next one too.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /function revealCurrentChapter/);
  assert.match(screens, /list\.querySelector\('\.list-row\.current'\)/);
  // Marks are a different list, and start at the top.
  assert.match(screens, /list\.scrollTop = 0;\n\n  \/\/ Bookmarks and highlights/);
});

t('translated text is marked wherever it appears', () => {
  // Machine translation is a guess, and a good one is easy to mistake for the
  // author's own words.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /export const isTranslatedTitle/);
  assert.match(library, /tile-name\$\{isTranslatedTitle\(book\) \? ' translated-text'/);
  assert.match(library, /continue-title'\)\.classList\.toggle\('translated-text'/);

  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /export function isTranslatedName/);
  assert.match(reader, /'chapter translated'/);

  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /isTranslatedName\(chapter\.index\) \? 'translated-text'/);
});

t('only the chapter name is tinted in the reader header', () => {
  // The page numbers beside it are not a translation of anything.
  const paint = app.slice(app.indexOf('function paintReader'), app.indexOf('reader-pos\').innerHTML'));
  assert.ok(!/classList\.toggle\('translated-text'/.test(paint),
    'the whole position line is tinted');
  assert.match(app, /<span class="translated-text">\$\{escapeText\(name\)\}/);
});

t('a chapter of translated body text is legible, not a gradient', () => {
  // A gradient over a thousand words is unreadable, and colour far from the
  // body ink is tiring to read for long.
  const rule = css.slice(css.indexOf('.page-flow .chapter.translated {'));
  assert.ok(!/linear-gradient/.test(rule.slice(0, 200)));
  assert.match(rule.slice(0, 200), /--read-ink/);
  // And it says what it is.
  assert.match(css, /content: "Machine translation"/);
});

t('the gradient degrades to a flat tint where it is unsupported', () => {
  // background-clip on text with a transparent fill leaves invisible text
  // anywhere it is not supported.
  assert.match(css, /@supports not \(\(-webkit-background-clip: text\)/);
});

t('status is more than read or unread, and can be reverted', () => {
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /export const STATUSES/);
  for (const state of ['reading', 'unread', 'onHold', 'dropped', 'finished']) {
    assert.ok(library.includes(`'${state}'`), `no ${state} state`);
  }
  // Automatic is the revert: it clears what was set rather than picking one.
  assert.match(app, /if \(status === null\) delete book\.status/);
  assert.match(app, /back to automatic/);
  // Offered only when there is something to revert.
  assert.match(app, /if \(pinned\) \{/);
  assert.ok(html.includes('id="status-sheet"'));
});

t('a book put aside is not offered as the one to continue', () => {
  // Finished, dropped and on hold are all "not what I am reading next",
  // whatever the dates say.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /\['finished', 'dropped', 'onHold'\]\.includes\(statusOf\(b\)\)/);
});

t('search resets when opened from the shelf', () => {
  // initFind runs on every visit but only re-registered handlers, so the
  // field kept the last query while the list showed that query's results
  // from whatever was open at the time.
  const screens = read('app/src/main/assets/www/js/screens.js');
  // Told which screen it was opened from, not left to infer it: the reader
  // keeps its book so reading can be resumed, so "has a book ever been
  // opened" is true forever and search never left in-book mode.
  assert.match(screens, /const inBook = fromReader && !!reader\.state\.book/);
  assert.match(app, /screens\.initFind\(goToMatch, cameFrom === 'reader'\)/);
  assert.match(screens, /if \(!inBook\) \{[\s\S]{0,400}input\.value = ''/);
  // Inside a book the query and the stepper's place are kept, which is the
  // point of being able to dismiss and come back.
  assert.match(screens, /input\.focus\(\)/);
});

t('the scopes suit what is being searched', () => {
  // Whole book and this chapter mean nothing over a shelf; titles and authors
  // mean nothing inside a book.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /\['all', 'Everything'\], \['title', 'Titles'\], \['author', 'Authors'\]/);
  assert.match(screens, /\['names', 'Chapter names'\]/);
});

t('a title search matches the title as shown', () => {
  // Including a translated one: searching for what is on screen should find
  // it.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /library\.displayTitle\(b\)/);
  assert.match(screens, /if \(shelfScope === 'title'\) return titleMatches\(b\)/);
  assert.match(screens, /if \(shelfScope === 'author'\) return authorMatches\(b\)/);
});

t('chapter names are searchable inside a book', () => {
  // A book of a thousand chapters is not one you find your way around by
  // scrolling the index.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /if \(findScope === 'names'\)/);
  assert.match(screens, /reader\.chapterName\(c\.index\)/);
  // Both the shown name and the book's own, so a translated index still finds
  // the original.
  assert.match(screens, /foldDiacritics\(c\.title \|\| ''\)/);
});

t('search shows the same books the shelf does', () => {
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /!b\.importing && \(!b\.inVault \|\| vaultUnlocked\)/);
});

t('bundling is one action that reads both ways', () => {
  // Several books become a bundle; a bundle already selected comes apart.
  // Two buttons for something that is its own opposite is one too many.
  assert.match(app, /bundle: async/);
  assert.match(app, /taken out of/);
  assert.match(app, /Select two or more books to bundle/);
  // Unbundling releases every member, not only what was selected: a bundle
  // shows as one tile, so selecting it selects the leader alone.
  assert.match(app, /ids\.has\(b\.bundleId\)/);
  assert.ok(html.includes('data-act="bundle"'));
});

t('building is a tool, not a shelf action', () => {
  /* Joining books already on the shelf was the wrong shape for the job: the
   * parts of a serial are files, and importing thirty volumes in order to
   * join them and delete thirty leftovers is a lot of work to arrive where
   * you meant to start. */
  assert.ok(html.includes('data-go="workshop"'), 'the workshop has no way in');
  assert.ok(html.includes('data-screen="workshop"'));
  assert.match(app, /const TABS = \[.*'workshop'/);
  // Taking a built book apart still belongs beside the book.
  assert.match(app, /return splitSelected\(books\[0\]\)/);
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /export async function splitBook/);
  assert.match(app, /were still on the shelf/);
});

t('the workshop picker does not filter what it can take', () => {
  /* Android builds the picker from the MIME types in the accept list and
   * drops extensions it cannot map to one. A wildcard like image/* then
   * narrows the whole picker to images, which is why zips could not be chosen
   * once pictures were added. */
  const picker = app.slice(app.indexOf("picker.multiple = true"));
  assert.match(picker.slice(0, 1200), /picker\.accept = '\*\/\*'/);
  // What a file is comes from its first bytes, not from what it is called.
  const build = read('app/src/main/assets/www/js/build.js');
  assert.match(build, /named: await nameWithFormat\(file\.name \|\| 'file', file\)/);
  const parse = read('app/src/main/assets/www/js/parse.js');
  assert.match(parse, /starts\(0x89, 0x50, 0x4e, 0x47\)\) return `\$\{name\}\.png`/);
});

t('writing a book out is one of the things you do to a book', () => {
  // It was only inside the details sheet, which is a long press and a scroll
  // away -- far enough that it may as well not have been there.
  assert.ok(html.includes('data-act="export"'), 'no export action');
  assert.match(app, /export: async \(\) => \{/);
  // One book at a time, like Open and Details.
  assert.match(app, /act === 'open' \|\| act === 'details' \|\| act === 'export'/);
});

t('a settings pane does not wipe what it has already built', () => {
  /* This was `body.innerHTML = '<h2>Page turning</h2>'` partway down the
   * behaviour pane, which threw away everything appended above it --
   * annotations, reading guides, chapter ends, pictures, page breaks. All of
   * it was built and then discarded a line later, so none of those settings
   * had ever been visible. */
  const panels = read('app/src/main/assets/www/js/panels.js');
  const pane = panels.slice(panels.indexOf('async function renderBehaviourPane'));
  // Comments describing the bug are not the bug.
  const code = pane.slice(0, pane.indexOf('\n}'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/body\.innerHTML\s*=/.test(code),
    'the pane assigns innerHTML partway through and loses what came before');
});

t('a folder can be emptied or deleted as a folder', () => {
  /* It could always be done by filtering the shelf and selecting everything,
   * which is three steps and a chance for the filter not to be what you
   * thought. A folder knows what is in it. */
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /export function onFolderMenu/);
  assert.match(panels, /onFolderActions\?\.\(folder, label, count\)/);
  assert.match(app, /async function openFolderActions/);
  assert.ok(html.includes('id="folder-actions"'));

  // Taking the books out is not the same as destroying them, and both are
  // offered rather than only the dangerous one.
  assert.match(app, /Take the books out/);
  assert.match(app, /delete book\.folder/);

  // Deleting says how many and asks again, because there is no undo.
  assert.match(app, /Delete all \$\{count\}/);
  assert.match(app, /Really delete \$\{count\} book/);
  assert.match(app, /remove\.classList\.add\('danger'\)/);
});

t('select all means all of what is shown', () => {
  // Filtered to a folder, a "select all" that reaches past the filter is a
  // trap: the next thing pressed happens to books you cannot see.
  assert.match(app, /!activeFolder \|\| book\.folder === activeFolder/);
  assert.match(app, /!book\.importing && !book\.transient/);
});

t('the tap zone is read whichever way it was stored', () => {
  // The setting used to be a percentage and is now a fraction. Compared
  // against a fraction, 26 is never exceeded -- so the middle of the screen
  // was never the middle, and every tap anywhere turned the page.
  assert.match(app, /function sideZone/);
  assert.match(app, /raw > 1 \? raw \/ 100 : raw/);
  assert.match(app, /Math\.min\(0\.35, Math\.max\(0\.05, fraction\)\)/);
});

t('an exported book carries the title it was given', () => {
  // Renaming the file leaves the book still calling itself whatever it called
  // itself before, and every other reader shows that name.
  const epub = read('app/src/main/assets/www/js/epub.js');
  assert.match(epub, /title: \(title \?\? stored\.title\)/);
  assert.match(app, /function askAboutExport/);
  assert.ok(html.includes('id="export-title"'));
  assert.ok(html.includes('id="export-file"'));
});

t('the build button is not under the tab bar', () => {
  // Every other screen with a footer is reached from inside a book, where the
  // bar is hidden. On a screen that is itself a tab the button was drawn
  // underneath it and could not be pressed.
  assert.match(css, /\[data-screen="workshop"\] \.stepper \{/);
  assert.match(css, /margin-bottom: calc\(var\(--safe-bottom\) \+ var\(--tabbar-h\)\)/);
  assert.match(css, /--tabbar-h:/);
});

t('a long part name keeps the end that identifies it', () => {
  /* The end of a filename is where the volume number lives. Cutting there
   * leaves a list of parts that all read the same, and ordering them becomes
   * guesswork. */
  const at = app.indexOf('function shortenMiddle');
  assert.ok(at > -1);
  const shortenMiddle = eval(`(${app.slice(at, app.indexOf('function renderWorkshop')).trim()})`);

  /* The cut is placed around the last number, not at a fixed midpoint. A
   * blind middle cut turned "Volume 14" into "lume 14", which is worse than
   * useless in a list being put in order. */
  for (const [name, keep] of [
    ['That Time I Got Reincarnated as a Slime - Volume 14 (Complete Fan Translation).epub', 'Volume 14'],
    ['[Group] Solo Leveling - Chapter 0142 [Digital] [Cleaned+Redrawn].zip', 'Chapter 0142'],
    ["Omniscient Reader's Viewpoint - Side Story 03 - The Final Chapter of the Epilogue.epub", 'Story 03'],
  ]) {
    const short = shortenMiddle(name);
    assert.ok(short.length <= 64, `${short.length} characters`);
    assert.ok(short.includes(keep), `"${keep}" was cut out of: ${short}`);
    // The extension survives too, since that is what says how it will be read.
    assert.ok(short.endsWith(name.slice(name.lastIndexOf('.'))));
  }

  // A name with no number in it is still shortened, just not around one.
  const plain = shortenMiddle('A Book With No Number In Its Name At All Whatsoever Really Truly None.epub');
  assert.ok(plain.length <= 64);
  assert.ok(plain.startsWith('A Book With'));

  // A name that fits is left exactly as it is.
  assert.equal(shortenMiddle('Vol 3.epub'), 'Vol 3.epub');

  /* And the clamp has to allow what the shortening kept: at roughly thirty
   * characters to a line in this row, two lines would clip the tail the
   * shortening deliberately preserved. */
  const rule = css.slice(css.indexOf('.build-what b {'), css.indexOf('.build-what small'));
  assert.match(rule, /line-clamp: 3/);
});

t('the workshop shows the order and lets it be changed', () => {
  // Order is the whole point of a serial, so it is shown and movable rather
  // than inferred and hoped for.
  const build = read('app/src/main/assets/www/js/build.js');
  assert.match(build, /export function move/);
  assert.match(build, /export const naturalOrder/);
  assert.match(app, /function renderWorkshop/);
  assert.match(app, /build\.move\(part\.id, by\)/);
  // A zip of volumes becomes its contents, not one part joined to itself —
  // ordered among themselves, so two books cannot interleave.
  assert.match(build, /for \(const book of \[\.\.\.archive\.books\]\.sort/);
  assert.ok(!/found\.sort\(/.test(build), 'everything added is sorted together again');
  // A part that will not open costs that part, not the build.
  assert.match(build, /failed\.push\(\{ name: part\.name, reason: error\.message \}\)/);
});

t('a bundle asks which edition to open', () => {
  assert.match(app, /if \(book\.bundle\) return openBundleSheet/);
  // Language and format are what actually tell two editions apart.
  assert.match(app, /book\.lang \? book\.lang\.toUpperCase\(\) : null, book\.format/);
  assert.ok(html.includes('id="bundle-sheet"'));
});

t('a long title on the continue card wraps instead of being cut', () => {
  assert.match(rule('.continue-title'), /line-clamp: 2/);
  assert.ok(!/white-space: nowrap/.test(rule('.continue-title')));
});

t('opening records a different thing from reading', () => {
  const store = read('app/src/main/assets/www/js/store.js');
  // The position save marks the book opened, not read.
  assert.match(store, /book\.lastOpenedAt = Date\.now\(\)/);
  assert.match(store, /export async function markRead/);
  // Only real progress marks it read, and only once a session.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /function noteReading/);
  assert.match(reader, /store\.markRead\(state\.book\.id\)/);
  // Continue still follows what was opened, which is where you were.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /b\.lastOpenedAt \|\| b\.lastReadAt/);
});

t('a file opened from elsewhere is read, not collected', () => {
  // Opening something to look at it should not quietly add it to a library.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /transient = false/);
  assert.match(library, /!b\.importing && !b\.transient/);
  assert.match(app, /handleFiles\(\[file\], \{ transient: true \}\)/);
  // Closing the reader forgets it, rather than leaving it until a restart.
  assert.match(app, /async function forgetTransientBook/);
  assert.match(app, /await forgetTransientBook\(\)/);
  // And it says it is passing through, with a way to make it stay.
  assert.ok(html.includes('id="keep-book"'));
  assert.match(app, /delete book\.transient/);
  // Anything a crash leaves behind is swept.
  assert.match(library, /b\.importing \|\| b\.transient/);
});

t('exports go through the native side, not an anchor', () => {
  // A WebView has no download handling: no DownloadListener means an
  // <a download> click is ignored outright, so both export buttons did
  // nothing at all.
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /function offerDownload/);
  assert.match(panels, /window\.GrimoireNative\?\.saveText/);
  // Both buttons use it, and neither builds its own anchor any more.
  // Its definition plus its callers: the reading log and the settings export.
  // The full backup goes out through the file writer instead, which can save
  // to a folder rather than only share.
  assert.equal((panels.match(/offerDownload\(/g) || []).length, 3);
  assert.ok(!/a\.download = 'grimoire/.test(panels), 'an export still relies on an anchor');
  // A failure says so rather than looking like a dead button again.
  assert.match(panels, /That file could not be saved/);

  const java = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.match(java, /public boolean saveText/);
  // A name is a name, not a path: the page cannot write outside the one
  // directory the provider exposes.
  assert.match(java, /new File\(name == null \? "export\.txt" : name\)\.getName\(\)/);

  const manifest = read('app/src/main/AndroidManifest.xml');
  assert.match(manifest, /androidx\.core\.content\.FileProvider/);
  assert.match(manifest, /android:exported="false"/);
  const paths = read('app/src/main/res/xml/file_paths.xml');
  assert.match(paths, /<cache-path name="exports" path="exports\/" \/>/);
  // One directory inside the cache, and nothing else.
  assert.ok(!/<external-path|<root-path|<files-path/.test(paths));
});

t('a backup can be restored, not only written', () => {
  // An export with no way back in is a file you keep and never use.
  const store = read('app/src/main/assets/www/js/store.js');
  assert.match(store, /export async function exportBackup/);
  assert.match(store, /export async function importBackup/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Restore from a backup/);
  assert.match(panels, /store\.importBackup/);
  // And it says what could not be matched rather than reporting success.
  assert.match(panels, /not on the shelf yet/);
});

t('in-book search knows it came from a book', () => {
  // cameFrom was assigned after the screen had already changed, so it was
  // always the screen just arrived at -- and searching from inside a book
  // behaved as though it had come from the shelf.
  const show = app.slice(app.indexOf('async function show('), app.indexOf('await enter(name)'));
  assert.ok(show.indexOf('cameFrom = current') < show.indexOf('current = name'),
    'cameFrom is still recorded after the change');
});

t('a file opened from outside waits for the reader to be ready', () => {
  // Opening from a file manager is always a cold start, and the old fixed
  // delay landed on a window with no Grimoire on it.
  const main = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(main, /void onReaderReady/);
  assert.match(main, /private String pendingUri/);
  assert.ok(!/postDelayed\([^)]*openExternalBook/.test(main), 'still guessing at a delay');
  const bridge = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.match(bridge, /public void ready\(\)/);
  assert.match(app, /window\.GrimoireNative\?\.ready\?\.\(\)/);
  // A staging failure is reported rather than leaving the app silent.
  assert.match(main, /handoffFailed/);
  assert.match(app, /handoffFailed\(reason\)/);
});

t('the heat map is drawn from words, not pages', () => {
  // A page is a function of type size; the same chapter is thirty pages at
  // one setting and twelve at another, and a chapter read elsewhere is none.
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /\.map\(\(d\) => d\.words\)\.filter/);
  assert.match(panels, /words\.toLocaleString\(\)\} words/);
  // A continuous shade within each level, so a heavy day is not flattened
  // into the same step as a merely busy one.
  assert.match(panels, /cell\.style\.setProperty\('--fill'/);
  assert.match(css, /color-mix\(in srgb, var\(--heat-4\)/);
});

t('the averages hold up when reading happens elsewhere', () => {
  const panels = read('app/src/main/assets/www/js/panels.js');
  for (const label of ['Words a chapter', 'Words a book', 'Chapters a day', 'Read elsewhere']) {
    assert.ok(panels.includes(`'${label}'`), `no ${label} figure`);
  }
  // Copying a chapter out is recorded as reading, since that is what it is.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /async function recordCopiedChapter/);
  assert.match(reader, /elsewhere: true/);
});

t('the import log names the books, not just the total', () => {
  // An average hides the thing worth knowing: four minutes might be a hundred
  // books at two seconds each or one book at three minutes, and only one of
  // those is worth doing anything about.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /const perBook = \[\]/);
  for (const field of ['bytes', 'chapters', 'images', 'words', 'writeMs']) {
    assert.ok(library.includes(`${field}:`), `no ${field} recorded`);
  }
  // Slowest first, since that is where any further work belongs.
  assert.match(library, /perBook\.sort\(\(a, b\) => b\.ms - a\.ms\)/);
  // Kept as a history, so a change can be judged against what came before.
  assert.match(library, /importHistory/);
  const store = read('app/src/main/assets/www/js/store.js');
  assert.match(store, /imports: \(await settings\(\)\)\.importHistory/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Slowest/);
});

t('an import reports how long it took and where it went', () => {
  // A benchmark on a desktop is not evidence about a phone: jsdom parses XML
  // in JavaScript where a WebView uses Blink's native parser, so any figure
  // measured here overstates what parsing costs on the device. The only
  // numbers worth trusting are the ones the phone takes itself.
  const library = read('app/src/main/assets/www/js/library.js');
  assert.match(library, /const spent = \{ read: 0, parse: 0, write: 0 \}/);
  assert.match(library, /results\.elapsedMs = Date\.now\(\) - started/);
  // Kept, so one import can be compared with the next.
  assert.match(library, /lastImport:/);
  assert.match(app, /s a book/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Last import/);
  for (const phase of ['Reading the file', 'Parsing', 'Writing to storage']) {
    assert.ok(panels.includes(phase), `no ${phase} figure`);
  }
});

console.log('settings');

t('settings is a screen with panes, reachable from the bar', () => {
  assert.match(html, /data-screen="settings"/);
  assert.match(html, /data-go="settings"/);
  assert.match(app, /TABS = \['library', 'folders', 'workshop', 'sort', 'stats', 'settings'\]/);
});

t('the settings strip is labelled', () => {
  // Six unlabelled glyphs is a guessing game, and the pane people look for
  // first was behind an ambiguous grid icon.
  const strip = html.slice(html.indexOf('id="settings-strip"'), html.indexOf('id="settings-body"'));
  const labels = [...strip.matchAll(/<span>(\w+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Text', 'Layout', 'Theme', 'Behaviour', 'Translate', 'Vault']);
});

t('the strip offers no share and no text-to-speech', () => {
  // Both exist in the app this was modelled on; neither exists here, and a
  // button that leads nowhere is worse than a shorter strip.
  const strip = html.slice(html.indexOf('id="settings-strip"'), html.indexOf('id="settings-body"'));
  const panes = [...strip.matchAll(/data-pane="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(panes, ['text', 'layout', 'theme', 'behaviour', 'translation', 'data']);
  assert.ok(!/share|speak|sound|volume|tts/i.test(strip));
});

console.log(`\n${pass} assertions passed`);
