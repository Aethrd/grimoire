import assert from 'node:assert/strict';
import { boot } from './harness.mjs';
await boot();

const theme = await import(new URL('../app/src/main/assets/www/js/theme.js', import.meta.url).href);
const lib   = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok  ' + name); pass++; };
/* Awaited separately: the summary at the end of this file is printed
   synchronously, so an async test that is merely started would not be
   counted by the time it runs. */
const t2 = async (name, fn) => { await fn(); console.log('  ok  ' + name); pass++; };

console.log('theme');
t('ramp produces eight steps, light to dark', () => {
  const steps = theme.ramp('#b4b0d6');
  assert.equal(steps.length, 8);
  assert.match(steps[0], /^#[0-9a-f]{6}$/);
  const lum = (h) => parseInt(h.slice(1,3),16) + parseInt(h.slice(3,5),16) + parseInt(h.slice(5,7),16);
  assert.ok(lum(steps[0]) > lum(steps[7]), 'step 100 must be lighter than step 900');
});
t('ramp steps hold the base hue wherever hue is meaningful', () => {
  // The 96%-lightness step is excluded on purpose: at that lightness sRGB has
  // ~2 levels of channel separation left, so the recovered hue is noise. Every
  // step carrying real colour must stay on the base hue.
  const base = theme.rgbToHsl(...theme.hexToRgb('#a9c3bd'))[0];
  const steps = theme.ramp('#a9c3bd').slice(1);
  for (const step of steps) {
    const [h, s] = theme.rgbToHsl(...theme.hexToRgb(step));
    assert.ok(s > 0.08, `step lost its colour: ${step}`);
    assert.ok(Math.abs(h - base) < 3, `hue drifted to ${h.toFixed(1)} at ${step}`);
  }
});
t('contrast ratio matches the WCAG reference values', () => {
  assert.ok(Math.abs(theme.contrast('#ffffff','#000000') - 21) < 0.01);
  assert.ok(Math.abs(theme.contrast('#777777','#ffffff') - 4.48) < 0.05);
});
t('guard refuses a failing pair and returns a passing step of the same hue', () => {
  // Pale wisteria on the pale light ground is nowhere near 4.5:1.
  const r = theme.guard('#b4b0d6', '#f6f5f8');
  assert.equal(r.ok, false, 'that pair should be refused');
  assert.ok(theme.contrast(r.ink, '#f6f5f8') >= 4.5, 'replacement must pass');
});
t('guard passes a pair that already clears the bar', () => {
  const r = theme.guard('#3d3868', '#f6f5f8');
  assert.equal(r.ok, true);
});

console.log('sort');
const books = [
  { id:1, title:'Salt Almanac',  author:'Oyelaran', lastReadAt: 300, addedAt: 1, seriesIndex: 2 },
  { id:2, title:'Nine Ways',     author:'Halvorsen', lastReadAt: null, addedAt: 2, seriesIndex: null },
  { id:3, title:'Field Notes',   author:'Amara',    lastReadAt: 100, addedAt: 3, seriesIndex: 1 },
  { id:4, title:'Winterlight',   author:'Pae',      lastReadAt: null, addedAt: 4, seriesIndex: 3 },
];
t('nulls sort last ascending', () => {
  const r = lib.sortBooks(books, [['lastRead','asc']]).map(b=>b.id);
  assert.deepEqual(r.slice(0,2), [3,1]);
  assert.deepEqual(r.slice(2).sort(), [2,4]);
});
t('nulls stay last descending — the rule a plain reverse would break', () => {
  const r = lib.sortBooks(books, [['lastRead','desc']]).map(b=>b.id);
  assert.deepEqual(r.slice(0,2), [1,3], 'read books first');
  assert.deepEqual(r.slice(2).sort(), [2,4], 'nulls must NOT float to the top');
});
t('later keys break ties from earlier ones', () => {
  const tied = [
    { id:1, author:'Zed',  addedAt: 5 },
    { id:2, author:'Abe',  addedAt: 5 },
    { id:3, author:'Mary', addedAt: 1 },
  ];
  assert.deepEqual(lib.sortBooks(tied, [['added','desc'],['author','asc']]).map(b=>b.id), [2,1,3]);
});
t('sort is stable for fully equal rows', () => {
  const same = [{id:1},{id:2},{id:3}];
  assert.deepEqual(lib.sortBooks(same, [['author','asc']]).map(b=>b.id), [1,2,3]);
});

console.log('group');
t('groups nest and carry per-node counts', () => {
  const g = lib.groupBooks([
    {id:1, series:'Winterlight', format:'EPUB'},
    {id:2, series:'Winterlight', format:'CBZ'},
    {id:3, series:null,          format:'EPUB'},
  ], ['series','format']);
  const winter = g.find(n=>n.label==='Winterlight');
  assert.equal(winter.count, 2);
  assert.deepEqual(winter.children.map(c=>c.label).sort(), ['CBZ','EPUB']);
  assert.equal(g.find(n=>n.label==='Standalone').count, 1);
});

t('status groups run reading, unread, finished', () => {
  // Sorted by name it reads Finished, Reading, Unread -- the books you have
  // already finished at the top, and the one you are in the middle of buried
  // beneath them.
  const states = [
    { finishedAt: 1, lastReadAt: 5 },
    {},
    { lastReadAt: 9 },
    { finishedAt: 2 },
    {},
  ];
  assert.deepEqual(
    lib.groupBooks(states, ['status']).map((g) => [g.label, g.count]),
    [['Reading', 1], ['Unread', 2], ['Finished', 2]]);
});

t('levels with no natural order stay alphabetical', () => {
  const formats = [{ format: 'PDF' }, { format: 'CBZ' }, { format: 'EPUB' }];
  assert.deepEqual(
    lib.groupBooks(formats, ['format']).map((g) => g.label),
    ['CBZ', 'EPUB', 'PDF']);
});

t('the order applies at whichever level status sits', () => {
  const mixed = [
    { format: 'EPUB', finishedAt: 1 },
    { format: 'EPUB', lastReadAt: 2 },
    { format: 'EPUB' },
  ];
  assert.deepEqual(
    lib.groupBooks(mixed, ['format', 'status'])[0].children.map((g) => g.label),
    ['Reading', 'Unread', 'Finished']);
});

console.log('translated text');

t('the tint is legible on every ground and every preset', () => {
  // Picking ramp steps by index gave 1.4:1 on the light ground, which is not
  // a tint but an invisibility: which steps read depends on the ground.
  for (const themeMode of ['dark', 'light']) {
    for (const [name, accent] of theme.ACCENT_PRESETS) {
      theme.apply({ themeMode, accent, tapZone: 0.18, veil: 0.5, heat: 'ember' });
      const root = document.documentElement.style;
      const ground = theme.GROUNDS[themeMode];
      for (const token of ['--translated-from', '--translated-to', '--translated-ink']) {
        const value = root.getPropertyValue(token).trim();
        assert.ok(theme.contrast(value, ground.bg) >= 4.5,
          `${themeMode}/${name}${token} is ${theme.contrast(value, ground.bg).toFixed(1)}:1`);
      }
    }
  }
});

t('the tint is also distinguishable from ordinary text', () => {
  // The most readable step on a dark ground is nearly the text colour, so
  // translated prose came out looking exactly like the author's -- which is
  // the one thing this is for.
  for (const themeMode of ['dark', 'light']) {
    for (const [name, accent] of theme.ACCENT_PRESETS) {
      theme.apply({ themeMode, accent, tapZone: 0.18, veil: 0.5, heat: 'ember' });
      const root = document.documentElement.style;
      const ground = theme.GROUNDS[themeMode];
      const ink = root.getPropertyValue('--translated-ink').trim();
      assert.ok(theme.contrast(ink, ground.text) >= 1.3,
        `${themeMode}/${name} body tint is indistinguishable from the text`);
    }
  }
});

t('it follows the accent rather than owning a colour', () => {
  theme.apply({ themeMode: 'dark', accent: '#C0553F', tapZone: 0.18, veil: 0.5, heat: 'ember' });
  const warm = document.documentElement.style.getPropertyValue('--translated-ink');
  theme.apply({ themeMode: 'dark', accent: '#3FA37A', tapZone: 0.18, veil: 0.5, heat: 'ember' });
  const cool = document.documentElement.style.getPropertyValue('--translated-ink');
  assert.notEqual(warm, cool);
});

console.log('reading status');

t('a state is inferred until someone says otherwise', () => {
  assert.equal(lib.statusOf({}), 'unread');
  assert.equal(lib.statusOf({ lastReadAt: 5 }), 'reading');
  assert.equal(lib.statusOf({ lastReadAt: 9, finishedAt: 9 }), 'finished');
  for (const book of [{}, { lastReadAt: 5 }, { finishedAt: 9 }]) {
    assert.equal(lib.statusIsPinned(book), false);
  }
});

t('a state that was set wins over the dates', () => {
  // The whole point of setting one: a book you have opened but put down is
  // not "reading", and the dates cannot know that.
  assert.equal(lib.statusOf({ lastReadAt: 5, status: 'onHold' }), 'onHold');
  assert.equal(lib.statusOf({ finishedAt: 9, status: 'unread' }), 'unread');
  assert.equal(lib.statusIsPinned({ lastReadAt: 5, status: 'onHold' }), true);
});

t('an unrecognised state falls back to inference', () => {
  // Rather than showing a book as something with no label.
  assert.equal(lib.statusOf({ lastReadAt: 5, status: 'banana' }), 'reading');
  assert.equal(lib.statusIsPinned({ status: 'banana' }), false);
});

t('every state has a place in the group order', () => {
  const labels = lib.groupBooks(
    [{}, { lastReadAt: 1 }, { finishedAt: 1 }, { status: 'dropped' }, { status: 'onHold' }],
    ['status']).map((g) => g.label);
  assert.deepEqual(labels, ['Reading', 'Unread', 'On hold', 'Dropped', 'Finished']);
});

t('opening a book is not reading it', () => {
  // Displaying a book saves a position, and that used to set lastReadAt --
  // so anything glanced at came back marked Reading.
  assert.equal(lib.statusOf({ lastOpenedAt: 5 }), 'unread');
  assert.equal(lib.statusOf({ lastOpenedAt: 5, lastReadAt: 6 }), 'reading');
});

t('a finished book read again is Reading until it reaches the end again', () => {
  // Finished on day 10; opened and read on day 20, now part way through.
  assert.equal(lib.statusOf({ finishedAt: 10, lastReadAt: 20, percent: 0.3 }), 'reading');
  // Back at the end: finished again, and still finished on the day it first was.
  assert.equal(lib.statusOf({ finishedAt: 10, lastReadAt: 20, percent: 1 }), 'finished');
  // Finished, and nothing read since: finished, wherever it was left.
  assert.equal(lib.statusOf({ finishedAt: 20, lastReadAt: 10, percent: 0.3 }), 'finished');
  assert.equal(lib.statusOf({ finishedAt: 20, lastReadAt: 20, percent: 0.3 }), 'finished');
  // Set by hand, it says what it was set to.
  assert.equal(lib.statusOf({ finishedAt: 10, lastReadAt: 20, percent: 0.3, status: 'finished' }), 'finished');
});

await t2('the reading and the position, written together, both land', async () => {
  /* The first page turned notes the reading (markRead) while leaving the
   * book writes the position (flushPosition). Each reads the record and
   * writes it back; run side by side, one wrote over the other. */
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const id = await store.add('books', { title: 'Race', fingerprint: 'race:1', addedAt: 1, status: 'onHold', finishedAt: null });
  for (let round = 0; round < 5; round++) {
    store.queuePosition({ bookId: id, chapterIndex: 0, page: round, percent: 0.2 + round / 10, updatedAt: Date.now() });
    await Promise.all([store.markRead(id), store.flushPosition()]);
    const book = await store.get('books', id);
    assert.equal(book.status, undefined, `round ${round}: the status the reading cleared came back`);
    assert.ok(book.lastReadAt, `round ${round}: the reading was lost`);
    assert.equal(book.percent, 0.2 + round / 10, `round ${round}: the position was lost`);
    await store.put('books', { ...book, status: 'onHold' });
  }
  await store.deleteBook(id);
});

await t2('out of a book, the shelf is drawn once what was read is written', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../app/src/main/assets/www/js/app.js', import.meta.url), 'utf8');
  const back = app.slice(app.indexOf('function back() {'), app.indexOf('/* ── library'));
  assert.match(back, /const written = previous === 'reader' \? reader\.pauseSession\(\)/);
  assert.match(back, /written\.then\(\(\) => \{ if \(current === target\) enter\(target\); \}\)/);
  assert.doesNotMatch(back, /reader\.pauseSession\(\);\s/, 'not left to land after the shelf is drawn');
});

