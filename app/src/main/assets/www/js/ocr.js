/* Text out of pictures.
 *
 * The reading is done on the phone, by ML Kit's recogniser (OcrBridge.java):
 * the picture is handed across in pieces, read in whichever scripts are
 * asked for, and the text comes back with where each block of it sits. This
 * module decides which scripts to ask for, which reading to believe, and in
 * what order the blocks are read -- a page of manga runs right to left.
 */

const pending = new Map();
let counter = 0;

/** Called from Java when a picture has been read. Not a reader API. */
export function settleOcr(id, ok, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(payload || 'The text could not be read'));
}

export const available = () => typeof window.GrimoireOcr?.recognise === 'function';

/** The scripts there are to read in, with the names they go by here. */
export const SCRIPTS = [
  ['korean', '한국어'],
  ['chinese', '中文'],
  ['japanese', '日本語'],
  ['latin', 'English'],
];

/** Which scripts to read a book's pictures in, from its language. Not
 *  knowing, all of them, and the reading that looks most like its own
 *  script wins. A Korean, Japanese or Chinese book is read in its own
 *  script only: an English reading alongside would sometimes win on a
 *  misread page, and turn あ into A. English is a chip away. */
export function scriptsFor(lang) {
  const code = String(lang || '').toLowerCase();
  if (code.startsWith('ko')) return ['korean'];
  if (code.startsWith('ja')) return ['japanese'];
  if (code.startsWith('zh')) return ['chinese'];
  if (code.startsWith('en')) return ['latin'];
  return SCRIPTS.map(([script]) => script);
}

function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Handed across a piece at a time: a long strip is megabytes, and one
 *  string that size crossing the bridge is held several times over. */
const PIECE = 512 * 1024;     // characters of base64, a multiple of four

/**
 * Read one picture.
 *
 * @returns { width, height, results: { script: { text, blocks } } }
 */
async function handOver(blob) {
  const id = `o${Date.now().toString(36)}${++counter}`;
  const data = await base64Of(blob);
  window.GrimoireOcr.begin(id);
  for (let at = 0; at < data.length; at += PIECE) {
    if (!window.GrimoireOcr.append(id, data.slice(at, at + PIECE))) {
      window.GrimoireOcr.cancel(id);
      throw new Error('The picture could not be handed over to be read.');
    }
  }
  return id;
}

export const lensAvailable = () => typeof window.GrimoireOcr?.lens === 'function';

/** Open the picture in Google Lens, for lettering read better there. */
export async function toLens(blob) {
  if (!lensAvailable()) throw new Error('Google Lens can be reached from the app only.');
  const id = await handOver(blob);
  const problem = window.GrimoireOcr.lens(id);
  if (problem) throw new Error(problem);
}

