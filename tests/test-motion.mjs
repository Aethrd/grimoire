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

t('scroll mode can actually be scrolled', () => {
  // The tap layer covered the scrollable area and swallowed every drag, so
  // the text could not be moved at all.
  assert.match(css, /\[data-mode="scroll"\] \.tap-layer \{ pointer-events: none; \}/);
  const app = read('app/src/main/assets/www/js/app.js');
  // Taps are recognised from the host instead, and only when the finger did
  // not travel -- anything else is a scroll.
  assert.match(app, /Scroll mode taps/);
  assert.match(app, /moved \|\| Date\.now\(\) - tapAt > 400/);
});

t('dragging the rail does not fight endless loading', () => {
  // Appending the next chapter changes scrollHeight, and a thumb positioned
  // as a fraction of it jumps backwards the instant that happens.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /export function setScrubbing/);
  assert.match(reader, /extending \|\| scrubbing/);
  // And a handle longer than its rail would overhang the bottom.
  assert.match(reader, /Math\.min\(1, viewport\.clientHeight \/ viewport\.scrollHeight\)/);
});

t('a tap in scroll mode does nothing but toggle chrome', () => {
  // No page turn, no chapter change, anywhere on the screen. Both were being
  // triggered by accident while reading.
  const app = read('app/src/main/assets/www/js/app.js');
  // Bounded by the block itself: el('chapter-prev') also appears earlier, in
  // paintReader, which made this slice run backwards and match nothing.
  const start = app.indexOf('/* Scroll mode taps.');
  const taps = app.slice(start, app.indexOf("el('chapter-prev').onclick", start));
  assert.match(taps, /reader\.cycleChrome\(\)/);
  assert.ok(!/reader\.turn\(/.test(taps), 'a scroll-mode tap can still turn a page');
  assert.ok(!/Chapter\(/.test(taps), 'a scroll-mode tap can still change chapter');
});

t('no tap or swipe crosses a chapter, in either mode', () => {
  // Turning a whole chapter is a far larger movement than a page. Sharing a
  // gesture with the page turn means doing the larger one by accident every
  // time a chapter ends.
  const reader = read('app/src/main/assets/www/js/reader.js');
  const turn = reader.slice(reader.indexOf('export function turn'), reader.indexOf('export function goToPage'));
  assert.ok(!/Chapter\(/.test(turn), 'turn() still reaches for a chapter somewhere');
  // It reports the refusal rather than looking like a missed tap.
  assert.match(turn, /return false/);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /if \(!reader\.turn\(/);
  assert.match(app, /function atChapterEdge/);
  // Said once, not on every attempt at the end of a chapter.
  assert.match(app, /Date\.now\(\) - edgeToldAt < 2500/);
});

t('an unmeasured page count cannot let a turn through', () => {
  // NaN fails every comparison silently, so a chapter that never measured
  // would slip straight past the check meant to stop it.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /Number\.isFinite\(state\.pageCount\)/);
  assert.match(reader, /Number\.isFinite\(count\)/);
});

t('turn() still refuses to change chapter in scroll mode', () => {
  // Tapping near the top jumped to the previous chapter, which is a violent
  // answer to "scroll up a bit".
  const reader = read('app/src/main/assets/www/js/reader.js');
  // Only the scroll branch. In paged mode turning past the last page moving
  // to the next chapter is exactly right.
  const turn = reader.slice(reader.indexOf('export function turn'), reader.indexOf('export function goToPage'));
  const scrollBranch = turn.slice(turn.indexOf('if (isScroll())'), turn.indexOf('const next = state.page'));
  assert.ok(!/Chapter\(/.test(scrollBranch), 'a tap can still fall through to a chapter change');
  assert.match(scrollBranch, /Math\.max\(0, Math\.min\(limit/, 'the scroll is not clamped at the ends');
});

t('the chapter buttons say when they cannot move', () => {
  // Doing nothing at the first chapter is correct, and indistinguishable
  // from being broken.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /export function hasNextChapter/);
  assert.match(reader, /export function hasPrevChapter/);
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /Already at the first chapter/);
  assert.match(app, /el\('chapter-prev'\)\.disabled = !reader\.hasPrevChapter\(\)/);
});

t('the side tap zones leave a wide middle band', () => {
  const store = read('app/src/main/assets/www/js/store.js');
  const match = /tapZone: ([\d.]+)/.exec(store);
  assert.ok(match, 'no default tap zone');
  assert.ok(Number(match[1]) <= 0.2, `sides are ${match[1]} of the width each, which crowds the centre`);
});

t('an async bridge reply is parsed whichever shape it arrives in', () => {
  // The native side evaluated settle(id, true, {…}) with the JSON injected
  // raw, so the payload arrived already parsed -- and JSON.parse on an object
  // gives "[object Object]" and throws. Every translation failed on it.
  const translate = read('app/src/main/assets/www/js/translate.js');
  assert.match(translate, /if \(typeof value === 'object'\) return value/);
  const java = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  assert.match(java, /JSONObject\.quote\(payloadJson\)/, 'the payload still crosses unquoted');
});

t('a book with no declared language is detected, not asked about', () => {
  // Switching translation on means wanting whatever is foreign translated.
  // Asking which language a scraped EPUB happens to be in is the wrong
  // question, and ML Kit does not detect on its own -- so identification is
  // run first, from the text.
  const java = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  assert.match(java, /LanguageIdentification\.getClient\(\)/);
  assert.match(java, /"und"\.equals\(code\)/, 'an unidentifiable text is not handled');
  // Same language in and out is a no-op, not an error.
  assert.match(java, /if \(source\.equals\(target\)\)/);

  const store = read('app/src/main/assets/www/js/store.js');
  assert.ok(!/translateSource/.test(store), 'the source setting is back');
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.ok(!/Translate from/.test(panels), 'the source picker is back');

  const translate = read('app/src/main/assets/www/js/translate.js');
  assert.match(translate, /export function sourceFor\(book\)/);
});

t('a failed translation can be diagnosed on the device', () => {
  // Six things can be wrong and unchanged titles distinguish none of them.
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Check it works/);
  for (const row of ['Engine', 'Its language', 'Packs installed', 'Result']) {
    assert.ok(panels.includes(`'${row}'`), `the report does not mention ${row}`);
  }
});

await (async () => {
  /* Showing or hiding the chrome changes the viewport's height and re-flows
   * the text. Restoring the position through a page index rounded it to the
   * nearest whole screenful, so a tap moved the page under the reader. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const reader = await import(new URL('../app/src/main/assets/www/js/reader.js', import.meta.url).href);

  const id = await store.add('books', { title: 'Scrolled', fingerprint: 'sc', addedAt: 1 });
  await store.put('chapters', {
    bookId: id, index: 0, title: 'One', words: 800,
    html: Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i}.</p>`).join(''),
  });

  reader.init({ onChange() {} });
  await reader.open(id);
  await reader.setMode('scroll');

  // jsdom measures nothing, so give the viewport a size and place ranges by
  // where their paragraph sits.
  const viewport = document.getElementById('page-viewport');
  Object.defineProperty(viewport, 'clientHeight', { get: () => 800, configurable: true });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => 8000, configurable: true });
  viewport.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 800 });
  let top = 0;
  Object.defineProperty(viewport, 'scrollTop',
    { get: () => top, set: (v) => { top = v; }, configurable: true });
  window.Range.prototype.getBoundingClientRect = function rect() {
    const paragraphs = [...document.querySelectorAll('#page-flow p')];
    const at = paragraphs.indexOf(this.startContainer.parentElement);
    return { top: (at < 0 ? 0 : at * 100) - top, left: 0, width: 5, height: 20 };
  };

  await t('a re-flow in scroll mode leaves the text where it was', async () => {
    // Deliberately not on a screen boundary: rounding to one is the bug.
    viewport.scrollTop = 1234;
    reader.state.anchor = 0;
    reader.repaginate();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(viewport.scrollTop, 1234,
      `the page moved ${Math.abs(viewport.scrollTop - 1234)}px`);
    // And it is not a multiple of the viewport height, which is what going
    // through a page index would have produced.
    assert.ok(viewport.scrollTop % 800 !== 0);
  });
})();

console.log('settings render for real');

// jsdom now has a working IndexedDB, so the panes can actually be rendered
// rather than pattern-matched. This exists because "the scroll toggle is
// absent" was reported twice and grepping the source said it was there.
const panels = await import(new URL('../app/src/main/assets/www/js/panels.js', import.meta.url).href);

async function renderPane(name) {
  await panels.openSettings(() => {});
  const button = [...document.getElementById('settings-strip').children]
    .find((b) => b.dataset.pane === name);
  button.onclick();
  await new Promise((r) => setTimeout(r, 80));
  return document.getElementById('settings-body').innerHTML;
}

const layoutPane = await renderPane('layout');
const behaviourPane = await renderPane('behaviour');

t('the layout pane really renders a paged/scroll switch', () => {
  assert.match(layoutPane, /Paged/);
  assert.match(layoutPane, /Scroll/);
  assert.match(layoutPane, /Endless/);
});

t('the behaviour pane renders its controls', async () => {
  // Not an empty pane pretending to be a feature.
  assert.ok(behaviourPane.length > 300, `behaviour pane was ${behaviourPane.length} chars`);
  assert.match(behaviourPane, /Tap the sides/);
});

console.log('settings panes update in place');

/* The Theme, Translation and Vault panes are each also a screen of their own,
 * and used to render into their own element which Settings then emptied into
 * itself. Every internal re-render went back to that now-hidden element, so
 * changing the engine, the target language, or downloading a pack all looked
 * like they did nothing at all. */

// A stand-in for the native bridge, so the pane has something to report.
window.GrimoireTranslate = {
  status: () => JSON.stringify({ engine: 'ondevice', configured: true }),
  supports: () => true,
  models: (id) => setTimeout(() => window.Grimoire.settle(id, true, '[]'), 0),
};
const translate = await import(new URL('../app/src/main/assets/www/js/translate.js', import.meta.url).href);
window.Grimoire = { settle: translate.settle };

const translationPane = await renderPane('translation');

t('the translation pane renders into the settings body', () => {
  assert.ok(translationPane.length > 500, `pane was ${translationPane.length} chars`);
  assert.equal(document.getElementById('language-body').innerHTML, '',
    'the pane rendered into its own hidden element instead');
});

t('changing the target language updates the pane you are looking at', async () => {
  const body = document.getElementById('settings-body');
  const chip = [...body.querySelectorAll('.chip')].find((c) => /Deutsch/.test(c.textContent));
  assert.ok(chip, 'no target-language chips rendered');
  chip.onclick();
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(document.getElementById('language-body').innerHTML, '',
    'the re-render went to the hidden element again');
  const german = [...body.querySelectorAll('.chip')].find((c) => /Deutsch/.test(c.textContent));
  assert.equal(german.getAttribute('aria-pressed'), 'true',
    'the visible pane still shows the old selection');
});

t('every supported language can be downloaded, not just the library\u2019s', () => {
  assert.equal(typeof translate.allLanguages, 'function');
  // Well over the handful a library uses, and each with a readable name.
  const names = Object.keys(translate.LANGUAGE_NAMES);
  assert.ok(names.length >= 50, `only ${names.length} languages listed`);
  for (const tag of names) assert.ok(translate.LANGUAGE_NAMES[tag].length > 2);
  const panelsSrc = read('app/src/main/assets/www/js/panels.js');
  assert.match(panelsSrc, /Other languages \(\$\{rest\.length\}\)/);
});

console.log(`\n${pass} assertions passed`);