console.log('books left unread');

{
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const titles = (books) => books.map((b) => b.title).sort();

  t('a book being read and left for five days goes on hold; the one read last never does', () => {
    const books = [
      { id: 1, title: 'Today', lastReadAt: now - 1000 },
      { id: 2, title: 'Six days', lastReadAt: now - 6 * DAY },
      { id: 3, title: 'Four days', lastReadAt: now - 4 * DAY },
      { id: 4, title: 'Exactly five', lastReadAt: now - 5 * DAY },
    ];
    assert.deepEqual(titles(lib.goneQuiet(books, { days: 5, now })), ['Exactly five', 'Six days']);
    // Read last, however long ago: it is the one being read.
    const alone = [{ id: 1, title: 'Months ago', lastReadAt: now - 90 * DAY },
      { id: 2, title: 'Older', lastReadAt: now - 95 * DAY }];
    assert.deepEqual(titles(lib.goneQuiet(alone, { days: 5, now })), ['Older']);
  });

  t('only Reading goes on hold: unread, finished, dropped and held stay as they are', () => {
    const old = now - 30 * DAY;
    const books = [
      { id: 1, title: 'Last', lastReadAt: now },
      { id: 2, title: 'Unread', addedAt: old },
      { id: 3, title: 'Finished', lastReadAt: old, finishedAt: old },
      { id: 4, title: 'Dropped', lastReadAt: old, status: 'dropped' },
      { id: 5, title: 'Held', lastReadAt: old, status: 'onHold' },
      { id: 6, title: 'Set to Reading', lastReadAt: old, status: 'reading' },
      { id: 7, title: 'Opened, never read', lastOpenedAt: old },
      { id: 8, title: 'Inferred', lastReadAt: old },
    ];
    assert.deepEqual(titles(lib.goneQuiet(books, { days: 5, now })), ['Inferred', 'Set to Reading']);
  });

  t('opening a book counts as picking it up; the bin and other editions of the last book are spared', () => {
    const old = now - 30 * DAY;
    const books = [
      { id: 1, title: 'Last', lastReadAt: now - DAY, bundleId: 1 },
      { id: 2, title: 'Its raw', lastReadAt: old, bundleId: 1 },
      { id: 3, title: 'Opened yesterday', lastReadAt: old, lastOpenedAt: now - DAY * 2 },
      { id: 4, title: 'Binned', lastReadAt: old, binnedAt: now },
      { id: 5, title: 'Passing through', lastReadAt: old, transient: true },
      { id: 6, title: 'Quiet', lastReadAt: old },
    ];
    assert.deepEqual(titles(lib.goneQuiet(books, { days: 5, now })), ['Quiet']);
  });

  t('nothing is held when it is turned off', () => {
    const books = [{ id: 1, title: 'A', lastReadAt: now }, { id: 2, title: 'B', lastReadAt: 1 }];
    assert.deepEqual(lib.goneQuiet(books, { days: 0, now }), []);
    assert.equal(lib.goneQuiet(books, { days: 5, now }).length, 1);
  });

  await t2('held books are saved On hold, and reading one makes it Reading again', async () => {
    const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
    for (const b of await store.all('books')) await store.deleteBook(b.id);
    const real = Date.now();
    const last = await store.add('books', { title: 'Last', fingerprint: 'q:1', addedAt: 1, lastReadAt: real });
    const quiet = await store.add('books', { title: 'Quiet', fingerprint: 'q:2', addedAt: 1, lastReadAt: real - 6 * DAY });
    await store.saveSettings({ autoHoldDays: 5 });
    assert.equal(await lib.holdQuietBooks(), 1);
    const held = await store.get('books', quiet);
    assert.equal(lib.statusOf(held), 'onHold');
    assert.equal(held.heldAutomatically, true);
    assert.equal(lib.statusOf(await store.get('books', last)), 'reading');
    assert.equal(await lib.holdQuietBooks(), 0, 'held once, not again');
    await store.markRead(quiet);
    const again = await store.get('books', quiet);
    assert.equal(lib.statusOf(again), 'reading');
    assert.equal(again.heldAutomatically, undefined);
    await store.saveSettings({ autoHoldDays: 0 });
    await store.put('books', { ...again, lastReadAt: real - 60 * DAY, lastOpenedAt: 0 });
    assert.equal(await lib.holdQuietBooks(), 0, 'off is off');
    await store.saveSettings({ autoHoldDays: 5 });
    for (const id of [last, quiet]) await store.deleteBook(id);
  });
}

