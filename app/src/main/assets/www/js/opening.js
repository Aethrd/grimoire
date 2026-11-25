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
  const COOL = [130, 210, 245];
  const TOXIC = [60, 200, 70];
  const LIME = [170, 236, 90];

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
  const EFFECTS = ['shine', 'fluctuate', 'poison', 'erode', 'burn', 'freeze'];
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
      fx: [], anchors: anchorsOf(segs),
    };
  }

  // A point of the circle on a page: local (a, b) in page widths, centred on the page.
  const circlePoint = (place, a, b) => place(0.5 + a, 0.5 + b * (PW / PH));

  /* What each effect does to the circle -- strongly: each one should be
   * unmistakable at a glance. A halo is a wide faint stroke under the line,
   * a glow without the cost of a blur; sag lets a decaying circle droop. */
  function effectLook(name, c, seed, now, t) {
    // { alpha, colour mix (warm/cool/toxic), width, rotation, scale, gap, halo, sag } for one segment.
    const look = { alpha: 0.2, warm: 0, cool: 0, toxic: 0, bright: 0, width: 1, rot: 0, scale: 1, keep: 1, halo: 0, sag: 0 };
    switch (name) {
      case 'dark': look.alpha = 0.12; break;
      case 'shine': {
        const pulse = 0.5 - 0.5 * Math.cos(t * 1.6);
        look.alpha = 0.6 + 0.4 * pulse; look.width = 1.5 + 0.9 * pulse; look.halo = 0.6 + 0.6 * pulse; look.bright = 0.35 + 0.45 * pulse;
        break;
      }
      case 'fluctuate':
        // Breathing unevenly: each line its own beat, the whole circle swaying.
        look.alpha = 0.45 + 0.4 * Math.sin(now / 520 + seed * 6);
        look.rot = Math.sin(now / 1500) * 0.26 + Math.sin(now / 610 + seed * 4) * 0.04;
        look.scale = 1 + Math.sin(now / 900) * 0.07 + Math.sin(now / 340 + seed * 9) * 0.025;
        look.width = 1 + 0.5 * (0.5 + 0.5 * Math.sin(now / 430 + seed * 7));
        look.halo = 0.25;
        break;
      case 'poison':
        // Toxic: dark green, swelling and ebbing like something alive.
        look.alpha = 0.6 + 0.25 * Math.sin(now / 700 + seed * 5);
        look.toxic = clamp(t / 1) * 1.2; look.width = 2.6; look.halo = 0.6 * clamp(t / 1);
        // Heavy with it: the circle sagging a little under the slime.
        look.sag = Math.min(0.012, t * 0.004);
        break;
      case 'erode': look.alpha = 0.6; look.keep = clamp(1 - t * (0.12 + seed * 0.18), 0.06, 1); break;
      case 'burn':
        look.alpha = 0.65 + 0.3 * Math.sin(now / 90 + seed * 9) * Math.sin(now / 230 + seed * 3);
        look.warm = clamp(t / 1.2) * 1.5; look.width = 1.4; look.halo = 0.7 * clamp(t / 1.2);
        break;
      case 'freeze': look.alpha = 0.6; look.cool = clamp(t / 1.6) * 1.5; look.width = 1.2; look.halo = 0.45 * clamp(t / 1.6); break;
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
      c.fx.length = 0; c.anchors.forEach((a) => { a.grown = 0; a.timer = rand(0, 1.5); });
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
      const halo = lerp(b.halo, a.halo, k), sag = lerp(b.sag, a.sag, k);
      let colour = mix(from, to, seed * 0.8);
      if (warm) colour = mix(colour, WARM, Math.min(1, warm * 0.6));
      if (cool) colour = mix(colour, COOL, Math.min(1, cool * 0.6));
      const toxic = lerp(b.toxic, a.toxic, k);
      if (toxic) colour = mix(colour, TOXIC, Math.min(1, toxic * 0.75));
      const bright = lerp(b.bright, a.bright, k);
      if (bright) colour = mix(colour, [255, 252, 236], bright);
      const width = lerp(b.width, a.width, k) * (c.widths[si] || 1) * S;
      ctx.lineCap = 'round';
      const cr = Math.cos(rot), sr = Math.sin(rot);
      // Drooping: lower the further out, as if it were running.
      const pts = seg.map(([x, y]) => circlePoint(place, (x * cr - y * sr) * scale, (x * sr + y * cr) * scale + sag * (0.4 + Math.abs(x) * 3)));
      // The glow under it.
      if (halo > 0.02 && keep >= 0.999) {
        ctx.strokeStyle = rgba(colour, alpha * halo * 0.28);
        ctx.lineWidth = width * 4.5;
        path(pts, false); ctx.stroke();
      }
      ctx.strokeStyle = rgba(colour, Math.min(1, alpha));
      ctx.lineWidth = width;
      if (keep >= 0.999) { path(pts, false); ctx.stroke(); }
      else {
        // Eaten away: only stretches of it left, where its own noise allows.
        for (let i = 1; i < pts.length; i += 1) {
          if (Math.sin(i * 2.7 + seed * 40) * 0.5 + 0.5 > keep) continue;
          ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
        }
      }
    });
    // Each effect, seen: flames, ice, poison, crumbling, sparkle, lightning.
    if (!calm) {
      const strength = ease(c.blend) * fade;
      const fx = STATUS[c.effect];
      if (fx && strength > 0.02) fx(c, place, strength, now, dt, from, to);
    }
  }

  /* ── the status effects: what each one looks like on the circle ──────────
   * Drawn on the rings at anchor points spread along them, in screen space:
   * up is up the screen, outward is away from the circle's centre. */
  /* Points scattered at random along every line of the circle -- its rings,
   * its figure, its heart -- each with a character of its own: how big, how
   * fast, how its crystals lie. Nothing evenly spaced or in step. */
  function anchorsOf(segs) {
    const lengths = segs.map((seg) => seg.length);
    const total = lengths.reduce((n, l) => n + l, 0) || 1;
    const count = Math.round(rand(36, 62));
    const all = [];
    for (let n = 0; n < count; n += 1) {
      let pick = Math.random() * total, si = 0;
      while (si < segs.length - 1 && pick > lengths[si]) { pick -= lengths[si]; si += 1; }
      const seg = segs[si];
      if (!seg.length) continue;
      const shards = [];
      const many = Math.floor(rand(0, 4.6));
      for (let j = 0; j < many; j += 1) shards.push({ angle: rand(-0.9, 0.9), len: rand(4, 15), wide: rand(0.16, 0.3), rate: rand(0.25, 0.9) });
      all.push({
        p: seg[Math.floor(Math.random() * seg.length)], seed: Math.random(),
        size: rand(0.5, 1.5), f1: rand(45, 110), f2: rand(110, 260), beat: rand(700, 2600), phase: rand(0, TAU),
        shards, grown: 0, timer: rand(0, 2.5),
      });
    }
    return all;
  }
  const screenOf = (place, [x, y]) => circlePoint(place, x, y);
  function outward(place, p) {
    const o = circlePoint(place, 0, 0), q = screenOf(place, p);
    const d = Math.hypot(q.x - o.x, q.y - o.y) || 1;
    return { q, ux: (q.x - o.x) / d, uy: (q.y - o.y) / d };
  }
  // A teardrop, point up, round at its foot: a flame, a drop.
  function teardrop(x, y, w, h, lean = 0) {
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.bezierCurveTo(x - w / 2, y - h * 0.45, x + lean - w * 0.15, y - h * 0.7, x + lean, y - h);
    ctx.bezierCurveTo(x + lean + w * 0.15, y - h * 0.7, x + w / 2, y - h * 0.45, x + w / 2, y);
    ctx.arc(x, y, w / 2, 0, Math.PI, false);
    ctx.closePath();
  }
  function star(x, y, r, alpha, colour) {
    ctx.fillStyle = rgba(colour, alpha);
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i * Math.PI) / 4 - Math.PI / 2, rr = i % 2 ? r * 0.22 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
  }

  // A soft light spread over the circle and round it: its colour lit up, as a glow is.
  function circleGlow(c, place, colour, alpha) {
    const o = circlePoint(place, 0, 0);
    const edge = circlePoint(place, Math.max(...c.segs[0].map(([x]) => Math.abs(x))), 0);
    const R = Math.abs(edge.x - o.x) * 1.35;
    const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, R);
    g.addColorStop(0, rgba(colour, alpha)); g.addColorStop(0.55, rgba(colour, alpha * 0.45)); g.addColorStop(1, rgba(colour, 0));
    ctx.save(); ctx.translate(o.x, o.y); ctx.scale(1, 0.62); ctx.translate(-o.x, -o.y);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(o.x, o.y, R, 0, TAU); ctx.fill();
    ctx.restore();
  }
  const STATUS = {
    /* Burn: fire as a particle fire is -- glowing motes streaming up off
     * the lines, many and small, each born white-hot and cooling as it
     * rises through yellow, orange and red, swelling then shrinking away,
     * swaying as it goes; added together, so where they crowd the fire is
     * brightest. Each point burns on its own beat, flaring and dying down.
     * Fine sparks shoot higher; smoke rises dark above; the circle is lit. */
    burn(c, place, k, now, dt) {
      circleGlow(c, place, [255, 120, 40], 0.16 * k);
      // New flame at each point, as fast as it is burning there.
      for (const a of c.anchors) {
        const flare = Math.max(0, Math.sin(now / a.beat + a.phase) * 0.8 + 0.4);
        a.timer -= dt * (6 + 26 * flare * a.size);
        while (a.timer <= 0 && c.fx.length < 420) {
          const q = screenOf(place, a.p);
          c.fx.push({ kind: 'flame', x: q.x + rand(-2.2, 2.2) * S, y: q.y + rand(-1, 1) * S, life: 0, span: rand(0.45, 0.95) * (0.7 + 0.5 * flare),
            rise: rand(18, 34) * (0.7 + 0.5 * flare), size: rand(1, 2.2) * (0.7 + 0.5 * a.size), sway: rand(0, TAU), wide: rand(2, 5) });
          a.timer += 1;
        }
      }
      if (Math.random() < dt * 16) {
        const a = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        const q = screenOf(place, a.p);
        c.fx.push({ kind: 'spark', x: q.x, y: q.y, life: 0, span: rand(0.9, 1.7), rise: rand(34, 60), drift: rand(-10, 10), size: rand(0.5, 1) });
      }
      if (Math.random() < dt * 4) {
        const a = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        const q = screenOf(place, a.p);
        c.fx.push({ kind: 'smoke', x: q.x, y: q.y - 14 * S, life: 0, span: 2.4, drift: rand(-6, 6), size: rand(5, 10) });
      }
      // Smoke first, under the fire, darkening.
      for (const e of c.fx) {
        if (e.kind !== 'smoke') continue;
        const x = e.x + Math.sin(e.life * 1.2) * e.drift * S, y = e.y - e.life * 14 * S, r = e.size * (0.6 + e.life * 0.6) * S;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(50,44,40,${0.24 * Math.sin(clamp(e.life / e.span) * Math.PI) * k})`); g.addColorStop(1, 'rgba(50,44,40,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // Its colour cooling as it rises: white, yellow, orange, red, gone.
      const heat = (u) => (u < 0.06 ? [255, 246, 214] : u < 0.4 ? mix([255, 246, 214], [255, 190, 70], (u - 0.06) / 0.34)
        : u < 0.7 ? mix([255, 190, 70], [240, 90, 24], (u - 0.4) / 0.3) : mix([240, 90, 24], [150, 24, 8], (u - 0.7) / 0.3));
      for (const e of c.fx) {
        e.life += dt;
        const u = clamp(e.life / e.span);
        if (e.kind === 'flame') {
          const x = e.x + Math.sin(e.life * 7 + e.sway) * e.wide * u * S;
          const y = e.y - e.rise * e.life * S * (1 + u * 0.6);
          const r = e.size * S * Math.sin(Math.min(1, u * 1.6 + 0.15) * Math.PI) * (1 - u * 0.4);
          if (r <= 0.05) continue;
          const col = heat(u), a = (1 - u) * 0.42 * k;
          // A bright core and a short soft edge, so each mote reads as one.
          const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.6);
          g.addColorStop(0, rgba(col, a)); g.addColorStop(0.35, rgba(col, a * 0.7)); g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, TAU); ctx.fill();
        } else if (e.kind === 'spark') {
          const x = e.x + Math.sin(e.life * 5 + e.drift) * e.drift * 0.5 * S, y = e.y - e.rise * e.life * S;
          const f = Math.sin(u * Math.PI) * k;
          ctx.fillStyle = `rgba(255,230,160,${f})`; ctx.beginPath(); ctx.arc(x, y, e.size * S, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
      c.fx = c.fx.filter((e) => e.life < e.span);
    },

    /* Freeze: ice as ice is -- clusters of tall faceted crystals standing up
     * off the lines, a light face and a dark face to each, white glints on
     * their edges; icicles hanging under; a cold light over the circle. */
    freeze(c, place, k, now, dt) {
      circleGlow(c, place, [140, 210, 255], 0.13 * k);
      for (const a of c.anchors) {
        a.grown = Math.min(1, a.grown + dt * 0.55);
        const { q, ux, uy } = outward(place, a.p);
        // Icicles under a few: hanging, growing longer.
        if (a.seed < 0.3) {
          const len = (4 + 9 * a.size) * a.grown * S * k, wd = (1 + a.size) * S;
          const g = ctx.createLinearGradient(q.x, q.y, q.x, q.y + len);
          g.addColorStop(0, `rgba(230,248,255,${0.9 * k})`); g.addColorStop(1, `rgba(120,200,240,${0.2 * k})`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(q.x - wd, q.y); ctx.lineTo(q.x + wd * 0.3, q.y + len); ctx.lineTo(q.x + wd, q.y); ctx.closePath(); ctx.fill();
        }
        // A cluster: its shards leaning up and out, each its own height.
        const up = { x: ux * 0.45, y: uy * 0.45 - 0.8 };
        const n = Math.hypot(up.x, up.y) || 1;
        for (const [j, shard] of a.shards.entries()) {
          const grown = Math.min(1, a.grown * shard.rate * 2);
          const cs = Math.cos(shard.angle * 0.8), sn = Math.sin(shard.angle * 0.8);
          const dx = (up.x / n) * cs - (up.y / n) * sn, dy = (up.x / n) * sn + (up.y / n) * cs;
          const len = shard.len * 1.15 * grown * S * k, bw = len * shard.wide;
          if (len < 1) continue;
          const px = -dy, py = dx;   // across the shard
          const base = { x: q.x + px * (j - (a.shards.length - 1) / 2) * bw * 0.9, y: q.y + py * (j - (a.shards.length - 1) / 2) * bw * 0.9 };
          const tip = { x: base.x + dx * len, y: base.y + dy * len };
          const shoulderL = { x: base.x + dx * len * 0.62 - px * bw * 0.75, y: base.y + dy * len * 0.62 - py * bw * 0.75 };
          const shoulderR = { x: base.x + dx * len * 0.55 + px * bw * 0.7, y: base.y + dy * len * 0.55 + py * bw * 0.7 };
          const L = { x: base.x - px * bw, y: base.y - py * bw }, R = { x: base.x + px * bw, y: base.y + py * bw };
          const spine = { x: base.x + dx * len * 0.1, y: base.y + dy * len * 0.1 };
          /* The lit face and the face in shadow, by one light for every
           * crystal -- from the upper left -- whichever way it leans: the
           * face turned to the light lit, the other shaded, each paling
           * evenly towards its tip. */
          const leftLit = (-px * -0.7 + -py * -0.7) > 0;
          const face = (lit) => {
            const g = ctx.createLinearGradient(base.x, base.y, tip.x, tip.y);
            if (lit) { g.addColorStop(0, `rgba(120,200,240,${0.95 * k})`); g.addColorStop(1, `rgba(214,244,255,${0.95 * k})`); }
            else { g.addColorStop(0, `rgba(30,96,156,${0.95 * k})`); g.addColorStop(1, `rgba(78,156,210,${0.95 * k})`); }
            return g;
          };
          ctx.fillStyle = face(leftLit);
          ctx.beginPath(); ctx.moveTo(L.x, L.y); ctx.lineTo(shoulderL.x, shoulderL.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(spine.x, spine.y); ctx.closePath(); ctx.fill();
          ctx.fillStyle = face(!leftLit);
          ctx.beginPath(); ctx.moveTo(spine.x, spine.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(shoulderR.x, shoulderR.y); ctx.lineTo(R.x, R.y); ctx.closePath(); ctx.fill();
          // A facet across the lit face, a little paler.
          const litShoulder = leftLit ? shoulderL : shoulderR, side = leftLit ? -1 : 1;
          ctx.fillStyle = `rgba(226,248,255,${0.45 * k})`;
          ctx.beginPath(); ctx.moveTo(litShoulder.x, litShoulder.y); ctx.lineTo(tip.x, tip.y);
          ctx.lineTo(base.x + dx * len * 0.5 + side * px * bw * 0.1, base.y + dy * len * 0.5 + side * py * bw * 0.1); ctx.closePath(); ctx.fill();
          // Its edges catching the light.
          ctx.strokeStyle = `rgba(240,252,255,${0.8 * k})`; ctx.lineWidth = 0.45 * S;
          ctx.beginPath(); ctx.moveTo(spine.x, spine.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
          const litEdge = leftLit ? [L, shoulderL] : [R, shoulderR];
          ctx.beginPath(); ctx.moveTo(litEdge[0].x, litEdge[0].y); ctx.lineTo(litEdge[1].x, litEdge[1].y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
          const glint = Math.max(0, Math.sin(now / (a.beat * 0.45) + a.phase + j * 2.3));
          if (glint > 0.88 && grown > 0.8) star(tip.x, tip.y, 3.4 * S * (glint - 0.88) * 8, k, [255, 255, 255]);
        }
      }
    },

    /* Poison: toxic, glowing -- the lines a sick bright green, coated in
     * slime that clumps and runs together, glowing; green smoke curling up
     * off it in wisps; drops oozing off; bubbles; glowing motes drifting up;
     * the green light of it over everything. */
    poison(c, place, k, now, dt) {
      circleGlow(c, place, [70, 230, 90], 0.2 * k);
      const grow = clamp(c.since / 3);
      // The slime: one mass, so where it gathers it runs together.
      const goo = `rgba(30,120,36,${0.9 * k})`;
      ctx.strokeStyle = goo; ctx.fillStyle = goo; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = (2 + 2.2 * grow) * S;
      for (const seg of c.segs) { path(seg.map((p) => screenOf(place, p)), false); ctx.stroke(); }
      const clumps = c.anchors.filter((a) => a.size > 0.85);
      const where = clumps.map((a) => {
        const q = screenOf(place, a.p);
        const r = (2.2 + 6 * (a.size - 0.85)) * (0.5 + 0.9 * grow) * (0.9 + 0.12 * Math.sin(now / a.beat + a.phase)) * S * k;
        return { q, r, a };
      });
      for (let i = 0; i < where.length; i += 1) {
        for (let j = i + 1; j < where.length; j += 1) {
          const A = where[i], B = where[j];
          if (Math.hypot(A.q.x - B.q.x, A.q.y - B.q.y) > (A.r + B.r) * (1.8 + 2.2 * grow)) continue;
          ctx.lineWidth = Math.min(A.r, B.r) * (0.7 + 0.5 * grow);
          ctx.beginPath(); ctx.moveTo(A.q.x, A.q.y); ctx.lineTo(B.q.x, B.q.y); ctx.stroke();
        }
      }
      for (const { q, r } of where) { ctx.beginPath(); ctx.ellipse(q.x, q.y + r * 0.2, r * 1.25, r, 0, 0, TAU); ctx.fill(); }
      // Glowing from inside: the slime lit through, brightest at its heart.
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(110,255,90,${0.5 * k})`; ctx.lineWidth = (0.8 + 0.8 * grow) * S;
      for (const seg of c.segs) { path(seg.map((p) => screenOf(place, p)), false); ctx.stroke(); }
      for (const { q, r } of where) {
        const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r * 1.6);
        g.addColorStop(0, `rgba(150,255,110,${0.55 * k})`); g.addColorStop(1, 'rgba(60,200,60,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 1.6, 0, TAU); ctx.fill();
      }
      ctx.restore();
      for (const { q, r, a } of where) {
        ctx.fillStyle = `rgba(230,255,200,${0.75 * k})`;
        ctx.beginPath(); ctx.ellipse(q.x - r * 0.45, q.y - r * 0.25, r * 0.28, r * 0.16, -0.4, 0, TAU); ctx.fill();
        a.timer -= dt;
        if (a.timer <= 0 && c.fx.filter((f) => f.kind === 'drip').length < 8) {
          c.fx.push({ kind: Math.random() < 0.55 ? 'drip' : 'bubble', p: a.p, life: 0, size: rand(2, 3.6), fall: 0, v: 0, snapped: 0 });
          a.timer = rand(1.5, 5);
        }
      }
      // Smoke curling up off it, and glowing motes drifting.
      if (Math.random() < dt * 5 && c.fx.filter((f) => f.kind === 'smoke').length < 14) {
        const a = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        c.fx.push({ kind: 'smoke', p: a.p, life: 0, curl: rand(-1, 1), size: rand(3, 6), span: rand(2.4, 3.6) });
      }
      if (Math.random() < dt * 9 && c.fx.filter((f) => f.kind === 'mote').length < 30) {
        const a = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        c.fx.push({ kind: 'mote', p: a.p, life: 0, drift: rand(-6, 6), size: rand(0.6, 1.4) });
      }
      const gloop = (x, y, r, stretch) => {
        const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r * 1.5);
        g.addColorStop(0, `rgba(200,255,150,${0.95 * k})`); g.addColorStop(0.45, `rgba(70,200,60,${0.95 * k})`); g.addColorStop(1, `rgba(20,90,24,${0.97 * k})`);
        ctx.fillStyle = g;
        ctx.save(); ctx.translate(x, y); ctx.scale(1, -1); teardrop(0, 0, r * 2, r * (2 + stretch)); ctx.restore();
        ctx.fill();
        ctx.fillStyle = `rgba(235,255,210,${0.75 * k})`;
        ctx.beginPath(); ctx.ellipse(x - r * 0.35, y + r * 0.1, r * 0.25, r * 0.4, 0.3, 0, TAU); ctx.fill();
      };
      for (const f of c.fx) {
        f.life += dt;
        const q = screenOf(place, f.p);
        if (f.kind === 'drip') {
          const swell = clamp(f.life / 1.6);
          const r = f.size * (0.45 + 0.55 * swell) * S;
          if (f.life > 1.6) {
            if (!f.snapped) { f.fall += dt * (5 + f.fall * 0.9); if (f.fall > 12 + f.size * 3) f.snapped = f.life; }
            else { f.v += dt * 90; f.fall += f.v * dt; }
          }
          const y = q.y + f.fall * S + r;
          if (!f.snapped) {
            const w = Math.max(0.35, r * 0.9 * (1 - f.fall / 30));
            ctx.fillStyle = `rgba(40,140,40,${0.92 * k})`;
            ctx.beginPath();
            ctx.moveTo(q.x - r * 0.8, q.y);
            ctx.quadraticCurveTo(q.x - w * 0.5, (q.y + y) / 2, q.x - r * 0.7, y - r * 0.5);
            ctx.lineTo(q.x + r * 0.7, y - r * 0.5);
            ctx.quadraticCurveTo(q.x + w * 0.5, (q.y + y) / 2, q.x + r * 0.8, q.y);
            ctx.closePath(); ctx.fill();
          } else {
            const back = clamp((f.life - f.snapped) / 0.35);
            if (back < 1) {
              ctx.strokeStyle = `rgba(40,140,40,${0.9 * (1 - back) * k})`; ctx.lineWidth = 0.7 * S;
              ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x, q.y + (12 * S) * (1 - back) * (1 - back)); ctx.stroke();
            }
          }
          gloop(q.x, y, r, f.snapped ? Math.min(1.8, f.v / 40) : 0.4 + swell * 0.4);
        } else if (f.kind === 'bubble') {
          const rise = f.life * 4 * S, r = f.size * (0.5 + f.life * 0.4) * S;
          const y = q.y - rise;
          if (f.life < 2) {
            ctx.fillStyle = `rgba(80,210,70,${0.35 * k})`; ctx.beginPath(); ctx.ellipse(q.x, y, r * 1.08, r * 0.95, 0, 0, TAU); ctx.fill();
            ctx.strokeStyle = `rgba(170,255,110,${0.9 * k})`; ctx.lineWidth = 0.7 * S; ctx.stroke();
            ctx.fillStyle = `rgba(235,255,210,${0.85 * k})`; ctx.beginPath(); ctx.arc(q.x - r * 0.35, y - r * 0.35, r * 0.25, 0, TAU); ctx.fill();
          } else {
            const pop = clamp((f.life - 2) / 0.3);
            ctx.strokeStyle = `rgba(170,255,110,${0.8 * (1 - pop) * k})`; ctx.lineWidth = 0.7 * S;
            ctx.beginPath(); ctx.arc(q.x, y, r * (1 + pop * 0.8), 0, TAU); ctx.stroke();
          }
        } else if (f.kind === 'smoke') {
          // A wisp: a ribbon rising and curling over, widening and thinning out.
          const f0 = clamp(f.life / f.span);
          const pts = [];
          for (let i = 0; i <= 12; i += 1) {
            const u = i / 12, rise = (u * 26 * f0 + f.life * 4) * S;
            pts.push({ x: q.x + Math.sin(u * 4 + f.life * 1.6) * f.size * S * u + f.curl * u * u * 14 * S, y: q.y - rise });
          }
          const fade = Math.sin(f0 * Math.PI) * k;
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
          ctx.strokeStyle = `rgba(40,170,70,${0.16 * fade})`; ctx.lineWidth = f.size * 1.6 * S; path(pts, false); ctx.stroke();
          ctx.strokeStyle = `rgba(90,230,110,${0.22 * fade})`; ctx.lineWidth = f.size * 0.6 * S; path(pts, false); ctx.stroke();
          ctx.restore();
        } else {
          // A glowing mote, drifting up.
          const x = q.x + Math.sin(f.life * 2 + f.drift) * f.drift * S, y = q.y - f.life * 16 * S;
          const fade = Math.sin(clamp(f.life / 2) * Math.PI) * k;
          ctx.save(); ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgba(110,255,100,${0.3 * fade})`; ctx.beginPath(); ctx.arc(x, y, f.size * 2.8 * S, 0, TAU); ctx.fill();
          ctx.fillStyle = `rgba(210,255,190,${0.95 * fade})`; ctx.beginPath(); ctx.arc(x, y, f.size * S, 0, TAU); ctx.fill();
          ctx.restore();
        }
      }
      c.fx = c.fx.filter((f) => (f.kind === 'drip' ? f.fall < 70 : f.kind === 'bubble' ? f.life < 2.3 : f.kind === 'smoke' ? f.life < f.span : f.life < 2));
    },

    // Erode: the rings crumbling, grit breaking off and falling away.
    erode(c, place, k, now, dt, from, to) {
      if (Math.random() < dt * 20 && c.fx.length < 60) {
        const a = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        c.fx.push({ p: a.p, life: 0, v: 0, fall: 0, spin: rand(0, TAU), size: rand(1.1, 2.6), drift: rand(-4, 4), tone: Math.random() });
      }
      for (const g of c.fx) {
        g.life += dt; g.v += dt * 90; g.fall += g.v * dt;
        const q = screenOf(place, g.p);
        const x = q.x + g.drift * g.life * S, y = q.y + g.fall * S, s = g.size * S;
        ctx.save(); ctx.translate(x, y); ctx.rotate(g.spin + g.life * 4);
        // Pieces of the ring itself, in its own colour, greying as they fall.
        ctx.fillStyle = rgba(mix(mix(from, to, g.tone), [150, 140, 130], clamp(g.life / 1.4) * 0.6), 0.9 * (1 - clamp(g.life / 1.4)) * k);
        ctx.beginPath(); ctx.moveTo(-s, -s * 0.6); ctx.lineTo(s * 0.8, -s); ctx.lineTo(s, s * 0.7); ctx.lineTo(-s * 0.5, s); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      c.fx = c.fx.filter((g) => g.life < 1.4);
    },

    // Shine: the whole circle lit -- light filling it, pulsing -- and stars twinkling along its lines.
    shine(c, place, k, now) {
      const o = circlePoint(place, 0, 0);
      const edge = circlePoint(place, Math.max(...c.segs[0].map(([x]) => Math.abs(x))), 0);
      const R = Math.abs(edge.x - o.x) * 1.15;
      const pulse = 0.5 - 0.5 * Math.cos(now / 640);
      const light = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, R);
      light.addColorStop(0, `rgba(255,250,228,${(0.32 + 0.2 * pulse) * k})`);
      light.addColorStop(0.6, `rgba(255,244,210,${(0.14 + 0.1 * pulse) * k})`);
      light.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.save(); ctx.translate(o.x, o.y); ctx.scale(1, 0.62); ctx.translate(-o.x, -o.y);
      ctx.fillStyle = light; ctx.beginPath(); ctx.arc(o.x, o.y, R, 0, TAU); ctx.fill();
      ctx.restore();
      for (const a of c.anchors) {
        const tw = Math.sin(now / (a.beat * 0.35) + a.phase);
        if (tw < 0.55) continue;
        const { q } = outward(place, a.p);
        const r = (2.5 + 4.5 * a.size) * (tw - 0.55) / 0.45 * S;
        star(q.x, q.y, r * 2.2, 0.25 * k, [255, 240, 200]);
        star(q.x, q.y, r, 0.95 * k, [255, 255, 240]);
      }
    },

    // Fluctuate: an arcane surge -- lightning cracking across the circle as it sways.
    fluctuate(c, place, k, now, dt, from, to) {
      if (Math.random() < dt * 7 && c.fx.length < 6) {
        const a = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        const b = c.anchors[Math.floor(Math.random() * c.anchors.length)];
        if (a !== b) c.fx.push({ a: a.p, b: b.p, life: 0, seed: Math.random() * 100 });
      }
      for (const bolt of c.fx) {
        bolt.life += dt;
        const p0 = screenOf(place, bolt.a), p1 = screenOf(place, bolt.b);
        const pts = [p0];
        const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1, nx = -(p1.y - p0.y) / len, ny = (p1.x - p0.x) / len;
        for (let i = 1; i < 9; i += 1) {
          const f = i / 9, jag = (Math.sin(bolt.seed + i * 12.9 + Math.floor(now / 60)) * 0.5) * len * 0.12;
          pts.push({ x: lerp(p0.x, p1.x, f) + nx * jag, y: lerp(p0.y, p1.y, f) + ny * jag });
        }
        pts.push(p1);
        const f = (1 - clamp(bolt.life / 0.3)) * k;
        ctx.strokeStyle = rgba(mix(from, to, 0.5), 0.35 * f); ctx.lineWidth = 4 * S; path(pts, false); ctx.stroke();
        ctx.strokeStyle = rgba(mix(to, [255, 255, 255], 0.5), 0.9 * f); ctx.lineWidth = 1.1 * S; path(pts, false); ctx.stroke();
        ctx.strokeStyle = `rgba(255,255,255,${f})`; ctx.lineWidth = 0.45 * S; path(pts, false); ctx.stroke();
      }
      c.fx = c.fx.filter((b) => b.life < 0.3);
    },
  };

  /* ── the inkwell: a round flask of thick glass, the ink inside it ──────────
   * A round belly on the desk, a narrow neck, a rolled collar at its mouth;
   * its cork stood beside it. The glass is thick and drawn as thick glass
   * is seen: clear in the middle, dense and bright at its rim, the window's
   * light curved over its shoulder. The ink in its belly is the theme's
   * gradient, its colours mixed into one another, a bright line where it
   * meets the glass, rings where anything goes into it. */
  // In front of the book, to the right: within reach of the page, and on screen on a phone.
  const WELL = { x: PW * 0.74, y: -PH / 2 - 36, r: 15, zc: 14, neck: 5.5, collar: 7.2, collarH: 3.2 };
  WELL.neckFrom = WELL.zc + Math.sqrt(WELL.r * WELL.r - WELL.neck * WELL.neck);
  WELL.top = WELL.neckFrom + 6;
  const wellTop = () => WELL.top;
  // Where the nib is tapped after dipping: over the mouth, by its right-hand rim -- lifted, and touching.
  const RIM = { x: WELL.x + WELL.neck * 0.6, y: WELL.y + 0.8, lift: 11, touch: 3 };
  // The glass is this thick; the ink fills the belly to a little below its middle.
  const WALL = 2.4;
  const INK_Z = WELL.zc - 2.5;
  const INK_R = Math.sqrt((WELL.r - WALL) ** 2 - (INK_Z - WELL.zc) ** 2);
  // How far below the mouth the nib goes to be under it.
  const DIP = INK_Z - 3 - WELL.top;
  const GRAVITY = 160;
  const TAU = Math.PI * 2;
  // The quill's slant in the flask: near enough upright to go down the neck clear of the glass.
  const UPRIGHT = 0.08;
  const WHITE = [255, 255, 255];
  const CORK = { x: WELL.x - 27, y: WELL.y - 9 };
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
  // The belly on screen: a circle, as a sphere is from anywhere.
  function belly(radius = WELL.r) {
    const c = P(WELL.x, WELL.y, WELL.zc);
    return { c, R: Math.abs(P(WELL.x + radius, WELL.y, WELL.zc).x - c.x) };
  }

  /* The ink: the theme's gradient, its colours mixed into one another and
   * drifting slowly, as two inks poured together. */
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
  // The ink's outline in the belly: below its surface (the far half of it, or, front only, the near half).
  function inkShape(frontOnly) {
    const { c, R } = belly(WELL.r - WALL);
    const edge = frontOnly ? ellipsePts(WELL.x, WELL.y, INK_Z, INK_R, 28, Math.PI, TAU) : ellipsePts(WELL.x, WELL.y, INK_Z, INK_R, 28, 0, Math.PI).reverse();
    const level = edge[0].y;
    const pts = [{ x: c.x - R - 2, y: level }, ...edge, { x: c.x + R + 2, y: level }, { x: c.x + R + 2, y: c.y + R + 2 }, { x: c.x - R - 2, y: c.y + R + 2 }];
    return { c, R, pts };
  }
  function drawInk(from, to, t, frontOnly = false) {
    const { c, R, pts } = inkShape(frontOnly);
    ctx.save();
    // Inside the glass...
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TAU); ctx.clip();
    // ...below the ink's surface.
    path(pts); ctx.clip();
    inkMix(from, to, t, { x: c.x, y: c.y + R * 0.3 }, R, R * 0.75);
    // Deeper at the foot and towards the glass, where there is more of it to see through.
    const round = ctx.createRadialGradient(c.x - R * 0.2, c.y - R * 0.1, R * 0.3, c.x, c.y, R);
    round.addColorStop(0, 'rgba(0,0,0,0)'); round.addColorStop(1, 'rgba(0,0,0,.34)');
    ctx.fillStyle = round; ctx.fillRect(c.x - R, c.y - R, R * 2, R * 2);
    if (!frontOnly) {
      // Its surface: seen from above, a little lighter, a bright line round it where it meets the glass.
      const surface = ellipsePts(WELL.x, WELL.y, INK_Z, INK_R, 36);
      const s = screenEllipse(WELL.x, WELL.y, INK_Z, INK_R);
      ctx.save();
      path(surface); ctx.clip();
      inkMix(from, to, t + 7, s.c, s.rx, s.ry);
      ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(s.c.x - s.rx, s.c.y - s.ry, s.rx * 2, s.ry * 2);
      ctx.restore();
      ctx.strokeStyle = rgba(mix(to, WHITE, 0.4), 0.5); ctx.lineWidth = 0.7 * S;
      path(surface); ctx.stroke();
    }
    ctx.restore();
  }

  // The cork, stood on the desk beside the flask: a short tapered plug.
  function drawCork() {
    const { x, y } = CORK;
    const foot = ellipsePts(x, y, 0, 3.6, 18, Math.PI, TAU), head = ellipsePts(x, y, 6, 4.6, 18, TAU, Math.PI);
    const l = P(x - 4.6, y, 3), r = P(x + 4.6, y, 3);
    const side = ctx.createLinearGradient(l.x, 0, r.x, 0);
    side.addColorStop(0, '#5a3b22'); side.addColorStop(0.35, '#9a6b42'); side.addColorStop(0.6, '#b07d50'); side.addColorStop(1, '#4e321d');
    ctx.fillStyle = side; path(foot.concat(head)); ctx.fill();
    ctx.fillStyle = '#c4925f'; path(ellipsePts(x, y, 6, 4.6, 20)); ctx.fill();
    // Its fibres, down its side; and its top's rim, worn darker.
    ctx.strokeStyle = 'rgba(70,44,24,.45)'; ctx.lineWidth = 0.45 * S;
    for (const a of [3.5, 3.95, 4.4, 4.85, 5.3, 5.8]) {
      ctx.beginPath();
      const p0 = P(x + Math.cos(a) * 3.7, y + Math.sin(a) * 3.7, 0.8), p1 = P(x + Math.cos(a) * 4.5, y + Math.sin(a) * 4.5, 5.4);
      ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(90,58,32,.7)'; ctx.lineWidth = 0.6 * S;
    path(ellipsePts(x, y, 6, 4.6, 20)); ctx.stroke();
    const sh = P(x + 2, y - 2, 0);
    const shadow = ctx.createRadialGradient(sh.x, sh.y, 1, sh.x, sh.y, 8 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,.3)'); shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(sh.x, sh.y, 8 * S, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawWellBack(from, to, t) {
    const { x, y, r } = WELL;
    // Its shadow, a little of the ink's colour let through the glass into it.
    const s = P(x + 5, y - 4, 0);
    const shadow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, r * 1.9 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,.36)');
    shadow.addColorStop(0.55, rgba(mix(from, [0, 0, 0], 0.35), 0.18));
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.9 * S, 0, TAU); ctx.fill();
    drawCork();
    // The belly's far side, seen through the near: the glass tints what is behind it.
    const { c, R } = belly();
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TAU); ctx.fill();
    // The glass's inner face, a wall's thickness in, at the back.
    const inner = belly(r - WALL);
    ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 0.7 * S;
    ctx.beginPath(); ctx.arc(inner.c.x, inner.c.y, inner.R, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    drawInk(from, to, t);
    // The neck's far wall, inside.
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    path(ellipsePts(x, y, WELL.neckFrom - 1, WELL.neck, 20, 0, Math.PI).concat(ellipsePts(x, y, WELL.top, WELL.neck, 20, Math.PI, 0))); ctx.fill();
  }

  // The near glass: over the ink, and over a nib dipped in it -- clear, so the nib still shows.
  function drawWellFront(to) {
    const { x, y, r, neck, collar, collarH } = WELL;
    const { c, R } = belly();
    // The belly: clear in the middle, dense and bright at its rim, where the glass is seen edge on.
    const rim = ctx.createRadialGradient(c.x, c.y, R * 0.55, c.x, c.y, R);
    rim.addColorStop(0, 'rgba(255,255,255,.02)'); rim.addColorStop(0.72, 'rgba(255,255,255,.06)');
    rim.addColorStop(0.88, 'rgba(255,255,255,.16)'); rim.addColorStop(1, 'rgba(255,255,255,.3)');
    ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TAU); ctx.fill();
    // Its outline: a shade for a light page, a light for a dark one.
    for (const [stroke, width] of [['rgba(0,0,0,.28)', 2], ['rgba(255,255,255,.45)', 1]]) {
      ctx.strokeStyle = stroke; ctx.lineWidth = width * S;
      ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TAU); ctx.stroke();
    }
    // The glass's inner face at the front: a wall's thickness in.
    const inner = belly(r - WALL);
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 0.7 * S;
    ctx.beginPath(); ctx.arc(inner.c.x, inner.c.y, inner.R, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
    // The window's light, curved over its shoulder; a point of it; and its reflection low on the far side.
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.62)'; ctx.lineWidth = 2.2 * S;
    ctx.beginPath(); ctx.arc(c.x, c.y, R * 0.74, Math.PI * 1.08, Math.PI * 1.38); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    const dot = { x: c.x - R * 0.28, y: c.y - R * 0.66 };
    ctx.beginPath(); ctx.arc(dot.x, dot.y, 1.2 * S, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1.6 * S;
    ctx.beginPath(); ctx.arc(c.x, c.y, R * 0.8, Math.PI * 0.12, Math.PI * 0.38); ctx.stroke();
    // Where it sits on the desk: a flat of thick glass catching the light.
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1 * S;
    path(ellipsePts(x, y, 0.6, 6, 20, Math.PI * 1.1, Math.PI * 1.9), false); ctx.stroke();
    // The neck: a short tube of thick glass.
    const n0 = WELL.neckFrom - 1, n1 = WELL.top - collarH;
    const nl = P(x - neck, y, n0), nr = P(x + neck, y, n0);
    const tube = ctx.createLinearGradient(nl.x, 0, nr.x, 0);
    tube.addColorStop(0, 'rgba(255,255,255,.3)'); tube.addColorStop(0.25, 'rgba(255,255,255,.06)');
    tube.addColorStop(0.75, 'rgba(255,255,255,.06)'); tube.addColorStop(1, 'rgba(255,255,255,.32)');
    ctx.fillStyle = tube;
    path(ellipsePts(x, y, n0, neck, 20, Math.PI, TAU).concat(ellipsePts(x, y, n1, neck, 20, TAU, Math.PI))); ctx.fill();
    for (const [stroke, width] of [['rgba(0,0,0,.24)', 1.6], ['rgba(255,255,255,.42)', 0.8]]) {
      ctx.strokeStyle = stroke; ctx.lineWidth = width * S;
      for (const side of [[P(x - neck, y, n0), P(x - neck, y, n1)], [P(x + neck, y, n0), P(x + neck, y, n1)]]) { path(side, false); ctx.stroke(); }
    }
    // The collar: a thick rolled ring of glass round the mouth, lit along its top.
    const cl = P(x - collar, y, n1), cr = P(x + collar, y, n1);
    const roll = ctx.createLinearGradient(cl.x, 0, cr.x, 0);
    roll.addColorStop(0, 'rgba(255,255,255,.42)'); roll.addColorStop(0.3, 'rgba(255,255,255,.14)');
    roll.addColorStop(0.55, 'rgba(255,255,255,.24)'); roll.addColorStop(1, 'rgba(255,255,255,.4)');
    ctx.fillStyle = roll;
    path(ellipsePts(x, y, n1, collar, 24, Math.PI, TAU).concat(ellipsePts(x, y, WELL.top, collar, 24, TAU, Math.PI))); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.beginPath();
    for (const ring of [ellipsePts(x, y, WELL.top, collar, 28), ellipsePts(x, y, WELL.top, neck - 1.2, 28)]) ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.fill('evenodd');
    for (const [stroke, width] of [['rgba(0,0,0,.26)', 1.6], ['rgba(255,255,255,.6)', 0.9]]) {
      ctx.strokeStyle = stroke; ctx.lineWidth = width * S;
      path(ellipsePts(x, y, WELL.top, collar, 28)); ctx.stroke();
      path(ellipsePts(x, y, n1, collar, 24, Math.PI, TAU), false); ctx.stroke();
    }
    ctx.strokeStyle = rgba(to, 0.35); ctx.lineWidth = 0.6 * S;
    path(ellipsePts(x, y, WELL.top, neck - 1.2, 28)); ctx.stroke();
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
  function drawQuill(at, lean, from, to, wet = 0, upright = 0) {
    ctx.save();
    ctx.translate(at.x, at.y);
    // Slanted as it writes; stood up as it goes down into the flask, to pass through the mouth and not the glass.
    ctx.rotate(lerp(0.95 - lean, UPRIGHT, upright));
    ctx.scale(-S, S);
    // Along the quill, nib (0) to plume (-90); across it, x.
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    /* The feather: a vane each side of the spine, the trailing one broad and
     * the leading one narrow, curving away together towards the tip. Its
     * colours are the theme's, deeper towards the tip. */
    const spine = (v) => -0.9 * Math.pow(Math.max(0, (-v - 26) / 64), 2) * 6;   // its curve: x at a point v along it
    const outer = [], inner = [];
    for (let i = 0; i <= 24; i += 1) {
      const v = -26 - (64 * i) / 24;
      const f = i / 24;
      // Widest a third of the way up, closing to the tip; a softer start at the down.
      const width = Math.sin(Math.PI * Math.pow(f, 0.72)) ;
      outer.push({ x: spine(v) - (1.2 + 8.4 * width), y: v });
      inner.push({ x: spine(v) + (0.6 + 3.8 * width), y: v });
    }
    const vaneGrad = ctx.createLinearGradient(0, -26, 0, -90);
    vaneGrad.addColorStop(0, rgba(mix(to, WHITE, 0.15), 0.92));
    vaneGrad.addColorStop(0.55, rgba(mix(to, from, 0.5), 0.95));
    vaneGrad.addColorStop(1, rgba(mix(from, [0, 0, 0], 0.25), 0.97));
    ctx.fillStyle = vaneGrad;
    ctx.beginPath();
    ctx.moveTo(spine(-26), -26);
    outer.forEach((p) => ctx.lineTo(p.x, p.y));
    for (let i = inner.length - 1; i >= 0; i -= 1) ctx.lineTo(inner[i].x, inner[i].y);
    ctx.closePath(); ctx.fill();
    // Its edge, a shade darker, so it reads against a page of the same colours.
    ctx.strokeStyle = rgba(mix(from, [0, 0, 0], 0.45), 0.5); ctx.lineWidth = 0.55;
    ctx.stroke();
    // The barbs: fine lines from the spine out and up, a little lighter; and two splits where they have parted.
    for (const [side, edge] of [[-1, outer], [1, inner]]) {
      for (let i = 2; i < 23; i += 1) {
        const v = edge[i].y;
        const o = edge[i];
        const split = side < 0 && (i === 9 || i === 15);
        ctx.strokeStyle = split ? rgba(mix(from, [0, 0, 0], 0.6), 0.55) : rgba(mix(to, WHITE, 0.45), 0.28);
        ctx.lineWidth = split ? 0.7 : 0.4;
        ctx.beginPath();
        ctx.moveTo(spine(v), v);
        ctx.quadraticCurveTo((spine(v) + o.x) / 2, v - 1.5, o.x, o.y - 3.2);
        ctx.stroke();
      }
    }
    // The down at its foot: soft, loose, pale.
    ctx.strokeStyle = rgba(mix(to, WHITE, 0.55), 0.38); ctx.lineWidth = 0.45;
    for (let k = 0; k < 7; k += 1) {
      const v = -24 - k * 1.6, side = k % 2 ? 1 : -1, reach = 3 + (k % 3);
      ctx.beginPath(); ctx.moveTo(0, v);
      ctx.bezierCurveTo(side * reach * 0.4, v - 1, side * reach, v + 0.5, side * (reach + 1.2), v - 2.2);
      ctx.stroke();
    }
    // The spine: pale, tapering to nothing at the tip.
    for (let i = 0; i < 12; i += 1) {
      const v0 = -20 - (70 * i) / 12, v1 = -20 - (70 * (i + 1)) / 12;
      ctx.strokeStyle = `rgba(255,255,255,${(0.7 - 0.4 * (i / 12)).toFixed(3)})`;
      ctx.lineWidth = 1.5 - 1.1 * (i / 12);
      ctx.beginPath(); ctx.moveTo(spine(v0), v0); ctx.lineTo(spine(v1), v1); ctx.stroke();
    }

    /* The retainer: brass, rising to a crown of points the feather is set
     * into, a gem of the theme's colour in its face. */
    const brass = ctx.createLinearGradient(-2.2, 0, 2.2, 0);
    brass.addColorStop(0, '#6e5428'); brass.addColorStop(0.35, '#e6c67e'); brass.addColorStop(0.55, '#b8934c'); brass.addColorStop(1, '#5a4320');
    ctx.fillStyle = brass;
    ctx.beginPath();
    ctx.moveTo(-1.7, -17.2); ctx.lineTo(-2.3, -21.6);
    // The crown: four points, the feather between them.
    ctx.lineTo(-2.6, -24.2); ctx.lineTo(-1.6, -22.4); ctx.lineTo(-0.9, -24.8); ctx.lineTo(0, -22.6);
    ctx.lineTo(0.9, -24.8); ctx.lineTo(1.6, -22.4); ctx.lineTo(2.6, -24.2);
    ctx.lineTo(2.3, -21.6); ctx.lineTo(1.7, -17.2);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,14,.85)'; ctx.lineWidth = 0.4; ctx.stroke();
    for (const v of [-17.6, -21.4]) { ctx.beginPath(); ctx.moveTo(-2.1, v); ctx.lineTo(2.1, v); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,240,200,.9)';
    for (const x of [-2.6, -0.9, 0.9, 2.6]) { ctx.beginPath(); ctx.arc(x, x === -0.9 || x === 0.9 ? -24.8 : -24.2, 0.32, 0, TAU); ctx.fill(); }
    const gem = ctx.createRadialGradient(-0.3, -19.8, 0.1, 0, -19.5, 1.1);
    gem.addColorStop(0, 'rgba(255,255,255,.95)'); gem.addColorStop(0.35, rgba(mix(from, WHITE, 0.2), 1)); gem.addColorStop(1, rgba(mix(from, [0, 0, 0], 0.4), 1));
    ctx.fillStyle = gem; ctx.beginPath(); ctx.ellipse(0, -19.5, 0.95, 1.25, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,14,.9)'; ctx.lineWidth = 0.35; ctx.stroke();

    /* The grip: dark leather, bound round with brass thread. */
    const leather = ctx.createLinearGradient(-1.6, 0, 1.6, 0);
    leather.addColorStop(0, '#2a1a10'); leather.addColorStop(0.4, '#7a4e2e'); leather.addColorStop(0.6, '#5c3a22'); leather.addColorStop(1, '#22150c');
    ctx.fillStyle = leather;
    ctx.beginPath(); ctx.moveTo(-1.5, -10.3); ctx.lineTo(-1.7, -17.4); ctx.lineTo(1.7, -17.4); ctx.lineTo(1.5, -10.3); ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(214,176,98,.75)'; ctx.lineWidth = 0.3;
    for (let v = -10; v > -18.5; v -= 1.15) { ctx.beginPath(); ctx.moveTo(-1.8, v); ctx.lineTo(1.8, v - 0.9); ctx.stroke(); }
    ctx.restore();

    /* The collar the nib is set in: a ring of brass. */
    ctx.fillStyle = brass;
    ctx.beginPath(); ctx.moveTo(-1.35, -8.6); ctx.lineTo(-1.6, -10.4); ctx.lineTo(1.6, -10.4); ctx.lineTo(1.35, -8.6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,14,.85)'; ctx.lineWidth = 0.35; ctx.stroke();

    /* The nib: steel to its point, gold over its shoulders, an engraved
     * scroll on the gold, a slit up its middle to a heart-shaped breather --
     * and, dipped, wet with ink from its point up. */
    const nib = () => { ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-1.5, -4, -1.3, -8.7); ctx.lineTo(1.3, -8.7); ctx.quadraticCurveTo(1.5, -4, 0, 0); ctx.closePath(); };
    const steel = ctx.createLinearGradient(-1.4, 0, 1.4, 0);
    steel.addColorStop(0, '#5f646e'); steel.addColorStop(0.4, '#e4e8ef'); steel.addColorStop(0.6, '#a7adb8'); steel.addColorStop(1, '#4b505a');
    ctx.fillStyle = steel; nib(); ctx.fill();
    ctx.save(); nib(); ctx.clip();
    const gilt = ctx.createLinearGradient(-1.4, 0, 1.4, 0);
    gilt.addColorStop(0, '#7a5c26'); gilt.addColorStop(0.4, '#f0d58e'); gilt.addColorStop(0.6, '#c29a4e'); gilt.addColorStop(1, '#634a1e');
    ctx.fillStyle = gilt;
    ctx.beginPath(); ctx.moveTo(-2, -8.8); ctx.lineTo(-2, -5.6); ctx.quadraticCurveTo(0, -4.2, 2, -5.6); ctx.lineTo(2, -8.8); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(90,62,20,.75)'; ctx.lineWidth = 0.22;
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(side * 0.35, -7.9); ctx.bezierCurveTo(side * 1.1, -7.6, side * 1.1, -6.6, side * 0.5, -6.7); ctx.stroke(); }
    if (wet > 0.02) {
      const ink = ctx.createLinearGradient(0, 0, 0, -7);
      ink.addColorStop(0, rgba(from, 0.95 * wet)); ink.addColorStop(0.6, rgba(to, 0.7 * wet)); ink.addColorStop(1, rgba(to, 0));
      ctx.fillStyle = ink; ctx.fillRect(-2, -9, 4, 9.5);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(20,22,28,.9)'; ctx.lineWidth = 0.32;
    ctx.beginPath(); ctx.moveTo(0, -0.4); ctx.lineTo(0, -4.3); ctx.stroke();
    // The breather: a small heart, its point down to the slit.
    ctx.fillStyle = 'rgba(20,22,28,.92)';
    ctx.beginPath(); ctx.moveTo(0, -4.3);
    ctx.bezierCurveTo(-0.9, -4.9, -0.75, -5.9, 0, -5.45);
    ctx.bezierCurveTo(0.75, -5.9, 0.9, -4.9, 0, -4.3);
    ctx.fill();
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
    wet: 0,                 // ink on the nib: 1 out of the well, drying as it writes
    upright: 0,             // how far the quill is stood up, to go down into the flask
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
      // The ink on the nib drying as it writes: gone after a page or so.
      state.wet = Math.max(0, state.wet - dt * 0.07);
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
      if (stepMove(dt)) { state.phase = 'dip'; state.t = 0; state.tapped = 0; state.turned = false; }
    } else if (state.phase === 'dip') {
      // Under the ink: wet to the holder.
      if (state.nib.z < INK_Z) state.wet = 1;
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
      // Once a dip: the dip outlasts the turn now (the taps on the rim), and the turn was started again when it ended.
      if (!state.leaf && !state.turned && k > 0.3) {
        state.turned = true;
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
    /* Going into the flask the quill stands up. Slanted as it writes, a nib
     * down in the ink had its shaft out through the side of the glass: the
     * mouth is narrow and the nib goes deep. Over the mouth, the lower it
     * goes the straighter it stands -- and eased, so it turns rather than
     * snaps. */
    const overMouth = Math.hypot(state.nib.x - WELL.x, state.nib.y - WELL.y) < WELL.neck;
    const wantUpright = overMouth ? clamp((wellTop() + 8 - state.nib.z) / 8) : 0;
    state.upright = calm ? wantUpright : lerp(state.upright, wantUpright, clamp(dt * 9));
    // The glass in front of the quill -- or, the nib down in it, over the quill, the ink in front of it first.
    if (!inNeck) drawWellFront(to);
    drawQuill(nibScreen, lean, from, to, calm ? 0.6 : state.wet, state.upright);
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
