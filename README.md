# Grimoire

An offline ebook reader for Android. Every feature, free, with no account and
no network access.

The reader is HTML, CSS and JavaScript; a small Java shell hosts it in a
`WebView` and signs it. About 400 lines of Java and 3,000 of plain ES modules.
No Node build step, no framework.

**One permission, `INTERNET`, for one feature: translation.** The default
engine is on-device — no account, no API key, and offline once a language pack
is installed. Packs are per language and about 30MB each, and the app only
offers the languages your library is actually in: reading Korean in English
fetches Korean and English, not the other fifty. DeepL and LibreTranslate are there if you want better quality or
your own server. Books are opened through the Storage Access Framework, which
grants access to the one file you picked. There is nothing to sign in to and
nothing to buy.

The reader itself still makes no network calls at all. DeepL refuses
client-side JavaScript (no CORS, deliberately, so keys stay out of pages), so
every request is made natively and the key never reaches the DOM.

## Getting a build

```bash
gradle wrapper --gradle-version 8.11.1   # once, then commit ./gradlew
./gradlew assembleDebug
```

Or push and let CI do it — **Actions → CI** builds on every push and attaches
the APK. For an installable signed build, tag it:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Read `docs/RELEASING.md` before you do that. The short version: make a signing
key and keep it, or every update will force an uninstall and take the library
with it.

```bash
node tests/run.mjs               # 78 assertions, no emulator needed
python3 tools/audit_assets.py    # fails if anything would hit the network
```

## What it does

| Screen | Notes |
|---|---|
| Library | Import, folders, multi-select, editable metadata and covers, cover grid at 2/3/4 up |
| Sort & group | Multi-key sort, per-key direction, 3-level grouping, live preview |
| Reader | Paged or scrolling, side-tap and swipe turns, scrub rail, draggable progress |
| Immersive | Chrome cycles full → chapter row → nothing; copy chapter with word count |
| Layout | Reading mode, face, size, leading, paragraph spacing, margins, alignment, ink — live |
| Image reel | Every image in reading order, filters, viewer, jump-to-page |
| Find in book | Debounced, diacritic-folded, grouped by chapter, stepper |
| Index & marks | TOC or derived index; bookmarks and highlights in one list |
| Theme & fonts | Accent ramp derivation, contrast guard, background image, palette extraction |
| Translation | On-device, DeepL or LibreTranslate; titles, chapter names and body as separate switches |
| Settings | One screen, six panes: text, layout, theme, behaviour, translation, data |
| Stats | Heat grid, streaks with freezes, script-aware word counts, JSON export |
| Take out | Pick pages, image pages or chapters out of a book; recoverable until discarded |
| Black out | Mark a panel by its four corners and cover it; painted into the file, original kept |
| Bin | Deleted books wait here with everything they had; delete for good frees the space |
| Vault | Passphrase-gated shelf, filtered out of search, reel and stats |

Formats read in full: **EPUB 2/3, PDF, CBZ, TXT, Markdown, HTML, FB2**.

PDFs have their **text extracted** rather than being drawn as pictures, so
search, the layout override, translation and copy all work on them like any
other book. A PDF laid out in columns, or one that is really a scan, extracts
poorly — there is no fixing that from this side, and a scan is refused with an
explanation rather than imported empty. Chapters come from the document
outline where it has one, and from even runs of pages where it does not.

pdf.js is bundled along with its CJK character maps and the base fourteen
fonts, because most Korean and Japanese PDFs reference their fonts rather than
embedding them. It adds about 2.3MB to the APK, and is imported on demand so a
library with no PDFs in it never loads any of it.

Those 4.3MB of unmodified library code are **fetched by the build, not
committed** — 169 of the files are character maps. The `vendorPdfJs` Gradle
task pulls them on the first build and skips thereafter, so an ordinary
rebuild costs nothing and an offline rebuild works. To run the reader tests
without touching Gradle:

```bash
node tools/vendor_pdfjs.mjs
```

The PDF suite skips its document tests with a note if it has not been run,
rather than failing.

**Zip archives are unpacked on import, and the folders inside become folders
here.** A zip organised into directories is someone's existing filing, and
rebuilding it by hand afterwards is exactly the tedium worth avoiding. Two
judgement calls it makes for you:

