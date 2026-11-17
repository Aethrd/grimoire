/* A whole book translated: a new edition of it, bound to the original.
 *
 * Chapter by chapter, in order, with the translator chosen in settings -- an
 * AI model with its keys (turned, and fallen back from, natively), DeepL, or
 * on-device. Each chapter is written into the new book the moment it is
 * done, so the edition can be read while the rest comes in, and nothing is
 * lost if the app is closed: every paragraph translated is kept in the
 * translation cache, and the run carries on from the chapter after the last
 * one written.
 *
 * The new book is an edition of the original (a bundle: one tile, two
 * editions), with the original's pictures and cover, and its own name.
 *
 * Each chapter is checked as it is written (checkChapter): paragraphs left
 * in the original, an answer that is a refusal rather than a translation,
 * one much shorter than the original. What is found is listed with the run,
 * and can be done again, the kept translation of it forgotten first.
 *
 * The run itself is kept in settings.translateJobs -- this phone's, by its
 * numbers for the books (store.DEVICE_SETTINGS), never in a backup.
 */

import * as store from './store.js';
import * as translate from './translate.js';
import * as library from './library.js';
import { countWords, chapterHtml } from './parse.js';

/** A run's options, and what they start as. */
export const DEFAULTS = { temperature: null, delay: 3 };
/** The temperatures offered (null: the service's own); the waits between chapters, in seconds. */
export const TEMPERATURES = [null, 0.2, 0.5, 0.8];
export const DELAYS = [0, 1, 3, 6, 10];

/* ── the runs ─────────────────────────────────────────────────────────── */

export async function jobs() {
  const list = (await store.settings()).translateJobs;
  return Array.isArray(list) ? list : [];
}

async function save(job) {
  const list = (await jobs()).filter((other) => other.id !== job.id);
  list.push({ ...job, updatedAt: Date.now() });
  await store.saveSettings({ translateJobs: list });
}

export async function getJob(id) {
  return (await jobs()).find((job) => job.id === id) || null;
}

/** The run translating this book into this language, if there is one -- or into any, without a language. */
export async function jobFor(sourceId, lang = null) {
  return (await jobs()).find((job) => job.sourceId === sourceId && (lang == null || job.lang === lang)) || null;
}

/** A run forgotten (its edition stays, as far as it got). */
export async function forget(id) {
  await store.saveSettings({ translateJobs: (await jobs()).filter((job) => job.id !== id) });
}

/**
 * Begin translating a book: its edition made -- named in the language, with
 * the original's pictures and cover, bound to it as an edition -- and the
 * run kept. A run already begun for this book and language is carried on
 * instead, with the options given now.
 */
export async function begin(sourceId, { lang, sourceLang = '', temperature = DEFAULTS.temperature, delay = DEFAULTS.delay } = {}) {
  const already = await jobFor(sourceId, lang);
  if (already && await store.get('books', already.targetId)) {
    const job = { ...already, temperature, delay, status: already.status === 'done' ? 'done' : 'paused' };
    await save(job);
    return job;
  }
  const source = await store.get('books', sourceId);
  if (!source) throw new Error('That book is no longer on the shelf.');
  const total = await store.chapterCount(sourceId);
  if (!total) throw new Error('That book has no chapters to translate.');
  const from = sourceLang || translate.sourceFor(source) || '';

  // Its name in the language, if the translator can; else the original's, marked.
  let title = '';
  try {
    const { results } = await translate.translateBatch(sourceId, [{ field: 'title', text: source.title }], lang, from);
    title = String(results.get('title') || '').trim();
  } catch { /* named below */ }
  if (!title || title === source.title) title = `${source.title} (${translate.TARGETS.find(([code]) => code === lang)?.[1] || lang})`;

  // One tile, two editions: the original leads, or the bundle it is already in.
  const leader = source.bundleId != null ? source.bundleId : source.id;
  if (source.bundleId == null) await store.put('books', { ...source, bundleId: leader });

  const edition = {
    title,
    author: source.author || null,
    lang: String(lang).split('-')[0].toLowerCase(),
    format: source.format || 'epub',
    fingerprint: `translated:${source.fingerprint || source.id}:${lang}`,
    translatedFrom: { id: source.id, fingerprint: source.fingerprint || null, title: source.title, lang: from || null },
    translation: { lang, done: 0, total, finished: false },
    coverBlob: source.coverBlob || null,
    coverBytes: source.coverBytes ?? null,
    coverCustom: !!source.coverCustom,
    folder: source.folder || null,
    bundleId: leader,
    addedAt: Date.now(),
    words: 0,
    chapters: 0,
  };
  const targetId = await store.add('books', edition);

  // Its pictures, the same blobs under the new book, at the same places.
  const pictures = await library.livePictures(sourceId);
  await store.putAll('images', pictures.map((image) => ({ ...image, bookId: targetId })));

  const job = {
    id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sourceId, targetId, lang, sourceLang: from, temperature, delay,
    status: 'paused', afterIndex: -Infinity, done: 0, total, flagged: [], startedAt: Date.now(),
  };
  await save(job);
  return job;
}

