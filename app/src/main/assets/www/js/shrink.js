/* Smaller copies.
 *
 * A comic scanned at 2400 pixels tall is four or five times the file of the
 * same comic at 1400, and on a phone screen the two are indistinguishable.
 * That matters in two places: what gets carried off the device, and what gets
 * kept. A thirty-volume series at full size is a backup nobody completes and
 * a transfer nobody waits for.
 *
 * So writing a book out can write a smaller one. The book on the shelf is
 * never touched -- this runs on the way into the file, so the copy is small
 * and the original is still the original. Deciding otherwise would make
 * "export small" a destructive operation disguised as a save.
 */

import * as store from './store.js';
import { pictureSize, readArrayBuffer } from './blobs.js';

/* The long edge, and how hard to compress.
 *
 * Named for what they are for rather than by number, because a number is only
 * meaningful next to the screen it will be read on.
 */
export const SIZES = {
  full: { edge: 0, quality: 1, label: 'Full size', note: 'Exactly as imported' },
  smart: { smart: true, quality: 0.88, label: 'Smart', note: 'As sharp as the phone or the Boox shows it, upright or on its side' },
  small: { edge: 1000, quality: 0.76, label: 'Small', note: 'For sending: longest side 1000 px, strips 450 wide' },
};

/* What was offered before Smart: Large and Screen. Kept only so an export
 * begun at one carries on at it, the same all through; a choice saved as
 * either is shown, and made, as Smart. */
const EARLIER_SIZES = {
  large: { edge: 2000, quality: 0.86, label: 'Large', note: 'For a tablet' },
  screen: { edge: 1400, quality: 0.82, label: 'Screen', note: 'For a phone' },
};
/** The size a key names, the earlier ones included; null for none. */
export const sizeFor = (key) => SIZES[key] || EARLIER_SIZES[key] || null;
/** As offered now: an earlier choice shown as Smart, an unknown one as full size. */
export const offeredSize = (key) => (SIZES[key] ? key : EARLIER_SIZES[key] ? 'smart' : 'full');

export const describeSize = (key) => {
  const size = sizeFor(key) || SIZES.full;
  if (size.smart) return 'smart size';
  return size.edge ? `${size.label.toLowerCase()}, ${size.edge}px` : 'full size';
};

/* The screens read on, in their own pixels: the phone and the e-reader --
 * a Galaxy S23 (1080 by 2340) and a Boox Note X5 Mini (1404 by 1872, 300
 * pixels an inch). Smart keeps every picture as large as either shows it,
 * upright or on its side, and no larger. */
export const READ_ON = [
  { name: 'Galaxy S23', short: 1080, long: 2340 },
  { name: 'Boox Note X5 Mini', short: 1404, long: 1872 },
];

/**
 * How much smaller Smart makes a picture, 1 to leave it.
 *
 * A page, a spread, any picture no taller than a phone: as large as it is
 * ever shown fitted whole -- on either screen, held either way. Taller (a
 * strip, a long page): read across, scrolled, so as wide as it is ever shown
 * -- the phone on its side, 2340. And made smaller only when that is worth a
 * generation: by a tenth or more, else left as it is.
 */
export function smartScale(width, height) {
  if (!(width > 0 && height > 0)) return 1;
  let shown = 0;
  for (const { short, long } of READ_ON) {
    shown = height / width > PHONE_SHAPE
      ? Math.max(shown, long / width)
      : Math.max(shown, Math.min(short / width, long / height), Math.min(long / width, short / height));
  }
  return shown >= WORTH_SCALING ? 1 : shown;
}

/** How much smaller a size makes a picture, 1 to leave it. */
export function scaleFor(width, height, size) {
  if (!(width > 0 && height > 0) || !size) return 1;
  if (size.smart) return smartScale(width, height);
  const edge = size.edge;
  if (!edge) return 1;
  const tall = height / width > PHONE_SHAPE;
  const scale = Math.min(1, (tall ? edge / PHONE_SHAPE : edge) / (tall ? width : Math.max(width, height)));
  // A strip so long that its width limit would leave it longer than a canvas
  // takes: brought down further, to the longest canvas, its shape kept --
  // still within the limit, where before it was left out of it. One already
  // within the limit is left alone, however long.
  return scale >= 1 ? 1 : Math.min(scale, MOST_CANVAS / Math.max(width, height));
}

