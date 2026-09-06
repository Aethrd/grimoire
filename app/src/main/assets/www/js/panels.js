/* Settings-side screens: appearance, language, stats, vault.
 *
 * Nothing here is gated. Every control does what it says the moment you tap
 * it, and there is no tier above this one to buy.
 */

import * as store from './store.js';
import * as theme from './theme.js';
import * as reader from './reader.js';
import { setVaultUnlocked, vaultUnlocked } from './library.js';
import { toast } from './screens.js';
import * as translate from './translate.js';
import * as blobs from './blobs.js';

const el = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let refreshTheme = () => {};
export function onThemeChange(fn) { refreshTheme = fn; }

function row(title, sub, control) {
  const node = document.createElement('div');
  node.className = 'row';
  node.innerHTML = `<div class="row-text"><b>${escape(title)}</b>${sub ? `<small>${escape(sub)}</small>` : ''}</div>`;
  if (control) node.appendChild(control);
  return node;
}

function toggle(on, onChange) {
  const button = document.createElement('button');
  button.className = 'switch';
  button.setAttribute('aria-pressed', String(on));
  button.onclick = () => {
    const next = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(next));
    onChange(next);
  };
  return button;
}

/* ── SCR-09 Theme & fonts ─────────────────────────────────────────────── */

/*
 * These three render into a container rather than a fixed element, because
 * each is both a screen of its own and a pane inside Settings. Moving their
 * children into the settings body once was not enough: every internal
 * re-render went back to the original element, which is off-screen inside
 * Settings -- so changing the engine, the target language or downloading a
 * pack all looked like they did nothing at all.
 */
export async function openAppearance(host) {
  const body = host || el('appearance-body');
  const settings = await store.settings();
  body.innerHTML = '';

  const modes = document.createElement('div');
  modes.className = 'field';
  modes.innerHTML = '<label><span>Mode</span><span class="muted">Dark is the default</span></label>';
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [value, label] of [['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow system']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String(settings.themeMode === value));
    button.onclick = async () => {
      const next = await store.saveSettings({
        themeMode: value,
        // The veil defaults differ per ground, so move it with the mode
        // unless the reader has already chosen their own.
        veil: value === 'light' ? 0.28 : 0.62,
      });
      theme.apply(next);
      refreshTheme();
      openAppearance(body);
    };
    seg.appendChild(button);
  }
  modes.appendChild(seg);
  body.appendChild(modes);

  // Accent. Every choice derives the full ramp, and the guard refuses any
  // pair that would put body text under 4.5:1 on the resulting ground.
  const accents = document.createElement('div');
  accents.className = 'field';
  accents.innerHTML = '<label><span>Accent</span><span class="muted">Builds the whole ramp</span></label>';
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  for (const [name, hex] of theme.ACCENT_PRESETS) {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.style.background = hex;
    button.title = name;
    button.setAttribute('aria-pressed', String(settings.accent.toLowerCase() === hex.toLowerCase()));
    button.onclick = async () => {
      const ground = theme.GROUNDS[document.documentElement.dataset.mode].bg;
      const check = theme.guard(hex, ground);
      const next = await store.saveSettings({ accent: hex });
      theme.apply(next);
      refreshTheme();
      if (!check.ok) toast('Adjusted to the nearest readable step of that hue');
      openAppearance(body);
    };
    swatches.appendChild(button);
  }
  accents.appendChild(swatches);

  const ramp = document.createElement('div');
  ramp.style.cssText = 'display:flex;margin-top:10px;border-radius:6px;overflow:hidden';
  for (const step of theme.ramp(settings.accent)) {
    const cell = document.createElement('span');
    cell.style.cssText = `flex:1;height:16px;background:${step}`;
    ramp.appendChild(cell);
  }
  accents.appendChild(ramp);

  const ground = theme.GROUNDS[document.documentElement.dataset.mode].bg;
  const ratio = theme.contrast(theme.guard(settings.accent, ground).ink, ground);
  const check = document.createElement('p');
  check.className = 'eyebrow';
  check.style.marginTop = '8px';
  check.textContent = `Body text contrast ${ratio.toFixed(1)}:1 — ${ratio >= 4.5 ? 'passes' : 'blocked, using nearest passing step'}`;
  accents.appendChild(check);
  body.appendChild(accents);

  // Background image + veil.
  const bg = document.createElement('div');
  bg.className = 'field';
  bg.innerHTML = '<label><span>Background image</span></label>';
  const pick = document.createElement('button');
  pick.className = 'btn ghost block';
  pick.textContent = settings.backgroundImage ? 'Replace image' : 'Choose image';
  pick.onclick = () => {
    pickImage(async (dataUrl, img) => {
      const next = await store.saveSettings({ backgroundImage: dataUrl });
      theme.apply(next);
      // A new image means a new palette, computed fresh every time.
      const palette = theme.extractPalette(img);
      renderPalette(palette);
      openAppearance(body);
    });
  };
  bg.appendChild(pick);

  if (settings.backgroundImage) {
    const veil = document.createElement('label');
    veil.className = 'field';
    veil.style.marginTop = '12px';
    veil.innerHTML = `<label><span>Veil</span><span>${Math.round(settings.veil * 100)}%</span></label>`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: 0, max: 0.95, step: 0.01, value: settings.veil });
    input.oninput = async () => {
      const next = await store.saveSettings({ veil: parseFloat(input.value) });
      veil.querySelector('label span:last-child').textContent = `${Math.round(next.veil * 100)}%`;
      theme.apply(next);
    };
    veil.appendChild(input);
    bg.appendChild(veil);

    const clear = document.createElement('button');
    clear.className = 'btn ghost block';
    clear.style.marginTop = '8px';
    clear.textContent = 'Remove image';
    clear.onclick = async () => {
      const next = await store.saveSettings({ backgroundImage: null });
      theme.apply(next);
      openAppearance(body);
    };
    bg.appendChild(clear);
  }
  body.appendChild(bg);

  const paletteHost = document.createElement('div');
  paletteHost.id = 'auto-palette';
  body.appendChild(paletteHost);

  // Font import needs a bridge the shell does not have yet, so say so rather
  // than shipping a control that quietly does nothing.
  const fonts = document.createElement('div');
  fonts.className = 'card';
  fonts.innerHTML = `
    <h2>Font import</h2>
    <p class="muted" style="font-size:12px;line-height:1.5;margin:0">
      Archivo and Newsreader are bundled. Importing your own .ttf or .otf needs a
      persistent copy in app storage, which means one more bridge method —
      <code>GrimoireNative.saveFont()</code>. Until then this is bundled faces only.</p>`;
  body.appendChild(fonts);

  function renderPalette(palette) {
    paletteHost.innerHTML = '';
    if (!palette.length) return;
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label><span>From your image</span></label>';
    const list = document.createElement('div');
    list.className = 'swatches';
    for (const [name, hex] of palette) {
      const button = document.createElement('button');
      button.className = 'swatch';
      button.style.background = hex;
      button.title = name;
      button.onclick = async () => {
        const next = await store.saveSettings({ accent: hex });
        theme.apply(next);
        refreshTheme();
        openAppearance(body);
      };
      list.appendChild(button);
    }
    field.appendChild(list);
    paletteHost.appendChild(field);
  }
}