- **A zip goes on the shelf as it is.** Every book file in it is a book,
  filed in the folder it sat in — exactly as the importer has always done.
  It does not join anything: a web novel saved a page per chapter arrives as
  a book per page, and the import says so and points at **Build**, which
  gathers each folder's chapters into one book in reading order (prologue,
  numbered chapters, epilogue, side stories, afterword — not filename order,
  and Korean and Japanese numbering included). For a while the importer did
  that joining itself, and it joined "Dune Part 1" to "Dune Part 2" and
  lifted books out of their folders; the comparison against the September
  importer that caught it is in `tests/test-archive.mjs`.
- **A folder of pictures is a chapter.** A manga series zipped as a folder per
  chapter comes out with a chapter per folder rather than one run of
  thousands of pages; two series side by side are two comics; folders named
  `Vol 1`, `Vol 2` are volumes of one. The 2,000-file limit that refused an
  ordinary sixty-chapter series is now 50,000.
- Pictures picked loose are the pages of one comic, and a file of no known
  kind is refused rather than read as text.
- A zip of images is a comic; a zip containing any readable book is a
  container. The extension cannot tell them apart, so the contents do — and a
  comic in a plain `.zip` imports exactly as a `.cbz` does, which most of them
  are.
- A single wrapper directory is stripped, because zipping a folder puts
  everything under one directory of that name and filing the whole library
  under *My Books* helps nobody. It is **not** stripped when doing so would
  leave every book unfiled — then that directory was the filing, not a wrapper.

Folders can also be set by hand. Long-press a book to enter selection: the
library header becomes a selection header, every cover gains a tick, and a
labelled action grid replaces the tab bar — Open, Folder, Status, Details,
Vault, Delete. Moving offers the folders already in use, so the common case is
one tap and no typing. Group by **Folder** in the
sort sheet, and nest another level under it if you want.
Refused with a stated reason: DOCX, MOBI, AZW3, RTF, CBR — see
`UNSUPPORTED_REASON` in `js/parse.js`.

### Books in, books out, and books taken apart

Four operations, and they are the four directions:

- **Build** joins files into one book. Volumes, chapters, image archives and
  saved pages, in whatever mix: a zip of one, an EPUB of the next, a PDF of
  the third. A book already on the shelf can be the first part, so the volume
  that came out this week goes on the end of the thirty you already have
  without re-importing any of them.
- **Divide** cuts one book into several, at chapters, at pages or at
  paragraphs, with a preview of what each cut actually separates.
- **Take out** removes content and keeps the book. This is the one for what
  arrives attached to a download rather than belonging to the work: the
  scanlator's credit page in front of every chapter, the advertisement spread
  bound into a volume, the duplicated scan, the afterword, the sample chapter
  for a different series.
- **Undo the join** takes a built book back into what it was made from.

A comic gets a **grid of its own pages** to pick from rather than a list of
their names — a page of a comic has no name worth reading and is recognised on
sight. Prose gets the list. And because the commonest job of all is one page
repeated through thirty volumes, **First of each chapter** and **Last of each
chapter** take them in one tap instead of sixty.

#### Looking before leaping

A thumbnail is enough to find a page and not enough to be sure about it: at
eighty pixels a scanlator's credit page and the first page of a chapter are
the same shape, and so are two halves of one spread. A chapter is worse — an
afterword and a chapter are the same row until you read a paragraph of either.

While reading, **Take out** in the toolbar opens this screen at the page on
screen, already picked, and holding a picture offers **Take page out** for
that page alone. Either way the book comes back at the same place once the
page is gone, not the shelf.

So nothing is taken out unseen:

- **The glass on every page opens it full size**, and from there you can step
  through the book one page at a time, picking or unpicking as you go. That is
  also the quickest way through a volume: look, decide, next. It is a separate
  target from the page itself on purpose — one tap cannot mean both *show me
  this* and *remove this*, and making the tap open a viewer would turn picking
  forty credit pages into forty viewers to dismiss.
- **A chapter is previewed by a paragraph of itself**, not by its name.
- **Taking out asks first**, with a strip of the pages themselves rather than
  a number, what the book will be left with, how many pictures stop being
  used, and how many bookmarks come out with them. From there, **Look through
  them** steps through exactly what was listed — the honest answer to "are you
  sure" is the pages, not a louder warning.

