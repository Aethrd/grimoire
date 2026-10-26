/* Saved web pages.
 *
 * A web novel is often kept as .mht or .mhtml — a whole page in one file, the
 * way a browser saves it. Inside is a MIME message: the HTML in one part, the
 * pictures in others, everything encoded so it survives being mailed around.
 *
 * Two things have to happen for it to read as a chapter. The parts have to be
 * pulled apart and decoded, and the site has to be stripped off the story —
 * a saved page carries the header, the navigation, the comments and whatever
 * else was on screen, and none of it is the book.
 */

const DECODER = new TextDecoder('utf-8');

/** Split a MIME message into its parts, headers separated from bodies. */
function splitParts(text) {
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(text.slice(0, 4000))?.[1];
  if (!boundary) return [];

  return text.split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const at = chunk.search(/\r?\n\r?\n/);
      if (at === -1) return null;
      const headers = {};
      for (const line of chunk.slice(0, at).split(/\r?\n/)) {
        const match = /^([\w-]+):\s*(.*)$/.exec(line.trim());
        if (match) headers[match[1].toLowerCase()] = match[2];
      }
      return { headers, body: chunk.slice(at).replace(/^\r?\n\r?\n/, '') };
    })
    .filter(Boolean);
}

/** Undo quoted-printable, which is how saved pages usually carry their text. */
function fromQuotedPrintable(body) {
  const joined = body.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /[0-9A-F]{2}/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return DECODER.decode(new Uint8Array(bytes));
}

function fromBase64(body) {
  const clean = body.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeText(part) {
  const encoding = (part.headers['content-transfer-encoding'] || '').toLowerCase();
  if (encoding === 'quoted-printable') return fromQuotedPrintable(part.body);
  if (encoding === 'base64') return DECODER.decode(fromBase64(part.body));
  return part.body;
}

function decodeBytes(part) {
  const encoding = (part.headers['content-transfer-encoding'] || '').toLowerCase();
  if (encoding === 'base64') return fromBase64(part.body);
  if (encoding === 'quoted-printable') {
    const text = fromQuotedPrintable(part.body);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }
  const bytes = new Uint8Array(part.body.length);
  for (let i = 0; i < part.body.length; i++) bytes[i] = part.body.charCodeAt(i) & 0xff;
  return bytes;
}

/* What a saved page carries besides the story. Removed before anything is
 * measured, so a long navigation menu cannot win the "most text" contest
 * below. */
export const NOT_THE_STORY = [
  'script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside',
  'form', 'button', 'svg', 'video', 'audio',
].join(',');

/* Plurals count. "comments" is the usual class name and "comment" was the
 * only spelling matched, so the comment section survived every strip. */
export const CHROME_WORDS = new RegExp(
  '(^|[-_ ])('
  + ['nav', 'navigation', 'menu', 'header', 'footer', 'sidebar', 'comments?',
    'disqus', 'adverts?', 'ads?', 'share', 'sharing', 'social', 'related',
    'recommend\\w*', 'breadcrumbs?', 'pagination', 'paginate', 'toolbar',
    'banner', 'cookie', 'popup', 'modal', 'subscribe', 'newsletter',
    'widget', 'promo', 'ranking'].join('|')
  + ')([-_ ]|$)', 'i');

/**
 * Find the part of the page that is actually the chapter.
 *
 * A saved page is mostly not the story. An <article> says so outright; where
 * there is none, the block with the most text in the fewest links is a good
 * proxy — navigation is short and link-dense, prose is long and link-sparse.
 */
export function findStory(doc) {
  for (const element of doc.querySelectorAll(NOT_THE_STORY)) element.remove();
  for (const element of doc.querySelectorAll('[class],[id]')) {
    const label = `${element.className} ${element.id}`;
    if (CHROME_WORDS.test(label)) element.remove();
  }

  const article = doc.querySelector('article, [role="main"], main');
  if (article && (article.textContent || '').trim().length > 200) return article;

  let best = null;
  let bestScore = 0;
  for (const block of doc.querySelectorAll('div, section, td')) {
    const text = (block.textContent || '').trim();
    if (text.length < 400) continue;
    const links = block.querySelectorAll('a').length;
    const paragraphs = block.querySelectorAll('p').length;
    // Prose scores by length and paragraph count; links count against it.
    const score = text.length + paragraphs * 200 - links * 150;
    if (score > bestScore) {
      bestScore = score;
      best = block;
    }
  }
  return best || doc.body;
}

/** The page's own title, with the site's name trimmed off the end. */
export function titleOf(doc, fallback) {
  const heading = doc.querySelector('h1, h2')?.textContent?.trim();
  const title = (doc.querySelector('title')?.textContent || '').trim();
  const cleaned = title
    .replace(/\s*[|\u2013\u2014\u00b7-]\s*[^|\u2013\u2014\u00b7-]{1,40}$/, '')
    .trim();
  return heading || cleaned || title || fallback;
}

/**
 * Read a saved page into a chapter.
 *
 * @returns { title, html, text, images } where images are the pictures the
 *   file carried, keyed by the address the markup refers to them by.
 */
export function readMht(text, fallbackTitle = 'Chapter') {
  const parts = splitParts(text);
  if (!parts.length) throw new Error('That does not look like a saved web page.');

  const html = parts.find((part) =>
    /text\/html/i.test(part.headers['content-type'] || ''));
  if (!html) throw new Error('That saved page has no HTML in it.');

  const images = new Map();
  for (const part of parts) {
    const type = (part.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) continue;

    /* A picture is referred to by its original address, or by a content id
     * where the saver rewrote the markup to cid: links. Both are recorded, so
     * whichever form the markup uses finds it. */
    const location = part.headers['content-location'];
    const id = (part.headers['content-id'] || '').replace(/^<|>$/g, '');
    const blob = new Blob([decodeBytes(part)], { type });
    if (location) images.set(location, blob);
    if (id) images.set(`cid:${id}`, blob);
  }

  const doc = new DOMParser().parseFromString(decodeText(html), 'text/html');
  const title = titleOf(doc, fallbackTitle);
  const story = findStory(doc);

  return {
    title,
    body: story,
    text: (story.textContent || '').trim(),
    images,
    base: html.headers['content-location'] || '',
  };
}

/** Whether a file looks like a saved page, by name or by its first bytes. */
export const looksLikeMht = (name, head = '') =>
  /\.mht(ml)?$/i.test(String(name))
  || /^(from|mime-version|content-type):/im.test(String(head).slice(0, 400));
