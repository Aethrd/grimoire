/* A library that opens empty is said as such, and nothing is written into it;
 * one that opens whole has its size noted outside the web storage; and every
 * book can be written out, hidden folders included. Two runs of the app, each
 * in its own process (a page boots once). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.mjs';

const phase = process.argv[2] || 'empty';
const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;
const store = await import(www('store.js'));
const marks = [];

if (phase === 'empty') {
  window.GrimoireNative = { libraryMark: () => 783, markLibrary: (n) => marks.push(n) };
  globalThis.GrimoireNative = window.GrimoireNative;
  await import(www('app.js'));
  await new Promise((r) => setTimeout(r, 500));

  await t('a library that had 783 books and opens empty says so, and writes nothing', async () => {
    const box = window.document.querySelector('.library-missing');
    assert.ok(box, 'no word that the library did not open');
    assert.match(box.textContent, /Your library did not open/);
    assert.match(box.textContent, /783 books/);
    assert.match(box.textContent, /Nothing has been changed/);
    // Nothing written: not the settings, not the size it had.
    assert.equal(await store.get('settings', 'app'), undefined);
    assert.deepEqual(marks, []);
  });

  // The second run: a library that opens whole.
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'whole'], { stdio: 'inherit' });
  assert.equal(run.status, 0, 'the run with a whole library failed');
} else {
  for (let i = 0; i < 6; i += 1) {
    await store.add('books', { title: `Book ${i}`, fingerprint: `b${i}.epub:${i}`, addedAt: i + 1, chapters: 1, folder: i < 2 ? 'secret' : '' });
  }
  await store.saveSettings({ hiddenFolders: ['secret'] });
  window.GrimoireNative = { libraryMark: () => 6, markLibrary: (n) => marks.push(n) };
  globalThis.GrimoireNative = window.GrimoireNative;
  await import(www('app.js'));
  await new Promise((r) => setTimeout(r, 600));

  await t('a library that opens whole is shown, and its size noted where a wiped web storage cannot take it', async () => {
    assert.equal(window.document.querySelector('.library-missing'), null);
    assert.ok(marks.includes(6), `noted ${JSON.stringify(marks)}`);
  });

  await t('Export every book takes the hidden folders too, which the shelf does not show', async () => {
    const panels = await import(www('panels.js'));
    const host = window.document.createElement('div');
    await panels.openVault(() => {}, host);
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Export every book');
    assert.ok(button, 'no Export every book in Settings');
    button.click();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(window.document.getElementById('export-many-sheet').hidden, false);
    assert.equal(window.document.getElementById('export-many-title').textContent, 'Write out 6 books');
    // Asked as a largest size, not a number of zips; remembered as 1 GB to begin with.
    const chips = [...window.document.querySelectorAll('#export-many-parts .chip')];
    assert.deepEqual(chips.map((c) => c.textContent), ['One zip', '2 GB', '1 GB', '500 MB', '250 MB', '100 MB']);
    assert.equal(chips.find((c) => c.getAttribute('aria-pressed') === 'true').textContent, '1 GB');
    chips.find((c) => c.textContent === '250 MB').click();
    assert.match(window.document.getElementById('export-many-note').textContent, /each under 250 MB/);
    window.document.getElementById('export-many-cancel').click();
  });

  await t('Your data in two halves: the backup (one file), then the books; settings alone folded away', async () => {
    const panels = await import(www('panels.js'));
    const host = window.document.createElement('div');
    await panels.openVault(() => {}, host);
    const text = host.textContent;
    const at = (words) => { const i = text.indexOf(words); assert.ok(i >= 0, `no ${words}`); return i; };
    assert.ok(at('Save a backup') < at('Restore from a backup'));
    assert.ok(at('Restore from a backup') < at('Export every book'), 'the books are not apart from the backup');
    const groups = [...host.querySelectorAll('.data-group')].map((g) => g.textContent);
    assert.deepEqual(groups, ['Backup', 'Books']);
    const folded = host.querySelector('details.settings-only');
    assert.ok(folded && !folded.open, 'settings only is not folded away');
    assert.ok(folded.querySelector('button') && [...folded.querySelectorAll('button')].some((b) => b.textContent === 'Import settings'));
  });
}

console.log(`\n${pass} checks passed (${phase})`);
process.exit(0);
