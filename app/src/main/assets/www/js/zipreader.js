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
 * Peak memory becomes the largest single entry, or a few pieces of the file,
 * rather than the whole file.
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
/**
 * @param options.chunk  the size of a piece of the file read at once
 * @param options.keep   how many pieces are held at a time
 */
export async function openZip(blob, { chunk = CHUNK, keep = KEEP } = {}) {
  if (!canStream()) return null;

  const tailStart = Math.max(0, blob.size - TAIL_BYTES);
  const tail = await bytes(blob, tailStart, blob.size);
  const eocd = findEocd(tail);
  // No end at all: cut off partway, as a download or a save can be. What is
  // whole of it can still be read from the front.
  if (eocd === -1) return recover(blob, { chunk, keep });

  const located = await locateDirectory(blob, tail, tailStart, eocd);
  if (!located) return null;
  const { count, size: directorySize, at: directoryAt } = located;
  if (directoryAt + directorySize > blob.size) return recover(blob, { chunk, keep });

  const directory = await bytes(blob, directoryAt, directoryAt + directorySize);
  const entries = new Map();

  let at = 0;
  for (let i = 0; i < count; i++) {
    /* Not a directory where the end says one is: the end belongs to
     * something else -- a book stored inside this archive, whose own end is
     * all that is left of a file cut short. Handed on, JSZip would "correct"
     * for the mismatch and read that one book as the whole archive. */
    if (at + 46 > directory.byteLength) return recover(blob, { chunk, keep });
    if (directory.getUint32(at, true) !== CENTRAL_SIGNATURE) return recover(blob, { chunk, keep });

    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    let compressedSize = directory.getUint32(at + 20, true);
    let size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let localAt = directory.getUint32(at + 42, true);
    if (at + 46 + nameLength + extraLength > directory.byteLength) return recover(blob, { chunk, keep });

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
      entries.set(name, { name, method, compressedSize, size, localAt, rawName: rawName.slice() });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }

  /* The directory has to describe this file.
   *
   * A zip saved over a larger one, by a provider that would not truncate,
   * ends with the old file's directory -- which describes the old file, so
   * every entry it lists points at bytes that now belong to something else.
   * Trusted, it imported the pages of whatever book used to be there. The
   * first and last entries are looked at where the directory says they are;
   * if what is there is not them, the file is not what its directory says. */
  /* Read through the same pieces as everything else, so looking costs no
   * extra trip out of the page: the first entry is in the first piece and the
   * last is beside the directory, and both are read before long anyway. */
  const reading = readers(blob, entries, { chunk, keep });
  const listed = [...entries.values()].sort((a, b) => a.localAt - b.localAt);
  for (const entry of new Set([listed[0], listed[listed.length - 1]].filter(Boolean))) {
    if (!await reading.isWhereListed(entry)) {
      // The index is not this file's -- but the files in it may well be
      // whole. Read them the way a file manager's extractor does.
      const rescued = await recover(blob, { chunk, keep });
      if (rescued) return rescued;
      throw damagedArchive();
    }
  }

  const { isWhereListed, bytesAt, ...use } = reading;
  return { entries, blob, ...use };
}

/**
 * Read a zip from the front, one entry after another, ignoring its index.
 *
 * The index at the end of a zip is what everything normally goes by, and it
 * is the part that goes wrong: a file saved over a larger one ends with the
 * old file's index, and a file cut off has none at all. Every entry also
 * carries its own header, though, saying its name and how long it is -- which
 * is how a phone's file manager extracts such a file without complaint while
 * this reader refused it. So when the index cannot be trusted, the entries
 * are walked from the start, taking each one that is whole, and stopping at
 * the first thing that is not an entry: the index, the damage, or the end.
 *
 * @returns the archive, marked `recovered`, or null if nothing was whole.
 */
