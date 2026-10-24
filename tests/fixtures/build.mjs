import JSZip from 'jszip';
import fs from 'node:fs';

// A minimal but valid EPUB 3: container, OPF with metadata and a nav
// document, two chapters, one image.
const zip = new JSZip();
zip.file('mimetype', 'application/epub+zip');
zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>The Salt Almanac</dc:title>
<dc:creator>Oyelaran</dc:creator>
<dc:language>en</dc:language>
<meta name="calibre:series" content="Tidewater"/>
<meta name="calibre:series_index" content="2"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="images/plate.png" media-type="image/png" properties="cover-image"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`);

zip.file('OEBPS/nav.xhtml', `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="ch1.xhtml">Salt and Tide</a></li>
<li><a href="ch2.xhtml">The Reckoning</a></li>
</ol></nav></body></html>`);

// Chapter 1 deliberately carries a <script>, an inline style and a stylesheet
// link, to prove the sanitiser strips all three.
zip.file('OEBPS/ch1.xhtml', `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<link rel="stylesheet" href="style.css"/><style>p{color:red}</style></head><body>
<h1>Salt and Tide</h1>
<p>The harbour kept its own accounts.</p>
<p onclick="steal()">Ledgers of brine and weather<sup>1</sup>.</p>
<script>window.stolen = true;</script>
<img src="images/plate.png" alt="A plate"/>
</body></html>`);

zip.file('OEBPS/ch2.xhtml', `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>The Reckoning</h1><p>Every debt came due at once.</p></body></html>`);

// 1x1 PNG
zip.file('OEBPS/images/plate.png', Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

const buf = await zip.generateAsync({ type: 'nodebuffer' });
fs.writeFileSync('tests/fixtures/salt-almanac.epub', buf);

// And a CBZ with out-of-order page names, to prove the natural sort.
const cbz = new JSZip();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
for (const n of ['page10.png','page2.png','page1.png']) cbz.file(n, png);
fs.writeFileSync('tests/fixtures/comic.cbz', await cbz.generateAsync({ type:'nodebuffer' }));
// A minimal but genuinely valid PDF: two pages of text, no outline, so the
// page-grouping path is exercised as well as extraction.
function pdfStream(lines) {
  let body = 'BT /F1 12 Tf 72 720 Td 14 TL\n';
  for (const line of lines) body += `(${line}) Tj T*\n`;
  return Buffer.from(body + 'ET');
}

const pdfPages = [
  pdfStream([
    'Chapter the first, in which a minimal document',
    'is constructed by hand for the purpose of',
    'proving that text extraction works.',
    'Short line.',
    'A second paragraph begins here and runs on for',
    'long enough to look like a paragraph rather than',
    'a heading of some kind.',
  ]),
  pdfStream([
    'The second page carries its own text so that',
    'page grouping has something to group.',
    'End.',
  ]),
];

const objs = new Map([
  [1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')],
  [2, Buffer.from('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>')],
  [3, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>')],
  [4, Buffer.concat([Buffer.from(`<< /Length ${pdfPages[0].length} >>\nstream\n`), pdfPages[0], Buffer.from('\nendstream')])],
  [5, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>')],
  [6, Buffer.concat([Buffer.from(`<< /Length ${pdfPages[1].length} >>\nstream\n`), pdfPages[1], Buffer.from('\nendstream')])],
  [7, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')],
]);

let pdf = Buffer.from('%PDF-1.4\n');
const offsets = new Map();
for (const [num, obj] of objs) {
  offsets.set(num, pdf.length);
  pdf = Buffer.concat([pdf, Buffer.from(`${num} 0 obj\n`), obj, Buffer.from('\nendobj\n')]);
}
const xref = pdf.length;
let table = `xref\n0 ${objs.size + 1}\n0000000000 65535 f \n`;
for (const [num] of objs) table += `${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`;
pdf = Buffer.concat([pdf, Buffer.from(table),
  Buffer.from(`trailer\n<< /Size ${objs.size + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
fs.writeFileSync('tests/fixtures/sample.pdf', pdf);

console.log('fixtures written');


/* RAR fixtures, stored rather than compressed.
 *
 * Nothing on npm writes RAR, and RAR's compression is not something to
 * re-create, so these are written with every file stored as it is: the
 * marker, the archive header, a header in front of each file, and the end of
 * the archive. That is enough for UnRAR to read, and it is UnRAR -- the same
 * decoder the app uses -- that the tests read them with. The compressed RAR 5
 * sample the tests use as well is real, and embedded in the test itself. */
function crc32(bytes) {
  let c, crc = 0xFFFFFFFF;
  for (const b of bytes) {
    c = (crc ^ b) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function rarBlock(type, flags, body) {
  const rest = Buffer.alloc(5 + body.length);
  rest.writeUInt8(type, 0);
  rest.writeUInt16LE(flags, 1);
  rest.writeUInt16LE(7 + body.length, 3);
  body.copy(rest, 5);
  const head = Buffer.alloc(2);
  head.writeUInt16LE(crc32(rest) & 0xFFFF, 0);
  return Buffer.concat([head, rest]);
}
function storedRar(entries) {
  const parts = [Buffer.from('Rar!\x1a\x07\x00', 'latin1'), rarBlock(0x73, 0, Buffer.alloc(6))];
  for (const [name, data] of entries) {
    const raw = Buffer.from(name.replace(/\//g, '\\'), 'latin1');
    const body = Buffer.alloc(25);
    body.writeUInt32LE(data.length, 0);          // packed size
    body.writeUInt32LE(data.length, 4);          // unpacked size
    body.writeUInt8(2, 8);                       // made on Windows
    body.writeUInt32LE(crc32(data), 9);
    body.writeUInt32LE(0x5A210000, 13);          // a date in 2025
    body.writeUInt8(29, 17);                     // version needed
    body.writeUInt8(0x30, 18);                   // method: stored
    body.writeUInt16LE(raw.length, 19);
    body.writeUInt32LE(0x20, 21);                // attributes: a file
    parts.push(rarBlock(0x74, 0x8000, Buffer.concat([body, raw])), data);
  }
  parts.push(Buffer.from([0xC4, 0x3D, 0x7B, 0x00, 0x40, 0x07, 0x00]));
  return Buffer.concat(parts);
}
const cbr = storedRar([['page1.png', png], ['page2.png', png], ['page10.png', png]]);
fs.writeFileSync('tests/fixtures/comic.cbr', cbr);
fs.writeFileSync('tests/fixtures/books.rar', storedRar([
  ['Volume 1/Salt Almanac.epub', fs.readFileSync('tests/fixtures/salt-almanac.epub')],
  ['Comics/Nested Comic.cbr', cbr],
]));
