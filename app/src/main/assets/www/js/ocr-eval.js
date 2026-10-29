/* How right a reading of a picture is, measured against an answer key: the
 * text of the picture as a person has checked it, bubble by bubble.
 *
 * The key is written as the reader reads: one bubble (or caption, or block
 * of text) to a paragraph, paragraphs apart by a blank line, in the order
 * they are read. A reading is scored the same way, so the same numbers come
 * out for the same pair however often they are worked out.
 *
 * - CER: characters wrong (put in, left out or swapped) per character of
 *   the key. The measure that counts for Japanese, Chinese and Korean.
 * - WER: the same in words, for text written with spaces between them.
 * - Omitted: bubbles of the key not found in the reading at all.
 * - Duplicated: bubbles of the key the reading has more than once.
 * - Out of order: bubbles found, but not where they are read.
 *
 * Plain functions, no page or phone needed: the app runs them on the
 * phone's readings, and tools/ocr-eval.mjs on text files.
 */

/** Text made comparable: the same character in its two widths (Ａ, A),
 *  vertical and ordinary punctuation, counted as one; and space, which a
 *  reading of Japanese has none of and an answer key may, left out where
 *  the script does not use it. */
export function comparable(text, { spaces = 'auto' } = {}) {
  let out = String(text || '').normalize('NFKC');
  const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(out);
  const korean = /[가-힯]/.test(out);
  const drop = spaces === 'drop' || (spaces === 'auto' && cjk && !korean);
  out = drop ? out.replace(/\s+/g, '') : out.replace(/\s+/g, ' ').trim();
  return out;
}

/** The bubbles of a key or a reading: its paragraphs, each made comparable. */
export function unitsOf(text, options) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((part) => comparable(part, options))
    .filter(Boolean);
}

/**
 * Edits from one sequence to another, the fewest there are, counted by kind.
 * Two rows at a time, so a long page is no trouble.
 *
 * @returns { distance, substitutions, insertions, deletions }
 */
export function editCounts(reference, hypothesis) {
  const a = Array.isArray(reference) ? reference : [...String(reference || '')];
  const b = Array.isArray(hypothesis) ? hypothesis : [...String(hypothesis || '')];
  const n = b.length;
  // Each cell: [distance, substitutions, insertions, deletions].
  let previous = Array.from({ length: n + 1 }, (_, j) => [j, 0, j, 0]);
  for (let i = 1; i <= a.length; i++) {
    const current = [[i, 0, 0, i]];
    for (let j = 1; j <= n; j++) {
      const same = a[i - 1] === b[j - 1];
      const diagonal = previous[j - 1];
      const up = previous[j];          // a character of the key left out
      const left = current[j - 1];     // a character put in
      let best = [diagonal[0] + (same ? 0 : 1), diagonal[1] + (same ? 0 : 1), diagonal[2], diagonal[3]];
      if (up[0] + 1 < best[0]) best = [up[0] + 1, up[1], up[2], up[3] + 1];
      if (left[0] + 1 < best[0]) best = [left[0] + 1, left[1], left[2] + 1, left[3]];
      current.push(best);
    }
    previous = current;
  }
  const [distance, substitutions, insertions, deletions] = previous[n];
  return { distance, substitutions, insertions, deletions };
}

/** Characters wrong per character of the key; 0 is perfect. Over 1 when
 *  the reading has a good deal the key has not. */
export function cer(reference, hypothesis, options) {
  const ref = [...comparable(reference, options)];
  const hyp = [...comparable(hypothesis, options)];
  if (!ref.length) return hyp.length ? 1 : 0;
  return editCounts(ref, hyp).distance / ref.length;
}

/** Words wrong per word of the key; null for text with no spaces to tell
 *  its words apart by (Japanese, Chinese), where it means nothing. */
export function wer(reference, hypothesis) {
  const ref = String(reference || '').normalize('NFKC').trim();
  if (!hasWords(ref)) return null;
  const a = wordsOf(ref);
  const b = wordsOf(hypothesis);
  if (!a.length) return b.length ? 1 : 0;
  return editCounts(a, b).distance / a.length;
}

/** Whether text is written with spaces between its words. */
function hasWords(text) {
  return !(/[぀-ヿ㐀-鿿]/.test(text) && !/[ \t]/.test(text));
}

