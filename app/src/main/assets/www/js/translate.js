/* Translation.
 *
 * Three engines, chosen in settings:
 *
 *   ondevice  ML Kit. No key, no account, and no network once the language
 *             model is on the device. The default.
 *   deepl     Better, but needs a key and sends text to DeepL.
 *   libre     LibreTranslate, on a server you nominate -- possibly your own.
 *
 * The work is done natively, not here. ML Kit is an Android library a page
 * cannot reach, and DeepL sends no CORS headers and says plainly that it does
 * not permit client-side calls, because a key in a page is a key anyone can
 * read. So this module asks TranslateBridge and never sees a key.
 *
 * Everything is cached, keyed by (book, field, language). Translating costs
 * characters against a quota, and re-translating the same chapter title every
 * time the index is opened would burn a month's free tier on scrolling.
 */

import * as store from './store.js';
import { chapterHtml } from './parse.js';
import { termsFor as glossaryTerms, relevant as glossaryRelevant } from './glossary.js';

/* ── the promise bridge ───────────────────────────────────────────────── */

const pending = new Map();
let counter = 0;

/** Called from Java. Not part of the reader's own API. */
export function settle(id, ok, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(typeof payload === 'string' ? payload : 'Request failed'));
}

export const available = () => typeof window.GrimoireTranslate !== 'undefined';

function call(method, args = [], timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error('Translation is unavailable in this build'));
    const id = `t${++counter}`;
    // A request that never settles would leave a spinner forever.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('DeepL did not answer in time'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      window.GrimoireTranslate[method](id, ...args);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * The native side settles a call by evaluating
 *   window.Grimoire.settle("r1", true, {"texts":[...]})
 * so the payload arrives as an already-parsed JavaScript value, not as text.
 * Calling JSON.parse on it yields "[object Object]" and throws -- which is
 * exactly what produced a recurring "returned something unreadable", and why
 * language packs always reported as not installed.
 *
 * Both shapes are accepted: newer builds quote the payload, older ones do not.
 */
