#!/usr/bin/env node
/* Score readings of pictures against their answer keys, off the phone.
 *
 *   node tools/ocr-eval.mjs key.txt reading.txt [another-reading.txt ...]
 *   node tools/ocr-eval.mjs keys/ readings-a/ [readings-b/ ...]
 *
 * Text files: one bubble to a paragraph, paragraphs apart by a blank line,
 * in reading order -- as the app's Copy text gives them. Given folders, files
 * of the same name are paired, and each folder of readings is one row of
 * the table, scored over every picture in it together. The same pair gives
 * the same numbers every time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const evaluate = await import(pathToFileURL(path.join(here, '../app/src/main/assets/www/js/ocr-eval.js')).href);

const [key, ...readings] = process.argv.slice(2);
if (!key || !readings.length) {
  console.error('usage: node tools/ocr-eval.mjs KEY READING [READING ...]   (files, or folders of them)');
  process.exit(2);
}

const text = (file) => fs.readFileSync(file, 'utf8');
const folder = (p) => fs.statSync(p).isDirectory();

const rows = [];
if (folder(key)) {
  const names = fs.readdirSync(key).filter((name) => name.endsWith('.txt')).sort();
  if (!names.length) {
    console.error(`no .txt answer keys in ${key}`);
    process.exit(2);
  }
  for (const dir of readings) {
    const scores = [];
    const missing = [];
    for (const name of names) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) { missing.push(name); continue; }
      scores.push(evaluate.score(text(path.join(key, name)), text(file)));
    }
    if (missing.length) console.error(`${dir}: no reading for ${missing.join(', ')} (left out of its row)`);
    rows.push({ label: path.basename(path.resolve(dir)), score: evaluate.total(scores) });
  }
} else {
  for (const file of readings) rows.push({ label: path.basename(file), score: evaluate.score(text(key), text(file)) });
}

console.log(evaluate.report(rows));
for (const { label, score } of rows) {
  console.log(`${label}: ${score.characters} characters in the key, ${score.substitutions} swapped, `
    + `${score.deletions} left out, ${score.insertions} put in`);
}