function pickImage(onPicked) {
  const input = document.createElement('input');
  input.type = 'file';
  // The same breadth as a book cover: anything the device can decode.
  input.accept = blobs.COVER_ACCEPT;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let usable;
    try {
      // Decoded and re-encoded first. A background is stored as a data URL in
      // settings, and a twelve megapixel photograph kept whole there is a
      // needless few megabytes carried around forever.
      usable = await blobs.normaliseCover(file);
    } catch (error) {
      return toast(error.message, 6000);
    }
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => onPicked(fr.result, img);
      img.onerror = () => toast('That image could not be read.', 5000);
      img.src = fr.result;
    };
    fr.onerror = () => toast('That image could not be read.', 5000);
    fr.readAsDataURL(usable);
  };
  input.click();
}

/* ── SCR-10 Language ──────────────────────────────────────────────────── */

export async function openLanguage(host) {
  const body = host || el('language-body');
  const settings = await store.settings();
  const state = translate.status();
  body.innerHTML = '';

  if (state.unavailable) {
    body.innerHTML = `<div class="card"><h2>Translation unavailable</h2>
      <p class="muted" style="font-size:12px;line-height:1.55;margin:0">
        This build has no translation bridge.</p></div>`;
    return;
  }

  /* The key. Held natively and never handed back to this page: DeepL refuses
     client-side calls precisely because a key in a page is readable by anyone
     with the page. Only whether one is set, and a hint, cross the bridge. */
  const keyCard = document.createElement('div');
  keyCard.className = 'card';
  keyCard.innerHTML = `<h2>DeepL</h2>
    <p class="muted" style="font-size:12px;line-height:1.55;margin:0 0 12px">
      ${state.configured
        ? `Connected on the ${escape(state.plan)} plan, key ${escape(state.hint || '')}.`
        : `Translation is off until you add an API key. A free key covers 500,000
           characters a month — enough for a great many chapter titles.
           Get one at deepl.com under Account → API keys.`}
      <br><br>Until a key is set the app makes no network requests at all.</p>`;

  if (!state.configured) {
    const field = document.createElement('div');
    field.className = 'field';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'DeepL API key';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    const save = document.createElement('button');
    save.className = 'btn primary block';
    save.style.marginTop = '10px';
    save.textContent = 'Connect';
    save.onclick = async () => {
      if (!input.value.trim()) return toast('Paste your key first');
      save.disabled = true;
      save.textContent = 'Checking…';
      try {
        // Verified against DeepL before it is stored, so a typo fails here
        // rather than on the first chapter you try to read.
        await translate.setKey(input.value);
        toast('Connected to DeepL');
        openLanguage(body);
      } catch (error) {
        save.disabled = false;
        save.textContent = 'Connect';
        toast(error.message, 5000);
      }
    };
    field.append(input, save);
    keyCard.appendChild(field);
  } else {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px';
    const check = document.createElement('button');
    check.className = 'btn ghost';
    check.style.flex = '1';
    check.textContent = 'Check usage';
    check.onclick = async () => {
      try {
        const used = await translate.usage();
        const count = used?.character_count ?? 0;
        const limit = used?.character_limit ?? 0;
        toast(limit
          ? `${count.toLocaleString()} of ${limit.toLocaleString()} characters used`
          : `${count.toLocaleString()} characters used`, 4000);
      } catch (error) { toast(error.message, 4000); }
    };
    const forget = document.createElement('button');
    forget.className = 'btn ghost';
    forget.style.flex = '1';
    forget.textContent = 'Disconnect';
    forget.onclick = async () => {
      await translate.clearKey();
      toast('Key removed. No further requests will be made.');
      openLanguage(body);
    };
    row.append(check, forget);
    keyCard.appendChild(row);
  }
  body.appendChild(keyCard);

  // Target language.
  const target = document.createElement('div');
  target.className = 'field';
  target.innerHTML = '<label><span>Translate into</span></label>';
  const chips = document.createElement('div');
  chips.className = 'chip-row wrap';
  for (const [code, label] of translate.TARGETS) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(settings.translateTarget === code));
    chip.onclick = async () => {
      await store.saveSettings({ translateTarget: code });
      openLanguage(body);
      refreshTheme();
    };
    chips.appendChild(chip);
  }
  target.appendChild(chips);
  body.appendChild(target);

  /* Three switches, not one setting with three effects. Titles are cheap and
     translate once per book; chapter names are cheap and translate once per
     book; body text is neither, and is charged by the paragraph. */
  const scope = document.createElement('section');
  scope.className = 'block';
  scope.innerHTML = '<h2>What to translate</h2>';
  for (const [key, title, sub] of [
    ['translateTitles', 'Book titles', 'On the shelf and the continue card. A few words per book, translated once.'],
    ['translateChapters', 'Chapter names', 'In the index and the reader header. Translated once per book.'],
    ['translateBody', 'Body text', 'Adds a translate button to the reader. Charged per paragraph, so it is on demand rather than automatic — and the original is never overwritten.'],
  ]) {
    scope.appendChild(row(title, sub, toggle(settings[key], async (on) => {
      await store.saveSettings({ [key]: on });
      if (on && !translate.status().configured) toast('Add a DeepL key above to use this');
      refreshTheme();
    })));
  }
  body.appendChild(scope);

  // Language packs, but only the ones this library could actually use.
  if (state.engine === 'ondevice') {
    const books = await store.all('books');
    const needed = translate.neededLanguages(books, settings.translateTarget);
    let installed = [];
    try { installed = await translate.models() || []; } catch { installed = []; }

    const packs = document.createElement('section');
    packs.className = 'block';
    packs.innerHTML = `<h2>Language packs</h2>
      <p class="muted" style="font-size:12px;line-height:1.55">
        One pack per language, about 30MB each, downloaded once over Wi-Fi and
        then offline forever. Not one per book, and not the whole set — reading
        Korean in English needs Korean and English and nothing else. Only the
        languages your library is actually in are listed.</p>`;

    const missing = needed.filter((t) => !installed.includes(t));
    if (missing.length > 1) {
      const all = document.createElement('button');
      all.className = 'btn primary block';
      all.style.marginBottom = '12px';
      all.textContent = `Download all ${missing.length} (about ${missing.length * 30}MB)`;
      all.onclick = async () => {
        all.disabled = true;
        let done = 0;
        for (const tag of missing) {
          all.textContent = `${translate.languageName(tag)}… (${done + 1} of ${missing.length})`;
          try {
            await translate.downloadModel(tag);
            done += 1;
          } catch (error) {
            // One failure should not abandon the rest.
            toast(`${translate.languageName(tag)}: ${error.message}`, 5000);
          }
        }
        toast(done === missing.length
          ? `${done} language packs ready offline`
          : `${done} of ${missing.length} installed`);
        openLanguage(body);
      };
      packs.appendChild(all);
    }

    if (!needed.length) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.style.fontSize = '12px';
      note.textContent = books.length
        ? 'None of your books say what language they are in. Set it in a book\u2019s details and it will appear here.'
        : 'Import some books and the languages they need will appear here.';
      packs.appendChild(note);
    }

    for (const tag of needed) {
      packs.appendChild(packRow(tag, installed.includes(tag),
        installed.includes(tag) ? null : 'In your library \u00b7 about 30MB, over Wi-Fi'));
    }

    // Packs for languages no longer in the library are still taking up room.
    for (const tag of installed.filter((t) => !needed.includes(t))) {
      packs.appendChild(packRow(tag, true, 'Installed, but nothing in your library uses it'));
    }

    /* Everything else on offer, behind a disclosure. Your library's own
       languages are the ones you almost certainly want; the rest is a list of
       fifty-odd and does not belong in the way of them. */
    const rest = translate.allLanguages()
      .filter((tag) => !needed.includes(tag) && !installed.includes(tag));
    if (rest.length) {
      const more = document.createElement('details');
      more.className = 'more-langs';
      more.innerHTML = `<summary>Other languages (${rest.length})</summary>`;
      const restBody = document.createElement('div');
      for (const tag of rest) restBody.appendChild(packRow(tag, false));
      more.appendChild(restBody);
      packs.appendChild(more);
    }

    body.appendChild(packs);

    /** One row per language: download it, or remove it once installed. */
    function packRow(tag, have, note) {
      const button = document.createElement('button');
      button.className = have ? 'btn ghost' : 'btn primary';
      button.textContent = have ? 'Remove' : 'Download';
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = have ? 'Removing\u2026' : 'Downloading\u2026';
        try {
          if (have) await translate.deleteModel(tag);
          else await translate.downloadModel(tag);
          toast(have
            ? `${translate.languageName(tag)} pack removed`
            : `${translate.languageName(tag)} ready offline`);
        } catch (error) {
          toast(error.message, 5000);
        }
        openLanguage(body);
      };
      return row(translate.languageName(tag),
        note || (have ? 'Installed \u2014 translates offline' : 'About 30MB, over Wi-Fi'),
        button);
    }
  }

  /* A report of every step, rather than a single line saying it did not work.
   * Working out which of six things is wrong from unchanged titles is not a
   * reasonable ask, and it is what "still not translating" kept meaning. */
  const diag = document.createElement('section');
  diag.className = 'block';
  diag.innerHTML = '<h2>Check it works</h2>';
  const report = document.createElement('div');
  report.className = 'facts';
  report.style.display = 'none';
  const run = document.createElement('button');
  run.className = 'btn ghost block';
  run.textContent = 'Test translation';

  run.onclick = async () => {
    run.disabled = true;
    run.textContent = 'Testing…';
    const books = await store.all('books');
    const sample = books.find((b) => b.lang) || books[0];
    const from = translate.sourceFor(sample, settings);
    const rows = [
      ['Engine', state.engine || 'none'],
      ['Set up', state.configured ? 'yes' : 'no'],
      ['Sample book', sample ? (sample.title || '').slice(0, 24) : 'none imported'],
      ['Its language', sample?.lang || 'not declared — detected from the text'],
      ['Translating to', settings.translateTarget],
    ];

    if (state.engine === 'ondevice') {
      try {
        const installed = await translate.models() || [];
        rows.push(['Packs installed', installed.length ? installed.join(', ') : 'none']);
        const want = [from, (settings.translateTarget || '').split('-')[0].toLowerCase()]
          .filter(Boolean);
        const absent = want.filter((t) => !installed.includes(t));
        if (absent.length) rows.push(['Missing', absent.map(translate.languageName).join(', ')]);
      } catch (error) {
        rows.push(['Packs installed', `could not tell: ${error.message}`]);
      }
    }

    {
      try {
        const { results } = await translate.translateBatch(
          -1, [{ field: `test:${Date.now()}`, text: 'Hello, world.' }],
          settings.translateTarget, from);
        rows.push(['Result', results.get([...results.keys()][0]) || 'empty']);
      } catch (error) {
        rows.push(['Result', error.message]);
      }
    }

    report.innerHTML = rows
      .map(([k, v]) => `<div><b>${escape(k)}</b><small>${escape(String(v))}</small></div>`)
      .join('');
    report.style.display = '';
    run.disabled = false;
    run.textContent = 'Test again';
  };

  diag.append(run, report);
  body.appendChild(diag);

  // Cache.
  const size = await translate.cacheSize();
  const cache = document.createElement('section');
  cache.className = 'block';
  cache.innerHTML = `<h2>Cache</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      ${size.entries.toLocaleString()} translations held, ${size.characters.toLocaleString()}
      characters. Nothing is ever translated twice: re-opening the index or the
      shelf costs nothing against your quota.</p>`;
  const clear = document.createElement('button');
  clear.className = 'btn ghost block';
  clear.textContent = 'Clear the translation cache';
  clear.onclick = async () => {
    await translate.clearCache();
    toast('Cache cleared');
    openLanguage(body);
  };
  cache.appendChild(clear);
  body.appendChild(cache);

  const note = document.createElement('p');
  note.className = 'muted';
  note.style.cssText = 'font-size:11px;line-height:1.6;margin-top:18px';
  note.textContent = 'Text you translate is sent to DeepL, which is the whole '
    + 'point of the feature and the one exception to the app keeping to itself. '
    + 'Book files are never uploaded — only the words being translated.';
  body.appendChild(note);
}

