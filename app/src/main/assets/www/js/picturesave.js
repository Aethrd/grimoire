/* Keeping a picture out of a book.
 *
 * A long press on a picture -- in the book as it is read, or in its reel of
 * pictures -- offers to save it. What is saved is the picture the book holds:
 * a GIF stays a GIF and keeps moving, and a picture with panels blacked out is
 * saved blacked out, because that is what the book now holds.
 *
 * Here are the parts that do not need the app around them: what kind of
 * picture a file really is, what to call it, and the press itself.
 */

const TYPE_OF_EXT = {
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const EXT_OF_TYPE = {
  'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};

async function headOf(blob, count) {
  const piece = blob.slice(0, count);
  if (typeof piece.arrayBuffer === 'function') return new Uint8Array(await piece.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(piece);
  });
}

/**
 * What kind of picture this is, from its first bytes.
 *
 * Read from the file rather than taken from its name or the type it was
 * stored with: books name pictures however they like, and a picture saved
 * as ".jpg" that is really a GIF opens as a still in a gallery, or not at all.
 */
export async function pictureType(blob, href = '') {
  const head = await headOf(blob, 32);
  const text = String.fromCharCode(...head);
  if (text.startsWith('GIF8')) return 'image/gif';
  if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xFF && head[1] === 0xD8) return 'image/jpeg';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (/^ftypavi[fs]/.test(text.slice(4, 12))) return 'image/avif';
  if (text.startsWith('BM')) return 'image/bmp';
  if (/^\s*(<\?xml|<svg)/i.test(text)) return 'image/svg+xml';
  if (EXT_OF_TYPE[blob.type]) return blob.type;
  const ext = (String(href).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1];
  return TYPE_OF_EXT[(ext || '').toLowerCase()] || 'image/jpeg';
}

const clean = (text) => String(text || '')
  .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** "Book title - picture.gif": which book it came from, and which picture. */
export function pictureName(title, href, type) {
  const ext = EXT_OF_TYPE[type] || 'jpg';
  let base = String(href || '').split(/[?#]/)[0].split('/').pop() || '';
  try { base = decodeURIComponent(base); } catch { /* left as it is */ }
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
  // A cover chosen in the app is named for when it was chosen, which means
  // nothing to anyone looking at the file.
  if (String(href).startsWith('grimoire-cover/')) base = 'cover';
  const book = clean(title).slice(0, 60).trim();
  const picture = clean(base).slice(0, 60).trim() || 'picture';
  return `${book ? `${book} - ` : ''}${picture}.${ext}`;
}

/**
 * A long press on a picture.
 *
 * @param host      where the pictures are
 * @param selector  what counts as a picture in it
 * @param onHold    called with the picture pressed
 *
 * A press is a finger that stays put for half a second. It is not a tap --
 * the reader's own taps give up at 400ms -- and lifting the finger afterwards
 * is not a tap either: the sheet the press opens would otherwise be shut by
 * it, or the picture opened underneath it.
 */
export function holdPicture(host, selector, onHold, { ignore = () => false } = {}) {
  let timer = null;
  let heldAt = 0;
  // Only the lift that ends the press is swallowed, not some later tap.
  const justHeld = () => Date.now() - heldAt < 800;
  let x = 0;
  let y = 0;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

  host.addEventListener('touchstart', (e) => {
    stop();
    heldAt = 0;
    if (e.touches.length !== 1 || ignore(e)) return;
    const picture = e.target?.closest?.(selector);
    if (!picture || !host.contains(picture)) return;
    x = e.touches[0].clientX;
    y = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      // A press that has become a text selection belongs to the selection.
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      heldAt = Date.now();
      onHold(picture);
    }, 500);
  }, { passive: true });

  host.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - x) > 10 || Math.abs(touch.clientY - y) > 10) stop();
  }, { passive: true });

  host.addEventListener('touchend', (e) => {
    stop();
    if (justHeld() && e.cancelable) e.preventDefault();
  });
  host.addEventListener('touchcancel', stop, { passive: true });

  // The browser's own long press on a picture -- a menu, or the start of a
  // drag -- is this one's to replace.
  host.addEventListener('contextmenu', (e) => {
    if (e.target?.closest?.(selector)) e.preventDefault();
  });
  host.addEventListener('click', (e) => {
    if (!justHeld()) return;
    heldAt = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
