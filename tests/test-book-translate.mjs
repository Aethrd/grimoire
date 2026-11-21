/* A whole book translated into a new edition beside it: chapter by chapter,
 * readable as it comes, carried on after a pause, each chapter checked, and
 * the ones found wanting done again. The translator is stood in for: it
 * translates, except that it declines one chapter and leaves another in the
 * original, as real models now and then do. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const www = (name) => new URL(`../app/src/main/assets/www/js/${name}`, import.meta.url).href;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass += 1; };

const store = await import(www('store.js'));
const translate = await import(www('translate.js'));
const booktranslate = await import(www('booktranslate.js'));

const KO = '그는 천천히 고개를 들어 하늘을 바라보았다. 바람이 불었다.';
const EN = 'He slowly raised his head and looked at the sky. The wind blew.';
let misbehave = new Map([[3, 'refusal'], [5, 'untranslated']]);
const asked = [];
window.GrimoireTranslate = globalThis.window.GrimoireTranslate = {
  status: () => JSON.stringify({ engine: 'llm', configured: true, llmProvider: 'anthropic', llmModel: 'claude-haiku-5-5', llmKeys: 2 }),
  translate(id, textsJson, lang, source) { this.translateWith(id, textsJson, lang, source, '{}'); },
  translateWith(id, textsJson, lang, source, optionsJson) {
    const texts = JSON.parse(textsJson);
    const options = JSON.parse(optionsJson || '{}');
    asked.push({ texts, options });
    const chapter = Number((texts.join(' ').match(/§(\d+)/) || [])[1]);
    const out = texts.map((text) => {
      if (/^제 ?\d+화/.test(text)) return `Chapter ${text.match(/\d+/)[0]}`;
      if (text === '하늘의 책') return 'The Book of the Sky';
      const how = misbehave.get(chapter);
      if (how === 'refusal') return 'I’m sorry, but I can’t help with translating this.';
      if (how === 'untranslated') return text;
      return text.replace(KO, EN).replace(/§(\d+)/, '[$1]');
    });
    setTimeout(() => translate.settle(id, true, JSON.stringify({ texts: out, characters: texts.join('').length })), 1);
  },
};

// The original: six chapters of Korean, a picture in the second.
const { Blob: NodeBlob } = await import('node:buffer');
const source = await store.add('books', { title: '하늘의 책', author: '작가', lang: 'ko', fingerprint: 'sky.epub:1', addedAt: 1, chapters: 6, words: 600 });
for (let i = 0; i < 6; i += 1) {
  const paragraphs = Array.from({ length: 8 }, () => `<p>${KO} §${i}</p>`).join('');
  await store.put('chapters', { bookId: source, index: i, title: `제${i + 1}화`, words: 100, base: 'text/',
    html: paragraphs + (i === 1 ? '<img data-img="images/p1.png">' : '') });
}
await store.put('images', { bookId: source, href: 'images/p1.png', blob: new NodeBlob([Buffer.from('png')]) });

const toasts = [];
const rows = [];
const progress = { start: (label) => { const row = Object.assign(() => {}, { label, say() {}, fail() {}, controls(c) { row.c = c; } }); rows.push(row); return row; } };
const deps = { progress, toast: (text) => toasts.push(text), sleep: async () => {} };

let job;
await t('begun: a new edition named in the language, bound to the original, with its pictures and cover', async () => {
  job = await booktranslate.begin(source, { lang: 'EN-US', sourceLang: 'ko', temperature: 0.2, delay: 0 });
  const edition = await store.get('books', job.targetId);
  const original = await store.get('books', source);
  assert.equal(edition.title, 'The Book of the Sky');
  assert.equal(edition.lang, 'en');
  assert.equal(original.bundleId, source, 'the original does not lead');
  assert.equal(edition.bundleId, source, 'not an edition of it');
  assert.equal(edition.translatedFrom.id, source);
  assert.deepEqual((await store.byIndex('images', 'bookId', job.targetId)).map((i) => i.href), ['images/p1.png']);
  assert.equal(job.total, 6);
  // This phone's: never in a backup.
  assert.ok(store.DEVICE_SETTINGS.includes('translateJobs'));
});

await t('paused part-way: what is done is in the edition, readable; carried on, it goes on from the next chapter', async () => {
  // Paused while the third chapter is under way.
  const pausing = { ...deps, progress: { start: (label) => {
    let n = 0;
    const row = Object.assign(() => {}, { label, fail() {}, controls(c) { row.c = c; }, say() { if (++n === 3) row.c.pause(); } });
    return row;
  } } };
  job = await booktranslate.run(job.id, pausing);
  assert.equal(job.status, 'paused');
  // After the chapter under way when it was asked: three.
  assert.equal(job.done, 3);
  let chapters = await store.byIndex('chapters', 'bookId', job.targetId);
  assert.equal(chapters.length, 3);
  assert.match(chapters[0].html, /He slowly raised his head/);
  assert.equal(chapters[0].title, 'Chapter 1');
  assert.match(chapters[1].html, /data-img="images\/p1\.png"/, 'the picture lost');
  assert.match(toasts.at(-1), /paused at 3 of 6 chapters/);
  // Its temperature went with every request.
  assert.ok(asked.filter((a) => a.texts.some((x) => x.includes('§'))).every((a) => a.options.temperature === 0.2));
  // Carried on: chapters 4 to 6, none asked twice.
  const before = asked.length;
  job = await booktranslate.run(job.id, deps);
  assert.equal(job.status, 'done');
  chapters = await store.byIndex('chapters', 'bookId', job.targetId);
  assert.equal(chapters.length, 6);
  assert.ok(!asked.slice(before).some((a) => a.texts.some((x) => /§[012]\b/.test(x))), 'chapters done before asked again');
  const edition = await store.get('books', job.targetId);
  assert.equal(edition.chapters, 6);
  assert.equal(edition.translation.finished, true);
  assert.ok(edition.words > 0);
});

await t('each chapter checked: a refusal and one left in the original found, named, and said at the end', async () => {
  const found = Object.fromEntries(job.flagged.map((f) => [f.index, f.problems]));
  assert.deepEqual(Object.keys(found).map(Number).sort(), [3, 5]);
  assert.ok(found[3].includes('refusal'));
  assert.ok(found[5].includes('untranslated'));
  assert.match(toasts.at(-1), /“The Book of the Sky” translated: 6 chapters, an edition of “하늘의 책”\. 2 chapters to look at/);
});

await t('done again: their kept translations forgotten first, asked afresh, and checked again', async () => {
  misbehave = new Map();
  job = await booktranslate.redo(job.id, job.flagged.map((f) => f.index), deps);
  assert.deepEqual(job.flagged, []);
  const fixed = await store.get('chapters', [job.targetId, 3]);
  assert.match(fixed.html, /He slowly raised his head/);
  assert.match(toasts.at(-1), /nothing left to look at/);
  // Checked again from the start: still nothing.
  job = await booktranslate.recheck(job.id);
  assert.deepEqual(job.flagged, []);
});

await t('the check itself: short, empty, refusal, untranslated -- and a good translation passes', () => {
  const ko = { html: Array.from({ length: 20 }, () => `<p>${KO}</p>`).join('') };
  assert.deepEqual(booktranslate.checkChapter(ko, Array.from({ length: 20 }, () => `<p>${EN}</p>`).join(''), 'EN-US'), []);
  assert.deepEqual(booktranslate.checkChapter(ko, '', 'EN-US'), ['empty']);
  assert.ok(booktranslate.checkChapter(ko, `<p>He looked up.</p>`, 'EN-US').includes('short'));
  assert.ok(booktranslate.checkChapter(ko, `<p>As an AI, I cannot translate this content.</p>`, 'EN-US').includes('refusal'));
  assert.ok(booktranslate.checkChapter(ko, ko.html, 'EN-US').includes('untranslated'));
});

await t('a run the app was closed in the middle of is paused on start, and said', async () => {
  const list = await booktranslate.jobs();
  await store.saveSettings({ translateJobs: list.map((j) => ({ ...j, status: 'running' })) });
  const cut = await booktranslate.pauseInterrupted();
  assert.equal(cut.length, 1);
  assert.equal((await booktranslate.getJob(job.id)).status, 'paused');
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /for \(const cut of await booktranslate\.pauseInterrupted\(\)/);
  assert.match(read('app/src/main/assets/www/index.html'), /<button data-act="translate">/);
});

console.log(`\n${pass} checks passed`);
process.exit(0);
