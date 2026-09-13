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

await t('navigating never leaves two screens on top of each other', async () => {
  // A body attribute colliding with the screen sections made the lookup match
  // the wrong element, so screens stopped being switched off. Every visible
  // symptom was in the rendering; nothing in the source looked wrong.
  const app = await import(new URL('../app/src/main/assets/www/js/app.js', import.meta.url).href);
  const screens = document.getElementById('screens');
  const active = () => [...screens.querySelectorAll('[data-screen]')]
    .filter((s) => s.hasAttribute('data-active')).map((s) => s.dataset.screen);

  for (const name of ['folders', 'workshop', 'sort', 'stats', 'settings', 'library', 'folders']) {
    const button = [...document.getElementById('tabbar').children]
      .find((b) => b.dataset.go === name);
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(active(), [name], `showing ${name} left ${active().join(' + ')} active`);
  }
});

await t('the reading desk returns you to where you opened it', async () => {
  /* The problem it answers: comparing three passages means jumping between
   * them, and every jump costs the place you were reading. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);

  const id = await store.add('books', { title: 'Desk', fingerprint: 'desk', addedAt: 9 });
  for (let i = 0; i < 20; i++) {
    await store.put('chapters', {
      bookId: id, index: i, title: `Chapter ${i}`, words: 100,
      html: `<p>Chapter ${i} opens with a sentence long enough to excerpt from.</p>`,
    });
  }
  await store.add('marks', { bookId: id, kind: 'bookmark', chapterIndex: 3, anchor: 0, at: Date.now() });
  await store.add('marks', {
    bookId: id, kind: 'highlight', chapterIndex: 7, anchor: 0, end: 10,
    note: 'Compare these two scenes', text: 'Chapter 7', at: Date.now(),
  });

  const tap = (name) => document.getElementById(name)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await reader.open(id);
  await reader.goTo({ chapter: 12, anchor: 0 });

  tap('desk-open');
  await new Promise((r) => setTimeout(r, 120));
  const groups = [...document.querySelectorAll('#desk-body .desk-group')];
  assert.deepEqual(groups.map((g) => g.querySelector('h3').textContent),
    ['Current', 'Pinned', 'Bookmarks', 'Notes']);

  tap('desk-pin');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(document.querySelectorAll('#desk-body .desk-group')[1]
    .querySelectorAll('.list-row').length, 1, 'the page was not pinned');

  // Jump somewhere else from the desk.
  document.querySelectorAll('#desk-body .desk-group')[2].querySelector('.list-row').onclick();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(reader.state.chapterIndex, 3);
  // The desk stays reachable, so a jump is never a one-way trip.
  assert.equal(document.getElementById('desk-tab').hidden, false);

  tap('desk-tab');
  await new Promise((r) => setTimeout(r, 100));
  tap('desk-close');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reader.state.chapterIndex, 12, 'closing did not put the reader back');
  // And the workspace is gone with it.
  assert.equal(document.getElementById('desk-tab').hidden, true);
});

console.log(`\n${pass} assertions passed`);
