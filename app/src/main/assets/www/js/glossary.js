/* A book's glossary: its names and terms, and how each is rendered.
 *
 * A translation that calls the hero Kim Dokja on one page and Kim Dok-ja on
 * the next, or turns a sect's name into three different English phrases, is
 * the commonest fault in machine-translated fiction. A glossary fixes each
 * one: the original, its rendering, what it is (a character, a place, a
 * skill...) and, for a character, whether to say he or she -- which Korean,
 * Japanese and Chinese leave out and a translator must otherwise guess.
 *
 * Every translation of the book is given the entries that occur in what is
 * being translated: an AI model reads them with its instructions, DeepL is
 * given them as one of its glossaries. (On-device translation and
 * LibreTranslate cannot take a glossary.)
 *
 * One glossary serves a whole series -- volume 12 knows the names volume 1
 * did -- and a book with no series has its own, shared by its editions.
 * Entries can be typed, found in the book by the AI model, and brought in
 * from a file: Glossarion's JSON, CSV and text glossaries all read.
 */

import * as store from './store.js';

export const KINDS = [
  ['character', 'Character'], ['place', 'Place'], ['group', 'Group'], ['term', 'Term'],
  ['skill', 'Skill'], ['item', 'Item'], ['title', 'Title'], ['other', 'Other'],
];
export const GENDERS = [['', '—'], ['male', 'He'], ['female', 'She'], ['neutral', 'They']];

/* ── where it is kept ─────────────────────────────────────────────────── */