#### Covering part of a page instead

Sometimes the page should stay and one panel should not: a spoiler in a
colour insert, a watermark across the art, a translator's note pasted over a
speech bubble. **Black out panels** is in a book's menu, among the shelf's
selection actions and at the top of the image reel, each opening the book's
pictures to pick from. While reading, the toolbar's black-out button takes
the picture on screen, and holding a finger on a picture offers it. Any of
them opens the picture to draw on. **Tap points round what you want
covered** — three for a triangle, six for a six-sided shape, as many as it
needs, joined in the order they were tapped — then **Black out shape**, or
tap the first point again, to fill it in. Each point can then be dragged to
fit, or the dot in the middle of an edge to move that whole edge; a loupe
shows what is under the finger while a point is placed. Press inside a shape
to choose it again, drag to move it, or delete it; black or white, undo, and
zoom.

Saving **paints the shapes into the picture itself**. The book's own copy is
replaced, so the reader, the reel, an exported EPUB, a smaller copy and a book
built onto this one all carry the edit; a mask laid over the page at reading
time would vanish the moment the book left the app. The original is kept
inside the app alongside the shapes, so an edit can be changed later — the
editor always starts again from the original — or put back with **Restore
original**. A comic whose cover is the edited page gets the edited cover too,
unless the cover was picked by hand.

What the confirmation says comes from the **same plan the removal runs**, read
rather than written. A preview worked out by a second piece of code that is
supposed to agree with the first will eventually disagree, and a preview that
can be wrong is worse than none.

Nothing is destroyed on the way out. Every other operation here leaves its
source alone, so a bad result costs a delete; this one reaches into a book
that already exists, and there is no such consolation. So a removal is kept
and can be **put back** until it is **discarded** on purpose. What that costs
is the markup of the removed pages, which is bytes, and leaving their pictures
where they are, which was already paid for — the pictures keep their rows,
flagged rather than deleted, which is why the reel, the export and every kind
of dividing all ask for the pictures the book is *still using*.

Put back works newest-first, as an undo does. That is not a limitation worth
engineering around: it is the only order in which the positions a removal
recorded still describe the book it is going back into. Re-inserting a page
from two removals ago, into a book that has changed shape twice since, would
be a guess dressed up as a restore.

Marks and the saved reading position are handled rather than left to rot. A
mark in a chapter that survives untouched follows it to its new number with
its offsets intact. A mark on text that was removed — or in a chapter whose
offsets have shifted because pages came out of the middle of it — is carried
out **with** the removal and comes back with it, because a mark left pointing
somewhere plausible and wrong is worse than one that is temporarily absent.

### Deleting, in two steps

A mistap on a grid of covers is not a decision, and deleting outright treated
it as one: the file had to be found again, which for something downloaded a
year ago often means not at all.

So **delete** means out of the way, and the **bin** is where gone happens. A
book in the bin keeps everything — its chapters, its pictures, its folder, its
place, its bookmarks — and nothing is freed until it is deleted from the bin.
That is the whole point of the second step: the first one has to be reversible
to be worth having, and reversible means nothing was thrown away.

Both the bin and a blurred cover are carried in the backup, because neither is
a property of the file and so neither comes back from re-importing it.

### Smaller copies

A comic scanned at 2400 pixels tall is four or five times the file of the same
comic at 1400, and on a phone the two are indistinguishable. Writing a book
out can write a smaller one — large, screen or small — and the book on the
shelf keeps every pixel it has: the downscaling happens on the way into the
file, so a smaller copy is a copy rather than an edit.

It gives back the original wherever shrinking would make things worse: an
animated GIF, which would come back as one frame; a page already under the
target, which would lose a generation of quality for nothing; and a result
that came out *bigger*, which happens with line art and flat colour because
PNG's own compression beats JPEG there. The saving is reported rather than
assumed, because on line art it can be close to zero.

### Turning a chapter where your thumb already is

The footer is the one place a tall phone cannot be reached without regripping,
and in a comic — where a chapter is a whole volume — turning a chapter is the
control used most. So it can float: dragged anywhere, resized, and flipped to
whichever side the hand is on, with **up as the next chapter**, because that is
how a thumb reads a stack.

