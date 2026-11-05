/* Translating with a glossary, the reader's own instructions, the page as a
 * picture, the chapter before -- and checked for what came back untranslated.
 *
 * The services themselves are on the other side of the bridge; here the
 * bridge is stood in for, and what crosses it is looked at. The native side
 * is checked for the same promises in its source. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const www = (file) => new URL(`../app/src/main/assets/www/js/${file}`, import.meta.url).href;
const glossary = await import(www('glossary.js'));
const translate = await import(www('translate.js'));
const store = await import(www('store.js'));
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass++; };

/* ── the glossary itself ──────────────────────────────────────────────── */

console.log('the glossary');

await t('a series shares one glossary; a book without one, and its editions, have their own', () => {
  assert.equal(glossary.scopeOf({ id: 1, series: 'Omniscient Reader' }).id, 'series:omniscient reader');
  assert.equal(glossary.scopeOf({ id: 2, series: '  omniscient   READER ' }).id, 'series:omniscient reader');
  assert.equal(glossary.scopeOf({ id: 3 }).id, 'book:3');
  assert.equal(glossary.scopeOf({ id: 4, bundleId: 3 }).id, 'book:3', 'an edition has its own glossary');
});

await t("Glossarion's glossaries read, whichever way they are written", () => {
  const compact = glossary.parseFile([
    'Glossary Columns: raw_name, translated_name, gender, description', '',
    '=== CHARACTERS ===', '* 김독자 = Kim Dokja [Male]: The reader', '* 유상아 = Yoo Sangah [Female]', '',
    '=== TERMS ===', '* 성좌 = Constellation',
  ].join('\n'), 'glossary.txt');
  assert.deepEqual(compact.map((e) => [e.source, e.target, e.kind, e.gender, e.note]), [
    ['김독자', 'Kim Dokja', 'character', 'male', 'The reader'],
    ['유상아', 'Yoo Sangah', 'character', 'female', ''],
    ['성좌', 'Constellation', 'term', '', ''],
  ]);
  const csv = glossary.parseFile('type,raw_name,translated_name,gender,description\ncharacter,김독자,Kim Dokja,male,"The reader, and the hero"\n', 'g.csv');
  assert.equal(csv[0].note, 'The reader, and the hero', 'a quoted comma split the description');
  const list = glossary.parseFile(JSON.stringify([{ type: 'character', raw_name: '김독자', translated_name: 'Kim Dokja', gender: 'male' }]), 'g.json');
  assert.deepEqual([list[0].kind, list[0].gender], ['character', 'male']);
  assert.equal(glossary.parseFile(JSON.stringify({ 성좌: 'Constellation' }), 'g.json')[0].target, 'Constellation');
  const sections = glossary.parseFile(JSON.stringify({ characters: [{ raw_name: '김독자', translated_name: 'Kim Dokja' }], places: { 서울: 'Seoul' } }), 'g.json');
  assert.deepEqual(sections.map((e) => e.kind), ['character', 'place']);
  const nested = glossary.parseFile(JSON.stringify({ 김독자: { translated_name: 'Kim Dokja', gender: 'male' } }), 'g.json');
  assert.deepEqual([nested[0].source, nested[0].gender], ['김독자', 'male']);
  const lines = glossary.parseFile('## Places\n- 서울 → Seoul\n| 원문 | 번역 |\n|---|---|\n| 성좌 | Constellation |', 'g.md');
  assert.deepEqual(lines.map((e) => e.source), ['서울', '성좌'], 'a table heading was taken for a name');
  assert.throws(() => glossary.parseFile('just some prose', 'x.txt'), /No glossary entries/);
});

await t('written out as Glossarion reads it, and read back the same', () => {
  const entries = [{ source: '김독자', target: 'Kim Dokja', kind: 'character', gender: 'male', note: 'The reader, hero' }];
  const json = JSON.parse(glossary.toJson(entries));
  assert.deepEqual(json, [{ type: 'character', raw_name: '김독자', translated_name: 'Kim Dokja', gender: 'male', description: 'The reader, hero' }]);
  assert.deepEqual(glossary.parseFile(glossary.toJson(entries), 'g.json'), entries);
  assert.deepEqual(glossary.parseFile(glossary.toCsv(entries), 'g.csv'), entries);
});

await t('brought in, a name already there keeps its translation; only its gaps are filled', () => {
  const { entries, added, filled } = glossary.merge(
    [{ source: '김독자', target: 'Kim Dok-ja' }],
    [{ source: '김독자', target: 'Kim Dokja', gender: 'male' }, { source: '성좌', target: 'Constellation' }]);
  assert.equal(entries[0].target, 'Kim Dok-ja', 'what the reader typed was overwritten');
  assert.equal(entries[0].gender, 'male');
  assert.deepEqual([added, filled], [1, 1]);
});