/* ── SCR-11 Stats & streaks ───────────────────────────────────────────── */

const DAY = 86400000;

export async function openStats() {
  const settings = await store.settings();
  const events = await store.all('events');
  const books = await store.all('books');
  const body = el('stats-body');
  body.innerHTML = '';

  // Vault books stay out of the totals until unlocked, if that is how it was
  // set up. Excluding them is the default.
  const hidden = new Set(books.filter((b) => b.inVault && settings.vaultHideFromStats && !vaultUnlocked).map((b) => b.id));
  const log = events.filter((e) => !hidden.has(e.bookId));

  const byDay = new Map();
  for (const event of log) {
    const day = byDay.get(event.day) || { pages: 0, words: 0, ms: 0 };
    day.pages += event.pages; day.words += event.words; day.ms += event.activeMs;
    byDay.set(event.day, day);
  }

  const streak = computeStreak(byDay, settings);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>${streak.current} day${streak.current === 1 ? '' : 's'}</h2>
    <p class="muted" style="font-size:12px;margin:0">
      Longest ${streak.longest} · ${streak.remaining > 0
        ? `${streak.remaining} more page${streak.remaining === 1 ? '' : 's'} keeps today alive`
        : 'today already counts'}</p>
    <p class="muted" style="font-size:11px;margin:8px 0 0">
      A day counts at ${settings.streakPages} pages or ${settings.streakMinutes} minutes.
      Two missed days a month are forgiven rather than resetting to zero.</p>`;
  body.appendChild(card);

  // Heat levels are quintiles of this reader's own distribution, not fixed
  // page counts, so the grid stays legible for light and heavy readers alike.
  const counts = [...byDay.values()].map((d) => d.pages).filter((n) => n > 0).sort((a, b) => a - b);
  const quintile = (q) => counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] : 1;
  const cuts = [quintile(0.2), quintile(0.4), quintile(0.6), quintile(0.8)];

  const heatWrap = document.createElement('section');
  heatWrap.className = 'block';
  heatWrap.innerHTML = '<h2>26 weeks</h2>';
  const heat = document.createElement('div');
  heat.className = 'heat';
  const start = Date.now() - 181 * DAY;
  for (let i = 0; i < 182; i++) {
    const key = store.dayKey(start + i * DAY);
    const pages = byDay.get(key)?.pages || 0;
    const level = pages === 0 ? 0 : pages <= cuts[0] ? 1 : pages <= cuts[1] ? 2 : pages <= cuts[2] ? 3 : 4;
    const cell = document.createElement('i');
    cell.dataset.l = String(level);
    cell.title = `${key} · ${pages} pages`;
    heat.appendChild(cell);
  }
  heatWrap.appendChild(heat);
  body.appendChild(heatWrap);

  const months = new Array(12).fill(0);
  const now = new Date();
  for (const event of log) {
    const at = new Date(event.at);
    const delta = (now.getFullYear() - at.getFullYear()) * 12 + (now.getMonth() - at.getMonth());
    if (delta >= 0 && delta < 12) months[11 - delta] += event.words;
  }
  const spark = document.createElement('section');
  spark.className = 'block';
  spark.innerHTML = '<h2>Words, twelve months</h2>';
  const bars = document.createElement('div');
  bars.className = 'spark';
  const peak = Math.max(1, ...months);
  for (const value of months) {
    const bar = document.createElement('i');
    bar.style.height = `${Math.max(2, (value / peak) * 100)}%`;
    bars.appendChild(bar);
  }
  spark.appendChild(bars);
  body.appendChild(spark);

  const visible = books.filter((b) => !hidden.has(b.id));
  const totals = document.createElement('section');
  totals.className = 'block';
  totals.innerHTML = '<h2>Totals</h2>';
  const grid = document.createElement('div');
  grid.className = 'totals';
  const hours = log.reduce((n, e) => n + e.activeMs, 0) / 3600000;
  const words = log.reduce((n, e) => n + e.words, 0);
  const languages = new Set(visible.map((b) => b.lang).filter(Boolean)).size;
  for (const [value, label, sub] of [
    [visible.length, 'Books', 'in the library'],
    [visible.filter((b) => b.finishedAt).length, 'Finished', 'read to the end'],
    [log.reduce((n, e) => n + e.pages, 0), 'Pages', 'at your current type size'],
    [words.toLocaleString(), 'Words', 'CJK normalised by script'],
    [hours.toFixed(1), 'Hours', 'foreground only, idle stripped'],
    [languages || '—', 'Languages', 'declared by the files'],
  ]) {
    const cell = document.createElement('div');
    cell.innerHTML = `<b>${value}</b><small>${label} — ${sub}</small>`;
    grid.appendChild(cell);
  }
  totals.appendChild(grid);
  body.appendChild(totals);

  // Unearned milestones show real progress, never a locked mystery.
  const milestones = document.createElement('section');
  milestones.className = 'block';
  milestones.innerHTML = '<h2>Milestones</h2>';
  const finished = visible.filter((b) => b.finishedAt).length;
  for (const [label, have, need] of [
    ['First book finished', finished, 1],
    ['Ten books finished', finished, 10],
    ['A million words', words, 1000000],
    ['Thirty-day streak', streak.longest, 30],
  ]) {
    const done = have >= need;
    const item = document.createElement('div');
    item.className = 'row';
    item.innerHTML = `
      <div class="row-text"><b>${label}</b>
        <small>${done ? 'Earned' : `${Math.min(have, need).toLocaleString()} of ${need.toLocaleString()}`}</small></div>`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.cssText = 'width:70px;flex:none';
    bar.innerHTML = `<span class="bar-fill" style="width:${Math.min(100, (have / need) * 100)}%"></span>`;
    item.appendChild(bar);
    milestones.appendChild(item);
  }
  body.appendChild(milestones);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn ghost block';
  exportBtn.textContent = 'Export the reading log as JSON';
  exportBtn.onclick = () => {
    // Everything is computed locally; the log belongs to the reader.
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'grimoire-reading-log.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  body.appendChild(exportBtn);
}

function computeStreak(byDay, settings) {
  const today = store.dayKey();
  const qualifies = (key) => {
    const day = byDay.get(key);
    if (!day) return false;
    return day.pages >= settings.streakPages || day.ms >= settings.streakMinutes * 60000;
  };

  let current = 0;
  let forgiven = 0;
  for (let i = 0; i < 400; i++) {
    const key = store.dayKey(Date.now() - i * DAY);
    if (qualifies(key)) { current += 1; continue; }
    if (key === today) continue;                 // today is not missed yet
    if (forgiven < 2) { forgiven += 1; continue; } // two freezes a month
    break;
  }

  let longest = 0, run = 0;
  const keys = [...byDay.keys()].sort();
  let previous = null;
  for (const key of keys) {
    if (!qualifies(key)) { run = 0; previous = key; continue; }
    const gap = previous ? (new Date(key) - new Date(previous)) / DAY : 1;
    run = gap <= 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }

  const todayPages = byDay.get(today)?.pages || 0;
  return { current, longest: Math.max(longest, current), remaining: Math.max(0, settings.streakPages - todayPages) };
}

/* ── SCR-12 Account & vault ───────────────────────────────────────────── */

async function hash(text) {
  const bytes = new TextEncoder().encode(`grimoire:${text}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function openVault(onVaultChange, host) {
  const body = host || el('vault-body');
  const settings = await store.settings();
  const books = await store.all('books');
  body.innerHTML = '';

  const vault = document.createElement('section');
  vault.className = 'block';
  vault.innerHTML = `<h2>Private vault</h2>
    <p class="muted" style="font-size:12px;line-height:1.5">
      Vault books are kept out of the shelf, search, the image reel and stats
      until it is unlocked. It re-locks when the app goes to the background.</p>`;

  if (!settings.vaultPassphrase) {
    const set = document.createElement('div');
    set.className = 'field';
    set.innerHTML = '<label><span>Set a passphrase</span></label>';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'At least 10 characters';
    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.innerHTML = '<i></i><i></i><i></i><i></i>';
    const verdict = document.createElement('p');
    verdict.className = 'eyebrow';
    verdict.style.marginTop = '6px';

    // A four-segment meter with a plain-words verdict, not a rules list.
    input.oninput = () => {
      const score = strength(input.value);
      [...meter.children].forEach((seg, i) => seg.classList.toggle('on', i < score.level));
      verdict.textContent = score.words;
    };

    const save = document.createElement('button');
    save.className = 'btn primary block';
    save.style.marginTop = '10px';
    save.textContent = 'Create vault';
    save.onclick = async () => {
      if (input.value.length < 10) return toast('Ten characters minimum');
      await store.saveSettings({ vaultPassphrase: await hash(input.value) });
      setVaultUnlocked(true);
      onVaultChange();
      openVault(onVaultChange, body);
    };

    set.append(input, meter, verdict, save);
    vault.appendChild(set);
  } else if (!vaultUnlocked) {
    const unlock = document.createElement('div');
    unlock.className = 'field';
    unlock.innerHTML = '<label><span>Locked</span></label>';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Passphrase';
    const button = document.createElement('button');
    button.className = 'btn primary block';
    button.style.marginTop = '10px';
    button.textContent = 'Unlock';
    button.onclick = async () => {
      if (await hash(input.value) !== settings.vaultPassphrase) return toast('That is not the passphrase');
      setVaultUnlocked(true);
      onVaultChange();
      openVault(onVaultChange, body);
      toast('Vault unlocked');
    };
    unlock.append(input, button);
    vault.appendChild(unlock);

    const bio = document.createElement('p');
    bio.className = 'muted';
    bio.style.cssText = 'font-size:11px;line-height:1.5;margin-top:10px';
    bio.textContent = 'Biometric unlock needs a BiometricPrompt bridge method. Until then the passphrase is the only key, which is also why an unlocked phone is not an unlocked vault.';
    vault.appendChild(bio);
  } else {
    vault.appendChild(row('Unlocked', 'Re-locks when the app goes to the background', (() => {
      const button = document.createElement('button');
      button.className = 'btn ghost';
      button.textContent = 'Lock now';
      button.onclick = () => { setVaultUnlocked(false); onVaultChange(); openVault(onVaultChange, body); };
      return button;
    })()));

    vault.appendChild(row('Exclude from stats', 'Vault reading never reaches the totals',
      toggle(settings.vaultHideFromStats, (on) => store.saveSettings({ vaultHideFromStats: on }))));

    const list = document.createElement('section');
    list.className = 'block';
    list.innerHTML = '<p class="eyebrow">Move books in or out</p>';
    for (const book of books) {
      list.appendChild(row(book.title, book.inVault ? 'In the vault' : 'On the shelf', toggle(book.inVault, async (on) => {
        book.inVault = on;
        await store.put('books', book);
        onVaultChange();
      })));
    }
    vault.appendChild(list);
  }
  body.appendChild(vault);

  const data = document.createElement('section');
  data.className = 'block';
  data.innerHTML = `<h2>Your data</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      Everything lives in this app on this device. There is no account and the
      app has no network permission, so nothing is uploaded and nothing can be.
      Export is here so leaving is easy, not because anything is stored
      elsewhere.</p>`;
  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn ghost block';
  exportBtn.textContent = 'Export settings as JSON';
  exportBtn.onclick = async () => {
    const blob = new Blob([JSON.stringify(await store.settings(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'grimoire-settings.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  data.appendChild(exportBtn);
  body.appendChild(data);
}

function strength(value) {
  let level = 0;
  if (value.length >= 10) level += 1;
  if (value.length >= 16) level += 1;
  if (/[^a-zA-Z0-9]/.test(value) || /\s/.test(value)) level += 1;
  if (new Set(value).size > 10) level += 1;
  const words = ['Too short to be worth setting', 'Guessable', 'Reasonable', 'Strong', 'Very strong'][level];
  return { level, words };
}


/* ── Settings ─────────────────────────────────────────────────────────────
 * One screen, six panes, an icon strip across the top. No share pane and no
 * text-to-speech pane: neither feature exists here, and a strip of buttons
 * that lead nowhere is worse than a shorter strip.
 */

const PANES = {
  text: { title: 'Text', render: renderTextPane },
  layout: { title: 'Layout', render: renderLayoutPane },
  theme: { title: 'Theme', render: openAppearanceInto },
  behaviour: { title: 'Behaviour', render: renderBehaviourPane },
  translation: { title: 'Translation', render: openLanguageInto },
  data: { title: 'Data & vault', render: renderDataPane },
};

let pane = 'text';

export async function openSettings(onVaultChange) {
  const strip = el('settings-strip');
  for (const button of strip.children) {
    button.setAttribute('aria-pressed', String(button.dataset.pane === pane));
    button.onclick = () => { pane = button.dataset.pane; openSettings(onVaultChange); };
  }
  el('settings-title').textContent = PANES[pane].title;
  const body = el('settings-body');
  body.innerHTML = '';
  await PANES[pane].render(body, onVaultChange);
}

/* Declarations, not arrow consts: PANES is built above and references these,
   so a const would still be in its temporal dead zone at that point and the
   whole module would fail to load. */
function openAppearanceInto(body) { return openAppearance(body); }
function openLanguageInto(body) { return openLanguage(body); }
function renderDataPane(body, onVaultChange) { return openVault(onVaultChange, body); }

/** App-wide reading defaults. The per-book override still wins over these. */
async function renderTextPane(body) {
  const layout = await store.layoutFor(0);
  body.innerHTML = `<p class="muted" style="font-size:12px;line-height:1.55">
    Defaults for every book. A book you have set up individually keeps its own
    settings; the Reset in a book's layout sheet brings it back to these.</p>`;

  const faces = document.createElement('div');
  faces.innerHTML = '<p class="eyebrow">Face</p>';
  const faceRow = document.createElement('div');
  faceRow.className = 'chip-row wrap';
  for (const [face, family] of [['Newsreader', 'var(--font-body)'], ['Archivo', 'var(--font-heading)']]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.cssText = `font-family:${family};text-transform:none`;
    chip.textContent = face;
    chip.setAttribute('aria-pressed', String(layout.face === face));
    chip.onclick = async () => { await store.saveLayout(0, { face }); renderSettings(); };
    faceRow.appendChild(chip);
  }
  faces.appendChild(faceRow);
  body.appendChild(faces);

  for (const [key, label, min, max, step, unit] of [
    ['size', 'Font size', 13, 30, 1, 'px'],
    ['leading', 'Line spacing', 1.1, 2.6, 0.05, ''],
    ['para', 'Paragraph spacing', 0, 44, 1, 'px'],
    ['margin', 'Side margins', 8, 64, 1, 'px'],
  ]) {
    body.appendChild(slider(label, layout[key], min, max, step, unit,
      (value) => store.saveLayout(0, { [key]: value })));
  }

  body.appendChild(row('Justified', 'Adds a first-line indent, or paragraph breaks vanish',
    toggle(layout.justified, (on) => store.saveLayout(0, { justified: on }))));
}

async function renderLayoutPane(body) {
  const settings = await store.settings();
  const layout = await store.layoutFor(0);

  body.innerHTML = '<p class="eyebrow">Reading mode</p>';
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [value, label] of [['paged', 'Paged'], ['scroll', 'Scroll']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String(layout.mode === value));
    button.onclick = async () => { await store.saveLayout(0, { mode: value }); renderSettings(); };
    seg.appendChild(button);
  }
  body.appendChild(seg);

  body.appendChild(row('Endless scroll', 'Run into the next chapter instead of stopping',
    toggle(layout.endless !== false, (on) => store.saveLayout(0, { endless: on }))));

  const shelf = document.createElement('section');
  shelf.className = 'block';
  shelf.innerHTML = '<h2>Shelf</h2>';
  const cols = document.createElement('div');
  cols.className = 'seg';
  for (const n of [2, 3, 4]) {
    const button = document.createElement('button');
    button.textContent = `${n} across`;
    button.setAttribute('aria-pressed', String(settings.columns === n));
    button.onclick = async () => { await store.saveSettings({ columns: n }); renderSettings(); };
    cols.appendChild(button);
  }
  shelf.appendChild(cols);
  body.appendChild(shelf);
}

async function renderBehaviourPane(body) {
  const settings = await store.settings();

  body.innerHTML = '<h2>Page turning</h2>';
  body.appendChild(row('Tap the sides', 'Left and right edges turn the page',
    toggle(settings.turnBySideTap, (on) => store.saveSettings({ turnBySideTap: on }))));
  body.appendChild(row('Swipe', 'Horizontal swipe turns the page. Off in scroll mode regardless.',
    toggle(settings.turnBySwipe, (on) => store.saveSettings({ turnBySwipe: on }))));

  body.appendChild(slider('Tap zone width',
    Math.round(settings.tapZone * 100), 12, 40, 1, '%',
    (value) => store.saveSettings({ tapZone: value / 100 })));

  const screen = document.createElement('section');
  screen.className = 'block';
  screen.innerHTML = '<h2>Screen</h2>';
  screen.appendChild(row('Keep the screen awake', 'While a book is open',
    toggle(settings.keepScreenOn, (on) => store.saveSettings({ keepScreenOn: on }))));
  body.appendChild(screen);

  const streaks = document.createElement('section');
  streaks.className = 'block';
  streaks.innerHTML = '<h2>Streaks</h2>';
  streaks.appendChild(slider('Pages for a day to count',
    settings.streakPages, 1, 60, 1, '', (v) => store.saveSettings({ streakPages: v })));
  streaks.appendChild(slider('Or minutes',
    settings.streakMinutes, 1, 120, 1, '', (v) => store.saveSettings({ streakMinutes: v })));
  body.appendChild(streaks);
}

/** A labelled range that writes on release and shows its value live. */
function slider(label, value, min, max, step, unit, onChange) {
  const field = document.createElement('label');
  field.className = 'field';
  field.innerHTML = `<label><span>${label}</span><span>${value}${unit}</span></label>`;
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, value });
  const readout = field.querySelector('label span:last-child');
  input.oninput = () => { readout.textContent = `${input.value}${unit}`; };
  input.onchange = () => onChange(parseFloat(input.value));
  field.appendChild(input);
  return field;
}

let renderSettings = () => {};
export function onSettingsChange(fn) { renderSettings = fn; }


/* ── Folders ──────────────────────────────────────────────────────────────
 * Every folder in use, with counts. Tapping one filters the shelf to it.
 */

export async function openFolders(onOpenFolder) {
  const books = await store.all('books');
  const visible = books.filter((b) => !b.inVault || vaultUnlocked);

  const counts = new Map();
  for (const book of visible) {
    const folder = book.folder || '';
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }

  const list = el('folders-list');
  list.innerHTML = '';
  el('folders-count').textContent =
    `${counts.size} folder${counts.size === 1 ? '' : 's'} · ${visible.length} books`;

  const entry = (label, count, folder, note) => {
    const button = document.createElement('button');
    button.className = 'list-row';
    button.innerHTML = `<span class="body"><b>${escape(label)}</b>${
      note ? `<small>${escape(note)}</small>` : ''}</span><span class="trail">${count}</span>`;
    button.onclick = () => onOpenFolder(folder);
    list.appendChild(button);
  };

  entry('All books', visible.length, null, 'Everything, unfiltered');

  // Nested paths sort together, so "Fantasy" sits above "Fantasy/Sub".
  for (const [folder, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!folder) continue;
    entry(folder, count, folder);
  }

  if (counts.has('')) entry('Unfiled', counts.get(''), '', 'Not in any folder');
}
