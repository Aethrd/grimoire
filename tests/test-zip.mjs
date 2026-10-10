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

/* ── zip64, and names that are not UTF-8 ─────────────────────────────── */

console.log('\nlarge archives and other alphabets');

const zlib = await import('node:zlib');

/**
 * A zip written by hand, so the parts JSZip never writes can be: zip64
 * records with placeholders where the sizes go, and names in a code page.
 */
function handmade(entries, { zip64 = false, utf8Flag = true } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  for (const { name, body, deflate } of entries) {
    const nameBytes = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');
    const data = Buffer.from(body);
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const flags = utf8Flag ? 0x800 : 0;
    const method = deflate ? 8 : 0;
    const local = Buffer.concat([
      u32(0x04034b50), u16(45), u16(flags), u16(method), u16(0), u16(0), u32(crc),
      u32(stored.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    const extra = zip64 ? Buffer.concat([u16(1), u16(24), u64(data.length), u64(stored.length), u64(offset)]) : Buffer.alloc(0);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(45), u16(45), u16(flags), u16(method), u16(0), u16(0), u32(crc),
      u32(zip64 ? 0xffffffff : stored.length), u32(zip64 ? 0xffffffff : data.length),
      u16(nameBytes.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0),
      u32(zip64 ? 0xffffffff : offset), nameBytes, extra,
    ]));
    chunks.push(local, stored);
    offset += local.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const tailParts = [directory];
  if (zip64) {
    const recordAt = offset + directory.length;
    tailParts.push(Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(entries.length), u64(entries.length), u64(directory.length), u64(offset),
    ]));
    tailParts.push(Buffer.concat([u32(0x07064b50), u32(0), u64(recordAt), u32(1)]));
  }
  tailParts.push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(zip64 ? 0xffff : entries.length), u16(zip64 ? 0xffff : entries.length),
    u32(zip64 ? 0xffffffff : directory.length), u32(zip64 ? 0xffffffff : offset), u16(0),
  ]));
  return new File([Buffer.concat([...chunks, ...tailParts])], 'handmade.zip');
}

await t('a zip64 archive is read in place, not handed to JSZip whole', async () => {
  const file = handmade([
    { name: 'Shelf/Fiction/notes.txt', body: 'NOTES\n\nHello there.\n' },
    { name: 'Shelf/Other/long.txt', body: 'x'.repeat(5000), deflate: true },
  ], { zip64: true });
  const zip = await zipreader.openZip(file);
  assert.ok(zip, 'the streaming reader declined a zip64 archive -- back to loading all of it');
  assert.deepEqual(zip.names().sort(), ['Shelf/Fiction/notes.txt', 'Shelf/Other/long.txt']);
  assert.equal(zip.sizeOf('Shelf/Other/long.txt'), 5000);
  assert.equal(await zip.text('Shelf/Fiction/notes.txt'), 'NOTES\n\nHello there.\n');
  assert.equal(await zip.text('Shelf/Other/long.txt'), 'x'.repeat(5000));
});

await t('a zip64 library unpacks into its folders like any other', async () => {
  const epub = fs.readFileSync(path.join(root, 'tests/fixtures/salt-almanac.epub'));
  const file = handmade([
    { name: 'Library/Fiction/One.epub', body: epub },
    { name: 'Library/Novels/Story.txt', body: 'STORY\n\nHello.\n', deflate: true },
  ], { zip64: true });
  const archive = await parse.expandArchive(file);
  assert.equal(archive.comic, false);
  assert.deepEqual(archive.books.map((b) => `${b.folder}/${b.name}`).sort(), ['Fiction/One.epub', 'Novels/Story.txt']);
  const book = archive.books.find((b) => b.name === 'One.epub');
  assert.equal((await book.read()).size, epub.length);
});

await t('Info-ZIP\'s own zip64 output reads too', async () => {
  // zip -fz, as a phone's or a PC's archiver writes for a large folder.
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z64-'));
  try {
    fs.mkdirSync(path.join(dir, 'Shelf/Fiction'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Shelf/Fiction/notes.txt'), 'NOTES\n\nHi.\n');
    execFileSync('zip', ['-q', '-r', '-fz', 'out.zip', 'Shelf'], { cwd: dir });
    const zip = await zipreader.openZip(new File([fs.readFileSync(path.join(dir, 'out.zip'))], 'out.zip'));
    assert.ok(zip, 'declined');
    assert.equal(await zip.text('Shelf/Fiction/notes.txt'), 'NOTES\n\nHi.\n');
  } catch (error) {
    if (error.code === 'ENOENT') return;   // no zip tool on this machine: nothing to compare with
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t('folder names from a Korean Windows zip come out in Korean, not question marks', async () => {
  // 마녀의 도시 in CP949, the code page Korean Windows writes zip names in.
  const cp949 = Buffer.from([0xb8, 0xb6, 0xb3, 0xe0, 0xc0, 0xc7, 0x20, 0xb5, 0xb5, 0xbd, 0xc3]);
  const name = Buffer.concat([cp949, Buffer.from('/01.txt')]);
  const file = handmade([{ name, body: 'ONE\n\nText.\n' }], { utf8Flag: false });
  const zip = await zipreader.openZip(file);
  assert.deepEqual(zip.names(), ['마녀의 도시/01.txt']);
  // Plain ASCII and flagged UTF-8 are as they were.
  const plain = await zipreader.openZip(handmade([{ name: 'Books/a.txt', body: 'A' }], { utf8Flag: false }));
  assert.deepEqual(plain.names(), ['Books/a.txt']);
});

console.log(`\n${pass} assertions passed`);