const normal = (text) => String(text || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Whose glossary a book uses: its series', else its own (an edition's is its bundle's). */
export function scopeOf(book) {
  if (book?.series && String(book.series).trim()) {
    return { id: `series:${normal(book.series)}`, label: `the series “${String(book.series).trim()}”`, series: true };
  }
  const own = book?.bundleId != null ? book.bundleId : book?.id;
  return { id: `book:${own}`, label: 'this book', series: false };
}

/* Kept with the translations, under a kind of their own: never cleared with
 * the cache (translate.js), and carried in a backup (store.exportBackup). */
const keyOf = (scope) => `glossary:${scope.id}`;

/** The glossary a book uses: { scope, entries, scanned }. */
export async function load(book) {
  const scope = scopeOf(book);
  let saved = null;
  try {
    saved = (await store.get('translations', keyOf(scope)))?.value;
  } catch { /* none yet */ }
  let data = {};
  try { data = saved ? JSON.parse(saved) : {}; } catch { data = {}; }
  return { scope, entries: clean(data.entries || []), scanned: data.scanned || {} };
}

export async function save(book, entries, { scanned } = {}) {
  const scope = scopeOf(book);
  const before = await load(book);
  const value = JSON.stringify({ scope: scope.id, entries: clean(entries), scanned: scanned || before.scanned });
  await store.put('translations', {
    key: keyOf(scope), bookId: book.id, field: 'glossary', lang: 'glossary', value, at: Date.now(),
  });
}

/** The entries for a book by its id, for translating it. */
export async function termsFor(bookId) {
  if (bookId == null || bookId < 0) return [];
  try {
    const book = await store.get('books', bookId);
    return book ? (await load(book)).entries : [];
  } catch {
    return [];
  }
}

/* ── entries ──────────────────────────────────────────────────────────── */

const KIND_WORDS = {
  character: 'character', characters: 'character', person: 'character', people: 'character', name: 'character',
  names: 'character', npc: 'character', protagonist: 'character', 'main character': 'character',
  place: 'place', places: 'place', location: 'place', locations: 'place', city: 'place', country: 'place',
  group: 'group', groups: 'group', organization: 'group', organizations: 'group', organisation: 'group',
  organisations: 'group', faction: 'group', factions: 'group', sect: 'group', guild: 'group', clan: 'group',
  term: 'term', terms: 'term', concept: 'term', glossary: 'term', terminology: 'term',
  skill: 'skill', skills: 'skill', ability: 'skill', abilities: 'skill', technique: 'skill', techniques: 'skill',
  item: 'item', items: 'item', weapon: 'item', artifact: 'item', artefact: 'item', object: 'item',
  title: 'title', titles: 'title', rank: 'title', honorific: 'title', honorifics: 'title',
  other: 'other', misc: 'other',
};
const kindOf = (word) => KIND_WORDS[normal(word).replace(/[_-]+/g, ' ')] || (word ? 'other' : '');

const GENDER_WORDS = {
  male: 'male', m: 'male', man: 'male', he: 'male', boy: 'male', him: 'male',
  female: 'female', f: 'female', woman: 'female', she: 'female', girl: 'female', her: 'female',
  neutral: 'neutral', nonbinary: 'neutral', 'non-binary': 'neutral', they: 'neutral', n: 'neutral',
};
const genderOf = (word) => GENDER_WORDS[normal(word)] || '';

/** An entry made tidy: trimmed, its kind and gender one of the known ones. */
function entry(raw) {
  const source = String(raw?.source ?? '').trim();
  const target = String(raw?.target ?? '').trim();
  if (!source) return null;
  return {
    source,
    target,
    kind: KINDS.some(([k]) => k === raw.kind) ? raw.kind : kindOf(raw.kind),
    gender: GENDERS.some(([g]) => g === raw.gender) ? raw.gender : genderOf(raw.gender),
    note: String(raw?.note ?? '').trim(),
  };
}

/** Entries made tidy, one to an original: the first kept, later ones fill its gaps. */
export function clean(entries) {
  const out = [];
  const at = new Map();
  for (const raw of entries || []) {
    const one = entry(raw);
    if (!one) continue;
    const key = normal(one.source);
    if (!at.has(key)) { at.set(key, out.length); out.push(one); continue; }
    const kept = out[at.get(key)];
    for (const field of ['target', 'kind', 'gender', 'note']) if (!kept[field] && one[field]) kept[field] = one[field];
  }
  return out;
}

/**
 * Entries brought in, put with those there: a new original is added; one
 * already there keeps its rendering and has only its gaps filled -- what the
 * reader typed is never overwritten by a file or a model.
 *
 * @returns { entries, added, filled }
 */
export function merge(existing, incoming) {
  const out = clean(existing).map((e) => ({ ...e }));
  const at = new Map(out.map((e, i) => [normal(e.source), i]));
  let added = 0;
  let filled = 0;
  for (const one of clean(incoming)) {
    const key = normal(one.source);
    if (!at.has(key)) { at.set(key, out.length); out.push(one); added++; continue; }
    const kept = out[at.get(key)];
    let changed = false;
    for (const field of ['target', 'kind', 'gender', 'note']) {
      if (!kept[field] && one[field]) { kept[field] = one[field]; changed = true; }
    }
    if (changed) filled++;
  }
  return { entries: out, added, filled };
}

/** The entries that occur in a text: all a translation of it needs. */
export function relevant(entries, text) {
  const haystack = normal(text);
  if (!haystack) return [];
  return (entries || []).filter((e) => e.target && haystack.includes(normal(e.source)));
}

/* ── files ────────────────────────────────────────────────────────────── *
 *
 * Read from what glossary tools write, Glossarion's above all:
 *   - JSON: a list of entries, with the names Glossarion uses (raw_name,
 *     translated_name, gender, type, description) or plainer ones
 *     (source/target, original/translation); a plain map of original to
 *     rendering; or sections -- { "characters": [...], "terms": [...] }.
 *   - CSV: with a header row, or without one (original, rendering), with
 *     "=== CHARACTERS ===" lines heading each section, as Glossarion's
 *     compact glossaries are written.
 *   - Text or Markdown: a line to an entry, "original → rendering" (or ->,
 *     =, :, a tab, or a table row).
 */

const SOURCE_NAMES = ['raw_name', 'raw', 'source', 'original', 'original_name', 'term', 'name_raw', 'korean', 'japanese', 'chinese', 'kr', 'jp', 'cn', 'from'];
const TARGET_NAMES = ['translated_name', 'translation', 'translated', 'target', 'english', 'en', 'name_translated', 'rendering', 'to', 'name'];
const KIND_NAMES = ['type', 'kind', 'category', 'entry_type', 'section'];
const NOTE_NAMES = ['description', 'note', 'notes', 'context', 'comment'];
const pick = (object, names) => {
  for (const name of names) {
    for (const key of Object.keys(object)) if (normal(key) === name) return object[key];
  }
  return undefined;
};

function fromObject(object, kind = '') {
  if (!object || typeof object !== 'object') return null;
  let source = pick(object, SOURCE_NAMES);
  let target = pick(object, TARGET_NAMES);
  // "name" is the rendering only when something else is the original.
  if (source === undefined && target !== undefined && 'name' in object) { source = object.name; target = undefined; }
  if (source === undefined) return null;
  return {
    source: String(source ?? ''),
    target: String(target ?? ''),
    kind: pick(object, KIND_NAMES) ?? kind,
    gender: pick(object, ['gender', 'sex', 'pronoun', 'pronouns']) ?? '',
    note: pick(object, NOTE_NAMES) ?? '',
  };
}

/** Whether an object's keys are an entry's fields, not a list of names. */
const describesEntry = (object) => Object.keys(object).some((key) =>
  [...TARGET_NAMES, ...KIND_NAMES, ...NOTE_NAMES, 'gender'].includes(normal(key)));

function fromJson(data) {
  const out = [];
  const walk = (value, kind) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const one = fromObject(item, kind);
        if (one) out.push(one);
        else if (item && typeof item === 'object') walk(item, kind);
      }
    } else if (value && typeof value === 'object') {
      const one = fromObject(value, kind);
      if (one) { out.push(one); return; }
      for (const [key, inner] of Object.entries(value)) {
        if (typeof inner === 'string') out.push({ source: key, target: inner, kind });
        else if (inner && typeof inner === 'object' && !Array.isArray(inner) && describesEntry(inner)) {
          // { "김독자": { "translated_name": "Kim Dokja", "gender": "male" } }
          const one2 = fromObject({ raw_name: key, ...inner }, kind);
          if (one2) out.push(one2);
        } else {
          // { "Characters": { "김독자": "Kim Dokja" } }, { "terms": [...] }
          walk(inner, KIND_WORDS[normal(key)] || kind);
        }
      }
    }
  };
  walk(data, '');
  return out;
}

