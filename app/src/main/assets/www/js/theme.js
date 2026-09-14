/* Theme.
 *
 * One chosen accent produces the whole 100–900 ramp, so every tinted surface
 * moves in step. The ladder and the saturation damping on the light steps are
 * taken from the design prototype, not invented here.
 */

const LIGHTNESS = [96, 92, 86, 76, 66, 54, 42, 26];
const STEP_NAMES = [100, 200, 300, 400, 500, 600, 700, 900];

export const GROUNDS = {
  dark: { bg: '#1b1a20', surface: '#232128', text: '#efeef3' },
  light: { bg: '#f6f5f8', surface: '#fffdff', text: '#2a2733' },
};

export const ACCENT_PRESETS = [
  ['Wisteria', '#b4b0d6'],
  ['Sea fog', '#a9c3bd'],
  ['Ember', '#e9b8a8'],
  ['Rose quartz', '#d6a2ae'],
  ['Wheat', '#e2c68a'],
  ['Slate', '#cfd3e6'],
];

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  if (s === 0) { const v = l * 255; return rgbToHex(v, v, v); }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hk = h / 360;
  return rgbToHex(ch(hk + 1 / 3) * 255, ch(hk) * 255, ch(hk - 1 / 3) * 255);
}

/** All eight steps, from one colour. */
export function ramp(baseHex) {
  const [h, s] = rgbToHsl(...hexToRgb(baseHex));
  return LIGHTNESS.map((l, i) => hslToHex(h, Math.min(s * (i < 3 ? 0.7 : 1), 0.6), l / 100));
}

function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = relLuminance(a), lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The contrast guard. Any accent/ground pair below 4.5:1 for body text is
 * refused; we return the nearest passing step of the same hue instead of
 * silently applying something unreadable.
 */
export function guard(baseHex, groundHex, min = 4.5) {
  const steps = ramp(baseHex);
  if (contrast(baseHex, groundHex) >= min) return { ok: true, ink: baseHex, steps };
  const passing = steps
    .map((hex) => ({ hex, ratio: contrast(hex, groundHex) }))
    .filter((s) => s.ratio >= min)
    .sort((a, b) => Math.abs(relLuminance(a.hex) - relLuminance(baseHex))
                  - Math.abs(relLuminance(b.hex) - relLuminance(baseHex)));
  return { ok: false, ink: passing.length ? passing[0].hex : (relLuminance(groundHex) > 0.5 ? '#000' : '#fff'), steps };
}

export const HEAT_RAMPS = {
  ink: ['#f2eff8', '#c9c4da', '#8e88a8', '#524e66', '#2b2934'],
};

/** Every accent produces a matching heat ramp, so the grid never clashes. */
export function heatRamp(name, accent, dark) {
  if (name !== 'accent' && HEAT_RAMPS[name]) {
    return dark ? HEAT_RAMPS[name].slice().reverse() : HEAT_RAMPS[name];
  }
  const s = ramp(accent);
  return dark ? [s[7], s[6], s[5], s[4], s[3]] : [s[0], s[1], s[3], s[5], s[6]];
}