It is **locked by default**, which is the part that makes it usable at all: an
unlocked control sitting over the page is one that moves every time you meant
to press it. Unlock it, put it where you want it, lock it again. Only the
dotted grip drags it — dragging by a button means every slightly imprecise
press moves the thing you were trying to press.

Copy chapter stays in the footer. That one is pressed with two hands.

## How it fits together

```
app/src/main/assets/www/
  index.html          every screen as a section; one carries [data-active]
  css/app.css         tokens; the accent ramp is injected at runtime
  js/store.js         IndexedDB — books, chapters, images, marks, events
  js/theme.js         ramp derivation, contrast guard, palette extraction
  js/parse.js         format parsers and the sanitiser
  js/reader.js        pagination, anchors, chrome, the reading log
  js/library.js       shelf, import pipeline, sort comparator, grouping
  js/screens.js       sort, layout, reel, find, index
  js/panels.js        appearance, language, stats, vault
  js/group.js         which files are one book: chapters, comics, reading order
  js/build.js         the workshop: several files in, one book out
  js/trim.js          taking pages and chapters out, and putting them back
  js/shrink.js        downscaling pictures for a smaller copy
  js/epub.js          writing a book back out as an EPUB
  js/redact.js        blacking out part of a picture, painted into the file
  js/app.js           routing, gestures, the shell's two hooks
```

Five decisions carry most of the weight:

**Position is a character offset, never a page number.** Pages are a function
of type size, margins and screen width; scroll offsets are a function of all
that plus the reading mode. The character offset survives all of it, which is
why changing the font size — or switching between paged and scroll — lands you
on the same sentence rather than somewhere near it.

**Pagination is CSS columns.** The flow is laid out in columns exactly one
viewport wide and translated sideways by exactly that width. Padding lives on
the viewport, not the flow, so a page turn is a translate of 100% with no
arithmetic to get wrong.

**Scroll mode is the same text, flowing down.** Set per book in the layout
sheet. With **endless scroll** on, reaching the end of a chapter runs into the
next one rather than stopping; chapters load as you approach them and are
dropped once well behind, so a long book does not end up entirely in memory.
Prepending is the awkward direction — inserting content above the viewport
moves everything down, so the scroll position is corrected by exactly the
inserted height or the text jumps under your eyes.

**Motion is feedback, not choreography.** Page turns, screen changes and
controls move; text never moves on its own and nothing loops. Transitions are
capped at 250ms, and any jump that is not a page turn — a re-flow, a chapter
load, a scrub — drops the transition, because sliding to an arbitrary page
after a font-size change reads as a fault. `prefers-reduced-motion` removes
motion rather than shortening it.

**The accent ramp is derived, never hand-picked.** One colour produces all
eight steps. `guard()` refuses any accent/ground pair below 4.5:1 for body text
and returns the nearest passing step of the same hue instead.

**Sort keeps nulls last in both directions.** This is why `sortBooks` is not a
comparator chain with a reverse: flipping a descending key would float every
book with no value to the top of the shelf.

**Importing does not parse the chapters.** Building a DOM costs about 1.6ms a
chapter and produces nothing an import needs: the word count and the list of
pictures both come out of the markup as text for a fifth of that. The source
is kept as it came and sanitised on the way to the page instead, where 1.6ms
is invisible. The sanitiser did not go anywhere; it runs when a chapter is actually opened.

**Those figures are from a desktop and overstate the gain on a phone.** jsdom
parses XML in JavaScript, where a WebView uses Blink's native parser, so the
cost being removed is several times smaller on the device than any measurement
taken in the test harness. The app therefore times its own imports: the
elapsed time is reported when one finishes, and Settings → Vault breaks the
last one into reading, parsing and writing. Those are the numbers to judge a
change by.

Keeping the source rather than the sanitised HTML costs about **14% more
storage** — attributes and stylesheets that the sanitiser would have dropped.
Anything that only wants the words strips the source with a regular
expression instead of parsing it, which is what searching a book does.

**Images are stored as blobs, never as blob URLs.** A `blob:` URL is scoped to
the document that created it, so persisting one persists a handle to something
that will not exist next launch — covers come back blank while the text is
fine. The blob data lives in IndexedDB and URLs are minted at render time
through `js/blobs.js`, which also releases them: one pool per rendered chapter,
because endless scroll drops chapters off the far end as you read.