/* ── running one ──────────────────────────────────────────────────────── */

const running = new Set();
export const isRunning = (id) => running.has(id);

/**
 * Translate what is left of a run, chapter by chapter, until it is done,
 * paused, or a translation fails (every key spent, say): then it is paused,
 * with why, to carry on from where it stopped.
 *
 * @param deps { progress, toast, refresh, sleep } -- the app's; sleep for tests.
 */
export async function run(id, { progress, toast, refresh = () => {}, sleep = null } = {}) {
  if (running.has(id)) return null;
  let job = await getJob(id);
  if (!job || job.status === 'done') return job;
  const source = await store.get('books', job.sourceId);
  let target = await store.get('books', job.targetId);
  if (!source || !target) {
    await forget(id);
    toast?.('That translation’s book is gone — the run is forgotten.', 6000);
    return null;
  }
  running.add(id);
  const wait = sleep || ((ms, stop) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => (stop() || Date.now() >= end ? resolve() : setTimeout(tick, Math.min(250, end - Date.now())));
    tick();
  }));
  job = { ...job, status: 'running', lastError: '' };
  await save(job);
  const name = library.displayTitle(target);
  const row = progress?.start(`Translating “${library.displayTitle(source)}”`);
  let pausing = false;
  row?.controls?.({ pause: () => { pausing = true; } });
  let failed = '';
  try {
    for (;;) {
      if (pausing) break;
      const batch = await store.chapterBatch(job.sourceId, job.afterIndex, 20);
      if (!batch.length) break;
      for (const chapter of batch) {
        if (pausing) break;
        row?.say?.(`Translating “${name}”`, job.done / job.total, `${job.done + 1} of ${job.total}`);
        const written = await translateOne(job, chapter, target.id);
        target = await store.get('books', target.id);
        target = {
          ...target,
          chapters: (target.chapters || 0) + (written.replaced ? 0 : 1),
          words: Math.max(0, (target.words || 0) + written.words - (written.replacedWords || 0)),
          translation: { ...(target.translation || {}), lang: job.lang, done: job.done + 1, total: job.total, finished: false },
        };
        await store.put('books', target);
        const flagged = (job.flagged || []).filter((f) => f.index !== chapter.index);
        if (written.problems.length) flagged.push({ index: chapter.index, title: written.title, problems: written.problems });
        job = { ...job, afterIndex: chapter.index, done: job.done + 1, flagged };
        await save(job);
        refresh();
        // A rest between chapters, as asked: some services limit how fast they are asked.
        const ms = Math.round((job.delay || 0) * 1000 * (0.75 + Math.random() * 0.5));
        if (ms) await wait(ms, () => pausing);
      }
    }
  } catch (error) {
    failed = error?.message || 'The translation failed';
  } finally {
    running.delete(id);
  }

  const finished = !failed && !pausing && job.done >= job.total;
  job = { ...job, status: finished ? 'done' : 'paused', lastError: failed, finishedAt: finished ? Date.now() : undefined };
  await save(job);
  target = await store.get('books', job.targetId);
  if (target) {
    await store.put('books', { ...target, translation: { ...(target.translation || {}), done: job.done, total: job.total, finished } });
  }
  refresh();
  const flaggedSaid = job.flagged?.length
    ? ` ${job.flagged.length} chapter${job.flagged.length === 1 ? '' : 's'} to look at (open Translate on it to see and redo them).` : '';
  if (finished) {
    row?.();
    toast?.(`“${name}” translated: ${job.total} chapters, an edition of “${library.displayTitle(source)}”.${flaggedSaid}`, 10000, { kind: job.flagged?.length ? 'failed' : 'done' });
  } else if (failed) {
    row?.fail?.();
    row?.();
    toast?.(`Translating “${name}” stopped at chapter ${job.done + 1} of ${job.total}: ${failed}. Open Translate on it to carry on.`, 12000, { kind: 'failed' });
  } else {
    row?.();
    toast?.(`Translating “${name}” paused at ${job.done} of ${job.total} chapters — open Translate on it to carry on.`, 6000);
  }
  return job;
}