await t('only the names in what is translated go with it', () => {
  const entries = [{ source: '김독자', target: 'Kim Dokja' }, { source: '성좌', target: 'Constellation' }, { source: '유상아', target: '' }];
  assert.deepEqual(glossary.relevant(entries, '김독자가 웃었다').map((e) => e.target), ['Kim Dokja']);
  assert.deepEqual(glossary.relevant(entries, '유상아'), [], 'a name with no translation yet was sent');
});

await t("the model's names are read from its answer; the book is looked through a stretch at a time", () => {
  const found = glossary.parseFound('Here you go:\n```json\n[{"source":"김독자","target":"Kim Dokja","kind":"character","gender":"male","note":"the reader"}]\n```');
  assert.deepEqual(found, [{ source: '김독자', target: 'Kim Dokja', kind: 'character', gender: 'male', note: 'the reader' }]);
  assert.throws(() => glossary.parseFound('I could not find any.'), /did not answer/);
  const chapters = [{ index: 0, t: 'a'.repeat(7000) }, { index: 1, t: 'b'.repeat(5000) }, { index: 2, t: 'c'.repeat(9000) }];
  const first = glossary.nextPieces(chapters, undefined, (c) => c.t);
  assert.equal(first.pieces.length, glossary.SCAN_REQUESTS);
  assert.ok(first.pieces.every((p) => p.length <= glossary.SCAN_CHARS));
  const second = glossary.nextPieces(chapters, first.next, (c) => c.t);
  assert.ok(second.pieces.length >= 1 && second.pieces[0][0] === 'c', 'the next scan did not carry on where the last stopped');
  assert.deepEqual(glossary.nextPieces(chapters, second.next, (c) => c.t).pieces, [], 'the end of the book was looked through again');
});

await t('kept with the series, never cleared with the cache, and carried in a backup', async () => {
  const one = await store.add('books', { title: 'ORV 1', series: 'ORV', fingerprint: 'orv1.epub:10', addedAt: 1 });
  const two = await store.add('books', { title: 'ORV 2', series: 'ORV', fingerprint: 'orv2.epub:10', addedAt: 1 });
  await glossary.save(await store.get('books', one), [{ source: '김독자', target: 'Kim Dokja', kind: 'character' }]);
  assert.deepEqual((await glossary.termsFor(two)).map((e) => e.target), ['Kim Dokja'], 'volume 2 does not know volume 1\'s names');
  await translate.clearCache();
  assert.equal((await glossary.termsFor(two)).length, 1, 'clearing translations took the glossary');
  const backup = await store.exportBackup();
  assert.ok(backup.glossaries.some((row) => row.key === 'glossary:series:orv'));
  await store.del('translations', 'glossary:series:orv');
  assert.equal((await glossary.termsFor(two)).length, 0);
  const report = await store.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(report.glossaries, 1);
  assert.equal((await glossary.termsFor(two)).length, 1, 'restoring a backup did not bring the glossary back');
  for (const id of [one, two]) await store.deleteBook(id);
});

/* ── what goes to the translator ──────────────────────────────────────── */

console.log('\nwhat goes to the translator');

let calls = [];
let engine = 'llm';
// A translation the check accepts: the Korean letters gone.
const en = (text) => `EN ${[...text].map((c) => (/[가-힣]/.test(c) ? 'k' : c)).join('')}`;
let answer = (texts) => texts.map(en);
window.GrimoireTranslate = globalThis.window.GrimoireTranslate = {
  status: () => JSON.stringify({ configured: true, engine }),
  translate(id, json, lang, source) { this.translateWith(id, json, lang, source, '{}'); },
  translateWith(id, json, lang, source, options) {
    const texts = JSON.parse(json);
    calls.push({ texts, lang, source, options: JSON.parse(options) });
    setTimeout(() => translate.settle(id, true, { texts: answer(texts, calls.at(-1).options), characters: json.length }), 1);
  },
  complete(id, system, user) {
    calls.push({ system, user });
    setTimeout(() => translate.settle(id, true, { text: '[{"source":"김독자","target":"Kim Dokja"}]' }), 1);
  },
};

const book = await store.add('books', { title: 'ORV 3', series: 'ORV Translate', fingerprint: 'orv3.epub:1', addedAt: 1 });
await glossary.save(await store.get('books', book), [
  { source: '김독자', target: 'Kim Dokja', kind: 'character', gender: 'male' },
  { source: '유중혁', target: 'Yoo Joonghyuk', kind: 'character', gender: 'male' },
]);