console.log('a bundle is read as one book');

t('reading one edition is reading the bundle: its status, progress and dates follow', () => {
  const raw = { id: 1, title: 'Raw', bundleId: 1, lang: 'ko' };               // leads, never opened
  const english = { id: 2, title: 'English', bundleId: 1, lastReadAt: 500, lastOpenedAt: 520, percent: 0.4 };
  const [entry] = lib.collapseBundles([raw, english]);
  assert.equal(entry.bundle.length, 2);
  assert.equal(lib.statusOf(entry), 'reading', 'the bundle stayed Unread when an edition was being read');
  assert.equal(entry.percent, 0.4);
  assert.equal(entry.lastReadAt, 500);
  assert.equal(entry.readEdition, 2, 'Continue would open an edition not being read');
  // Set On hold on the bundle, then the English read later: Reading.
  const held = [{ ...raw, status: 'onHold', lastOpenedAt: 100 }, { ...english, status: undefined, lastReadAt: 900 }];
  assert.equal(lib.statusOf(lib.collapseBundles(held)[0]), 'reading');
  // Finished in one edition, last read there: the bundle is finished.
  const done = [raw, { ...english, finishedAt: 600, lastReadAt: 590, percent: 1 }];
  assert.equal(lib.statusOf(lib.collapseBundles(done)[0]), 'finished');
});