/** One chapter translated and written into the edition, its title too, and checked. */
async function translateOne(job, chapter, targetId) {
  const options = { temperature: job.temperature };
  const { html } = await translate.translateChapterBody(job.sourceId, chapter, job.lang, job.sourceLang, options);
  let title = chapter.title || '';
  if (title.trim()) {
    try {
      const { results } = await translate.translateChapterNames(job.sourceId, [chapter], job.lang, job.sourceLang);
      title = results.get(`chapter:${chapter.index}`) || title;
    } catch { /* the original's title stands */ }
  }
  const text = textOf(html);
  const words = countWords(text, String(job.lang).split('-')[0].toLowerCase());
  const before = await store.get('chapters', [targetId, chapter.index]).catch(() => null);
  await store.put('chapters', {
    bookId: targetId, index: chapter.index, title, html, words,
    base: chapter.base || '', volume: chapter.volume, fromToc: chapter.fromToc,
  });
  return {
    title, words, replaced: !!before, replacedWords: before?.words || 0,
    problems: checkChapter(chapter, html, job.lang),
  };
}

/* ── the check ────────────────────────────────────────────────────────── */

const BLOCKS = 'p, h1, h2, h3, h4, li, blockquote';
const blocksOf = (html) => {
  const holder = document.createElement('div');
  holder.innerHTML = html || '';
  return [...holder.querySelectorAll(BLOCKS)].map((node) => node.textContent.trim()).filter(Boolean);
};
const textOf = (html) => {
  const holder = document.createElement('div');
  holder.innerHTML = html || '';
  return holder.textContent || '';
};