/** CSV cells of one line, quotes and doubled quotes understood. */
function cells(line, separator) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell.trim()) quoted = true;
    else if (c === separator) { out.push(cell.trim()); cell = ''; } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

function fromLines(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let kind = '';
  let header = null;
  let lastWasTable = false;
  const csvish = lines.filter((l) => l.includes(',')).length >= lines.filter((l) => l.trim()).length / 2;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    // A table's rule: the row above it was the table's headings.
    if (/^\|?\s*:?-{3,}/.test(line)) {
      if (lastWasTable && !header) out.pop();
      lastWasTable = false;
      continue;
    }
    lastWasTable = line.startsWith('|');
    // Glossarion's compact glossaries open with the columns they hold.
    if (/^glossary( columns)?:/i.test(line)) continue;
    // === CHARACTERS ===, ## Places, [Terms]
    const section = line.match(/^(?:={2,}\s*(.+?)\s*={2,}|#{1,6}\s+(.+)|\[(.+)\])$/);
    if (section) { kind = kindOf(section[1] || section[2] || section[3]); header = null; continue; }
    let parts;
    if (line.startsWith('|')) parts = line.replace(/^\||\|$/g, '').split('|').map((p) => p.trim());
    else if (line.includes('\t')) parts = line.split('\t').map((p) => p.trim());
    else if (csvish && line.includes(',')) parts = cells(line, ',');
    else {
      const arrow = line.replace(/^[-*•]\s*/, '').match(/^(.+?)\s*(?:→|->|=>|=|:|：)\s*(.+)$/);
      if (!arrow) continue;
      // "Kim Dokja [Male]: the reader" -- Glossarion's compact entries --
      // or "Kim Dokja (the reader)".
      const rest = arrow[2].match(/^(.+?)(?:\s*\[([^\]]+)\])?(?:\s*:\s*(.+)|\s*\((.+)\))?\s*$/);
      out.push({
        source: arrow[1],
        target: rest ? rest[1] : arrow[2],
        gender: rest?.[2] || '',
        note: rest?.[3] || rest?.[4] || '',
        kind,
      });
      continue;
    }
    const lower = parts.map((p) => normal(p));
    if (!header && lower.some((p) => SOURCE_NAMES.includes(p)) && lower.some((p) => TARGET_NAMES.includes(p) || KIND_NAMES.includes(p))) {
      header = lower;
      continue;
    }
    if (header) {
      const object = {};
      header.forEach((name, i) => { object[name] = parts[i] ?? ''; });
      const one = fromObject(object, kind);
      if (one) out.push(one);
    } else if (parts.length >= 2) {
      // Glossarion's compact rows: type, original, rendering[, gender[, note]]
      // when the first cell is a kind; else original, rendering[, gender, note].
      const lead = KIND_WORDS[lower[0]];
      const [source, target, gender, note] = lead && parts.length >= 3 ? parts.slice(1) : parts;
      out.push({ source, target, gender, note, kind: lead && parts.length >= 3 ? lead : kind });
    }
  }
  return out;
}

