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

t('marking read and unread is one control, both ways', () => {
  // A one-way "mark as read" is half a control, and a shelf has both kinds.
  const status = app.slice(app.indexOf('status: async'), app.indexOf('vault: async'));
  assert.match(status, /anyUnfinished/);
  assert.match(status, /marked as unread/);
});

t('renaming a book drops its stale translated title', () => {
  // The cached translation was made from the old text.
  const save = app.slice(app.indexOf("details-save"), app.indexOf('Details saved'));
  assert.match(save, /translate\.clearCache\(book\.id\)/);
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
  assert.match(library, /lastReadAt && !b\.finishedAt/);
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

console.log('settings');

t('settings is a screen with panes, reachable from the bar', () => {
  assert.match(html, /data-screen="settings"/);
  assert.match(html, /data-go="settings"/);
  assert.match(app, /TABS = \['library', 'sort', 'stats', 'settings'\]/);
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
