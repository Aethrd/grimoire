/* Faithful reading, and the measure of it.
 *
 * The recogniser runs on the phone only, so these test what is around it:
 * that what it read is kept apart from what was corrected, that nothing is
 * read twice or quietly lost, that a script failing loses only itself, and
 * that the accuracy check scores a reading as it should. The native side is
 * checked for the same promises in its source. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const ocr = await import(new URL('../app/src/main/assets/www/js/ocr.js', import.meta.url).href);
const evaluate = await import(new URL('../app/src/main/assets/www/js/ocr-eval.js', import.meta.url).href);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass++; };

/* ── as read, and as corrected ─────────────────────────────────────── */

await t('a correction says what it changed, and changes nothing else', () => {
  const { text, changes } = ocr.correctJapanese('身体能カだつた');
  assert.equal(text, '身体能力だった');
  assert.deepEqual(changes.map((c) => `${c.at}:${c.from}→${c.to}`).sort(), ['3:カ→力', '5:つ→っ']);
  assert.equal([...text].length, [...'身体能カだつた'].length, 'one character for one, never more or fewer');
  // What it has no rule for is left as read: an unusual word stays unusual.
  for (const odd of ['ギュギュギュッ', 'ちくわぶ', 'つ', 'カ', 'ロボのカード', '勝敗はついてる']) {
    assert.equal(ocr.correctJapanese(odd).text, odd, odd);
    assert.equal(ocr.correctJapanese(odd).changes.length, 0, odd);
  }
  // tidyJapanese is the same rules, unchanged.
  assert.equal(ocr.tidyJapanese('誰より強いつてだけ'), '誰より強いってだけ');
});

await t('each block keeps the reading as read beside the corrected one', () => {
  const blocks = [{
    text: 'だつた', lines: ['だつた'], raw: ['だつた'], x: 0, y: 0, w: 10, h: 30, vertical: true,
  }];
  const [block] = ocr.orderedBlocks(blocks, 'japanese');
  assert.equal(block.raw, 'だつた');
  assert.equal(block.corrected, 'だった');
  assert.equal(block.joined, 'だった', 'corrected by default');
  assert.equal(block.corrections.length, 1);
  const [asRead] = ocr.orderedBlocks(blocks, 'japanese', { corrected: false });
  assert.equal(asRead.joined, 'だつた', 'as read, when asked');
  assert.equal(ocr.readingText(blocks, 'japanese', { corrected: false }), 'だつた');
  // The recogniser's own vertical forms are the raw text; the lines, tidied.
  const [vertical] = ocr.orderedBlocks([{
    text: '「はい」', lines: ['「はい」'], raw: ['﹁はい﹂'], x: 0, y: 0, w: 10, h: 40, vertical: true,
  }], 'japanese');
  assert.equal(vertical.raw, '﹁はい﹂');
  assert.equal(vertical.joined, '「はい」');
  // A reading kept from before there was a raw text: its lines stand in.
  const [old] = ocr.orderedBlocks([{ text: 'x', lines: ['もう'], x: 0, y: 0, w: 5, h: 5 }], 'japanese');
  assert.equal(old.raw, 'もう');
});

await t('blocks the recogniser was unsure of are marked, not changed', () => {
  const blocks = [
    { text: '確か', lines: ['確か'], x: 0, y: 0, w: 10, h: 10, confidence: 0.95 },
    { text: '多分', lines: ['多分'], x: 20, y: 0, w: 10, h: 10, confidence: 0.31 },
    { text: '不明', lines: ['不明'], x: 40, y: 0, w: 10, h: 10 },
  ];
  const out = ocr.orderedBlocks(blocks, 'japanese', { direction: 'ltr' });
  assert.deepEqual(out.map((b) => b.unsure), [false, true, false], 'no certainty given is not unsure');
  assert.deepEqual(out.map((b) => b.joined), ['確か', '多分', '不明'], 'the text itself is untouched');
  assert.equal(ocr.readingText(blocks, 'japanese', { direction: 'ltr' }), '確か\n\n多分\n\n不明',
    'no marks written into the text');
});

