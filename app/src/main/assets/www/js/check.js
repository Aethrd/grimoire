/* A book checked for missing or broken content.
 *
 * A port of epub_check.py, kept close to it. Not a judge of the writing: it
 * looks for what goes wrong when chapters are downloaded and packed --
 *
 *   numbering  gaps, repeats, out of order, typo'd numbers, restarts, title
 *              numbers that disagree with the text's, parts (1)(2)(4) or 上/下
 *              with one missing, arc numbers that jump
 *   content    empty, placeholder or locked chapters, very short or long ones,
 *              a second heading inside a chapter, chapters that end or start
 *              mid-sentence, the same text either side of a break, duplicates,
 *              a block repeated inside a chapter
 *   leftovers  site text (links, translator/Patreon/ads, prev/next, comment
 *              prompts), lines repeated at the start or end of many chapters
 *   file       broken characters or leftover HTML, missing pictures, a
 *              contents label used over and over, a wrong language tag
 *
 * "✗" almost certainly a problem, "?" to look at, "·" for information.
 *
 * The script reads an EPUB's files; here the book is read as the app keeps
 * it -- its chapters, its pictures -- which is the same text, already parsed.
 */

/* ── patterns ──────────────────────────────────────────────────────────── */

const CN_DIG = { 零: 0, 〇: 0, '○': 0, 一: 1, 壹: 1, 二: 2, 两: 2, 貳: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000 };
export function cn2int(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0; let sec = 0; let num = 0;
  for (const ch of s) {
    if (ch in CN_DIG) num = CN_DIG[ch];
    else if (ch in CN_UNIT) {
      const u = CN_UNIT[ch];
      if (u === 10000) { total += (sec + num) * u; sec = 0; num = 0; } else { sec += (num || 1) * u; num = 0; }
    } else return null;
  }
  return total + sec + num;
}

const CJK_NUM = '0-9零〇○一二两三四五六七八九十百千万壹貳贰叁拾佰仟萬';
const NUM_PATTERNS = [
  /(?:제\s*)?(\d+)\s*(?:화|회|편)(?![가-힣])/u,
  new RegExp(`第\\s*([${CJK_NUM}]+)\\s*[章话話回节節集篇幕]`, 'u'),
  /\b(?:chapter|chap|ch|episode|ep)\s*\.?\s*#?\s*(\d+)/iu,
];
/** Python's re.match: from the start only. */
const anchored = (rx) => new RegExp(`^(?:${rx.source})`, rx.flags.replace('g', ''));
const NUM_AT_START = NUM_PATTERNS.map(anchored);
const HEAD_LINE = [
  /^\s*(?:제\s*)?\d+\s*화(?:\s|$|[.:]).{0,40}$/u,
  new RegExp(`^\\s*第\\s*[${CJK_NUM}]+\\s*[章话話回节節](?:\\s|$|[：:]).{0,40}$`, 'u'),
  /^\s*(?:chapter|ch\.|episode)\s*\d+\b.{0,60}$/iu,
];
const TITLE_FALLBACK = /^\s*#?(\d{1,5})(?:\s*[.:)=\-–—]\s*\S|\s+\S|\s*$)/u;
const SPECIAL = new RegExp('(프롤로그|에필로그|서장|종장|후기|작가의\\s*말|공지|prologue|epilogue|afterword|foreword|preface|interlude|intermission|'
  + '序章|序幕|楔子|引子|尾声|尾聲|终章|終章|完本感言|上架感言|感言|后记|後記|あとがき|まえがき|プロローグ|エピローグ|登場人物|人物紹介|'
  + 'あらすじ|내용\\s*소개|작품\\s*소개|内容简介|简介|synopsis|table of contents|contents|目次|目录|목차|cover|表紙|封面|표지|'
  + 'copyright|about (?:the )?(?:author|illustrator|translator)|about j-novel|newsletter|credits|title page|illustrations?|'
  + 'characters|character list|\\bmap\\b|the story so far|bonus short story|奥付|著作権|版权|版權|저작권|판권)', 'iu');
const SIDE = /(외전|번외|특별\s*편|특외|side\s*stor(?:y|ies)|extra|bonus|番外|外传|外傳|外伝|後日談|後日譚|後話|閑話|幕間|SS\b|after\s*stor(?:y|ies)|afterstory)/iu;
const PART = /^(.*?)\s*[(（[［]\s*(\d+|[上中下](?:\s*[、,，]\s*[上中下])*|[一二三四五六七八九十]+)\s*[)）\]］]\s*$/u;
const PART_AFTER_NUM = new RegExp(`(?:第\\s*[${CJK_NUM}]+\\s*[章话話回节節]|\\d+\\s*화)\\s*\\(\\s*(\\d+|[上中下](?:\\s*[、,]\\s*[上中下])*|[一二三四五六七八九十]+)\\s*\\)`, 'du');
const PART_EN = /^(.*?)\s*[,:\-–—]?\s*\bpart\s*(\d+)\s*$/iu;
const ARC = /^\s*(\d+)\.\s*(\S.*?)\s*$/u;