t('grouped by status, a bundle is one entry under the edition read last', () => {
  const raw = { id: 1, title: 'Raw', bundleId: 1 };
  const english = { id: 2, title: 'English', bundleId: 1, lastReadAt: 500 };
  const entries = lib.collapseBundles([raw, english], ['status']);
  assert.equal(entries.length, 1, 'the bundle came apart: one edition Reading, one Unread');
  const groups = lib.groupBooks(entries, ['status']);
  assert.deepEqual(groups.map((g) => [g.label, g.count]), [['Reading', 1]]);
  // Grouped by something the editions really differ in, they part -- and
  // each still shows the bundle's status.
  const byLang = lib.collapseBundles([{ ...raw, lang: 'ko' }, { ...english, lang: 'en' }], ['language']);
  assert.equal(byLang.length, 2);
  assert.deepEqual(byLang.map((b) => lib.statusOf(b)), ['reading', 'reading']);
});

await t2('reading one edition clears a status set on the whole bundle', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const a = await store.add('books', { title: 'Lead', fingerprint: 'b:1', addedAt: 1, status: 'onHold' });
  const b = await store.add('books', { title: 'Other', fingerprint: 'b:2', addedAt: 1, status: 'onHold', heldAt: 5, heldAutomatically: true });
  const lone = await store.add('books', { title: 'Elsewhere', fingerprint: 'b:3', addedAt: 1, status: 'onHold' });
  for (const id of [a, b]) await store.put('books', { ...(await store.get('books', id)), bundleId: a });
  await store.markRead(b);
  for (const id of [a, b]) {
    const book = await store.get('books', id);
    assert.equal(book.status, undefined, `edition ${id} kept On hold after the bundle was read`);
    assert.equal(book.heldAutomatically, undefined);
  }
  assert.equal((await store.get('books', lone)).status, 'onHold', 'a book outside the bundle changed');
  const lead = await store.get('books', a);
  assert.equal(lead.lastReadAt, undefined, 'the edition not read was marked read');
  for (const id of [a, b, lone]) await store.deleteBook(id);
});

