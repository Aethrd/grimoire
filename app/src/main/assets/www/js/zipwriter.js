/* Writing a zip as it is made.
 *
 * Exporting many books at once puts them in one zip. JSZip builds that zip
 * in memory -- and reads every file into memory the moment it is added -- so
 * a batch of books was every book held at once, and then the whole archive
 * again. Large batches took the app past what Android will leave running
 * while the save screen is open, and the export was lost.
 *
 * This writes each file into the archive as soon as it is handed over and
 * keeps nothing of it afterwards: the largest thing held at once is one book
 * and a few megabytes of buffer, however many books there are. Files are
 * stored rather than compressed -- an EPUB is already a zip, and compressing
 * it again saves next to nothing at a real cost in time.
 *
 * Each file is read twice: once for its checksum, which the header in front
 * of it has to carry, and once to write it. That keeps to the plainest form
 * of zip every reader accepts, rather than one with sizes and checksums
 * trailing each file, which some do not. A Blob read twice costs reading it,
 * not holding it.
 *
 * Past 4GB -- thirty volumes of a comic gets there -- the zip64 extensions
 * are written as well, as the format requires.
 */

const PIECE = 3 * 1024 * 1024;
const MAX32 = 0xFFFFFFFF;

/* The checksum, eight bytes at a time (slicing-by-8): several times fewer
 * steps than a byte at a time, for every byte of every book written out. */