async function recover(blob, { chunk = CHUNK, keep = KEEP } = {}) {
  const entries = new Map();
  const { isWhereListed, bytesAt, ...use } = readers(blob, entries, { chunk, keep });
  let pos = 0;
  for (let n = 0; n < 200000 && pos + 30 <= blob.size; n++) {
    const head = await bytesAt(pos, pos + 30);
    const view = new DataView(head.buffer, head.byteOffset, 30);
    if (view.getUint32(0, true) !== LOCAL_SIGNATURE) break;
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    let compressedSize = view.getUint32(18, true);
    let size = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataStart = pos + 30 + nameLength + extraLength;
    if (dataStart > blob.size) break;
    const meta = (await bytesAt(pos + 30, dataStart)).slice();
    const metaView = new DataView(meta.buffer);
    if (compressedSize === MAX32 || size === MAX32) {
      const field = extras(metaView, nameLength, extraLength).get(ZIP64_EXTRA);
      if (!field || field.size < 8) break;
      let read = field.at;
      if (size === MAX32) { size = uint64(metaView, read); read += 8; }
      if (compressedSize === MAX32 && read + 8 <= field.at + field.size) compressedSize = uint64(metaView, read);
    }
    // Encrypted, or with its length written only after its data: neither can
    // be stepped over without reading it, so this is as far as it goes.
    if (flags & 0x1) break;
    if ((flags & 0x8) && !compressedSize) break;
    if (dataStart + compressedSize > blob.size) break;     // cut off partway through this one

    const rawName = meta.subarray(0, nameLength);
    const name = flags & 0x800 ? new TextDecoder('utf-8').decode(rawName) : decodeName(rawName, null);
    if ((method === 0 || method === 8) && !name.endsWith('/')) {
      entries.set(name, { name, method, compressedSize, size, localAt: pos, rawName });
    }
    pos = dataStart + compressedSize;
    if (flags & 0x8) {
      // The trailing record of sizes, with or without its own signature.
      const sig = pos + 4 <= blob.size ? (await bytesAt(pos, pos + 4)) : null;
      const signed = sig && new DataView(sig.buffer, sig.byteOffset, 4).getUint32(0, true) === 0x08074b50;
      pos += signed ? 16 : 12;
    }
  }
  if (!entries.size) return null;
  return { entries, blob, recovered: true, ...use };
}

const LOCAL_SIGNATURE = 0x04034b50;

/** An archive whose own index does not match its contents. */
export function damagedArchive() {
  const error = new Error('That file is damaged: its contents do not match its own index. '
    + 'This usually happens when a file is saved over an older one. Save or download it again, '
    + 'under a new name.');
  error.damaged = true;
  return error;
}

/* ── reading entries ─────────────────────────────────────────────────────
 *
 * Every read of a Blob on a phone goes out of the page to the browser process
 * and back, and reading an entry one Blob call at a time was four of those
 * -- the local header, the data, the inflate, the text -- for every chapter
 * and every picture. A book of a thousand entries was four thousand round
 * trips in a row: seconds of waiting on a desktop, long enough on a phone
 * that a mass import looked stuck.
 *
 * So the file is read in pieces of a megabyte, each read once and kept for a
 * while: a chapter, its header, and the next few chapters usually share one.
 * A handful of pieces are kept, so memory stays bounded however large the
 * book -- a 79MB one is read in about eighty calls instead of four thousand.
 *
 * Pictures are not copied at all where they can be helped. A picture stored
 * uncompressed, as nearly all are, is handed on as a slice of the file
 * itself, which costs nothing until it is written to storage -- and then is
 * read once, there, rather than into the page and out again.
 */

/** The size of a piece of the file read at once. */
export const CHUNK = 1024 * 1024;
/** How many pieces are kept at a time. */
const KEEP = 12;

