/* Settings-side screens: appearance, language, stats, vault.
 *
 * Nothing here is gated. Every control does what it says the moment you tap
 * it, and there is no tier above this one to buy.
 */

import * as store from './store.js';
import * as theme from './theme.js';
import * as reader from './reader.js';
import {
  setVaultUnlocked, vaultUnlocked, countWorks, workOf, onShelf, hiddenBy, hiddenFolderList,
  collapseBundles, displayTitle, naturalOrder,
} from './library.js';
import { toast } from './screens.js';
import * as translate from './translate.js';
import * as blobs from './blobs.js';
import * as frames from './frame.js';

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
  body.appendChild(themesField(settings, () => openAppearance(body)));

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
      Archivo and Newsreader come with the app. Adding your own .ttf or .otf
      fonts is not possible yet.</p>`;
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

/* ── themes ───────────────────────────────────────────────────────────
 *
 * The look, kept by name: saved from what is set now, switched between with
 * a tap, written out to send, and brought in from a file -- a theme someone
 * sent, a settings file this app exported, or simply a picture, which
 * becomes the background with an accent taken from it.
 */

/** The file kinds a theme can come in. Wide on purpose: a .json passed
 *  through a chat app or a download often arrives typed as plain text or as
 *  "some file", and a picker asked only for JSON greys those out. */
const THEME_ACCEPT = `application/json,text/plain,application/octet-stream,.json,${blobs.COVER_ACCEPT}`;

const sameLook = (a, b) => theme.THEME_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));

function themesField(settings, redraw) {
  const field = document.createElement('div');
  field.className = 'field themes-field';
  field.innerHTML = '<label><span>Themes</span><span class="muted">Saved looks, to switch between or send</span></label>';
  const saved = Array.isArray(settings.savedThemes) ? settings.savedThemes : [];

  const list = document.createElement('div');
  list.className = 'chip-row wrap theme-list';
  for (const kept of saved) {
    const item = document.createElement('span');
    item.className = 'theme-chip';
    const use = document.createElement('button');
    use.className = 'chip';
    use.setAttribute('aria-pressed', String(sameLook(kept, settings)));
    use.innerHTML = `<i class="theme-dot" style="background:${kept.accent || settings.accent}"></i>${escape(kept.name)}`;
    use.title = `Use ${kept.name}`;
    use.onclick = async () => {
      const look = {};
      for (const key of theme.THEME_KEYS) if (key in kept) look[key] = kept[key];
      const next = await store.saveSettings(look);
      theme.apply(next);
      refreshTheme();
      redraw();
    };
    const remove = document.createElement('button');
    remove.className = 'theme-remove';
    remove.setAttribute('aria-label', `Remove ${kept.name}`);
    remove.textContent = '✕';
    remove.onclick = async () => {
      await store.saveSettings({ savedThemes: saved.filter((t) => t !== kept) });
      toast(`${kept.name} removed — the look on screen stays as it is`, 4000);
      redraw();
    };
    item.append(use, remove);
    list.appendChild(item);
  }
  if (!saved.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.style.cssText = 'font-size:12px;margin:0';
    none.textContent = 'None saved yet. Set the look below, then save it here — or import one.';
    list.appendChild(none);
  }
  field.appendChild(list);

  // Naming one, in place: no dialog to block the page.
  const naming = document.createElement('div');
  naming.className = 'theme-naming';
  naming.hidden = true;
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Name this theme';
  name.maxLength = 60;
  const keep = document.createElement('button');
  keep.className = 'btn primary';
  keep.textContent = 'Save';
  keep.onclick = async () => {
    const look = theme.themeOf(settings, name.value || `Theme ${saved.length + 1}`);
    await store.saveSettings({ savedThemes: theme.withTheme(saved, look) });
    toast(`Saved as ${look.name}`, 3000);
    redraw();
  };
  name.onkeydown = (e) => { if (e.key === 'Enter') keep.onclick(); };
  naming.append(name, keep);
  field.appendChild(naming);

  const actions = document.createElement('div');
  actions.className = 'chip-row wrap theme-actions';
  const action = (label, run) => {
    const button = document.createElement('button');
    button.className = 'chip';
    button.textContent = label;
    button.onclick = run;
    actions.appendChild(button);
    return button;
  };
  action('Save this look…', () => {
    naming.hidden = false;
    name.value = '';
    name.focus();
  });
  action('Import a theme…', () => importTheme(settings, redraw));
  action('Send this look', async () => {
    const current = saved.find((t) => sameLook(t, settings));
    const look = theme.themeOf(settings, current?.name || 'My theme');
    const text = JSON.stringify(theme.themeFile(look), null, 2);
    const file = `${look.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'theme'}.quire-theme.json`;
    if (onWriteOut) {
      await onWriteOut(new Blob([text], { type: 'application/json' }), file, 'application/json', { share: true });
    } else {
      offerDownload(file, 'application/json', text);
    }
  });
  field.appendChild(actions);
  return field;
}

/** A theme from a file: put with the saved ones, and the first put to use. */
function importTheme(settings, redraw) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = THEME_ACCEPT;
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    const stem = String(file.name || 'Imported theme').replace(/(\.quire-theme)?\.[a-z0-9]+$/i, '').slice(0, 60);
    try {
      let found;
      if (/^image\//.test(file.type || '') || /\.(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i.test(file.name || '')) {
        found = [await themeFromPicture(file, stem, settings)];
      } else {
        let data;
        try {
          data = JSON.parse(await readText(file));
        } catch {
          throw new Error('That file is not a theme — a theme is a .json file, or a picture.');
        }
        found = theme.readThemes(data, stem);
      }
      let saved = Array.isArray(settings.savedThemes) ? settings.savedThemes : [];
      for (const look of found) saved = theme.withTheme(saved, look);
      const first = {};
      for (const key of theme.THEME_KEYS) if (key in found[0]) first[key] = found[0][key];
      const next = await store.saveSettings({ savedThemes: saved, ...first });
      theme.apply(next);
      refreshTheme();
      toast(found.length === 1
        ? `${found[0].name} imported and in use`
        : `${found.length} themes imported · ${found[0].name} in use`, 5000);
      redraw();
    } catch (error) {
      toast(error.message || 'That theme could not be read', 6000);
    }
  };
  picker.click();
}

/** A picture as a theme: the background, veiled, with an accent from it. */
async function themeFromPicture(file, name, settings) {
  const usable = await blobs.normaliseCover(file);
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('That picture could not be read.'));
    fr.readAsDataURL(usable);
  });
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That picture could not be read.'));
    image.src = dataUrl;
  });
  const palette = theme.extractPalette(img) || [];
  const accent = palette[0]?.[1] || settings.accent;
  return {
    name,
    themeMode: settings.themeMode,
    accent,
    heatRamp: settings.heatRamp,
    backgroundImage: dataUrl,
    veil: settings.veil ?? 0.62,
  };
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


/**
 * Offer a file to be saved.
 *
 * A WebView has no download handling of its own: no DownloadListener means an
 * <a download> click is simply ignored, which is why these buttons appeared
 * to do nothing. The native side writes the file to the app's cache and opens
 * the share sheet, where it can be saved or sent anywhere. The anchor stays
 * as the fallback for running this in an ordinary browser.
 */
/** FileReader rather than Blob.text(), which needs Chrome 76. */
function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

function offerDownload(name, mimeType, text) {
  if (window.GrimoireNative?.saveText) {
    if (window.GrimoireNative.saveText(name, mimeType, text)) return true;
    toast('That file could not be saved', 5000);
    return false;
  }

  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

/* ── OpenRouter ───────────────────────────────────────────────────────────
 *
 * One account at openrouter.ai reaches most models -- DeepSeek, Claude, GPT,
 * Gemini, Qwen, and some free ones -- and, unlike the others, it lets an app
 * be given a key by signing in: the browser opens on openrouter.ai, the
 * reader signs in there (or makes an account) and approves, and comes back
 * with the key kept on the phone (OpenRouterLink.java). The password is only
 * ever typed into openrouter.ai, and the page here never sees the key.
 */
function openRouterFields(state, pasteInstead, done) {
  const box = document.createElement('div');
  const note = (text) => {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.cssText = 'font-size:12px;line-height:1.5;margin:6px 0';
    p.textContent = text;
    return p;
  };
  const button = (label, kind = 'ghost') => {
    const b = document.createElement('button');
    b.className = `btn ${kind} block`;
    b.style.marginTop = '8px';
    b.textContent = label;
    return b;
  };
  const connected = state.llmConfigured && state.llmProvider === 'openrouter';

  if (!connected) {
    box.appendChild(note('Sign in at openrouter.ai — or make a free account there — and approve Quire. '
      + 'Your browser opens for it and you come straight back: no key to copy. '
      + 'Free models cost nothing; others use the credits on your OpenRouter account.'));
    const go = button('Sign in with OpenRouter', 'primary');
    const cancel = button('Cancel');
    cancel.hidden = true;
    const paste = button('Paste a key instead');
    let waiting = false;
    go.onclick = async () => {
      if (waiting) return;
      waiting = true;
      go.disabled = true;
      go.textContent = 'Waiting for the browser…';
      cancel.hidden = false;
      paste.hidden = true;
      try {
        await translate.connectOpenRouter();
        toast('Signed in with OpenRouter', 3000, { kind: 'done' });
        done();
      } catch (error) {
        waiting = false;
        go.disabled = false;
        go.textContent = 'Sign in with OpenRouter';
        cancel.hidden = true;
        paste.hidden = false;
        toast(/cancelled/i.test(error.message) ? 'Signing in was cancelled' : error.message, 7000);
      }
    };
    cancel.onclick = () => translate.cancelOpenRouter();
    paste.onclick = pasteInstead;
    box.append(go, cancel, paste);
    return box;
  }

  box.appendChild(note(state.llmLinked
    ? 'Signed in with OpenRouter. The key it gave is kept on this phone.'
    : `Using your OpenRouter key${state.llmHint ? ` ${state.llmHint}` : ''}.`));
  box.appendChild(modelPicker(state, done));
  const out = button(state.llmLinked ? 'Sign out' : 'Disconnect');
  out.onclick = async () => {
    await translate.clearLlm('openrouter');
    toast(state.llmLinked
      ? 'Signed out. To cancel the key itself, delete “Quire” at openrouter.ai/keys.'
      : 'Key removed. No further requests will be made.', 6000);
    done();
  };
  box.appendChild(out);
  return box;
}

/** OpenRouter's models to choose from: searchable, free ones first. */
function modelPicker(state, done) {
  const wrap = document.createElement('div');
  wrap.className = 'or-models';
  const current = document.createElement('button');
  current.className = 'btn ghost block or-current';
  current.style.marginTop = '8px';
  current.innerHTML = `<span class="muted">Model</span> <b>${escape(state.llmModel || 'openrouter/auto')}</b> <span class="muted">— change</span>`;
  wrap.appendChild(current);
  current.onclick = async () => {
    current.disabled = true;
    let models;
    try {
      models = await translate.openRouterModels();
    } catch (error) {
      current.disabled = false;
      return toast(error.message, 5000);
    }
    current.hidden = true;
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = `Search ${models.length} models`;
    search.autocapitalize = 'off';
    search.spellcheck = false;
    search.style.marginTop = '8px';
    const freeOnly = document.createElement('button');
    freeOnly.className = 'chip';
    freeOnly.textContent = 'Free only';
    freeOnly.setAttribute('aria-pressed', 'false');
    const filters = document.createElement('div');
    filters.className = 'chip-row';
    filters.style.marginTop = '8px';
    filters.appendChild(freeOnly);
    const list = document.createElement('div');
    list.className = 'or-list';
    const SHOWN = 60;
    const show = () => {
      const found = translate.sortModels(models, search.value, freeOnly.getAttribute('aria-pressed') === 'true');
      list.innerHTML = '';
      for (const model of found.slice(0, SHOWN)) {
        const row = document.createElement('button');
        row.className = 'or-row';
        row.setAttribute('aria-pressed', String(model.id === state.llmModel));
        const tags = [model.free ? '<span class="or-tag free">Free</span>' : '',
          model.vision ? '<span class="or-tag">Sees pictures</span>' : ''].join('');
        row.innerHTML = `<span class="or-name">${escape(model.name || model.id)}</span>${tags}`
          + `<span class="or-id">${escape(model.id)}</span>`;
        row.onclick = async () => {
          for (const other of list.children) other.disabled = true;
          row.classList.add('busy');
          try {
            await translate.setLlm('openrouter', '', model.id, '');
            toast(`Translating with ${model.name || model.id}`, 3000, { kind: 'done' });
            done();
          } catch (error) {
            for (const other of list.children) other.disabled = false;
            row.classList.remove('busy');
            toast(error.message, 7000);
          }
        };
        list.appendChild(row);
      }
      if (!found.length) list.appendChild(Object.assign(document.createElement('p'),
        { className: 'muted', textContent: 'No model matches.' }));
      else if (found.length > SHOWN) list.appendChild(Object.assign(document.createElement('p'),
        { className: 'muted', textContent: `And ${found.length - SHOWN} more — search to narrow them down.` }));
    };
    search.oninput = show;
    freeOnly.onclick = () => {
      freeOnly.setAttribute('aria-pressed', String(freeOnly.getAttribute('aria-pressed') !== 'true'));
      show();
    };
    wrap.append(search, filters, list);
    show();
  };
  return wrap;
}

/** A field for one key or several, one to a line, shown as dots. */
function keysBox(placeholder) {
  const box = document.createElement('textarea');
  box.className = 'keys-box';
  box.rows = 2;
  box.placeholder = placeholder;
  box.autocapitalize = 'off';
  box.autocomplete = 'off';
  box.spellcheck = false;
  return box;
}

/* ── what the AI model is told ────────────────────────────────────────────
 *
 * The instructions an AI model translates by, in the reader's own words if
 * they like: one set for each language translated from, as translators of
 * Korean, Japanese and Chinese fiction each have their own habits -- keep
 * the honorifics, leave the sound effects, romanise names this way. The
 * reply's form is not theirs to change, and is added to whatever they write.
 */
async function instructionsCard() {
  const settings = await store.settings();
  const card = document.createElement('div');
  card.className = 'card prompts-card';
  card.innerHTML = `<h2>Instructions for the model</h2>
    <p class="muted" style="font-size:12px;line-height:1.55;margin:0 0 10px">
      What the model is told before every page, for each language it translates from.
      {source} and {target} become the two languages. How it must reply is added for you.
      Each book’s glossary of names is in its details.</p>`;
  const tabs = document.createElement('div');
  tabs.className = 'chip-row wrap';
  const box = document.createElement('textarea');
  box.className = 'prompt-box';
  box.rows = 9;
  box.spellcheck = false;
  const note = document.createElement('p');
  note.className = 'muted';
  note.style.cssText = 'font-size:12px;margin:6px 0 0';
  let profile = 'ko';
  const saved = () => ({ ...(settings.translatePrompts || {}) });
  const paint = () => {
    for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.profile === profile));
    const own = String(saved()[profile] || '').trim();
    box.value = own || translate.DEFAULT_PROMPT;
    note.textContent = own && own !== translate.DEFAULT_PROMPT ? 'Your own instructions.' : 'The usual instructions.';
  };
  for (const [code, label] of translate.PROMPT_PROFILES) {
    const tab = document.createElement('button');
    tab.className = 'chip';
    tab.style.textTransform = 'none';
    tab.dataset.profile = code;
    tab.textContent = label;
    tab.onclick = () => { profile = code; paint(); };
    tabs.appendChild(tab);
  }
  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;margin-top:8px';
  const keep = document.createElement('button');
  keep.className = 'btn primary';
  keep.style.flex = '1';
  keep.textContent = 'Save';
  keep.onclick = async () => {
    const all = saved();
    const text = box.value.trim();
    if (!text || text === translate.DEFAULT_PROMPT) delete all[profile];
    else all[profile] = text;
    settings.translatePrompts = all;
    await store.saveSettings({ translatePrompts: all });
    toast('Saved. New translations follow it; ones already made stay until translated again.', 5000);
    paint();
  };
  const reset = document.createElement('button');
  reset.className = 'btn ghost';
  reset.style.flex = '1';
  reset.textContent = 'Back to the usual';
  reset.onclick = async () => {
    const all = saved();
    delete all[profile];
    settings.translatePrompts = all;
    await store.saveSettings({ translatePrompts: all });
    paint();
  };
  buttons.append(keep, reset);

  // The page itself, for a model that can see.
  const sees = row('Show the model the page',
    'When translating text in pictures, the page goes too — faces and who is speaking set the tone. A picture costs more than its words.',
    toggle(settings.aiSeesPage !== false, (on) => store.saveSettings({ aiSeesPage: on })));
  sees.style.marginTop = '12px';
  card.append(tabs, box, note, buttons, sees);
  paint();
  return card;
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

  /* Which translator. On device is free and offline; DeepL is far better
     and needs a key; LibreTranslate is a server of your choosing. The key
     is held natively and never handed back to this page: DeepL refuses
     client-side calls precisely because a key in a page is readable by
     anyone with the page. Only whether one is set, and a hint, cross the
     bridge. */
  const engineCard = document.createElement('div');
  engineCard.className = 'card';
  engineCard.innerHTML = '<h2>Translator</h2>';
  const engines = document.createElement('div');
  engines.className = 'chip-row wrap';
  for (const [code, label] of translate.ENGINES) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.textTransform = 'none';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(state.engine === code));
    chip.onclick = async () => {
      if (state.engine === code) return;
      try {
        await translate.setEngine(code);
      } catch (error) { toast(error.message, 5000); }
      openLanguage(body);
      refreshTheme();
    };
    engines.appendChild(chip);
  }
  engineCard.appendChild(engines);
  const about = translate.ENGINES.find(([code]) => code === state.engine);
  const engineNote = document.createElement('p');
  engineNote.className = 'muted';
  engineNote.style.cssText = 'font-size:12px;line-height:1.55;margin:10px 0 0';
  engineNote.textContent = about ? about[2] : '';
  engineCard.appendChild(engineNote);
  body.appendChild(engineCard);

  const keyCard = document.createElement('div');
  keyCard.className = 'card';
  keyCard.innerHTML = `<h2>DeepL</h2>
    <p class="muted" style="font-size:12px;line-height:1.55;margin:0 0 12px">
      ${state.deeplConfigured
        ? `Connected on the ${escape(state.plan === 'free' ? 'free' : 'Pro')} API plan, key ${escape(state.hint || '')}`
          + (state.deeplKeys > 1 ? ` and ${state.deeplKeys - 1} more, used in turn when one runs out.` : '.')
          + (state.engine === 'deepl' ? '' : ' Choose DeepL above to use it.')
        : `Paste a DeepL API key to use DeepL. A free API key covers 500,000
           characters a month. It is made at deepl.com → Account → API Keys &amp; Limits,
           on a DeepL API plan (a DeepL Translator account alone has none).`}
      <br><br>DeepL is only asked anything while it is the chosen translator.</p>`;

  const keyField = () => {
    const field = document.createElement('div');
    field.className = 'field';
    const input = keysBox('DeepL API key — or several, one to a line, used in turn when one runs out');
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
        // rather than on the first chapter you try to read. A key given is
        // a key to be used: DeepL becomes the translator.
        await translate.setKey(input.value.trim());
        await translate.setEngine('deepl');
        toast('Connected to DeepL', 3000, { kind: 'done' });
        openLanguage(body);
        refreshTheme();
      } catch (error) {
        save.disabled = false;
        save.textContent = 'Connect';
        toast(error.message, 6000);
      }
    };
    field.append(input, save);
    return field;
  };
  if (!state.deeplConfigured) {
    keyCard.appendChild(keyField());
  } else {
    const keys = document.createElement('div');
    keys.style.cssText = 'display:flex;gap:8px';
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
      if (state.engine === 'deepl') await translate.setEngine('ondevice').catch(() => {});
      toast('Key removed. No further requests will be made.');
      openLanguage(body);
      refreshTheme();
    };
    const change = document.createElement('button');
    change.className = 'btn ghost';
    change.style.flex = '1';
    change.textContent = 'Change keys';
    change.onclick = () => { change.disabled = true; keyCard.appendChild(keyField()); };
    keys.append(check, change, forget);
    keyCard.appendChild(keys);
  }
  body.appendChild(keyCard);

  // A language model: which service, its key, the model, and for another
  // service its address.
  if (state.engine === 'llm') {
    const card = document.createElement('div');
    card.className = 'card';
    const chosen = state.llmProvider || 'anthropic';
    const info = translate.LLM_PROVIDERS.find(([code]) => code === chosen) || translate.LLM_PROVIDERS[0];
    card.innerHTML = `<h2>AI model</h2>
      <p class="muted" style="font-size:12px;line-height:1.55;margin:0 0 10px">
        ${state.llmConfigured
          ? `Using ${escape(info[1])}, model ${escape(state.llmModel || info[2])}${state.llmHint ? `, key ${escape(state.llmHint)}` : ''}`
            + (state.llmKeys > 1 ? ` and ${state.llmKeys - 1} more, used in turn when one runs out.` : '.')
          : (chosen === 'openrouter' ? 'Sign in with OpenRouter, or choose another service and paste your API key.' : 'Choose the service, paste your API key, and connect.') + ' The key stays on this phone.'}
        Each page’s text goes to the service you choose, and is billed to your account there.</p>`;
    const providers = document.createElement('div');
    providers.className = 'chip-row wrap';
    let picked = chosen;
    const fields = document.createElement('div');
    fields.className = 'field';
    let pasting = false;
    const paint = () => {
      const [code, , model, where] = translate.LLM_PROVIDERS.find(([c]) => c === picked);
      for (const chip of providers.children) chip.setAttribute('aria-pressed', String(chip.dataset.code === code));
      fields.innerHTML = '';
      // OpenRouter: signing in rather than pasting, unless asked for.
      if (code === 'openrouter' && !(pasting && !(state.llmConfigured && state.llmProvider === code))) {
        fields.appendChild(openRouterFields(state, () => { pasting = true; paint(); }, () => {
          openLanguage(body);
          refreshTheme();
        }));
        return;
      }
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.style.cssText = 'font-size:12px;line-height:1.5;margin:6px 0';
      hint.textContent = code === 'custom' ? where : `Key from ${where}.`;
      const base = document.createElement('input');
      base.type = 'url';
      base.placeholder = 'https://api.deepseek.com/v1';
      base.value = code === 'custom' ? (state.llmBase || '') : '';
      base.autocapitalize = 'off';
      base.spellcheck = false;
      const key = keysBox(code === 'custom'
        ? 'API key, if the service needs one — several, one to a line'
        : 'API key — or several, one to a line, used in turn when one runs out');
      key.style.marginTop = '8px';
      const modelBox = document.createElement('input');
      modelBox.type = 'text';
      modelBox.placeholder = code === 'custom' ? 'Model name, e.g. deepseek-chat' : model;
      modelBox.value = code === state.llmProvider && state.llmModel ? state.llmModel : model;
      modelBox.autocapitalize = 'off';
      modelBox.spellcheck = false;
      modelBox.style.marginTop = '8px';
      const connect = document.createElement('button');
      connect.className = 'btn primary block';
      connect.style.marginTop = '10px';
      connect.textContent = 'Connect';
      connect.onclick = async () => {
        if (code !== 'custom' && !key.value.trim()
          && !(state.llmConfigured && state.llmProvider === code)) return toast('Paste your key first');
        connect.disabled = true;
        connect.textContent = 'Checking…';
        try {
          await translate.setLlm(code, key.value.trim(), modelBox.value.trim(), base.value.trim());
          toast('Connected', 3000, { kind: 'done' });
          openLanguage(body);
          refreshTheme();
        } catch (error) {
          connect.disabled = false;
          connect.textContent = 'Connect';
          toast(error.message, 7000);
        }
      };
      fields.append(hint);
      if (code === 'custom') fields.append(base);
      fields.append(key, modelBox, connect);
      if (state.llmConfigured && state.llmProvider === code) {
        const forget = document.createElement('button');
        forget.className = 'btn ghost block';
        forget.style.marginTop = '8px';
        forget.textContent = 'Disconnect';
        forget.onclick = async () => {
          await translate.clearLlm(code);
          toast('Key removed. No further requests will be made.');
          openLanguage(body);
          refreshTheme();
        };
        fields.append(forget);
      }
    };
    for (const [code, label] of translate.LLM_PROVIDERS) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.style.textTransform = 'none';
      chip.dataset.code = code;
      chip.textContent = label;
      chip.onclick = () => { picked = code; pasting = false; paint(); };
      providers.appendChild(chip);
    }
    card.append(providers, fields);
    paint();
    body.appendChild(card);
    body.appendChild(await instructionsCard());
  }

  // LibreTranslate: the server's address, and its key if it has one.
  if (state.engine === 'libre') {
    const libre = document.createElement('div');
    libre.className = 'card';
    libre.innerHTML = `<h2>LibreTranslate</h2>
      <p class="muted" style="font-size:12px;line-height:1.55;margin:0 0 12px">
        ${state.libreUrl ? `Using ${escape(state.libreUrl)}.` : 'The address of the server to use.'}</p>`;
    const address = document.createElement('input');
    address.type = 'url';
    address.placeholder = 'https://libretranslate.example';
    address.value = state.libreUrl || '';
    address.autocapitalize = 'off';
    address.spellcheck = false;
    const libreKey = document.createElement('input');
    libreKey.type = 'password';
    libreKey.placeholder = 'Key, if the server needs one';
    libreKey.autocomplete = 'off';
    libreKey.style.marginTop = '8px';
    const use = document.createElement('button');
    use.className = 'btn primary block';
    use.style.marginTop = '10px';
    use.textContent = 'Use this server';
    use.onclick = async () => {
      try {
        await translate.setLibre(address.value, libreKey.value);
        toast('Saved', 2500, { kind: 'done' });
        openLanguage(body);
      } catch (error) { toast(error.message, 5000); }
    };
    const field = document.createElement('div');
    field.className = 'field';
    field.append(address, libreKey, use);
    libre.appendChild(field);
    body.appendChild(libre);
  }

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
      if (on && !translate.status().configured) toast('Set up the translator above to use this');
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

export async function openStats({ onOpen = null } = {}) {
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
    const day = byDay.get(event.day) || { pages: 0, words: 0, ms: 0, chapters: 0 };
    day.pages += event.pages;
    day.words += event.words;
    day.ms += event.activeMs;
    day.chapters += event.chapters || 0;
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

  /* Words, not pages.
   *
   * A page is a function of type size and screen; the same chapter is thirty
   * pages at one setting and twelve at another, and a chapter copied out to
   * be read elsewhere is no pages at all. Words are what was actually read,
   * whichever way it happened.
   *
   * The levels are quintiles of this reader's own distribution rather than
   * fixed counts, so the grid stays legible for light and heavy readers
   * alike. */
  const counts = [...byDay.values()].map((d) => d.words).filter((n) => n > 0).sort((a, b) => a - b);
  const quintile = (q) => counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] : 1;
  const cuts = [quintile(0.2), quintile(0.4), quintile(0.6), quintile(0.8)];

  /* Averages that hold up when most of the reading happens somewhere else.
   *
   * Time and pages only see what happened in the app. Words and chapters see
   * what was read wherever it was read, so those are the ones worth showing
   * an average of. */
  /* Books, as the shelf has them: what is on it, outside a locked vault,
   * with a bundle of editions counted once. The bin is not the library. */
  const shelf = books.filter((b) => onShelf(b) && !hidden.has(b.id));
  const shelfCount = countWorks(shelf);
  const totalWords = log.reduce((n, e) => n + (e.words || 0), 0);
  const totalChapters = log.reduce((n, e) => n + (e.chapters || 0), 0);
  const elsewhereWords = log.filter((e) => e.elsewhere).reduce((n, e) => n + (e.words || 0), 0);
  const activeDays = [...byDay.values()].filter((d) => d.words > 0).length;
  // Reading the raw and then the translation is reading one book.
  const everyBook = new Map(books.map((b) => [b.id, b]));
  const booksTouched = new Set(log.map((e) => e.bookId).filter(Boolean)
    .map((id) => (everyBook.has(id) ? workOf(everyBook.get(id), everyBook) : `book:${id}`))).size;

  const averages = document.createElement('section');
  averages.className = 'block';
  averages.innerHTML = '<h2>Averages</h2>';
  const table = document.createElement('div');
  table.className = 'facts';

  const fact = (label, value, note) => {
    const cell = document.createElement('div');
    cell.innerHTML = `<b>${escape(label)}</b><small>${escape(value)}</small>`
      + (note ? `<small class="muted">${escape(note)}</small>` : '');
    table.appendChild(cell);
  };

  fact('Words a chapter', totalChapters
    ? Math.round(totalWords / totalChapters).toLocaleString() : '—');
  fact('Words a book', booksTouched
    ? Math.round(totalWords / booksTouched).toLocaleString() : '—');
  fact('Chapters a day', activeDays
    ? (totalChapters / activeDays).toFixed(1) : '—', 'on days you read');
  fact('Words a day', activeDays
    ? Math.round(totalWords / activeDays).toLocaleString() : '—', 'on days you read');
  fact('Read elsewhere', totalWords
    ? `${Math.round((elsewhereWords / totalWords) * 100)}%`
    : '—', 'copied out of the app');
  fact('Books touched', String(booksTouched), `of ${shelfCount} on the shelf`);

  averages.appendChild(table);
  body.appendChild(averages);

  const heatWrap = document.createElement('section');
  heatWrap.className = 'block';
  heatWrap.innerHTML = '<h2>26 weeks</h2>'
    + '<p class="muted" style="font-size:11px;margin:0 0 8px">By words read, '
    + 'including chapters copied out to read elsewhere.</p>';
  const heat = document.createElement('div');
  heat.className = 'heat';
  const start = Date.now() - 181 * DAY;
  for (let i = 0; i < 182; i++) {
    const key = store.dayKey(start + i * DAY);
    const day = byDay.get(key);
    const words = day?.words || 0;
    const level = words === 0 ? 0
      : words <= cuts[0] ? 1 : words <= cuts[1] ? 2 : words <= cuts[2] ? 3 : 4;
    const cell = document.createElement('i');
    cell.dataset.l = String(level);
    // A continuous shade within the level, so a heavy day reads as heavier
    // than a merely busy one rather than both flattening to the top step.
    const ceiling = cuts[3] || 1;
    cell.style.setProperty('--fill', String(Math.min(1, words / (ceiling * 1.5))));
    cell.title = `${key} · ${words.toLocaleString()} words`;
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

  const visible = shelf;
  // Finished once, whichever edition it was finished in.
  const finishedCount = countWorks(visible.filter((b) => b.finishedAt), visible);
  const totals = document.createElement('section');
  totals.className = 'block';
  totals.innerHTML = '<h2>Totals</h2>';
  const grid = document.createElement('div');
  grid.className = 'totals';
  const hours = log.reduce((n, e) => n + e.activeMs, 0) / 3600000;
  const words = log.reduce((n, e) => n + e.words, 0);
  const languages = new Set(visible.map((b) => b.lang).filter(Boolean)).size;
  for (const [value, label, sub] of [
    [shelfCount, 'Books', 'in the library, editions counted once'],
    [finishedCount, 'Finished', 'read to the end'],
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
  const finished = finishedCount;
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

  body.appendChild(folderLists(shelf, hiddenFolderList(settings), onOpen));

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn ghost block';
  exportBtn.textContent = 'Export the reading log as JSON';
  exportBtn.onclick = () => {
    // Everything is computed locally; the log belongs to the reader.
    offerDownload('quire-reading-log.json', 'application/json',
      JSON.stringify(log, null, 2));
  };
  body.appendChild(exportBtn);
}

/* ── what is in each folder ──────────────────────────────────────────
 *
 * Every book on the shelf by title, under the folder it is filed in --
 * drawn from the library as it is each time the page is shown, so filing,
 * renaming or deleting a book on the shelf is here the next time you look.
 * A bundle is one entry: its English edition's title first, with the
 * original beside it, since that is the pair it was bundled to keep.
 * Folders hidden from the shelf are hidden here too; the vault is left out
 * while it is locked, as everywhere else on this page.
 */

/** Whether a book is the English edition of its bundle. */
const isEnglish = (book) => /^en\b/i.test(book.lang || '')
  || (!book.lang && /^[\x20-\x7E\u2018-\u201D\u2013\u2014…]+$/.test(book.title || ''));

function entryOf(item) {
  const editions = item.bundle || [item];
  const english = editions.find(isEnglish);
  const first = english || editions[0];
  const others = editions.filter((each) => each !== first)
    .map((each) => displayTitle(each)).filter((title) => title && title !== displayTitle(first));
  return { book: item, title: displayTitle(first) || 'Untitled', also: others };
}

/* The list, as text to paste somewhere: a folder's, or all of them, each
 * folder under its name and count, its books numbered in the order shown,
 * a bundle's other titles beside its first. */
const listLine = (entry, n) => `${n}. ${entry.title}${entry.also.length ? ` (${entry.also.join(' · ')})` : ''}`;
const folderText = (name, entries) => [`${name} (${entries.length})`, ...entries.map((entry, i) => listLine(entry, i + 1))].join('\n');

async function copyPlain(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
  } catch {
    // Older WebViews: the copy command, from a box made for it and taken away.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('The phone would not take the copy');
  }
}

function copyButton(label, text, said) {
  const button = document.createElement('button');
  button.className = 'chip folder-copy';
  button.type = 'button';
  button.textContent = label;
  button.onclick = async (event) => {
    // In a folder's heading: copies, and leaves the folder open or shut as it was.
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyPlain(text());
      toast(said);
    } catch (error) {
      toast(`Could not copy — ${error.message}`);
    }
  };
  return button;
}

function folderLists(shelf, hidden, onOpen) {
  const section = document.createElement('section');
  section.className = 'block folder-lists';
  section.innerHTML = '<div class="folder-lists-head"><h2>In each folder</h2></div>';

  const listed = shelf.filter((book) => !hiddenBy(book.folder || '', hidden));
  const away = new Set(shelf.filter((book) => hiddenBy(book.folder || '', hidden))
    .map((book) => hiddenBy(book.folder || '', hidden)));

  const byFolder = new Map();
  for (const item of collapseBundles(listed)) {
    const folder = item.folder || '';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(entryOf(item));
  }
  if (!byFolder.size) {
    section.insertAdjacentHTML('beforeend', '<p class="muted" style="font-size:12px;margin:0">No books on the shelf yet.</p>');
    return section;
  }

  // Loose books first, then the folders by name, numbers in number order.
  const folders = [...byFolder.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : naturalOrder(a, b)));
  const total = [...byFolder.values()].reduce((n, list) => n + list.length, 0);
  const nameOf = (folder) => (folder ? folder.split('/').join(' / ') : 'Not in a folder');
  for (const folder of folders) byFolder.get(folder).sort((a, b) => naturalOrder(a.title, b.title));
  // The whole list: every folder shown, as it is shown.
  section.querySelector('.folder-lists-head').appendChild(copyButton('Copy list',
    () => folders.map((folder) => folderText(nameOf(folder), byFolder.get(folder))).join('\n\n'),
    `List copied · ${total} book${total === 1 ? '' : 's'} in ${folders.length} folder${folders.length === 1 ? '' : 's'}`));
  for (const folder of folders) {
    const entries = byFolder.get(folder);
    const box = document.createElement('details');
    box.className = 'folder-list';
    // Open when the whole library is short enough to read at a glance.
    box.open = total <= 60;
    // The whole path: a folder inside another reads as where it is.
    const name = nameOf(folder);
    box.innerHTML = `<summary><span>${escape(name)}</span>`
      + `<small class="muted">${entries.length}</small></summary>`;
    // Just this folder's.
    box.querySelector('summary').appendChild(copyButton('Copy', () => folderText(name, entries),
      `“${name}” copied · ${entries.length} book${entries.length === 1 ? '' : 's'}`));
    const list = document.createElement('ol');
    for (const entry of entries) {
      const row = document.createElement('li');
      const title = document.createElement(onOpen ? 'button' : 'span');
      title.className = 'folder-title';
      title.innerHTML = `<b>${escape(entry.title)}</b>`
        + (entry.also.length ? `<small>${escape(entry.also.join(' · '))}</small>` : '');
      if (onOpen) title.onclick = () => onOpen(entry.book);
      row.appendChild(title);
      list.appendChild(row);
    }
    box.appendChild(list);
    section.appendChild(box);
  }
  if (away.size) {
    section.insertAdjacentHTML('beforeend', `<p class="muted" style="font-size:11px;margin:8px 0 0">`
      + `${away.size} folder${away.size === 1 ? '' : 's'} hidden from the shelf ${away.size === 1 ? 'is' : 'are'} not listed.</p>`);
  }
  return section;
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
  /* A backup is everything except the books.
   *
   * The text and pictures are not in it on purpose -- they are gigabytes, and
   * they already exist as the files they came from. What cannot be re-created
   * is what you did afterwards, which is exactly what this holds. */
  /* Where the last import's time went.
   *
   * Reading, parsing and writing are the three things an import does, and
   * which of them dominates is a question about the phone rather than about
   * the code -- so it is answered by the phone. */
  const last = settings.lastImport;
  if (last?.books) {
    const timing = document.createElement('section');
    timing.className = 'block';
    const seconds = last.ms / 1000;
    const share = (ms) => `${Math.round((ms / last.ms) * 100)}%`;
    timing.innerHTML = `<h2>Last import</h2>
      <p class="muted" style="font-size:12px;line-height:1.55">
        ${last.books} book${last.books === 1 ? '' : 's'} in ${seconds.toFixed(0)}s
        — ${(seconds / last.books).toFixed(1)}s each.</p>`;
    const facts = document.createElement('div');
    facts.className = 'facts';
    for (const [label, ms] of [
      ['Reading the file', last.spent?.read || 0],
      ['Parsing', last.spent?.parse || 0],
      ['Writing to storage', last.spent?.write || 0],
    ]) {
      const cell = document.createElement('div');
      cell.innerHTML = `<b>${escape(label)}</b><small>${(ms / 1000).toFixed(1)}s · ${share(ms)}</small>`;
      facts.appendChild(cell);
    }
    timing.appendChild(facts);

    /* The slowest books, named.
     *
     * An average hides the thing worth knowing: four minutes might be a
     * hundred books at two seconds each or one book at three minutes, and
     * only one of those is worth doing anything about. */
    if (last.perBook?.length) {
      const list = document.createElement('div');
      list.style.marginTop = '10px';
      list.innerHTML = '<p class="eyebrow">Slowest</p>';
      for (const book of last.perBook.slice(0, 5)) {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.style.pointerEvents = 'none';
        const size = book.bytes ? `${(book.bytes / 1048576).toFixed(1)}MB · ` : '';
        row.innerHTML = `<span class="body"><b>${escape(book.name)}</b>`
          + `<small>${(book.ms / 1000).toFixed(1)}s · ${size}`
          + `${book.chapters} chapters · ${book.images} pictures</small></span>`;
        list.appendChild(row);
      }
      timing.appendChild(list);
    }

    body.appendChild(timing);
  }

  /* The last crash, kept so it can be read rather than guessed at. */
  if (settings.lastCrash) {
    const crash = document.createElement('section');
    crash.className = 'block';
    crash.innerHTML = '<h2>Last crash</h2>';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;font-size:11px;line-height:1.45;'
      + 'max-height:220px;overflow:auto;margin:0 0 8px;color:var(--muted);'
      + '-webkit-user-select:text;user-select:text';
    pre.textContent = settings.lastCrash;
    crash.appendChild(pre);

    const clear = document.createElement('button');
    clear.className = 'btn ghost block';
    clear.textContent = 'Clear this report';
    clear.onclick = async () => { await store.saveSettings({ lastCrash: null }); renderSettings(); };
    crash.appendChild(clear);
    body.appendChild(crash);
  }

  /* Two ways out, because they are different things.
   *
   * Saving puts the file in a folder that can be found again, which is what a
   * backup is for. Sending hands it to whatever app will take it, which is
   * what you want when the backup is going to another device. Only the second
   * existed, and a backup living in a chat thread is not a backup. */
  const backupRow = document.createElement('div');
  backupRow.style.cssText = 'display:flex;gap:8px';
  for (const [label, share, primary] of [
    ['Save a backup', false, true],
    ['Send a copy', true, false],
  ]) {
    const button = document.createElement('button');
    button.className = `btn ${primary ? 'primary' : 'ghost'}`;
    button.style.flex = '1';
    button.textContent = label;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const backup = await store.exportBackup();
        await onWriteOut?.(
          new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
          `quire-backup-${store.dayKey()}.json`, 'application/json', { share });
      } catch (error) {
        toast(error.message || 'That backup could not be written', 6000);
      } finally {
        button.disabled = false;
      }
    };
    backupRow.appendChild(button);
  }
  data.appendChild(backupRow);
  if (backupHooks?.available()) data.appendChild(await autoBackupBlock());

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'btn ghost block';
  restoreBtn.style.marginTop = '8px';
  restoreBtn.textContent = 'Restore from a backup';
  restoreBtn.onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    // As wide as a theme's: a .json from a chat app is often typed as text.
    picker.accept = 'application/json,text/plain,application/octet-stream,.json';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const report = await store.importBackup(JSON.parse(await readText(file)));
        // Said plainly, including what could not be matched: a backup restored
        // before the books are back is half a restore, and should say so.
        toast(report.missing
          ? `${report.books} books restored · ${report.missing} not on the shelf yet — they get their covers, blurs, places and marks back as you import them`
          : `${report.books} books, ${report.marks} marks and ${report.events} sessions restored`, 8000);
        onVaultChange?.();
        openVault(onVaultChange, body);
      } catch (error) {
        toast(error.message || 'That backup could not be read', 6000);
      }
    };
    picker.click();
  };
  data.appendChild(restoreBtn);

  const note = document.createElement('p');
  note.className = 'muted';
  note.style.cssText = 'font-size:12px;line-height:1.55;margin:10px 0 0';
  note.textContent = 'Books are matched by file name and size, so import the '
    + 'same files first and then restore: folders, statuses, editions, bookmarks, '
    + 'your place in each book and the reading log all come back.';
  data.appendChild(note);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn ghost block';
  exportBtn.style.marginTop = '14px';
  exportBtn.textContent = 'Export settings only';
  exportBtn.onclick = async () => {
    offerDownload('quire-settings.json', 'application/json',
      JSON.stringify(await store.settings(), null, 2));
  };
  data.appendChild(exportBtn);

  // And back in: only settings the app knows, each as the kind of value it
  // takes. A settings file can carry nothing that reaches outside the app.
  const importBtn = document.createElement('button');
  importBtn.className = 'btn ghost block';
  importBtn.style.marginTop = '8px';
  importBtn.textContent = 'Import settings';
  importBtn.onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json,text/plain,application/octet-stream,.json';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const count = await store.importSettings(JSON.parse(await readText(file)));
        const next = await store.settings();
        theme.apply(next);
        refreshTheme();
        toast(`${count} setting${count === 1 ? '' : 's'} imported`, 4000);
      } catch (error) {
        toast(error instanceof SyntaxError ? 'That file is not a settings file.' : (error.message || 'Those settings could not be read'), 6000);
      }
    };
    picker.click();
  };
  data.appendChild(importBtn);
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

let shownPane = null;

export async function openSettings(onVaultChange) {
  const strip = el('settings-strip');
  for (const button of strip.children) {
    button.setAttribute('aria-pressed', String(button.dataset.pane === pane));
    button.onclick = () => { pane = button.dataset.pane; openSettings(onVaultChange); };
  }
  el('settings-title').textContent = PANES[pane].title;
  const body = el('settings-body');

  /* Redrawn where it was, when it is the same pane.
   *
   * Every choice in a pane redraws the pane, and emptying it first collapsed
   * the scroll to the top: tap "Fit width" halfway down Behaviour and you were
   * thrown back to Annotations, never seeing the option change. Combined with
   * the chosen option not being drawn as chosen, those buttons looked as
   * though they did nothing. A different pane still starts at the top. */
  const same = shownPane === pane;
  const scrolled = same ? body.scrollTop : 0;
  body.innerHTML = '';
  try {
    await PANES[pane].render(body, onVaultChange);
  } finally {
    // Put back once the pane is full again, when there is height to scroll.
    body.scrollTop = scrolled;
    shownPane = pane;
  }
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
    Defaults for every book. A setting you change inside a book stays with
    that book; the Reset in its layout sheet brings it back to these. Margins
    are the same in every book, and override the book's own.</p>`;

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
    ['vmargin', 'Top and bottom margins', 0, 80, 1, 'px'],
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
    button.setAttribute('aria-pressed', String(settings.readingMode === value));
    button.onclick = async () => { await store.saveSettings({ readingMode: value }); renderSettings(); };
    seg.appendChild(button);
  }
  body.appendChild(seg);

  body.appendChild(row('Endless scroll', 'Run into the next chapter instead of stopping',
    toggle(settings.endlessScroll !== false, (on) => store.saveSettings({ endlessScroll: on }))));

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