await t('a model is given the glossary entries in the text, the instructions, and the part before', async () => {
  calls = [];
  await store.saveSettings({ translatePrompts: { ko: 'Translate Korean web novels into {target}. Keep honorifics.' } });
  const { results } = await translate.translateBatch(book, [{ field: 'p1', text: '김독자가 말했다.' }], 'EN-US', 'ko',
    { previous: 'He nodded.', context: '앞' });
  assert.equal(results.get('p1'), en('김독자가 말했다.'));
  const { options } = calls[0];
  assert.deepEqual(options.glossary.map((e) => e.target), ['Kim Dokja'], 'the whole glossary was sent, or none of it');
  assert.equal(options.glossary[0].gender, 'male');
  assert.equal(options.instructions, 'Translate Korean web novels into {target}. Keep honorifics.');
  assert.equal(options.previous, 'He nodded.');
  assert.equal(options.context, '앞');
});

await t('the usual instructions are not sent as if they were the reader\'s own', async () => {
  calls = [];
  await store.saveSettings({ translatePrompts: { ko: translate.DEFAULT_PROMPT } });
  await translate.translateBatch(book, [{ field: 'p2', text: '안녕' }], 'EN-US', 'ko');
  assert.equal(calls[0].options.instructions, undefined);
  assert.equal(translate.profileOf('ja-JP'), 'ja');
  assert.equal(translate.profileOf('fr'), 'other');
  await store.saveSettings({ translatePrompts: {} });
});

await t('a translation made with other glossary entries is not taken for this one', async () => {
  calls = [];
  await translate.translateBatch(book, [{ field: 'p3', text: '유중혁' }], 'EN-US', 'ko');
  await translate.translateBatch(book, [{ field: 'p3', text: '유중혁' }], 'EN-US', 'ko');
  assert.equal(calls.length, 1, 'the same translation was asked for twice');
  await glossary.save(await store.get('books', book), [{ source: '유중혁', target: 'Yu Jung-hyeok' }]);
  await translate.translateBatch(book, [{ field: 'p3', text: '유중혁' }], 'EN-US', 'ko');
  assert.equal(calls.length, 2, 'a changed name did not make a fresh translation');
  assert.equal(calls[1].options.glossary[0].target, 'Yu Jung-hyeok');
});

await t('a part that comes back untranslated is asked for again, insistently, and only kept once translated', async () => {
  calls = [];
  let once = true;
  answer = (texts, options) => texts.map((text) => {
    if (text.includes('둘') && once && !options.insist) return text;      // left as it was
    if (text.includes('셋')) return '셋은 그대로';                         // never translated
    return en(text);
  });
  const { results } = await translate.translateBatch(book, [
    { field: 'q1', text: '하나' }, { field: 'q2', text: '둘' }, { field: 'q3', text: '셋' },
  ], 'EN-US', 'ko');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].texts, ['둘', '셋'], 'only the untranslated parts were asked again');
  assert.equal(calls[1].options.insist, true);
  assert.equal(results.get('q2'), en('둘'));
  assert.equal(results.get('q3'), '셋은 그대로', 'what came back is still shown');
  calls = [];
  await translate.translateBatch(book, [{ field: 'q3', text: '셋' }], 'EN-US', 'ko');
  assert.deepEqual(calls[0]?.texts, ['셋'], 'an untranslated part was kept as if it were translated');
  answer = (texts) => texts.map(en);
  // A name in Latin letters, or an English line, is no failure.
  assert.equal(translate.untranslated('김독자', 'Kim Dokja', 'EN-US'), false);
  assert.equal(translate.untranslated('김독자가 웃었다', '김독자 laughed', 'EN-US'), true);
  assert.equal(translate.untranslated('Bonjour', 'Bonjour', 'EN-US'), false);
  assert.equal(translate.untranslated('안녕', '', 'EN-US'), true);
});

await t('DeepL is given the glossary too; on-device is given none of it', async () => {
  engine = 'deepl';
  calls = [];
  await translate.translateBatch(book, [{ field: 'd1', text: '유중혁이 왔다' }], 'EN-US', 'ko');
  assert.equal(calls[0].options.glossary[0].source, '유중혁');
  assert.equal(calls[0].options.instructions, undefined, 'DeepL was sent a model\'s instructions');
  engine = 'ondevice';
  calls = [];
  await translate.translateBatch(book, [{ field: 'o1', text: '유중혁' }], 'EN-US', 'ko');
  assert.equal(calls[0].options.glossary, undefined);
  engine = 'llm';
});