export async function recognise(blob, scripts, { timeout = 120000 } = {}) {
  if (!available()) throw new Error('Reading text from pictures needs the app.');
  const id = await handOver(blob);
  const payload = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Reading the picture took too long'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      window.GrimoireOcr.recognise(id, scripts.join(','));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

/* How much of a reading is in the script it was read for. A recogniser
 * asked to read the wrong script still finds something -- Hangul read as
 * Chinese is a page of odd characters -- so the readings are compared by
 * how much of each is its own kind of writing. */
const OWN = {
  korean: /[가-힯ᄀ-ᇿ㄰-㆏]/g,
  japanese: /[぀-ヿㇰ-ㇿ]/g,
  chinese: /[一-鿿㐀-䶿]/g,
  latin: /[A-Za-z]/g,
};
const WEIGHT = { korean: 1, japanese: 1.2, chinese: 1, latin: 0.6 };

export function scoreOf(script, text) {
  const own = (String(text || '').match(OWN[script] || OWN.latin) || []).length;
  let score = own * (WEIGHT[script] || 1);
  // Japanese is written in kanji as well as kana: they count, a little.
  if (script === 'japanese' && own > 0) score += (String(text).match(OWN.chinese) || []).length * 0.5;
  return score;
}

/** The reading to believe: the one most in its own script. */
export function pickBest(results, order = Object.keys(results || {})) {
  let best = null;
  let bestScore = -1;
  for (const script of order) {
    const reading = results?.[script];
    if (!reading) continue;
    const score = scoreOf(script, reading.text);
    if (score > bestScore) { best = { script, ...reading }; bestScore = score; }
  }
  return best;
}

/**
 * The blocks in the order they are read, as text.
 *
 * Top to bottom, left to right, for most pages. A page set in columns --
 * manga, and Chinese set the old way -- is read as such a page is: the rows
 * of panels top to bottom, and along each row, right to left. A block read
 * from columns comes with its columns already in order, right to left.
 *
 * A block's own lines are joined as the script joins them: with spaces in
 * English and Korean, with nothing in Chinese and Japanese.
 */
export function readingText(blocks, script, { direction = '' } = {}) {
  const list = (blocks || []).filter((block) => String(block.text || '').trim());
  if (!list.length) return '';
  const ordered = inRows(list, direction || directionOf(list, script));
  const glue = script === 'latin' || script === 'korean' ? ' ' : '';
  return ordered
    .map((block) => (block.lines?.length ? block.lines : String(block.text).split('\n'))
      .map((line) => String(line).trim()).filter(Boolean).join(glue))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Which way a page's panels run, as far as the text on it says: right to
 * left where it is set in columns, left to right where it runs in lines.
 * A manga translated into English or Korean keeps its right-to-left panels
 * with its text in lines, which the text cannot tell -- the sheet has a
 * chip for that, remembered for the book.
 */
export function directionOf(blocks, script, lang = '') {
  if (String(lang).toLowerCase().startsWith('ja')) return 'rtl';
  const list = (blocks || []).filter((block) => String(block.text || '').trim());
  const cjk = script === 'japanese' || script === 'chinese';
  const columns = list.some((block) => block.vertical)
    || (cjk && list.length > 0 && list.filter((block) => block.h > block.w * 1.3).length > list.length / 2);
  return columns ? 'rtl' : 'ltr';
}

/* Rows of blocks -- blocks side by side, standing at about the same height
 * on the page -- top to bottom; each row across in the page's direction.
 * Right to left where the text is set in columns (manga, and Chinese set
 * the traditional way); left to right where it runs in lines (Korean
 * manhwa and webtoons, mainland manhua, English). Rows rather than a plain
 * sort by height, so two bubbles side by side are read across even when
 * one sits a little lower. */
function inRows(list, direction) {
  const rows = [];
  for (const block of [...list].sort((a, b) => a.y - b.y)) {
    const row = rows.find((r) => r.some((other) => {
      const overlap = Math.min(other.y + other.h, block.y + block.h) - Math.max(other.y, block.y);
      return overlap >= Math.min(other.h, block.h) / 3;
    }));
    if (row) row.push(block);
    else rows.push([block]);
  }
  return rows.flatMap((row) => row.sort(direction === 'rtl'
    ? (a, b) => (b.x + b.w) - (a.x + a.w)
    : (a, b) => a.x - b.x));
}

/**
 * Read a picture and say what it says.
 *
 * @param scripts  the scripts to try; the likeliest reading is kept
 * @returns { script, text, blocks, raw }: the text in the order the page
 *   itself suggests; blocks, to be put in another order if the reader says
 */
export async function readPicture(blob, scripts) {
  const read = await recognise(blob, scripts);
  const best = pickBest(read.results, scripts);
  if (!best) return { script: scripts[0], text: '', blocks: [], raw: '' };
  const raw = String(best.text || '').trim();
  return { script: best.script, blocks: best.blocks || [], raw, text: readingText(best.blocks, best.script) || raw };
}

/**
 * Part of a picture -- one speech bubble -- cut out and made larger.
 *
 * The recogniser works at a set size, so a bubble that is a tenth of a page
 * is read at a tenth of the detail; cut out, it is read at all of it. The
 * piece is enlarged until its longer side is about 1600 pixels and given a
 * white margin, which the recogniser finds lines against more readily than
 * against the edge of the picture.
 *
 * @param box  { x, y, w, h } as fractions of the picture
 */
export async function cropOf(blob, box, { longest = 1600, margin = 0.06 } = {}) {
  const bitmap = await createImageBitmap(blob);
  try {
    const sx = Math.max(0, Math.round(box.x * bitmap.width));
    const sy = Math.max(0, Math.round(box.y * bitmap.height));
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(box.w * bitmap.width)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(box.h * bitmap.height)));
    const scale = Math.max(1, Math.min(4, longest / Math.max(sw, sh)));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const pad = Math.round(Math.max(w, h) * margin);
    const canvas = document.createElement('canvas');
    canvas.width = w + pad * 2;
    canvas.height = h + pad * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, pad, pad, w, h);
    return await new Promise((resolve, reject) => canvas.toBlob(
      (out) => (out ? resolve(out) : reject(new Error('That part of the picture could not be cut out'))),
      'image/png'));
  } finally {
    bitmap.close?.();
  }
}
