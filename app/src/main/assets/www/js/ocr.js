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
  return orderedBlocks(blocks, script, { direction }).map((block) => block.joined).join('\n\n');
}

/**
 * The blocks in reading order, each with its text joined as the script
 * joins it (`joined`): one bubble, one piece of text, to be translated as
 * a whole and laid back over the bubble it came from.
 */
export function orderedBlocks(blocks, script, { direction = '' } = {}) {
  const list = (blocks || []).filter((block) => String(block.text || '').trim());
  if (!list.length) return [];
  const glue = script === 'latin' || script === 'korean' ? ' ' : '';
  const tidy = script === 'japanese' ? tidyJapanese : (text) => text;
  return inRows(list, direction || directionOf(list, script))
    .map((block) => ({
      ...block,
      joined: tidy((block.lines?.length ? block.lines : String(block.text).split('\n'))
        .map((line) => String(line).trim()).filter(Boolean).join(glue)),
    }))
    .filter((block) => block.joined);
}

/**
 * The recogniser's commonest slips in Japanese, put right from the
 * characters around them.
 *
 * - っ read as つ: before て, た or と inside a word (だつた, 強いつて,
 *   ちよつと), it is the small one nearly always -- って, った, っと. In a
 *   katakana word the same for ツ before a consonant.
 * - Kanji read as the katakana they look like: カ for 力, ロ for 口, エ for
 *   工, ニ for 二, ハ for 八 -- when they stand beside kanji and not inside
 *   a katakana word (身体能カ is 身体能力; ロボ stays).
 */
const KANA = '\u3041-\u3096\u30A1-\u30FA\u30FC';
const KATAKANA = /[\u30A1-\u30FA\u30FC\u30FB]/;
const KANJI = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
const LOOKALIKE = { 'カ': '力', 'ロ': '口', 'エ': '工', 'ニ': '二', 'ハ': '八' };

export function tidyJapanese(text) {
  let out = String(text || '')
    .replace(new RegExp(`(?<=[${KANA}\\u4E00-\\u9FFF])つ(?=[てたと])`, 'g'), 'っ')
    .replace(/(?<=[\u30A1-\u30FA])ツ(?=[カキクケコサシスセソタチテトパピプペポ])/g, 'ッ');
  const chars = [...out];
  for (let i = 0; i < chars.length; i++) {
    const kanji = LOOKALIKE[chars[i]];
    if (!kanji) continue;
    const before = chars[i - 1] || '';
    const after = chars[i + 1] || '';
    if (KATAKANA.test(before) || KATAKANA.test(after)) continue;
    if (KANJI.test(before) || KANJI.test(after)) chars[i] = kanji;
  }
  out = chars.join('');
  return out;
}

/**
 * Whether a block's text is text, and not the recogniser's muddle -- a
 * block of Japanese read badly comes out as stray Latin letters and digits,
 * and translated, that is nonsense laid over the picture. In Japanese,
 * Chinese and Korean, at least half of what is not space or punctuation
 * must be in the script.
 */
export function readable(text, script) {
  const chars = [...String(text || '')].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!chars.length) return false;
  if (script === 'latin') return true;
  const own = chars.filter((c) => /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(c)).length;
  return own >= chars.length * 0.5;
}

/** The language a script's text is in, as the translators name it. */
export function languageOf(script) {
  return { korean: 'ko', japanese: 'ja', chinese: 'zh' }[script] || '';
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
  if (!best) return { script: scripts[0], text: '', blocks: [], raw: '', width: read.width, height: read.height };
  const raw = String(best.text || '').trim();
  return {
    script: best.script,
    blocks: best.blocks || [],
    raw,
    text: readingText(best.blocks, best.script) || raw,
    // The size the boxes are measured against: the picture as it was read,
    // which for a very large one is a scaled-down copy.
    width: read.width,
    height: read.height,
  };
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

/**
 * The speech bubble a block of text sits in: the light inside of it, found
 * by spreading out from just around the text until the bubble's outline
 * stops the spread. A translation laid over the whole bubble has room that
 * one laid over the text alone does not -- English runs longer than the
 * Japanese it comes from, and a bubble of columns is narrow where its text
 * is but wide where it is drawn.
 *
 * Where the spread is not stopped on a side -- text on an open page, or
 * narration over the drawing -- that side keeps to the text, with a margin.
 *
 * @param lum    brightness, row by row, of the picture at the size it was read
 * @param block  { x, y, w, h }, at that size
 * @returns { x, y, w, h, round } -- round when the bubble is an oval rather
 *   than a box (it fills well under all of its bounding box)
 */
export function bubbleArea(lum, width, height, block, { light = 200 } = {}) {
  const bx = Math.max(0, Math.floor(block.x));
  const by = Math.max(0, Math.floor(block.y));
  const br = Math.min(width, Math.ceil(block.x + block.w));
  const bb = Math.min(height, Math.ceil(block.y + block.h));
  // A character's size: given, or the block's narrow side shared between
  // its lines (its columns, set vertically).
  const lines = Math.max(1, block.lines?.length || 1);
  const size = Math.max(4, block.size || Math.min(block.w, block.h) / lines);
  const fallback = () => {
    const pad = size * 0.3;
    const x = Math.max(0, bx - pad);
    const y = Math.max(0, by - pad);
    return { x, y, w: Math.min(width, br + pad) - x, h: Math.min(height, bb + pad) - y, round: false };
  };
  if (br <= bx || bb <= by) return fallback();
  // Looked for no further than this from the text.
  // A bubble hugs its text: a little wider and taller than the text, never
  // a panel's width of white beyond it.
  const across = block.w * 0.25 + size * 1.5;
  const down = block.h * 0.15 + size * 1.5;
  const wl = Math.max(0, Math.floor(bx - across));
  const wt = Math.max(0, Math.floor(by - down));
  const wr = Math.min(width, Math.ceil(br + across));
  const wb = Math.min(height, Math.ceil(bb + down));
  const ww = wr - wl;
  const seen = new Uint8Array(ww * (wb - wt));
  const stack = [];
  const push = (x, y) => {
    if (x < wl || x >= wr || y < wt || y >= wb) return;
    const i = (y - wt) * ww + (x - wl);
    if (seen[i] || lum[y * width + x] < light) return;
    seen[i] = 1;
    stack.push(x, y);
  };
  // Seeds: the ring just outside the text.
  const ring = 3;
  for (let x = bx - ring; x < br + ring; x++) { push(x, by - ring); push(x, bb + ring - 1); }
  for (let y = by - ring; y < bb + ring; y++) { push(bx - ring, y); push(br + ring - 1, y); }
  let count = 0;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const limit = ww * (wb - wt);
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    count++;
    if (x < l) l = x;
    if (x > r) r = x;
    if (y < t) t = y;
    if (y > b) b = y;
    if (count > limit) break;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  const textArea = (br - bx) * (bb - by);
  if (count < textArea * 0.15) return fallback();
  // Run out of room on any side, it is not a bubble but open page, or the
  // drawing's own white: the text keeps to itself, with a margin.
  if (l <= wl || t <= wt || r >= wr - 1 || b >= wb - 1) return fallback();
  const left = Math.min(bx, l + 1);
  const top = Math.min(by, t + 1);
  const right = Math.max(br, r);
  const bottom = Math.max(bb, b);
  const filled = count / Math.max(1, (r - l + 1) * (b - t + 1));
  return { x: left, y: top, w: right - left, h: bottom - top, round: filled < 0.88 };
}
