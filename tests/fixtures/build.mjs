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
console.log('fixtures written');