/* ── read once, lost nowhere ───────────────────────────────────────── */

await t('text found twice in one place is kept once; twice in two places, twice', () => {
  const twice = [
    { text: 'ドン', x: 100, y: 100, w: 40, h: 80 },
    { text: 'ドン', x: 102, y: 98, w: 40, h: 80 },            // an overlap's second find
    { text: 'ドン', x: 400, y: 100, w: 40, h: 80 },           // a second cry
    { text: 'まだだ', x: 600, y: 50, w: 30, h: 90 },
    { text: 'まだ', x: 600, y: 50, w: 30, h: 60 },            // part of it, found again
  ];
  const { blocks, dropped } = ocr.withoutDuplicates(twice);
  assert.equal(dropped, 2);
  assert.deepEqual(blocks.map((b) => b.text), ['ドン', 'ドン', 'まだだ']);
  assert.equal(ocr.withoutDuplicates([]).dropped, 0);
});

await t('the warnings say what to be wary of, beside the text', () => {
  const warnings = ocr.checkReading({
    script: 'japanese',
    failed: { korean: 'out of memory' },
    duplicates: 1,
    blocks: [
      { text: 'だつた', lines: ['だつた'], x: 0, y: 0, w: 10, h: 10, confidence: 0.2 },
      { text: 'Il1|', lines: ['Il1|'], x: 20, y: 0, w: 10, h: 10 },
    ],
  });
  const kinds = Object.fromEntries(warnings.map((w) => [w.kind, w]));
  assert.equal(kinds.failed.script, 'korean');
  assert.equal(kinds.unsure.count, 1);
  assert.equal(kinds.muddled.count, 1);
  assert.equal(kinds.duplicates.count, 1);
  assert.equal(kinds.corrected.count, 1);
  assert.deepEqual(ocr.checkReading({ script: 'latin', blocks: [] }).map((w) => w.kind), ['empty']);
});

await t('one script failing keeps the others, and says which failed', async () => {
  let steps = null;
  window.GrimoireOcr = globalThis.window.GrimoireOcr = {
    begin() {},
    append() { return true; },
    cancel() {},
    recognise(id) { this.recogniseWith(id, 'japanese,korean', null); },
    recogniseWith(id, scripts, json) {
      steps = json ? JSON.parse(json) : null;
      setTimeout(() => ocr.settleOcr(id, true, JSON.stringify({
        width: 100, height: 100,
        results: { japanese: { text: 'はい', blocks: [{ text: 'はい', x: 1, y: 1, w: 9, h: 20, lines: ['はい'] }] } },
        failed: { korean: 'out of memory' },
      })), 2);
    },
  };
  const blob = new window.Blob([new Uint8Array(10)], { type: 'image/png' });
  const out = await ocr.readPicture(blob, ['japanese', 'korean'], { steps: ocr.NO_STEPS });
  assert.equal(out.text, 'はい');
  assert.deepEqual(out.failed, { korean: 'out of memory' });
  assert.deepEqual(steps, { ...ocr.NO_STEPS }, 'the steps cross the bridge');
  assert.equal(typeof out.ms, 'number');
});

await t('an empty picture, or a reading that comes back garbled, is an error, not empty text', async () => {
  await assert.rejects(ocr.readPicture(new window.Blob([]), ['latin']), /empty/);
  window.GrimoireOcr.recogniseWith = (id) => setTimeout(() => ocr.settleOcr(id, true, '{"width":1,'), 1);
  await assert.rejects(ocr.readPicture(new window.Blob(['x']), ['latin'], { steps: ocr.ALL_STEPS }), /garbled/);
  window.GrimoireOcr.recogniseWith = (id) => setTimeout(() => ocr.settleOcr(id, true, '{}'), 1);
  await assert.rejects(ocr.readPicture(new window.Blob(['x']), ['latin'], { steps: ocr.ALL_STEPS }), /empty/);
});

