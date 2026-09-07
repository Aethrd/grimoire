import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { boot } from './harness.mjs';

const window = await boot();
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const zipreader = await import(new URL('../app/src/main/assets/www/js/zipreader.js', import.meta.url).href);
const parse = await import(new URL('../app/src/main/assets/www/js/parse.js', import.meta.url).href);

let pass = 0;
const t = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

/* JSZip loads an entire archive before a single entry can be read. That is
 * unremarkable for a normal EPUB and fatal for a 463MB one: the app survived
 * importing that book alone and died on it in the middle of a shelf, which is
 * the shape of a heap with no room left rather than a broken file.
 *
 * A zip is random-access by design, so the directory is read from the tail
 * and entries are sliced out as they are wanted. */

async function build(entries, { store = false } = {}) {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body);
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: store ? 'STORE' : 'DEFLATE',
  });
  return new File([bytes], 'a.zip');
}

console.log('reading without loading');

await t('the directory lists every entry', async () => {
  const zip = await zipreader.openZip(await build({
    'a.txt': 'alpha', 'dir/b.txt': 'beta', 'dir/deep/c.txt': 'gamma',
  }));
  assert.ok(zip, 'the reader declined an ordinary archive');
  assert.deepEqual(zip.names().sort(), ['a.txt', 'dir/b.txt', 'dir/deep/c.txt']);
  // Directories are entries too, and are not files.
  assert.ok(!zip.names().some((n) => n.endsWith('/')));
});

await t('deflated entries come back intact', async () => {
  // Long enough that the compressor actually engages.
  const body = 'The quick brown fox. '.repeat(500);
  const zip = await zipreader.openZip(await build({ 'x.txt': body }));
  assert.equal(await zip.text('x.txt'), body);
});

await t('stored entries come back intact', async () => {
  const zip = await zipreader.openZip(await build({ 'x.txt': 'no compression' }, { store: true }));
  assert.equal(await zip.text('x.txt'), 'no compression');
});

await t('UTF-8 names and content survive', async () => {
  const zip = await zipreader.openZip(await build({ '한국어/책.txt': '마녀의 도시' }));
  assert.ok(zip.names().includes('한국어/책.txt'));
  assert.equal(await zip.text('한국어/책.txt'), '마녀의 도시');
});

await t('sizes are known without reading the entry', async () => {
  // This is what lets an 83MB illustration be skipped rather than allocated.
  const body = 'x'.repeat(50_000);
  const zip = await zipreader.openZip(await build({ 'big.txt': body }));
  assert.equal(zip.sizeOf('big.txt'), 50_000);
});

await t('a missing entry is null, not a throw', async () => {
  const zip = await zipreader.openZip(await build({ 'a.txt': 'a' }));
  assert.equal(await zip.text('nope.txt'), null);
  assert.equal(await zip.blob('nope.txt'), null);
  assert.equal(zip.has('nope.txt'), false);
});

await t('something that is not a zip is declined, not guessed at', async () => {
  // The caller falls back to JSZip rather than this inventing an answer.
  const nonsense = new File([new Uint8Array(200).fill(7)], 'x.zip');
  assert.equal(await zipreader.openZip(nonsense), null);
});

console.log('through the parser');

await t('an EPUB parses the same through the streaming reader', async () => {
  const epub = new File(
    [fs.readFileSync(new URL('./fixtures/salt-almanac.epub', import.meta.url))], 'salt.epub');
  const parsed = await parse.parse(epub);
  assert.equal(parsed.title, 'The Salt Almanac');
  assert.ok(parsed.chapters.length > 0);
  assert.ok(parsed.coverBlob, 'the cover was lost');
});

await t('an oversized illustration is skipped, not allocated', () => {
  // Nothing on a phone will decode an 83MB animated GIF, and merely holding
  // one is enough to end the import. The chapter is shown without it rather
  // than the whole book failing.
  const src = read('app/src/main/assets/www/js/parse.js');
  assert.match(src, /MAX_IMAGE_BYTES/);
  const blobOf = src.slice(src.indexOf('async function blobOf'), src.indexOf('async function blobOf') + 400);
  assert.match(blobOf, /sizeOf\(path\) > MAX_IMAGE_BYTES/);
});

await t('JSZip is still there for archives the reader will not take', () => {
  // zip64, unusual compression: nothing that used to import stops importing.
  const src = read('app/src/main/assets/www/js/parse.js');
  const open = src.slice(src.indexOf('async function openArchive'), src.indexOf('const MAX_IMAGE_BYTES'));
  assert.match(open, /JSZip\.loadAsync/);
  assert.match(open, /openZip\(file\)\.catch/);
});

console.log(`\n${pass} assertions passed`);
