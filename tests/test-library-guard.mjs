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
  const restarts = [];
  window.GrimoireNative = { libraryMark: () => 783, markLibrary: (n) => marks.push(n), libraryOnDisk: () => 8.1e9, restartApp: () => restarts.push(1) };
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

  await t('its files still on the phone: said so, and to wait -- never to restore and import', async () => {
    const box = window.document.querySelector('.library-missing');
    assert.match(box.textContent, /Their files are still on the phone \(8\.1 GB\)/);
    assert.match(box.textContent, /Do not import or restore anything while this shows/);
    assert.match(box.textContent, /looks again by itself/);
    assert.ok(!/restore your newest backup/i.test(box.textContent), 'told to restore while the books are only out of reach');
    // Restart starts the whole app again, not the page.
    box.querySelector('[data-retry]').click();
    assert.deepEqual(restarts, [1]);
    // Starting with no books asks twice, and says what it leaves.
    const empty = box.querySelector('[data-empty]');
    empty.click();
    assert.equal(empty.textContent, 'Sure? Tap again');
    assert.match(box.querySelector('.library-missing-look').textContent, /out of reach/);
    assert.deepEqual(marks, [], 'started with none on one tap');
  });

  // The files gone from the phone too; and a library that opens whole.
  for (const next of ['gone', 'whole']) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), next], { stdio: 'inherit' });
    assert.equal(run.status, 0, `the run "${next}" failed`);
  }
} else if (phase === 'gone') {
  window.GrimoireNative = { libraryMark: () => 783, markLibrary: (n) => marks.push(n), libraryOnDisk: () => 2e6 };
  globalThis.GrimoireNative = window.GrimoireNative;
  await import(www('app.js'));
  await new Promise((r) => setTimeout(r, 500));
  await t('its files gone from the phone as well: not "wait", but restore', async () => {
    const box = window.document.querySelector('.library-missing');
    assert.match(box.textContent, /Their files are no longer on the phone \(2 MB left\)/);
    assert.match(box.textContent, /Restore your newest backup/);
    assert.ok(!/looks again by itself/.test(box.textContent));
  });
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

  await t('its connection closed under it, the library is opened again and read -- not failed for good', async () => {
    await store.dropConnectionForTest();
    assert.equal(await store.countBooks(), 6);
    await store.dropConnectionForTest();
    await store.saveSettings({ shelfFolder: 'secret' });
    assert.equal((await store.settings()).shelfFolder, 'secret');
    await store.saveSettings({ shelfFolder: null });
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
    assert.equal(window.document.getElementById('export-many-resume').hidden, true, 'carry on offered with nothing to carry on');
  });

  await t('an export cut off is offered to carry on: what was saved, what is left, and from which zip', async () => {
    const all = await store.all('books');
    await store.saveSettings({ exportRun: { kind: 'everything', limitMB: 500, folder: 'Mythos books', base: 'Books', at: 1,
      order: all.map((b) => b.id), done: all.slice(0, 2).map((b) => b.id), zips: 1 } });
    const panels = await import(www('panels.js'));
    const host = window.document.createElement('div');
    await panels.openVault(() => {}, host);
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Export every book').click();
    for (let i = 0; i < 30 && window.document.getElementById('export-many-resume').hidden; i += 1) await new Promise((r) => setTimeout(r, 50));
    const note = window.document.getElementById('export-many-resume-note').textContent;
    assert.match(note, /^1 zip saved in “Mythos books”, 2 books in them; \d+ left\. Carrying on writes zip 2 onward \(the folder is asked for again\), 500 MB each\.$/);
    // Save, which starts afresh, not offered beside Carry on.
    assert.equal(window.document.getElementById('export-many-go').hidden, true, 'Save offered beside Carry on');
    // Started over: the record let go of, and Save back.
    window.document.getElementById('export-many-restart').click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await store.settings()).exportRun, null);
    assert.equal(window.document.getElementById('export-many-go').hidden, false);
    window.document.getElementById('export-many-cancel').click();
    // A record that is not one (from elsewhere, or damaged) is not acted on: no carrying on offered.
    await store.saveSettings({ exportRun: { v: 1, kind: 'everything', limitMB: 500, order: ['x'], done: [], zips: 1 } });
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Export every book').click();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(window.document.getElementById('export-many-resume').hidden, true, 'a damaged record offered to carry on');
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
