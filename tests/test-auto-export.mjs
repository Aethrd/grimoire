/* The automatic export of loose files into a folder is gone: the export of
 * zips is the export. One left switched on, or with an export waiting on
 * the queue (as it kept running after being turned off), does nothing
 * now: its settings are dropped, nothing is written, and Settings no longer
 * shows it. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const store = await import(www('store.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const written = [];
window.GrimoireNative = globalThis.GrimoireNative = {
  // An older app's calls, if anything still made them.
  writeAutoExport: (...args) => written.push(args),
  autoExportFolderName: () => 'Books',
};

await store.add('books', { title: 'Alpha', fingerprint: 'alpha:1', addedAt: 1, chapters: 1, words: 10, folder: 'not slop' });
// As it was left: off, but with an export waiting on the queue.
await store.saveSettings({ autoExport: { every: null, update: true, pending: true, lastAt: 1, files: {} } });

await import(www('app.js'));
await sleep(400);
const panels = await import(www('panels.js'));

await t('its leftover settings are dropped: nothing waits on the queue to export', async () => {
  for (let i = 0; i < 40 && (await store.settings()).autoExport; i += 1) await sleep(25);
  assert.ok(!(await store.settings()).autoExport, JSON.stringify((await store.settings()).autoExport));
  assert.equal(written.length, 0);
});

await t('Settings no longer offers it; the app and the native side have no part of it left', async () => {
  const host = window.document.createElement('div');
  await panels.openData(() => {}, host);
  assert.ok(!host.querySelector('.auto-export'), 'Automatic export still in Settings');
  assert.ok(!/Automatic export/.test(host.textContent));
  const app = read('app/src/main/assets/www/js/app.js');
  assert.ok(!/autoExport\.(afterQueue|start|run)\(/.test(app), 'still run from somewhere');
  const bridge = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.ok(!/writeAutoExport|deleteAutoExport|chooseAutoExportFolder/.test(bridge), 'still on the bridge');
  // The folder it held is let go of, unless the backups or a zip export use it.
  const activity = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(activity, /forgetAutoExportFolder\(\);/);
  assert.match(activity, /if \(saved\.equals\(prefs\.getString\(BACKUP_TREE, null\)\) \|\| saved\.equals\(prefs\.getString\(EXPORT_SET_TREE, null\)\)\) return;/);
});

console.log(`\n${pass} checks passed`);
process.exit(0);
