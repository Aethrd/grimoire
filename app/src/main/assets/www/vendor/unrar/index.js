/* node-unrar-js 2.0.2 (MIT, see LICENSE.md), the browser half only.
 *
 * Taken from the package's esm/ build with two changes and nothing else: the
 * import paths name their files (".js"), which a page loading modules
 * directly needs and a bundler would have added; and the Node-only file
 * extractor is left out. The WebAssembly is RARLAB's UnRAR source compiled
 * by Emscripten -- see README.md.
 */
import { ExtractorData } from './ExtractorData.js';
import { getUnrar } from './unrar.singleton.js';
export * from './Extractor.js';
export async function createExtractorFromData({ wasmBinary, data, password = '' }) {
  const unrar = await getUnrar(wasmBinary && { wasmBinary });
  const extractor = new ExtractorData(unrar, data, password);
  unrar.extractor = extractor;
  return extractor;
}
