/* 小説家になろう (Syosetu) PDFs, turned into proper books.
 *
 * Syosetu lets a novel be saved as a PDF, set vertically; turned into an EPUB
 * that comes out as one long run of the PDF's pages -- page numbers in the
 * text, sentences cut in two at every page break, vertical punctuation
 * (﹁﹂︒︑) where the horizontal belongs, the line-wrap spaces of the page in
 * the middle of words, and no chapters. Made into one chapter per episode
 * (第N話 and its title), grouped by arc, its notes (前書き, 後書き) kept as
 * notes, its illustration tags (＜ｉ12345｜6789＞) as a marker, the PDF's own
 * notice and closing "発行 … URL" line left out -- and checked: every
 * character of the story is in what comes out, in order, or nothing comes out.
 *
 * Episode titles, which say where each episode starts, come from the novel's
 * contents page on the site (by the Nコード the PDF carries), or from the list
 * as pasted. Never guessed: a wrong guess cuts episodes in the wrong places.
 *
 * A port of syosetu_pdf2epub.py, which the reader wrote; kept close to it.
 */

import { readArrayBuffer } from './blobs.js';
import { pdfPages } from './pdf.js';

/* ── text ───────────────────────────────────────────────────────────── */

const VERT = {
  '︑': '、', '︒': '。', '︕': '！', '︖': '？', '︐': '，', '︓': '：', '︔': '；',
  '﹁': '「', '﹂': '」', '﹃': '『', '﹄': '』', '︵': '（', '︶': '）', '︷': '｛', '︸': '｝',
  '︹': '〔', '︺': '〕', '︻': '【', '︼': '】', '︽': '《', '︾': '》', '︿': '〈', '﹀': '〉',
  '﹇': '［', '﹈': '］', '︗': '〖', '︘': '〗', '︙': '…', '︰': '‥', '︱': '―', '︲': '–',
};
/** Vertical presentation forms to their horizontal ones. */
export function horiz(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (VERT[ch]) out += VERT[ch];
    else if (code >= 0xFE10 && code <= 0xFE4F) out += ch.normalize('NFKC');
    else out += ch;
  }
  return out;
}
/** To compare by: horizontal, NFKC, no whitespace, every wave dash alike. */
export function key(s) {
  return horiz(s).normalize('NFKC').replace(/\s/g, '').replace(/[~〜～]/g, '~');
}

const ILL = /[<＜][iｉ][0-9０-９]+[|｜][0-9０-９]+[>＞]/;
const ILL_ALL = new RegExp(ILL.source, 'g');
const TERM_END = [...'。！？」』）】》…―・', ...'︒︕︖﹂﹄︶︼︾︙'];
const NOSTART = new Set([...'、。，！？」』）】》っゃゅょぁぃぅぇぉゎッャュョァィゥェォヮー︑︒︕︖﹂﹄︶︼︾']);
const OPEN = new Set([...'﹁﹃︵「『（']);
const CLOSE = new Set([...'﹂﹄︶」』）']);
const NOTE_PRE = key('（前書き）');
const NOTE_POST = key('（後書き）');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescape = (s) => new DOMParser().parseFromString(`<!doctype html><body>${s}`, 'text/html').body.textContent || '';
const endsTerm = (s) => TERM_END.some((t) => s.endsWith(t));

/* ── the EPUB as it came ────────────────────────────────────────────── */

async function readEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const text = async (name) => zip.file(name)?.async('string') ?? null;
  const container = await text('META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(container || '')?.[1];
  if (!opfPath) throw new Error('not an EPUB (no package file)');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfText = await text(opfPath);
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  const manifest = new Map();
  for (const item of opf.getElementsByTagName('item')) {
    manifest.set(item.getAttribute('id'), { href: item.getAttribute('href'), properties: item.getAttribute('properties') || '' });
  }
  const at = (href) => {
    const parts = [];
    for (const piece of (base + decodeURI(href)).split('/')) {
      if (piece === '..') parts.pop();
      else if (piece && piece !== '.') parts.push(piece);
    }
    return parts.join('/');
  };
  const paras = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item) continue;
    const page = await text(at(item.href));
    if (!page) continue;
    const body = page.split('<body').slice(-1)[0];
    for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const t = unescape(m[1].replace(/<[^>]+>/g, '')).trim();
      if (t) paras.push(t);
    }
  }
  let cover = null;
  for (const item of manifest.values()) if (/cover-image/.test(item.properties)) cover = item.href;
  if (!cover) {
    const named = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    if (named && manifest.has(named)) cover = manifest.get(named).href;
  }
  const coverBytes = cover ? await zip.file(at(cover))?.async('uint8array') : null;
  const first = (tag) => opf.getElementsByTagNameNS('*', tag)[0]?.textContent || null;
  return { paras, cover: cover && coverBytes ? { name: cover, bytes: coverBytes } : null, ident: first('identifier'), title: first('title') };
}

