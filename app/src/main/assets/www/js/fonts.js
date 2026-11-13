/* Fonts of your own, to read in.
 *
 * A .ttf, .otf, .woff or .woff2 picked from the phone is checked to be a
 * font, kept in the app's own storage, and loaded each time the app starts
 * (the FontFace API: no bridge, nothing sent anywhere). Each is then a face
 * to read in, beside Newsreader and Archivo, chosen in Layout as they are.
 *
 * The font itself is kept apart from the settings -- a record of its own in
 * the settings store, `font:<id>` -- so a settings backup stays small; only
 * the list of fonts (id and name) is in the settings. A backup restored
 * elsewhere names fonts that are not there, and those are simply not offered.
 */

import * as store from './store.js';

/** What the picker is asked for. Wide on purpose: Android's pickers type a
 *  font as a font, as "some file", or as nothing, and greying the file out
 *  is the worst of those. */
export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2,font/sfnt,'
  + 'application/x-font-ttf,application/x-font-otf,application/font-sfnt,application/font-woff,'
  + 'application/vnd.ms-opentype,application/octet-stream';

/** The largest font kept: a full CJK face runs to 20 MB or so. */
export const FONT_MAX_BYTES = 40 * 1024 * 1024;

/** The family a kept font is loaded under: its own, apart from any the page knows. */
export const familyOf = (id) => `quire-font-${id}`;

/** What a layout's face is drawn in: one of the app's two, or a font of your own. */
export function faceFamily(face) {
  if (face === 'Archivo') return 'var(--font-heading)';
  const own = /^font:(.+)$/.exec(String(face || ''));
  if (own) return `"${familyOf(own[1])}", var(--font-body)`;
  return 'var(--font-body)';
}

/** Whether the bytes are a font: TrueType, OpenType, a collection, or WOFF/WOFF2. */
export function looksLikeFont(bytes) {
  const b = new Uint8Array(bytes.slice ? bytes.slice(0, 4) : bytes);
  if (b.length < 4) return false;
  const tag = String.fromCharCode(...b);
  return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)
    || ['OTTO', 'true', 'typ1', 'ttcf', 'wOFF', 'wOF2'].includes(tag);
}

/** A file's name as a font's: its extension and the usual weight words left as they are. */
export function nameOfFile(name) {
  return String(name || 'Font').replace(/\.(ttf|otf|ttc|woff2?)$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 60) || 'Font';
}

const loaded = new Set();

async function loadOne(font, bytes) {
  if (loaded.has(font.id)) return true;
  if (typeof FontFace !== 'function' || !document.fonts) return false;
  const face = new FontFace(familyOf(font.id), bytes);
  await face.load();
  document.fonts.add(face);
  loaded.add(font.id);
  return true;
}

const bytesOf = (blob) => (typeof blob.arrayBuffer === 'function'
  ? blob.arrayBuffer()
  : new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  }));

/** Every kept font, loaded. One that will not load is left out, not fatal. @returns the fonts loaded */
export async function loadAll() {
  const fonts = (await store.settings()).fonts || [];
  const ok = [];
  for (const font of fonts) {
    try {
      const row = await store.get('settings', `font:${font.id}`);
      if (!row?.blob) continue;
      if (await loadOne(font, await bytesOf(row.blob))) ok.push(font);
    } catch (error) {
      console.warn('font', font.name, error);
    }
  }
  return ok;
}

/** The fonts kept, as the settings list them. */
export async function list() {
  return (await store.settings()).fonts || [];
}

/**
 * A font picked from the phone: checked, loaded, kept.
 * @returns {{ id, name }}
 * @throws with a sentence to show when it is not a font, too large, or will not load
 */
export async function add(file) {
  if (!file) throw new Error('No file was picked.');
  if (file.size > FONT_MAX_BYTES) throw new Error('That file is too large to be a font.');
  const bytes = await bytesOf(file);
  if (!looksLikeFont(bytes)) throw new Error('That file is not a font (.ttf, .otf, .woff or .woff2).');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const font = { id, name: nameOfFile(file.name) };
  try {
    await loadOne(font, bytes);
  } catch {
    throw new Error('This phone could not read that font.');
  }
  await store.put('settings', { key: `font:${id}`, blob: new Blob([bytes], { type: file.type || 'font/sfnt' }), name: font.name });
  const fonts = await list();
  await store.saveSettings({ fonts: [...fonts, font] });
  return font;
}

/** A kept font, let go: its file, and its place in the list. Books reading in it go back to Newsreader. */
export async function remove(id) {
  await store.del('settings', `font:${id}`);
  await store.saveSettings({ fonts: (await list()).filter((font) => font.id !== id) });
  loaded.delete(id);
}