t('a bundle read lately in any edition is not put on hold', () => {
  const DAY = 864e5;
  const now = 100 * DAY;
  const books = [
    { id: 9, title: 'Read last', lastReadAt: now },
    { id: 1, title: 'Raw', bundleId: 1, lastReadAt: now - 20 * DAY },
    { id: 2, title: 'English', bundleId: 1, lastReadAt: now - DAY },
    { id: 3, title: 'Left', lastReadAt: now - 20 * DAY },
  ];
  assert.deepEqual(lib.goneQuiet(books, { days: 5, now }).map((b) => b.title), ['Left']);
});

console.log('the language of a title');

await t2('the language is told from the characters when the book does not say, or says wrong', async () => {
  const translate = await import(new URL('../app/src/main/assets/www/js/translate.js', import.meta.url).href);
  const from = (title, lang = '', extra = {}) => translate.sourceFor({ title, lang, ...extra });
  assert.equal(from('전지적 독자 시점'), 'ko');
  assert.equal(from('나 혼자만 레벨업', 'en'), 'ko', 'a scraped "en" on a Korean title');
  assert.equal(from('転生したらスライムだった件'), 'ja');
  assert.equal(from('Re:ゼロから始める異世界生活'), 'ja');
  assert.equal(from('魔道祖师'), 'zh');
  assert.equal(from('魔道祖師', 'ja'), 'ja', 'kanji alone, in a book that says Japanese');
  assert.equal(from('進撃の巨人'), 'ja', 'one kana among kanji');
  assert.equal(from('鬼滅', '', { author: '吾峠呼世晴', series: 'きめつ' }), 'ja', 'the series says what the title cannot');
  assert.equal(from('Война и мир'), 'ru');
  assert.equal(from('Тіні забутих предків'), 'uk');
  assert.equal(from('Solo Leveling'), '', 'Latin is left to the translator to tell');
  assert.equal(from('Solo Leveling', 'ko'), '', 'Latin letters are not Korean, whatever the book says');
  assert.equal(from('Middlemarch', 'en'), 'en');
  assert.equal(from('Le Petit Prince', 'fr'), 'fr');
  assert.equal(translate.languageOfText('The Beginning After The End 1화'), '', 'one word of Hangul in an English title');
});