/* ── the PDF's pages ────────────────────────────────────────────────── */

/* ── the PDF itself ─────────────────────────────────────────────────────
 *
 * Read straight from the PDF, as pdf.js gives its text: runs, positioned.
 * Syosetu sets a page in vertical columns, right to left; a paragraph's first
 * column one character down from the top, a blank line a column left empty,
 * a paragraph's last column short of the foot. Those make the blocks an
 * EPUB made from the PDF would have, one page at a time; furigana and
 * emphasis dots (the small runs beside a column) are left out, as are the
 * page numbers and the closing 発行 page.
 */

/** Between two paragraphs in one block; before a page's first block where a blank line was. Both whitespace to key(). */
const PARA = '\u2028';
const BLANK = '\u2029';
/** Before a page's first block where it goes on with the paragraph the last page ended in. */
const JOIN = '\u2007';

const mode = (values) => {
  const count = new Map();
  let best = null;
  let most = 0;
  for (const v of values) {
    const k = Math.round(v * 2) / 2;
    const n = (count.get(k) || 0) + 1;
    count.set(k, n);
    if (n > most) { most = n; best = k; }
  }
  return { best, count };
};

/** The PDF's pages (pdf.js runs { str, x, y, w, h, size }) as pages of blocks. */
export function pagesFromPdf(runs) {
  const solid = (r) => r.str.trim() !== '';
  const body = mode(runs.flat().filter(solid).map((r) => r.size)).best || 10;
  const upright = (r) => r.h > r.w * 1.2;
  const flat = (r) => r.w > r.h * 1.2;
  const vertical = (page) => {
    let v = 0;
    let h = 0;
    for (const r of page) if (solid(r)) { if (upright(r)) v += r.h; else if (flat(r)) h += r.w; }
    return v > h;
  };

  const columnsOf = (page) => {
    const kept = page.filter((r) => r.size >= body * 0.8);
    const digits = (r) => /^\d+$/.test(r.str.trim());
    const foot = Math.min(...kept.filter((r) => solid(r) && !digits(r)).map((r) => r.y - r.h));
    const cols = [];
    for (const r of kept) {
      if (digits(r) && r.y < foot) continue;   // the page number, below the columns
      let col = cols.find((c) => Math.abs(c.x - r.x) <= body * 0.5);
      if (!col) { col = { x: r.x, runs: [] }; cols.push(col); }
      col.runs.push(r);
    }
    return cols.filter((c) => c.runs.some(solid)).map((c) => {
      const ink = c.runs.filter(solid);
      return {
        x: c.x,
        // A space within a column is the text's own (Syosetu's 　); pdf.js gives it as a run of its own.
        text: [...c.runs].sort((a, b) => b.y - a.y).map((r) => (solid(r) ? r.str : '\u3000')).join('').trim(),
        top: Math.max(...ink.map((r) => r.y)),
        end: Math.min(...ink.map((r) => r.y - r.h)),
      };
    }).sort((a, b) => b.x - a.x);
  };

  const laid = runs.map((page) => (vertical(page) ? { cols: columnsOf(page) } : { lines: page }));
  const all = laid.flatMap((p) => p.cols || []);
  // Where a column starts and ends, and the columns' places, across the book.
  const enough = Math.max(3, all.length * 0.02);
  const common = (values) => [...mode(values).count].filter(([, n]) => n >= enough).map(([k]) => k);
  const top = Math.max(...common(all.map((c) => c.top)));
  const foot = mode(all.map((c) => c.end)).best;
  const right = Math.max(...common(all.map((c) => c.x)));
  const left = Math.min(...common(all.map((c) => c.x)));
  const pitch = mode(laid.flatMap((p) => (p.cols || []).slice(1).map((c, i) => p.cols[i].x - c.x))).best || body * 1.6;
  const indented = (c) => c.top < top - body * 0.5;
  const short = (c) => c.end > foot + body * 0.5;

  let before = null;   // the last page's last column, where it ran to the page's left edge
  return laid.map((p) => {
    if (p.lines) {
      before = null;
      const lines = [];
      for (const r of [...p.lines].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const line = lines.find((l) => Math.abs(l.y - r.y) <= body * 0.5);
        if (line) line.runs.push(r); else lines.push({ y: r.y, runs: [r] });
      }
      const text = lines.map((l) => l.runs.sort((a, b) => a.x - b.x).map((r) => r.str).join('').trim()).filter((t) => t && !/^\d+$/.test(t));   // a page number alone
      // Syosetu's closing page: the title, 発行 and the novel's address. Not the story.
      if (text.some((t) => t.includes('発行')) && text.some((t) => /syosetu\.com/.test(t))) return [];
      return text;
    }
    // A run of paragraphs between blank lines is a block, its paragraphs
    // apart by PARA; a paragraph's columns one run of text, the wrap known
    // from the page and so no space left for linesOf to guess by.
    const blocks = [];
    let block = null;
    let para = null;
    p.cols.forEach((c, i) => {
      const prev = p.cols[i - 1];
      if (!prev || prev.x - c.x > pitch * 1.5) { para = [c.text]; block = [para]; blocks.push(block); return; }
      if (indented(c) || short(prev)) { para = [c.text]; block.push(para); return; }
      para.push(c.text);
    });
    const out = blocks.map((b) => b.map((q) => q.join('').trim()).join(PARA)).filter(Boolean);
    // The first block, as it follows the page before: the same paragraph
    // going on, a new one with no blank line between, or after a blank line.
    const first = p.cols[0];
    if (out.length && first) {
      if (!before || right - first.x > pitch * 0.5) out[0] = BLANK + out[0];
      else out[0] = (indented(first) || short(before) ? PARA : JOIN) + out[0];
    }
    const last = p.cols[p.cols.length - 1];
    before = last && last.x - left < pitch * 0.5 ? last : null;
    return out;
  });
}

