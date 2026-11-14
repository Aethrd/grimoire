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

/* ── the theme's gradient ──────────────────────────────────────────────
 *
 * Two to five colours, each with a share: how much of the length it holds
 * before it blends into the next. Equal shares of two are the plain blend,
 * end to end; a larger share holds its colour solid for longer. One direction
 * for all of it -- Auto keeps each place its own (bars across, the download
 * mark down, pause and resume corner to corner).
 */
export const GRADIENT_MAX = 5;
/* Its direction: an angle, turned by degrees as CSS reads one (0 points up,
 * 90 right, 180 down), or Auto -- each place its own: bars across, the
 * download mark down, pause and resume corner to corner. The arrows an older
 * build kept are read as their angles. */
const OLD_DIRS = { right: 90, left: 270, down: 180, up: 0, 'down-right': 135, 'up-right': 45 };
/** The angle set, 0 to 359, or null for Auto. */
export function gradientAngle(value) {
  if (typeof value === 'string' && value in OLD_DIRS) return OLD_DIRS[value];
  if (value === null || value === undefined || value === 'auto' || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
}
const STOP_HEX = /^#[0-9a-f]{6}$/i;
const shareOf = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 50;
};

/** A gradient checked: { from, to, stops: [{ color, share }] }, or null. Takes
 *  the older two-colour { from, to } as two equal shares. */
export function gradientOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let stops = null;
  if (Array.isArray(raw.stops)) {
    const kept = raw.stops
      .filter((stop) => stop && STOP_HEX.test(String(stop.color || '').trim()))
      .slice(0, GRADIENT_MAX)
      .map((stop) => ({ color: String(stop.color).trim().toLowerCase(), share: shareOf(stop.share) }));
    if (kept.length >= 2) stops = kept;
  }
  if (!stops && STOP_HEX.test(String(raw.from || '').trim()) && STOP_HEX.test(String(raw.to || '').trim())) {
    stops = [{ color: raw.from.trim().toLowerCase(), share: 50 }, { color: raw.to.trim().toLowerCase(), share: 50 }];
  }
  return stops ? { from: stops[0].color, to: stops[stops.length - 1].color, stops } : null;
}

/** Where each colour stands along the length, 0 to 1: solid through its share,
 *  blending into the next across a band as wide as the narrower side allows. */
export function placeStops(stops) {
  const total = stops.reduce((sum, stop) => sum + stop.share, 0) || 1;
  const seg = stops.map((stop) => stop.share / total);
  const last = stops.length - 1;
  const out = [{ color: stops[0].color, at: 0 }];
  let edge = 0;
  for (let i = 0; i < last; i += 1) {
    edge += seg[i];
    const half = Math.min(seg[i] * (i === 0 ? 1 : 0.5), seg[i + 1] * (i + 1 === last ? 1 : 0.5));
    out.push({ color: stops[i].color, at: edge - half }, { color: stops[i + 1].color, at: edge + half });
  }
  out.push({ color: stops[last].color, at: 1 });
  return out;
}

/** The colour at t (0 to 1) along placed stops. */
export function colourAt(placed, t) {
  if (t <= placed[0].at) return placed[0].color;
  for (let i = 1; i < placed.length; i += 1) {
    const a = placed[i - 1], b = placed[i];
    if (t <= b.at) {
      const k = b.at - a.at > 1e-6 ? (t - a.at) / (b.at - a.at) : 1;
      const p = hexToRgb(a.color), q = hexToRgb(b.color);
      return rgbToHex(p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k);
    }
  }
  return placed[placed.length - 1].color;
}

/** As a CSS background, at the angle given (degrees; Auto is across, 90). */
export function gradientCss(placed, angle = null) {
  return `linear-gradient(${angle ?? 90}deg, ${placed.map((p) => `${p.color} ${(p.at * 100).toFixed(1)}%`).join(', ')})`;
}

/* Drawn marks (the download mark, pause and resume) take the gradient as
 * samples along it -- each a custom property, so a change of colour reaches
 * every one already drawn -- and their direction from the setting, set again
 * on each when it changes (apply, below). */
export const GRADIENT_SAMPLES = 17;
const SVG_PLACES = {
  // The download mark, in its own 24-unit box: by default, down.
  mark: { units: 'userSpaceOnUse', box: [4.4, 3.6, 19.6, 19.5], auto: 180 },
  // Pause and resume, across their own box: by default, corner to corner.
  icon: { units: 'objectBoundingBox', box: [0, 0, 1, 1], auto: 135 },
};
let gradientTurn = null;
/* Its line through a box at the angle, as CSS draws one: through the middle,
 * long enough that the box's far corners take the two ends. */
