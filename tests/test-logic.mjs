import assert from 'node:assert/strict';
import { boot } from './harness.mjs';
await boot();

const theme = await import(new URL('../app/src/main/assets/www/js/theme.js', import.meta.url).href);
const lib   = await import(new URL('../app/src/main/assets/www/js/library.js', import.meta.url).href);

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok  ' + name); pass++; };

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

console.log(`\n${pass} assertions passed`);
