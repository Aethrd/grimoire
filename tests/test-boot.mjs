import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

/* The cheapest test in the suite and, twice now, the one that would have
 * caught the worst bug.
 *
 * A missing helper or a const referenced before its initialiser is a
 * whole-app failure -- a blank screen, not a broken button -- and neither
 * shows up in `node --check`, which only parses. Loading every module and
 * calling the entry points catches both in about a second. */

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

const MODULES = ['store', 'theme', 'blobs', 'parse', 'reader', 'library',
                 'screens', 'panels', 'translate', 'app'];

console.log('modules load');

for (const name of MODULES) {
  await t(`${name}.js`, async () => {
    await import(new URL(`../app/src/main/assets/www/js/${name}.js`, import.meta.url).href);
  });
}

console.log('entry points run');

const library = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);
const panels = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);
const screens = await import(new URL('../app/src/main/assets/www/js/screens.js', import.meta.url).href);

await t('the shelf renders with an empty library', async () => {
  // renderShelf calls several helpers that slice-based edits have twice
  // deleted outright. Any missing one throws here.
  await library.renderShelf({ onOpen() {}, onLongPress() {}, selection: new Set() });
  assert.ok(document.getElementById('shelf'));
});

await t('every settings pane renders without throwing', async () => {
  for (const pane of ['text', 'layout', 'theme', 'behaviour', 'translation', 'data']) {
    await panels.openSettings(() => {});
    const button = [...document.getElementById('settings-strip').children]
      .find((b) => b.dataset.pane === pane);
    button.onclick();
    await new Promise((r) => setTimeout(r, 60));
    const html = document.getElementById('settings-body').innerHTML;
    assert.ok(html.length > 40, `the ${pane} pane rendered ${html.length} chars`);
  }
});

await t('the folders screen renders', async () => {
  await panels.openFolders(() => {});
  assert.ok(document.getElementById('folders-list').children.length >= 1);
});

await t('the stats screen renders with no reading history', async () => {
  await panels.openStats();
  assert.ok(document.getElementById('stats-body').innerHTML.length > 100);
});

await t('the sort sheet renders and previews', async () => {
  await screens.openSort();
  assert.ok(document.getElementById('sort-keys').children.length > 0);
});

console.log(`\n${pass} assertions passed`);
