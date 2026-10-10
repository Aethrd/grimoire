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

/* The long edge, and how hard to compress.
 *
 * Named for what they are for rather than by number, because a number is only
 * meaningful next to the screen it will be read on.
 */
export const SIZES = {
  full: { edge: 0, quality: 1, label: 'Full size', note: 'Exactly as imported' },
  large: { edge: 2000, quality: 0.86, label: 'Large', note: 'For a tablet' },
  screen: { edge: 1400, quality: 0.82, label: 'Screen', note: 'For a phone' },
  small: { edge: 1000, quality: 0.76, label: 'Small', note: 'For sending' },
};

export const describeSize = (key) => {
  const size = SIZES[key] || SIZES.full;
  return size.edge ? `${size.label.toLowerCase()}, ${size.edge}px` : 'full size';
};

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
export async function shrinkPicture(blob, { edge = 1400, quality = 0.82 } = {}) {
  if (!blob || !edge) return blob;
  if (ANIMATED.test(blob.type || '')) return blob;

  let bitmap = null;
  try {
    bitmap = await Promise.race([
      decode(blob),
      new Promise((resolve) => setTimeout(() => resolve(null), PATIENCE)),
    ]);
  } catch {
    return blob;
  }
  if (!bitmap) return blob;

  const { width, height } = bitmap;
  if (!width || !height) return blob;

  const longest = Math.max(width, height);
  if (longest <= edge) {
    bitmap.close?.();
    return blob;
  }

  const scale = edge / longest;
  const to = { width: Math.round(width * scale), height: Math.round(height * scale) };

  try {
    const canvas = document.createElement('canvas');
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
export async function shrinkAll(images, { edge, quality, onProgress } = {}) {
  const AT_ONCE = 4;
  const out = new Map();
  let done = 0;
  let saved = 0;

  for (let at = 0; at < images.length; at += AT_ONCE) {
    await Promise.all(images.slice(at, at + AT_ONCE).map(async (image) => {
      if (!image.blob) return;
      const small = await shrinkPicture(image.blob, { edge, quality });
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
