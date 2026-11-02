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
  assert.equal(store.DEFAULT_SETTINGS.readingMode, 'paged');
  assert.equal(store.DEFAULT_SETTINGS.endlessScroll, true);
});

t('how you read is a setting, not a property of one book', () => {
  // It used to live in the per-book layout, where choosing scroll on one book
  // left every other one paged -- which reads as the app forgetting.
  assert.ok(!('mode' in store.DEFAULT_LAYOUT), 'reading mode is back in the layout');
  assert.ok(!('endless' in store.DEFAULT_LAYOUT));

  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /store\.saveSettings\(\{ readingMode: mode \}\)/);
  assert.match(reader, /store\.saveSettings\(\{ endlessScroll: on \}\)/);
  // An older install still carrying it in a layout row is honoured once, so
  // nobody loses the mode they had.
  assert.match(reader, /settings\.readingMode \|\| layout\.mode \|\| 'paged'/);
  // And re-applying the layout with no settings -- every slider in the layout
  // sheet does -- keeps the mode on screen rather than falling back to paged.
  assert.match(reader, /\(state\.book \? state\.mode : layout\.mode \|\| state\.mode \|\| 'paged'\)/);
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
  // Staying put when the measurement fails, rather than reading "could not
  // measure" as "the beginning".
  // Without the slide -- and keeping the place it was given (see show()).
  assert.match(js, /show\(pageAtAnchor\(anchor, chapter\) \?\? state\.page, \{ animate: false, keepAnchor: true \}\)/);
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
  // the text could not be moved at all. It takes no touches now, in either
  // mode -- which is also what lets a long press reach the words.
  assert.match(css, /\.tap-layer \{ pointer-events: none; \}/);
  const app = read('app/src/main/assets/www/js/app.js');
  // Taps are read from the host instead, and only when the finger did not
  // travel -- anything else is a scroll or a selection.
  assert.match(app, /Taps, in both modes/);
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

t('the overlay never takes a touch, so text can be selected', () => {
  // It sat over the words, so a long press landed on it and Android's Copy,
  // Translate and Web search never appeared.
  assert.match(css, /\.tap-layer \{ pointer-events: none; \}/);
  assert.match(css, /\.page-flow \{\n  -webkit-user-select: text; user-select: text;/);
  assert.match(css, /-webkit-touch-callout: default/);
});

t('only the book\u2019s own words can be selected', () => {
  // One rule turns selection on, and it is on the container that holds
  // nothing but chapters. Everything else -- the header, the position line,
  // the copy row, every other screen -- inherits the app-wide `none`.
  const enabling = [...css.matchAll(/([^{}]+)\{[^}]*user-select:\s*text/g)]
    .map((m) => m[1].trim().split('\n').pop().trim());
  // The book, and anything typed into -- a field whose text cannot be
  // selected has no caret and no paste.
  assert.deepEqual(enabling.sort(), ['.page-flow', 'input, textarea'],
    `selection is enabled somewhere else: ${enabling.join(', ')}`);

  // And two things inside the flow that are not the author's words: the label
  // the app puts above a translated chapter, and illustrations, which would
  // otherwise offer the system's image menu.
  assert.match(css, /\.page-flow \.chapter::before \{ -webkit-user-select: none/);
  assert.match(css, /\.page-flow img, \.page-flow figure \{/);
  assert.match(css, /-webkit-touch-callout: none/);
});

t('the end of a chapter is reachable without the buttons', () => {
  /* Asked for both ways at different times, and both are right: a tap must
   * not turn a whole chapter by accident, and reaching the end should not
   * mean hunting for a button. Asking twice keeps them apart -- the second
   * tap is a page turn that happens to land on nothing, not a decision. */
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /edgeDirection === direction && Date\.now\(\) - edgeToldAt < 4000/);
  assert.match(app, /tap again to carry on/);
  assert.match(app, /await reader\.nextChapter\(\)/);
  // And it can be set to either extreme for anyone who wants one.
  const store = read('app/src/main/assets/www/js/store.js');
  assert.match(store, /chapterOnEdge: 'confirm'/);
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Carry straight on/);
  assert.match(panels, /Only the buttons/);
});

t('pictures can be fitted more than one way', () => {
  // A page of prose and a page of comic want different things from the same
  // rule, and a scan of a two-page spread wants a third.
  for (const mode of ['screen', 'width', 'height', 'stretch', 'original', 'smart']) {
    assert.ok(css.includes(`[data-images="${mode}"]`), `no rule for ${mode}`);
  }
  // Fit screen neither crops nor distorts, so it is the default.
  const store = read('app/src/main/assets/www/js/store.js');
  assert.match(store, /imageFit: 'screen'/);
  // Smart fitting needs the shape of each picture, which is only known once
  // it has loaded.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /classList\.toggle\('landscape'/);
  assert.match(reader, /classList\.toggle\('tall'/);
});

t('the body carries every setting the stylesheet reads', () => {
  // These were set from the reader and the settings panes but never from the
  // theme, so a fresh launch had none of them until a pane was opened.
  const theme = read('app/src/main/assets/www/js/theme.js');
  for (const key of ['marks', 'images', 'focus', 'keepParagraphs']) {
    assert.match(theme, new RegExp(`dataset\\.${key} =`), `${key} is not applied at launch`);
  }
  assert.match(theme, /--mark-opacity/);
});

t('a tap is a finger that neither moved nor lingered', () => {
  // Which is exactly what separates a page turn from the start of a
  // selection, and it is read from the host rather than the overlay.
  const app = read('app/src/main/assets/www/js/app.js');
  const taps = app.slice(app.indexOf('/* Taps, in both modes.'),
    app.indexOf('// Swipe, independently'));
  assert.match(taps, /moved \|\| Date\.now\(\) - tapAt > 400/);
  // And a tap that only dismisses an existing selection is not a turn either.
  assert.match(taps, /getSelection\?\.\(\)\.isCollapsed/);
  assert.match(taps, /reader\.cycleChrome\(\)/);

  // A swipe is the same shape as dragging out a selection, so it stands down
  // for one too -- otherwise the page turns out from under the selection.
  const swipe = app.slice(app.indexOf('// Swipe, independently'), app.indexOf("el('chapter-prev').onclick"));
  assert.match(swipe, /getSelection\?\.\(\)\.isCollapsed/);
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
  assert.match(translate, /export function sourceFor\(book, text = ''\)/);
});

t('a failed translation can be diagnosed on the device', () => {
  // Six things can be wrong and unchanged titles distinguish none of them.
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /Check it works/);
  for (const row of ['Engine', 'Its language', 'Packs installed', 'Result']) {
    assert.ok(panels.includes(`'${row}'`), `the report does not mention ${row}`);
  }
});




t('the passage being read is held together across a re-flow', () => {
  // Changing the type size re-flows everything, and the paragraph someone is
  // halfway through can end up split across the break -- precisely the one
  // that should not be.
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /function keepPassageWhole/);
  // Only when it is actually split, and only that paragraph.
  assert.match(reader, /if \(startsIn === endsIn\) return/);
  assert.match(reader, /block\.classList\.add\('keep-whole'\)/);
  // One correction, not a loop: fixing a break can make another.
  const fn = reader.slice(reader.indexOf('function keepPassageWhole'));
  assert.equal((fn.slice(0, 1600).match(/keepPassageWhole\(/g) || []).length, 1,
    'the correction calls itself');
  assert.match(css, /\.page-flow \.keep-whole \{ break-inside: avoid/);
});

t('the desk is a workspace over the book, not a screen away from it', () => {
  const app = read('app/src/main/assets/www/js/app.js');
  // Where to come back to, recorded once when the desk opens.
  assert.match(app, /home: \{ chapterIndex: reader\.state\.chapterIndex/);
  assert.match(app, /async function closeDesk/);
  // Tapping outside is a peek at the page, not a close -- closing moves the
  // reader, which is not what tapping outside asks for.
  assert.match(app, /Dismissing by the scrim is a peek at the page/);
  // Pins belong to the desk and go with it.
  assert.match(app, /desk\.pinned\.push/);
  assert.match(app, /desk = null/);
});

t('a chapter does not wait forever for a picture', () => {
  // An image that fires neither load nor error would leave the chapter
  // waiting indefinitely, and a book that never opens is worse than one
  // measured a moment before its pictures arrive.
  const reader = read('app/src/main/assets/www/js/reader.js');
  const fn = reader.slice(reader.indexOf('function imagesSettled'));
  assert.match(fn.slice(0, 900), /Promise\.race/);
  assert.match(fn.slice(0, 900), /setTimeout\(res, 3000\)/);
});

t('the reel measures several pictures at once', () => {
  // Each measurement gives up after a few seconds if a picture will not
  // decode, and taken in turn that is a few seconds each -- a book with two
  // hundred illustrations would sit there for minutes before drawing
  // anything.
  const screens = read('app/src/main/assets/www/js/screens.js');
  assert.match(screens, /const AT_ONCE = 8/);
  assert.match(screens, /await Promise\.all\(unmeasured\.slice/);
  // Volumes lead the reel where a book has them.
  assert.match(screens, /new Set\(images\.map\(\(i\) => i\.volume\)\.filter\(Boolean\)\)/);
  assert.match(screens, /reelVolume && image\.volume !== reelVolume/);
  assert.match(css, /\.reel-volume \{/);
});

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

t('a notice can be read through', () => {
  /* These say things about the page you are looking at -- that you have
   * reached the end of a chapter -- and a solid block covering the words it
   * is talking about is the wrong way round. */
  assert.match(css, /@supports \(backdrop-filter: blur\(6px\)\)/);
  assert.match(css, /color-mix\(in srgb, var\(--accent-900\) 62%, transparent\)/);
  assert.match(css, /backdrop-filter: blur\(7px\)/);

  /* The blur is what makes it legible: without it the text underneath shows
   * through as noise. So where it is unsupported the notice stays opaque
   * rather than becoming unreadable. */
  const plain = css.slice(css.indexOf('.toast {'), css.indexOf('@supports (backdrop-filter'));
  assert.match(plain, /background: var\(--accent-900\);/);
});

t('the annotation bar stays on the screen', () => {
  /* It used to measure the room above a selection and, finding little, place
   * itself above anyway -- so selecting a line near the top put the bar off
   * the top edge where most of it could not be seen. */
  const app = read('app/src/main/assets/www/js/app.js');
  const place = app.slice(app.indexOf('function placeAnnotateBar'), app.indexOf('function hideAnnotateBar'));
  assert.match(place, /if \(top > limit\) top = rect\.top - height - margin/);
  assert.match(place, /Math\.max\(margin, Math\.min\(top, Math\.max\(margin, limit\)\)\)/);
  // Measured, not guessed, so a taller bar is still placed correctly.
  assert.match(place, /bar\.offsetHeight/);
});

t('using the bar does not count as losing the selection', () => {
  /* Pressing a colour collapses the selection, which fired selectionchange,
   * which hid the bar -- so the press appeared to do nothing and the bar
   * vanished under the finger. */
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /let usingBar = false/);
  assert.match(app, /addEventListener\('pointerdown', \(\) => \{ usingBar = true; \}\)/);
  assert.match(app, /if \(usingBar\) return;/);
});

t('a mark can be taken off from the bar that made it', () => {
  // Removing was only reachable by tapping the mark afterwards to open its
  // note, which is not where anyone looks for it.
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /el\('annotate-remove'\)\.hidden = !around/);
  assert.match(app, /await reader\.removeMark\(around\.id\)/);
  const reader = read('app/src/main/assets/www/js/reader.js');
  assert.match(reader, /export function markAt/);
});

t('a colour swatch is big enough to hit', () => {
  // A swatch was a 28px circle, about half what a finger needs, so taps
  // landed between them. The circle looks the same; the button is bigger.
  const rule = css.slice(css.indexOf('.annotate-colours button {'), css.indexOf('.annotate-colours button::before'));
  assert.match(rule, /width: 44px; height: 44px/);
  assert.match(css, /\.annotate-colours button::before/);
});

t('anything offered as a choice is big enough to press', () => {
  /* A chip is 23px tall at its own padding, which is half what a finger
   * needs. Finding an option and being unable to hit it is the same as the
   * option not being there. */
  const ruleFor = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at > -1, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(ruleFor('.chip'), /min-height: 40px/);
  assert.match(ruleFor('.seg button'), /min-height: 42px/);
  assert.match(ruleFor('.list-row'), /min-height: 48px/);
});

t('sideways scrolling does not fight the page turn', () => {
  // A paged layout is columns moved by a transform, and a scroller on the
  // same element competes with it: the flow shifts a little instead of the
  // page moving, and a tap meant for the middle lands on a surface that has
  // moved under it.
  for (const mode of ['height', 'original', 'smart']) {
    assert.ok(css.includes(`[data-mode="scroll"][data-images="${mode}"] .page-flow { overflow-x: auto; }`),
      `${mode} scrolls sideways in paged mode too`);
  }
});

t('picture fitting is reachable from the book, not only from settings', () => {
  // It is a decision made while looking at a page -- this volume is a scan of
  // a spread, that one is a long strip -- and a setting three screens away
  // from the page is a setting nobody finds.
  const screens = read('app/src/main/assets/www/js/screens.js');
  const layout = screens.slice(screens.indexOf('export async function openLayout'));
  for (const label of ['Fit screen', 'Fit width', 'Fit height', 'Stretch', 'Original', 'Smart']) {
    assert.ok(layout.includes(`'${label}'`), `${label} is not in the layout sheet`);
  }
  assert.match(layout, /store\.saveSettings\(\{ imageFit: value \}\)/);
});

t('every picture fitting is offered, drawn not just defined', () => {
  /* A rule in the stylesheet with no way to choose it is not a feature. */
  for (const label of ['Fit screen', 'Fit width', 'Fit height', 'Stretch',
    'Original size', 'Smart fit']) {
    assert.ok(behaviourPane.includes(label), `${label} is not offered`);
  }
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
