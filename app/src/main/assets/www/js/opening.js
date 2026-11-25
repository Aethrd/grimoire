/* The scene while a book opens -- and, faint, behind the queue's progress.
 *
 * Seen from above at an angle: a thick book open on a desk, a quill writing
 * its right page with letters drifting in to become the ink, gliding from
 * line to line (held as a right hand holds it, its plume to the top right),
 * travelling to the inkwell to dip into the ink and tap twice on the rim, a
 * loose drop falling back in each time, as the page turns over with its
 * writing on it; on the left a magic circle, dark four times in ten,
 * otherwise woken one way or another (shine, fluctuate, decay, erode, burn,
 * freeze) for a while. In the theme's gradient, on the app's own dark ground.
 *
 * Nothing flashes: no fade is quicker than a second, nothing reaches full
 * brightness but a finished line for a moment, and the ground never changes.
 * With the phone's reduced motion on, nothing travels or turns: the quill
 * rests in the well, lines appear one at a time, and the circle only glows.
 *
 * playScene(canvas, { faint, glyphs, letters }) starts it on a canvas; the
 * returned stop() ends it. Faint: drawn at half the frame rate, for behind the
 * queue. Letters: the drifting letters to draw from (letterMix below), or a
 * promise of them -- until it comes, the mix as it always was.
 */

/* ── the letters' mix: the library's own writing ─────────────────────────
 * A library mostly in Hangul drifts mostly Hangul; one with little English
 * little Latin -- unless French, German or the like are there, which are
 * Latin letters too (with their accents). Each book counts once, and its
 * writing is told from its title (with its author and series) and from the
 * language it says it is in, however it says it: "ko", "kr", "kor",
 * "Korean", "한국어", "ko-KR"... or not at all. */
const WRITINGS = {
  hangul: { test: /[가-힯ᄀ-ᇿ㄰-㆏]/u, sample: '이야기책장글월말빛꿈별길마음' },
  kana: { test: /[぀-ヿㇰ-ㇿｦ-ﾟ]/u, sample: 'あかさたなはまやらわのをアカサタナ' },
  han: { test: /[一-鿿㐀-䶿豈-﫿]/u, sample: '文書章話物語字筆墨紙卷' },
  cyrillic: { test: /[Ѐ-ӿ]/u, sample: 'абвгдежзиклмнопрстуфя' },
  greek: { test: /[Ͱ-Ͽ]/u, sample: 'αβγδεζηθλμξπσφψω' },
  arabic: { test: /[؀-ۿ]/u, sample: 'ابتثجحدرسصطعفقكلمنهوي' },
  hebrew: { test: /[֐-׿]/u, sample: 'אבגדהוזחטיכלמנסעפצקרשת' },
  thai: { test: /[฀-๿]/u, sample: 'กขคงจฉชซญดตถทนบปผพฟมยรลวสหอฮ' },
  devanagari: { test: /[ऀ-ॿ]/u, sample: 'अआइउएकखगचजटडतदनपबमयरलवसह' },
  latin: { test: /[A-Za-z]/, sample: 'Abcdefghijkmnoprstuvwy' },
  accented: { test: /[À-ɏ]/u, sample: 'éèàçùâêîôûëïüœæßñöäåøíóú' },
};
// A language as a book may give it -- code, English name or its own -- to the writing it is in.
const SPOKEN = [
  ['hangul', 'ko kr kor korean 한국어 한국말 한글 조선어 조선말'],
  ['japanese', 'ja jp jpn japanese nihongo 日本語 にほんご'],
  ['han', 'zh cn chi zho chinese mandarin cantonese tw hk 中文 汉语 漢語 华语 華語 国语 國語 普通话 简体中文 繁體中文 繁体中文'],
  ['cyrillic', 'ru rus russian русский ukr ukrainian українська bg bul bulgarian български sr srp serbian српски mk mkd macedonian be bel belarusian kk kaz kazakh mn mon mongolian'],
  ['greek', 'el ell gre gr greek ελληνικά'],
  ['arabic', 'ar ara arabic العربية fa fas per persian farsi فارسی ur urd urdu'],
  ['hebrew', 'he heb iw hebrew עברית'],
  ['thai', 'th tha thai ไทย'],
  ['devanagari', 'hi hin hindi हिन्दी हिंदी mr marathi ne nepali'],
  ['latin', 'en eng english us gb'],
  ['accented', 'fr fre fra french français francais de ger deu german deutsch es spa spanish español espanol castellano it ita italian italiano pt por portuguese português portugues br nl dut nld dutch nederlands id ind indonesian bahasa ms msa malay vi vie vietnamese tr tur turkish türkçe pl pol polish polski sv swe swedish svenska no nor nb nob nn norwegian norsk da dan danish dansk fi fin finnish suomi cs ces cze czech čeština ro ron rum romanian română hu hun hungarian magyar ca cat catalan català tl fil filipino tagalog la lat latin is isl icelandic hr hrv croatian hrvatski sk slk slovak sl slv slovenian et est estonian lv lav latvian lt lit lithuanian'],
];
const SPOKEN_AS = new Map(SPOKEN.flatMap(([writing, names]) => names.split(' ').map((name) => [name, writing])));
SPOKEN_AS.set('tiếng việt', 'accented').set('tieng viet', 'accented');
// Read as a writing: a Japanese book is kana among kanji; French, Latin letters with an accent here and there.
const READ_AS = { japanese: { kana: 0.55, han: 0.45 }, accented: { latin: 0.75, accented: 0.25 } };
const asBuckets = (writing) => READ_AS[writing] || { [writing]: 1 };
const LATINISH = new Set(['latin', 'accented']);
const CJK = new Set(['hangul', 'japanese', 'han']);
// A short code is only taken from a tag when it is one of these: "id", "it", "cat", "fin" are words too.
const TAG_CODES = new Set(['ko', 'kr', 'ja', 'jp', 'zh', 'cn']);

/** The writing a language is in, from however it is given; null when it cannot be told ("und", "uk" -- Ukrainian or British?). */
export function spokenWriting(lang, { strict = false } = {}) {
  const said = String(lang ?? '').normalize('NFC').trim().toLowerCase();
  if (!said || said === 'und' || said === 'mul' || said === 'zxx') return null;
  if (SPOKEN_AS.has(said)) {
    if (strict && /^[a-z]{1,3}$/.test(said) && !TAG_CODES.has(said)) return null;
    return SPOKEN_AS.get(said);
  }
  if (strict) return null;
  // "ko-KR", "zh_TW", "pt-BR", "Korean (South Korea)", "English; Korean": the first part that says.
  for (const part of said.split(/[\s\-_/,;:().|]+/)) if (SPOKEN_AS.has(part)) return SPOKEN_AS.get(part);
  return null;
}

/** What a book is written in, as shares of the writings ({ hangul: 1 }, { latin: .5, hangul: .5 }), or null when nothing tells. */
export function writingOfBook(book) {
  if (!book) return null;
  const text = [book.title, book.author, book.series].filter((part) => typeof part === 'string').join(' ');
  const count = (writing) => (text.match(new RegExp(WRITINGS[writing].test.source, 'gu')) || []).length;
  const latin = count('latin') + count('accented');
  let seen = null;
  const kana = count('kana');
  if (kana && kana >= count('hangul')) seen = 'japanese';
  else {
    let most = 0;
    for (const writing of Object.keys(WRITINGS)) {
      if (LATINISH.has(writing) || writing === 'kana') continue;
      const n = count(writing);
      if (n > most) { most = n; seen = writing; }
    }
    // Mostly Latin, a word of something else in it: Latin.
    if (seen && latin > most * 2) seen = null;
  }
  if (!seen && latin) seen = count('accented') ? 'accented' : 'latin';
  let said = spokenWriting(book.lang);
  if (!said && Array.isArray(book.tags)) for (const tag of book.tags) { said = spokenWriting(tag, { strict: true }); if (said) break; }
  if (!said || said === seen) return seen ? asBuckets(seen) : null;
  if (!seen) return asBuckets(said);
  // Han characters in a book that says Japanese or Korean: that language. Kana or Hangul seen: what is seen.
  if (CJK.has(seen) && CJK.has(said)) return asBuckets(seen === 'han' ? said : seen);
  // Latin both: the accents, if either has them.
  if (LATINISH.has(seen) && LATINISH.has(said)) return asBuckets('accented');
  // A Latin title on a book that says Korean (or the like): its words may be either -- half each.
  if (LATINISH.has(seen)) {
    const half = {};
    for (const [bucket, n] of Object.entries(asBuckets(seen))) half[bucket] = (half[bucket] || 0) + n / 2;
    for (const [bucket, n] of Object.entries(asBuckets(said))) half[bucket] = (half[bucket] || 0) + n / 2;
    return half;
  }
  // Characters that are not Latin, whatever the book says (a scraped EPUB's "en" on a Korean title): the characters.
  return asBuckets(seen);
}

// The mix as it always was, and a little of it kept in any library so every writing still turns up now and then.
const BEFORE = { hangul: 0.3, han: 0.2, kana: 0.13, latin: 0.37 };
const KEEP_BEFORE = 0.08;
const SLOTS = 120;
const FROM_TITLES = 80;