function bytesOf(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

/** Inflate bytes already in memory, without a Blob -- so without leaving the page. */
async function inflate(data) {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}

const UTF8_LOOSE = new TextDecoder('utf-8');

function readers(blob, entries, { chunk = CHUNK, keep = KEEP } = {}) {
  /* Pieces of the file, by number, most recently used last. A piece being
   * fetched is kept as its promise, so two entries wanting the same piece at
   * once share the one read. */
  const pieces = new Map();

  function piece(n) {
    let held = pieces.get(n);
    if (held) {
      pieces.delete(n);
      pieces.set(n, held);
      return held;
    }
    const start = n * chunk;
    held = bytesOf(blob.slice(start, Math.min(blob.size, start + chunk)))
      .then((buffer) => new Uint8Array(buffer));
    held.catch(() => pieces.delete(n));
    pieces.set(n, held);
    while (pieces.size > keep) pieces.delete(pieces.keys().next().value);
    return held;
  }

  /** Bytes [start, end) of the file, from the pieces that hold them. */
  async function range(start, end) {
    const first = Math.floor(start / chunk);
    const last = Math.floor((end - 1) / chunk);
    if (first === last) {
      const held = await piece(first);
      return held.subarray(start - first * chunk, end - first * chunk);
    }
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => piece(first + i)));
    const out = new Uint8Array(end - start);
    let at = 0;
    parts.forEach((part, i) => {
      const from = i === 0 ? start - first * chunk : 0;
      const to = i === parts.length - 1 ? end - last * chunk : part.length;
      out.set(part.subarray(from, to), at);
      at += to - from;
    });
    return out;
  }

  /**
   * Where an entry's data starts. The local header repeats the name and extra
   * field, and its lengths do not have to match the central directory's, so
   * the offset can only be found by reading it -- from a piece, usually one
   * already here.
   */
  async function dataRange(entry) {
    const header = await range(entry.localAt, Math.min(blob.size, entry.localAt + 30));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    // Not an entry where the directory says one is: a damaged file, whose
    // bytes here belong to something else. See openZip.
    if (header.byteLength < 30 || view.getUint32(0, true) !== LOCAL_SIGNATURE) throw damagedArchive();
    const start = entry.localAt + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    return [start, start + entry.compressedSize];
  }

  /** Whether the entry the directory lists is really there: its header, its name. */
  async function isWhereListed(entry) {
    const end = Math.min(blob.size, entry.localAt + 30 + entry.rawName.length);
    if (end - entry.localAt < 30 + entry.rawName.length) return false;
    const header = await range(entry.localAt, end);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    return view.getUint32(0, true) === LOCAL_SIGNATURE
      && view.getUint16(26, true) === entry.rawName.length
      && entry.rawName.every((b, i) => header[30 + i] === b);
  }

  /** An entry's bytes, inflated, in memory. Only for entries small enough to hold. */
  async function inMemory(entry) {
    const [start, end] = await dataRange(entry);
    const data = entry.compressedSize ? await range(start, end) : new Uint8Array(0);
    return entry.method === 0 ? data : inflate(data);
  }

  /** An entry as a Blob without bringing it into the page: a slice, or a stream. */
  async function streamed(entry) {
    const [start, end] = await dataRange(entry);
    const slice = blob.slice(start, end);
    if (entry.method === 0) return slice;
    // deflate-raw: the zip payload has no zlib header around it.
    const source = typeof slice.stream === 'function'
      ? slice.stream()
      : new ReadableStream({
        async start(controller) {
          controller.enqueue(new Uint8Array(await bytesOf(slice)));
          controller.close();
        },
      });
    return new Response(source.pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  }

  /* Small enough to read through the pieces: a chapter, a stylesheet, a
   * table of contents. A large entry is read on its own, as before. */
  const small = (entry) => entry.compressedSize <= chunk;

  return {
    isWhereListed,
    bytesAt: range,
    has: (name) => entries.has(name),
    sizeOf: (name) => entries.get(name)?.size ?? 0,
    names: () => [...entries.keys()],

    /** The entry as a Blob of the given type, or null if it is not there. */
    async blob(name, type) {
      const entry = entries.get(name);
      if (!entry) return null;
      // Stored: a slice of the file, which nothing has to copy. Compressed
      // and small: inflated from the piece it is in. Otherwise streamed.
      const data = entry.method !== 0 && small(entry)
        ? await inMemory(entry)
        : await streamed(entry);
      return new Blob([data], { type });
    },

    /** The entry decoded as UTF-8 text. */
    async text(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (small(entry)) return UTF8_LOOSE.decode(await inMemory(entry));
      const data = await streamed(entry);
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