const PLACEHOLDER = new RegExp('(coming soon|placeholder|not (yet )?available|this chapter is (locked|private|premium)|unlock (this|the) chapter|'
  + 'premium chapter|purch(?:ase)|log ?in to|sign in to|subscribe to read|access denied|just a moment|cloudflare|'
  + 'enable javascript|error 404|page not found|captcha|'
  + '준비\\s*중|유료|구매|결제|로그인|성인\\s*인증|이용권|대여|'
  + '订阅|付费|VIP章节|本章需要|请登录|正在手打|防盗章节|此章节|'
  + '有料|ログイン|購入|다운로드되지\\s*않|누락된\\s*회차|努力更新中|[報报]錯|催更|稍后刷新|稍後刷新)', 'iu');
const AUTHOR_NOTE = /(작품\s*후기|작가의\s*말|작가\s*후기|author'?s?\s*note|前書き|後書き|あとがき|作者的话|作者的話|作者有话说)/iu;
const NOTICE = /(공지|휴재|휴재\s*공지|연재\s*(?:중단|재개)|notice|announcement|hiatus|on break|請假|请假|休更|卡文|斷更|断更|更新(?:說明|说明|通知)|復更|复更|上架感言|お知らせ|休載|活動報告)/iu;
const JUNK = new RegExp('(https?://|www\\.[a-z]|\\b[a-z0-9-]+\\.(?:com|net|org|io|me|co|kr|cn|jp|xyz|info)\\b|'
  + 'translator\\s*:|editor\\s*:|proofreader\\s*:|\\bTL\\s*(?:note|:)|\\bT/N\\b|\\bED\\s*:|patreon|ko-?fi|discord\\.(?:gg|com)|(?:our|join|the)\\s+discord\\s+(?:server|channel)|'
  + 'previous chapter|next chapter|no (?:previous|next) chapter|table of contents|suggest an edit|'
  + 'read (?:the )?(?:latest|more) (?:chapters? )?(?:at|on)|read (?:it|this) (?:at|on) \\S+\\.(?:com|net|org)|support (?:us|me|the translator)|join our (?:discord|patreon|server|community)|'
  + 'novelupdates|wuxiaworld|webnovel\\.com|royalroad|'
  + '무단\\s*(?:전재|복제|배포)|다음\\s*화\\s*보기|이전\\s*화|선작|추천\\s*부탁|댓글\\s*부탁|'
  + '精校|最新章节|请收藏|本章未完|点击下一页|手机阅读|笔趣阁|求月票|求推荐票|求订阅|天才一秒|百度搜索|'
  + 'ブックマーク|ポイント評価|誤字報告|感想をお待ち|溫馨提示|温馨提示|加入書架|加入书架|我的書架|我的书架|VIP會員|VIP会员|章節報錯|章节报错|免廣告|免广告|書友|书友群)', 'iu');
const MOJIBAKE = /(�|Ã[\x80-\xbf¡-¿]|â€|Â\s|ì[\x80-\xbf]|ë[\x80-\xbf]|ê[\x80-\xbf]|ã[\x80-\xbf]|&(?:nbsp|amp|lt|gt|quot|#\d+);|<\/?(?:p|br|div|span)\b)/u;

const TERMINAL = new Set('.!?…。！？」』”’"\')）]】》〉〕~～—―-♪★☆*ㅋㅎㅠㅜㄷ:;>');
const KO_END = new Set('다요죠까네군지야어아고며서게데나자라니든걸해와과임음함됨듯중것뿐만도오여냐럼');
const LOWER_START = /^[a-z]/;
const CONT_START = /^[、。，,.;:)）」』]/;

const nfkc = (s) => String(s).normalize('NFKC');
const norm = (s) => nfkc(s).replace(/\s+/gu, '').toLowerCase();
const isSep = (s) => !/[\p{L}\p{N}_가-힣぀-ヿ一-鿿]/u.test(s);
const chars = (s) => Array.from(s);
const clip = (s, n = 90) => { const c = chars(String(s).replaceAll('\n', ' ')); return c.length <= n ? c.join('') : `${c.slice(0, n - 1).join('')}…`; };
const clipEnd = (s, n = 90) => { const c = chars(String(s).replaceAll('\n', ' ')); return c.length <= n ? c.join('') : `…${c.slice(-(n - 1)).join('')}`; };
const len = (s) => (/[\uD800-\uDFFF]/.test(s) ? chars(s).length : s.length);
const commas = (n) => Math.trunc(n).toLocaleString('en-US');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function findNum(s, fallback = false) {
  s = nfkc(s);
  for (const rx of NUM_PATTERNS) {
    const m = rx.exec(s);
    if (m) { const v = cn2int(m[1]); if (v !== null) return v; }
  }
  if (fallback) { const m = TITLE_FALLBACK.exec(s); if (m) return parseInt(m[1], 10); }
  return null;
}

export function scriptOf(text) {
  const c = { ko: 0, kana: 0, han: 0, latin: 0 };
  for (const ch of chars(text.slice(0, 200000))) {
    const o = ch.codePointAt(0);
    if (o >= 0xAC00 && o <= 0xD7A3) c.ko += 1;
    else if (o >= 0x3040 && o <= 0x30FF) c.kana += 1;
    else if (o >= 0x4E00 && o <= 0x9FFF) c.han += 1;
    else if (/^[A-Za-z]$/.test(ch)) c.latin += 1;
  }
  const tot = (c.ko + c.kana + c.han + c.latin) || 1;
  if (c.ko / tot > 0.3) return 'ko';
  if (c.kana / tot > 0.05) return 'ja';
  if (c.han / tot > 0.3) return 'zh';
  return 'en';
}

/* ── reading ───────────────────────────────────────────────────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', shy: '­' };
/** html.unescape, once over: an escaped entity ("&amp;nbsp;") comes out as the entity, as it would there. */
const unescape = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (all, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return all; }
  }
  return ENTITIES[e.toLowerCase()] ?? ENTITIES[e] ?? all;
});

