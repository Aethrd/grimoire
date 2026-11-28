/* The stats page kept up to date while it is open: every minute -- unless an
 * operation is running, when it waits, and is drawn once the last of them has
 * finished (or once a day, if they run that long). Not under a day's card
 * left open. The real page and the real progress panel, with the minute
 * timer and the clock in the test's hands. */
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const window = await boot();
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const store = await import(www('store.js'));

// The minute timer, caught; every other timer as it is.
const minutely = [];
const realInterval = globalThis.setInterval;
const catching = (fn, ms, ...rest) => {
  if (ms === 60000) { minutely.push(fn); return 0; }
  return realInterval(fn, ms, ...rest);
};
globalThis.setInterval = catching;
window.setInterval = catching;
// The clock, movable.
let shift = 0;
const realNow = Date.now;
Date.now = () => realNow() + shift;

const book = await store.add('books', { title: 'Read Daily', fingerprint: 'r:1', addedAt: 1, chapters: 3 });
await store.add('events', { bookId: book, day: store.dayKey(realNow()), at: realNow(), pages: 4, words: 900, activeMs: 120000, chapters: 1 });

const app = await import(www('app.js'));
await settle(600);
const el = (id) => window.document.getElementById(id);
const go = async (name) => { window.document.querySelector(`#tabbar [data-go="${name}"]`).click(); await settle(300); };

await go('stats');
const body = el('stats-body');
const minute = async () => { minutely.at(-1)(); await settle(200); };
// A mark on what is drawn: gone when the page is drawn again.
const mark = () => { body.firstElementChild.dataset.mark = 'then'; };
const redrawn = () => !body.querySelector('[data-mark]');

await t('open, it is drawn again every minute', async () => {
  assert.ok(body.querySelector('.heat i[data-day]'), 'no heat map');
  assert.ok(minutely.length >= 1, 'no minute timer');
  mark();
  await minute();
  assert.ok(redrawn());
  // A day read since: there at the next minute.
  await store.add('events', { bookId: book, day: store.dayKey(realNow()), at: realNow(), pages: 2, words: 400, activeMs: 60000, chapters: 1 });
  await minute();
  const today = body.querySelector('.heat i.today');
  today.click();
  assert.match(body.querySelector('.heat-tip').textContent, /1,300 words/);
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
});

await t('each day shaded against four hours of reading (or 62,400 words), not against the other days', async () => {
  const day = (n) => store.dayKey(realNow() - n * 86400000);
  const at = (n) => realNow() - n * 86400000;
  // Five hours on a comic, hardly a word: the far end. 31,200 words: half. Two hours: half. Ten minutes: a sliver.
  await store.add('events', { bookId: book, day: day(3), at: at(3), pages: 300, words: 40, activeMs: 5 * 3600000, chapters: 2 });
  await store.add('events', { bookId: book, day: day(4), at: at(4), pages: 0, words: 31200, activeMs: 0, chapters: 6, elsewhere: true });
  await store.add('events', { bookId: book, day: day(5), at: at(5), pages: 40, words: 100, activeMs: 2 * 3600000, chapters: 1 });
  await store.add('events', { bookId: book, day: day(6), at: at(6), pages: 6, words: 2000, activeMs: 10 * 60000, chapters: 1 });
  await minute();
  const cell = (n) => body.querySelector(`.heat i[data-day="${day(n)}"]`);
  assert.equal(cell(3).style.getPropertyValue('--fill'), '1');
  assert.equal(cell(3).dataset.l, '4');
  assert.equal(cell(3).style.getPropertyValue('--heat-c'), 'var(--grad-s0)');
  assert.equal(cell(4).style.getPropertyValue('--fill'), '0.5');
  assert.equal(cell(4).dataset.l, '2');
  assert.equal(cell(5).style.getPropertyValue('--fill'), '0.5');
  assert.equal(Number(cell(6).style.getPropertyValue('--fill')).toFixed(3), (10 / 240).toFixed(3));
  assert.equal(cell(6).dataset.l, '1');
  // The heaviest day shown no longer takes the far end because it is the heaviest.
  assert.notEqual(cell(4).style.getPropertyValue('--heat-c'), 'var(--grad-s0)');
  // A day with nothing: empty.
  assert.equal(cell(9).dataset.l, '0');
});

await t('not under a day’s card left open: it waits for the card to close', async () => {
  body.querySelector('.heat i.today').click();
  assert.ok(!body.querySelector('.heat-tip').hidden);
  mark();
  await minute();
  assert.ok(!redrawn(), 'drawn from under the card');
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  await minute();
  assert.ok(redrawn());
});

await t('while an operation runs: not every minute; once the last one ends', async () => {
  const first = app.progress.start('Downloading');
  const second = app.progress.start('Exporting');
  mark();
  await minute();
  await minute();
  assert.ok(!redrawn(), 'drawn while running');
  first();
  await settle(200);
  assert.ok(!redrawn(), 'drawn with one still running');
  second();
  await settle(200);
  assert.ok(redrawn(), 'not drawn when the last ended');
  // Nothing owed, nothing more: the next is the minute's.
  mark();
  const third = app.progress.start('Importing');
  third();
  await settle(200);
  assert.ok(!redrawn(), 'drawn for nothing');
  await minute();
  assert.ok(redrawn());
});

await t('an operation running for over a day: drawn once a day all the same', async () => {
  const long = app.progress.start('A long download');
  mark();
  shift = 23 * 60 * 60 * 1000;
  await minute();
  assert.ok(!redrawn());
  shift = 24 * 60 * 60 * 1000 + 60000;
  await minute();
  assert.ok(redrawn(), 'not drawn after a day');
  mark();
  await minute();
  assert.ok(!redrawn(), 'drawn every minute after the day');
  long();
  await settle(200);
  assert.ok(redrawn());
  shift = 0;
});

await t('left, it is not drawn; back, it is drawn and kept up again', async () => {
  await go('library');
  const timers = minutely.length;
  await minute();
  await go('stats');
  assert.ok(minutely.length > timers, 'no new minute timer on coming back');
  mark();
  await minute();
  assert.ok(redrawn());
});

globalThis.setInterval = realInterval;
window.setInterval = realInterval;
Date.now = realNow;
console.log(`\n${pass} checks passed`);
process.exit(0);