function gradientLine(place) {
  const spot = SVG_PLACES[place] || SVG_PLACES.icon;
  const angle = (gradientTurn ?? spot.auto) * Math.PI / 180;
  const [x0, y0, x1, y1] = spot.box;
  const w = x1 - x0, h = y1 - y0, cx = x0 + w / 2, cy = y0 + h / 2;
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const r = (v) => Number(v.toFixed(2));
  return { x1: r(cx - dx * half), y1: r(cy - dy * half), x2: r(cx + dx * half), y2: r(cy + dy * half) };
}
/** The <linearGradient> for a drawn mark: `place` is 'mark' or 'icon'. */
export function gradientSvg(id, place) {
  const spot = SVG_PLACES[place] || SVG_PLACES.icon;
  const line = gradientLine(place);
  let stops = '';
  for (let k = 0; k < GRADIENT_SAMPLES; k += 1) {
    const end = k < GRADIENT_SAMPLES / 2 ? '--grad-from' : '--grad-to';
    stops += `<stop offset="${(k / (GRADIENT_SAMPLES - 1)).toFixed(4)}" style="stop-color:var(--grad-s${k}, var(${end}))"/>`;
  }
  return `<linearGradient id="${id}" data-grad="${place}" gradientUnits="${spot.units}" x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}">${stops}</linearGradient>`;
}

/* ── roles: the gradient as the app's colours ─────────────────────────────
 *
 * The gradient's colours, ranked by their share (the larger first; level
 * shares in the order they stand): primary, secondary, tertiary, and a fourth
 * and fifth. With colours of your own the primary leads the whole app -- it is
 * the accent everything else is drawn from -- and each of the rest is given a
 * part to colour:
 *   primary    main buttons, sliders, switches, what is selected, the tab you are on
 *   secondary  pause and resume, outlined buttons, an icon that is on
 *   tertiary   the edges of cards and chips
 *   fourth     small headings over a screen's title
 *   fifth      the lines between rows
 * Fewer than five colours: the roles go round them again. Following the
 * accent, they are steps of its ramp. Drawn solid in them, or in the
 * gradient itself (colourStyle).
 */
export const ROLE_NAMES = ['Primary', 'Secondary', 'Tertiary', 'Fourth', 'Fifth'];
export const ROLE_PARTS = [
  'Main buttons, sliders, switches, what is selected, the tab you are on',
  'Pause and resume, outlined buttons, an icon that is on',
  'Edges of cards and chips',
  'Small headings over a title',
  'Lines between rows',
];
export const COLOUR_STYLES = { solid: 'Solid colours', gradient: 'The gradient' };
/** The colours by rank: the larger share first, level ones in their order. */
export function rolesOf(stops) {
  const ranked = stops.map((stop, i) => ({ ...stop, i })).sort((a, b) => b.share - a.share || a.i - b.i).map((stop) => stop.color);
  return ROLE_NAMES.map((_, i) => ranked[i % ranked.length]);
}

