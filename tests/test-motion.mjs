import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.mjs';
await boot();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('app/src/main/assets/www/css/app.css');

const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok  ' + name); pass++; };

/* Scroll geometry needs a real layout engine, and jsdom has none -- every
 * getBoundingClientRect here returns zeros. What follows tests the contract
 * around the reader rather than pretending to test the reader's measurement.
 * The scrolling itself needs a device. */

console.log('reading mode');

t('paged is the default, endless is on for when scroll is chosen', () => {
  assert.equal(store.DEFAULT_LAYOUT.mode, 'paged');
  assert.equal(store.DEFAULT_LAYOUT.endless, true);
});

t('mode and endless are per-book layout, so they inherit and reset', () => {
  // Living in DEFAULT_LAYOUT means they go through layoutFor()/saveLayout(),
  // which already handles per-book override and Reset restoring inheritance.
  assert.ok('mode' in store.DEFAULT_LAYOUT);
  assert.ok('endless' in store.DEFAULT_LAYOUT);
});

t('the reader exposes both switches', () => {
  assert.equal(typeof reader.setMode, 'function');
  assert.equal(typeof reader.setEndless, 'function');
});

t('state starts paged with one chapter and no assumptions', () => {
  assert.equal(reader.state.mode, 'paged');
  assert.deepEqual(reader.state.loaded, []);
});

console.log('motion');

t('reduced motion is honoured', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const block = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(block, /animation-duration:\s*1ms\s*!important/);
  assert.match(block, /transition-duration:\s*1ms\s*!important/);
  assert.match(block, /scroll-behavior:\s*auto\s*!important/);
});

t('nothing loops', () => {
  // A reader with a looping animation anywhere in it is a reader with
  // something moving in the corner of your eye while you read.
  assert.ok(!/animation-iteration-count:\s*infinite/.test(css));
  assert.ok(!/\binfinite\b/.test(css));
});

t('transitions stay short enough to read as feedback', () => {
  // Anything past a quarter of a second stops feeling like a response and
  // starts feeling like a wait.
  const durations = [...css.matchAll(/transition[^;{}]*?(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(durations.length > 0, 'no transition durations found at all');
  const tooSlow = durations.filter((d) => d > 250);
  assert.deepEqual(tooSlow, [], `transitions over 250ms: ${tooSlow}`);
});

t('page turns animate but re-flows do not', () => {
  // Sliding to an arbitrary page after a font-size change looks like a fault,
  // so the reader drops the transition for anything that is not a turn.
  assert.match(css, /\.page-flow\s*\{[^}]*transition:\s*transform/s);
  assert.match(css, /\.page-flow\.no-motion\s*\{\s*transition:\s*none/);
  const js = read('app/src/main/assets/www/js/reader.js');
  assert.match(js, /withoutMotion/);
  // Every jump that is not a turn must go through it.
  assert.match(js, /show\(pageAtAnchor\(anchor, chapter\), \{ animate: false \}\)/);
});

t('the text itself never animates', () => {
  // Motion belongs on controls and page turns. Anything that moved the words
  // while someone was reading them would be a bug, not a flourish.
  assert.ok(!/\.page-flow p\s*\{[^}]*(animation|transition)/s.test(css));
  assert.ok(!/\.chapter\s*\{[^}]*animation/s.test(css));
});

console.log('scroll mode styling');

t('scroll mode scrolls and drops the column layout', () => {
  assert.match(css, /\.page-viewport\.scrolling\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.page-flow\.scrolling\s*\{[^}]*column-width:\s*auto/s);
  assert.match(css, /\.page-flow\.scrolling\s*\{[^}]*height:\s*auto/s);
});

t('chapters running together get a visible seam', () => {
  // Endless scroll should not slide from one chapter into the next without
  // saying so.
  assert.match(css, /\.chapter \+ \.chapter::before/);
});

console.log('language packs');

t('only the languages the library uses are offered', () => {
  // ML Kit models are per language, ~30MB each. Offering all fifty, or
  // fetching them together, would be absurd; reading Korean in English needs
  // Korean and English and nothing else.
  const translate = read('app/src/main/assets/www/js/translate.js');
  assert.match(translate, /export function neededLanguages/);
  const fn = translate.slice(translate.indexOf('function neededLanguages'));
  assert.match(fn.slice(0, 600), /book\.lang/, 'packs are not derived from the books');
  assert.match(fn.slice(0, 600), /target/, 'the target language is not included');

  const java = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  assert.match(java, /public void downloadModel/);
  assert.match(java, /public void deleteModel/);
  // Downloading a 30MB pack on mobile data without asking is not on.
  const download = java.slice(java.indexOf('public void downloadModel'));
  assert.match(download.slice(0, 500), /requireWifi/);
});

console.log('stats');

t('reading counts progress, not page turns', () => {
  // Flipping back and forth in one chapter used to raise the page count
  // every time, so the numbers went up for doing nothing.
  const js = read('app/src/main/assets/www/js/reader.js');
  assert.match(js, /furthest/);
  const count = js.slice(js.indexOf('function countPage'), js.indexOf('export async function flushSession'));
  assert.match(count, /if \(reached <= session\.furthest\) return/);
  // Time still accrues either way: re-reading a paragraph is reading.
  assert.ok(count.indexOf('session.active += gap') < count.indexOf('session.furthest'),
    'the clock stops when you turn back');
});

t('several language packs can be fetched in one go', () => {
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Download all \$\{missing\.length\}/);
  // One failure must not abandon the rest of the queue.
  const bulk = panels.slice(panels.indexOf('Download all'), panels.indexOf('if (!needed.length)'));
  assert.match(bulk, /catch \(error\)/);
});

console.log(`\n${pass} assertions passed`);
