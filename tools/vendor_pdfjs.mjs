#!/usr/bin/env node
/*
 * Fetches pdf.js into the bundled assets.
 *
 * Any Gradle build does this too, via the vendorPdfJs task -- this exists so
 * the reader tests can be run without touching Gradle, and so there is one
 * obvious command to point at when the PDF suite says it skipped.
 *
 *     node tools/vendor_pdfjs.mjs
 *
 * It is fetched rather than committed because it is 4.3MB of unmodified
 * library code, 169 of them character-map files. Once here it ships inside the
 * APK, and the app still makes no network calls of its own at runtime.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '4.10.38';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'app/src/main/assets/www/vendor');

if (fs.existsSync(path.join(vendor, 'pdf.min.mjs'))
    && fs.existsSync(path.join(vendor, 'cmaps'))) {
  console.log('pdf.js is already vendored.');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(root, '.pdfjs-'));
try {
  console.log(`Fetching pdfjs-dist@${VERSION}…`);
  execFileSync('npm', ['pack', `pdfjs-dist@${VERSION}`, '--silent'],
    { cwd: scratch, stdio: 'inherit' });
  execFileSync('tar', ['xf', `pdfjs-dist-${VERSION}.tgz`], { cwd: scratch });

  fs.mkdirSync(vendor, { recursive: true });
  const pkg = path.join(scratch, 'package');

  // The legacy build: minSdk is 26, and the modern one assumes a newer JS
  // baseline than an old WebView provides.
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    fs.copyFileSync(path.join(pkg, 'legacy/build', name), path.join(vendor, name));
  }
  // Character maps, without which most Korean and Japanese PDFs extract as
  // nothing at all, and the base fourteen fonts.
  for (const dir of ['cmaps', 'standard_fonts']) {
    fs.cpSync(path.join(pkg, dir), path.join(vendor, dir), { recursive: true });
  }

  const count = fs.readdirSync(path.join(vendor, 'cmaps')).length;
  console.log(`Vendored pdf.js ${VERSION}: library, worker, ${count} cmaps, base fonts.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