/* A phone screen's shape, tall over wide (reader.js PHONE_SHAPE, kept here
 * rather than imported so writing a file does not load the reader). */
const PHONE_SHAPE = 20 / 9;
/* The longest side a canvas is trusted with on a phone. */
const MOST_CANVAS = 16384;
/* The most pixels a picture may have to be made smaller here: decoded whole
 * first, at four bytes a pixel -- 40 million is 160 MB, beside the copy
 * drawn and the export or the shelf going on around it. A bigger one (a
 * webtoon episode as one picture, 2,000 by 30,000) is kept as it is. */
const MOST_PIXELS = 40_000_000;

/** Too big to be made smaller safely, by its header: kept as it is, never decoded to find out. */
export function tooBigToShrink(width, height, sizeOrEdge) {
  if (!(width > 0 && height > 0)) return false;
  if (width * height > MOST_PIXELS) return true;
  const scale = scaleFor(width, height, typeof sizeOrEdge === 'number' ? { edge: sizeOrEdge } : sizeOrEdge);
  return Math.round(width * scale) > MOST_CANVAS || Math.round(height * scale) > MOST_CANVAS;
}

/** A GIF may be animated, and re-encoding one gives back a single frame. */
const ANIMATED = /gif/i;

/* Eight seconds, then give up and keep the original.
 *
 * A picture that will not decode otherwise hangs the export at that page, and
 * a book that never finishes writing is worse than a book that writes big.
 */
const PATIENCE = 8000;

/**
 * A smaller version of one picture, or the original where smaller is no good.
 *
 * Every guard here is a case where shrinking makes things worse rather than
 * smaller, and each one returns the blob it was given:
 *
 *   - an animated GIF, which would come back as one frame
 *   - a picture already inside the target, which would be re-encoded for
 *     nothing and lose a generation of quality doing it
 *   - a result that came out bigger than the original, which happens with
 *     line art and flat colour: PNG's own compression beats JPEG there
 *   - anything that would not decode in reasonable time
 */
