/* Text out of pictures. The reading itself is ML Kit's, on the phone
 * (OcrBridge.java), so what is tested here is everything around it: which
 * scripts are asked for, which reading is believed, the order blocks are read
 * in, the pictures handed across in pieces, and the button and sheet. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const ocr = await import(new URL('../app/src/main/assets/www/js/ocr.js', import.meta.url).href);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass++; };

await t('scripts follow the book language, all four when it is not known', () => {
  // Their own script only: an English reading must not win on a misread page.
  assert.deepEqual(ocr.scriptsFor('ko'), ['korean']);
  assert.deepEqual(ocr.scriptsFor('ja-JP'), ['japanese']);
  assert.deepEqual(ocr.scriptsFor('zh-Hant'), ['chinese']);
  assert.deepEqual(ocr.scriptsFor('en'), ['latin']);
  assert.deepEqual(ocr.scriptsFor(''), ['korean', 'chinese', 'japanese', 'latin']);
});

await t('the reading most in its own script is believed', () => {
  const results = {
    korean: { text: '미안해요 정말', blocks: [] },
    chinese: { text: '口 曰 日 卜', blocks: [] },
    latin: { text: 'ol of ot', blocks: [] },
  };
  assert.equal(ocr.pickBest(results).script, 'korean');
  const japanese = {
    japanese: { text: '申し訳ありません', blocks: [] },
    chinese: { text: '申訳', blocks: [] },
  };
  assert.equal(ocr.pickBest(japanese).script, 'japanese');
  assert.equal(ocr.pickBest({ latin: { text: 'I am sorry!', blocks: [] } }).script, 'latin');
  assert.equal(ocr.pickBest({}), null);
});

await t('vertical Japanese is read right to left; other pages top to bottom', () => {
  const columns = [
    { text: 'ありま', x: 10, y: 0, w: 20, h: 120, lines: ['ありま'] },
    { text: '申し訳', x: 60, y: 0, w: 20, h: 120, lines: ['申し訳'] },
    { text: 'せん', x: 10, y: 300, w: 20, h: 80, lines: ['せん'] },
  ];
  assert.equal(ocr.readingText(columns, 'japanese'), '申し訳\n\nありま\n\nせん');
  // Blocks the phone read as columns come with their columns in order, and
  // the bubbles of a row of panels are read right to left.
  const bubbles = [
    { text: 'left', vertical: true, x: 10, y: 20, w: 80, h: 300, lines: ['ちょっと', '待って'] },
    { text: 'right', vertical: true, x: 200, y: 0, w: 80, h: 260, lines: ['申し訳', 'ありません'] },
    { text: 'below', vertical: true, x: 150, y: 500, w: 60, h: 200, lines: ['はい'] },
  ];
  assert.equal(ocr.readingText(bubbles, 'japanese'), '申し訳ありません\n\nちょっと待って\n\nはい');
  const rows = [
    { text: 'second', x: 0, y: 50, w: 200, h: 20, lines: ['second'] },
    { text: 'first line', x: 0, y: 0, w: 200, h: 40, lines: ['first', 'line'] },
  ];
  assert.equal(ocr.readingText(rows, 'latin'), 'first line\n\nsecond');
  // Korean (and horizontal Chinese) bubbles side by side read left to right,
  // even when the right one sits higher; Korean keeps its spaces.
  const manhwa = [
    { text: 'b', x: 300, y: 0, w: 200, h: 80, lines: ['정말', '미안해'] },
    { text: 'a', x: 0, y: 30, w: 200, h: 80, lines: ['잠깐만'] },
    { text: 'c', x: 100, y: 400, w: 200, h: 80, lines: ['괜찮아'] },
  ];
  assert.equal(ocr.readingText(manhwa, 'korean'), '잠깐만\n\n정말 미안해\n\n괜찮아');
  const manhua = manhwa.map((block) => ({ ...block, lines: block.lines.map(() => '对不起') }));
  assert.equal(ocr.readingText(manhua, 'chinese'), '对不起\n\n对不起对不起\n\n对不起');
  // A manga translated into English: lines of text, panels right to left,
  // as set for the book.
  assert.equal(ocr.readingText(manhwa, 'latin', { direction: 'rtl' }), '정말 미안해\n\n잠깐만\n\n괜찮아');
  assert.equal(ocr.directionOf(manhwa, 'latin'), 'ltr');
  assert.equal(ocr.directionOf(manhwa, 'japanese', 'ja'), 'rtl', 'a Japanese book runs right to left, lines or columns');
  assert.equal(ocr.directionOf(bubbles, 'chinese', 'zh'), 'rtl', 'Chinese in columns runs right to left');
  assert.equal(ocr.directionOf(manhua, 'chinese', 'zh'), 'ltr', 'Chinese in lines runs left to right');
  // Chinese lines join with nothing between them.
  assert.equal(ocr.readingText([{ text: '对不起\n真的', x: 0, y: 0, w: 90, h: 40, lines: ['对不起', '真的'] }], 'chinese'), '对不起真的');
});

await t('a picture is handed across in pieces and read through the bridge', async () => {
  assert.equal(ocr.available(), false);
  const got = new Map();
  let asked = null;
  window.GrimoireOcr = globalThis.window.GrimoireOcr = {
    begin(id) { got.set(id, []); },
    append(id, piece) { got.get(id).push(piece); return true; },
    cancel(id) { got.delete(id); },
    recognise(id, scripts) {
      asked = { id, scripts, data: got.get(id).join('') };
      setTimeout(() => ocr.settleOcr(id, true, JSON.stringify({
        width: 10, height: 10,
        results: {
          korean: { text: '미안해', blocks: [{ text: '미안해', x: 0, y: 0, w: 10, h: 5, lines: ['미안해'] }] },
          latin: { text: 'olol', blocks: [{ text: 'olol', x: 0, y: 0, w: 10, h: 5, lines: ['olol'] }] },
        },
      })), 5);
    },
  };
  assert.equal(ocr.available(), true);
  const blob = new window.Blob([new Uint8Array(700 * 1024).fill(7)], { type: 'image/png' });
  const out = await ocr.readPicture(blob, ['korean', 'latin']);
  assert.equal(out.script, 'korean');
  assert.equal(out.text, '미안해');
  assert.equal(out.blocks.length, 1, 'the blocks come back, to be put in another order');
  assert.equal(asked.scripts, 'korean,latin');
  assert.ok(Buffer.from(asked.data, 'base64').length === 700 * 1024, 'every piece arrived');
});

await t('a failed reading says why', async () => {
  window.GrimoireOcr.recognise = (id) => setTimeout(() => ocr.settleOcr(id, false, 'that picture could not be opened'), 1);
  await assert.rejects(ocr.readPicture(new window.Blob(['x']), ['latin']), /could not be opened/);
});

await t('Google Lens is offered only where the app can open it', async () => {
  assert.equal(ocr.lensAvailable(), false);
  let handed = null;
  window.GrimoireOcr.lens = (id) => { handed = id; return ''; };
  assert.equal(ocr.lensAvailable(), true);
  await ocr.toLens(new window.Blob(['x']));
  assert.ok(handed);
  window.GrimoireOcr.lens = () => 'no app';
  await assert.rejects(ocr.toLens(new window.Blob(['x'])), /no app/);
});

await t('the button sits in the copy row, with its framed page, arrow and TXT', () => {
  const doc = window.document;
  const button = doc.querySelector('.copy-row #ocr-btn');
  assert.ok(button, 'in the copy row');
  assert.ok(button.querySelector('.ocr-frame') && button.querySelector('.ocr-page'));
  assert.equal(button.querySelector('.ocr-txt').textContent, 'TXT');
  assert.ok(button.querySelectorAll('.ocr-panels rect').length >= 2);
  const page = button.querySelector('.ocr-page');
  const ratio = Number(page.getAttribute('height')) / Number(page.getAttribute('width'));
  assert.ok(Math.abs(ratio - Math.SQRT2) < 0.01, 'a page in proportion 1:√2');
  for (const id of ['ocr-sheet', 'ocr-stage', 'ocr-box', 'ocr-scripts', 'ocr-text', 'ocr-copy', 'ocr-lens', 'ocr-close']) {
    assert.ok(doc.getElementById(id), id);
  }
});

await t('the app wires it up: settleOcr, back, panels redrawn as you read', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /settleOcr: ocr\.settleOcr/);
  assert.match(app, /if \(!el\('ocr-sheet'\)\.hidden\) \{ closeOcr\(\); return true; \}/);
  assert.match(app, /moveCopyIconKnobs\(\); drawOcrPanels\(\);/);
  assert.match(app, /picturesInView\(\{ inOrder: true \}\)/);
});

await t('the native side: registered, with the four recognisers bundled', () => {
  const main = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(main, /new OcrBridge\(this, webView\), "GrimoireOcr"/);
  const gradle = read('app/build.gradle.kts');
  for (const lib of ['latin', 'chinese', 'japanese', 'korean']) assert.match(gradle, new RegExp(`libs\\.mlkit\\.text\\.${lib}`));
  const bridge = read('app/src/main/java/com/grimoire/ereader/OcrBridge.java');
  assert.match(bridge, /com\.google\.ar\.lens/);
  // Columns are laid out as lines and read again.
  assert.match(bridge, /VerticalLayout\.layout\(/);
  assert.match(bridge, /out\.put\("vertical", true\)/);
  const layout = read('app/src/main/java/com/grimoire/ereader/VerticalLayout.java');
  assert.doesNotMatch(layout, /^import android/m, 'plain Java, testable off the phone');
  assert.match(bridge, /window\.Grimoire\.settleOcr/);
});

console.log(`\n${pass} ocr tests passed`);