await t2('a title left untranslated when its language was wrong is asked again, once', async () => {
  const translate = await import(new URL('../app/src/main/assets/www/js/translate.js', import.meta.url).href);
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  // Cached as it went: the Korean title sent as English came back Korean.
  await store.put('translations', { key: '77:title:EN-US', bookId: 77, field: 'title', lang: 'EN-US', value: '나 혼자만 레벨업', at: 1 });
  await store.put('translations', { key: '77:name:EN-US', bookId: 77, field: 'name', lang: 'EN-US', value: 'Solo', at: 1 });
  const sent = [];
  window.GrimoireTranslate = globalThis.window.GrimoireTranslate = {
    status: () => JSON.stringify({ configured: true, engine: 'ondevice' }),
    translate(id, json, lang, source) {
      sent.push({ texts: JSON.parse(json), source });
      setTimeout(() => translate.settle(id, true, { texts: JSON.parse(json).map(() => 'Solo Leveling') }), 1);
    },
  };
  const items = [{ field: 'title', text: '나 혼자만 레벨업' }, { field: 'name', text: 'Solo' }];
  const first = await translate.translateBatch(77, items, 'EN-US', 'ko');
  assert.equal(first.results.get('title'), 'Solo Leveling');
  assert.deepEqual(sent.map((s) => s.texts), [['나 혼자만 레벨업']], 'a good cached one was sent again');
  assert.equal(sent[0].source, 'ko');
  const again = await translate.translateBatch(77, items, 'EN-US', 'ko');
  assert.equal(again.translated, 0, 'the fixed title was asked for again');
  delete window.GrimoireTranslate;
  await store.del('translations', '77:title:EN-US');
  await store.del('translations', '77:name:EN-US');
});

