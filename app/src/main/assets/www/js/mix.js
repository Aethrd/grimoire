/* Which grey a coloured page should become.
 *
 * Luminance is the honest default and the wrong answer often enough to
 * matter. Two hues can differ enormously and sit at nearly the same
 * brightness -- a mid-red and a mid-green land within a few percent of each
 * other -- and when that happens the coloured text and the coloured bubble
 * behind it become the same grey. No amount of levels, gamma or banding
 * recovers it, because the detail was destroyed by the conversion itself.
 *
 * The channels have not lost it, though. Line art that vanishes under
 * luminance is usually still there in one channel, and often stark in it. So
 * rather than assume, this measures: convert a few pages several different
 * ways, see which keeps the most edge detail, and remember the answer.
 *
 * Measured once per book, not per page. A page is a canvas pass and a slow
 * screen cannot afford one per turn -- and a book is drawn by one person in
 * one palette, so the answer barely changes from page to page anyway.
 */

/* The mixes worth trying.
 *
 * Luminance first, so a tie leaves the honest conversion in place. The others
 * lean on one channel each, which is what separates a hue pair that luminance
 * flattens. */
export const MIXES = [
  { name: 'luminance', rgb: [0.2126, 0.7152, 0.0722] },
  { name: 'red', rgb: [0.72, 0.21, 0.07] },
  { name: 'green', rgb: [0.15, 0.75, 0.10] },
  { name: 'blue', rgb: [0.10, 0.25, 0.65] },
  // Red against green, which is the pair luminance collapses most often.
  { name: 'red-green', rgb: [0.62, -0.10, 0.48] },
];

/** Convert pixels to one grey plane with the given weights. */
export function applyMix(pixels, [wr, wg, wb]) {
  const grey = new Float32Array(pixels.length / 4);
  for (let i = 0, g = 0; i < pixels.length; i += 4, g++) {
    const value = (pixels[i] * wr + pixels[i + 1] * wg + pixels[i + 2] * wb) / 255;
    grey[g] = value < 0 ? 0 : value > 1 ? 1 : value;
  }
  return grey;
}

/**
 * How much detail a grey plane holds.
 *
 * Edge energy is most of it: line art, lettering and the boundary of a
 * screentone are all edges, and a conversion that keeps them keeps what the
 * page is made of. Spread matters too but counts for less -- a mix can widen
 * the histogram while smearing the lines, which looks contrasty and reads
 * worse.
 */
export function scoreGrey(grey, width, height) {
  if (width < 3 || height < 3) return 0;

  let edges = 0;
  let sum = 0;
  let squares = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const dx = Math.abs(grey[at + 1] - grey[at - 1]);
      const dy = Math.abs(grey[at + width] - grey[at - width]);
      edges += dx + dy;

      const value = grey[at];
      sum += value;
      squares += value * value;
    }
  }

  const count = (width - 2) * (height - 2);
  const mean = sum / count;
  const spread = Math.sqrt(Math.max(0, squares / count - mean * mean));

  return (edges / count) * 0.75 + spread * 0.25;
}

/**
 * Pick the best mix for a set of sample pages.
 *
 * @param samples  [{ pixels, width, height }] already reduced small; the
 *   measurement wants shape, not resolution, and a full page costs far more
 *   to walk than it adds.
 */
export function chooseMix(samples) {
  if (!samples.length) return MIXES[0];

  const totals = MIXES.map((mix) => {
    let total = 0;
    for (const sample of samples) {
      total += scoreGrey(applyMix(sample.pixels, mix.rgb), sample.width, sample.height);
    }
    return total / samples.length;
  });

  const best = totals.indexOf(Math.max(...totals));

  /* Luminance unless something is clearly better.
   *
   * A mix that wins by a whisker is noise, and switching on noise means two
   * volumes of the same book rendering differently for no reason anyone can
   * see. Ten percent is a margin you can point at on the page.
   */
  if (best > 0 && totals[best] < totals[0] * 1.1) return MIXES[0];
  return MIXES[best];
}

/** Whether a page has enough colour in it for the question to arise. */
export function hasColour(pixels) {
  let coloured = 0;
  let looked = 0;
  // Every eighth pixel: enough to tell a grey scan from a colour page.
  for (let i = 0; i < pixels.length; i += 32) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) coloured++;
    looked++;
  }
  return looked > 0 && coloured / looked > 0.08;
}

/** The matrix a mix becomes, for an feColorMatrix. */
export function matrixFor(mix) {
  const [r, g, b] = mix.rgb;
  return [
    r, g, b, 0, 0,
    r, g, b, 0, 0,
    r, g, b, 0, 0,
    0, 0, 0, 1, 0,
  ].map((n) => Number(n.toFixed(4))).join(' ');
}


/* ── measuring an actual book ─────────────────────────────────────────────

/**
 * Reduce a picture to something small enough to walk quickly.
 *
 * Shape is what the measurement wants, not resolution: a page at 120 pixels
 * across still has its lettering and its panel borders, and costs a
 * thousandth of the work to examine.
 */
export async function sampleImage(blob, size = 120) {
  const url = URL.createObjectURL(blob);
  try {
    const picture = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('that picture could not be read'));
      img.src = url;
    });

    const width = Math.max(3, Math.min(size, picture.naturalWidth || size));
    const height = Math.max(3, Math.round(width * ((picture.naturalHeight || size) / (picture.naturalWidth || size))));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(picture, 0, 0, width, height);
    return { pixels: context.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Work out the best conversion for a book from a few of its pages.
 *
 * Spread through the book rather than taken from the front, because the first
 * pages of a comic are a cover and a title page and are not representative of
 * anything.
 */
export async function measureBook(blobs, { take = 5 } = {}) {
  if (!blobs.length) return null;

  const step = Math.max(1, Math.floor(blobs.length / take));
  const chosen = [];
  for (let at = 0; at < blobs.length && chosen.length < take; at += step) chosen.push(blobs[at]);

  const samples = [];
  for (const blob of chosen) {
    const sample = await sampleImage(blob);
    if (sample) samples.push(sample);
  }
  if (!samples.length) return null;

  // A book with no colour in it has nothing to decide.
  if (!samples.some((sample) => hasColour(sample.pixels))) return MIXES[0];

  return chooseMix(samples);
}
