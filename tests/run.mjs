/* Runs every test file in order and exits non-zero on the first failure. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

if (!existsSync(path.join(here, 'fixtures/salt-almanac.epub'))) {
  console.log('Building fixtures…');
  const built = spawnSync(process.execPath, ['tests/fixtures/build.mjs'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status);
}

let failed = 0;
for (const file of ['test-boot.mjs', 'test-logic.mjs', 'test-parse.mjs', 'test-more.mjs', 'test-archive.mjs', 'test-blobs.mjs', 'test-shelf.mjs', 'test-motion.mjs', 'test-freedom.mjs']) {
  console.log(`\n── ${file} ─────────────────────────────────`);
  const run = spawnSync(process.execPath, [`tests/${file}`], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