console.log('themes');

t('a theme is the look as a whole, written out and read back', () => {
  const settings = { themeMode: 'dark', accent: '#b4b0d6', heatRamp: 'ink', backgroundImage: null, veil: 0.62, columns: 3 };
  const look = theme.themeOf(settings, '  Night  ');
  // The gradient goes with it: null, following the accent, when none of your own is set.
  assert.deepEqual(look, { name: 'Night', themeMode: 'dark', accent: '#b4b0d6', heatRamp: 'ink', backgroundImage: null, veil: 0.62, gradient: null });
  const file = theme.themeFile(look);
  assert.equal(file.format, 'quire-theme');
  assert.deepEqual(theme.readThemes(JSON.parse(JSON.stringify(file))), [look]);
});

t('a theme file is checked: nothing unsafe or unknown is taken on trust', () => {
  const [kept] = theme.readThemes({
    name: 'Mixed', themeMode: 'sepia', accent: 'red; background:url(x)', heatRamp: 'nope',
    backgroundImage: 'https://example.com/spy.png', veil: 7, columns: 9,
  });
  assert.deepEqual(kept, { name: 'Mixed', veil: 0.95 }, 'an unsafe value got through');
  assert.throws(() => theme.readThemes({ hello: 'world' }), /no theme/);
  assert.throws(() => theme.readThemes('just text'), /no theme/);
  const picture = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(theme.readThemes({ backgroundImage: picture })[0].backgroundImage, picture);
  assert.throws(() => theme.readThemes({ backgroundImage: 'data:text/html;base64,PHNjcmlwdD4=' }), /no theme/,
    'a page dressed as a picture was taken');
});

t('a settings file, a list of themes, or one on its own: each is read', () => {
  // A whole settings export: its look, and nothing else.
  const [fromSettings] = theme.readThemes({ themeMode: 'light', accent: '#336699', translateTitles: true, columns: 4 }, 'quire-settings');
  assert.deepEqual(fromSettings, { name: 'quire-settings', themeMode: 'light', accent: '#336699' });
  const many = theme.readThemes([{ accent: '#111111' }, { accent: '#222222' }], 'Pack');
  assert.deepEqual(many.map((t) => t.name), ['Pack 1', 'Pack 2']);
  // Saved again under the same name, it takes the old one's place.
  const saved = theme.withTheme([{ name: 'A', accent: '#000000' }, { name: 'B' }], { name: 'A', accent: '#ffffff' });
  assert.deepEqual(saved.map((t) => [t.name, t.accent]), [['B', undefined], ['A', '#ffffff']]);
});

await t2('settings come back in from a file, only the ones the app knows, as the kind they are', async () => {
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const before = await store.settings();
  const count = await store.importSettings({
    columns: 4, accent: '#123456', translateTitles: 'yes', hackerKey: 1,
    backgroundImage: 'https://example.com/x.png', lastCrash: 'boom',
  });
  assert.equal(count, 2);
  const after = await store.settings();
  assert.equal(after.columns, 4);
  assert.equal(after.accent, '#123456');
  assert.equal(after.translateTitles, before.translateTitles, 'a setting of the wrong kind was taken');
  assert.equal(after.hackerKey, undefined);
  assert.equal(after.backgroundImage, before.backgroundImage, 'a picture from the web was taken');
  await assert.rejects(store.importSettings({ nothing: 1 }), /no settings/);
  await store.saveSettings({ columns: before.columns, accent: before.accent });
});

