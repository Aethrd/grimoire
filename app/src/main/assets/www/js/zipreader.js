/* Reading a zip without holding it.
 *
 * JSZip loads an entire archive into memory before a single entry can be
 * touched. For an ordinary EPUB that is unremarkable; for a 463MB one full of
 * 80MB animated GIFs it is half a gigabyte of allocation before any work
 * starts, and on a phone that is the end of the process. It survived being
 * imported on its own and died in the middle of a shelf, which is exactly the
 * shape of a heap that has no room left rather than a file that is broken.
 *
 * A zip is random-access by design: the central directory at the end lists
 * every entry and where it starts. So the directory is read from the tail of
 * the Blob, and each entry is sliced and inflated only when it is asked for.
 * Peak memory becomes the largest single entry rather than the whole file.
 *
 * Inflating uses DecompressionStream, which WebView has had since Chrome 80.
 * Where it is missing, or where the archive uses anything unusual, the caller
 * falls back to JSZip and behaves as it always did.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** The end-of-central-directory record lives in the last 64KB at most. */
const TAIL_BYTES = 66_000;

export const canStream = () => typeof DecompressionStream === 'function';

async function bytes(blob, start, end) {
  const slice = blob.slice(start, end);
  const buffer = typeof slice.arrayBuffer === 'function'
    ? await slice.arrayBuffer()
    : await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(slice);
    });
  return new DataView(buffer);
}

/**
 * Locate the end-of-central-directory record.
 *
 * It has no fixed offset: a zip may carry a trailing comment, so the
 * signature has to be searched for backwards from the very end.
 */
function findEocd(view) {
  for (let at = view.byteLength - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

const decoder = new TextDecoder('utf-8');

/**
 * Read the central directory and return an index of the entries.
 *
 * Returns null when the archive is anything other than the ordinary case --
 * zip64, split volumes, an unsupported compression method. The caller falls
 * back rather than this guessing.
 */
export async function openZip(blob) {
  if (!canStream()) return null;

  const tailStart = Math.max(0, blob.size - TAIL_BYTES);
  const tail = await bytes(blob, tailStart, blob.size);
  const eocd = findEocd(tail);
  if (eocd === -1) return null;

  // A zip64 locator immediately before the record means the 32-bit fields
  // below are placeholders. Rare, and not worth reimplementing.
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === EOCD64_LOCATOR) return null;

  const count = tail.getUint16(eocd + 10, true);
  const directorySize = tail.getUint32(eocd + 12, true);
  const directoryAt = tail.getUint32(eocd + 16, true);
  if (directoryAt === 0xffffffff || count === 0xffff) return null;   // zip64

  const directory = await bytes(blob, directoryAt, directoryAt + directorySize);
  const entries = new Map();

  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.byteLength) return null;
    if (directory.getUint32(at, true) !== CENTRAL_SIGNATURE) return null;

    const method = directory.getUint16(at + 10, true);
    const compressedSize = directory.getUint32(at + 20, true);
    const size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const localAt = directory.getUint32(at + 42, true);

    const name = decoder.decode(
      new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength));

    // 0 is stored, 8 is deflate. Anything else is not worth guessing at.
    if (method !== 0 && method !== 8) return null;
    if (size === 0xffffffff || localAt === 0xffffffff) return null;   // zip64

    if (!name.endsWith('/')) {
      entries.set(name, { name, method, compressedSize, size, localAt });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, blob, ...readers(blob, entries) };
}

function readers(blob, entries) {
  /**
   * The local header repeats the name and extra field, and its lengths do not
   * have to match the central directory's, so the data offset can only be
   * found by reading it.
   */
  async function dataRange(entry) {
    const header = await bytes(blob, entry.localAt, entry.localAt + 30);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = entry.localAt + 30 + nameLength + extraLength;
    return [start, start + entry.compressedSize];
  }

  async function raw(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const [start, end] = await dataRange(entry);
    const slice = blob.slice(start, end);
    if (entry.method === 0) return slice;

    // deflate-raw: the zip payload has no zlib header around it.
    const inflate = new DecompressionStream('deflate-raw');
    // Blob.stream() keeps even the compressed bytes off the heap. Where it is
    // missing, reading the compressed extent is still far better than the
    // whole archive.
    const source = typeof slice.stream === 'function'
      ? slice.stream()
      : new ReadableStream({
        async start(controller) {
          const view = await bytes(slice, 0, slice.size);
          controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
          controller.close();
        },
      });
    return new Response(source.pipeThrough(inflate)).blob();
  }

  return {
    has: (name) => entries.has(name),
    sizeOf: (name) => entries.get(name)?.size ?? 0,
    names: () => [...entries.keys()],

    /** The entry as a Blob of the given type, or null if it is not there. */
    async blob(name, type) {
      const data = await raw(name);
      return data ? new Blob([data], { type }) : null;
    },

    /** The entry decoded as UTF-8 text. */
    async text(name) {
      const data = await raw(name);
      if (!data) return null;
      if (typeof data.text === 'function') return data.text();
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsText(data);
      });
    },
  };
}
