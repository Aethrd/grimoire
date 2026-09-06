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

/** Measure a bitmap without leaving its URL behind. */
export function measure(blob) {
  return new Promise((resolve) => {
    if (!blob) return resolve({ width: 0, height: 0 });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (dims) => { URL.revokeObjectURL(url); resolve(dims); };
    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done({ width: 0, height: 0 });
    img.src = url;
  });
}