await t('the step sets are what they say', () => {
  assert.ok(Object.values(ocr.ALL_STEPS).every(Boolean));
  assert.ok(Object.values(ocr.NO_STEPS).every((on) => !on));
  assert.deepEqual(Object.keys(ocr.EARLIER_STEPS).sort(), Object.keys(ocr.ALL_STEPS).sort());
  assert.equal(ocr.EARLIER_STEPS.columns && ocr.EARLIER_STEPS.closer, true, 'what the app did before');
  assert.equal(ocr.EARLIER_STEPS.tiles || ocr.EARLIER_STEPS.compare || ocr.EARLIER_STEPS.straighten, false);
});

/* ── the native side keeps the same promises ───────────────────────── */

await t('the recogniser side: partial results, certainty, extra passes that only add', () => {
  const bridge = read('app/src/main/java/com/grimoire/ereader/OcrBridge.java');
  // Each script in its own try, its failure put beside the others' results.
  assert.match(bridge, /found\.put\(name, read\(bitmap, name, steps\)\);\s*\} catch \(Throwable e\)/);
  assert.match(bridge, /result\.put\("failed", failed\)/);
  assert.match(bridge, /public void recogniseWith\(final String id, final String scripts, final String stepsJson\)/);
  // Certainty looked up by name: a recogniser without it still builds and runs.
  assert.match(bridge, /"getConfidence"/);
  assert.match(bridge, /"getAngle"/);
  assert.doesNotMatch(bridge, /\.getConfidence\(\)/, 'never called directly');
  // The quarter search adds only what was not found, and never replaces.
  assert.match(bridge, /if \(covered\(at, found\)\) continue;/);
  // Columns read again only when the first reading is not sure.
  assert.match(bridge, /steps\.compare && doubtful/);
  // The raw text and the source of each block go to the page.
  assert.match(bridge, /out\.put\("raw", raw\)/);
  assert.match(bridge, /out\.put\("source", block\.source\)/);
  // Upright as shown: a picture's EXIF turn is honoured.
  assert.match(bridge, /TAG_ORIENTATION/);
  const layout = read('app/src/main/java/com/grimoire/ereader/VerticalLayout.java');
  assert.match(layout, /sheet\.original = argb;/, 'the patch as drawn is kept beside the cleaned one');
  assert.match(layout, /static List<String> columnTextsRaw\(/);
});

await t('readings made before this version are read again, and answer keys survive a cache clear', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /:ocrpic2:/);
  const translate = read('app/src/main/assets/www/js/translate.js');
  assert.match(translate, /const isKey = \(row\) => row\.lang === 'key' \|\| row\.lang === 'glossary';/);
  assert.match(translate, /filter\(\(row\) => !isKey\(row\)\)/);
});

await t('the sheet has the as-read switch and the accuracy check', () => {
  const doc = window.document;
  for (const id of ['ocr-asread', 'ocr-check', 'ocr-accuracy', 'ocr-key', 'ocr-key-run', 'ocr-key-all',
    'ocr-key-copy', 'ocr-key-result', 'ocr-marks']) {
    assert.ok(doc.getElementById(id), id);
  }
  assert.equal(doc.getElementById('ocr-asread').getAttribute('aria-pressed'), 'false', 'corrected by default');
});

/* ── the measure ───────────────────────────────────────────────────── */

const KEY = '「初めまして」\n\nよろしく\n\nお願いします';

await t('a perfect reading scores nothing wrong', () => {
  const s = evaluate.score(KEY, KEY);
  assert.equal(s.cer, 0);
  assert.equal(s.omitted, 0);
  assert.equal(s.duplicated, 0);
  assert.equal(s.outOfOrder, 0);
  assert.equal(s.units, 3);
  assert.equal(s.wer, null, 'Japanese has no words to count by spaces');
});