export async function shrinkPicture(blob, size = EARLIER_SIZES.screen) {
  const { edge = 0, quality = 0.82, smart = false } = size || {};
  if (!blob || (!edge && !smart)) return blob;
  if (ANIMATED.test(blob.type || '')) return blob;

  /* Already within the size, by what its header says: left as it is without
   * being decoded at all. Every picture was decoded whole just to learn its
   * size -- a webtoon strip tens of megabytes of pixels -- including the many
   * that are then left as they were. Only ever used to leave one alone: a
   * photo marked to be turned can have its sides the other way round in its
   * header, and is then at most kept at full size, never drawn wrong. */
  const head = await pictureSize(blob, { decode: false }).catch(() => null);
  if (head?.width && head?.height && within(head.width, head.height, size)) return blob;
  /* Too big to draw smaller on a phone: kept as it is -- found out from its
   * header, before it is decoded. It was decoded whole first, and only then
   * found too long for a canvas: a webtoon episode as one picture, a hundred
   * and more megabytes of pixels for nothing, in the middle of an export. */
  if (head?.width && head?.height && tooBigToShrink(head.width, head.height, size)) return blob;
  /* See-through: a JPEG cannot hold it, and its clear parts came out black.
   * Left as it is, as keeping pictures smaller leaves it (keptSmaller). */
  if (await seeThroughPng(blob)) return blob;

  let bitmap = null;
  const decoding = decode(blob);
  try {
    bitmap = await Promise.race([
      decoding,
      new Promise((resolve) => setTimeout(() => resolve(null), PATIENCE)),
    ]);
  } catch {
    return blob;
  }
  if (!bitmap) {
    // Given up on, it still comes in time: let go of then, not held.
    decoding.then((late) => late?.close?.(), () => {});
    return blob;
  }

  const { width, height } = bitmap;
  if (!width || !height) return blob;

  /* How much smaller, by the size's own rule (scaleFor): a picture taller
   * than a phone screen by its width, as it is read -- by its long edge, a
   * strip 800 across and 12,000 down came out a sliver -- and Smart by the
   * screens it is read on. */
  const scale = scaleFor(width, height, size);
  if (scale >= 1) {
    bitmap.close?.();
    return blob;
  }
  const to = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  // Past what a canvas holds on a phone: kept as it is rather than lost.
  if (to.width > MOST_CANVAS || to.height > MOST_CANVAS) {
    bitmap.close?.();
    return blob;
  }

  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = to.width;
    canvas.height = to.height;
    const context = canvas.getContext('2d');
    if (!context) return blob;

    /* Smoothed on the way down.
     *
     * Nearest-neighbour downscaling of a screentone is moiré, which on a comic
     * page is the single most visible way to make a smaller file look worse
     * than it has to. */
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    // An ImageBitmap draws directly; the <img> fallback hands over its element.
    context.drawImage(bitmap.source || bitmap, 0, 0, to.width, to.height);

    const out = await new Promise((resolve) => {
      if (canvas.toBlob) canvas.toBlob(resolve, 'image/jpeg', quality);
      else resolve(null);
    });

    // Bigger is not smaller. Flat colour and line art deflate better as PNG
    // than they encode as JPEG, and re-encoding them costs size and quality
    // at once.
    if (!out || out.size >= blob.size) return blob;
    return out;
  } catch {
    return blob;
  } finally {
    bitmap.close?.();
    // Its pixels let go of now, not whenever the engine next tidies: a book is hundreds of these.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/* Within the size: nothing to make smaller (shrinkPicture). */
function within(width, height, size) {
  return scaleFor(width, height, size) >= 1;
}

/* A PNG that can be see-through, from its first bytes (pngSeeThrough). */
async function seeThroughPng(blob) {
  try {
    const head = new Uint8Array(await readArrayBuffer(blob.slice(0, Math.min(blob.size, 65536))));
    return head[0] === 0x89 && head[1] === 0x50 && pngSeeThrough(head);
  } catch {
    return false;
  }
}

/** createImageBitmap where there is one, an <img> where there is not. */
function decode(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      /* Shaped like an ImageBitmap so the caller does not have to know which
       * it got: the same width, height and close(), and the element itself
       * under `source` for drawImage. */
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
        source: image,
      });
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode')); };
    image.src = url;
  });
}

/**
 * Shrink a whole book's worth, reporting as it goes.
 *
 * Several at a time, because each one is a decode and an encode that mostly
 * waits: in turn, a three-hundred-page volume is minutes of nothing happening
 * on a phone that could have been doing eight of them.
 */
export async function shrinkAll(images, { edge, quality, smart, onProgress } = {}) {
  const AT_ONCE = 4;
  const out = new Map();
  let done = 0;
  let saved = 0;

  for (let at = 0; at < images.length; at += AT_ONCE) {
    await Promise.all(images.slice(at, at + AT_ONCE).map(async (image) => {
      if (!image.blob) return;
      const small = await shrinkPicture(image.blob, { edge, quality, smart });
      out.set(image.href, small);
      saved += Math.max(0, image.blob.size - small.size);
      done += 1;
      onProgress?.(done / images.length, saved);
    }));
  }

  return { blobs: out, saved };
}

