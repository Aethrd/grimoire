/* Object URLs, and why images are not stored as them.
 *
 * URL.createObjectURL() hands back a `blob:` URL scoped to the *document* that
 * created it. Close the app and that document is gone; every such URL stops
 * resolving. Persisting one is persisting a handle to something that will not
 * exist next launch, which is exactly how covers come back blank after a
 * restart while the text is fine.
 *
 * So the blobs themselves live in IndexedDB — which stores Blob values
 * natively — and URLs are minted at render time and released when whatever
 * rendered them goes away.
 */

/**
 * A batch of URLs with a shared lifetime.
 *
 * Anything that rebuilds wholesale (the shelf, the image reel) keeps one pool
 * and releases it before re-rendering; anything with a longer life (a chapter
 * in the reader) keeps a pool per section and releases it when that section is
 * removed. Without the release these leak for as long as the app is open.
 */
export function pool() {
  const urls = new Set();
  return {
    url(blob) {
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.add(url);
      return url;
    },
    release() {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
    get size() { return urls.size; },
  };
}

/**
 * Blob.arrayBuffer() needs Chrome 76. minSdk here is 26, and a device that
 * has never updated its WebView can be older than that, so fall back to
 * FileReader -- the same reason parse.js does not rely on Blob.text().
 */
export function readArrayBuffer(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

/**
 * URLs that outlive a render.
 *
 * A pool is for things rebuilt wholesale; this is for things redrawn often
 * from the same data. Releasing and re-minting a shelf's covers on every
 * render made the browser decode every image again, and until they landed
 * each tile was an empty placeholder -- the flash.
 *
 * Keyed, with a caller-supplied signature saying when the underlying data has
 * actually changed. Identity is no use for anything read back from IndexedDB,
 * which hands back a new object every time.
 */
export function urlCache() {
  const held = new Map();

  return {
    /** The URL for this key, minting one only if the data is new. */
    url(key, blob, signature) {
      if (!blob) return null;
      const existing = held.get(key);
      const unchanged = existing && (existing.blob === blob
        || (signature !== undefined && existing.signature === signature));
      if (unchanged) return existing.url;

      if (existing) URL.revokeObjectURL(existing.url);
      const url = URL.createObjectURL(blob);
      held.set(key, { url, blob, signature });
      return url;
    },

    /** Release everything whose key is not in `keep`. */
    forget(keep) {
      for (const [key, entry] of held) {
        if (keep.has(key)) continue;
        URL.revokeObjectURL(entry.url);
        held.delete(key);
      }
    },

    release() {
      for (const entry of held.values()) URL.revokeObjectURL(entry.url);
      held.clear();
    },

    get size() { return held.size; },
  };
}

/** Measure a bitmap without leaving its URL behind. */
export function measure(blob) {
  return new Promise((resolve) => {
    if (!blob) return resolve({ width: 0, height: 0 });

    let settled = false;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (dims) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(dims);
    };

    /* Bounded. A picture in a format the decoder does not know fires neither
     * load nor error, and the promise would then never settle -- which left
     * the whole picture reel blank rather than short one thumbnail, because
     * every image is measured before any is drawn. Unmeasured is a size of
     * zero, not a reel that never appears. */
    const timer = setTimeout(() => done({ width: 0, height: 0 }), 4000);

    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done({ width: 0, height: 0 });
    img.src = url;
  });
}


/**
 * A picture's size read from its first bytes, without decoding it.
 *
 * Decoding a page of a comic to learn its shape costs as much as showing it,
 * and a book is checked while it opens; the size is written near the start
 * of every common format, so a slice of the file is enough. PNG, GIF, WebP,
 * JPEG, BMP and AVIF are read here; anything else is measured the slow way,
 * unless `decode` is false.
 * @returns {Promise<{width:number,height:number}>} zero both ways if unknown
 */
export async function pictureSize(blob, { decode = true } = {}) {
  const none = { width: 0, height: 0 };
  if (!blob) return none;
  let bytes;
  try {
    bytes = new Uint8Array(await readArrayBuffer(blob.slice(0, Math.min(blob.size, 262144))));
  } catch {
    return decode ? measure(blob) : none;
  }
  const found = sizeFromBytes(bytes);
  return found || (decode ? measure(blob) : none);
}

/** The size written in a picture's header, or null. Exported for the tests. */
export function sizeFromBytes(b) {
  const n = b.length;
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ascii = (i, len) => String.fromCharCode(...b.subarray(i, i + len));
  if (n >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return { width: u32be(16), height: u32be(20) };
  if (n >= 10 && ascii(0, 4) === 'GIF8') return { width: u16le(6), height: u16le(8) };
  if (n >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === 'VP8L') {
      const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (kind === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return null;
  }
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const height = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
    return { width: b[18] | (b[19] << 8) | (b[20] << 16), height: Math.abs(height) };
  }
  // AVIF and HEIF: the image's extent is an 'ispe' box near the start.
  if (n >= 12 && ascii(4, 4) === 'ftyp') {
    for (let i = 8; i + 16 <= n; i++) {
      if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
        return { width: u32be(i + 8), height: u32be(i + 12) };
      }
    }
    return null;
  }
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      // A frame header: its size, whichever kind of compression.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}


/* ── cover images ─────────────────────────────────────────────────────── */

/** What a cover can be picked from. */
export const COVER_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'image/bmp', 'image/svg+xml', 'image/heic', 'image/heif',
  'image/tiff', 'image/x-icon',
];

/** Extensions too, because SAF hands plenty of files over as octet-stream. */
export const COVER_EXTENSIONS =
  '.jpg,.jpeg,.jfif,.png,.apng,.webp,.gif,.avif,.bmp,.svg,.heic,.heif,.tif,.tiff,.ico';

export const COVER_ACCEPT = `image/*,${COVER_TYPES.join(',')},${COVER_EXTENSIONS}`;

/** Long edge of a stored cover. A shelf tile is a couple of hundred pixels. */
const COVER_MAX_EDGE = 1000;

/**
 * Turn any picked file into a cover the app can actually draw.
 *
 * Accepting a file is not the same as being able to show it: a HEIC off a
 * phone camera, or a TIFF, will be offered by the picker and then render as
 * nothing. So the image is decoded first -- if that fails, it is refused with
 * a reason rather than stored as a blank -- and then re-encoded, which both
 * guarantees it displays and stops a 12 megapixel photograph being kept whole
 * as the thumbnail for a book.
 *
 * An animated GIF or APNG becomes its first frame, which is what a cover
 * should be anyway.
 */
export async function normaliseCover(file) {
  const bitmap = await decode(file);
  if (!bitmap) {
    throw new Error('That image could not be read. JPEG, PNG, WebP, GIF, AVIF '
      + 'and BMP all work; HEIC and TIFF often do not.');
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext ? canvas.getContext('2d') : null;
  if (!context) {
    // No canvas to re-encode with. It decoded, so it will display; keep it.
    return file;
  }

  const scale = Math.min(1, COVER_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const encoded = await toBlob(canvas, 'image/webp', 0.85)
    || await toBlob(canvas, 'image/jpeg', 0.85);
  // Only if the re-encode actually saved something, and only when it worked.
  return encoded && encoded.size < file.size ? encoded : (encoded || file);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) return resolve(null);
    canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality);
  });
}

/** createImageBitmap where available; an <img> otherwise. Neither is certain. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth ? img : null);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
