# unrar

Reads RAR archives (RAR 4 and RAR 5) in the page, so .cbr comics and .rar
archives can be imported. Nothing is ever written as RAR: the app unpacks the
archive and keeps what was in it.

- `index.js`, `Extractor.js`, `ExtractorData*.js`, `unrar.singleton.js`,
  `unrar.js`, `unrar.wasm`: node-unrar-js 2.0.2 by Jianrong Yu, MIT licence
  (LICENSE.md). https://github.com/YuJianrong/node-unrar.js
- `unrar.wasm` is compiled from RARLAB's UnRAR source (unrarsrc 6.1.7), which
  is distributed under the UnRAR licence: free to use for extracting RAR
  archives, and not to be used to re-create the RAR compression algorithm.
  https://www.rarlab.com/rar_add.htm