/** Push the whole computed theme onto :root as custom properties. */
export function apply(settings) {
  const mode = settings.themeMode === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.themeMode;
  const dark = mode === 'dark';
  const ground = GROUNDS[mode];
  const steps = ramp(settings.accent);
  const root = document.documentElement.style;

  document.documentElement.dataset.mode = mode;
  root.setProperty('--bg', ground.bg);
  root.setProperty('--surface', ground.surface);
  root.setProperty('--text', ground.text);
  root.setProperty('--read-ink', ground.text);

  STEP_NAMES.forEach((name, i) => root.setProperty(`--accent-${name}`, steps[i]));

  // The base accent is the mid step in dark and a deeper one in light, so the
  // same token reads with the same weight on either ground.
  const base = dark ? steps[3] : steps[5];
  root.setProperty('--accent', base);
  root.setProperty('--on-accent', contrast(base, '#ffffff') >= 3 ? '#ffffff' : steps[7]);

  // Body-size text in the accent needs a deeper step than chrome does.
  root.setProperty('--accent-ink', guard(base, ground.bg).ink);

  /* Translated text is marked with colour drawn from the accent, so it is
     always obviously the machine's words rather than the author's -- and so
     it follows whatever theme is set rather than introducing one of its own.

     The two ends are chosen from the ramp by measuring, not by picking step
     numbers: which steps are legible depends entirely on the ground. On a
     dark page the pale end of a ramp reads and the deep end does not; on a
     light page it is the other way round. Picking by index gave 1.4:1 on the
     light ground, which is not a tint but an invisibility. */
  const legible = steps.filter((step) => contrast(step, ground.bg) >= 4.5);
  const fallbackInk = guard(base, ground.bg).ink;

  /* Legible is not the same as distinguishable. The most readable step on a
     dark ground is very nearly the ordinary text colour, so translated prose
     came out looking exactly like the author's -- which is the one thing this
     is for. Steps too close to the page's own text are dropped. */
  const marked = legible.filter((step) => contrast(step, ground.text) >= 1.35);
  const usable = marked.length ? marked : legible;

  const from = usable[0] || fallbackInk;
  const to = usable[usable.length - 1] || fallbackInk;
  root.setProperty('--translated-from', from);
  root.setProperty('--translated-to', to);

  // Body text gets one colour, not a gradient: a gradient running down a
  // whole chapter is unreadable at the pale end and looks like a fault. The
  // most legible step available, since this is a page of prose.
  const strongest = usable.slice().sort(
    (a, b) => contrast(b, ground.bg) - contrast(a, ground.bg))[0];
  root.setProperty('--translated-ink', strongest || fallbackInk);

  const heat = heatRamp(settings.heatRamp, settings.accent, dark);
  heat.forEach((c, i) => root.setProperty(`--heat-${i}`, c));

  root.setProperty('--tap-zone', `${Math.round(settings.tapZone * 100)}%`);

  if (settings.backgroundImage) {
    root.setProperty('--bg-image', `url("${settings.backgroundImage}")`);
    root.setProperty('--bg-image-opacity', String(1 - settings.veil));
  } else {
    root.setProperty('--bg-image', 'none');
    root.setProperty('--bg-image-opacity', '0');
  }

  /* Everything the stylesheet reads off the body.
   *
   * These were being set from the reader and the settings panes but never
   * from here, so they were only right once something had touched them --
   * a fresh launch had no picture fitting, no mark opacity and no page-break
   * preference until a pane was opened.
   */
  root.setProperty('--mark-opacity', String(settings.markOpacity ?? 0.35));
  document.body.dataset.marks = settings.markDensity || 'full';
  document.body.dataset.images = settings.imageFit || 'screen';
  document.body.dataset.focus = settings.focusMode || 'off';
  document.body.dataset.keepParagraphs = String(!!settings.keepParagraphs);

  return mode;
}

/**
 * Palette extraction for a background image: bucket the pixels of a
 * downsampled bitmap and offer dominant, muted, vibrant and light-muted.
 * Recomputed on every import — a new image means a new palette.
 */
export function extractPalette(img) {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 0.08 || l > 0.95) continue;
    const key = `${Math.round(h / 20)}:${Math.round(s * 4)}:${Math.round(l * 4)}`;
    const b = buckets.get(key) || { h: 0, s: 0, l: 0, n: 0 };
    b.h += h; b.s += s; b.l += l; b.n += 1;
    buckets.set(key, b);
  }

  const list = [...buckets.values()]
    .map((b) => ({ h: b.h / b.n, s: b.s / b.n, l: b.l / b.n, n: b.n }))
    .sort((a, b) => b.n - a.n);
  if (!list.length) return [];

  const pick = (fn, fallback) => (list.find(fn) || fallback || list[0]);
  const dominant = list[0];
  const vibrant = pick((c) => c.s > 0.4 && c.l > 0.3 && c.l < 0.7);
  const muted = pick((c) => c.s < 0.3);
  const lightMuted = pick((c) => c.s < 0.35 && c.l > 0.6);

  return [
    ['Dominant', hslToHex(dominant.h, Math.min(dominant.s, 0.5), 0.72)],
    ['Vibrant', hslToHex(vibrant.h, Math.min(vibrant.s, 0.5), 0.72)],
    ['Muted', hslToHex(muted.h, Math.min(muted.s, 0.32), 0.74)],
    ['Light muted', hslToHex(lightMuted.h, Math.min(lightMuted.s, 0.28), 0.8)],
  ];
}