const parse = (value) => {
  if (value == null || value === 'null') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

/** Synchronous and cheap. Never returns the key, only whether one is set. */
export function status() {
  if (!available()) return { configured: false, unavailable: true };
  return parse(window.GrimoireTranslate.status()) || { configured: false };
}

export const ENGINES = [
  ['ondevice', 'On device', 'Free, no account, and offline once a language pack is installed.'],
  ['deepl', 'DeepL', 'Best quality. Needs an API key; free tier is 500,000 characters a month.'],
  ['libre', 'LibreTranslate', 'Free software you can self-host, so your text goes to a server you chose.'],
  ['llm', 'AI model', 'Claude, ChatGPT, Gemini or another model, with your own API key, billed by its provider. It reads a page as a whole, so names and tone stay consistent.'],
];

export const setEngine = (engine) => call('setEngine', [engine]).then(parse);
export const setLibre = (url, key) => call('setLibre', [url, key || '']).then(parse);
export const models = () => call('models').then(parse);
export const deleteModel = (tag) => call('deleteModel', [tag]).then(parse);
// A model is ~30MB and takes a while over Wi-Fi, so this gets a long deadline.
export const downloadModel = (tag) => call('downloadModel', [tag], 300000).then(parse);

/** Whether on-device translation covers a language at all. */
export function supports(tag) {
  if (!available() || !tag) return false;
  try { return window.GrimoireTranslate.supports(tag) === true; } catch { return false; }
}

/**
 * The languages worth offering to download: the ones your books are actually
 * in, plus wherever you are translating to.
 *
 * ML Kit models are per language, not per pair and not the whole set. Reading
 * Korean in English needs Korean and English and nothing else.
 */
export function neededLanguages(books, target) {
  const tags = new Set();
  for (const book of books) {
    const tag = (book.lang || '').split('-')[0].toLowerCase();
    if (tag && supports(tag)) tags.add(tag);
  }

  const to = (target || '').split('-')[0].toLowerCase();
  if (to && supports(to)) tags.add(to);
  return [...tags].sort();
}

/* The languages ML Kit can translate on device. Names in English because the
 * list is long and a picker of endonyms is hard to scan; supports() is asked
 * before any of them is offered, so an entry the installed ML Kit does not
 * cover simply never appears. */
export const LANGUAGE_NAMES = {
  af: 'Afrikaans', ar: 'Arabic', be: 'Belarusian', bg: 'Bulgarian',
  bn: 'Bengali', ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish',
  de: 'German', el: 'Greek', en: 'English', eo: 'Esperanto', es: 'Spanish',
  et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French', ga: 'Irish',
  gl: 'Galician', gu: 'Gujarati', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian',
  ht: 'Haitian Creole', hu: 'Hungarian', id: 'Indonesian', is: 'Icelandic',
  it: 'Italian', ja: 'Japanese', ka: 'Georgian', kn: 'Kannada', ko: 'Korean',
  lt: 'Lithuanian', lv: 'Latvian', mk: 'Macedonian', mr: 'Marathi',
  ms: 'Malay', mt: 'Maltese', nl: 'Dutch', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak',
  sl: 'Slovenian', sq: 'Albanian', sv: 'Swedish', sw: 'Swahili',
  ta: 'Tamil', te: 'Telugu', th: 'Thai', tl: 'Tagalog', tr: 'Turkish',
  uk: 'Ukrainian', ur: 'Urdu', vi: 'Vietnamese', zh: 'Chinese',
};

/** Every language on-device translation covers, in name order. */
export function allLanguages() {
  return Object.keys(LANGUAGE_NAMES)
    .filter((tag) => supports(tag))
    .sort((a, b) => LANGUAGE_NAMES[a].localeCompare(LANGUAGE_NAMES[b]));
}

export const languageName = (tag) => LANGUAGE_NAMES[tag] || tag.toUpperCase();

/**
 * The source language for a book, when it declares one.
 *
 * An empty answer is fine and normal: the native side identifies the language
 * from the text itself. Switching translation on means wanting whatever is
 * foreign translated, not answering a question about which language a scraped
 * EPUB happens to be in.
 */
export function sourceFor(book, text = '') {
  const declared = (book?.lang || '').split('-')[0].toLowerCase();
  // What the words themselves are written in: the title, unless told what
  // to look at, with the author and series beside it for a second opinion.
  const sample = [text || book?.title, book?.author, book?.series].filter(Boolean).join(' ');
  const seen = languageOfText(sample);
  if (!seen) {
    // Latin letters in a book that says it is Korean, Japanese, Russian...:
    // the words are not in that language, whatever the book says ("Solo
    // Leveling" on a Korean edition). Left to the translator to tell.
    if (NOT_LATIN.has(declared) && /[A-Za-z]/.test(text || book?.title || '')) return '';
    return declared;
  }
  if (!declared || declared === 'und') return seen;
  return sameWriting(declared, seen) ? declared : seen;
}

/* Written in the same characters, so the characters cannot tell them apart:
 * a Japanese title all in kanji looks Chinese, a Ukrainian one Russian. The
 * book's own word is taken over the characters' then. */
const SAME_WRITING = [
  ['zh', 'ja', 'ko'],
  ['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'mn'],
  ['ar', 'fa', 'ur'],
  ['hi', 'mr', 'ne'],
];
const NOT_LATIN = new Set(['zh', 'ja', 'ko', 'ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'mn', 'el', 'ar', 'fa', 'ur', 'he', 'th', 'hi', 'mr', 'ne']);
const sameWriting = (a, b) => a === b || SAME_WRITING.some((group) => group.includes(a) && group.includes(b));

const SCRIPTS = [
  ['ko', /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/gu],
  ['ja', /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/gu],
  ['zh', /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/gu],
  ['ru', /[\u0400-\u04ff]/gu],
  ['el', /[\u0370-\u03ff]/gu],
  ['ar', /[\u0600-\u06ff]/gu],
  ['he', /[\u0590-\u05ff]/gu],
  ['th', /[\u0e00-\u0e7f]/gu],
  ['hi', /[\u0900-\u097f]/gu],
];

/**
 * The language a piece of text is in, as far as its characters say: Hangul
 * is Korean; kana -- even one, among kanji -- is Japanese; Han characters
 * alone are Chinese; Cyrillic is Russian (Ukrainian with its own letters);
 * and so on. '' for Latin letters and anything else the characters cannot
 * settle: the translator works those out from the words.
 */
export function languageOfText(text) {
  const words = String(text || '');
  const counts = new Map();
  for (const [code, pattern] of SCRIPTS) {
    const n = (words.match(pattern) || []).length;
    if (n) counts.set(code, n);
  }
  if (!counts.size) return '';
  const latin = (words.match(/[A-Za-z\u00c0-\u024f]/g) || []).length;
  // Kana is never anything but Japanese, however much kanji is round it.
  if (counts.has('ja') && (counts.get('ja') >= (counts.get('ko') || 0))) return 'ja';
  const [best, most] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // Mostly Latin, with a word of something else in it: not settled here.
  if (latin > most * 2) return '';
  if (best === 'ru' && /[іїєґІЇЄҐ]/.test(words)) return 'uk';
  return best;
}
export const setKey = (key) => call('setKey', [key], 30000).then(parse);

/** The language-model services, with the fast, inexpensive model of each
 *  as the starting point (any other can be named), and where to get a key. */
export const LLM_PROVIDERS = [
  ['anthropic', 'Claude', 'claude-haiku-5-5', 'console.anthropic.com → API Keys'],
  ['openai', 'ChatGPT', 'gpt-6-luna', 'platform.openai.com → API keys'],
  ['gemini', 'Gemini', 'gemini-3.8-flash', 'aistudio.google.com → Get API key'],
  ['openrouter', 'OpenRouter', 'openrouter/auto', 'Sign in instead of copying a key — DeepSeek, Claude, GPT, Gemini, Qwen and free models with one account'],
  ['custom', 'Other', '', 'Any service that speaks OpenAI’s chat format: DeepSeek, or Ollama / LM Studio on your own computer'],
];
/** Tried with a word of translation before it is kept, then made the translator. */
export const setLlm = (provider, key, model, base) =>
  call('setLlm', [provider, key || '', model || '', base || ''], 60000).then(parse);
export const clearLlm = (provider) => call('clearLlm', [provider]).then(parse);

/* OpenRouter: signing in at openrouter.ai, in the browser, gives the app a key
 * of the reader's own (OpenRouterLink.java), kept natively like a pasted one.
 * Settles when the browser comes back: up to ten minutes, so the wait here is
 * a little longer than the native one. */
export const connectOpenRouter = () => call('connectOpenRouter', [], 11 * 60 * 1000).then(parse);
export function cancelOpenRouter() {
  try { if (available()) window.GrimoireTranslate.cancelOpenRouter(); } catch { /* nothing to stop */ }
}
/** [{id, name, free, vision, context}], as OpenRouter lists them. */
export const openRouterModels = () => call('openRouterModels', [], 30000).then(parse);
/** Free first, then by name; a search matches the id or the name. */
export function sortModels(models, query = '', freeOnly = false) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return (Array.isArray(models) ? models : [])
    .filter((m) => m && m.id && (!freeOnly || m.free))
    .filter((m) => words.every((w) => `${m.id} ${m.name || ''}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.free - a.free) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
}
export const clearKey = () => call('clearKey').then(parse);
export const usage = () => call('usage').then(parse);

/* ── languages ────────────────────────────────────────────────────────── */

export const TARGETS = [
  ['EN-US', 'English (US)'], ['EN-GB', 'English (UK)'], ['DE', 'Deutsch'],
  ['FR', 'Français'], ['ES', 'Español'], ['IT', 'Italiano'],
  ['NL', 'Nederlands'], ['PL', 'Polski'], ['PT-BR', 'Português (BR)'],
  ['RU', 'Русский'], ['JA', '日本語'], ['ZH', '中文'], ['KO', '한국어'],
];

/* ── cache ────────────────────────────────────────────────────────────── */

const cacheKey = (bookId, field, lang) => `${bookId}:${field}:${lang}`;

async function cached(bookId, field, lang) {
  const row = await store.get('translations', cacheKey(bookId, field, lang));
  return row ? row.value : null;
}

async function remember(bookId, field, lang, value) {
  await store.put('translations', {
    key: cacheKey(bookId, field, lang),
    bookId, field, lang, value,
    at: Date.now(),
  });
}

/* Answer keys for the accuracy check (lang 'key') and glossaries (lang
 * 'glossary') are kept in the same place, but are the reader's own work, not
 * a cache: never cleared here. */
const isKey = (row) => row.lang === 'key' || row.lang === 'glossary';

/** Forget everything translated for one book, or for the whole library. */
export async function clearCache(bookId = null) {
  const rows = (await store.all('translations')).filter((row) => !isKey(row));
  for (const row of rows) {
    if (bookId === null || row.bookId === bookId) await store.del('translations', row.key);
  }
  return rows.length;
}

export async function cacheSize() {
  const rows = (await store.all('translations')).filter((row) => !isKey(row));
  return {
    entries: rows.length,
    characters: rows.reduce((n, r) => n + (r.value?.length || 0), 0),
  };
}

/* ── translating ──────────────────────────────────────────────────────── */

/**
 * Translate a batch, using the cache for anything already done.
 *
 * Only the misses are sent. Fields are named by the caller so the cache can
 * be keyed per item: "chapter:3", "body:3", and so on.
 */
const askedAgain = new Set();

/* ── what a translation is given besides the words ────────────────────────
 *
 * For an AI model and for DeepL: the book's glossary (glossary.js), the part
 * of it that occurs in what is translated. For a model also: the reader's own
 * instructions, by the language translated from, and the page as a picture.
 * A translation made with other entries or instructions is kept apart from
 * one made without, so changing a name in the glossary is a fresh translation
 * of where that name occurs -- and nowhere else.
 */

/** The instruction profiles, by the language translated from. */
export const PROMPT_PROFILES = [['ko', 'Korean'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['other', 'Other languages']];

/** What a model is told unless told otherwise (LlmTranslator.DEFAULT_INSTRUCTIONS). */
export const DEFAULT_PROMPT = 'You translate for a reading app. The user sends a JSON array of strings: '
  + 'consecutive parts of one page of a book or comic -- speech bubbles, captions or paragraphs, in reading '
  + 'order. Translate each string from {source} into {target}. Read them together for context: keep names, '
  + 'terms and tone consistent, and keep each translation in its own place even when a sentence runs on from '
  + 'one part into the next. Translate faithfully and naturally, keeping the register as written -- casual '
  + 'speech stays casual, sound effects become English-style sound effects.';

export const profileOf = (source) => {
  const base = String(source || '').split('-')[0].toLowerCase();
  return ['ko', 'ja', 'zh'].includes(base) ? base : 'other';
};

/** The reader's own instructions for translating from this language; '' for the usual. */
export function promptFor(settings, source) {
  const text = String(settings?.translatePrompts?.[profileOf(source)] || '').trim();
  return text && text !== DEFAULT_PROMPT ? text : '';
}

function hashOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Whether a translation came back as the original, or largely still in its
 * script: a model that skipped a line, a bubble DeepL took for a name. Only
 * for a source written in a script of its own -- Korean, Japanese, Chinese,
 * Russian and the like -- translated into another; a French line left in
 * French cannot be told from one translated into it by its letters.
 */
export function untranslated(text, out, target = '') {
  const original = String(text || '');
  const result = String(out ?? '');
  if (!original.trim()) return false;
  if (!result.trim()) return true;
  const script = languageOfText(original);
  const into = String(target || '').split('-')[0].toLowerCase();
  if (!script || script === into) return false;
  const pattern = SCRIPTS.find(([code]) => code === script)?.[1];
  const letters = [...result].filter((c) => /\p{L}/u.test(c)).length;
  if (!pattern || !letters) return false;
  const left = (result.match(new RegExp(pattern.source, 'gu')) || []).length;
  return left / letters > 0.2;
}

export async function translateBatch(bookId, items, lang, sourceLang = '',
  { context = '', previous = '', image = null, glossary: given = null } = {}) {
  const results = new Map();
  const misses = [];

  const engine = status().engine;
  const rich = typeof window.GrimoireTranslate?.translateWith === 'function';
  const takesGlossary = rich && (engine === 'llm' || engine === 'deepl');
  const terms = takesGlossary ? (given || await glossaryTerms(bookId)) : [];
  const instructions = rich && engine === 'llm' ? promptFor(await store.settings(), sourceLang) : '';
  // Kept apart by the glossary entries and the instructions it was made with.
  const keyed = (item) => {
    const used = glossaryRelevant(terms, item.text);
    if (!used.length && !instructions) return item.field;
    return `${item.field}#${hashOf(JSON.stringify([used.map((e) => [e.source, e.target, e.gender]), instructions]))}`;
  };

  const into = String(lang || '').split('-')[0].toLowerCase();
  for (const item of items) {
    const field = keyed(item);
    const hit = await cached(bookId, field, lang);
    // Kept untranslated -- a Korean title sent as English, from a book that
    // said it was, came back as it went -- is asked again, now the language
    // is told from the characters. Not when it is already in the language
    // wanted: that one is right as it is.
    // Once a session: one that comes back unchanged again is let be.
    const again = `${bookId}:${field}:${lang}`;
    const stuck = hit !== null && hit === item.text && !!languageOfText(item.text)
      && languageOfText(item.text) !== into && !askedAgain.has(again);
    if (stuck) askedAgain.add(again);
    if (hit !== null && !stuck) results.set(item.field, hit);
    else if (item.text && item.text.trim()) misses.push({ ...item, keyedField: field });
  }

  if (!misses.length) return { results, translated: 0, characters: 0 };

  const ask = async (list, { insist = false } = {}) => {
    const texts = list.map((m) => m.text);
    const around = String(context || '').slice(0, 2000);
    const used = glossaryRelevant(terms, `${texts.join('\n')}\n${around}`);
    const options = {
      ...(around ? { context: around } : {}),
      ...(previous ? { previous: String(previous).slice(-1500) } : {}),
      ...(used.length ? { glossary: used.map(({ source, target, kind, gender, note }) => ({ source, target, kind, gender, note })) } : {}),
      ...(instructions ? { instructions } : {}),
      ...(image && engine === 'llm' ? { image } : {}),
      ...(insist ? { insist: true } : {}),
    };
    // ML Kit needs to be told the source language; it does not sniff. The
    // book's own declared language is the answer nearly every time. Context
    // -- the bubbles around the one being translated, say -- goes to DeepL to
    // steer names and tone, and is not translated or charged. Builds without
    // the newer bridge methods are asked plainly.
    let response;
    if (rich && Object.keys(options).length) {
      response = await call('translateWith', [JSON.stringify(texts), lang, sourceLang || '', JSON.stringify(options)], 180000);
    } else {
      const withContext = around && typeof window.GrimoireTranslate?.translateWithContext === 'function';
      response = await call(withContext ? 'translateWithContext' : 'translate', [
        JSON.stringify(texts), lang, sourceLang || '', ...(withContext ? [around] : []),
      ], 120000);
    }
    const payload = parse(response);
    if (!payload?.texts) {
      // Not always DeepL: this is whichever engine is selected.
      throw new Error('The translation engine returned something unreadable.');
    }
    return payload;
  };

  const payload = await ask(misses);
  const out = misses.map((_, i) => payload.texts[i]);
  let characters = payload.characters || 0;

  /* Checked: a part left untranslated is asked for once more, on its own
   * with the others as context, told plainly to translate it. Still left,
   * it is shown as it came but not kept, so the next look asks again. */
  const left = misses.map((m, i) => i).filter((i) => out[i] != null && untranslated(misses[i].text, out[i], lang));
  if (left.length && rich && (engine === 'llm' || engine === 'deepl')) {
    try {
      const again = await ask(left.map((i) => misses[i]), { insist: true });
      characters += again.characters || 0;
      left.forEach((i, k) => {
        const value = again.texts[k];
        if (value != null && !untranslated(misses[i].text, value, lang)) out[i] = value;
      });
    } catch {
      // The first answer stands.
    }
  }

  for (let i = 0; i < misses.length; i++) {
    const value = out[i];
    if (value == null) continue;
    results.set(misses[i].field, value);
    if (!untranslated(misses[i].text, value, lang)) await remember(bookId, misses[i].keyedField, lang, value);
  }

  return { results, translated: misses.length, characters };
}

/** A question for the AI model set up, and its answer as text (finding a book's names). */
export async function complete(system, user) {
  if (typeof window.GrimoireTranslate?.complete !== 'function') {
    throw new Error('This version of the app cannot ask the model that.');
  }
  const payload = parse(await call('complete', [system, user], 180000));
  return String(payload?.text || '');
}

/**
 * The parts of one page -- the bubbles of a picture -- translated together.
 *
 * Each part is sent as its own text, so that each translation comes back to
 * its own place, with the whole page as context: DeepL reads it for names,
 * tone and what a line answers (and does not charge for it), and a language
 * model is sent the page as one list. Marking the parts with tags in one
 * text was tried, and DeepL translates each tagged part as a sentence on its
 * own -- the context it was meant to keep, lost.
 *
 * @param items [{ field, text }], in reading order
 */
export async function translatePage(bookId, items, lang, sourceLang = '', { image = null } = {}) {
  const context = items.map((item) => item.text).join('\n');
  return translateBatch(bookId, items, lang, sourceLang, { context, image });
}

/** Chapter names for the index and the reader header. */
export async function translateChapterNames(bookId, chapters, lang, sourceLang) {
  return translateBatch(bookId, chapters.map((c) => ({
    field: `chapter:${c.index}`,
    text: c.title,
  })), lang, sourceLang);
}

/**
 * A chapter's body, paragraph by paragraph.
 *
 * Sent as separate strings rather than one blob so the structure survives:
 * DeepL translates each independently and returns them in order, which maps
 * straight back onto the paragraphs they came from. The original is never
 * replaced -- the caller decides what to show.
 */
export async function translateChapterBody(bookId, chapter, lang, sourceLang) {
  const holder = document.createElement('div');
  holder.innerHTML = chapterHtml(chapter);

  const blocks = [...holder.querySelectorAll('p, h1, h2, h3, h4, li, blockquote')]
    .filter((node) => node.textContent.trim());
  if (!blocks.length) return { html: chapterHtml(chapter), translated: 0, characters: 0 };

  /* Carried on from the chapter before: how its translation ended goes
   * with this one, so a scene running over the chapter break keeps its
   * voice, its names and who is speaking. */
  const previous = chapter.index > 0 ? await cached(bookId, `tail:${chapter.index - 1}`, lang) : null;
  const { results, translated, characters } = await translateBatch(
    bookId,
    blocks.map((node, i) => ({ field: `body:${chapter.index}:${i}`, text: node.textContent.trim() })),
    lang, sourceLang, { previous: previous || '' });

  const done = [];
  blocks.forEach((node, i) => {
    const value = results.get(`body:${chapter.index}:${i}`);
    if (value != null) { node.textContent = value; done.push(value); }
  });
  // And this one's ending kept, for the chapter after.
  const tail = done.slice(-4).join('\n').slice(-1500);
  if (tail.trim()) await remember(bookId, `tail:${chapter.index}`, lang, tail);

  return { html: holder.innerHTML, translated, characters };
}
