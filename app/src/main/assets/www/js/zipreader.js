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
 * Zip64 archives -- over 4GB, or over 65,535 files -- are read the same way.
 * Where DecompressionStream is missing, or where the archive uses anything
 * unusual, the caller falls back to JSZip and behaves as it always did.
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

const EOCD64_SIGNATURE = 0x06064b50;
const ZIP64_EXTRA = 0x0001;
const UNICODE_PATH_EXTRA = 0x7075;
const MAX32 = 0xffffffff;

/** A 64-bit little-endian number, exact as far as a file can be long. */
const uint64 = (view, at) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x1_0000_0000;

/* Names, in whatever the zip was made with.
 *
 * A zip says its names are UTF-8 with a flag, and plenty that are never set
 * it -- a zip made on a Korean or Japanese Windows writes names in that
 * language's own code page. Read as UTF-8 those are question marks, and a
 * library of folders comes out filed under nonsense. So: UTF-8 if the bytes
 * are UTF-8, then the Unicode name some tools add beside the legacy one,
 * then the code pages such zips are most often made in, then Latin. */
const strict = (label) => {
  try { return new TextDecoder(label, { fatal: true }); } catch { return null; }
};
const UTF8 = strict('utf-8');
const LEGACY = ['euc-kr', 'shift_jis', 'gbk'].map(strict).filter(Boolean);
const LATIN = new TextDecoder('windows-1252');

function decodeName(raw, unicodePath) {
  try { return UTF8.decode(raw); } catch { /* not UTF-8 */ }
  if (unicodePath) return unicodePath;
  for (const decoder of LEGACY) {
    try { return decoder.decode(raw); } catch { /* not this one */ }
  }
  return LATIN.decode(raw);
}

/** The extra fields of one entry, by id. */
function extras(view, start, length) {
  const found = new Map();
  let at = start;
  while (at + 4 <= start + length) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    if (at + 4 + size > start + length) break;
    found.set(id, { at: at + 4, size });
    at += 4 + size;
  }
  return found;
}

/**
 * Where the central directory is, and how many entries it lists.
 *
 * Zip64 -- an archive over 4GB, or of more than 65,535 files, and what some
 * tools write for anything they could not size in advance -- keeps the real
 * numbers in a second record and leaves placeholders in the first. Those
 * used to send the whole archive to JSZip, which reads every byte of it into
 * memory first: for a library zip of a few gigabytes, the end of the app.
 */
async function locateDirectory(blob, tail, tailStart, eocd) {
  const locatorAt = eocd - 20;
  if (locatorAt >= 0 && tail.getUint32(locatorAt, true) === EOCD64_LOCATOR) {
    const recordAt = uint64(tail, locatorAt + 8);
    const record = recordAt >= tailStart
      ? new DataView(tail.buffer, tail.byteOffset + (recordAt - tailStart), 56)
      : await bytes(blob, recordAt, recordAt + 56);
    if (record.byteLength < 56 || record.getUint32(0, true) !== EOCD64_SIGNATURE) return null;
    // Split across several disks is not something a phone is handed.
    if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) return null;
    return { count: uint64(record, 32), size: uint64(record, 40), at: uint64(record, 48) };
  }
  if (tail.getUint16(eocd + 4, true) !== 0) return null;   // split volumes
  return {
    count: tail.getUint16(eocd + 10, true),
    size: tail.getUint32(eocd + 12, true),
    at: tail.getUint32(eocd + 16, true),
  };
}

/**
 * Read the central directory and return an index of the entries.
 *
 * Returns null when the archive is anything this does not read -- split
 * volumes, an unsupported compression method, encryption. The caller falls
 * back rather than this guessing.
 */
export async function openZip(blob) {
  if (!canStream()) return null;

  const tailStart = Math.max(0, blob.size - TAIL_BYTES);
  const tail = await bytes(blob, tailStart, blob.size);
  const eocd = findEocd(tail);
  if (eocd === -1) return null;

  const located = await locateDirectory(blob, tail, tailStart, eocd);
  if (!located) return null;
  const { count, size: directorySize, at: directoryAt } = located;
  if (directoryAt + directorySize > blob.size) return null;

  const directory = await bytes(blob, directoryAt, directoryAt + directorySize);
  const entries = new Map();

  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.byteLength) return null;
    if (directory.getUint32(at, true) !== CENTRAL_SIGNATURE) return null;

    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    let compressedSize = directory.getUint32(at + 20, true);
    let size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let localAt = directory.getUint32(at + 42, true);
    if (at + 46 + nameLength + extraLength > directory.byteLength) return null;

    const extra = extras(directory, at + 46 + nameLength, extraLength);

    /* The real sizes, where these are placeholders. The zip64 field holds
     * only the ones that overflowed, in this order. */
    if (size === MAX32 || compressedSize === MAX32 || localAt === MAX32) {
      const field = extra.get(ZIP64_EXTRA);
      if (!field) return null;
      let read = field.at;
      const next = () => {
        if (read + 8 > field.at + field.size) throw new Error('short zip64 field');
        const value = uint64(directory, read);
        read += 8;
        return value;
      };
      try {
        if (size === MAX32) size = next();
        if (compressedSize === MAX32) compressedSize = next();
        if (localAt === MAX32) localAt = next();
      } catch {
        return null;
      }
    }

    // Encrypted: there is nothing to read without the password.
    if (flags & 0x1) return null;
    // 0 is stored, 8 is deflate. Anything else is not worth guessing at.
    if (method !== 0 && method !== 8) return null;

    const rawName = new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength);
    let unicodePath = null;
    const unicode = extra.get(UNICODE_PATH_EXTRA);
    if (unicode && unicode.size > 5) {
      try {
        unicodePath = UTF8.decode(new Uint8Array(directory.buffer,
          directory.byteOffset + unicode.at + 5, unicode.size - 5));
      } catch { /* a broken one is no worse than none */ }
    }
    // Flagged UTF-8 is UTF-8, whatever else it might also decode as.
    const name = flags & 0x800
      ? new TextDecoder('utf-8').decode(rawName)
      : decodeName(rawName, unicodePath);

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