await t('a page of pictures goes with its bubbles to a model, as a picture', async () => {
  calls = [];
  const image = { type: 'image/jpeg', data: 'AAAA' };
  await translate.translatePage(book, [{ field: 'b1', text: '김독자!' }, { field: 'b2', text: '뭐?' }], 'EN-US', 'ko', { image });
  assert.deepEqual(calls[0].options.image, image);
  assert.equal(calls[0].options.context, '김독자!\n뭐?');
  engine = 'deepl';
  calls = [];
  await translate.translatePage(book, [{ field: 'b3', text: '응' }], 'EN-US', 'ko', { image });
  assert.equal(calls[0].options.image, undefined, 'DeepL was sent a picture');
  engine = 'llm';
  const app = read('app/src/main/assets/www/js/app.js');
  assert.match(app, /settings\.aiSeesPage !== false/);
  assert.match(app, /const PAGE_SIDE = 1568;/);
});

await t('a chapter carries on from how the one before it ended', async () => {
  calls = [];
  const html = (words) => words.map((w) => `<p>${w}</p>`).join('');
  await translate.translateChapterBody(book, { index: 4, title: '4', html: html(['넷 하나', '넷 둘']) }, 'EN-US', 'ko');
  await translate.translateChapterBody(book, { index: 5, title: '5', html: html(['다섯']) }, 'EN-US', 'ko');
  assert.equal(calls[1].options.previous, `${en('넷 하나')}\n${en('넷 둘')}`);
});

await t('the model can be asked for a book\'s names', async () => {
  calls = [];
  const reply = await translate.complete(glossary.findingInstructions('English (US)'), 'Text:\n김독자');
  assert.deepEqual(glossary.parseFound(reply).map((e) => e.target), ['Kim Dokja']);
  assert.match(calls[0].system, /proper nouns/);
});

/* ── the native side keeps the same promises ───────────────────────────── */

console.log('\nthe native side');

await t('the bridge takes the glossary, instructions, picture and part before, and asks again when busy', () => {
  const bridge = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  assert.match(bridge, /public void translateWith\(final String requestId, final String textsJson,/);
  assert.match(bridge, /public void complete\(final String requestId, final String system, final String user\)/);
  // Several keys, the next tried when one is refused or runs out.
  assert.match(bridge, /static List<String> keysIn\(String value\)/);
  assert.match(bridge, /if \(!e\.keySpent\) throw e;/);
  // DeepL glossaries, made once per set of entries and pruned.
  assert.match(bridge, /"\/v2\/glossaries"/);
  assert.match(bridge, /request\.put\("glossary_id", glossary\)/);
  const llm = read('app/src/main/java/com/grimoire/ereader/LlmTranslator.java');
  assert.match(llm, /static String withRetries\(Exchange exchange\)/);
  assert.match(llm, /code == 429 \|\| code == 500 \|\| code == 502 \|\| code == 503/);
  assert.match(llm, /"image_url"/);
  assert.match(llm, /"inline_data"/);
  assert.match(llm, /"media_type", imageType/);
  // The reader's instructions cannot take away the form of the reply.
  assert.match(llm, /return opening \+ "\\n\\n" \+ OUTPUT_RULES;/);
});

await t('settings: instructions for each language, several keys, the page switch, and the glossary sheet', () => {
  const panels = read('app/src/main/assets/www/js/panels.js');
  assert.match(panels, /async function instructionsCard\(\)/);
  assert.match(panels, /Show the model the page/);
  assert.match(panels, /function keysBox\(placeholder\)/);
  const html = read('app/src/main/assets/www/index.html');
  for (const id of ['glossary-sheet', 'glossary-add', 'glossary-find', 'glossary-import', 'glossary-export', 'glossary-save', 'ocr-glossary']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const defaults = read('app/src/main/assets/www/js/store.js');
  assert.match(defaults, /translatePrompts: \{\},/);
  assert.match(defaults, /aiSeesPage: true,/);
  // The usual instructions here are the native side's, word for word.
  const llm = read('app/src/main/java/com/grimoire/ereader/LlmTranslator.java');
  const native = llm.slice(llm.indexOf('DEFAULT_INSTRUCTIONS = "'), llm.indexOf(';', llm.indexOf('DEFAULT_INSTRUCTIONS = "')))
    .replace('DEFAULT_INSTRUCTIONS = ', '').split('\n').map((l) => l.trim().replace(/^\+\s*/, '')).join('')
    .replace(/"\s*"/g, '').replace(/^"|"$/g, '');
  assert.equal(native, translate.DEFAULT_PROMPT);
});

console.log(`\n${pass} glossary tests passed`);