/** A chapter's text, a line each: as the script reads an XHTML page. */
export function textLines(xhtml) {
  let body = String(xhtml || '').split(/<body\b[^>]*>/i).slice(1).join('') || String(xhtml || '');
  body = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  body = body.replace(/<(br|hr)\b[^>]*>|<\/(p|div|h[1-6]|li|blockquote|tr|section|header|figure|aside)>/gi, '\n');
  const t = unescape(body.replace(/<[^>]+>/g, ''));
  return t.replaceAll('　', ' ').split('\n').map((l) => l.trim()).filter(Boolean);
}

/* ── analysis ──────────────────────────────────────────────────────────── */

class Report {
  constructor() { this.items = []; }
  add(sev, where, msg, ...ex) { this.items.push({ sev, where, msg, excerpt: ex.filter(Boolean) }); }
}

function splitHeading(lines, title, bookTitle) {
  const heads = [];
  const bt = bookTitle ? norm(bookTitle) : null;
  const tn = norm(title);
  for (const l of lines.slice(0, 4)) {
    if (heads.length >= 3 || len(l) > 100) break;
    const nl = norm(l);
    if ((findNum(l) !== null && len(l) <= 100 && (len(l) <= 60 || NUM_AT_START.some((rx) => rx.test(nfkc(l)))))
      || (nl && tn.includes(nl)) || (ARC.test(l) && len(l) <= 40)
      || (SPECIAL.test(l) && len(l) <= 25) || (bt && nl.startsWith(bt)) || (SIDE.test(l) && len(l) <= 30)) {
      heads.push(l);
    } else break;
  }
  return [heads, lines.slice(heads.length)];
}

const ORDER = { 上: 1, 中: 2, 下: 3 };
/** A part marker's first (or last) piece, as a number: 2, 二, 中, 中、下. */
function pv(p, last = false) {
  const bits = String(p).split(/\s*[、,，]\s*/);
  const q = last ? bits[bits.length - 1] : bits[0];
  return q in ORDER ? ORDER[q] : /^\d+$/.test(q) ? parseInt(q, 10) : cn2int(q);
}

/**
 * The checks, over a book.
 *
 * @param book  { meta: { title, creator, language }, chapters: [{ file, title, lines, imgs }],
 *                toc: [[file, label]], names: Set of files, missingImgs: [[file, src]], coverDupes: [file] }
 * @returns { summary, items: [{ sev, where, msg, excerpt }], chapters }
 */