**Archives are read, not loaded.** JSZip has to materialise an entire zip
before a single entry can be touched. A 463MB EPUB full of 80MB animated GIFs
imported fine on its own and killed the app in the middle of a shelf — the
shape of a heap with no room left rather than a broken file. `js/zipreader.js`
reads the central directory from the tail of the Blob and slices each entry
out as it is wanted, so peak memory is the largest single entry rather than
the whole archive. Measured on that book: reading one 83MB illustration cost
JSZip 84MB; twenty chapters through the streaming reader cost 2MB. JSZip
remains the fallback for zip64 and unusual compression, so nothing that
imported before stops importing.

Illustrations over 12MB are skipped. Nothing on a phone will decode an 83MB
GIF, and merely holding one is enough to end the import; the chapter is shown
without it rather than the book failing.

**Books are untrusted input.** `sanitise()` strips scripts, styles, stylesheet
links and event handlers at parse time, not at render time — the reader runs on
the same origin as the app. There is a test asserting a `<script>` inside an
EPUB never executes.

## Tests

`tests/` runs the reader's modules under jsdom — no emulator, a few seconds.

- **logic** — accent ramp, contrast guard, the sort comparator's nulls-last
  rule, grouping
- **parse** — EPUB 2 and 3 including the NCX fallback, sanitiser escapes, CBZ
  natural page ordering, script-aware word counts, refusals with reasons
- **more** — heading-derived indexes, copy-chapter flattening
- **archive** — folder detection, wrapper stripping, comic-versus-container,
  resource-fork junk, and refusals that explain themselves
- **blobs** — that nothing persists a document-scoped URL, and that every URL
  minted is released again
- **shelf** — cover geometry that content cannot stretch, and the selection
  contract: buttons rather than typed menus, in-app confirmation, back leaves
  the mode before the screen
- **trim** — taking pages and chapters out, that nothing is destroyed on the
  way, that marks and the saved position follow or are carried out rather than
  left wrong, that the preview is the removal's own plan and writes nothing,
  and the whole path a finger takes: search, long press, open a page full size,
  pick the credit page out of every chapter, see the confirmation, cancel it,
  confirm it, put it back
- **tools** — the bin as two steps rather than one, the floating chapter pad as
  it is actually drawn on the reader, smaller copies and every case where
  shrinking is refused, building onto a book already on the shelf, and the two
  ways the app used to end up a blank page
- **motion** — reading-mode defaults, and the motion contract: nothing loops,
  no transition over 250ms, reduced motion honoured, text never animates
- **ocr** and **ocr-accuracy** — which scripts are asked for and which reading
  is believed, reading order, the text as read kept apart from the corrected
  text, repeats dropped only where the same text is found in the same place,
  one script failing without losing the others, and the accuracy measures
  themselves (CER, WER, missed, doubled and out-of-order bubbles)
- **freedom** — asserts no paywall, no ads, no sign-in, that `INTERNET` is the
  only permission, that the reader itself cannot reach the network, and that
  translation is inert without a key

That last one exists because those are easy things to reintroduce by accident:
one dependency, one stray import, one merged manifest entry. The release
workflow makes the same check against the built APK, so a permission arriving
through manifest merging fails the build rather than reaching a user.

### How right the text from pictures is

ML Kit only runs on the phone, so accuracy is measured there. In the text
sheet, pick one picture and tap **Check accuracy**. Type, or put right, the
picture's text exactly as printed (one bubble to a paragraph, in reading
order). That answer key is kept with the book. **Check this picture** reads
the picture four ways and scores each one:

- the recogniser alone;
- the reading as it was before the latest steps;
- now, as read;
- now, corrected.

**Check every picture with a key** totals the scores over all of the book's
keyed pictures. **Copy report** gives the table as text.

To score readings off the phone, save them as text files (Copy text) next to
their keys and run:

    node tools/ocr-eval.mjs key.txt reading.txt [reading2.txt …]
    node tools/ocr-eval.mjs keys/ readings-now/ readings-before/

No number means anything without a checked key. A key made by accepting the
reading unchanged scores that reading perfect.

`tools/audit_assets.py` fails on anything that would actually load off-origin —
a `<script src>`, a `fetch()`, a CSS `@import`. A URL in a vendored library's
licence header is not a violation, which is why it replaced a blanket `grep`.