/**
 * The entries in a glossary file, whatever kind it is.
 * @throws when nothing in it reads as an entry
 */
export function parseFile(text, name = '') {
  const body = String(text || '').replace(/^﻿/, '');
  let found = [];
  const trimmed = body.trim();
  if (/\.json$/i.test(name) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      found = fromJson(JSON.parse(trimmed));
    } catch {
      found = fromLines(body);
    }
  } else {
    found = fromLines(body);
  }
  const entries = clean(found);
  if (!entries.length) throw new Error('No glossary entries were found in that file.');
  return entries;
}

/** Written out as Glossarion reads it: a JSON list with its field names. */
export function toJson(entries) {
  return JSON.stringify(clean(entries).map((e) => ({
    type: e.kind || 'term', raw_name: e.source, translated_name: e.target,
    ...(e.gender ? { gender: e.gender } : {}), ...(e.note ? { description: e.note } : {}),
  })), null, 2);
}

/** And as a CSV, for a spreadsheet. */
export function toCsv(entries) {
  const quote = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [['type', 'raw_name', 'translated_name', 'gender', 'description']];
  for (const e of clean(entries)) rows.push([e.kind || 'term', e.source, e.target, e.gender, e.note]);
  return rows.map((row) => row.map(quote).join(',')).join('\n');
}

/* ── found by the model ──────────────────────────────────────────────── */

/** How much of the book one request takes, and how many requests one scan makes. */
export const SCAN_CHARS = 6000;
export const SCAN_REQUESTS = 3;

/** What the model is told to do. */
export function findingInstructions(targetName) {
  return 'You build glossaries for translating fiction. In the text the user sends, find the proper nouns '
    + 'and special terms a translator must render the same way every time: character names, places, '
    + 'groups (sects, guilds, companies, families), titles and ranks, skills and techniques, named items, '
    + `and invented words. For each, give its rendering in ${targetName}: a person's name romanised as `
    + 'translations of the genre usually do, a meaningful name translated. Give each character\'s gender as '
    + '"male", "female" or "" when the text does not show it. Leave out ordinary words, and anything listed '
    + 'as already in the glossary. Reply with only a JSON array of objects with the keys "source" (exactly '
    + 'as written in the text), "target", "kind" (character, place, group, title, skill, item or term), '
    + '"gender" and "note" (a few words on who or what it is), and nothing else.';
}

/** The model's answer as entries; anything that is not one is left out. */
export function parseFound(reply) {
  const text = String(reply || '');
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  if (open < 0 || close <= open) throw new Error('The model did not answer with a list of names.');
  let list;
  try {
    list = JSON.parse(text.slice(open, close + 1));
  } catch {
    throw new Error('The model did not answer with a list of names.');
  }
  return clean(fromJson(list));
}

/**
 * The book's text, from where the last scan stopped, for the next scan:
 * chapter after chapter, its paragraphs' words.
 *
 * @returns { pieces: [text], next: { chapter, offset } } -- empty when the book has no more words
 */
export function nextPieces(chapters, from = { chapter: 0, offset: 0 }, plainText) {
  const pieces = [];
  let piece = '';
  let at = { ...from };
  const ordered = [...chapters].sort((a, b) => a.index - b.index);
  for (let c = 0; c < ordered.length && pieces.length < SCAN_REQUESTS; c++) {
    const chapter = ordered[c];
    if (chapter.index < at.chapter) continue;
    const words = plainText(chapter);
    let offset = chapter.index === at.chapter ? at.offset : 0;
    while (offset < words.length && pieces.length < SCAN_REQUESTS) {
      const take = words.slice(offset, offset + (SCAN_CHARS - piece.length));
      piece += take;
      offset += take.length;
      if (piece.length >= SCAN_CHARS) { pieces.push(piece); piece = ''; }
    }
    at = { chapter: chapter.index, offset };
    if (offset >= words.length) {
      piece += '\n';
      at = { chapter: chapter.index + 1, offset: 0 };
    }
  }
  if (piece.trim() && pieces.length < SCAN_REQUESTS) pieces.push(piece);
  return { pieces: pieces.filter((p) => p.trim()), next: at };
}