export function analyse(book, { quiet = false, showAll = false } = {}) {
  const R = new Report();
  const meta = book.meta;
  const chs = book.chapters.map((c) => ({ ...c }));
  // Boilerplate: a short line repeated near the start or end of many chapters (site UI, prev/next, ads).
  const edge = new Map();
  for (const c of chs) {
    const lines = c.lines;
    const seen = new Set();
    lines.forEach((l, k) => {
      const nl = norm(l);
      if (!nl || len(l) > 100 || isSep(l) || seen.has(nl)) return;
      seen.add(nl);
      let e = edge.get(nl);
      if (!e) { e = [0, 0, null]; edge.set(nl, e); }
      e[0] += 1; e[2] = e[2] || [c, l];
      if (k < 5 || k >= lines.length - 6) e[1] += 1;
    });
  }
  const thr = Math.max(5, 0.08 * chs.length);
  const boiler = new Map([...edge].filter(([nl, v]) => v[0] >= thr && v[1] >= 0.7 * v[0]
    && !(meta.title && nl === norm(meta.title)) && findNum(v[2][1]) === null));
  const site = (l) => boiler.has(norm(l)) || (JUNK.test(l) && len(l) < 160);
  chs.forEach((c, at) => {
    c.i = at + 1;
    const L = c.lines;
    let st = 0;   // site lines above the heading
    while (st < Math.min(4, L.length) && site(L[st])) st += 1;
    [c.heads, c.body] = splitHeading(L.slice(st), c.title, meta.title);
    const b = c.body;   // the story: the body without site text at its end
    let en = b.length;
    for (let k = Math.max(0, b.length - 8); k < b.length; k += 1) if (site(b[k])) { en = k; break; }
    let st2 = 0;
    for (let k = 0; k < Math.min(3, en); k += 1) if (site(b[k])) st2 = k + 1;
    const story = b.slice(st2, en);
    c.story = story.length ? story : b;
    c.label = c.title || (c.heads.length ? c.heads[0] : c.file.split('/').pop());
    c.size = len(c.story.join('').replace(/\s/gu, ''));
    const labAll = [c.title, ...c.heads].join(' ');
    c.special = SPECIAL.test(labAll) && findNum(labAll) === null;
    c.side = SIDE.test(labAll);
    c.nTitle = c.title ? findNum(c.title, true) : null;
    c.nText = null;
    for (const h of c.heads) { const n = findNum(h); if (n !== null && !ARC.test(h)) { c.nText = n; break; } }
    let part = null;
    let base = null;
    for (let cand of [c.heads.length ? c.heads[c.heads.length - 1] : '', c.title, ...c.heads.slice(0, -1)]) {
      cand = String(cand || '').replace(/(?<=[)）])\s*\d[\d,]*$/u, '');   // a word count glued after "(3)"
      let m = PART.exec(cand) || PART_EN.exec(cand);
      if (m) { [, base, part] = m; break; }
      m = PART_AFTER_NUM.exec(nfkc(cand));
      if (m) { base = cand.slice(0, m.indices[1][0]) + cand.slice(m.indices[0][1]); part = m[1]; break; }
    }
    if (base === null) base = c.heads.length ? c.heads[c.heads.length - 1] : c.title;
    base = nfkc(base || '').replace(new RegExp(`^[^\\p{L}\\p{N}_]*\\d+\\s*[.:：]|\\d+\\s*화|第\\s*[${CJK_NUM}]+\\s*[章话話回节節]|\\b(?:chapter|ch|episode|ep)\\.?\\s*\\d+`, 'giu'), '');
    if (meta.title) base = base.replaceAll(nfkc(meta.title), '');
    c.part = part;
    c.base = norm(base);
    const arc = c.heads.map((h) => ARC.exec(h)).find((m, k) => m && findNum(c.heads[k]) === null);
    c.arc = arc ? [parseInt(arc[1], 10), PART.exec(arc[2]) ? PART.exec(arc[2])[1] : arc[2]] : null;
  });
  const W = (c) => `#${c.i} ${clip(c.label, 50)}`;
  const sizes = chs.filter((c) => c.size > 0 && !c.special).map((c) => c.size);
  const med = sizes.length ? median(sizes) : 0;
  for (const c of chs) {   // placeholders and notices: said, but kept out of the numbering check
    const txt = c.story.join(' ');
    c.ph = c.size > 0 && c.size < Math.max(1500, 0.3 * med) ? (PLACEHOLDER.exec(txt)?.[0] ?? null) : null;
    c.notice = NOTICE.test(`${c.title} ${c.heads.join(' ')}`) && c.size < 0.6 * med;
  }
  const lang = scriptOf(chs.slice(0, 50).flatMap((c) => c.body).join(''));

  // ── which numbering is the real one
  const textCov = chs.filter((c) => c.nText !== null).length;
  const primary = textCov >= 0.5 * chs.length && textCov >= 3 ? 'nText' : 'nTitle';
  const other = primary === 'nText' ? 'nTitle' : 'nText';
  const srcName = { nText: 'numbers printed in the chapter text', nTitle: 'chapter titles' };

  // ── the sequence (main and side stories apart, restarts allowed)
  const seqCheck = (seq, label, r) => {
    let prev = null; let prevpart = null; let i = 0;
    while (i < seq.length) {
      const c = seq[i]; const n = c[primary];
      if (prev === null) {
        if (n !== 0 && n !== 1) r.add('?', W(c), `${label}numbering starts at ${n} (chapters before it missing?)`);
        prev = n; prevpart = c.part; i += 1; continue;
      }
      if (n === prev + 1) { /* in order */ } else if (n === prev) {
        const ok = c.part && (prevpart ? pv(c.part) > pv(prevpart, true) : pv(c.part) >= 2);
        if (!ok) r.add('✗', W(c), `${label}number ${n} appears twice in a row (duplicate, or a mislabelled chapter)`, `previous: ${clip(seq[i - 1].label, 60)}`);
      } else {
        const exp = prev + 1;
        let j = null;
        for (let jj = i + 1; jj < Math.min(i + 12, seq.length); jj += 1) if (seq[jj][primary] === exp + (jj - i)) { j = jj; break; }
        let all = j !== null;
        if (all) for (let k = i; k < j; k += 1) if (seq[k][primary] === exp + (k - i)) { all = false; break; }
        if (j !== null && all) {
          for (let k = i; k < j; k += 1) r.add('✗', W(seq[k]), `${label}says ${seq[k][primary]} but sits where ${exp + (k - i)} should be (typo in the number?)`);
          prev = exp + (j - i) - 1; prevpart = seq[j - 1].part; i = j; continue;
        }
        if (n > prev + 1) {
          const miss = [];
          for (let m = prev + 1; m < n; m += 1) miss.push(m);
          r.add('✗', W(c), `${label}GAP — missing ${miss.length} chapter(s): ${miss.length <= 15 ? miss.join(', ') : `${miss[0]}–${miss[miss.length - 1]}`}`,
            `before it: ${clip(seq[i - 1].label, 60)}`);
        } else if (n === 0 || n === 1) {
          r.add('·', W(c), `${label}numbering restarts at ${n} (new volume / season?)`);
        } else {
          r.add('✗', W(c), `${label}goes back from ${prev} to ${n} (duplicate or out of order)`);
        }
      }
      prev = n; prevpart = c.part; i += 1;
    }
  };
  // Side stories share the main numbering or have their own; notices and placeholders may or may
  // not carry a number. Each reading tried; the one with the fewest problems kept.
  const score = (r) => r.items.filter((x) => x.sev === '✗').length * 10 + r.items.length;
  let best = null;
  for (const keepExtra of [true, false]) {
    const allnum = chs.filter((c) => c[primary] !== null && c.size > 0 && (keepExtra || !(c.ph || c.notice)));
    const mn = allnum.filter((c) => !c.side);
    const sd = allnum.filter((c) => c.side);
    for (const split of sd.length ? [false, true] : [false]) {
      const r = new Report();
      if (split) { seqCheck(mn, '', r); seqCheck(sd, 'side story ', r); } else seqCheck(allnum, '', r);
      if (best === null || score(r) < score(best[0])) best = [r, split ? mn : allnum, split ? sd : []];
    }
  }
  const [, main, side] = best;
  const nbad = best[0].items.filter((x) => x.sev === '✗');
  if (!showAll && nbad.length > Math.max(8, 0.1 * main.length)) {
    R.add('✗', '', `chapter numbering is inconsistent throughout (${nbad.length} breaks in ${main.length} numbered chapters). `
      + 'The titles probably do not match the real chapters (auto-numbered files, chapters split across files, '
      + 'or several volumes joined). First few below.');
    R.items.push(...best[0].items.slice(0, 5));
  } else R.items.push(...best[0].items);
  const unnumbered = chs.filter((c) => c[primary] === null && !c.special && !c.side && !c.notice && !c.ph && c.size > 0);
  if (main.length && unnumbered.length) {
    for (const c of unnumbered.slice(0, 20)) {
      const alt = c[other];
      R.add(c.size > 300 ? '?' : '·', W(c), `no chapter number found${alt !== null && primary === 'nText' ? ` in the text (title says ${alt})` : ''}`,
        clip(c.story.length ? c.story[0] : ''));
    }
    if (unnumbered.length > 20) R.add('?', '', `…and ${unnumbered.length - 20} more chapters without a number`);
  }

  // ── title numbers against the text's
  const both = chs.filter((c) => c.nText !== null && c.nTitle !== null);
  if (both.length && primary === 'nText') {
    const runs = [];
    for (const c of both) {
      const d = c.nTitle - c.nText;
      if (runs.length && runs[runs.length - 1][0] === d) runs[runs.length - 1][2] = c;
      else runs.push([d, c, c]);
    }
    const bad = runs.filter((r) => r[0] !== 0);
    for (const [d, a, b] of bad.slice(0, 10)) {
      R.add('?', `#${a.i}–#${b.i}`, `chapter title/contents number is ${d > 0 ? '+' : ''}${d} from the number printed in the text`,
        `e.g. title "${clip(a.title, 40)}" / text "${clip(a.heads.length ? a.heads[0] : '', 40)}"`);
    }
    if (bad.length > 10) R.add('?', '', `…${bad.length - 10} more stretches where title and text numbers disagree`);
  }

  // ── parts (1)(2)(3) / 上中下
  for (let k = 0; k + 1 < chs.length; k += 1) {
    const a = chs[k]; const b = chs[k + 1];
    if (!b.part) continue;
    const same = (a.base === b.base && a.base) || (a.arc && b.arc && a.arc[0] === b.arc[0]);
    if (same && a.part) {
      const pa = pv(a.part, true); const pb = pv(b.part);
      if (a.part[0] in ORDER && b.part[0] in ORDER) {
        if (pb <= pa) R.add('✗', W(b), `part order ${a.part} → ${b.part}`);
      } else if (pb !== pa + 1) R.add('✗', W(b), `part (${a.part}) is followed by (${b.part})${pb > pa + 1 ? ' — part missing' : ''}`);
    } else if (!same && !['1', '上', '一'].includes(b.part) && pv(b.part) > 1 && !(a.part && pv(b.part) === pv(a.part, true) + 1)
      && !(a.base && b.base.startsWith(chars(a.base).slice(0, 4).join('')) && !a.part)) {
      R.add('?', W(b), `starts at part (${b.part}) — earlier part missing or renamed?`, `previous: ${clip(a.label, 60)}`);
    }
  }

  // ── arcs "12. name"
  const arcs = chs.filter((c) => c.arc);
  if (arcs.length >= Math.max(3, 0.3 * chs.length)) {
    for (let k = 0; k + 1 < arcs.length; k += 1) {
      const a = arcs[k]; const b = arcs[k + 1];
      if (b.arc[0] !== a.arc[0] && b.arc[0] !== a.arc[0] + 1) {
        const jump = b.arc[0] > a.arc[0] + 1;
        R.add(jump ? '✗' : '?', W(b), `arc number jumps ${a.arc[0]} → ${b.arc[0]}${jump ? ' (arc missing?)' : ''}`);
      }
    }
  }

  // ── sizes, placeholders
  const longs = []; const stubNotices = [];
  for (const c of chs) {
    const txt = c.story.join(' ');
    if (c.size === 0) {
      if (c.imgs) continue;
      R.add(!c.special ? '✗' : '?', W(c), 'EMPTY chapter (no text)');
      continue;
    }
    const ph = c.ph;
    if (ph && findNum(c.title) === null && c.nText === null && !c.special && c.title) { stubNotices.push(c); continue; }
    if (c.notice && !ph) { R.add('·', W(c), `author notice / announcement (${commas(c.size)} chars)`, clip(txt, 100)); continue; }
    if (ph) { R.add('✗', W(c), `looks like a placeholder / locked page ("${ph}"), ${c.size} chars`, clip(txt, 120)); continue; }
    if (med && !c.special && c.size < 0.25 * med) {
      R.add(c.size < 0.12 * med && c.i > 1 ? '✗' : '?', W(c), `very short: ${commas(c.size)} chars (typical ${commas(med)})`, clip(txt, 120));
    } else if (med && !c.special && c.size < 0.5 * med) {
      R.add('?', W(c), `short: ${commas(c.size)} chars (typical ${commas(med)})`, `ends: ${clipEnd(c.story[c.story.length - 1])}`);
    } else if (med && c.size > 2.3 * med) longs.push(c);
  }
  if (stubNotices.length) {
    R.add('?', '', `${stubNotices.length} un-numbered page(s) are only a site placeholder ("${stubNotices[0].ph}") — `
      + `usually author notices (leave notes, announcements), not story: ${stubNotices.slice(0, 6).map((c) => `#${c.i} ${clip(c.title, 20)}`).join(', ')}`
      + (stubNotices.length > 6 ? ' …' : ''));
  }
  if (longs.length && longs.length <= Math.max(3, 0.01 * chs.length)) {
    for (const c of longs) R.add('?', W(c), `very long: ${commas(c.size)} chars (typical ${commas(med)}) — two chapters merged?`);
  } else if (longs.length) {
    R.add('·', '', `${longs.length} chapters are over twice the typical length (book mixes whole and split chapters?) — `
      + `e.g. ${longs.slice(0, 8).map((c) => `#${c.i}`).join(', ')}`);
  }

  // ── a second heading inside a chapter
  for (const c of chs) {
    if (c.special) continue;
    for (let k = 0; k < c.story.length; k += 1) {
      const l = c.story[k];
      if ((len(l) <= 70 && HEAD_LINE.some((rx) => rx.test(nfkc(l))))
        || (meta.title && norm(l).startsWith(norm(meta.title)) && findNum(l) !== null)) {
        R.add('✗', W(c), `chapter heading in the middle of the chapter (story line ${k + 1} of ${c.story.length}) — merged chapters?`, clip(l));
        break;
      }
    }
  }

  const pdfpages = chs.filter((c) => /^\s*pages?\s*\d+/i.test(c.title)).length >= 0.5 * chs.length && chs.length > 0;
  if (pdfpages) {
    R.add('?', '', 'chapters are PDF page ranges ("Pages 1–20"), not story chapters — endings are not checked. '
      + 'For a Syosetu PDF, add it in Build with Syosetu PDF pressed.');
  }
  // ── endings and starts
  const badEnd = (s) => {
    s = s.trimEnd();
    if (!s || isSep(s) || /(完|完结|完結|끝|완결|\bend|\bfin|つづく|続く|未完待续|待续)[^\p{L}\p{N}_]*$/iu.test(s)) return false;
    const lastCh = chars(s).pop();
    const ch = TERMINAL.has(lastCh) ? lastCh : (chars(nfkc(lastCh)).pop() || lastCh);
    if (TERMINAL.has(ch)) return ',，、'.includes(ch);
    if (lang === 'ko' && KO_END.has(ch)) return false;
    return true;
  };
  for (let k = 0; k < chs.length; k += 1) {
    const a = chs[k]; const b = chs[k + 1] || null;
    if (!a.story.length || a.special || pdfpages) continue;
    const last = a.story[a.story.length - 1];
    const e = badEnd(last) || ',，、'.includes(chars(last.trimEnd()).pop() || '');
    const s = !!(b && b.story.length && (LOWER_START.test(b.story[0]) || CONT_START.test(b.story[0])));
    if (e && s) {
      R.add('✗', W(a), 'sentence runs over into the next chapter (split in the wrong place)', `ends:   ${clipEnd(last)}`, `next:   ${clip(b.story[0])}`);
    } else if (e) {
      R.add('?', W(a), 'ends without finishing the sentence (cut off, or author typo?)', `ends:   ${clipEnd(last)}`,
        b && b.story.length ? `next:   ${clip(b.story[0])}` : '');
    } else if (s) {
      R.add('?', W(b), 'starts mid-sentence (beginning cut off?)', `starts: ${clip(b.story[0])}`, `prev ends: ${clipEnd(last)}`);
    }
  }

  // ── overlap between neighbours, duplicate chapters, repeated blocks
  for (let k = 0; k + 1 < chs.length; k += 1) {
    const a = chs[k]; const b = chs[k + 1];
    const tail = a.story.slice(-6).map(norm).filter((l) => len(l) >= 15);
    const head = new Set(b.story.slice(0, 12).map(norm).filter((l) => len(l) >= 15));
    const hit = tail.filter((l) => head.has(l));
    if (hit.length) {
      const ex = clip(a.story.slice(-6).find((l) => norm(l) === hit[0]));
      if (hit.length >= 6) R.add('✗', W(b), `repeats ${hit.length} lines from the end of the previous chapter (overlap / double download)`, ex);
      else if (hit.length >= 4) R.add('?', W(b), `repeats ${hit.length} lines from the end of the previous chapter (long author recap, or double download?)`, ex);
      else R.add('·', W(b), `opens by repeating the last ${hit.length} line(s) of the previous chapter (usually an author recap)`, ex);
    }
  }
  const index = new Map();
  for (const c of chs) {
    c.pset = new Set(c.body.map(norm).filter((l) => len(l) >= 25));
    for (const p of c.pset) { if (!index.has(p)) index.set(p, new Set()); index.get(p).add(c.i); }
  }
  const seenPairs = new Set();
  for (const c of chs) {
    if (c.pset.size < 8) continue;
    const cnt = new Map();
    for (const p of c.pset) for (const j of index.get(p)) if (j !== c.i) cnt.set(j, (cnt.get(j) || 0) + 1);
    for (const [j, k] of cnt) {
      const pair = `${Math.min(c.i, j)}:${Math.max(c.i, j)}`;
      if (k >= 0.6 * c.pset.size && !seenPairs.has(pair)) {
        seenPairs.add(pair);
        R.add('✗', W(c), `${Math.trunc((100 * k) / c.pset.size)}% of its text also appears in #${j} ${clip(chs[j - 1].label, 40)} (duplicate chapter?)`);
      }
    }
  }
  for (const c of chs) {
    const L = c.body.map(norm);
    const pos = new Map();
    for (let k = 0; k < L.length - 2; k += 1) {
      if (Math.min(len(L[k]), len(L[k + 1]), len(L[k + 2])) < 20) continue;
      const key3 = `${L[k]}\u0000${L[k + 1]}\u0000${L[k + 2]}`;
      if (pos.has(key3) && k - pos.get(key3) >= 3) {
        const j0 = pos.get(key3);
        let run = 3;
        while (k + run < L.length && j0 + run < k && L[j0 + run] === L[k + run]) run += 1;
        R.add(run >= 6 ? '✗' : '?', W(c), `${run} lines repeated inside the chapter (lines ${j0 + 1} and ${k + 1})`
          + (run >= 6 ? ' — duplicated text' : ' — callback or duplicated text?'), clip(c.body[k]));
        break;
      }
      if (!pos.has(key3)) pos.set(key3, k);
    }
  }

  // ── site leftovers
  const junkHits = new Map();
  for (const c of chs) {
    for (const l of [...c.heads, ...c.body]) {
      if (JUNK.test(l) && !(len(l) > 160 && !/https?:\/\/|www\./.test(l))) {
        const k = chars(norm(l)).slice(0, 80).join('');
        if (!junkHits.has(k)) junkHits.set(k, []);
        junkHits.get(k).push([c, l]);
      }
    }
  }
  const junkSorted = [...junkHits].sort((x, y) => y[1].length - x[1].length);
  for (const [, hits] of junkSorted.slice(0, 25)) {
    const [c, l] = hits[0];
    R.add('?', W(c) + (hits.length > 1 ? ` (+${hits.length - 1} more chapters)` : ''), 'site/translator text?', clip(l, 120));
  }
  if (junkHits.size > 25) R.add('?', '', `…${junkHits.size - 25} more different site-text lines`);
  for (const [nl, [n, , [, l]]] of [...boiler].sort((x, y) => y[1][0] - x[1][0])) {
    if (junkHits.has(nl)) continue;
    if (AUTHOR_NOTE.test(l)) R.add('·', '', `author's-note divider in ${n} chapters`, clip(l, 120));
    else R.add('?', '', `same line at the start/end of ${n} chapters (site boilerplate?)`, clip(l, 120));
  }

  // ── broken characters, leftover HTML
  const enc = [];
  for (const c of chs) for (const l of c.body) { const m = MOJIBAKE.exec(l); if (m) enc.push([c, l, m[0]]); }
  if (enc.length) {
    const [c, l, g] = enc[0];
    R.add(enc.some((x) => x[2].includes('�') || x[2].includes('Ã') || x[2].includes('â€')) ? '✗' : '?', W(c),
      `broken characters / leftover HTML in ${enc.length} line(s) (e.g. "${g}")`, clip(l, 120));
  }

  // ── pictures, contents, metadata
  for (const [p, src] of (book.missingImgs || []).slice(0, 10)) R.add('✗', p, `image missing from the file: ${src}`);
  for (const p of book.coverDupes || []) R.add('·', p, 'contains a copy of the cover image');
  const toc = book.toc || [];
  for (const [f, lab] of toc) if (book.names && !book.names.has(f)) R.add('✗', '', `contents entry points to a file that is not there: "${clip(lab, 50)}" → ${f}`);
  if (toc.length) {
    const tocFiles = new Set(toc.map(([f]) => f));
    const notin = chs.filter((c) => !tocFiles.has(c.file) && c.size > 0);
    if (notin.length) R.add('?', W(notin[0]), `${notin.length} chapter(s) not listed in the contents${notin.length > 1 ? ` (first: #${notin[0].i})` : ''}`);
    const labels = new Map();
    for (const [, lab] of toc) labels.set(lab, (labels.get(lab) || 0) + 1);
    const same = [...labels].filter(([, k]) => k >= 3).map(([lab]) => lab);
    if (same.length) R.add('·', '', `${same.length} contents label(s) used 3+ times (e.g. "${clip(same[0], 50)}") — unhelpful contents`);
  } else R.add('?', '', 'no contents (nav / ncx) found');
  const dl = (meta.language || '').toLowerCase().split('-')[0];
  if (dl !== lang) {
    R.add('?', '', `language tag is "${meta.language || 'missing'}" but the text is ${{ ko: 'Korean', ja: 'Japanese', zh: 'Chinese', en: 'English' }[lang]} (${lang})`);
  }
  if (!meta.creator) R.add('·', '', 'no author in the metadata');

  const nums = main.map((c) => c[primary]);
  const summary = {
    title: meta.title, author: meta.creator, language: meta.language, detected: lang,
    chapters: chs.length, numberedBy: srcName[primary], first: nums.length ? nums[0] : null, last: nums.length ? nums[nums.length - 1] : null,
    sideStories: side.length, special: chs.filter((c) => c.special).length, medianChars: Math.trunc(med),
    totalChars: chs.reduce((sum, c) => sum + c.size, 0),
  };
  if (quiet) R.items = R.items.filter((x) => x.sev !== '·');
  return { summary, items: R.items, chapters: chs };
}

/** The summary line under the title, as the script prints it. */
export function summaryLine(s) {
  return `${s.chapters} chapters`
    + (s.first !== null ? `, numbered ${s.first}–${s.last} (${s.numberedBy})` : '')
    + (s.sideStories ? `, ${s.sideStories} side stories` : '')
    + (s.special ? `, ${s.special} prologue/epilogue/other` : '')
    + `; typical chapter ${commas(s.medianChars)} chars, ${commas(s.totalChars)} in total`;
}

/** The report as text, as the script prints it. */
export function reportText(res) {
  const s = res.summary;
  const out = ['═'.repeat(78), `${s.title || ''}${s.author ? `  —  ${s.author}` : ''}`, summaryLine(s), '─'.repeat(78)];
  for (const [sev, head] of [['✗', 'PROBLEMS'], ['?', 'CHECK THESE'], ['·', 'NOTES']]) {
    const xs = res.items.filter((x) => x.sev === sev);
    if (!xs.length) continue;
    out.push('', `${head} (${xs.length})`);
    for (const x of xs) {
      out.push(` ${sev} ${x.where ? `[${x.where}] ` : ''}${x.msg}`);
      for (const e of x.excerpt) out.push(`      ${e}`);
    }
  }
  const np = res.items.filter((x) => x.sev === '✗').length;
  const nc = res.items.filter((x) => x.sev === '?').length;
  out.push('', !np && !nc ? 'No problems found.' : `${np} problem(s), ${nc} thing(s) to check.`);
  return `${out.join('\n')}\n`;
}

/** Every chapter's last lines and the next one's first: for a read of how they join. */
export function boundariesText(res) {
  const chs = res.chapters;
  const out = [`Chapter boundaries for ${res.summary.title} — last lines of each chapter and first lines of the next.`, ''];
  for (let k = 0; k + 1 < chs.length; k += 1) {
    const a = chs[k]; const b = chs[k + 1];
    out.push(`=== #${a.i} ${a.label}  →  #${b.i} ${b.label}`);
    for (const l of a.story.slice(-3)) out.push(`  … ${l}`);
    out.push('  ----');
    for (const l of b.story.slice(0, 3)) out.push(`  ${l}`);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}