## Known gaps

Honest list, in rough order of how much they matter:

- **The e-ink preset is tuned by eye, not measured.** Its black and white
  points assume manga on white paper; a photograph loses highlight detail
  above about 88% grey. Panels differ in gamma, so the numbers are a starting
  point rather than a calibration.
- **Greying is CSS, not a pipeline.** Luminance and contrast are right, and
  the sharpening is a small convolution. What is not there: local contrast
  (CLAHE), denoising, and choosing between the colour channels for whichever
  carries the most line detail. Those need a canvas pass per page and a cache,
  which is a different piece of work.
- **No optical centering.** The text block is centred by its margins rather
  than by how it looks. Doing it properly means measuring the shape of the set
  text — the ragged edge, the indents, where paragraphs fall — and the honest
  version of that is a typesetting problem rather than a margin tweak.
- ~~**Highlights cannot be created.**~~ Done: select text in the reader and the
  annotation bar appears. The tab renders and the data model supports
  them, but there is no text-selection handler, so that tab stays empty.
- **The vault is a filter, not encryption.** Vault books are hidden from every
  list until unlocked, but the files are not encrypted and the passphrase is a
  single unsalted SHA-256. It wants PBKDF2 at minimum.
- **Fonts are Latin-only.** Word counting is carefully CJK-aware, which implies
  a CJK coverage the bundled subsets do not back. This matters more now that
  on-device translation makes Korean and Japanese libraries practical.
- **Translation is untested against a live engine.** All three paths compile
  and the plumbing is tested, but no request has been made from a device. ML
  Kit's first-run model download is the most likely to need adjustment.
- **Korean and Japanese books will translate but not render well**, because the
  bundled fonts are Latin-only.
- **Downscaling for a smaller copy cannot be tested here.** It needs a real
  canvas to decode and re-encode with, and jsdom has none — so the guards are
  tested (an animated GIF untouched, an already-small page untouched, a result
  that came out bigger rejected) and the actual re-encode is not. The first
  smaller copy written on a device is worth opening and looking at.
- **Dragging the chapter pad is not driven in a test.** jsdom has no layout, so
  a synthetic touch carries no coordinates to drag by. That the pad is drawn
  where it was put, that the footer pair gives way to it, and that its buttons
  turn chapters are all exercised; the drag itself is checked only against the
  source.
- **A removal keeps the markup of what it removed on the book's own row.** For
  a comic that is a handful of image tags and costs nothing; for a two-thousand
  chapter novel, removing a hundred chapters duplicates their text until the
  removal is discarded. It is bounded and recoverable, but it is not free, and
  a per-book cap would be the honest next step.
- **Reading a picked file can be refused by Android**, and the shell reading
  it instead is the workaround rather than a cure. The renderer is a separate
  sandboxed process and is handed a file descriptor rather than the URI grant;
  when a provider refuses that descriptor the page sees `NotReadableError`
  while this process can still open the same URI. The rescue copies the file
  into the app's own storage first, which costs its size in disk for the
  length of the import. It is not tested on a device — jsdom has no content
  providers, so the tests drive a File that refuses to be read and check that
  the shell is asked and the copy is used.
- `boot()` has no catch, so a startup exception is a blank screen.
- **Scroll mode is untested on a device.** jsdom has no layout engine, so every
  measurement in it returns zero; the tests cover the contract around scroll
  mode, not the scrolling. The endless window — append, prepend with scroll
  compensation, and trimming — is the part most likely to need adjustment on
  real hardware.

## Icons

`tools/make_icons.py` regenerates every launcher asset from `art/icon-source.jpg`:

```bash
python3 tools/make_icons.py art/icon-source.jpg
```

Adaptive icons give you a 108dp canvas of which only the centre 66dp is safe;
launchers mask the rest to whatever shape the OEM picked. The source art fills
91% of its frame, so it is scaled to land inside that circle and its square
edge feathered into a background layer of the same colour.

The themed (monochrome) layer is drawn by hand as a vector rather than derived
— Android tints it a single colour, and thresholding a detailed illustration
gives speckle with holes through the middle.

## Targets

compileSdk 36, targetSdk 36, minSdk 26, AGP 8.9.1 on Gradle 8.11.1 — the
minimum AGP that supports API 36.