const isPdf = async (file) => String.fromCharCode(...new Uint8Array(await readArrayBuffer(file.slice(0, 5)))) === '%PDF-';

/** Running page numbers out; the pages, and the last page's number. */
export function splitPages(paras) {
  const pages = [[]];
  let expect = 1;
  const skipped = [];
  for (const p of paras) {
    if (p === String(expect) || (p === String(expect + 1) && pages[pages.length - 1].length > 0 && expect > 1)) {
      if (p === String(expect + 1)) { skipped.push(expect); expect += 1; }
      expect += 1;
      pages.push([]);
      continue;
    }
    pages[pages.length - 1].push(p);
  }
  return { pages, last: expect - 1, skipped };
}

/** The PDF's information page: title, ︻Ｎコード︼, ︻作者名︼. */
export function parseFront(blocks) {
  const info = {};
  const flat = blocks.slice(0, 60).join(' \n ');
  const code = /︻Ｎコード︼\s*\n?\s*([ＮNｎn][０-９0-9Ａ-Ｚａ-ｚA-Za-z]+)/.exec(flat);
  if (code) info.ncode = code[1].normalize('NFKC').toLowerCase();
  const author = /︻作者名︼\s*\n?\s*([\s\S]+?)\s*\n\s*︻/.exec(flat);
  if (author) info.author = author[1].replace(/\s*\n\s*/g, '').trim();
  const head = blocks.slice(0, 60).findIndex((b, i) => i > 0 && b.startsWith('︻Ｎコード︼'));
  if (head > 0) { info.title = blocks[head - 1].trim(); info.infoStart = head - 1; }
  return info;
}

/* ── the episodes, by the site's list ───────────────────────────────── */

const DATE_LINE = /^\s*\d{4}\/\d{1,2}\/\d{1,2}(\s+\d{1,2}:\d{2})?(\s*[（(]改[)）])?\s*$/;
/** A pasted list: a title a line, "# " before an arc's heading; dates and blank lines passed over. */
export function titlesFromText(text) {
  const eps = [];
  let arc = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || DATE_LINE.test(s)) continue;
    if (s.startsWith('# ')) { arc = s.slice(2).trim(); continue; }
    eps.push({ title: s, arc });
  }
  return eps;
}