/** The letters to drift, in the library's proportions: an array of characters, the open book's title among them. */
export function letterMix(books = [], { title = '' } = {}) {
  const share = {};
  const seenChars = {};
  let counted = 0;
  for (const book of Array.isArray(books) ? books : []) {
    if (!book || book.binnedAt || book.importing || book.transient) continue;
    const writing = writingOfBook(book);
    if (!writing) continue;
    counted += 1;
    for (const [bucket, n] of Object.entries(writing)) share[bucket] = (share[bucket] || 0) + n;
    // Its own characters, to drift as well as the usual few.
    for (const ch of Array.from(String(book.title || ''))) {
      for (const bucket of Object.keys(writing)) {
        if (!WRITINGS[bucket].test.test(ch)) continue;
        const set = (seenChars[bucket] ||= new Set());
        if (set.size < FROM_TITLES) set.add(ch);
      }
    }
  }
  const pool = [];
  for (const bucket of Object.keys(WRITINGS)) {
    const part = counted ? (1 - KEEP_BEFORE) * ((share[bucket] || 0) / counted) + KEEP_BEFORE * (BEFORE[bucket] || 0) : (BEFORE[bucket] || 0);
    const slots = Math.round(part * SLOTS);
    if (!slots) continue;
    const chars = [...new Set([...Array.from(WRITINGS[bucket].sample), ...(seenChars[bucket] || [])])];
    // Spread across all of them, the library's own as well as the usual few.
    for (let i = 0; i < slots; i += 1) pool.push(chars[Math.floor((i * chars.length) / slots) % chars.length]);
  }
  // The open book's title, each of its letters once, as it always was.
  for (const ch of Array.from(String(title || '').replace(/\s+/g, '')).slice(0, 40)) pool.push(ch);
  return pool.length ? pool : Array.from(WRITINGS.latin.sample);
}

