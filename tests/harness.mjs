// Boots the reader's modules under jsdom so the pure logic can be exercised
// without an emulator.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const WWW = new URL('../app/src/main/assets/www/', import.meta.url).pathname;

export async function boot() {
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://appassets.androidplatform.net/assets/www/index.html' });
  const { window } = dom;

  for (const key of ['window','document','Node','NodeFilter','DOMParser','Image','CSS',
                     'HTMLElement','customElements','getComputedStyle','requestAnimationFrame',
                     'matchMedia','Blob','File','FileReader','URL','navigator','localStorage']) {
    if (window[key] === undefined) continue;
    try { globalThis[key] = window[key]; }
    catch { Object.defineProperty(globalThis, key, { value: window[key], configurable: true }); }
  }
  globalThis.matchMedia = window.matchMedia || (() => ({ matches:false, addEventListener(){} }));
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.JSZip = (await import('jszip')).default;

  // jsdom has no IndexedDB, and the settings screens read their values from
  // it before rendering anything. Without this they throw and every pane
  // comes back empty, which is indistinguishable from a missing control.
  const fake = await import('fake-indexeddb');
  globalThis.indexedDB = fake.indexedDB;
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  window.indexedDB = fake.indexedDB;
  window.IDBKeyRange = fake.IDBKeyRange;
  // jsdom's Blob has no text(); removing it exercises the FileReader fallback.
  if (window.Blob?.prototype?.text) delete window.Blob.prototype.text;
  // jsdom implements neither half of the object-URL API. Tests that care
  // about URL lifetime replace these with counting versions.
  window.URL.createObjectURL ||= () => 'blob:stub/0';
  window.URL.revokeObjectURL ||= () => {};
  globalThis.URL.createObjectURL ||= window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL ||= window.URL.revokeObjectURL;
  return window;
}