const GENERIC = new Set(['1話目から読む', '続きを読む', '最新エピソードを読む', '最初から読む', 'しおりから読む']);
/** A contents page's arcs and episodes, in page order: old layout and new. */
export function parseTocHtml(page, ncode) {
  const items = [];
  for (const m of page.matchAll(/class="[^"]*(?:p-eplist__chapter-title|chapter_title)[^"]*"[^>]*>([\s\S]*?)<\//g)) {
    items.push([m.index, 'arc', unescape(m[1].replace(/<[^>]+>/g, '')).trim(), null]);
  }
  const link = new RegExp(`<a\\b([^>]*)href="/${ncode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d+)/"([^>]*)>([\\s\\S]*?)</a>`, 'gi');
  for (const m of page.matchAll(link)) {
    const attrs = m[1] + m[3];
    const before = page.slice(Math.max(0, m.index - 160), m.index);
    const text = unescape(m[4].replace(/<[^>]+>/g, '')).trim();
    if (!text || GENERIC.has(text)) continue;
    if (attrs.includes('subtitle') || before.includes('subtitle')) items.push([m.index, 'ep', text, Number(m[2])]);
  }
  items.sort((a, b) => a[0] - b[0]);
  return items.map(([, kind, text, no]) => ({ kind, text, no }));
}

/** The episode list from the site, page by page; `fetchText(url)` fetches one (paced by the app). */
export async function titlesFromWeb(ncode, fetchText) {
  for (const host of ['ncode.syosetu.com', 'novel18.syosetu.com']) {
    const eps = [];
    const seen = new Set();
    let arc = null;
    let page = 1;
    try {
      for (;;) {
        const html = await fetchText(`https://${host}/${ncode}/${page > 1 ? `?p=${page}` : ''}`);
        let added = 0;
        for (const { kind, text, no } of parseTocHtml(html, ncode)) {
          if (kind === 'arc') arc = text;
          else if (!seen.has(no)) { seen.add(no); eps.push({ title: text, arc, no }); added += 1; }
        }
        if (!added || !html.includes(`?p=${page + 1}"`)) break;
        page += 1;
      }
    } catch {
      continue;
    }
    if (eps.length) return { eps: eps.sort((a, b) => a.no - b.no), host };
  }
  return { eps: null, host: null };
}

/* ── where each episode is ──────────────────────────────────────────── */

const isHead = (b, keys) => {
  const k = key(b);
  if (keys.has(k)) return true;
  for (const t of keys) if (k.startsWith(t + NOTE_PRE) || k.startsWith(t + NOTE_POST)) return true;
  return false;
};

/** The pages as one run of blocks: a sentence cut by a page break, and a line-start character, joined back. */
export function joinBlocks(pages, keys) {
  const blocks = [];
  const pageFirst = new Set();
  let joined = 0;
  pages.forEach((page) => {
    page.forEach((b, bi) => {
      const last = blocks[blocks.length - 1];
      // Read from the PDF itself, a page's first block says how it follows the last (pagesFromPdf).
      if (bi === 0 && b[0] === BLANK) {
        pageFirst.add(blocks.length);
        blocks.push(b.slice(1));
        return;
      }
      if (bi === 0 && (b[0] === JOIN || b[0] === PARA)) {
        if (blocks.length && !isHead(b, keys) && !isHead(last, keys)) {
          blocks[blocks.length - 1] += b[0] === JOIN ? b.slice(1) : b;
          joined += 1;
          return;
        }
        b = b.slice(1);
      }
      if (bi === 0 && blocks.length && !endsTerm(last.trimEnd()) && !new RegExp(`^${ILL.source}$`).test(last)
        && !isHead(b, keys) && !isHead(last, keys)) {
        blocks[blocks.length - 1] += b; joined += 1; return;
      }
      if (blocks.length && NOSTART.has([...b][0]) && !isHead(last, keys)) {
        blocks[blocks.length - 1] += b; joined += 1; return;
      }
      if (bi === 0) pageFirst.add(blocks.length);
      blocks.push(b);
    });
  });
  return { blocks, pageFirst, joined };
}

function stripHead(block, headKey) {
  let n = 0;
  const chars = [...block];
  for (let k = 0; k < chars.length; k += 1) {
    n += key(chars[k]).length;
    if (n >= headKey.length) return chars.slice(k + 1).join('').trim();
  }
  return '';
}

function locate(blocks, pageFirst, eps, startAt) {
  const keys = blocks.map(key);
  let pos = startAt;
  const found = [];
  const missing = [];
  eps.forEach((ep, i) => {
    const tk = key(ep.title);
    const cands = [];
    for (let j = pos; j < keys.length; j += 1) if (keys[j] === tk) cands.push(j);
    const hit = cands.find((j) => pageFirst.has(j)) ?? cands[0];
    if (hit === undefined) { missing.push(i + 1); return; }
    found.push([i, hit]);
    pos = hit + 1;
  });
  return { found, missing };
}

/* ── lines ──────────────────────────────────────────────────────────── */

/** A block's lines: the PDF's wrap spaces out, a line where a sentence or a quotation ends. */
export function linesOf(block) {
  const out = [];
  let cur = '';
  let depth = 0;
  const chars = [...block];
  chars.forEach((ch, i) => {
    if (ch === PARA) { out.push(cur); cur = ''; depth = 0; return; }   // a paragraph's end, read from the PDF
    if (ch === ' ') {
      const a = cur ? [...cur].slice(-1)[0] : '';
      const b = chars[i + 1] || '';
      if (b && NOSTART.has(b)) return;
      // As the script reads it: an empty neighbour counts as "in" (Python's '' in s is true; so is includes('')).
      if (depth > 0) {
        if ('︕︖！？'.includes(a)) cur += '　';
        return;
      }
      if ('︒︕︖﹂﹄︶。！？」』）'.includes(a) || '﹁﹃「『'.includes(b)) { out.push(cur); cur = ''; }
      return;
    }
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
    cur += ch;
  });
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

function render(blocks, stats) {
  const out = [];
  for (const b of blocks) {
    linesOf(b).forEach((line, j) => {
      const parts = horiz(line).split(ILL);
      parts.forEach((part, k) => {
        if (k) { out.push('<p class="illust">［挿絵］</p>'); stats.ill += 1; }
        if (part.trim()) out.push(`<p${j === 0 && k === 0 ? ' class="gap"' : ''}>${esc(part)}</p>`);
      });
    });
  }
  return out.join('\n');
}

/* ── the EPUB made ──────────────────────────────────────────────────── */

const CSS = `@charset "utf-8";
body { margin: 0 5%; line-height: 1.9; }
p { margin: 0; text-indent: 0; }
p.gap { margin-top: 1em; }
section.chapter { page-break-before: always; break-before: page; }
header.chapter-head { margin: 2.5em 0 2em 0; padding-bottom: 1em; border-bottom: 1px solid #999; text-align: center; page-break-after: avoid; break-after: avoid; }
span.chapter-arc { display: block; margin: 0 0 0.3em 0; font-size: 0.85em; letter-spacing: normal; color: #999; }
p.chapter-number { margin: 0 0 0.4em 0; font-size: 0.95em; letter-spacing: 0.1em; color: #777; }
h1.chapter-title { margin: 0; font-size: 1.4em; line-height: 1.5; }
aside.note { margin: 1.5em 0; padding: 0.7em 1em; border-left: 3px solid #bbb; font-size: 0.9em; color: #666; }
aside.note p.note-label { font-weight: bold; margin-bottom: 0.3em; }
p.illust { text-align: center; color: #999; font-size: 0.85em; margin: 1em 0; }
div.cover { text-align: center; } div.cover img { max-width: 100%; max-height: 100vh; height: auto; }
`;
const xhtml = (title, body, css = '../style.css', extra = '') => '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja" xml:lang="ja">\n<head><meta charset="utf-8"/>'
  + `<title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="${css}"/></head>\n<body${extra}>\n${body}\n</body>\n</html>\n`;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

async function writeEpub(book, introHtml, chapters, cover) {
  const files = new Map();
  files.set('OEBPS/style.css', CSS);
  let ext = '.jpg';
  if (cover) {
    ext = (/\.[a-z0-9]+$/i.exec(cover.name)?.[0] || '.jpg').toLowerCase();
    files.set(`OEBPS/cover${ext}`, cover.bytes);
    files.set('OEBPS/cover.xhtml', xhtml(book.title, `<div class="cover"><img src="cover${ext}" alt="${esc(book.title)}"/></div>`, 'style.css', ' epub:type="cover"'));
  }
  files.set('OEBPS/text/intro.xhtml', xhtml('あらすじ', introHtml));
  for (const c of chapters) files.set(`OEBPS/text/${c.file}`, xhtml(c.label, c.html));
  // Contents, grouped by arc.
  const nav = [];
  const ncx = [];
  let order = 0;
  const np = (label, href, kids = '') => {
    order += 1;
    return `<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${esc(label)}</text></navLabel><content src="${href}"/>${kids}</navPoint>\n`;
  };
  nav.push('<li><a href="text/intro.xhtml">あらすじ</a></li>\n');
  ncx.push(np('あらすじ', 'text/intro.xhtml'));
  const groups = [];
  for (const c of chapters) {
    if (groups.length && groups[groups.length - 1][0] === c.arc) groups[groups.length - 1][1].push(c);
    else groups.push([c.arc, [c]]);
  }
  for (const [arc, cs] of groups) {
    const items = cs.map((c) => `<li><a href="text/${c.file}">${esc(c.label)}</a></li>\n`).join('');
    if (arc) {
      nav.push(`<li><a href="text/${cs[0].file}">${esc(arc)}</a>\n<ol>\n${items}</ol></li>\n`);
      order += 1;
      const o0 = order;
      let kids = `<navPoint id="np${o0}c" playOrder="${o0}"><navLabel><text>${esc(cs[0].label)}</text></navLabel><content src="text/${cs[0].file}"/></navPoint>\n`;
      kids += cs.slice(1).map((c) => np(c.label, `text/${c.file}`)).join('');
      ncx.push(`<navPoint id="np${o0}" playOrder="${o0}"><navLabel><text>${esc(arc)}</text></navLabel><content src="text/${cs[0].file}"/>${kids}</navPoint>\n`);
    } else {
      nav.push(items);
      ncx.push(...cs.map((c) => np(c.label, `text/${c.file}`)));
    }
  }
  files.set('OEBPS/nav.xhtml', xhtml('目次', `<nav epub:type="toc" id="toc"><h1>目次</h1>\n<ol>\n${nav.join('')}</ol>\n</nav>\n`
    + `<nav epub:type="landmarks" hidden=""><ol>${cover ? '<li><a epub:type="cover" href="cover.xhtml">表紙</a></li>' : ''}`
    + `<li><a epub:type="bodymatter" href="text/${chapters[0].file}">本文</a></li></ol></nav>`, 'style.css'));
  files.set('OEBPS/toc.ncx', '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="ja">\n'
    + `<head><meta name="dtb:uid" content="${esc(book.ident)}"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n`
    + `<docTitle><text>${esc(book.title)}</text></docTitle>\n<docAuthor><text>${esc(book.author)}</text></docAuthor>\n<navMap>\n${ncx.join('')}</navMap>\n</ncx>\n`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const items = chapters.map((c, i) => `<item id="c${i + 1}" href="text/${c.file}" media-type="application/xhtml+xml"/>\n`).join('');
  const coverItems = cover ? `<item id="cover-img" href="cover${ext}" media-type="${IMAGE_TYPES[ext] || 'image/jpeg'}" properties="cover-image"/>\n`
    + '<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>\n' : '';
  files.set('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="ja">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${esc(book.ident)}</dc:identifier>
<dc:title>${esc(book.title)}</dc:title>
<dc:creator>${esc(book.author)}</dc:creator>
<dc:language>ja</dc:language>
<meta property="dcterms:modified">${now}</meta>
${cover ? '<meta name="cover" content="cover-img"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${coverItems}<item id="intro" href="text/intro.xhtml" media-type="application/xhtml+xml"/>
${items}</manifest>
<spine toc="ncx">
${cover ? '<itemref idref="cover-page"/>' : ''}
<itemref idref="intro"/>
${chapters.map((c, i) => `<itemref idref="c${i + 1}"/>\n`).join('')}</spine>
</package>
`);
  // Well-formed, every page of it.
  for (const [name, data] of files) {
    if (!/\.(xhtml|opf|ncx)$/.test(name)) continue;
    const doc = new DOMParser().parseFromString(data, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(`the rebuilt ${name.split('/').pop()} is not well-formed`);
  }
  const zip = new JSZip();
  const plain = { createFolders: false };
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', ...plain });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n', plain);
  for (const [name, data] of files) zip.file(name, data, plain);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

/* ── the whole of it ────────────────────────────────────────────────── */

/** Not a Syosetu PDF's EPUB, or its episodes not to be had: said, and the file left as it is. */
export class NotSyosetu extends Error {}

/**
 * A Syosetu PDF, or an EPUB made from one, rebuilt.
 *
 * @param file       the PDF or EPUB as it came
 * @param readPdf    (file, onProgress) => the PDF's runs a page (pdf.js's, by default)
 * @param fetchText  (url) => the page's text -- the site's contents pages, paced by the app
 * @param askTitles  (info) => the episode list pasted by the reader, or null -- when the site's cannot be had
 * @returns { file, title, author, chapters, missing: ['第12話 …'], illustrations, notes, joined }
 */
export async function rebuild(file, { fetchText, askTitles, readPdf = pdfPages, onProgress } = {}) {
  let src;
  let pages;
  if (await isPdf(file)) {
    pages = pagesFromPdf(await readPdf(file, onProgress));
    src = { cover: null, ident: null, title: null };
  } else {
    src = await readEpub(file);
    ({ pages } = splitPages(src.paras));
  }
  // A paragraph a block, to read the information page by.
  const front = parseFront([...(pages[0] || []), ...(pages[1] || []), ...(pages[2] || [])]
    .flatMap((b) => b.split(PARA)).map((b) => b.replace(BLANK, '').trim()).filter(Boolean));
  const ncode = front.ncode;
  if (!ncode && !front.title) throw new NotSyosetu('it does not look like a Syosetu PDF (no Nコード in it)');

  let eps = null;
  if (ncode && fetchText) ({ eps } = await titlesFromWeb(ncode, fetchText).catch(() => ({ eps: null })));
  if (!eps?.length && askTitles) {
    const pasted = await askTitles({ ncode, title: front.title || src.title || file.name });
    if (pasted) eps = titlesFromText(pasted);
  }
  if (!eps?.length) throw new NotSyosetu('its episode list could not be had from the site, nor was one pasted');

  const keys = new Set(eps.map((e) => key(e.title)));
  const { blocks, pageFirst, joined } = joinBlocks(pages, keys);
  const infoStart = Math.max(0, blocks.findIndex((b) => b.startsWith('︻Ｎコード︼')));
  const { found, missing } = locate(blocks, pageFirst, eps, infoStart);
  if (!found.length) throw new NotSyosetu('none of its episodes could be found in the text');

  // Carved into episodes.
  const tk = eps.map((e) => key(e.title));
  const chapters = [];
  const stats = { ill: 0, pre: 0, post: 0 };
  const starts = found.map(([, hit]) => hit);
  found.forEach(([ei, si], idx) => {
    const ep = eps[ei];
    const t = tk[ei];
    let end = idx + 1 < found.length ? starts[idx + 1] : blocks.length;
    if (idx + 1 < found.length) {   // the next episode's 前書き sits before its title
      const nk = tk[found[idx + 1][0]] + NOTE_PRE;
      for (let k = si + 1; k < end; k += 1) if (key(blocks[k]).startsWith(nk)) { end = k; break; }
    }
    let pre = [];
    let pk = null;
    for (let k = si - 1; k > Math.max(si - 15, -1); k -= 1) if (key(blocks[k]).startsWith(t + NOTE_PRE)) { pk = k; break; }
    if (pk !== null) {
      const first = stripHead(blocks[pk], t + NOTE_PRE);
      pre = [...(first ? [first] : []), ...blocks.slice(pk + 1, si)];
    }
    const body = [];
    const post = [];
    let inPost = false;
    for (const b of blocks.slice(si + 1, end)) {
      if (key(b).startsWith(t + NOTE_POST)) {
        inPost = true;
        const rest = stripHead(b, t + NOTE_POST);
        if (rest) post.push(rest);
        continue;
      }
      (inPost ? post : body).push(b);
    }
    if (idx === found.length - 1) {   // Syosetu's closing "title / 発行 … URL"
      const tail = post.length ? post : body;
      while (tail.length && (/syosetu\.com|発行/.test(tail[tail.length - 1]) || key(tail[tail.length - 1]) === key(front.title || ''))) tail.pop();
    }
    const n = ei + 1;
    const arcShown = ep.arc && (idx === 0 || eps[found[idx - 1][0]].arc !== ep.arc);
    const parts = ['<section class="chapter" epub:type="chapter">\n<header class="chapter-head">'
      // The arc's name inside the number's line, set above it: a checker reading the
      // first lines (check.js) takes "第一部 第1話" for the heading it is, not 第1話 for one mid-chapter.
      + `<p class="chapter-number">${arcShown ? `<span class="chapter-arc">${esc(ep.arc)}</span> ` : ''}第${n}話</p><h1 class="chapter-title">${esc(horiz(ep.title))}</h1></header>`];
    if (pre.length) { parts.push(`<aside class="note"><p class="note-label">前書き</p>\n${render(pre, stats)}\n</aside>`); stats.pre += 1; }
    parts.push(render(body, stats));
    if (post.length) { parts.push(`<aside class="note"><p class="note-label">後書き</p>\n${render(post, stats)}\n</aside>`); stats.post += 1; }
    parts.push('</section>');
    chapters.push({ n, file: `ep${String(n).padStart(4, '0')}.xhtml`, label: `第${n}話 ${horiz(ep.title)}`, arc: ep.arc || null, html: parts.join('\n'), titleBlock: si });
  });

  // あらすじ: the information page, up to the first episode (or its 前書き).
  const firstEp = starts[0];
  let pre0 = firstEp;
  for (let k = firstEp - 1; k > Math.max(firstEp - 15, -1); k -= 1) if (key(blocks[k]).startsWith(tk[found[0][0]] + NOTE_PRE)) { pre0 = k; break; }
  const info = blocks.slice(infoStart, pre0);
  const book = { title: front.title || src.title || 'untitled', author: (front.author || '').replace(/\u3000/g, ' '), ident: src.ident || `urn:syosetu:${ncode}` };
  const introHtml = '<section class="chapter">\n<header class="chapter-head"><h1 class="chapter-title">あらすじ</h1>'
    + `<p class="chapter-number">${esc(book.title)} · ${esc(book.author)}</p></header>\n${render(info, stats)}\n</section>`;

  // Checked: every character of the story text is in what comes out, in order.
  const used = new Set(chapters.map((c) => c.titleBlock));
  const heads = [];
  for (const c of chapters) for (const label of [NOTE_PRE, NOTE_POST]) heads.push(key(eps[c.n - 1].title) + label);
  const srcKeys = [];
  for (let k = infoStart; k < blocks.length; k += 1) {
    if (used.has(k)) continue;
    let kb = key(blocks[k]);
    for (const h of heads) if (kb.startsWith(h)) kb = kb.slice(h.length);
    srcKeys.push(kb);
  }
  const srcText = srcKeys.join('').replace(/<i[0-9]+\|[0-9]+>/g, '');
  let outText = '';
  for (const page of [introHtml, ...chapters.map((c) => c.html)]) {
    const after = page.split('</header>').slice(1).join('</header>');
    for (const m of after.matchAll(/<p(?: class="([^"]*)")?>([\s\S]*?)<\/p>/g)) {
      if (m[1] === 'note-label' || m[1] === 'illust') continue;
      outText += key(unescape(m[2]));
    }
  }
  const droppedTail = srcText.startsWith(outText) ? srcText.slice(outText.length) : null;
  const ok = srcText === outText || (droppedTail !== null && /syosetu\.com|発行/.test(droppedTail) && droppedTail.length < 200);
  if (!ok) {
    let i = 0;
    while (i < srcText.length && i < outText.length && srcText[i] === outText[i]) i += 1;
    throw new Error(`the rebuilt text does not match the original at character ${i} (“…${srcText.slice(Math.max(0, i - 20), i + 20)}…”) -- nothing changed`);
  }

  const blob = await writeEpub(book, introHtml, chapters, src.cover);
  const name = (file.name || 'book.epub').replace(/\.(epub|pdf)$/i, '') + '.epub';
  return {
    file: new File([blob], name, { type: 'application/epub+zip' }),
    title: book.title,
    author: book.author,
    chapters: chapters.length,
    missing: missing.map((n) => `第${n}話 ${eps[n - 1].title}`),
    illustrations: stats.ill,
    notes: stats.pre + stats.post,
    joined,
  };
}