/** "4.2 MB saved", for a sentence somebody reads once and then trusts. */
export function describeSaving(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── kept smaller ──────────────────────────────────────────────────────── */

/* The pictures a book keeps, made no bigger than the phone shows them.
 *
 * Unlike the copies above, this changes the book on the shelf, for good: it
 * is asked for, book by book or folder by folder, and says so. So it is
 * careful where smaller would be worse:
 *
 *   - sized for the screen it is read on -- this phone's, in its own pixels
 *     (an S23 is 1080 by 2340) -- whichever way it is held: a page, or a
 *     spread, as large as it fills the screen upright or on its side
 *   - a picture taller than the screen (a strip, a long page) is read across
 *     its width, scrolled: only its width is limited, never its length
 *   - room left to zoom: half as big again as the screen, by default, so
 *     small lettering on a page stays sharp held closer
 *   - only made smaller, never only re-encoded: a picture already within that
 *     is left exactly as it is, never written again a generation worse
 *   - left alone: animations, see-through pictures (a JPEG cannot be),
 *     pictures blacked out (their original is kept to undo it), anything that
 *     will not decode, and any that came out less than a tenth smaller
 *
 * The picture keeps its name in the book; what it is now (a JPEG) is read off
 * the picture itself wherever that matters -- an export names it for that.
 */
export const KEEP_SIZES = {
  zoom: { room: 1.5, quality: 0.9, label: 'Room to zoom', note: 'Half as big again as the screen: lettering stays sharp zoomed in' },
  screen: { room: 1, quality: 0.88, label: 'Fits the screen', note: 'As big as the screen shows it, and no bigger' },
};

/* The screen read on, in its own pixels: this phone's, or an S23's when it
 * cannot be told. */
const S23 = { short: 1080, long: 2340 };
export function readingScreen() {
  const ratio = globalThis.devicePixelRatio || 1;
  const w = Math.round((globalThis.screen?.width || 0) * ratio);
  const h = Math.round((globalThis.screen?.height || 0) * ratio);
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  return short >= 600 && long >= 900 ? { short, long } : { ...S23 };
}

/** How much smaller a picture is kept, 1 to leave it as it is. */
export function keptScale(width, height, screen = S23, room = KEEP_SIZES.zoom.room) {
  if (!(width > 0 && height > 0)) return 1;
  const { short, long } = screen;
  // Taller than the screen: read across, scrolled. Its length is not limited.
  const shown = height / width > long / short
    ? short / width
    : Math.max(Math.min(short / width, long / height), Math.min(long / width, short / height));
  return Math.min(1, shown * room);
}

/* Made smaller by less than this, a picture is left: not worth a generation. */
const WORTH_SCALING = 0.9;
const WORTH_SAVING = 0.9;

/** A PNG that can be see-through: by its colour type, or a tRNS chunk before its pixels. */
export function pngSeeThrough(b) {
  if (b.length < 33) return true;
  if (b[25] === 4 || b[25] === 6) return true;
  let i = 8;
  while (i + 8 <= b.length) {
    const length = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + length;
  }
  // Its pixels not reached in what was read: it might be.
  return true;
}

const KEEPABLE = /^image\/(jpeg|jpg|png)$/i;

/**
 * One kept picture made smaller, or null to leave it: { blob, width, height }.
 * `image` is its record in the book (images store).
 */
export async function keptSmaller(image, { size = 'zoom', screen = readingScreen() } = {}) {
  const keep = KEEP_SIZES[size] || KEEP_SIZES.zoom;
  const blob = image?.blob;
  if (!blob || !(blob.size > 0) || image.original || image.animated) return null;
  if (!KEEPABLE.test(blob.type || '')) return null;
  let head;
  try { head = new Uint8Array(await readArrayBuffer(blob.slice(0, Math.min(blob.size, 65536)))); } catch { return null; }
  const png = head[0] === 0x89 && head[1] === 0x50;
  const jpeg = head[0] === 0xff && head[1] === 0xd8;
  if (!png && !jpeg) return null;
  if (png && pngSeeThrough(head)) return null;
  const { width, height } = await pictureSize(blob, { decode: false });
  const scale = keptScale(width, height, screen, keep.room);
  if (scale > WORTH_SCALING) return null;
  const to = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  if (to.width > MOST_CANVAS || to.height > MOST_CANVAS || typeof createImageBitmap !== 'function') return null;
  // Too many pixels to decode safely, whatever it comes out as: kept as it is.
  if (width * height > MOST_PIXELS) return null;
  let bitmap = null;
  try {
    // Decoded straight to the smaller size, smoothed: screentone stays tone, not moire.
    const decoding = createImageBitmap(blob, { resizeWidth: to.width, resizeHeight: to.height, resizeQuality: 'high' });
    bitmap = await Promise.race([
      decoding,
      new Promise((resolve) => setTimeout(() => resolve(null), PATIENCE)),
    ]);
    if (!bitmap) { decoding.then((late) => late?.close?.(), () => {}); return null; }
    const canvas = document.createElement('canvas');
    canvas.width = to.width;
    canvas.height = to.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, to.width, to.height);
    const out = await new Promise((resolve) => (canvas.toBlob ? canvas.toBlob(resolve, 'image/jpeg', keep.quality) : resolve(null)));
    canvas.width = 0;
    canvas.height = 0;
    if (!out || !(out.size > 0) || out.size > blob.size * WORTH_SAVING) return null;
    // Written over the original for good: only once it is seen to be the picture.
    if (!(await looksDrawn(out, to))) return null;
    return { blob: out, ...to };
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/* A picture made smaller, looked at before it replaces the original: the
 * size asked for, and something drawn in it. Short of memory, a phone's
 * canvas can give back a blank picture rather than fail -- all black, the
 * right size, small -- and written over a page that would be the page gone.
 * Looked at very small: a picture of one flat colour throughout is not
 * trusted (a truly blank page is only left as it was). */
const SAMPLE = 24;
export async function looksDrawn(blob, { width, height }) {
  try {
    const size = await pictureSize(blob, { decode: false });
    if (size.width !== width || size.height !== height) return false;
    const bitmap = await createImageBitmap(blob, { resizeWidth: SAMPLE, resizeHeight: SAMPLE, resizeQuality: 'low' });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const context = canvas.getContext('2d');
      if (!context?.getImageData) return false;
      context.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
      const { data } = context.getImageData(0, 0, SAMPLE, SAMPLE);
      let low = 255;
      let high = 0;
      for (let i = 0; i < data.length; i += 4) {
        const light = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (light < low) low = light;
        if (light > high) high = light;
      }
      return high - low >= 8;
    } finally { bitmap.close?.(); }
  } catch {
    return false;
  }
}

/* The same picture still: nothing else written to it since it was read. */
const unchanged = (now, then) => !!now?.blob && now.blob.size === then.blob.size
  && now.blob.type === then.blob.type && !now.original && !now.animated;

/**
 * The pictures of these books kept smaller, one at a time (a phone's memory
 * holds one page decoded, not eight). A book still being imported or
 * downloaded is passed over. Each picture is written where it stands, in one
 * transaction, only if nothing else changed it meanwhile.
 * `make` is keptSmaller, in the tests something standing in for it.
 * @returns {{ books:number, pictures:number, saved:number, looked:number, stopped:boolean }}
 */
export async function keepSmaller(bookIds, { size = 'zoom', screen = readingScreen(), onProgress, shouldStop, make = keptSmaller } = {}) {
  const done = { books: 0, pictures: 0, saved: 0, looked: 0, stopped: false };
  for (let at = 0; at < bookIds.length; at += 1) {
    const book = await store.get('books', bookIds[at]);
    if (!book || book.importing || book.transient) continue;
    const images = await store.byIndex('images', 'bookId', book.id);
    let changed = 0;
    for (let n = 0; n < images.length; n += 1) {
      if (shouldStop?.()) { done.stopped = true; return done; }
      const image = images[n];
      images[n] = null;
      done.looked += 1;
      const small = await make(image, { size, screen });
      if (small) {
        const written = await store.update('images', [book.id, image.href], (now) => (unchanged(now, image)
          ? { ...now, blob: small.blob, width: small.width, height: small.height, keptFrom: now.keptFrom ?? now.blob.size }
          : null));
        if (written) {
          changed += 1;
          done.pictures += 1;
          done.saved += image.blob.size - small.blob.size;
        }
      }
      onProgress?.({ book: at, books: bookIds.length, title: book.title, picture: n + 1, pictures: images.length, saved: done.saved });
    }
    if (changed) done.books += 1;
  }
  return done;
}