let tables = null;
function crcTables() {
  if (tables) return tables;
  tables = Array.from({ length: 8 }, () => new Int32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    tables[0][n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[0][n];
    for (let t = 1; t < 8; t++) { c = tables[0][c & 0xFF] ^ (c >>> 8); tables[t][n] = c; }
  }
  return tables;
}

export function crcUpdate(crc, bytes) {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crcTables();
  let c = ~crc;
  const n = bytes.length;
  let i = 0;
  for (; i + 8 <= n; i += 8) {
    const a = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    c = t7[a & 0xFF] ^ t6[(a >>> 8) & 0xFF] ^ t5[(a >>> 16) & 0xFF] ^ t4[a >>> 24]
      ^ t3[bytes[i + 4]] ^ t2[bytes[i + 5]] ^ t1[bytes[i + 6]] ^ t0[bytes[i + 7]];
  }
  for (; i < n; i++) c = t0[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

/* Two checksums made one, as zlib's crc32_combine: the checksum of A then B
 * from A's, B's and B's length, without reading either again. A book's own
 * checksum is worked out as it is made, so the zip it goes into need not read
 * it all through a second time. */
function gf2Times(mat, vec) {
  let sum = 0;
  for (let i = 0; vec; i++, vec >>>= 1) if (vec & 1) sum ^= mat[i];
  return sum >>> 0;
}
function gf2Square(square, mat) { for (let n = 0; n < 32; n++) square[n] = gf2Times(mat, mat[n]); }
export function crcCombine(crc1, crc2, len2) {
  if (!(len2 > 0)) return crc1 >>> 0;
  const even = new Array(32);
  const odd = new Array(32);
  odd[0] = 0xEDB88320;
  for (let n = 1, row = 1; n < 32; n++, row = (row << 1) >>> 0) odd[n] = row;
  gf2Square(even, odd);
  gf2Square(odd, even);
  let left = len2;
  for (;;) {
    gf2Square(even, odd);
    if (left % 2 === 1) crc1 = gf2Times(even, crc1);
    left = Math.floor(left / 2);
    if (!left) break;
    gf2Square(odd, even);
    if (left % 2 === 1) crc1 = gf2Times(odd, crc1);
    left = Math.floor(left / 2);
    if (!left) break;
  }
  return (crc1 ^ crc2) >>> 0;
}

async function bytesOf(blob) {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/* Deflating by the browser's own zlib, not by script.
 *
 * Each chapter of a book written out is deflated; done in JavaScript (as
 * JSZip does) that was one core flat out for the whole of a long export --
 * the heat. CompressionStream is the same deflate, in the browser's own
 * code, several times cheaper. Where it is missing, null, and the caller
 * keeps to JSZip. */
let deflateKnown = null;
export function canDeflate() {
  if (deflateKnown !== null) return deflateKnown;
  try { deflateKnown = typeof CompressionStream === 'function' && !!new CompressionStream('deflate-raw') && typeof Response === 'function'; } catch { deflateKnown = false; }
  return deflateKnown;
}

export async function deflateRaw(bytes) {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** A little-endian record of fixed fields. */
function record(fields) {
  const size = fields.reduce((n, [bytes]) => n + bytes, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 2) view.setUint16(at, value, true);
    else if (bytes === 4) view.setUint32(at, value >>> 0, true);
    else if (bytes === 8) {
      view.setUint32(at, value % 0x100000000, true);
      view.setUint32(at + 4, Math.floor(value / 0x100000000), true);
    }
    at += bytes;
  }
  return out;
}

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * @param write  called with each piece of the archive, in order, as a
 *               Uint8Array; may return a promise, which is waited for.
 * @param options.zip64At  the size past which the zip64 forms are used. 4GB,
 *               which is what the format says; lower only to test them.
 */
export function zipWriter(write, { zip64At = MAX32, blobs = false } = {}) {
  const entries = [];
  let offset = 0;
  const stamp = dosTime(new Date());

  // `blobs`: a file's own Blob handed on as it is (write takes Blobs too), not copied into bytes.
  const emit = async (bytes, crc) => {
    await write(bytes, crc);
    offset += bytes.size ?? bytes.length;
  };

  return {
    /** Add a file. Its bytes are read from the Blob and written straight out. */
    async add(name, blob, onProgress) {
      const nameBytes = new TextEncoder().encode(name);
      const size = blob.size;

      // Its checksum, if worked out as it was made (an EPUB of epubArchive's); else read for it.
      let crc = Number.isInteger(blob.crc32) ? blob.crc32 >>> 0 : 0;
      if (!Number.isInteger(blob.crc32)) {
        for (let at = 0; at < size; at += PIECE) {
          crc = crcUpdate(crc, await bytesOf(blob.slice(at, Math.min(size, at + PIECE))));
          onProgress?.(at / size / 2);
        }
      }

      const start = offset;
      const big = size >= zip64At;
      const extra = big ? record([[2, 0x0001], [2, 16], [8, size], [8, size]]) : new Uint8Array(0);
      await emit(join(record([
        [4, 0x04034b50], [2, big ? 45 : 20], [2, 0x0800], [2, 0],
        [2, stamp.time], [2, stamp.date], [4, crc],
        [4, big ? MAX32 : size], [4, big ? MAX32 : size],
        [2, nameBytes.length], [2, extra.length],
      ]), nameBytes, extra));

      if (blobs) await emit(blob, crc);
      else {
        for (let at = 0; at < size; at += PIECE) {
          await emit(await bytesOf(blob.slice(at, Math.min(size, at + PIECE))));
          onProgress?.(0.5 + at / size / 2);
        }
      }
      onProgress?.(1);
      entries.push({ nameBytes, crc, size, packed: size, method: 0, start });
    },

    /**
     * Add a file already in memory -- a chapter, a list of contents -- deflated
     * if asked and if that makes it smaller, else stored. Under 4GB, always.
     */
    async addBytes(name, bytes, { deflate = false } = {}) {
      const nameBytes = new TextEncoder().encode(name);
      const crc = crcUpdate(0, bytes);
      let data = bytes;
      let method = 0;
      if (deflate && bytes.length > 64) {
        const packed = await deflateRaw(bytes);
        if (packed.length < bytes.length) { data = packed; method = 8; }
      }
      const start = offset;
      await emit(join(record([
        [4, 0x04034b50], [2, 20], [2, 0x0800], [2, method],
        [2, stamp.time], [2, stamp.date], [4, crc],
        [4, data.length], [4, bytes.length],
        [2, nameBytes.length], [2, 0],
      ]), nameBytes));
      await emit(data);
      entries.push({ nameBytes, crc, size: bytes.length, packed: data.length, method, start });
    },

    /** Write the directory that ends the archive. */
    async finish() {
      const directoryStart = offset;
      for (const entry of entries) {
        const needs = entry.size >= zip64At || entry.start >= zip64At;
        const extraFields = [];
        if (entry.size >= zip64At) extraFields.push([8, entry.size], [8, entry.size]);
        if (entry.start >= zip64At) extraFields.push([8, entry.start]);
        const extra = needs
          ? record([[2, 0x0001], [2, extraFields.reduce((n, [b]) => n + b, 0)], ...extraFields])
          : new Uint8Array(0);
        await emit(join(record([
          // Made on Unix, as an ordinary readable file: tools then take the
          // name as the UTF-8 it is flagged as, and extract with sane
          // permissions rather than none.
          [4, 0x02014b50], [2, (3 << 8) | (needs ? 45 : 20)], [2, needs ? 45 : 20], [2, 0x0800], [2, entry.method || 0],
          [2, stamp.time], [2, stamp.date], [4, entry.crc],
          [4, entry.size >= zip64At ? MAX32 : entry.packed ?? entry.size], [4, entry.size >= zip64At ? MAX32 : entry.size],
          [2, entry.nameBytes.length], [2, extra.length], [2, 0], [2, 0], [2, 0], [4, (0o100644 << 16) >>> 0],
          [4, entry.start >= zip64At ? MAX32 : entry.start],
        ]), entry.nameBytes, extra));
      }
      const directorySize = offset - directoryStart;

      const zip64 = entries.length >= 0xFFFF || directoryStart >= zip64At || directorySize >= zip64At;
      if (zip64) {
        const zip64End = offset;
        await emit(record([
          [4, 0x06064b50], [8, 44], [2, 45], [2, 45], [4, 0], [4, 0],
          [8, entries.length], [8, entries.length], [8, directorySize], [8, directoryStart],
        ]));
        await emit(record([[4, 0x07064b50], [4, 0], [8, zip64End], [4, 1]]));
      }
      await emit(record([
        [4, 0x06054b50], [2, 0], [2, 0],
        [2, Math.min(entries.length, 0xFFFF)], [2, Math.min(entries.length, 0xFFFF)],
        [4, zip64 ? MAX32 : directorySize], [4, zip64 ? MAX32 : directoryStart], [2, 0],
      ]));
    },

    get size() { return offset; },
  };
}
