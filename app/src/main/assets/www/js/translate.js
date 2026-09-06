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

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** Synchronous and cheap. Never returns the key, only whether one is set. */
export function status() {
  if (!available()) return { configured: false, unavailable: true };
  return parse(window.GrimoireTranslate.status()) || { configured: false };
}

export const ENGINES = [
  ['ondevice', 'On device', 'Free, no account, and offline once a language pack is installed.'],
  ['deepl', 'DeepL', 'Best quality. Needs an API key; free tier is 500,000 characters a month.'],
  ['libre', 'LibreTranslate', 'Free software you can self-host, so your text goes to a server you chose.'],
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
export const setKey = (key) => call('setKey', [key], 30000).then(parse);
export const clearKey = () => call('clearKey').then(parse);
export const usage = () => call('usage').then(parse);

/* ── languages ────────────────────────────────────────────────────────── */

export const TARGETS = [
  ['EN-GB', 'English (UK)'], ['EN-US', 'English (US)'], ['DE', 'Deutsch'],
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

/** Forget everything translated for one book, or for the whole library. */
export async function clearCache(bookId = null) {
  const rows = await store.all('translations');
  for (const row of rows) {
    if (bookId === null || row.bookId === bookId) await store.del('translations', row.key);
  }
  return rows.length;
}

export async function cacheSize() {
  const rows = await store.all('translations');
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
export async function translateBatch(bookId, items, lang, sourceLang = '') {
  const results = new Map();
  const misses = [];

  for (const item of items) {
    const hit = await cached(bookId, item.field, lang);
    if (hit !== null) results.set(item.field, hit);
    else if (item.text && item.text.trim()) misses.push(item);
  }

  if (!misses.length) return { results, translated: 0, characters: 0 };

  // ML Kit needs to be told the source language; it does not sniff. The
  // book's own declared language is the answer nearly every time.
  const response = await call('translate', [
    JSON.stringify(misses.map((m) => m.text)),
    lang,
    sourceLang || '',
  ], 120000);
  const payload = parse(response);
  if (!payload?.texts) throw new Error('DeepL returned something unreadable');

  for (let i = 0; i < misses.length; i++) {
    const value = payload.texts[i];
    if (value == null) continue;
    results.set(misses[i].field, value);
    await remember(bookId, misses[i].field, lang, value);
  }

  return { results, translated: misses.length, characters: payload.characters || 0 };
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
  holder.innerHTML = chapter.html;

  const blocks = [...holder.querySelectorAll('p, h1, h2, h3, h4, li, blockquote')]
    .filter((node) => node.textContent.trim());
  if (!blocks.length) return { html: chapter.html, translated: 0, characters: 0 };

  const { results, translated, characters } = await translateBatch(
    bookId,
    blocks.map((node, i) => ({ field: `body:${chapter.index}:${i}`, text: node.textContent.trim() })),
    lang, sourceLang);

  blocks.forEach((node, i) => {
    const value = results.get(`body:${chapter.index}:${i}`);
    if (value != null) node.textContent = value;
  });

  return { html: holder.innerHTML, translated, characters };
}
