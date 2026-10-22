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

let table = null;
function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crcUpdate(crc, bytes) {
  const t = crcTable();
  let c = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
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
export function zipWriter(write, { zip64At = MAX32 } = {}) {
  const entries = [];
  let offset = 0;
  const stamp = dosTime(new Date());

  const emit = async (bytes) => {
    await write(bytes);
    offset += bytes.length;
  };

  return {
    /** Add a file. Its bytes are read from the Blob and written straight out. */
    async add(name, blob, onProgress) {
      const nameBytes = new TextEncoder().encode(name);
      const size = blob.size;

      let crc = 0;
      for (let at = 0; at < size; at += PIECE) {
        crc = crcUpdate(crc, await bytesOf(blob.slice(at, Math.min(size, at + PIECE))));
        onProgress?.(at / size / 2);
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

      for (let at = 0; at < size; at += PIECE) {
        await emit(await bytesOf(blob.slice(at, Math.min(size, at + PIECE))));
        onProgress?.(0.5 + at / size / 2);
      }
      onProgress?.(1);
      entries.push({ nameBytes, crc, size, start });
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
          [4, 0x02014b50], [2, (3 << 8) | (needs ? 45 : 20)], [2, needs ? 45 : 20], [2, 0x0800], [2, 0],
          [2, stamp.time], [2, stamp.date], [4, entry.crc],
          [4, entry.size >= zip64At ? MAX32 : entry.size], [4, entry.size >= zip64At ? MAX32 : entry.size],
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
