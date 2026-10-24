/* RAR, read as the ZIP it could have been.
 *
 * Comics are as often .cbr as .cbz, and serials are passed around as .rar.
 * The rest of the app reads ZIPs -- a comic from its pages, a container from
 * the books and folders inside it -- so a RAR is unpacked here and its
 * contents written straight back out as a ZIP, which then goes through the
 * importer, or into Build, exactly as a .cbz or .zip would. Everything they
 * already do -- comics told apart from containers, folders kept, the same
 * archive not imported twice -- comes with it for nothing.
 *
 * The reading is RARLAB's UnRAR, compiled to WebAssembly (vendor/unrar). It
 * is loaded the first time a RAR arrives, not before: a library with none in
 * it never pays for it.
 *
 * Memory: the archive is read whole -- the decoder takes it in one piece --
 * but each file is let go of the moment it has been written into the ZIP, and
 * the ZIP is kept as Blobs, which the WebView can hold on disk. The peak is
 * the archive plus the largest file in it, not the archive twice over.
 */

import { zipWriter } from './zipwriter.js';

const MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];   // "Rar!\x1a\x07"

/** Named as a RAR. Whether it is one is for isRar to say. */
export const namedRar = (name) => /\.(rar|cbr)$/i.test(String(name || ''));

async function head(blob, count) {
  const piece = blob.slice(0, count);
  if (typeof piece.arrayBuffer === 'function') return new Uint8Array(await piece.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(piece);
  });
}

/** A RAR, by its first bytes -- whatever it is called. */
export async function isRar(blob) {
  const bytes = await head(blob, MAGIC.length);
  return MAGIC.every((value, i) => bytes[i] === value);
}

async function bytesOf(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

let decoder = null;

/** The decoder, loaded once, from the app's own files. */
function loadDecoder() {
  if (!decoder) {
    decoder = (async () => {
      const [unrar, wasm] = await Promise.all([
        import('../vendor/unrar/index.js'),
        fetch(new URL('../vendor/unrar/unrar.wasm', import.meta.url)).then((response) => {
          if (!response.ok) throw new Error(`the RAR reader could not be loaded (${response.status})`);
          return response.arrayBuffer();
        }),
      ]);
      return { unrar, wasmBinary: wasm };
    })();
    // A failed load is tried again next time rather than remembered.
    decoder.catch(() => { decoder = null; });
  }
  return decoder;
}

/** For tests, which have no page to fetch the decoder from. */
export function useDecoder(unrar, wasmBinary) {
  decoder = Promise.resolve({ unrar, wasmBinary });
}

/** What went wrong, said plainly. */
function plainly(error, name) {
  const reason = error?.reason || '';
  if (reason === 'ERAR_MISSING_PASSWORD' || reason === 'ERAR_BAD_PASSWORD') {
    return `“${name}” is locked with a password. Unlock it with a RAR app and import what is inside.`;
  }
  if (reason === 'ERAR_BAD_DATA' || reason === 'ERAR_BAD_ARCHIVE' || reason === 'ERAR_EREAD'
    || reason === 'ERAR_UNKNOWN_FORMAT') {
    return `“${name}” is damaged or did not finish downloading.`;
  }
  if (reason === 'ERAR_NO_MEMORY' || error instanceof RangeError) {
    return `“${name}” is too large to unpack on this phone. Unpack it with a RAR app and import what is inside.`;
  }
  if (reason === 'ERAR_EREFERENCE' || reason === 'ERAR_EOPEN') {
    return `“${name}” is one part of a split archive. Join the parts with a RAR app first.`;
  }
  return `“${name}” could not be unpacked: ${error?.message || 'unknown error'}`;
}

/** The name the unpacked copy goes by: a comic stays a comic. */
export function zipNameFor(name) {
  const base = String(name || 'archive').replace(/\.(rar|cbr)$/i, '');
  return /\.cbr$/i.test(name) ? `${base}.cbz` : `${base}.zip`;
}

/**
 * A RAR's contents as a ZIP File.
 *
 * @param file        the RAR
 * @param onProgress  called with (fraction, name of the file being unpacked)
 * @returns a File named as the ZIP equivalent: ".cbr" becomes ".cbz", and
 *   anything else ".zip"
 */
export async function rarToZip(file, onProgress) {
  const { unrar, wasmBinary } = await loadDecoder();

  let extractor;
  try {
    extractor = await unrar.createExtractorFromData({ wasmBinary, data: await bytesOf(file) });
  } catch (error) {
    throw new Error(plainly(error, file.name));
  }

  const parts = [];
  const zip = zipWriter((bytes) => { parts.push(new Blob([bytes])); });

  try {
    // Listed first, for the count the progress is measured against.
    const listed = [...extractor.getFileList().fileHeaders].filter((h) => !h.flags.directory);
    const total = listed.reduce((n, h) => n + (h.unpSize || 0), 0) || 1;
    let done = 0;

    const { files } = extractor.extract();
    for (const entry of files) {
      const header = entry.fileHeader;
      if (header.flags.directory) continue;
      const name = header.name.replace(/\\/g, '/').replace(/^\/+/, '');
      onProgress?.(Math.min(1, done / total), name.split('/').pop());
      const data = entry.extraction;
      // Let go of the decoder's own copy at once, rather than at the end of
      // the archive: kept, every file unpacked so far stays in memory.
      delete extractor.dataFiles?.[extractor.getExtractedFileName?.(header.name)];
      if (!data) continue;
      await zip.add(name, new Blob([data]));
      done += header.unpSize || data.length;
    }
    await zip.finish();
  } catch (error) {
    throw new Error(plainly(error, file.name));
  }

  onProgress?.(1, '');
  if (!parts.length) throw new Error(`“${file.name}” is empty.`);
  return new File(parts, zipNameFor(file.name), { type: 'application/zip' });
}