/* An answer that is the model declining, or talking, rather than translating. */
// Either apostrophe: models answer with the curly one as often as the straight.
const REFUSAL = /^\s*(?:I(?:['’]m| am) sorry|Sorry,? (?:but )?I|I can(?:no|['’])t (?:help|assist|translate|provide|comply|continue|do that)|I(?:['’]m| am) (?:not able|unable) to|As an AI|I won['’]t|I will not (?:translate|provide)|Unfortunately,? I (?:can(?:no|['’])t|am unable))/i;
const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

/**
 * What is wrong with a chapter's translation, as far as can be told without
 * reading it: [] if nothing.
 *   untranslated  paragraphs come back still in the original's script
 *   refusal       an answer that declines, or says something, instead
 *   short         much shorter than the original: parts likely dropped
 *   empty         nothing came back for a chapter that had words
 */
export function checkChapter(sourceChapter, translatedHtml, lang) {
  const problems = [];
  const original = blocksOf(chapterHtml(sourceChapter));
  const done = blocksOf(translatedHtml);
  const originalText = original.join('\n');
  const doneText = done.join('\n');
  if (originalText.trim() && !doneText.trim()) return ['empty'];

  // Paragraph by paragraph, where the two line up (the translation keeps each in its place).
  const pairs = Math.min(original.length, done.length);
  let left = 0;
  for (let i = 0; i < pairs; i += 1) if (translate.untranslated(original[i], done[i], lang)) left += 1;
  if (pairs && (left >= 3 || left / pairs > 0.1)) problems.push('untranslated');

  if (done.slice(0, 3).some((text) => REFUSAL.test(text)) || /content (?:policy|guidelines)|cannot be translated/i.test(doneText.slice(0, 600))) {
    problems.push('refusal');
  }

  /* Length: a translation from Korean, Japanese or Chinese runs to about two
   * to three times as many characters in a European language; between
   * alphabets, about as many. Well under that, parts are likely missing. */
  const fromCjk = ((originalText.match(CJK) || []).length / Math.max(1, originalText.replace(/\s/g, '').length)) > 0.3;
  const intoCjk = /^(ja|zh|ko)/i.test(String(lang));
  const expected = fromCjk && !intoCjk ? 1.4 : !fromCjk && intoCjk ? 0.25 : 0.55;
  const ratio = doneText.replace(/\s/g, '').length / Math.max(1, originalText.replace(/\s/g, '').length);
  if (originalText.replace(/\s/g, '').length > 400 && ratio < expected) problems.push('short');
  return problems;
}

export const PROBLEM_WORDS = {
  untranslated: 'left partly in the original',
  refusal: 'reads like a refusal, not a translation',
  short: 'much shorter than the original — parts may be missing',
  empty: 'came back empty',
};

/**
 * Chapters translated again: each one's kept translation forgotten first,
 * so it is truly asked afresh; checked again as it is written.
 * @returns the run, with what is still found.
 */
export async function redo(id, indices, { progress, toast, refresh = () => {} } = {}) {
  let job = await getJob(id);
  if (!job) return null;
  const row = progress?.start(`Translating ${indices.length} chapter${indices.length === 1 ? '' : 's'} again`);
  let failed = '';
  running.add(id);
  try {
    for (const [at, index] of indices.entries()) {
      row?.say?.(null, at / indices.length, `${at + 1} of ${indices.length}`);
      const chapter = await store.get('chapters', [job.sourceId, index]);
      if (!chapter) continue;
      await translate.forgetChapter(job.sourceId, index, job.lang);
      const written = await translateOne(job, chapter, job.targetId);
      const target = await store.get('books', job.targetId);
      if (target) await store.put('books', { ...target, words: Math.max(0, (target.words || 0) + written.words - (written.replacedWords || 0)) });
      const flagged = (job.flagged || []).filter((f) => f.index !== index);
      if (written.problems.length) flagged.push({ index, title: written.title, problems: written.problems });
      job = { ...job, flagged };
      await save(job);
      refresh();
    }
  } catch (error) {
    failed = error?.message || 'The translation failed';
  } finally {
    running.delete(id);
  }
  row?.();
  toast?.(failed
    ? `Translating again stopped: ${failed}`
    : job.flagged.length
      ? `Done — ${job.flagged.length} chapter${job.flagged.length === 1 ? '' : 's'} still to look at.`
      : 'Done — nothing left to look at.', 7000, { kind: failed ? 'failed' : 'done' });
  return job;
}

/**
 * The finished edition checked again from the start, every chapter against
 * the original: for a run made before checking, or after its chapters were
 * changed. Returns the run, with what is found.
 */
export async function recheck(id) {
  let job = await getJob(id);
  if (!job) return null;
  const flagged = [];
  let after = -Infinity;
  for (;;) {
    const batch = await store.chapterBatch(job.sourceId, after, 50);
    if (!batch.length) break;
    after = batch[batch.length - 1].index;
    for (const chapter of batch) {
      const done = await store.get('chapters', [job.targetId, chapter.index]).catch(() => null);
      if (!done) continue;
      const problems = checkChapter(chapter, done.html || '', job.lang);
      if (problems.length) flagged.push({ index: chapter.index, title: done.title, problems });
    }
  }
  job = { ...job, flagged };
  await save(job);
  return job;
}

/** Runs the app was closed in the middle of: paused, to carry on when asked. */
export async function pauseInterrupted() {
  const list = await jobs();
  const cut = list.filter((job) => job.status === 'running');
  if (!cut.length) return [];
  await store.saveSettings({ translateJobs: list.map((job) => (job.status === 'running' ? { ...job, status: 'paused' } : job)) });
  return cut;
}
