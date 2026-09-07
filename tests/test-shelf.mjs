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
  assert.deepEqual(acts, ['open', 'folder', 'status', 'details', 'vault', 'delete']);
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
  assert.match(library, /b\.lastReadAt && !\['finished', 'dropped', 'onHold'\]/);
  // And opening a book records that it was opened.
  assert.match(app, /book\.lastReadAt = Date\.now\(\)/);
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
  assert.match(library, /!b\.importing && \(!b\.inVault/);
  assert.match(library, /export async function sweepUnfinishedImports/);
  assert.match(app, /await library\.sweepUnfinishedImports\(\)/);
  // And a failure during parse cleans up after itself rather than waiting
  // for the next launch.
  assert.match(library, /await store\.deleteBook\(bookId\)\.catch/);
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
  assert.match(screens, /const inBook = !!reader\.state\.book/);
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

console.log('settings');

t('settings is a screen with panes, reachable from the bar', () => {
  assert.match(html, /data-screen="settings"/);
  assert.match(html, /data-go="settings"/);
  assert.match(app, /TABS = \['library', 'folders', 'sort', 'stats', 'settings'\]/);
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