export function playScene(canvas, { faint = false, glyphs = '', letters: lettersFrom = null } = {}) {
  // Caught at once, so letters that fail never go unanswered -- even where nothing is drawn.
  const lettersReady = Promise.resolve(lettersFrom).catch(() => null);
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let calm = !!reduceQuery?.matches;
  let probe = null;
  try { probe = canvas?.getContext?.('2d') || null; } catch { probe = null; }
  if (!probe || typeof requestAnimationFrame !== 'function') return { stop() {} };

  const hexToRgb = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const WARM = [226, 140, 96];
  const COOL = [164, 200, 236];

  let ctx, W, H;
  function fit() {
    const box = canvas.getBoundingClientRect();
    /* Faint (under 40%), drawn at one pixel to the CSS pixel: at that strength
     * it looks the same, and is a quarter of the pixels on a phone's screen.
     * Stronger, as sharp as the screen. */
    const dpr = faint ? 1 : Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = box.width; H = box.height;
  }
  fit();

  /* ── the camera: above the desk, looking down at an angle ──────────────
   * The desk is z = 0; x runs right, y away from the reader, z up. Seen
   * from above and in front, tipped back PITCH from straight down: the far
   * end of the book a little smaller than the near, as a book on a desk is. */
  const PITCH = 0.62;
  const sinP = Math.sin(PITCH), cosP = Math.cos(PITCH);
  let D = 1000, CX = 0, CY = 0, S = 1;
  function camera() { D = 1000; CX = W / 2; CY = H * 0.42; S = Math.min(W / 400, H / 560, 1.25); }
  camera();
  function P(x, y, z) {
    const depth = D + y * sinP - z * cosP;
    const k = (D / depth) * S;
    return { x: CX + x * k, y: CY - (y * cosP + z * sinP) * k };
  }

  /* ── the book ──────────────────────────────────────────────────────────
   * Two blocks of pages, PW wide and PH deep, T thick, on boards a little
   * larger. A page rises from the spine and flattens towards its edge. */
  const PW = 150, PH = 200, T = 16, BOARD = 3, LIP = 7;
  const rise = (u) => {
    const a = Math.min(1, u / 0.32);
    return T + 9 * (1 - (1 - a) * (1 - a)) - 3.2 * Math.max(0, u - 0.32);
  };
  // A point on a page, its page's own terms: u from the spine (0) to the edge (1), v from the top (0) to the foot (1).
  const onRight = (u, v, lift = 0) => P(u * PW, PH / 2 - v * PH, rise(u) + 0.3 + lift);
  const onLeft = (u, v, lift = 0) => P(-u * PW, PH / 2 - v * PH, rise(u) + 0.3 + lift);
  const world = { right: (u, v, lift = 0) => ({ x: u * PW, y: PH / 2 - v * PH, z: rise(u) + 0.3 + lift }) };


  function path(points, close = true) {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
  }

  // The top of one block of pages, as a strip of points (side: -1 left, 1 right).
  function pageOutline(side) {
    const top = [], foot = [];
    for (let i = 0; i <= 16; i += 1) {
      const u = i / 16;
      top.push(P(side * u * PW, PH / 2, rise(u)));
      foot.push(P(side * u * PW, -PH / 2, rise(u)));
    }
    return top.concat(foot.reverse());
  }

  function drawBook() {
    // The shadow it casts on the desk, soft.
    const sc = P(0, -6, 0);
    const shadow = ctx.createRadialGradient(sc.x, sc.y, 10, sc.x, sc.y, PW * 1.35 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,.42)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    path([P(-PW - 26, -PH / 2 - 22, 0), P(PW + 26, -PH / 2 - 22, 0), P(PW + 26, PH / 2 + 12, 0), P(-PW - 26, PH / 2 + 12, 0)]);
    ctx.fill();

    // The boards: the cover under each block, a little larger, with its front edge.
    for (const side of [-1, 1]) {
      const x0 = 0, x1 = side * (PW + LIP);
      const top = [P(x0, PH / 2 + LIP, BOARD), P(x1, PH / 2 + LIP, BOARD), P(x1, -PH / 2 - LIP, BOARD), P(x0, -PH / 2 - LIP, BOARD)];
      ctx.fillStyle = '#2a2026';
      path(top); ctx.fill();
      ctx.fillStyle = '#1f181d';
      path([P(x0, -PH / 2 - LIP, BOARD), P(x1, -PH / 2 - LIP, BOARD), P(x1, -PH / 2 - LIP, 0), P(x0, -PH / 2 - LIP, 0)]); ctx.fill();
    }

    // The near edge of each block: its pages, layer on layer.
    for (const side of [-1, 1]) {
      const edge = [];
      for (let i = 0; i <= 16; i += 1) edge.push(P(side * (i / 16) * PW, -PH / 2, rise(i / 16)));
      const base = [P(side * PW, -PH / 2, BOARD), P(0, -PH / 2, BOARD)];
      const g = ctx.createLinearGradient(0, base[0].y, 0, edge[8].y);
      g.addColorStop(0, '#2a262b');
      g.addColorStop(1, '#3a353a');
      ctx.fillStyle = g;
      path(edge.concat(base)); ctx.fill();
      ctx.lineWidth = 0.5;
      for (let k = 1; k < 9; k += 1) {
        const f = k / 9;
        ctx.strokeStyle = `rgba(0,0,0,${0.08 + 0.03 * (k % 2)})`;
        const line = [];
        for (let i = 0; i <= 16; i += 1) { const u = i / 16; line.push(P(side * u * PW, -PH / 2, lerp(BOARD, rise(u), f))); }
        path(line, false); ctx.stroke();
      }
    }

    // The two pages: soft paper, darker into the spine, a fall of light across.
    for (const side of [-1, 1]) {
      const outline = pageOutline(side);
      const spine = P(0, 0, rise(0)), edge = P(side * PW, 0, rise(1));
      const g = ctx.createLinearGradient(spine.x, spine.y, edge.x, edge.y);
      g.addColorStop(0, '#2c282e');
      g.addColorStop(0.16, '#3b363c');
      g.addColorStop(0.62, '#3f3a40');
      g.addColorStop(1, '#3a353b');
      ctx.fillStyle = g;
      path(outline); ctx.fill();
      ctx.save();
      path(outline); ctx.clip();
      // Plain paper: one soft tone, a gentle fall of light -- no grain.
      const mid = P(side * PW * 0.55, 0, rise(0.55));
      const v = ctx.createRadialGradient(mid.x, mid.y, 10, mid.x, mid.y, PW * 0.95 * S);
      v.addColorStop(0, 'rgba(255,240,235,0.025)');
      v.addColorStop(1, 'rgba(0,0,0,0.1)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    // The fold, in shadow.
    const fold = ctx.createLinearGradient(P(-12, 0, T).x, 0, P(12, 0, T).x, 0);
    fold.addColorStop(0, 'rgba(0,0,0,0)');
    fold.addColorStop(0.5, 'rgba(0,0,0,.32)');
    fold.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fold;
    path([P(-12, PH / 2, rise(0.08)), P(12, PH / 2, rise(0.08)), P(12, -PH / 2, rise(0.08)), P(-12, -PH / 2, rise(0.08))]);
    ctx.fill();
  }

  /* ── the writing ─────────────────────────────────────────────────────── */
  const ROWS = 7;
  const WRITE_SPEED = 37.5;   // points a second: a quarter faster than before
  function lineShape(row) {
    const pts = [];
    const len = 0.66 + Math.random() * 0.12;
    const seed = Math.random() * 10;
    for (let i = 0; i <= 64; i += 1) {
      const k = i / 64;
      pts.push([0.13 + k * len + Math.cos(k * 40 + seed) * 0.006,
        0.14 + row * 0.11 + Math.sin(k * 40 + seed) * 0.013 * (0.6 + 0.4 * Math.sin(k * 9 + seed))]);
    }
    return { pts, drawn: 0, doneAt: null };
  }
  function strokeLines(lines, place, alpha, from, to, now, live) {
    for (const line of lines) {
      const upto = Math.floor(line.drawn);
      if (upto < 2 || alpha <= 0.01) continue;
      let a = 0.5;
      if (line.doneAt && live) {
        const since = (now - line.doneAt) / 1000;
        a = since < 0.7 ? 0.5 + 0.24 * ease(since / 0.7) : 0.74 - 0.28 * ease(clamp((since - 0.7) / 1.6));
      } else if (!live) a = 0.46;
      const p0 = place(...line.pts[0]), p1 = place(...line.pts[line.pts.length - 1]);
      const g = ctx.createLinearGradient(p0.x, p0.y, p1.x + 0.01, p1.y);
      g.addColorStop(0, rgba(from, a * alpha));
      g.addColorStop(1, rgba(to, a * alpha));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.25 * S;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < upto; i += 1) { const p = place(...line.pts[i]); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.stroke();
    }
  }

  /* ── the magic circle ────────────────────────────────────────────────
   * Drawn new for each page that lands on the left: rings, a star, rune
   * marks round the band, small circles at the star's points. Four times in
   * ten it lies dark; otherwise one effect takes it, at random, for a while. */
  const EFFECTS = ['shine', 'fluctuate', 'decay', 'erode', 'burn', 'freeze'];
  const rollEffect = () => (Math.random() < 0.4 ? 'dark' : EFFECTS[Math.floor(Math.random() * EFFECTS.length)]);
  /* Rune-like marks, drawn in a unit box: x across, y up (y=1 the top). Each is
   * a few strokes, none of them a real alphabet's letter. */
  const GLYPHS = [
    [[[0, -1], [0, 1]], [[0, 0.5], [0.6, 1]], [[0, 0], [0.6, 0.5]]],
    [[[0, -1], [0, 1]], [[-0.6, 1], [0, 0.3], [0.6, 1]]],
    [[[-0.6, -1], [0.6, 1]], [[-0.6, 1], [0.6, -1]]],
    [[[0, -1], [0, 1]], [[-0.5, 0.4], [0, 1], [0.5, 0.4]]],
    [[[-0.6, -1], [0, -0.2], [0.6, -1]], [[0, -0.2], [-0.55, 0.4], [0, 1], [0.55, 0.4], [0, -0.2]]],
    [[[-0.6, -1], [-0.6, 1], [0.6, -1], [0.6, 1], [-0.6, -1]]],
    [[[0, -1], [0, 1], [0.6, 0.6], [0, 0.15], [0.6, -1]]],
    [[[-0.6, -1], [-0.6, 1]], [[0.6, -1], [0.6, 1]], [[-0.6, 1], [0.6, 0]], [[0.6, 1], [-0.6, 0]]],
    [[[-0.6, -0.9], [0, 1], [0.6, -0.9], [-0.6, -0.9]]],
    [[[0.6, 1], [-0.4, 1], [-0.6, 0.6], [0.5, -0.2], [0.6, -0.7], [-0.6, -1]]],
    [[[-0.6, 0], [0.6, 0]], [[0, -1], [0, 1]], [[-0.4, 1], [0.4, 1]]],
    [[[0, 1], [0, -1]], [[-0.6, -0.4], [0, 0.2], [0.6, -0.4]], [[-0.3, 1], [0.3, 1]]],
  ];

  /* Each circle drawn new from parts chosen at random -- a rim (plain, spiked,
   * crescented, or broken by great glyphs), bands of runes or close script, a
   * figure (a star of any count, nested polygons, spokes, a hexagram, petals,
   * or small circles in orbit, each a circle of its own), points at its
   * corners and something at its heart -- so no two pages carry the same one. */
  function newCircle() {
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const chance = (p) => Math.random() < p;
    const TAU = Math.PI * 2;
    const segs = [], widths = [];
    const add = (seg, w = 1) => { segs.push(seg); widths.push(w); };
    const ring = (r, n = 72, from = 0, to = TAU, cx = 0, cy = 0) => {
      const out = [];
      for (let i = 0; i <= n; i += 1) { const a = lerp(from, to, i / n); out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
      return out;
    };
    const polygon = (r, n, spin, step = 1, cx = 0, cy = 0) => {
      const out = [];
      for (let i = 0; i <= n; i += 1) { const a = spin + ((i * step) % n) / n * TAU; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
      return out;
    };
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    // A star {n/step}: one line where the count allows, else as many as it takes.
    const star = (r, n, step, spin, cx = 0, cy = 0, w = 1) => {
      const parts = gcd(n, step), m = n / parts;
      for (let p = 0; p < parts; p += 1) add(polygon(r, m, spin + (p / n) * TAU, step / parts, cx, cy), w);
    };
    // A glyph centred at (cx, cy), its "up" along angle `up`, `h` its half-height.
    const glyph = (cx, cy, h, up, kind = Math.floor(Math.random() * GLYPHS.length), w = 1) => {
      const ux = Math.cos(up), uy = Math.sin(up), tx = -uy, ty = ux;
      for (const stroke of GLYPHS[kind]) add(stroke.map(([gx, gy]) => [cx + (tx * gx + ux * gy) * h, cy + (ty * gx + uy * gy) * h]), w);
    };
    // Glyphs set round a ring, upright to it.
    const writeRound = (r, h, count, spin, w) => {
      for (let i = 0; i < count; i += 1) {
        const a = spin + (i / count) * TAU;
        glyph(Math.cos(a) * r, Math.sin(a) * r, h, a, undefined, w);
      }
    };

    const spin = Math.random() * TAU;
    const rim = pick(['plain', 'plain', 'spiked', 'crescents', 'broken']);
    const R = rim === 'plain' ? rand(0.32, 0.39) : rand(0.29, 0.34);   // in page widths

    // The rim.
    if (rim === 'broken') {
      // The outer ring in arcs, a great glyph standing in each gap.
      const n = pick([5, 6, 7, 8]), gap = 0.32 / n * Math.PI;
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU;
        add(ring(R, 14, a + gap, a + TAU / n - gap), 1.3);
        glyph(Math.cos(a) * R, Math.sin(a) * R, R * 0.09, a, undefined, 1.3);
      }
    } else add(ring(R), rim === 'plain' ? 1.2 : 1);
    if (rim === 'spiked') {
      // Points outward: great ones at the quarters, lesser between, a diamond in each.
      const n = pick([8, 12, 16]);
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU, major = i % (n / 4) === 0;
        const len = major ? R * 0.26 : R * 0.12, half = major ? 0.09 : 0.06;
        const at = (r, da) => [Math.cos(a + da) * r, Math.sin(a + da) * r];
        add([at(R, -half), at(R + len, 0), at(R, half)]);
        if (major) add([at(R + len * 0.15, 0), at(R + len * 0.4, -half * 0.35), at(R + len * 0.65, 0), at(R + len * 0.4, half * 0.35), at(R + len * 0.15, 0)], 0.8);
      }
      if (chance(0.6)) for (let i = 0; i < n * 3; i += 1) { const a = spin + ((i + 0.5) / (n * 3)) * TAU; add(ring(R * 0.008, 6, 0, TAU, Math.cos(a) * R * 1.05, Math.sin(a) * R * 1.05), 0.8); }
    } else if (rim === 'crescents') {
      const n = pick([8, 10, 12]);
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU, cx = Math.cos(a) * R * 1.07, cy = Math.sin(a) * R * 1.07, cr = R * 0.05;
        add(ring(cr, 16, a + 0.5, a + TAU - 0.5, cx, cy), 0.9);
        add(ring(cr * 0.8, 14, a + 1.1, a + TAU - 1.1, cx + Math.cos(a) * cr * 0.4, cy + Math.sin(a) * cr * 0.4), 0.9);
      }
    }
    if (rim !== 'broken' && chance(0.45)) {
      const n = pick([24, 36, 48, 60]);
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * TAU, l = R * (i % 4 === 0 ? 0.07 : 0.035);
        add([[Math.cos(a) * R, Math.sin(a) * R], [Math.cos(a) * (R - l), Math.sin(a) * (R - l)]], 0.7);
      }
    }

    // The band(s): runes, close script, dots, ticks, or none; sometimes two bands.
    let outer = R;
    const bands = chance(0.3) ? 2 : 1;
    for (let k = 0; k < bands; k += 1) {
      const width = R * (k === 0 ? rand(0.12, 0.2) : rand(0.08, 0.12));
      const inner = outer - width;
      add(ring(inner), k === 0 ? 1 : 0.8);
      const mid = outer - width / 2, h = width * 0.3;
      const fill = pick(['runes', 'script', 'script', 'dots', 'ticks', 'none']);
      if (fill === 'runes') writeRound(mid, h, 10 + Math.floor(Math.random() * 10), spin, 0.9);
      else if (fill === 'script') writeRound(mid, h * 0.75, Math.floor(TAU * mid / (h * 1.9)), spin + k, 0.6);
      else if (fill === 'dots') {
        const n = 16 + Math.floor(Math.random() * 20);
        for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add(ring(h * (i % 3 === 0 ? 0.5 : 0.28), 10, 0, TAU, Math.cos(a) * mid, Math.sin(a) * mid), 0.7); }
      } else if (fill === 'ticks') {
        const n = 24 + Math.floor(Math.random() * 24);
        for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add([[Math.cos(a) * (mid - h), Math.sin(a) * (mid - h)], [Math.cos(a) * (mid + h), Math.sin(a) * (mid + h)]], 0.7); }
      }
      outer = inner;
      if (k === 0 && bands === 2) { outer -= R * 0.04; add(ring(outer), 0.7); }
    }
    if (chance(0.35)) add(ring(outer * rand(0.55, 0.7), 60), 0.8);

    // The figure, inside the bands.
    const space = outer * rand(0.94, 0.99);
    const figure = pick(['star', 'star', 'nested', 'spokes', 'hexagram', 'petals', 'orbit', 'orbit']);
    let points = [];
    if (figure === 'star') {
      const n = pick([5, 6, 7, 8, 9, 10, 12]);
      const steps = [];
      for (let k = 2; k < n / 2; k += 1) steps.push(k);
      star(space, n, steps.length ? pick(steps) : 2, spin);
      if (chance(0.4)) add(polygon(space, n, spin), 0.8);
      points = polygon(space, n, spin).slice(0, n);
    } else if (figure === 'nested') {
      const n = pick([3, 4, 5, 6, 8]), count = 2 + Math.floor(Math.random() * 2);
      for (let k = 0; k < count; k += 1) add(polygon(space * Math.pow(Math.cos(Math.PI / n), k), n, spin + k * Math.PI / n));
      points = polygon(space, n, spin).slice(0, n);
    } else if (figure === 'spokes') {
      const n = pick([6, 8, 12, 16]);
      for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add([[Math.cos(a) * space * 0.22, Math.sin(a) * space * 0.22], [Math.cos(a) * space, Math.sin(a) * space]], 0.8); }
      add(polygon(space * 0.7, n, spin + Math.PI / n));
      points = polygon(space, n, spin).slice(0, n).filter((_, i) => i % 2 === 0);
    } else if (figure === 'hexagram') {
      add(polygon(space, 3, spin)); add(polygon(space, 3, spin + Math.PI / 3));
      add(ring(space * 0.5, 48), 0.9);
      if (chance(0.5)) { add(polygon(space * 0.5, 3, spin + Math.PI), 0.8); add(polygon(space * 0.5, 3, spin), 0.8); }
      points = polygon(space, 6, spin).slice(0, 6);
    } else if (figure === 'petals') {
      // Lens-shaped petals out from the middle, sometimes a lesser set between.
      const n = pick([4, 5, 6, 8]);
      const petal = (a, r0, r1, wide, w) => {
        const one = [], back = [];
        for (let i = 0; i <= 14; i += 1) {
          const t = i / 14, r = lerp(r0, r1, t), off = Math.sin(t * Math.PI) * wide;
          const x = Math.cos(a) * r, y = Math.sin(a) * r, nx = -Math.sin(a), ny = Math.cos(a);
          one.push([x + nx * off, y + ny * off]); back.unshift([x - nx * off, y - ny * off]);
        }
        add(one.concat(back), w);
      };
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU;
        petal(a, space * 0.12, space * 0.96, space * rand(0.16, 0.22), 1);
        if (chance(0.7)) add(ring(space * 0.08, 20, 0, TAU, Math.cos(a) * space * 0.55, Math.sin(a) * space * 0.55), 0.8);
      }
      if (chance(0.5)) for (let i = 0; i < n; i += 1) petal(spin + ((i + 0.5) / n) * TAU, space * 0.3, space * 0.75, space * 0.08, 0.7);
      points = polygon(space, n, spin).slice(0, n);
    } else {
      // Circles in orbit, each a little circle of its own, joined by a figure.
      const n = pick([3, 4, 5, 6]);
      const sr = space * (n <= 4 ? rand(0.2, 0.26) : rand(0.15, 0.19));
      const orbit = space - sr * 1.05;
      const centres = polygon(orbit, n, spin).slice(0, n);
      add(polygon(orbit, n, spin), 0.9);
      if (chance(0.5)) add(ring(orbit, 72), 0.6);
      if (n >= 5 && chance(0.6)) star(orbit, n, 2, spin, 0, 0, 0.7);
      for (const [cx, cy] of centres) {
        add(ring(sr, 40, 0, TAU, cx, cy));
        const inside = pick(['star', 'ring', 'glyph', 'script']);
        if (inside === 'star') { const m = pick([5, 6, 7, 8]); star(sr * 0.85, m, m === 6 ? 2 : Math.floor((m - 1) / 2), Math.random() * TAU, cx, cy, 0.7); }
        else if (inside === 'ring') { add(ring(sr * 0.62, 28, 0, TAU, cx, cy), 0.8); add(ring(sr * 0.2, 12, 0, TAU, cx, cy), 0.8); }
        else if (inside === 'glyph') glyph(cx, cy, sr * 0.5, Math.atan2(cy, cx), undefined, 1);
        else {
          add(ring(sr * 0.72, 32, 0, TAU, cx, cy), 0.6);
          const m = 9 + Math.floor(Math.random() * 5);
          for (let i = 0; i < m; i += 1) { const a = (i / m) * TAU; glyph(cx + Math.cos(a) * sr * 0.86, cy + Math.sin(a) * sr * 0.86, sr * 0.09, a, undefined, 0.5); }
        }
      }
      if (chance(0.5)) add(polygon(space * 0.98, 3, spin + Math.PI / n + Math.random()), 0.8);   // a great triangle across
    }

    // At its points: small circles (sometimes with a mark), diamonds, or nothing.
    const satellite = figure === 'orbit' ? 'none' : pick(['circle', 'circle', 'diamond', 'none']);
    const pr = R * rand(0.05, 0.085);
    for (const [px, py] of satellite === 'none' ? [] : points) {
      if (satellite === 'circle') { add(ring(pr, 18, 0, TAU, px, py), 0.9); if (chance(0.5)) glyph(px, py, pr * 0.55, Math.atan2(py, px), undefined, 0.6); }
      else add(polygon(pr, 4, Math.atan2(py, px), 1, px, py), 0.9);
    }

    // Its heart.
    const heart = pick(['ring', 'crescent', 'dot', 'star', 'glyph', 'rings', 'none']);
    const hr = R * rand(0.09, 0.16);
    if (heart === 'ring') { add(ring(hr, 36)); add(ring(hr * 0.55, 24), 0.8); }
    else if (heart === 'crescent') { add(ring(hr, 36, 0.4, TAU - 0.4)); add(ring(hr * 0.8, 30, 0.9, TAU - 0.9, hr * 0.35, 0)); }
    else if (heart === 'dot') add(ring(hr * 0.22, 12));
    else if (heart === 'star') star(hr, 5, 2, spin);
    else if (heart === 'glyph') { add(ring(hr * 1.1, 36), 0.8); glyph(0, 0, hr * 0.7, -Math.PI / 2); }
    else if (heart === 'rings') for (let k = 1; k <= 3; k += 1) add(ring(hr * k / 3, 18 + k * 8), 0.7);
    // A few arcs inside the band, sometimes.
    if (chance(0.3)) {
      const n = pick([3, 4, 6]);
      for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add(ring(outer * 0.93, 16, a + 0.15, a + TAU / n - 0.15), 0.7); }
    }
    return {
      segs, widths, seeds: segs.map(() => Math.random()),
      effect: rollEffect(), was: 'dark', wasT: 0, blend: 1, since: 0, next: rand(5, 9),
      embers: [], frost: segs.slice(0, 2).flatMap((one) => one.filter((_, i) => i % 6 === 0).map((p) => ({ p, len: 0, max: rand(0.015, 0.04) }))),
    };
  }

  // A point of the circle on a page: local (a, b) in page widths, centred on the page.
  const circlePoint = (place, a, b) => place(0.5 + a, 0.5 + b * (PW / PH));

  function effectLook(name, c, seed, now, t) {
    // { alpha, colour mix (warm/cool), width, rotation, scale, gap } for one segment.
    const look = { alpha: 0.2, warm: 0, cool: 0, width: 1, rot: 0, scale: 1, keep: 1 };
    switch (name) {
      case 'dark': look.alpha = 0.16; break;
      case 'shine': look.alpha = 0.3 + 0.32 * (0.5 - 0.5 * Math.cos(t * 1.4)); look.width = 1.2; break;
      case 'fluctuate':
        look.alpha = 0.32 + 0.14 * Math.sin(now / 900 + seed * 6);
        look.rot = Math.sin(now / 2600) * 0.08;
        look.scale = 1 + Math.sin(now / 1700) * 0.025;
        break;
      case 'decay': look.alpha = Math.max(0.05, 0.42 - t * (0.06 + seed * 0.12)); break;
      case 'erode': look.alpha = 0.36; look.keep = clamp(1 - t * (0.05 + seed * 0.08), 0.15, 1); break;
      case 'burn': look.alpha = 0.4 + 0.08 * Math.sin(now / 300 + seed * 9); look.warm = clamp(t / 2); break;
      case 'freeze': look.alpha = 0.36; look.cool = clamp(t / 2.5); break;
      default: break;
    }
    return look;
  }

  function drawCircle(c, place, fade, from, to, now, dt) {
    if (!c || fade <= 0.01) return;
    c.since += dt;
    if (!calm && c.since > c.next) {
      // Handed over from exactly where the last effect was, so nothing jumps.
      c.was = c.effect; c.wasT = c.since; c.effect = rollEffect(); c.blend = 0; c.since = 0; c.next = rand(5, 9);
      c.embers.length = 0; c.frost.forEach((f) => { f.len = 0; });
    }
    if (calm && c.effect !== 'dark' && c.effect !== 'shine') { c.was = c.effect; c.wasT = c.since; c.effect = 'shine'; c.blend = 0; }
    c.blend = Math.min(1, c.blend + dt / 1.4);
    const t = c.since;
    c.segs.forEach((seg, si) => {
      const seed = c.seeds[si];
      const a = effectLook(c.effect, c, seed, now, t);
      const b = effectLook(c.was, c, seed, now, c.wasT || 0);
      const k = ease(c.blend);
      const alpha = lerp(b.alpha, a.alpha, k) * fade;
      const warm = lerp(b.warm, a.warm, k), cool = lerp(b.cool, a.cool, k);
      const rot = lerp(b.rot, a.rot, k), scale = lerp(b.scale, a.scale, k), keep = lerp(b.keep, a.keep, k);
      let colour = mix(from, to, seed * 0.8);
      if (warm) colour = mix(colour, WARM, warm * 0.55);
      if (cool) colour = mix(colour, COOL, cool * 0.55);
      ctx.strokeStyle = rgba(colour, alpha);
      ctx.lineWidth = lerp(b.width, a.width, k) * (c.widths[si] || 1) * S;
      ctx.lineCap = 'round';
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const pts = seg.map(([x, y]) => circlePoint(place, (x * cr - y * sr) * scale, (x * sr + y * cr) * scale));
      if (keep >= 0.999) { path(pts, false); ctx.stroke(); }
      else {
        // Eaten away: only stretches of it left, where its own noise allows.
        for (let i = 1; i < pts.length; i += 1) {
          if (Math.sin(i * 2.7 + seed * 40) * 0.5 + 0.5 > keep) continue;
          ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
        }
      }
    });
    // Burn: a few embers lift off the rings and fade. Freeze: frost creeps out from the rings.
    if (c.effect === 'burn' && !calm) {
      if (Math.random() < dt * 6 && c.embers.length < 24) {
        const ring = c.segs[0], p = ring[Math.floor(Math.random() * ring.length)];
        c.embers.push({ a: p[0], b: p[1], z: 0, life: 0 });
      }
      for (const e of c.embers) {
        e.life += dt; e.z += dt * 9;
        const at = place(0.5 + e.a, 0.5 + e.b * (PW / PH));
        const fadeE = Math.sin(clamp(e.life / 2.2) * Math.PI) * 0.4 * ease(c.blend) * fade;
        ctx.fillStyle = rgba(mix(WARM, from, 0.3), fadeE);
        ctx.beginPath(); ctx.arc(at.x, at.y - e.z * S, 1.3 * S, 0, Math.PI * 2); ctx.fill();
      }
      c.embers = c.embers.filter((e) => e.life < 2.2);
    }
    if (c.effect === 'freeze') {
      ctx.strokeStyle = rgba(mix(COOL, from, 0.25), 0.35 * ease(c.blend) * fade);
      ctx.lineWidth = 0.8 * S;
      for (const f of c.frost) {
        f.len = Math.min(f.max, f.len + dt * 0.012);
        const [x, y] = f.p, r = Math.hypot(x, y) || 1;
        const o = circlePoint(place, x, y), e = circlePoint(place, x + (x / r) * f.len, y + (y / r) * f.len);
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      }
    }
  }

  /* ── the inkwell: a squat bottle of clear glass, ink swirling in it ───────
   * The glass is thick, and drawn as thick glass is seen: walls with an
   * inner face, a heavy base the ink stands on, a lip as wide as the glass,
   * clear in the middle and dense where it is seen edge on. The ink inside is the
   * theme's gradient, its colours mixed into one another, seen through the
   * side and, down the neck, on top -- a bright line where it meets the
   * glass, rings where anything goes in. */
  // In front of the book, to the right: within reach of the page, and on screen on a phone.
  const WELL = { x: PW * 0.74, y: -PH / 2 - 36, r: 16, h: 22, neck: 8, nh: 7 };
  const wellTop = () => WELL.h + WELL.nh;
  // Where the nib is tapped after dipping: over the opening, by its right-hand rim -- lifted, and touching.
  const RIM = { x: WELL.x + WELL.neck * 0.8, y: WELL.y + 1, lift: 11, touch: 3 };
  // The ink: most of the way up the body, under the shoulder, inside the glass's thickness.
  const INK_Z = WELL.h - 5;
  // The glass has substance: walls this thick, a heavy base the ink sits on, a thick lip.
  const WALL = 2.8, BASE = 3.4, LIP_W = 1.8;
  const INK_R = WELL.r - WALL;
  // How far below the rim the nib goes to be under it.
  const DIP = INK_Z - 3 - (WELL.h + WELL.nh);
  const GRAVITY = 160;
  const TAU = Math.PI * 2;
  const WHITE = [255, 255, 255];
  function ellipsePts(cx, cy, z, r, n = 28, from = 0, to = TAU) {
    const pts = [];
    for (let i = 0; i <= n; i += 1) { const a = lerp(from, to, i / n); pts.push(P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z)); }
    return pts;
  }
  // An ellipse on screen as its centre and two radii, for gradients drawn into it.
  function screenEllipse(cx, cy, z, r) {
    const c = P(cx, cy, z);
    return { c, rx: Math.abs(P(cx + r, cy, z).x - c.x), ry: Math.abs(c.y - P(cx, cy + r, z).y) || 1 };
  }

  /* The ink, side and top: the theme's gradient, its colours mixed into one
   * another and drifting slowly, as two inks poured together. Front only: the
   * part in front of a nib dipped in it, drawn again over the quill. */
  function inkMix(from, to, t, c, rx, ry) {
    // A wash across, one end of the gradient to the other...
    const across = ctx.createLinearGradient(c.x - rx, c.y - ry, c.x + rx, c.y + ry);
    across.addColorStop(0, rgba(from, 1)); across.addColorStop(1, rgba(to, 1));
    ctx.fillStyle = across;
    ctx.fillRect(c.x - rx - 2, c.y - ry - 2, rx * 2 + 4, ry * 2 + 4);
    // ...and soft clouds of each colour drifting through it.
    const clouds = [[from, 0, 0.62], [to, 2.1, 0.58], [mix(from, to, 0.5), 4.2, 0.5], [from, 5.3, 0.4], [to, 1.1, 0.42]];
    for (const [colour, phase, size] of clouds) {
      const cx = c.x + Math.cos(t * 0.35 + phase) * rx * 0.55;
      const cy = c.y + Math.sin(t * 0.27 + phase * 1.3) * ry * 0.55;
      const r = Math.max(rx, ry) * size;
      const cloud = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      cloud.addColorStop(0, rgba(colour, 0.75)); cloud.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = cloud;
      ctx.fillRect(c.x - rx - 2, c.y - ry - 2, rx * 2 + 4, ry * 2 + 4);
    }
  }
  function drawInk(from, to, t, frontOnly = false) {
    const { x, y } = WELL;
    ctx.save();
    if (frontOnly) {
      path(ellipsePts(x, y, BASE, INK_R, 24, Math.PI, TAU).concat(ellipsePts(x, y, INK_Z, INK_R, 24, TAU, Math.PI)));
      ctx.clip();
    }
    // Its side, through the glass: the mix, a little deeper towards the foot.
    const body = ellipsePts(x, y, BASE, INK_R, 28, Math.PI, TAU).concat(ellipsePts(x, y, INK_Z, INK_R, 28, 0, Math.PI));
    // Over the whole of it, the curve of its foot included.
    const xs = body.map((p) => p.x), ys = body.map((p) => p.y);
    const box = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    const foot = { y: Math.max(...ys) }, top = { y: Math.min(...ys) };
    ctx.save();
    path(body); ctx.clip();
    inkMix(from, to, t, box, (Math.max(...xs) - Math.min(...xs)) / 2 + 1, (foot.y - top.y) / 2 + 1);
    const deeper = ctx.createLinearGradient(0, foot.y, 0, top.y);
    deeper.addColorStop(0, 'rgba(0,0,0,.32)'); deeper.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = deeper; path(body); ctx.fill();
    ctx.restore();

    // Its top, seen down the neck: the same mix, shaded where the glass meets it.
    const surface = ellipsePts(x, y, INK_Z, INK_R, 36);
    const { c, rx, ry } = screenEllipse(x, y, INK_Z, INK_R);
    ctx.save();
    path(surface); ctx.clip();
    inkMix(from, to, t + 7, c, rx, ry);
    ctx.save();
    ctx.translate(c.x, c.y); ctx.scale(1, ry / rx);
    const walls = ctx.createRadialGradient(0, 0, rx * 0.45, 0, 0, rx);
    walls.addColorStop(0, 'rgba(0,0,0,0)'); walls.addColorStop(1, 'rgba(0,0,0,.28)');
    ctx.fillStyle = walls; ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.restore();
    ctx.strokeStyle = rgba(mix(to, WHITE, 0.35), 0.4); ctx.lineWidth = 0.7 * S;
    path(surface); ctx.stroke();
    ctx.restore();
  }

  function drawWellBack(from, to, t) {
    const { x, y, r, h, neck, nh } = WELL;
    // Its shadow, a little of the ink's colour let through the glass into it.
    const s = P(x + 4, y - 3, 0);
    const shadow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, r * 1.8 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,.34)');
    shadow.addColorStop(0.55, rgba(mix(from, [0, 0, 0], 0.35), 0.16));
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.8 * S, 0, TAU); ctx.fill();
    // The back of the glass, seen through the front: thick enough to tint what is behind it.
    const outline = ellipsePts(x, y, 0, r, 28, Math.PI, TAU).concat(ellipsePts(x, y, h, r, 28, 0, Math.PI));
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    path(outline); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 0.8 * S;
    path(ellipsePts(x, y, 0, r, 28, 0, Math.PI), false); ctx.stroke();
    // The far wall's inner face, a wall's thickness in.
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 0.7 * S;
    path(ellipsePts(x, y, h - 1.5, r - WALL, 28, 0, Math.PI), false); ctx.stroke();
    // The heavy base: solid glass the ink stands on, lit through.
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    path(ellipsePts(x, y, 0, r - 0.6, 28, Math.PI, TAU).concat(ellipsePts(x, y, BASE, r - 0.6, 28, 0, Math.PI))); ctx.fill();
    drawInk(from, to, t);
    // The far half of the shoulder and of the neck.
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 0.7 * S;
    path(ellipsePts(x, y, h, r, 28, 0, Math.PI), false); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    path(ellipsePts(x, y, h, neck, 20, 0, Math.PI).concat(ellipsePts(x, y, h + nh, neck, 20, Math.PI, 0))); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.26)'; ctx.lineWidth = 0.9 * S;
    path(ellipsePts(x, y, h + nh, neck, 20, 0, Math.PI), false); ctx.stroke();
  }

  // The near glass: over the ink, and over a nib dipped in it -- clear, so the nib still shows.
  function drawWellFront(to) {
    const { x, y, r, h, neck, nh } = WELL;
    const left = P(x - r, y, 0), right = P(x + r, y, 0);
    const wallShare = WALL / (2 * r);
    // The near wall: thick glass, so brighter and denser where it is seen edge on, at its sides.
    const wall = ctx.createLinearGradient(left.x, 0, right.x, 0);
    wall.addColorStop(0, 'rgba(255,255,255,.26)'); wall.addColorStop(wallShare, 'rgba(255,255,255,.12)');
    wall.addColorStop(wallShare * 1.6, 'rgba(255,255,255,.04)'); wall.addColorStop(0.5, 'rgba(255,255,255,.025)');
    wall.addColorStop(1 - wallShare * 1.6, 'rgba(255,255,255,.04)'); wall.addColorStop(1 - wallShare, 'rgba(255,255,255,.13)');
    wall.addColorStop(1, 'rgba(255,255,255,.28)');
    ctx.fillStyle = wall;
    path(ellipsePts(x, y, 0, r, 28, Math.PI, TAU).concat(ellipsePts(x, y, h, r, 28, TAU, Math.PI))); ctx.fill();
    // The wall's inner face, a wall's thickness in from each side: where the ink meets the glass.
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 0.7 * S;
    for (const side of [-1, 1]) { path([P(x + side * (r - WALL), y - 0.5, BASE), P(x + side * (r - WALL), y - 0.5, h - 1.5)], false); ctx.stroke(); }
    // Its outline: a shade for a light page, a light for a dark one.
    const sides = [[P(x - r, y, 0), P(x - r, y, h)], [P(x + r, y, 0), P(x + r, y, h)]];
    for (const [stroke, width] of [['rgba(0,0,0,.26)', 2], ['rgba(255,255,255,.42)', 1]]) {
      ctx.strokeStyle = stroke; ctx.lineWidth = width * S;
      for (const side of sides) { path(side, false); ctx.stroke(); }
      path(ellipsePts(x, y, 0, r, 28, Math.PI, TAU), false); ctx.stroke();
    }
    // The heavy base, its near face: solid glass, its top edge catching the light.
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    path(ellipsePts(x, y, 0, r, 28, Math.PI, TAU).concat(ellipsePts(x, y, BASE, r, 28, TAU, Math.PI))); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.34)'; ctx.lineWidth = 0.9 * S;
    path(ellipsePts(x, y, BASE, r - 0.4, 28, Math.PI * 1.06, Math.PI * 1.94), false); ctx.stroke();
    // The shoulder: a thick ring of glass from the body in to the neck.
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    ctx.beginPath();
    for (const ring of [ellipsePts(x, y, h, r, 32), ellipsePts(x, y, h, neck, 24)]) ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.36)'; ctx.lineWidth = 0.9 * S;
    path(ellipsePts(x, y, h, r, 28, Math.PI, TAU), false); ctx.stroke();
    // The window's light, down the glass; and a fainter one across from it.
    for (const [ax, w, a] of [[-0.6, 2.4, 0.55], [0.68, 1.4, 0.24]]) {
      const p0 = P(x + r * ax, y - r * 0.8, BASE + 1), p1 = P(x + r * ax, y - r * 0.8, h - 2);
      const streak = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
      streak.addColorStop(0, 'rgba(255,255,255,0)'); streak.addColorStop(0.45, `rgba(255,255,255,${a})`);
      streak.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = streak; ctx.lineWidth = w * S; ctx.lineCap = 'round';
      path([p0, p1], false); ctx.stroke();
    }
    // The neck: a short tube of thick glass, its inner face showing.
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    path(ellipsePts(x, y, h, neck, 20, Math.PI, TAU).concat(ellipsePts(x, y, h + nh, neck, 20, TAU, Math.PI))); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.36)'; ctx.lineWidth = 0.9 * S;
    for (const side of [[P(x - neck, y, h), P(x - neck, y, h + nh)], [P(x + neck, y, h), P(x + neck, y, h + nh)]]) { path(side, false); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 0.6 * S;
    for (const side of [-1, 1]) { path([P(x + side * (neck - LIP_W), y - 0.3, h + 0.5), P(x + side * (neck - LIP_W), y - 0.3, h + nh)], false); ctx.stroke(); }
    // The lip: a ring of glass as wide as the glass is thick, bright on top.
    ctx.fillStyle = 'rgba(255,255,255,.24)';
    ctx.beginPath();
    for (const ring of [ellipsePts(x, y, h + nh, neck, 28), ellipsePts(x, y, h + nh, neck - LIP_W, 28)]) ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 0.9 * S;
    path(ellipsePts(x, y, h + nh, neck, 28)); ctx.stroke();
    ctx.strokeStyle = rgba(to, 0.32); ctx.lineWidth = 0.6 * S;
    path(ellipsePts(x, y, h + nh, neck - LIP_W, 28)); ctx.stroke();
  }

  /* ── ink: a drop hanging from the nib, drops shaken loose, rings ──────────
   * Round below, drawn to a point above where it hangs or as it falls, the
   * gradient's colours mixed in it, a point of light on it. */
  function inkDrop(at, r, from, to, t, stretch = 0) {
    ctx.save();
    ctx.translate(at.x, at.y);
    const tip = -r * (1 + stretch * 1.6);
    ctx.beginPath();
    ctx.moveTo(0, tip);
    ctx.bezierCurveTo(r * 0.5, tip * 0.6, r, -r * 0.35, r, 0);
    ctx.arc(0, 0, r, 0, Math.PI, false);
    ctx.bezierCurveTo(-r, -r * 0.35, -r * 0.5, tip * 0.6, 0, tip);
    ctx.closePath();
    // The gradient's two colours mixed in it, turning a little as it goes.
    const a = t * 1.5;
    const mixIn = ctx.createLinearGradient(Math.cos(a) * r, tip / 2 + Math.sin(a) * r, -Math.cos(a) * r, -Math.sin(a) * r);
    mixIn.addColorStop(0, rgba(from, 1)); mixIn.addColorStop(1, rgba(to, 1));
    ctx.fillStyle = mixIn; ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.beginPath(); ctx.ellipse(-r * 0.36, -r * 0.34, r * 0.26, r * 0.18, -0.5, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function drawBead(nib, size, from, to, t) {
    const r = (0.8 + 1.6 * size) * S;
    // Hanging from the nib: its point at the nib, longer the more of it there is.
    const stretch = 0.3 + 0.7 * size;
    inkDrop({ x: nib.x, y: nib.y + r * (1 + stretch * 1.6) }, r, from, to, t, stretch);
  }
  function drawDrops(dt, from, to, t) {
    if (calm) { state.drops.length = 0; state.ripples.length = 0; return; }
    for (const d of state.drops) {
      d.vz -= GRAVITY * dt; d.z += d.vz * dt;
      if (d.z <= INK_Z) { d.done = true; state.ripples.push({ x: d.x, y: d.y, life: 0, size: d.size }); continue; }
      // Falling: drawn out along its fall, its point up.
      inkDrop(P(d.x, d.y, d.z), d.size * S, from, to, t, Math.min(1, -d.vz / 70));
    }
    state.drops = state.drops.filter((d) => !d.done);
    if (!state.ripples.length) return;
    // The rings, on the ink only.
    ctx.save();
    path(ellipsePts(WELL.x, WELL.y, INK_Z, INK_R)); ctx.clip();
    for (const r of state.ripples) {
      r.life += dt;
      const k = clamp(r.life / 0.9);
      ctx.strokeStyle = rgba(mix(from, to, k), 0.6 * (1 - k));
      ctx.lineWidth = (0.9 - 0.4 * k) * S;
      path(ellipsePts(r.x, r.y, INK_Z, 0.6 + k * 3.8 * r.size, 20)); ctx.stroke();
    }
    ctx.restore();
    state.ripples = state.ripples.filter((r) => r.life < 0.9);
  }

  /* ── the quill: drawn at its nib, its plume up to the right ──────────────
   * Held as a right hand holds it: the nib at the foot on the left, the
   * feather leaning away to the top right. (Drawn as before, mirrored.) */
  function drawQuill(at, lean, from, to) {
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(0.95 - lean);
    ctx.scale(-S, S);
    const g = ctx.createLinearGradient(0, 0, 0, -82);
    g.addColorStop(0, rgba(to, 0.94)); g.addColorStop(1, rgba(from, 0.85));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-12, -32, -5, -82);
    ctx.quadraticCurveTo(8, -50, 3, -9);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(from, 0.45); ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(0.5, -2); ctx.lineTo(-2.6, -76); ctx.stroke();
    // Barbs, faint.
    ctx.strokeStyle = rgba(to, 0.25); ctx.lineWidth = 0.6;
    for (let i = 14; i < 70; i += 7) { ctx.beginPath(); ctx.moveTo(-1.5 - i * 0.015, -i); ctx.lineTo(-8 + i * 0.02, -i - 6); ctx.stroke(); }
    ctx.restore();
  }

  /* ── the story of it: write, glide, travel, dip, turn, return ────────── */
  const state = {
    phase: 'return', t: 0,
    right: [], leaf: null,
    circle: newCircle(), nextCircle: null,
    nib: { x: WELL.x, y: WELL.y, z: wellTop() + 10 },   // in the desk's terms
    from: null,             // where a move began
    handover: 1,            // calm: the left page's fade
    tapped: 0,              // the last tap on the rim that shook a drop loose
    shake: 0,               // the feather's shake after a tap, dying away
    bead: 0,                // ink gathered at the nib, 0 to 1
    drops: [],              // loose drops falling back into the well
    ripples: [],            // and the rings they leave on the ink
  };
  const nibAtWell = (depth) => ({ x: WELL.x, y: WELL.y, z: wellTop() + depth });
  // A move from where the nib is to `to`, over `secs`, lifted `arc` on the way.
  function move(to, secs, arc) {
    state.from = { ...state.nib, to, secs, arc, t: 0 };
  }
  function stepMove(dt) {
    const m = state.from;
    if (!m) return true;
    m.t += dt;
    const k = ease(clamp(m.t / m.secs));
    state.nib = { x: lerp(m.x, m.to.x, k), y: lerp(m.y, m.to.y, k), z: lerp(m.z, m.to.z, k) + Math.sin(k * Math.PI) * m.arc };
    if (m.t >= m.secs) { state.nib = { ...m.to }; state.from = null; return true; }
    return false;
  }
  const lineStart = (row) => world.right(0.13, 0.14 + row * 0.11, 0);

  /* ── the letters: drifting, and drawn into the nib as it writes ─────── */
  // The book's own title among them, as its letters; the rest in the library's own writing, once known.
  let POOL = letterMix([], { title: glyphs });
  const startedAt = performance.now();
  const letters = [];
  lettersReady.then((pool) => {
    if (stopped || !Array.isArray(pool) || !pool.length) return;
    POOL = pool;
    // Known while the scene is still coming in: its letters taken from the new mix at once.
    if (performance.now() - startedAt < 700) for (const l of letters) if (!l.feed) l.ch = POOL[Math.floor(Math.random() * POOL.length)];
  });
  function spawn(l, anywhere) {
    l.ch = POOL[Math.floor(Math.random() * POOL.length)];
    l.x = anywhere ? Math.random() * W : (Math.random() < 0.5 ? -10 : W + 10);
    l.y = Math.random() * H * 0.84;
    l.vx = (Math.random() - 0.5) * 8; l.vy = (Math.random() - 0.5) * 6;
    l.base = 0.14 + Math.random() * 0.14;
    l.size = 12 + Math.random() * 7;
    l.born = performance.now();
    l.feed = null;
  }
  for (let i = 0; i < 38; i += 1) { const l = {}; spawn(l, true); l.born -= 2000; letters.push(l); }
  let lastFeed = 0;

  let colours = null;
  function step(dt, now) {
    ctx.clearRect(0, 0, W, H);
    /* The theme's colours read once a second, not every frame: reading a
     * style has the page's styles worked out again if anything on it changed
     * since -- and with an export saying how far it has got, something has,
     * every frame. A theme changed shows within the second. */
    if (!colours || now - colours.at > 1000) colours = { at: now, from: hexToRgb(css('--grad-from')), to: hexToRgb(css('--grad-to')) };
    const { from, to } = colours;
    state.t += dt;
    const writing = state.right.find((line) => !line.doneAt);

    if (calm) {
      // No travel, no turning: the quill rests in the well; lines appear one at a time; a full page hands over by a fade.
      state.leaf = null; state.from = null;
      state.nib = nibAtWell(DIP + 1);
      if (state.handover < 1) {
        state.handover = Math.min(1, state.handover + dt / 1.5);
        if (state.handover >= 1) { state.right = []; state.circle = state.nextCircle || newCircle(); state.nextCircle = null; }
      } else if (state.t > 1.6) {
        state.t = 0;
        if (state.right.length >= ROWS) { state.nextCircle = newCircle(); state.handover = 0; }
        else { const line = lineShape(state.right.length); line.drawn = line.pts.length; line.doneAt = now; state.right.push(line); }
      }
      if (state.phase !== 'calm') state.phase = 'calm';
    } else if (state.phase === 'calm') {
      state.phase = 'return'; state.t = 0; state.handover = 1;
      if (state.nextCircle) { state.circle = state.nextCircle; state.nextCircle = null; }
    }

    if (state.phase === 'return') {
      // Back to the start of the next line to write, lifted and eased: never a jump.
      if (!state.from) move(lineStart(state.right.length), 1.25, 26);
      if (stepMove(dt)) { state.phase = 'write'; state.t = 0; }
    } else if (state.phase === 'write') {
      let line = writing;
      if (!line && state.right.length < ROWS) { line = lineShape(state.right.length); state.right.push(line); }
      if (line) {
        line.drawn = Math.min(line.pts.length, line.drawn + dt * WRITE_SPEED);
        const p = line.pts[Math.max(0, Math.floor(line.drawn) - 1)];
        state.nib = world.right(p[0], p[1], 0);
        if (line.drawn >= line.pts.length) {
          line.doneAt = now;
          // Glide to the next line, the nib lifted a little; or, the page full, to the inkwell.
          if (state.right.length < ROWS) { state.phase = 'glide'; move(lineStart(state.right.length), 0.45, 6); }
          else { state.phase = 'toWell'; move(nibAtWell(14), 1.5, 34); }
        }
      }
    } else if (state.phase === 'glide') {
      if (stepMove(dt)) state.phase = 'write';
    } else if (state.phase === 'toWell') {
      if (stepMove(dt)) { state.phase = 'dip'; state.t = 0; state.tapped = 0; }
    } else if (state.phase === 'dip') {
      /* Down through the neck into the ink and a moment there; up, a bead of
       * ink gathering at the nib, across to the rim; tapped on it twice, the
       * feather shaking and a loose drop falling back in each time; then up
       * over the well again. The page turns meanwhile. */
      const k = state.t;
      const tap = (at) => { const s = (k - at) / 0.4; return s < 0.32 ? ease(s / 0.32) : 1 - ease((s - 0.32) / 0.68); };
      if (k < 0.6) state.nib = nibAtWell(lerp(14, DIP, ease(k / 0.6)));
      else if (k < 0.95) state.nib = nibAtWell(DIP);
      else if (k < 1.45) {
        // Up out of the neck first, then across: never through the glass.
        const s = (k - 0.95) / 0.5, up = ease(clamp(s / 0.6)), across = ease(clamp((s - 0.3) / 0.7));
        state.nib = { x: lerp(WELL.x, RIM.x, across), y: lerp(WELL.y, RIM.y, across), z: wellTop() + lerp(DIP, RIM.lift, up) };
      } else if (k < 2.25) {
        // Two taps, 0.4 s each: down onto the rim quickly, up slower.
        const down = tap(k < 1.85 ? 1.45 : 1.85);
        state.nib = { x: RIM.x, y: RIM.y, z: wellTop() + lerp(RIM.lift, RIM.touch, down) };
        for (const at of [1.45, 1.85]) {
          if (state.tapped < at && k >= at + 0.128) {
            state.tapped = at;
            state.shake = 1;
            state.drops.push({ x: RIM.x - 1.2, y: RIM.y, z: wellTop() + RIM.touch - 1, vz: 0, size: at === 1.45 ? 2 : 1.5 });
          }
        }
      } else {
        const e = ease(clamp((k - 2.25) / 0.5));
        state.nib = { x: lerp(RIM.x, WELL.x, e), y: lerp(RIM.y, WELL.y, e), z: wellTop() + lerp(RIM.lift, 12, e) };
      }
      // The bead at the nib: gathering once out of the ink, gone with the taps.
      state.bead = k < 0.95 ? 0 : k < 1.45 + 0.128 ? clamp((k - 0.95) / 0.4) : k < 1.85 + 0.128 ? 0.45 : 0;
      if (!state.leaf && k > 0.3) {
        state.nextCircle = newCircle();
        state.leaf = { lines: state.right, theta: 0 };
        state.right = [];
      }
      if (k > 2.75) { state.phase = 'wait'; state.t = 0; state.tapped = 0; state.bead = 0; }
    } else if (state.phase === 'wait') {
      state.nib = nibAtWell(12 + Math.sin(state.t * 2) * 1.5);
      if (!state.leaf) { state.phase = 'return'; state.t = 0; state.from = null; }
    }

    // The leaf turning over: carried by an eased angle, bent a little as a page is.
    if (state.leaf) {
      state.leaf.age = (state.leaf.age || 0) + dt;
      state.leaf.theta = Math.PI * ease(clamp(state.leaf.age / 2.3));
      if (state.leaf.age >= 2.3) {
        state.circle = state.nextCircle; state.nextCircle = null;
        state.leaf = null;
      }
    }

    // ── letters behind the book ──
    const nibScreen = P(state.nib.x, state.nib.y, state.nib.z);
    const feeding = !calm && state.phase === 'write';
    if (feeding && now - lastFeed > 240) {
      const free = letters.filter((l) => !l.feed && now - l.born > 1200);
      const pick = free[Math.floor(Math.random() * free.length)];
      if (pick) pick.feed = { x: pick.x, y: pick.y, size: pick.size, a: pick.base, t: 0 };
      lastFeed = now;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const drawLetter = (l) => {
      const born = clamp((now - l.born) / 1000);
      let x = l.x, y = l.y, size = l.size, a = l.base * born;
      if (calm) a = l.base * (0.85 + 0.15 * Math.sin(now / 1500 + l.size));
      else if (l.feed) {
        l.feed.t += dt;
        const k = ease(clamp(l.feed.t / 1.3));
        x = lerp(l.feed.x, nibScreen.x, k); y = lerp(l.feed.y, nibScreen.y, k);
        size = l.feed.size * (1 - 0.7 * k);
        a = l.feed.a + (0.48 - l.feed.a) * Math.sin(k * Math.PI) - l.feed.a * k;
        if (k >= 1) { spawn(l, false); return; }
      } else {
        l.x += l.vx * dt; l.y += l.vy * dt;
        if (l.x < -20 || l.x > W + 20 || l.y < -20 || l.y > H * 0.86) { spawn(l, false); return; }
        x = l.x; y = l.y;
      }
      ctx.fillStyle = rgba(mix(from, to, clamp(x / W)), a);
      ctx.font = `600 ${size}px Archivo, "Noto Sans KR", "Noto Sans JP", sans-serif`;
      ctx.fillText(l.ch, x, y);
    };
    for (const l of letters) if (!l.feed) drawLetter(l);

    // ── the book, the circle, the writing ──
    drawBook();
    if (calm && state.handover < 1) {
      drawCircle(state.circle, onLeft, 1 - ease(state.handover), from, to, now, dt);
      drawCircle(state.nextCircle, onLeft, ease(state.handover), from, to, now, 0);
      strokeLines(state.right, onRight, 1 - ease(state.handover), from, to, now, true);
    } else {
      drawCircle(state.circle, onLeft, 1, from, to, now, dt);
      strokeLines(state.right, onRight, 1, from, to, now, true);
    }

    // ── the leaf, its writing on its face and the next circle on its back ──
    if (state.leaf) {
      const th = state.leaf.theta;
      const N = 18;
      const curve = [];   // along the leaf from the spine: { x, z } in the desk's terms
      let x = 0, z = rise(0);
      curve.push({ x, z, u: 0 });
      for (let i = 1; i <= N; i += 1) {
        const u = i / N;
        const phi = th + Math.sin(th) * 0.55 * u;         // the outer part lags: the page bends
        x += Math.cos(phi) * PW / N; z += Math.sin(phi) * PW / N;
        // Flat at both ends it lies on the pages' own rise, so it lands where it settles.
        const flat = Math.abs(Math.cos(th));
        curve.push({ x, z: z + (rise(u) - rise(0)) * flat * flat, u });
      }
      const at = (u, v) => {
        const f = u * N, i = Math.min(N - 1, Math.floor(f)), k = f - i;
        const p = curve[i], q = curve[i + 1];
        return P(lerp(p.x, q.x, k), PH / 2 - v * PH, lerp(p.z, q.z, k) + 0.4);
      };
      const outline = curve.map((c) => P(c.x, PH / 2, c.z)).concat(curve.slice().reverse().map((c) => P(c.x, -PH / 2, c.z)));
      const face = Math.cos(th);   // > 0: its written face is up; < 0: its back
      const shade = 0.6 + 0.4 * Math.abs(face);
      const mid = P(curve[N >> 1].x, 0, curve[N >> 1].z), tip = P(curve[N].x, 0, curve[N].z), base = P(0, 0, rise(0));
      const g = ctx.createLinearGradient(base.x, base.y, tip.x + 0.01, tip.y);
      g.addColorStop(0, `rgb(${Math.round(41 * shade)},${Math.round(37 * shade)},${Math.round(43 * shade)})`);
      g.addColorStop(0.5, `rgb(${Math.round(64 * shade)},${Math.round(58 * shade)},${Math.round(63 * shade)})`);
      g.addColorStop(1, `rgb(${Math.round(56 * shade)},${Math.round(50 * shade)},${Math.round(56 * shade)})`);
      ctx.fillStyle = g;
      path(outline); ctx.fill();
      ctx.save();
      path(outline); ctx.clip();
      // Its writing, only on it, going as it stands upright; its back's circle coming as it lies down.
      if (face > 0) strokeLines(state.leaf.lines, at, clamp((face - 0.1) / 0.45), from, to, now, false);
      else drawCircle(state.nextCircle, (u, v) => at(u, v), clamp((-face - 0.1) / 0.45), from, to, now, 0);
      ctx.restore();
      void mid;
    }

    // ── the inkwell, the quill, the letters drawn into it ──
    // The ink turns slowly; with reduced motion it is still.
    const swirl = calm ? 0 : now / 1000;
    drawWellBack(from, to, swirl);
    const inNeck = state.nib.z < wellTop() + 2 && Math.hypot(state.nib.x - WELL.x, state.nib.y - WELL.y) < 3;
    // A ring where the nib goes into the ink, and where it comes out.
    const under = inNeck && state.nib.z < INK_Z + 0.5;
    if (under !== state.under) {
      if (state.under !== undefined && !calm) state.ripples.push({ x: state.nib.x, y: state.nib.y, life: 0, size: 2.2 });
      state.under = under;
    }
    // The glow behind the nib: short, faint, fading.
    if (!calm && state.phase === 'write' && writing) {
      const end = Math.floor(writing.drawn);
      for (let i = Math.max(1, end - 12); i < end; i += 1) {
        const k = 1 - (end - i) / 12;
        const p = onRight(...writing.pts[i - 1]), q = onRight(...writing.pts[i]);
        ctx.strokeStyle = rgba(from, 0.32 * k);
        ctx.lineWidth = (4 * k + 1) * S;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    }
    drawDrops(dt, from, to, swirl);
    for (const l of letters) if (l.feed) drawLetter(l);
    // After a tap on the rim the feather shakes, quick and dying away.
    state.shake = Math.max(0, state.shake - dt * 2.4);
    const shake = state.shake * state.shake * Math.sin(now / 26) * 0.1;
    const lean = (state.phase === 'write' ? Math.sin(now / 150) * 0.05 : 0.18) + shake;
    // The glass in front of the quill -- or, the nib down in it, over the quill, the ink in front of it first.
    if (!inNeck) drawWellFront(to);
    drawQuill(nibScreen, lean, from, to);
    if (state.bead > 0.02 && !calm) drawBead(nibScreen, state.bead, from, to, swirl);
    if (inNeck) {
      if (under) drawInk(from, to, swirl, true);
      drawWellFront(to);
    }
  }

  let last = performance.now();
  let raf = 0;
  let stopped = false;
  let skip = false;
  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    // Faint, behind the queue: every other frame is enough, and kinder to the battery.
    if (faint && (skip = !skip)) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden && W > 2 && H > 2) { try { step(dt, now); } catch (e) { console.warn('opening scene', e); } }
  }
  raf = requestAnimationFrame(frame);
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { fit(); camera(); }) : null;
  resized?.observe(canvas);
  const onReduce = (e) => { calm = e.matches; };
  reduceQuery?.addEventListener?.('change', onReduce);
  return {
    stop() {
      stopped = true;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      resized?.disconnect();
      reduceQuery?.removeEventListener?.('change', onReduce);
      try { ctx.clearRect(0, 0, W, H); } catch { /* gone */ }
    },
  };
}