/** Push the whole computed theme onto :root as custom properties. */
export function apply(settings) {
  const mode = settings.themeMode === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.themeMode;
  const dark = mode === 'dark';
  const ground = GROUNDS[mode];
  // Colours of your own: the one with the largest share is the accent (see roles, above).
  const gradient = gradientOf(settings.gradient);
  const accent = gradient ? rolesOf(gradient.stops)[0] : settings.accent;
  const steps = ramp(accent);
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

  /* The theme's gradient -- the download mark, pause and resume: from a
   * light step of the accent to a deep one, or two colours of your own. */
  const stops = gradient ? gradient.stops
    : [{ color: steps[STEP_NAMES.indexOf(300)], share: 50 }, { color: steps[STEP_NAMES.indexOf(600)], share: 50 }];
  const placed = placeStops(stops);
  root.setProperty('--grad-from', stops[0].color);
  root.setProperty('--grad-to', stops[stops.length - 1].color);
  for (let k = 0; k < GRADIENT_SAMPLES; k += 1) root.setProperty(`--grad-s${k}`, colourAt(placed, k / (GRADIENT_SAMPLES - 1)));
  gradientTurn = gradientAngle(settings.gradientDir);
  root.setProperty('--grad-bar', gradientCss(placed, gradientTurn));
  if (gradient) document.documentElement.dataset.gradient = 'own';
  else delete document.documentElement.dataset.gradient;
  // What on it reads best, the whole length across: light or dark.
  const onGrad = ['#ffffff', '#1b1a20'].map((ink) => ({ ink, worst: Math.min(...placed.map((p) => contrast(p.color, ink))) }))
    .sort((a, b) => b.worst - a.worst)[0].ink;
  root.setProperty('--on-grad', onGrad);
  /* Thin things -- a progress bar, a slider's track -- run along their length
   * whatever the angle: left to right, or right to left where it points left. */
  const leftward = gradientTurn !== null && Math.sin(gradientTurn * Math.PI / 180) < -1e-6;
  root.setProperty('--grad-across', gradientCss(placed, leftward ? 270 : 90));
  // The roles, each with an ink for words and marks on the page's ground.
  const roles = gradient ? rolesOf(gradient.stops) : [base, steps[2], steps[5], steps[1], steps[6]];
  roles.forEach((colour, i) => {
    root.setProperty(`--role-${i + 1}`, i === 0 ? base : colour);
    root.setProperty(`--role-${i + 1}-ink`, guard(i === 0 ? base : colour, ground.bg, 3).ink);
  });
  /* The kinds of notice (screens.js), one colour each from these, in order of
   * how much they matter. Fewer colours than kinds -- a gradient of two --
   * and the rest are those turned round the wheel, so no two kinds look
   * alike and a problem never looks like a download. */
  // One colour of your own (no gradient): its shades are too alike to tell apart at a glance, so it alone is the start.
  // The first is the accent itself, standing for the first colour; the others only where they are other colours.
  const distinct = [base.toLowerCase()];
  if (gradient) {
    for (const colour of roles.slice(1)) {
      const c = colour.toLowerCase();
      if (c !== roles[0].toLowerCase() && !distinct.includes(c)) distinct.push(c);
    }
  }
  const hueOf = (hex) => rgbToHsl(...hexToRgb(hex))[0];
  const apart = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const chosen = [];
  for (let i = 0; i < 5; i += 1) {
    let colour = distinct[i];
    if (!colour) {
      // The turn of one of them that stands furthest from every colour already given.
      let best = null; let far = -1;
      for (const from of distinct) {
        const [h, sat, l] = rgbToHsl(...hexToRgb(from));
        for (const turn of [-150, -110, -70, -40, 40, 70, 110, 150, 180]) {
          const hue = (h + turn + 360) % 360;
          const near = Math.min(...chosen.map((c) => apart(hueOf(c), hue)));
          if (near > far) { far = near; best = hslToHex(hue, Math.max(sat, 0.35), l); }
        }
      }
      colour = best;
    }
    chosen.push(colour);
    root.setProperty(`--notice-${i + 1}`, colour);
    root.setProperty(`--notice-${i + 1}-ink`, guard(colour, ground.bg, 3).ink);
  }
  document.documentElement.dataset.colourStyle = COLOUR_STYLES[settings.colourStyle] ? settings.colourStyle : 'solid';
  // The marks already drawn turn with it.
  for (const g of document.querySelectorAll('linearGradient[data-grad]')) {
    const line = gradientLine(g.dataset.grad);
    for (const key of ['x1', 'y1', 'x2', 'y2']) g.setAttribute(key, String(line[key]));
  }

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

  const heat = heatRamp(settings.heatRamp, accent, dark);
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
  document.body.dataset.grey = settings.greyscale || 'off';
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


/**
 * Point the grey filters at a particular conversion.
 *
 * Both chains start with the same matrix, so choosing once sets how every
 * grey mode converts -- including the e-ink preset, whose levels and banding
 * then work on a plane that kept the detail rather than one that lost it.
 */
export function useGreyMix(name) {
  const mix = GREY_MIXES[name] || GREY_MIXES.luminance;
  const values = matrixFor(mix);
  for (const id of ['greymix-matrix', 'eink-matrix']) {
    document.getElementById(id)?.setAttribute('values', values);
  }
  document.body.dataset.greyMix = name || 'luminance';
}

const GREY_MIXES = {
  luminance: [0.2126, 0.7152, 0.0722],
  red: [0.72, 0.21, 0.07],
  green: [0.15, 0.75, 0.10],
  blue: [0.10, 0.25, 0.65],
  'red-green': [0.62, -0.10, 0.48],
};

const matrixFor = ([r, g, b]) => [
  r, g, b, 0, 0,
  r, g, b, 0, 0,
  r, g, b, 0, 0,
  0, 0, 0, 1, 0,
].map((n) => Number(n.toFixed(4))).join(' ');

/* ── themes, saved and shared ─────────────────────────────────────────────
 *
 * A theme is the look as a whole: light or dark, the accent, the reading-log
 * colours, the background picture and how far it is veiled. Kept by name to
 * switch between, and written out as a small file to send to someone -- or
 * to bring back after a reinstall. The picture travels inside the file.
 */

export const THEME_KEYS = ['themeMode', 'accent', 'heatRamp', 'backgroundImage', 'veil', 'gradient', 'gradientDir', 'colourStyle'];
/** What a theme file says it is, so that one can be told from any other JSON. */
export const THEME_FORMAT = 'quire-theme';

/** The look as it is now, as a theme called `name`. */
export function themeOf(settings, name) {
  const theme = { name: String(name || 'My theme').trim().slice(0, 60) || 'My theme' };
  for (const key of THEME_KEYS) theme[key] = settings[key] ?? null;
  return theme;
}

/** A file's worth of themes: one, or several. */
export function themeFile(themes) {
  return { format: THEME_FORMAT, version: 1, themes: [].concat(themes) };
}

const HEX = /^#[0-9a-f]{6}$/i;
/* Only a picture carried in the file itself: a theme must never make the
 * app reach out to the network for its background. */
const PICTURE = /^data:image\/(png|jpe?g|webp|gif|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * The themes in a file, checked: a theme file, a list of themes, one theme on
 * its own, or a whole settings file exported from the app (its look is
 * taken, nothing else). Anything that is not a valid value is left at what it
 * is now rather than taken on trust.
 *
 * @returns [{ name, themeMode?, accent?, heatRamp?, backgroundImage?, veil? }]
 * @throws when there is no theme in it at all
 */
export function readThemes(data, fallbackName = 'Imported theme') {
  let list;
  if (data && Array.isArray(data.themes)) list = data.themes;
  else if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') list = [data];
  else list = [];
  const out = [];
  list.forEach((raw, at) => {
    if (!raw || typeof raw !== 'object') return;
    const theme = {};
    if (['light', 'dark', 'system'].includes(raw.themeMode)) theme.themeMode = raw.themeMode;
    if (typeof raw.accent === 'string' && HEX.test(raw.accent.trim())) theme.accent = raw.accent.trim().toLowerCase();
    if (raw.heatRamp === 'accent' || (typeof raw.heatRamp === 'string' && HEAT_RAMPS[raw.heatRamp])) theme.heatRamp = raw.heatRamp;
    if (raw.backgroundImage === null) theme.backgroundImage = null;
    else if (typeof raw.backgroundImage === 'string' && PICTURE.test(raw.backgroundImage)) {
      theme.backgroundImage = raw.backgroundImage.replace(/\s+/g, '');
    }
    // The gradient: two to five colours with their shares, or following the accent; and its direction.
    if (raw.gradient === null) theme.gradient = null;
    else if (gradientOf(raw.gradient)) theme.gradient = gradientOf(raw.gradient);
    if (raw.gradientDir === null || raw.gradientDir === 'auto') theme.gradientDir = raw.gradientDir;
    else if (gradientAngle(raw.gradientDir) !== null) theme.gradientDir = gradientAngle(raw.gradientDir);
    if (raw.colourStyle === null || (typeof raw.colourStyle === 'string' && COLOUR_STYLES[raw.colourStyle])) theme.colourStyle = raw.colourStyle;
    const veil = Number(raw.veil);
    if (raw.veil != null && Number.isFinite(veil)) theme.veil = Math.max(0, Math.min(0.95, veil));
    if (!THEME_KEYS.some((key) => key in theme)) return;
    const name = typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, 60)
      : list.length > 1 ? `${fallbackName} ${at + 1}` : fallbackName;
    out.push({ name, ...theme });
  });
  if (!out.length) throw new Error('There is no theme in that file.');
  return out;
}

/** The saved themes, with this one added -- or put in place of one of the same name. */
export function withTheme(saved, theme) {
  const list = (Array.isArray(saved) ? saved : []).filter((t) => t && t.name !== theme.name);
  return [...list, theme];
}
