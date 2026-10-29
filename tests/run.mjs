/* Runs every test file in order and exits non-zero on the first failure. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* Test fixtures are generated rather than committed -- they are binary files
 * that would otherwise sit in the repo forever, and generating them keeps
 * them honest. The builder itself must be committed, though, and a missing
 * one otherwise surfaces as a bare MODULE_NOT_FOUND from Node with no
 * indication of what to do about it. */
const builder = path.join(here, 'fixtures/build.mjs');
const fixtures = ['salt-almanac.epub', 'comic.cbz', 'sample.pdf', 'comic.cbr', 'books.rar', 'lantern.mobi'];
const missing = fixtures.filter((f) => !existsSync(path.join(here, 'fixtures', f)));

if (missing.length) {
  if (!existsSync(builder)) {
    console.error(
      `\nMissing tests/fixtures/build.mjs, which generates ${missing.join(', ')}.\n` +
      `It is a committed file, not a generated one -- check it was added:\n` +
      `    git ls-files tests/fixtures\n`);
    process.exit(1);
  }
  console.log(`Building fixtures (${missing.join(', ')})…`);
  const built = spawnSync(process.execPath, [builder], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status || 1);
}

let failed = 0;
for (const file of ['test-boot.mjs', 'test-logic.mjs', 'test-parse.mjs', 'test-zip.mjs', 'test-pdf.mjs', 'test-more.mjs', 'test-archive.mjs', 'test-blobs.mjs', 'test-shelf.mjs', 'test-trim.mjs', 'test-tools.mjs', 'test-redact.mjs', 'test-motion.mjs', 'test-reflow.mjs', 'test-web.mjs', 'test-ocr.mjs', 'test-ocr-accuracy.mjs', 'test-freedom.mjs']) {
  console.log(`\n── ${file} ─────────────────────────────────`);
  const run = spawnSync(process.execPath, [`tests/${file}`], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