let onWriteOut = null;

/* Automatic backups, set here and run by the app (app.js): { available, state,
 * set, chooseFolder, now }. */
let backupHooks = null;
export function onAutoBackup(hooks) { backupHooks = hooks; }

/** How often, how many kept, into which folder, and when the last was made. */
async function autoBackupBlock() {
  const box = document.createElement('div');
  box.className = 'auto-backup';
  const paint = async () => {
    const state = await backupHooks.state();
    box.replaceChildren();
    const head = document.createElement('p');
    head.className = 'eyebrow';
    head.textContent = 'Automatic backups';
    box.appendChild(head);
    const said = document.createElement('p');
    said.className = 'muted auto-backup-note';
    const when = state.lastAt ? new Date(state.lastAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    said.textContent = !state.folder
      ? 'Saved on their own into a folder you choose: on a schedule, or when the queue finishes. The newest few are kept, older ones removed; one you save by hand is never touched.'
      : `${state.every || state.afterQueue ? 'On' : 'Off'} · into “${state.folder}” · the newest ${state.keep} kept`
        + `${when ? ` · last ${when}` : ' · none yet'}${state.lastError ? ` · last try failed: ${state.lastError}` : ''}.`
        + ' Made while the app is open (Android does not let it wake itself for this).';
    box.appendChild(said);
    const chips = (label, options, current, pick) => {
      const row = document.createElement('div');
      row.className = 'chip-row wrap';
      const name = document.createElement('span');
      name.className = 'muted';
      name.textContent = label;
      row.appendChild(name);
      for (const [text, value] of options) {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.textContent = text;
        chip.setAttribute('aria-pressed', String(value === current));
        chip.onclick = async () => { await pick(value); paint(); };
        row.appendChild(chip);
      }
      box.appendChild(row);
    };
    const needFolder = async () => state.folder || (await backupHooks.chooseFolder());
    chips('Every', [['Off', null], ['Day', 'day'], ['Week', 'week']], state.every, async (every) => {
      if (every && !(await needFolder())) return;
      await backupHooks.set({ every });
    });
    chips('Also', [['When the queue finishes', true], ['No', false]], state.afterQueue, async (afterQueue) => {
      if (afterQueue && !(await needFolder())) return;
      await backupHooks.set({ afterQueue });
    });
    chips('Keep', [['3', 3], ['5', 5], ['10', 10], ['20', 20]], state.keep, (keep) => backupHooks.set({ keep }));
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:6px';
    const folder = document.createElement('button');
    folder.className = 'btn ghost';
    folder.style.flex = '1';
    folder.textContent = state.folder ? 'Change folder' : 'Choose folder';
    folder.onclick = async () => { await backupHooks.chooseFolder(); paint(); };
    const now = document.createElement('button');
    now.className = 'btn ghost';
    now.style.flex = '1';
    now.textContent = 'Back up now';
    now.disabled = !state.folder;
    now.onclick = async () => { now.disabled = true; await backupHooks.now(); };
    row.append(folder, now);
    box.appendChild(row);
  };
  backupHooks.repaint = paint;
  await paint();
  return box;
}
/** How a file leaves the app; supplied by the shell, which owns the bridge. */
export function onWrite(fn) { onWriteOut = fn; }

let onGuidesChange = null;
/** The reader re-reads the guide settings when they change. */
export function onGuides(fn) { onGuidesChange = fn; }

async function renderBehaviourPane(body) {
  const settings = await store.settings();

  const marks = document.createElement('section');
  marks.className = 'block';
  marks.innerHTML = `<h2>Annotations</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      How loud your marks are on a re-read. Style and colour are chosen as you
      make each one.</p>`;

  const density = document.createElement('div');
  density.className = 'seg';
  for (const [value, label] of [['full', 'Full'], ['markers', 'Markers'], ['hidden', 'Hidden']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String((settings.markDensity || 'full') === value));
    button.onclick = async () => { await reader.setMarkDensity(value); renderSettings(); };
    density.appendChild(button);
  }
  marks.appendChild(density);
  marks.appendChild(row('Join marks that touch',
    'Two highlights of the same style and colour with nothing between them become one.',
    toggle(settings.mergeMarks !== false, (on) => store.saveSettings({ mergeMarks: on }))));

  marks.appendChild(slider('Highlight strength',
    Math.round((settings.markOpacity ?? 0.35) * 100), 10, 90, 5, '%',
    async (value) => {
      await store.saveSettings({ markOpacity: value / 100 });
      document.documentElement.style.setProperty('--mark-opacity', String(value / 100));
    }));
  body.appendChild(marks);

  const guides = document.createElement('section');
  guides.className = 'block';
  guides.innerHTML = `<h2>Reading guides</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      For dense text, textbooks and tired eyes. Off unless you want them.</p>`;
  guides.appendChild(row('Reading ruler', 'A band that follows the line you touch',
    toggle(settings.readingRuler, async (on) => {
      await store.saveSettings({ readingRuler: on });
      onGuidesChange?.();
    })));

  const focus = document.createElement('div');
  focus.className = 'seg';
  for (const [value, label] of [['off', 'No dimming'], ['paragraph', 'Paragraph'], ['line', 'Line']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String((settings.focusMode || 'off') === value));
    button.onclick = async () => {
      await store.saveSettings({ focusMode: value });
      onGuidesChange?.();
      renderSettings();
    };
    focus.appendChild(button);
  }
  guides.appendChild(focus);
  body.appendChild(guides);

  /* Books left unread go On hold by themselves. */
  const aside = document.createElement('section');
  aside.className = 'block';
  aside.innerHTML = `<h2>Books left unread</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      A book you were reading and have not read for a while goes On hold, so
      Reading shows what you are actually reading. Never the book you read
      last. Read one again and it is back in Reading.</p>`;
  const holdDays = settings.autoHoldDays ?? 5;
  aside.appendChild(row('Put on hold when left unread', null,
    toggle(holdDays > 0, async (on) => {
      await store.saveSettings({ autoHoldDays: on ? (settings.lastAutoHoldDays || 5) : 0 });
      renderSettings();
    })));
  if (holdDays > 0) {
    aside.appendChild(slider('Days without reading', holdDays, 1, 30, 1, '', async (value) => {
      await store.saveSettings({ autoHoldDays: value, lastAutoHoldDays: value });
      renderSettings();
    }));
  }
  body.appendChild(aside);

  const ends = document.createElement('section');
  ends.className = 'block';
  ends.innerHTML = `<h2>At the end of a chapter</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      A chapter is a much bigger jump than a page, so a tap does not make one
      by accident.</p>`;
  for (const [value, label, note] of [
    ['confirm', 'Tap again to carry on', 'One tap says the chapter has ended, the next moves'],
    ['immediate', 'Carry straight on', 'A tap at the end goes to the next chapter'],
    ['buttons', 'Only the buttons', 'Taps never change chapter'],
  ]) {
    const option = document.createElement('button');
    option.className = 'list-row';
    option.innerHTML = `<span class="body"><b>${escape(label)}</b><small>${escape(note)}</small></span>`;
    option.setAttribute('aria-pressed', String((settings.chapterOnEdge || 'confirm') === value));
    option.onclick = async () => { await store.saveSettings({ chapterOnEdge: value }); renderSettings(); };
    ends.appendChild(option);
  }
  body.appendChild(ends);

  const pictures = document.createElement('section');
  pictures.className = 'block';
  pictures.innerHTML = `<h2>Pictures</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      How illustrations and comic pages are fitted. Only Fit screen leaves a
      picture both uncropped and undistorted.</p>`;
  for (const [value, label, note] of [
    ['screen', 'Fit screen', 'The whole page, nothing cropped or distorted'],
    ['width', 'Fit width', 'As wide as the screen; a tall page runs on below'],
    ['height', 'Fit height', 'As tall as the screen; a wide page runs off the side'],
    ['stretch', 'Stretch', 'Fills the space exactly, distorting to do it'],
    ['original', 'Original size', 'However large it is, scrollable'],
    ['smart', 'Smart fit', 'Width for tall strips, height for wide spreads'],
    ['fill', 'Fill', 'Fills the space exactly, cropping rather than distorting'],
  ]) {
    const option = document.createElement('button');
    option.className = 'list-row';
    option.innerHTML = `<span class="body"><b>${escape(label)}</b><small>${escape(note)}</small></span>`;
    option.setAttribute('aria-pressed', String((settings.imageFit || 'screen') === value));
    option.onclick = async () => {
      await store.saveSettings({ imageFit: value });
      document.body.dataset.images = value;
      renderSettings();
    };
    pictures.appendChild(option);
  }

  /* Where pictures go, and what shape -- drawn rather than typed. */
  const frameRow = document.createElement('div');
  frameRow.className = 'row';
  const frameNow = settings.pictureFrame || null;
  frameRow.innerHTML = `<span class="row-text"><b>Picture frame</b>
    <small>${escape(frameNow
      ? `${frames.describeKept(frameNow)} — pictures are fitted into the shape you drew`
      : 'Pictures use the whole page. Draw a frame to give them a shape and place of your own')}</small></span>
    <button class="btn ghost" id="picture-frame-edit">${frameNow ? 'Adjust…' : 'Draw…'}</button>`;
  frameRow.querySelector('#picture-frame-edit').onclick = async () => {
    // The book's own first picture, to see the frame's effect on.
    const first = reader.state.images?.values?.().next?.().value || null;
    const urls = blobs.pool();
    const sample = first ? urls.url(first) : null;
    const chosen = await frames.editFrame(frameNow, { sample, fit: settings.imageFit || 'screen' });
    urls.release();
    if (chosen === undefined) return;
    await store.saveSettings({ pictureFrame: chosen });
    reader.setPictureFrame(chosen);
    reader.repaginate();
    renderSettings();
  };
  pictures.appendChild(frameRow);
  body.appendChild(pictures);

  const grey = document.createElement('section');
  grey.className = 'block';
  grey.innerHTML = `<h2>Colour pages in grey</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      A coloured page greyed plainly reads flatter than the black and white it
      was drawn as: the contrast that separated edges was hue, not brightness.
      The later settings put that contrast back. Nothing is changed in the
      file.
      <br><br>
      E-ink is for a screen that shows about sixteen greys and has no
      backlight. It sets a black and a white point so ink reads black and
      paper reads white, pulls the midtones apart where screentones live, and
      picks the sixteen levels itself rather than letting the panel dither
      them. It has no sharpening: a halo is subtle at 256 levels and obvious
      at sixteen.</p>`;
  for (const [value, label, note] of [
    ['off', 'Off', 'Pages as they are'],
    ['plain', 'Grey', 'Luminance, nothing else'],
    ['contrast', 'Grey, lifted', 'With the local contrast raised'],
    ['crisp', 'Grey, crisp', 'Contrast and a mild sharpening of edges'],
    ['eink', 'E-ink', 'Sixteen levels, spread to use all of them'],
  ]) {
    const option = document.createElement('button');
    option.className = 'list-row';
    option.innerHTML = `<span class="body"><b>${escape(label)}</b><small>${escape(note)}</small></span>`;
    option.setAttribute('aria-pressed', String((settings.greyscale || 'off') === value));
    option.onclick = async () => {
      await store.saveSettings({ greyscale: value });
      document.body.dataset.grey = value;
      renderSettings();
    };
    grey.appendChild(option);
  }
  body.appendChild(grey);

  const pages = document.createElement('section');
  pages.className = 'block';
  pages.innerHTML = '<h2>Page breaks</h2>';
  pages.appendChild(row('Keep paragraphs whole',
    'Never split one across a page. Costs a little space at the foot of the page to buy it.',
    toggle(settings.keepParagraphs, async (on) => {
      await store.saveSettings({ keepParagraphs: on });
      document.body.dataset.keepParagraphs = String(on);
      if (reader.state.book) reader.repaginate();
    })));
  body.appendChild(pages);


  /* Appended, not assigned.
   *
   * This was `body.innerHTML = ...`, which threw away everything added above
   * it -- annotations, reading guides, what happens at the end of a chapter,
   * how pictures are fitted, page breaks. All of it was built and then wiped
   * a line later, so none of those settings has ever been visible in the app.
   */
  const turning = document.createElement('h2');
  turning.textContent = 'Page turning';
  body.appendChild(turning);

  body.appendChild(row('Tap the sides', 'Left and right edges turn the page. Paged mode only: in scroll mode a tap toggles the chrome.',
    toggle(settings.turnBySideTap, (on) => store.saveSettings({ turnBySideTap: on }))));
  body.appendChild(row('Swipe', 'Horizontal swipe turns the page. Off in scroll mode regardless.',
    toggle(settings.turnBySwipe, (on) => store.saveSettings({ turnBySwipe: on }))));

  body.appendChild(slider('Tap zone width',
    Math.round(settings.tapZone * 100), 12, 40, 1, '%',
    (value) => store.saveSettings({ tapZone: value / 100 })));

  /* ── the page pad ──
   *
   * Turning the page means reaching the edge of it, which on a tall phone in
   * one hand is the far side of the screen. So the turn can float, and go
   * where the hand actually is -- and carry on into the next chapter, so it
   * is the only control reading needs.
   */
  const pad = { on: false, x: 88, y: 64, scale: 1, vertical: true, locked: true, side: 'right' };
  const own = { ...pad, ...(settings.chapterPad || {}) };
  const savePad = (patch) => store.saveSettings({ chapterPad: { ...own, ...patch } });

  const padBlock = document.createElement('section');
  padBlock.className = 'block';
  padBlock.innerHTML = `<h2>Page buttons</h2>
    <p class="muted" style="font-size:12px;line-height:1.55">
      A floating pair that turns the page, and carries on into the next
      chapter at the end of one. It can go anywhere on the page, at whatever
      size suits your thumb. The chapter buttons and Copy chapter stay in the
      footer.</p>`;

  padBlock.appendChild(row('Float them over the page', 'Turn pages from where your thumb is',
    toggle(own.on, async (on) => { await savePad({ on }); renderSettings(); })));

  if (own.on) {
    padBlock.appendChild(row('Up is the next page', 'Stacked rather than side by side',
      toggle(own.vertical !== false, async (vertical) => {
        await savePad({ vertical });
        renderSettings();
      })));

    /* Which side, as two chips rather than a drag.
     *
     * Dragging it across is fine once you know it can be dragged; swapping
     * hands is a thing people do constantly and should cost one tap. */
    const sides = document.createElement('div');
    sides.innerHTML = '<p class="eyebrow">Side</p>';
    const sideRow = document.createElement('div');
    sideRow.className = 'chip-row';
    for (const [side, label, x] of [['left', 'Left', 12], ['right', 'Right', 88]]) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = label;
      chip.setAttribute('aria-pressed', String((own.side || 'right') === side));
      chip.onclick = async () => { await savePad({ side, x }); renderSettings(); };
      sideRow.appendChild(chip);
    }
    sides.appendChild(sideRow);
    padBlock.appendChild(sides);

    padBlock.appendChild(slider('Size', Math.round((own.scale || 1) * 100), 70, 160, 5, '%',
      (value) => savePad({ scale: value / 100 })));

    padBlock.appendChild(slider('Down the page', Math.round(own.y), 6, 94, 1, '%',
      (value) => savePad({ y: value })));

    /* Locked by default, and that is what makes it usable.
     *
     * An unlocked control sitting over the page moves every time you meant to
     * press it. Unlock, put it where you want it, lock it again. */
    padBlock.appendChild(row(own.locked === false ? 'Unlocked — drag the grip' : 'Locked in place',
      own.locked === false
        ? 'Drag the dotted grip between the arrows'
        : 'It cannot be moved by accident while reading',
      toggle(own.locked !== false, async (locked) => { await savePad({ locked }); renderSettings(); })));

    const reset = document.createElement('button');
    reset.className = 'btn ghost';
    reset.textContent = 'Put it back where it started';
    reset.onclick = async () => {
      await store.saveSettings({ chapterPad: { ...pad, on: true } });
      renderSettings();
    };
    padBlock.appendChild(reset);
  }
  body.appendChild(padBlock);

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

let onFolderActions = null;
/** What the shell offers for a whole folder; it owns deleting. */
export function onFolderMenu(fn) { onFolderActions = fn; }

const OFF_SHELF_ICON = '<svg class="off-shelf-icon" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M3 3l18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.4.8-1.3 2-2.5 3.2M6.3 7.8C4.6 9 3.3 10.7 2.5 12c1 1.8 4.5 6 9.5 6 1.4 0 2.7-.3 3.8-.8"/>'
  + '<path d="M9.9 10a3 3 0 0 0 4.1 4.1"/></svg>';

export async function openFolders(onOpenFolder) {
  const books = await store.all('books');
  // Deleted books are in the bin, not in their folders.
  const visible = books.filter((b) => onShelf(b) && (!b.inVault || vaultUnlocked));

  // Books per folder, a bundle of editions counted once (see countWorks).
  const inFolder = new Map();
  for (const book of visible) {
    const folder = book.folder || '';
    if (!inFolder.has(folder)) inFolder.set(folder, []);
    inFolder.get(folder).push(book);
  }
  const counts = new Map([...inFolder].map(([folder, list]) => [folder, countWorks(list, visible)]));
  const total = countWorks(visible);
  // "All books" opens the main shelf, which leaves hidden folders out; its
  // count is what you will find there.
  const hidden = hiddenFolderList(await store.settings());
  const onMainShelf = visible.filter((b) => !hiddenBy(b.folder || '', hidden));
  const shelfTotal = countWorks(onMainShelf, visible);

  const list = el('folders-list');
  list.innerHTML = '';
  el('folders-count').textContent =
    `${counts.size} folder${counts.size === 1 ? '' : 's'} · ${total} book${total === 1 ? '' : 's'}`;

  const entry = (label, count, folder, note) => {
    const row = document.createElement('div');
    row.className = 'folder-row';

    const button = document.createElement('button');
    button.className = 'list-row';
    const by = folder ? hiddenBy(folder, hidden) : null;
    if (by) {
      row.classList.add('off-shelf');
      note = by === folder ? 'Hidden from the shelf' : `Hidden with “${by}”`;
    }
    button.innerHTML = `<span class="body"><b>${escape(label)}</b>${
      note ? `<small>${by ? OFF_SHELF_ICON : ''}${escape(note)}</small>` : ''}</span><span class="trail">${count}</span>`;
    button.onclick = () => onOpenFolder(folder);
    row.appendChild(button);

    /* Emptying a folder is a folder's business, not a selection's.
     *
     * It could always be done by filtering the shelf and selecting
     * everything, which is three steps and a chance to have the filter not be
     * what you thought. A folder knows what is in it. */
    if (folder !== null) {
      const more = document.createElement('button');
      more.className = 'icon-btn folder-more';
      more.title = `What to do with ${label}`;
      more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/>'
        + '<circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
      more.onclick = (event) => {
        event.stopPropagation();
        onFolderActions?.(folder, label, count);
      };
      row.appendChild(more);
    }

    list.appendChild(row);
  };

  entry('All books', shelfTotal, null,
    shelfTotal === total ? 'Everything, unfiltered' : 'The shelf: everything but hidden folders');

  // Nested paths sort together, so "Fantasy" sits above "Fantasy/Sub".
  for (const [folder, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!folder) continue;
    entry(folder, count, folder);
  }

  if (counts.has('')) entry('Unfiled', counts.get(''), '', 'Not in any folder');
}
