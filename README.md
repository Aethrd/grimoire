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
| Vault | Passphrase-gated shelf, filtered out of search, reel and stats |

Formats read in full: **EPUB 2/3, CBZ, TXT, Markdown, HTML, FB2**.

**Zip archives are unpacked on import, and the folders inside become folders
here.** A zip organised into directories is someone's existing filing, and
rebuilding it by hand afterwards is exactly the tedium worth avoiding. Two
judgement calls it makes for you:

- A zip of images is a comic; a zip containing any readable book is a
  container. The extension cannot tell them apart, so the contents do.
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
Refused with a stated reason: PDF, DOCX, MOBI, AZW3, RTF, CBR — see
`UNSUPPORTED_REASON` in `js/parse.js`.

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

**Images are stored as blobs, never as blob URLs.** A `blob:` URL is scoped to
the document that created it, so persisting one persists a handle to something
that will not exist next launch — covers come back blank while the text is
fine. The blob data lives in IndexedDB and URLs are minted at render time
through `js/blobs.js`, which also releases them: one pool per rendered chapter,
because endless scroll drops chapters off the far end as you read.

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
- **motion** — reading-mode defaults, and the motion contract: nothing loops,
  no transition over 250ms, reduced motion honoured, text never animates
- **freedom** — asserts no paywall, no ads, no sign-in, that `INTERNET` is the
  only permission, that the reader itself cannot reach the network, and that
  translation is inert without a key

That last one exists because those are easy things to reintroduce by accident:
one dependency, one stray import, one merged manifest entry. The release
workflow makes the same check against the built APK, so a permission arriving
through manifest merging fails the build rather than reaching a user.

`tools/audit_assets.py` fails on anything that would actually load off-origin —
a `<script src>`, a `fetch()`, a CSS `@import`. A URL in a vendored library's
licence header is not a violation, which is why it replaced a blanket `grep`.

## Known gaps

Honest list, in rough order of how much they matter:

- **Highlights cannot be created.** The tab renders and the data model supports
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