await t('edits are counted by kind, the fewest there are', () => {
  assert.deepEqual(evaluate.editCounts('kitten', 'sitting'), { distance: 3, substitutions: 2, insertions: 1, deletions: 0 });
  assert.deepEqual(evaluate.editCounts('abc', ''), { distance: 3, substitutions: 0, insertions: 0, deletions: 3 });
  assert.deepEqual(evaluate.editCounts('', 'ab'), { distance: 2, substitutions: 0, insertions: 2, deletions: 0 });
  // Characters, not UTF-16 halves: one emoji is one character.
  assert.equal(evaluate.editCounts([...'a😀b'], [...'a😁b']).distance, 1);
});

await t('a misread character, a lost bubble, a doubled one, one out of place', () => {
  const misread = evaluate.score(KEY, '「初めまレて」\n\nよろしく\n\nお願いします');
  assert.equal(misread.substitutions, 1);
  assert.ok(Math.abs(misread.cer - 1 / 17) < 1e-9);
  const lost = evaluate.score(KEY, '「初めまして」\n\nお願いします');
  assert.equal(lost.omitted, 1);
  assert.equal(lost.deletions, 4);
  const doubled = evaluate.score(KEY, '「初めまして」\n\nよろしく\n\nよろしく\n\nお願いします');
  assert.equal(doubled.duplicated, 1);
  assert.equal(doubled.insertions, 4);
  const shuffled = evaluate.score(KEY, 'お願いします\n\n「初めまして」\n\nよろしく');
  assert.equal(shuffled.outOfOrder, 1);
  assert.equal(shuffled.omitted, 0);
  const extra = evaluate.score(KEY, `${KEY}\n\nＳＦＸ`);
  assert.equal(extra.extra, 1);
});

await t('a bubble split in two is not a duplicate', () => {
  const s = evaluate.score('ボクらに追われた時点で', 'ボクらに\n\n追われた時点で');
  assert.equal(s.duplicated, 0);
  assert.equal(s.omitted, 0);
  assert.equal(s.cer, 0);
});

await t('widths and vertical forms count as the same character; space only where words use it', () => {
  assert.equal(evaluate.cer('「はい」', '﹁はい﹂'), 0);
  assert.equal(evaluate.cer('ＡＢＣ', 'ABC'), 0);
  assert.equal(evaluate.cer('はい', 'は い'), 0, 'Japanese: space is no character');
  assert.ok(evaluate.cer('안녕 하세요', '안녕하세요') > 0, 'Korean: the space is part of the text');
  assert.ok(Math.abs(evaluate.wer('the quick brown fox', 'the quick brown fax') - 0.25) < 1e-9);
  assert.equal(evaluate.wer('the cat', 'the cat'), 0);
});

await t('pictures together are scored over all their characters, and reported as a table', () => {
  const a = { ...evaluate.score('ああああああああああ', 'ああああああああああ'), ms: 1000 };
  const b = { ...evaluate.score('いい', 'うう'), ms: 500 };
  const sum = evaluate.total([a, b]);
  assert.equal(sum.pictures, 2);
  assert.ok(Math.abs(sum.cer - 2 / 12) < 1e-9, 'not the average of 0% and 100%');
  assert.equal(sum.ms, 1500);
  const table = evaluate.report([{ label: 'Now', score: sum }]);
  assert.match(table, /CER/);
  assert.match(table, /16\.7%/);
  assert.match(table, /1\.5s/);
});

await t('the command-line scorer reads a key and a reading', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(`${os.tmpdir()}/grimoire-eval-`);
  try {
    fs.writeFileSync(`${dir}/key.txt`, KEY);
    fs.writeFileSync(`${dir}/read.txt`, '「初めまレて」\n\nお願いします');
    const run = spawnSync(process.execPath, ['tools/ocr-eval.mjs', `${dir}/key.txt`, `${dir}/read.txt`],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /CER/);
    assert.match(run.stdout, /1\/3/, 'one bubble of three omitted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${pass} ocr accuracy tests passed`);