function wordsOf(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** How unlike two pieces of text are: 0 the same, 1 nothing alike. */
function unlike(a, b) {
  const ra = [...a];
  const rb = [...b];
  const longer = Math.max(ra.length, rb.length) || 1;
  return editCounts(ra, rb).distance / longer;
}

/**
 * The key's bubbles matched with the reading's: each of the reading's to
 * the key's it is most like, if like enough. A bubble the reading split
 * in two, or ran into the next, still matches by its larger part.
 */
function match(refUnits, hypUnits, { enough = 0.5 } = {}) {
  const owner = hypUnits.map((hyp) => {
    let best = -1;
    let bestScore = enough;
    refUnits.forEach((ref, i) => {
      // Like the bubble, or wholly within it, or holding all of it.
      let score = unlike(ref, hyp);
      if (hyp.length >= 2 && ref.includes(hyp)) score = Math.min(score, 0.2);
      if (ref.length >= 2 && hyp.includes(ref)) score = Math.min(score, 0.2);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  });
  return owner;
}

/** Of the bubbles found, how many must move to be in the key's order:
 *  those outside the longest run already in order. */
function outOfOrder(sequence) {
  const tails = [];
  for (const value of sequence) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < value) lo = mid + 1; else hi = mid;
    }
    tails[lo] = value;
  }
  return sequence.length - tails.length;
}

/**
 * Everything measured, for one reading against its key.
 *
 * @returns {
 *   cer, wer, characters, substitutions, insertions, deletions,
 *   units, omitted, duplicated, outOfOrder, extra
 * }
 */
export function score(reference, hypothesis, options) {
  const refUnits = unitsOf(reference, options);
  const hypUnits = unitsOf(hypothesis, options);
  // Characters: the whole text, bubble after bubble in reading order, so a
  // bubble out of place counts against it here as well as below.
  const ref = [...refUnits.join('')];
  const hyp = [...hypUnits.join('')];
  const counts = editCounts(ref, hyp);
  const owner = match(refUnits, hypUnits);
  const seen = new Map();
  for (const i of owner) if (i >= 0) seen.set(i, (seen.get(i) || 0) + 1);
  // A bubble the reading split in two is found twice, and is not a
  // duplicate: a duplicate is the bubble's whole text found again.
  let duplicated = 0;
  for (const [i, times] of seen) {
    if (times < 2) continue;
    const whole = hypUnits.filter((hyp, k) => owner[k] === i && unlike(refUnits[i], hyp) < 0.34).length;
    if (whole >= 2) duplicated++;
  }
  const firsts = [];
  const placed = new Set();
  owner.forEach((i) => { if (i >= 0 && !placed.has(i)) { placed.add(i); firsts.push(i); } });
  return {
    cer: ref.length ? counts.distance / ref.length : (hyp.length ? 1 : 0),
    wer: wer(refUnits.join('\n'), hypUnits.join('\n')),
    words: hasWords(refUnits.join('\n')) ? wordsOf(refUnits.join('\n')).length : 0,
    characters: ref.length,
    substitutions: counts.substitutions,
    insertions: counts.insertions,
    deletions: counts.deletions,
    units: refUnits.length,
    omitted: refUnits.length - seen.size,
    duplicated,
    outOfOrder: outOfOrder(firsts),
    extra: owner.filter((i) => i < 0).length,
  };
}

/** Several pictures' scores as one: the rates over all their characters
 *  together (not an average of rates, which a short page would sway). */
export function total(scores) {
  const list = (scores || []).filter(Boolean);
  const sum = (key) => list.reduce((n, s) => n + (s[key] || 0), 0);
  const characters = sum('characters');
  const errors = sum('substitutions') + sum('insertions') + sum('deletions');
  const withWords = list.filter((s) => s.wer !== null && s.wer !== undefined && s.words);
  const words = withWords.reduce((n, s) => n + s.words, 0);
  return {
    pictures: list.length,
    cer: characters ? errors / characters : 0,
    wer: withWords.length
      ? withWords.reduce((n, s) => n + s.wer * s.words, 0) / words
      : null,
    characters,
    substitutions: sum('substitutions'),
    insertions: sum('insertions'),
    deletions: sum('deletions'),
    units: sum('units'),
    omitted: sum('omitted'),
    duplicated: sum('duplicated'),
    outOfOrder: sum('outOfOrder'),
    extra: sum('extra'),
    ms: sum('ms'),
  };
}

/** A percentage, to one place. */
export const percent = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`);

/** The scores as a plain table, to be read or pasted anywhere. */
export function report(rows) {
  const head = ['', 'CER', 'WER', 'omitted', 'duplicated', 'out of order', 'extra', 'time'];
  const lines = rows.map(({ label, score: s }) => [
    label,
    percent(s.cer),
    percent(s.wer),
    `${s.omitted}/${s.units}`,
    String(s.duplicated),
    String(s.outOfOrder),
    String(s.extra),
    s.ms ? `${(s.ms / 1000).toFixed(1)}s` : '—',
  ]);
  const all = [head, ...lines];
  const widths = head.map((_, c) => Math.max(...all.map((row) => [...row[c]].length)));
  return all.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()).join('\n');
}