console.log('reading elsewhere');

await (async () => {
  await t2('words alone count as a reading session', async () => {
  // A chapter copied out to be read in a translator produces no pages and no
  // time. Requiring either meant that reading recorded nothing at all.
  const store = await import(new URL('../app/src/main/assets/www/js/store.js', import.meta.url).href);
  const id = await store.add('books', { title: 'Copied', fingerprint: 'c', addedAt: 1 });

  await store.recordEvent({ bookId: id, words: 4000, chapters: 1, elsewhere: true });
  const log = await store.all('events');
  assert.equal(log.length, 1, 'the copied chapter was not recorded');
  assert.equal(log[0].words, 4000);
  assert.equal(log[0].chapters, 1);
  assert.equal(log[0].elsewhere, true);

    // An empty session is still nothing.
    await store.recordEvent({ bookId: id, words: 0 });
    assert.equal((await store.all('events')).length, 1);
  });
})();

console.log('bundles');

t('editions collapse to one entry led by one of them', () => {
  const books = [
    { id: 1, title: 'Witch City', bundleId: 1 },
    { id: 2, title: '마녀의 도시', bundleId: 1 },
    { id: 3, title: 'Something Else' },
  ];
  // Order is the sorter's job now -- collapsing runs first, so what matters
  // here is what survives, not where it lands.
  const shelf = lib.collapseBundles(books);
  assert.deepEqual(shelf.map((b) => b.title).sort(), ['Something Else', 'Witch City']);
  // shelf[0] is no longer necessarily the bundle, since ordering moved to
  // the sorter. Find it by what it is.
  const gathered = shelf.find((b) => b.bundle);
  assert.equal(gathered.bundle.length, 2);
  // The leader comes first, so the sheet reads the same way every time.
  assert.equal(gathered.bundle[0].id, 1);
});

t('a bundle sorts like any other entry, including on its size', () => {
  const books = [
    { id: 9, title: 'Aardvark' },
    { id: 1, title: 'Middle', bundleId: 1 },
    { id: 2, title: 'Middle (raw)', bundleId: 1 },
    { id: 8, title: 'Zebra' },
  ];
  const shelf = lib.collapseBundles(books);
  assert.deepEqual(lib.sortBooks(shelf, [['title', 'asc']]).map((b) => b.title),
    ['Aardvark', 'Middle', 'Zebra']);
  // Descending by bundle puts the gathered editions first, which is the
  // useful direction; a lone book counts as one.
  assert.equal(lib.sortBooks(shelf, [['bundle', 'desc']])[0].title, 'Middle');
});

t('a bundle comes apart when grouping would separate its editions', () => {
  // Group by language and a translation and its original belong under two
  // headings, not one.
  const books = [
    { id: 1, title: 'Witch City', lang: 'en', bundleId: 1 },
    { id: 2, title: '마녀의 도시', lang: 'ko', bundleId: 1 },
  ];
  assert.equal(lib.collapseBundles(books, []).length, 1);
  assert.equal(lib.collapseBundles(books, ['language']).length, 2);
  // A grouping they agree on leaves the bundle whole.
  assert.equal(lib.collapseBundles(books, ['format']).length, 1);
});

t('a member whose leader is gone stands for itself', () => {
  // Deleting one edition must not take the other off the shelf with it.
  const books = [{ id: 2, title: 'Orphan', bundleId: 1 }];
  assert.deepEqual(lib.collapseBundles(books).map((b) => b.title), ['Orphan']);
});

t('a leader released on its own does not appear twice', () => {
  // It no longer leads, so its former members stand for themselves rather
  // than re-forming a group around a book that is not in one.
  const books = [
    { id: 1, title: 'Was the leader' },
    { id: 2, title: 'Still points at it', bundleId: 1 },
  ];
  assert.deepEqual(lib.collapseBundles(books).map((b) => b.title),
    ['Was the leader', 'Still points at it']);
});

console.log(`\n${pass} assertions passed`);
