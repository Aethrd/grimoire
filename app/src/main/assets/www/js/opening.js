/* The scene while a book opens -- and, faint, behind the queue's progress.
 *
 * Seen from above at an angle: a thick book open on a desk, a quill writing
 * its right page with letters drifting in to become the ink, gliding from
 * line to line, travelling to the inkwell to dip as the page turns over with
 * its writing on it; on the left a magic circle, dark four times in ten,
 * otherwise woken one way or another (shine, fluctuate, decay, erode, burn,
 * freeze) for a while. In the theme's gradient, on the app's own dark ground.
 *
 * Nothing flashes: no fade is quicker than a second, nothing reaches full
 * brightness but a finished line for a moment, and the ground never changes.
 * With the phone's reduced motion on, nothing travels or turns: the quill
 * rests in the well, lines appear one at a time, and the circle only glows.
 *
 * playScene(canvas, { faint, glyphs }) starts it on a canvas; the returned
 * stop() ends it. Faint: drawn at half the frame rate, for behind the queue.
 */
export function playScene(canvas, { faint = false, glyphs = '' } = {}) {
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let calm = !!reduceQuery?.matches;
  let probe = null;
  try { probe = canvas?.getContext?.('2d') || null; } catch { probe = null; }
  if (!probe || typeof requestAnimationFrame !== 'function') return { stop() {} };

  const hexToRgb = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const WARM = [226, 140, 96];
  const COOL = [164, 200, 236];

  let ctx, W, H;
  function fit() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = box.width; H = box.height;
  }
  fit();

  /* ── the camera: above the desk, looking down at an angle ──────────────
   * The desk is z = 0; x runs right, y away from the reader, z up. Seen
   * from above and in front, tipped back PITCH from straight down: the far
   * end of the book a little smaller than the near, as a book on a desk is. */
  const PITCH = 0.62;
  const sinP = Math.sin(PITCH), cosP = Math.cos(PITCH);
  let D = 1000, CX = 0, CY = 0, S = 1;
  function camera() { D = 1000; CX = W / 2; CY = H * 0.42; S = Math.min(W / 400, H / 560, 1.25); }
  camera();
  function P(x, y, z) {
    const depth = D + y * sinP - z * cosP;
    const k = (D / depth) * S;
    return { x: CX + x * k, y: CY - (y * cosP + z * sinP) * k };
  }

  /* ── the book ──────────────────────────────────────────────────────────
   * Two blocks of pages, PW wide and PH deep, T thick, on boards a little
   * larger. A page rises from the spine and flattens towards its edge. */
  const PW = 150, PH = 200, T = 16, BOARD = 3, LIP = 7;
  const rise = (u) => {
    const a = Math.min(1, u / 0.32);
    return T + 9 * (1 - (1 - a) * (1 - a)) - 3.2 * Math.max(0, u - 0.32);
  };
  // A point on a page, its page's own terms: u from the spine (0) to the edge (1), v from the top (0) to the foot (1).
  const onRight = (u, v, lift = 0) => P(u * PW, PH / 2 - v * PH, rise(u) + 0.3 + lift);
  const onLeft = (u, v, lift = 0) => P(-u * PW, PH / 2 - v * PH, rise(u) + 0.3 + lift);
  const world = { right: (u, v, lift = 0) => ({ x: u * PW, y: PH / 2 - v * PH, z: rise(u) + 0.3 + lift }) };


  function path(points, close = true) {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
  }

  // The top of one block of pages, as a strip of points (side: -1 left, 1 right).
  function pageOutline(side) {
    const top = [], foot = [];
    for (let i = 0; i <= 16; i += 1) {
      const u = i / 16;
      top.push(P(side * u * PW, PH / 2, rise(u)));
      foot.push(P(side * u * PW, -PH / 2, rise(u)));
    }
    return top.concat(foot.reverse());
  }

  function drawBook() {
    // The shadow it casts on the desk, soft.
    const sc = P(0, -6, 0);
    const shadow = ctx.createRadialGradient(sc.x, sc.y, 10, sc.x, sc.y, PW * 1.35 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,.42)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    path([P(-PW - 26, -PH / 2 - 22, 0), P(PW + 26, -PH / 2 - 22, 0), P(PW + 26, PH / 2 + 12, 0), P(-PW - 26, PH / 2 + 12, 0)]);
    ctx.fill();

    // The boards: the cover under each block, a little larger, with its front edge.
    for (const side of [-1, 1]) {
      const x0 = 0, x1 = side * (PW + LIP);
      const top = [P(x0, PH / 2 + LIP, BOARD), P(x1, PH / 2 + LIP, BOARD), P(x1, -PH / 2 - LIP, BOARD), P(x0, -PH / 2 - LIP, BOARD)];
      ctx.fillStyle = '#2a2026';
      path(top); ctx.fill();
      ctx.fillStyle = '#1f181d';
      path([P(x0, -PH / 2 - LIP, BOARD), P(x1, -PH / 2 - LIP, BOARD), P(x1, -PH / 2 - LIP, 0), P(x0, -PH / 2 - LIP, 0)]); ctx.fill();
    }

    // The near edge of each block: its pages, layer on layer.
    for (const side of [-1, 1]) {
      const edge = [];
      for (let i = 0; i <= 16; i += 1) edge.push(P(side * (i / 16) * PW, -PH / 2, rise(i / 16)));
      const base = [P(side * PW, -PH / 2, BOARD), P(0, -PH / 2, BOARD)];
      const g = ctx.createLinearGradient(0, base[0].y, 0, edge[8].y);
      g.addColorStop(0, '#2a262b');
      g.addColorStop(1, '#3a353a');
      ctx.fillStyle = g;
      path(edge.concat(base)); ctx.fill();
      ctx.lineWidth = 0.5;
      for (let k = 1; k < 9; k += 1) {
        const f = k / 9;
        ctx.strokeStyle = `rgba(0,0,0,${0.08 + 0.03 * (k % 2)})`;
        const line = [];
        for (let i = 0; i <= 16; i += 1) { const u = i / 16; line.push(P(side * u * PW, -PH / 2, lerp(BOARD, rise(u), f))); }
        path(line, false); ctx.stroke();
      }
    }

    // The two pages: soft paper, darker into the spine, a fall of light across.
    for (const side of [-1, 1]) {
      const outline = pageOutline(side);
      const spine = P(0, 0, rise(0)), edge = P(side * PW, 0, rise(1));
      const g = ctx.createLinearGradient(spine.x, spine.y, edge.x, edge.y);
      g.addColorStop(0, '#2c282e');
      g.addColorStop(0.16, '#3b363c');
      g.addColorStop(0.62, '#3f3a40');
      g.addColorStop(1, '#3a353b');
      ctx.fillStyle = g;
      path(outline); ctx.fill();
      ctx.save();
      path(outline); ctx.clip();
      // Plain paper: one soft tone, a gentle fall of light -- no grain.
      const mid = P(side * PW * 0.55, 0, rise(0.55));
      const v = ctx.createRadialGradient(mid.x, mid.y, 10, mid.x, mid.y, PW * 0.95 * S);
      v.addColorStop(0, 'rgba(255,240,235,0.025)');
      v.addColorStop(1, 'rgba(0,0,0,0.1)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    // The fold, in shadow.
    const fold = ctx.createLinearGradient(P(-12, 0, T).x, 0, P(12, 0, T).x, 0);
    fold.addColorStop(0, 'rgba(0,0,0,0)');
    fold.addColorStop(0.5, 'rgba(0,0,0,.32)');
    fold.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fold;
    path([P(-12, PH / 2, rise(0.08)), P(12, PH / 2, rise(0.08)), P(12, -PH / 2, rise(0.08)), P(-12, -PH / 2, rise(0.08))]);
    ctx.fill();
  }

  /* ── the writing ─────────────────────────────────────────────────────── */
  const ROWS = 7;
  const WRITE_SPEED = 37.5;   // points a second: a quarter faster than before
  function lineShape(row) {
    const pts = [];
    const len = 0.66 + Math.random() * 0.12;
    const seed = Math.random() * 10;
    for (let i = 0; i <= 64; i += 1) {
      const k = i / 64;
      pts.push([0.13 + k * len + Math.cos(k * 40 + seed) * 0.006,
        0.14 + row * 0.11 + Math.sin(k * 40 + seed) * 0.013 * (0.6 + 0.4 * Math.sin(k * 9 + seed))]);
    }
    return { pts, drawn: 0, doneAt: null };
  }
  function strokeLines(lines, place, alpha, from, to, now, live) {
    for (const line of lines) {
      const upto = Math.floor(line.drawn);
      if (upto < 2 || alpha <= 0.01) continue;
      let a = 0.5;
      if (line.doneAt && live) {
        const since = (now - line.doneAt) / 1000;
        a = since < 0.7 ? 0.5 + 0.24 * ease(since / 0.7) : 0.74 - 0.28 * ease(clamp((since - 0.7) / 1.6));
      } else if (!live) a = 0.46;
      const p0 = place(...line.pts[0]), p1 = place(...line.pts[line.pts.length - 1]);
      const g = ctx.createLinearGradient(p0.x, p0.y, p1.x + 0.01, p1.y);
      g.addColorStop(0, rgba(from, a * alpha));
      g.addColorStop(1, rgba(to, a * alpha));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.25 * S;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < upto; i += 1) { const p = place(...line.pts[i]); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.stroke();
    }
  }

  /* ── the magic circle ────────────────────────────────────────────────
   * Drawn new for each page that lands on the left: rings, a star, rune
   * marks round the band, small circles at the star's points. Four times in
   * ten it lies dark; otherwise one effect takes it, at random, for a while. */
  const EFFECTS = ['shine', 'fluctuate', 'decay', 'erode', 'burn', 'freeze'];
  const rollEffect = () => (Math.random() < 0.4 ? 'dark' : EFFECTS[Math.floor(Math.random() * EFFECTS.length)]);
  /* Rune-like marks, drawn in a unit box: x across, y up (y=1 the top). Each is
   * a few strokes, none of them a real alphabet's letter. */
  const GLYPHS = [
    [[[0, -1], [0, 1]], [[0, 0.5], [0.6, 1]], [[0, 0], [0.6, 0.5]]],
    [[[0, -1], [0, 1]], [[-0.6, 1], [0, 0.3], [0.6, 1]]],
    [[[-0.6, -1], [0.6, 1]], [[-0.6, 1], [0.6, -1]]],
    [[[0, -1], [0, 1]], [[-0.5, 0.4], [0, 1], [0.5, 0.4]]],
    [[[-0.6, -1], [0, -0.2], [0.6, -1]], [[0, -0.2], [-0.55, 0.4], [0, 1], [0.55, 0.4], [0, -0.2]]],
    [[[-0.6, -1], [-0.6, 1], [0.6, -1], [0.6, 1], [-0.6, -1]]],
    [[[0, -1], [0, 1], [0.6, 0.6], [0, 0.15], [0.6, -1]]],
    [[[-0.6, -1], [-0.6, 1]], [[0.6, -1], [0.6, 1]], [[-0.6, 1], [0.6, 0]], [[0.6, 1], [-0.6, 0]]],
    [[[-0.6, -0.9], [0, 1], [0.6, -0.9], [-0.6, -0.9]]],
    [[[0.6, 1], [-0.4, 1], [-0.6, 0.6], [0.5, -0.2], [0.6, -0.7], [-0.6, -1]]],
    [[[-0.6, 0], [0.6, 0]], [[0, -1], [0, 1]], [[-0.4, 1], [0.4, 1]]],
    [[[0, 1], [0, -1]], [[-0.6, -0.4], [0, 0.2], [0.6, -0.4]], [[-0.3, 1], [0.3, 1]]],
  ];

  /* Each circle drawn new from parts chosen at random -- a rim (plain, spiked,
   * crescented, or broken by great glyphs), bands of runes or close script, a
   * figure (a star of any count, nested polygons, spokes, a hexagram, petals,
   * or small circles in orbit, each a circle of its own), points at its
   * corners and something at its heart -- so no two pages carry the same one. */
  function newCircle() {
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const chance = (p) => Math.random() < p;
    const TAU = Math.PI * 2;
    const segs = [], widths = [];
    const add = (seg, w = 1) => { segs.push(seg); widths.push(w); };
    const ring = (r, n = 72, from = 0, to = TAU, cx = 0, cy = 0) => {
      const out = [];
      for (let i = 0; i <= n; i += 1) { const a = lerp(from, to, i / n); out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
      return out;
    };
    const polygon = (r, n, spin, step = 1, cx = 0, cy = 0) => {
      const out = [];
      for (let i = 0; i <= n; i += 1) { const a = spin + ((i * step) % n) / n * TAU; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
      return out;
    };
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    // A star {n/step}: one line where the count allows, else as many as it takes.
    const star = (r, n, step, spin, cx = 0, cy = 0, w = 1) => {
      const parts = gcd(n, step), m = n / parts;
      for (let p = 0; p < parts; p += 1) add(polygon(r, m, spin + (p / n) * TAU, step / parts, cx, cy), w);
    };
    // A glyph centred at (cx, cy), its "up" along angle `up`, `h` its half-height.
    const glyph = (cx, cy, h, up, kind = Math.floor(Math.random() * GLYPHS.length), w = 1) => {
      const ux = Math.cos(up), uy = Math.sin(up), tx = -uy, ty = ux;
      for (const stroke of GLYPHS[kind]) add(stroke.map(([gx, gy]) => [cx + (tx * gx + ux * gy) * h, cy + (ty * gx + uy * gy) * h]), w);
    };
    // Glyphs set round a ring, upright to it.
    const writeRound = (r, h, count, spin, w) => {
      for (let i = 0; i < count; i += 1) {
        const a = spin + (i / count) * TAU;
        glyph(Math.cos(a) * r, Math.sin(a) * r, h, a, undefined, w);
      }
    };

    const spin = Math.random() * TAU;
    const rim = pick(['plain', 'plain', 'spiked', 'crescents', 'broken']);
    const R = rim === 'plain' ? rand(0.32, 0.39) : rand(0.29, 0.34);   // in page widths

    // The rim.
    if (rim === 'broken') {
      // The outer ring in arcs, a great glyph standing in each gap.
      const n = pick([5, 6, 7, 8]), gap = 0.32 / n * Math.PI;
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU;
        add(ring(R, 14, a + gap, a + TAU / n - gap), 1.3);
        glyph(Math.cos(a) * R, Math.sin(a) * R, R * 0.09, a, undefined, 1.3);
      }
    } else add(ring(R), rim === 'plain' ? 1.2 : 1);
    if (rim === 'spiked') {
      // Points outward: great ones at the quarters, lesser between, a diamond in each.
      const n = pick([8, 12, 16]);
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU, major = i % (n / 4) === 0;
        const len = major ? R * 0.26 : R * 0.12, half = major ? 0.09 : 0.06;
        const at = (r, da) => [Math.cos(a + da) * r, Math.sin(a + da) * r];
        add([at(R, -half), at(R + len, 0), at(R, half)]);
        if (major) add([at(R + len * 0.15, 0), at(R + len * 0.4, -half * 0.35), at(R + len * 0.65, 0), at(R + len * 0.4, half * 0.35), at(R + len * 0.15, 0)], 0.8);
      }
      if (chance(0.6)) for (let i = 0; i < n * 3; i += 1) { const a = spin + ((i + 0.5) / (n * 3)) * TAU; add(ring(R * 0.008, 6, 0, TAU, Math.cos(a) * R * 1.05, Math.sin(a) * R * 1.05), 0.8); }
    } else if (rim === 'crescents') {
      const n = pick([8, 10, 12]);
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU, cx = Math.cos(a) * R * 1.07, cy = Math.sin(a) * R * 1.07, cr = R * 0.05;
        add(ring(cr, 16, a + 0.5, a + TAU - 0.5, cx, cy), 0.9);
        add(ring(cr * 0.8, 14, a + 1.1, a + TAU - 1.1, cx + Math.cos(a) * cr * 0.4, cy + Math.sin(a) * cr * 0.4), 0.9);
      }
    }
    if (rim !== 'broken' && chance(0.45)) {
      const n = pick([24, 36, 48, 60]);
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * TAU, l = R * (i % 4 === 0 ? 0.07 : 0.035);
        add([[Math.cos(a) * R, Math.sin(a) * R], [Math.cos(a) * (R - l), Math.sin(a) * (R - l)]], 0.7);
      }
    }

    // The band(s): runes, close script, dots, ticks, or none; sometimes two bands.
    let outer = R;
    const bands = chance(0.3) ? 2 : 1;
    for (let k = 0; k < bands; k += 1) {
      const width = R * (k === 0 ? rand(0.12, 0.2) : rand(0.08, 0.12));
      const inner = outer - width;
      add(ring(inner), k === 0 ? 1 : 0.8);
      const mid = outer - width / 2, h = width * 0.3;
      const fill = pick(['runes', 'script', 'script', 'dots', 'ticks', 'none']);
      if (fill === 'runes') writeRound(mid, h, 10 + Math.floor(Math.random() * 10), spin, 0.9);
      else if (fill === 'script') writeRound(mid, h * 0.75, Math.floor(TAU * mid / (h * 1.9)), spin + k, 0.6);
      else if (fill === 'dots') {
        const n = 16 + Math.floor(Math.random() * 20);
        for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add(ring(h * (i % 3 === 0 ? 0.5 : 0.28), 10, 0, TAU, Math.cos(a) * mid, Math.sin(a) * mid), 0.7); }
      } else if (fill === 'ticks') {
        const n = 24 + Math.floor(Math.random() * 24);
        for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add([[Math.cos(a) * (mid - h), Math.sin(a) * (mid - h)], [Math.cos(a) * (mid + h), Math.sin(a) * (mid + h)]], 0.7); }
      }
      outer = inner;
      if (k === 0 && bands === 2) { outer -= R * 0.04; add(ring(outer), 0.7); }
    }
    if (chance(0.35)) add(ring(outer * rand(0.55, 0.7), 60), 0.8);

    // The figure, inside the bands.
    const space = outer * rand(0.94, 0.99);
    const figure = pick(['star', 'star', 'nested', 'spokes', 'hexagram', 'petals', 'orbit', 'orbit']);
    let points = [];
    if (figure === 'star') {
      const n = pick([5, 6, 7, 8, 9, 10, 12]);
      const steps = [];
      for (let k = 2; k < n / 2; k += 1) steps.push(k);
      star(space, n, steps.length ? pick(steps) : 2, spin);
      if (chance(0.4)) add(polygon(space, n, spin), 0.8);
      points = polygon(space, n, spin).slice(0, n);
    } else if (figure === 'nested') {
      const n = pick([3, 4, 5, 6, 8]), count = 2 + Math.floor(Math.random() * 2);
      for (let k = 0; k < count; k += 1) add(polygon(space * Math.pow(Math.cos(Math.PI / n), k), n, spin + k * Math.PI / n));
      points = polygon(space, n, spin).slice(0, n);
    } else if (figure === 'spokes') {
      const n = pick([6, 8, 12, 16]);
      for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add([[Math.cos(a) * space * 0.22, Math.sin(a) * space * 0.22], [Math.cos(a) * space, Math.sin(a) * space]], 0.8); }
      add(polygon(space * 0.7, n, spin + Math.PI / n));
      points = polygon(space, n, spin).slice(0, n).filter((_, i) => i % 2 === 0);
    } else if (figure === 'hexagram') {
      add(polygon(space, 3, spin)); add(polygon(space, 3, spin + Math.PI / 3));
      add(ring(space * 0.5, 48), 0.9);
      if (chance(0.5)) { add(polygon(space * 0.5, 3, spin + Math.PI), 0.8); add(polygon(space * 0.5, 3, spin), 0.8); }
      points = polygon(space, 6, spin).slice(0, 6);
    } else if (figure === 'petals') {
      // Lens-shaped petals out from the middle, sometimes a lesser set between.
      const n = pick([4, 5, 6, 8]);
      const petal = (a, r0, r1, wide, w) => {
        const one = [], back = [];
        for (let i = 0; i <= 14; i += 1) {
          const t = i / 14, r = lerp(r0, r1, t), off = Math.sin(t * Math.PI) * wide;
          const x = Math.cos(a) * r, y = Math.sin(a) * r, nx = -Math.sin(a), ny = Math.cos(a);
          one.push([x + nx * off, y + ny * off]); back.unshift([x - nx * off, y - ny * off]);
        }
        add(one.concat(back), w);
      };
      for (let i = 0; i < n; i += 1) {
        const a = spin + (i / n) * TAU;
        petal(a, space * 0.12, space * 0.96, space * rand(0.16, 0.22), 1);
        if (chance(0.7)) add(ring(space * 0.08, 20, 0, TAU, Math.cos(a) * space * 0.55, Math.sin(a) * space * 0.55), 0.8);
      }
      if (chance(0.5)) for (let i = 0; i < n; i += 1) petal(spin + ((i + 0.5) / n) * TAU, space * 0.3, space * 0.75, space * 0.08, 0.7);
      points = polygon(space, n, spin).slice(0, n);
    } else {
      // Circles in orbit, each a little circle of its own, joined by a figure.
      const n = pick([3, 4, 5, 6]);
      const sr = space * (n <= 4 ? rand(0.2, 0.26) : rand(0.15, 0.19));
      const orbit = space - sr * 1.05;
      const centres = polygon(orbit, n, spin).slice(0, n);
      add(polygon(orbit, n, spin), 0.9);
      if (chance(0.5)) add(ring(orbit, 72), 0.6);
      if (n >= 5 && chance(0.6)) star(orbit, n, 2, spin, 0, 0, 0.7);
      for (const [cx, cy] of centres) {
        add(ring(sr, 40, 0, TAU, cx, cy));
        const inside = pick(['star', 'ring', 'glyph', 'script']);
        if (inside === 'star') { const m = pick([5, 6, 7, 8]); star(sr * 0.85, m, m === 6 ? 2 : Math.floor((m - 1) / 2), Math.random() * TAU, cx, cy, 0.7); }
        else if (inside === 'ring') { add(ring(sr * 0.62, 28, 0, TAU, cx, cy), 0.8); add(ring(sr * 0.2, 12, 0, TAU, cx, cy), 0.8); }
        else if (inside === 'glyph') glyph(cx, cy, sr * 0.5, Math.atan2(cy, cx), undefined, 1);
        else {
          add(ring(sr * 0.72, 32, 0, TAU, cx, cy), 0.6);
          const m = 9 + Math.floor(Math.random() * 5);
          for (let i = 0; i < m; i += 1) { const a = (i / m) * TAU; glyph(cx + Math.cos(a) * sr * 0.86, cy + Math.sin(a) * sr * 0.86, sr * 0.09, a, undefined, 0.5); }
        }
      }
      if (chance(0.5)) add(polygon(space * 0.98, 3, spin + Math.PI / n + Math.random()), 0.8);   // a great triangle across
    }

    // At its points: small circles (sometimes with a mark), diamonds, or nothing.
    const satellite = figure === 'orbit' ? 'none' : pick(['circle', 'circle', 'diamond', 'none']);
    const pr = R * rand(0.05, 0.085);
    for (const [px, py] of satellite === 'none' ? [] : points) {
      if (satellite === 'circle') { add(ring(pr, 18, 0, TAU, px, py), 0.9); if (chance(0.5)) glyph(px, py, pr * 0.55, Math.atan2(py, px), undefined, 0.6); }
      else add(polygon(pr, 4, Math.atan2(py, px), 1, px, py), 0.9);
    }

    // Its heart.
    const heart = pick(['ring', 'crescent', 'dot', 'star', 'glyph', 'rings', 'none']);
    const hr = R * rand(0.09, 0.16);
    if (heart === 'ring') { add(ring(hr, 36)); add(ring(hr * 0.55, 24), 0.8); }
    else if (heart === 'crescent') { add(ring(hr, 36, 0.4, TAU - 0.4)); add(ring(hr * 0.8, 30, 0.9, TAU - 0.9, hr * 0.35, 0)); }
    else if (heart === 'dot') add(ring(hr * 0.22, 12));
    else if (heart === 'star') star(hr, 5, 2, spin);
    else if (heart === 'glyph') { add(ring(hr * 1.1, 36), 0.8); glyph(0, 0, hr * 0.7, -Math.PI / 2); }
    else if (heart === 'rings') for (let k = 1; k <= 3; k += 1) add(ring(hr * k / 3, 18 + k * 8), 0.7);
    // A few arcs inside the band, sometimes.
    if (chance(0.3)) {
      const n = pick([3, 4, 6]);
      for (let i = 0; i < n; i += 1) { const a = spin + (i / n) * TAU; add(ring(outer * 0.93, 16, a + 0.15, a + TAU / n - 0.15), 0.7); }
    }
    return {
      segs, widths, seeds: segs.map(() => Math.random()),
      effect: rollEffect(), was: 'dark', wasT: 0, blend: 1, since: 0, next: rand(5, 9),
      embers: [], frost: segs.slice(0, 2).flatMap((one) => one.filter((_, i) => i % 6 === 0).map((p) => ({ p, len: 0, max: rand(0.015, 0.04) }))),
    };
  }

  // A point of the circle on a page: local (a, b) in page widths, centred on the page.
  const circlePoint = (place, a, b) => place(0.5 + a, 0.5 + b * (PW / PH));

  function effectLook(name, c, seed, now, t) {
    // { alpha, colour mix (warm/cool), width, rotation, scale, gap } for one segment.
    const look = { alpha: 0.2, warm: 0, cool: 0, width: 1, rot: 0, scale: 1, keep: 1 };
    switch (name) {
      case 'dark': look.alpha = 0.16; break;
      case 'shine': look.alpha = 0.3 + 0.32 * (0.5 - 0.5 * Math.cos(t * 1.4)); look.width = 1.2; break;
      case 'fluctuate':
        look.alpha = 0.32 + 0.14 * Math.sin(now / 900 + seed * 6);
        look.rot = Math.sin(now / 2600) * 0.08;
        look.scale = 1 + Math.sin(now / 1700) * 0.025;
        break;
      case 'decay': look.alpha = Math.max(0.05, 0.42 - t * (0.06 + seed * 0.12)); break;
      case 'erode': look.alpha = 0.36; look.keep = clamp(1 - t * (0.05 + seed * 0.08), 0.15, 1); break;
      case 'burn': look.alpha = 0.4 + 0.08 * Math.sin(now / 300 + seed * 9); look.warm = clamp(t / 2); break;
      case 'freeze': look.alpha = 0.36; look.cool = clamp(t / 2.5); break;
      default: break;
    }
    return look;
  }

  function drawCircle(c, place, fade, from, to, now, dt) {
    if (!c || fade <= 0.01) return;
    c.since += dt;
    if (!calm && c.since > c.next) {
      // Handed over from exactly where the last effect was, so nothing jumps.
      c.was = c.effect; c.wasT = c.since; c.effect = rollEffect(); c.blend = 0; c.since = 0; c.next = rand(5, 9);
      c.embers.length = 0; c.frost.forEach((f) => { f.len = 0; });
    }
    if (calm && c.effect !== 'dark' && c.effect !== 'shine') { c.was = c.effect; c.wasT = c.since; c.effect = 'shine'; c.blend = 0; }
    c.blend = Math.min(1, c.blend + dt / 1.4);
    const t = c.since;
    c.segs.forEach((seg, si) => {
      const seed = c.seeds[si];
      const a = effectLook(c.effect, c, seed, now, t);
      const b = effectLook(c.was, c, seed, now, c.wasT || 0);
      const k = ease(c.blend);
      const alpha = lerp(b.alpha, a.alpha, k) * fade;
      const warm = lerp(b.warm, a.warm, k), cool = lerp(b.cool, a.cool, k);
      const rot = lerp(b.rot, a.rot, k), scale = lerp(b.scale, a.scale, k), keep = lerp(b.keep, a.keep, k);
      let colour = mix(from, to, seed * 0.8);
      if (warm) colour = mix(colour, WARM, warm * 0.55);
      if (cool) colour = mix(colour, COOL, cool * 0.55);
      ctx.strokeStyle = rgba(colour, alpha);
      ctx.lineWidth = lerp(b.width, a.width, k) * (c.widths[si] || 1) * S;
      ctx.lineCap = 'round';
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const pts = seg.map(([x, y]) => circlePoint(place, (x * cr - y * sr) * scale, (x * sr + y * cr) * scale));
      if (keep >= 0.999) { path(pts, false); ctx.stroke(); }
      else {
        // Eaten away: only stretches of it left, where its own noise allows.
        for (let i = 1; i < pts.length; i += 1) {
          if (Math.sin(i * 2.7 + seed * 40) * 0.5 + 0.5 > keep) continue;
          ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
        }
      }
    });
    // Burn: a few embers lift off the rings and fade. Freeze: frost creeps out from the rings.
    if (c.effect === 'burn' && !calm) {
      if (Math.random() < dt * 6 && c.embers.length < 24) {
        const ring = c.segs[0], p = ring[Math.floor(Math.random() * ring.length)];
        c.embers.push({ a: p[0], b: p[1], z: 0, life: 0 });
      }
      for (const e of c.embers) {
        e.life += dt; e.z += dt * 9;
        const at = place(0.5 + e.a, 0.5 + e.b * (PW / PH));
        const fadeE = Math.sin(clamp(e.life / 2.2) * Math.PI) * 0.4 * ease(c.blend) * fade;
        ctx.fillStyle = rgba(mix(WARM, from, 0.3), fadeE);
        ctx.beginPath(); ctx.arc(at.x, at.y - e.z * S, 1.3 * S, 0, Math.PI * 2); ctx.fill();
      }
      c.embers = c.embers.filter((e) => e.life < 2.2);
    }
    if (c.effect === 'freeze') {
      ctx.strokeStyle = rgba(mix(COOL, from, 0.25), 0.35 * ease(c.blend) * fade);
      ctx.lineWidth = 0.8 * S;
      for (const f of c.frost) {
        f.len = Math.min(f.max, f.len + dt * 0.012);
        const [x, y] = f.p, r = Math.hypot(x, y) || 1;
        const o = circlePoint(place, x, y), e = circlePoint(place, x + (x / r) * f.len, y + (y / r) * f.len);
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      }
    }
  }

  /* ── the inkwell: a squat glass bottle, its neck open ─────────────────── */
  // In front of the book, to the right: within reach of the page, and on screen on a phone.
  const WELL = { x: PW * 0.74, y: -PH / 2 - 36, r: 16, h: 22, neck: 8, nh: 7 };
  const wellTop = () => WELL.h + WELL.nh;
  function ellipsePts(cx, cy, z, r, n = 28, from = 0, to = Math.PI * 2) {
    const pts = [];
    for (let i = 0; i <= n; i += 1) { const a = lerp(from, to, i / n); pts.push(P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z)); }
    return pts;
  }
  function drawWellBack(from, to) {
    const { x, y, r, h, neck, nh } = WELL;
    // Its shadow, then the body: the near half of its base and the whole of its shoulder.
    const s = P(x + 4, y - 3, 0);
    const shadow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, r * 1.8 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,.45)'); shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.8 * S, 0, Math.PI * 2); ctx.fill();
    const left = P(x - r, y, 0), right = P(x + r, y, 0);
    const g = ctx.createLinearGradient(left.x, 0, right.x, 0);
    g.addColorStop(0, '#16151b'); g.addColorStop(0.32, '#2a2832'); g.addColorStop(0.45, '#3a3744'); g.addColorStop(0.6, '#24222b'); g.addColorStop(1, '#141318');
    ctx.fillStyle = g;
    // Its outline: the near half of its base, up, and the far half of its top.
    path(ellipsePts(x, y, 0, r, 28, Math.PI, Math.PI * 2).concat(ellipsePts(x, y, h, r, 28, 0, Math.PI)));
    ctx.fill();
    // Its top, a shoulder, and the neck's back half.
    ctx.fillStyle = '#25232c';
    path(ellipsePts(x, y, h, r)); ctx.fill();
    ctx.fillStyle = '#1b1a21';
    path(ellipsePts(x, y, h, neck, 20, Math.PI, Math.PI * 2).concat(ellipsePts(x, y, h + nh, neck, 20, 0, Math.PI))); ctx.fill();
    // The ink inside, a dark pool with the faintest sheen of the theme.
    const ink = ellipsePts(x, y, h + nh - 1.5, neck - 1.3);
    const c = P(x - 2, y + 2, h + nh);
    const sheen = ctx.createRadialGradient(c.x, c.y, 0.5, c.x, c.y, neck * 1.3 * S);
    sheen.addColorStop(0, rgba(mix(to, [0, 0, 0], 0.3), 0.55)); sheen.addColorStop(1, 'rgba(8,7,10,1)');
    ctx.fillStyle = sheen; path(ink); ctx.fill();
    // The rim's far half.
    ctx.strokeStyle = rgba(to, 0.55); ctx.lineWidth = 1.2 * S;
    path(ellipsePts(x, y, h + nh, neck, 20, 0, Math.PI), false); ctx.stroke();
    // A highlight down the glass.
    const hl = [P(x - r * 0.45, y - r * 0.85, 3), P(x - r * 0.45, y - r * 0.85, h - 3)];
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 2.2 * S;
    path(hl, false); ctx.stroke();
  }
  // Drawn over the quill: the near half of the neck and rim, so a dipped nib is inside it.
  function drawWellFront(to) {
    const { x, y, h, neck, nh } = WELL;
    ctx.fillStyle = '#1e1d25';
    path(ellipsePts(x, y, h, neck, 20, Math.PI, Math.PI * 2).concat(ellipsePts(x, y, h + nh, neck, 20, Math.PI, Math.PI * 2).reverse())); ctx.fill();
    ctx.strokeStyle = rgba(to, 0.6); ctx.lineWidth = 1.2 * S;
    path(ellipsePts(x, y, h + nh, neck, 20, Math.PI, Math.PI * 2), false); ctx.stroke();
  }

  /* ── the quill: drawn at its nib, leaning back over the page ─────────── */
  function drawQuill(at, lean, from, to) {
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(-0.95 + lean);
    ctx.scale(S, S);
    const g = ctx.createLinearGradient(0, 0, 0, -82);
    g.addColorStop(0, rgba(to, 0.94)); g.addColorStop(1, rgba(from, 0.85));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-12, -32, -5, -82);
    ctx.quadraticCurveTo(8, -50, 3, -9);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(from, 0.45); ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(0.5, -2); ctx.lineTo(-2.6, -76); ctx.stroke();
    // Barbs, faint.
    ctx.strokeStyle = rgba(to, 0.25); ctx.lineWidth = 0.6;
    for (let i = 14; i < 70; i += 7) { ctx.beginPath(); ctx.moveTo(-1.5 - i * 0.015, -i); ctx.lineTo(-8 + i * 0.02, -i - 6); ctx.stroke(); }
    ctx.restore();
  }

  /* ── the story of it: write, glide, travel, dip, turn, return ────────── */
  const state = {
    phase: 'return', t: 0,
    right: [], leaf: null,
    circle: newCircle(), nextCircle: null,
    nib: { x: WELL.x, y: WELL.y, z: wellTop() + 10 },   // in the desk's terms
    from: null,             // where a move began
    handover: 1,            // calm: the left page's fade
  };
  const nibAtWell = (depth) => ({ x: WELL.x, y: WELL.y, z: wellTop() + depth });
  // A move from where the nib is to `to`, over `secs`, lifted `arc` on the way.
  function move(to, secs, arc) {
    state.from = { ...state.nib, to, secs, arc, t: 0 };
  }
  function stepMove(dt) {
    const m = state.from;
    if (!m) return true;
    m.t += dt;
    const k = ease(clamp(m.t / m.secs));
    state.nib = { x: lerp(m.x, m.to.x, k), y: lerp(m.y, m.to.y, k), z: lerp(m.z, m.to.z, k) + Math.sin(k * Math.PI) * m.arc };
    if (m.t >= m.secs) { state.nib = { ...m.to }; state.from = null; return true; }
    return false;
  }
  const lineStart = (row) => world.right(0.13, 0.14 + row * 0.11, 0);

  /* ── the letters: drifting, and drawn into the nib as it writes ─────── */
  // The book's own title among them, as its letters.
  const POOL = `${String(glyphs || '').replace(/\s+/g, '')}이야기책장文書章話物語あかさたなAbcdefghijkmnoprstuvwy`;
  const letters = [];
  function spawn(l, anywhere) {
    l.ch = POOL[Math.floor(Math.random() * POOL.length)];
    l.x = anywhere ? Math.random() * W : (Math.random() < 0.5 ? -10 : W + 10);
    l.y = Math.random() * H * 0.84;
    l.vx = (Math.random() - 0.5) * 8; l.vy = (Math.random() - 0.5) * 6;
    l.base = 0.14 + Math.random() * 0.14;
    l.size = 12 + Math.random() * 7;
    l.born = performance.now();
    l.feed = null;
  }
  for (let i = 0; i < 38; i += 1) { const l = {}; spawn(l, true); l.born -= 2000; letters.push(l); }
  let lastFeed = 0;

  function step(dt, now) {
    ctx.clearRect(0, 0, W, H);
    const from = hexToRgb(css('--grad-from')), to = hexToRgb(css('--grad-to'));
    state.t += dt;
    const writing = state.right.find((line) => !line.doneAt);

    if (calm) {
      // No travel, no turning: the quill rests in the well; lines appear one at a time; a full page hands over by a fade.
      state.leaf = null; state.from = null;
      state.nib = nibAtWell(-6);
      if (state.handover < 1) {
        state.handover = Math.min(1, state.handover + dt / 1.5);
        if (state.handover >= 1) { state.right = []; state.circle = state.nextCircle || newCircle(); state.nextCircle = null; }
      } else if (state.t > 1.6) {
        state.t = 0;
        if (state.right.length >= ROWS) { state.nextCircle = newCircle(); state.handover = 0; }
        else { const line = lineShape(state.right.length); line.drawn = line.pts.length; line.doneAt = now; state.right.push(line); }
      }
      if (state.phase !== 'calm') state.phase = 'calm';
    } else if (state.phase === 'calm') {
      state.phase = 'return'; state.t = 0; state.handover = 1;
      if (state.nextCircle) { state.circle = state.nextCircle; state.nextCircle = null; }
    }

    if (state.phase === 'return') {
      // Back to the start of the next line to write, lifted and eased: never a jump.
      if (!state.from) move(lineStart(state.right.length), 1.25, 26);
      if (stepMove(dt)) { state.phase = 'write'; state.t = 0; }
    } else if (state.phase === 'write') {
      let line = writing;
      if (!line && state.right.length < ROWS) { line = lineShape(state.right.length); state.right.push(line); }
      if (line) {
        line.drawn = Math.min(line.pts.length, line.drawn + dt * WRITE_SPEED);
        const p = line.pts[Math.max(0, Math.floor(line.drawn) - 1)];
        state.nib = world.right(p[0], p[1], 0);
        if (line.drawn >= line.pts.length) {
          line.doneAt = now;
          // Glide to the next line, the nib lifted a little; or, the page full, to the inkwell.
          if (state.right.length < ROWS) { state.phase = 'glide'; move(lineStart(state.right.length), 0.45, 6); }
          else { state.phase = 'toWell'; move(nibAtWell(14), 1.5, 34); }
        }
      }
    } else if (state.phase === 'glide') {
      if (stepMove(dt)) state.phase = 'write';
    } else if (state.phase === 'toWell') {
      if (stepMove(dt)) { state.phase = 'dip'; state.t = 0; }
    } else if (state.phase === 'dip') {
      // Down through the neck into the ink, a moment, and up: the page turns meanwhile.
      const k = state.t;
      const depth = k < 0.6 ? lerp(14, -7, ease(k / 0.6)) : k < 0.95 ? -7 : lerp(-7, 12, ease(clamp((k - 0.95) / 0.6)));
      state.nib = nibAtWell(depth);
      if (!state.leaf && k > 0.3) {
        state.nextCircle = newCircle();
        state.leaf = { lines: state.right, theta: 0 };
        state.right = [];
      }
      if (k > 1.55) { state.phase = 'wait'; state.t = 0; }
    } else if (state.phase === 'wait') {
      state.nib = nibAtWell(12 + Math.sin(state.t * 2) * 1.5);
      if (!state.leaf) { state.phase = 'return'; state.t = 0; state.from = null; }
    }

    // The leaf turning over: carried by an eased angle, bent a little as a page is.
    if (state.leaf) {
      state.leaf.age = (state.leaf.age || 0) + dt;
      state.leaf.theta = Math.PI * ease(clamp(state.leaf.age / 2.3));
      if (state.leaf.age >= 2.3) {
        state.circle = state.nextCircle; state.nextCircle = null;
        state.leaf = null;
      }
    }

    // ── letters behind the book ──
    const nibScreen = P(state.nib.x, state.nib.y, state.nib.z);
    const feeding = !calm && state.phase === 'write';
    if (feeding && now - lastFeed > 240) {
      const free = letters.filter((l) => !l.feed && now - l.born > 1200);
      const pick = free[Math.floor(Math.random() * free.length)];
      if (pick) pick.feed = { x: pick.x, y: pick.y, size: pick.size, a: pick.base, t: 0 };
      lastFeed = now;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const drawLetter = (l) => {
      const born = clamp((now - l.born) / 1000);
      let x = l.x, y = l.y, size = l.size, a = l.base * born;
      if (calm) a = l.base * (0.85 + 0.15 * Math.sin(now / 1500 + l.size));
      else if (l.feed) {
        l.feed.t += dt;
        const k = ease(clamp(l.feed.t / 1.3));
        x = lerp(l.feed.x, nibScreen.x, k); y = lerp(l.feed.y, nibScreen.y, k);
        size = l.feed.size * (1 - 0.7 * k);
        a = l.feed.a + (0.48 - l.feed.a) * Math.sin(k * Math.PI) - l.feed.a * k;
        if (k >= 1) { spawn(l, false); return; }
      } else {
        l.x += l.vx * dt; l.y += l.vy * dt;
        if (l.x < -20 || l.x > W + 20 || l.y < -20 || l.y > H * 0.86) { spawn(l, false); return; }
        x = l.x; y = l.y;
      }
      ctx.fillStyle = rgba(mix(from, to, clamp(x / W)), a);
      ctx.font = `600 ${size}px Archivo, "Noto Sans KR", "Noto Sans JP", sans-serif`;
      ctx.fillText(l.ch, x, y);
    };
    for (const l of letters) if (!l.feed) drawLetter(l);

    // ── the book, the circle, the writing ──
    drawBook();
    if (calm && state.handover < 1) {
      drawCircle(state.circle, onLeft, 1 - ease(state.handover), from, to, now, dt);
      drawCircle(state.nextCircle, onLeft, ease(state.handover), from, to, now, 0);
      strokeLines(state.right, onRight, 1 - ease(state.handover), from, to, now, true);
    } else {
      drawCircle(state.circle, onLeft, 1, from, to, now, dt);
      strokeLines(state.right, onRight, 1, from, to, now, true);
    }

    // ── the leaf, its writing on its face and the next circle on its back ──
    if (state.leaf) {
      const th = state.leaf.theta;
      const N = 18;
      const curve = [];   // along the leaf from the spine: { x, z } in the desk's terms
      let x = 0, z = rise(0);
      curve.push({ x, z, u: 0 });
      for (let i = 1; i <= N; i += 1) {
        const u = i / N;
        const phi = th + Math.sin(th) * 0.55 * u;         // the outer part lags: the page bends
        x += Math.cos(phi) * PW / N; z += Math.sin(phi) * PW / N;
        // Flat at both ends it lies on the pages' own rise, so it lands where it settles.
        const flat = Math.abs(Math.cos(th));
        curve.push({ x, z: z + (rise(u) - rise(0)) * flat * flat, u });
      }
      const at = (u, v) => {
        const f = u * N, i = Math.min(N - 1, Math.floor(f)), k = f - i;
        const p = curve[i], q = curve[i + 1];
        return P(lerp(p.x, q.x, k), PH / 2 - v * PH, lerp(p.z, q.z, k) + 0.4);
      };
      const outline = curve.map((c) => P(c.x, PH / 2, c.z)).concat(curve.slice().reverse().map((c) => P(c.x, -PH / 2, c.z)));
      const face = Math.cos(th);   // > 0: its written face is up; < 0: its back
      const shade = 0.6 + 0.4 * Math.abs(face);
      const mid = P(curve[N >> 1].x, 0, curve[N >> 1].z), tip = P(curve[N].x, 0, curve[N].z), base = P(0, 0, rise(0));
      const g = ctx.createLinearGradient(base.x, base.y, tip.x + 0.01, tip.y);
      g.addColorStop(0, `rgb(${Math.round(41 * shade)},${Math.round(37 * shade)},${Math.round(43 * shade)})`);
      g.addColorStop(0.5, `rgb(${Math.round(64 * shade)},${Math.round(58 * shade)},${Math.round(63 * shade)})`);
      g.addColorStop(1, `rgb(${Math.round(56 * shade)},${Math.round(50 * shade)},${Math.round(56 * shade)})`);
      ctx.fillStyle = g;
      path(outline); ctx.fill();
      ctx.save();
      path(outline); ctx.clip();
      // Its writing, only on it, going as it stands upright; its back's circle coming as it lies down.
      if (face > 0) strokeLines(state.leaf.lines, at, clamp((face - 0.1) / 0.45), from, to, now, false);
      else drawCircle(state.nextCircle, (u, v) => at(u, v), clamp((-face - 0.1) / 0.45), from, to, now, 0);
      ctx.restore();
      void mid;
    }

    // ── the inkwell, the quill, the letters drawn into it ──
    drawWellBack(from, to);
    const inNeck = state.nib.z < wellTop() + 2 && Math.hypot(state.nib.x - WELL.x, state.nib.y - WELL.y) < 3;
    // The glow behind the nib: short, faint, fading.
    if (!calm && state.phase === 'write' && writing) {
      const end = Math.floor(writing.drawn);
      for (let i = Math.max(1, end - 12); i < end; i += 1) {
        const k = 1 - (end - i) / 12;
        const p = onRight(...writing.pts[i - 1]), q = onRight(...writing.pts[i]);
        ctx.strokeStyle = rgba(from, 0.32 * k);
        ctx.lineWidth = (4 * k + 1) * S;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    }
    for (const l of letters) if (l.feed) drawLetter(l);
    const lean = state.phase === 'write' ? Math.sin(now / 150) * 0.05 : 0.18;
    drawQuill(nibScreen, lean, from, to);
    if (inNeck) drawWellFront(to);
  }

  let last = performance.now();
  let raf = 0;
  let stopped = false;
  let skip = false;
  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    // Faint, behind the queue: every other frame is enough, and kinder to the battery.
    if (faint && (skip = !skip)) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden && W > 2 && H > 2) { try { step(dt, now); } catch (e) { console.warn('opening scene', e); } }
  }
  raf = requestAnimationFrame(frame);
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { fit(); camera(); }) : null;
  resized?.observe(canvas);
  const onReduce = (e) => { calm = e.matches; };
  reduceQuery?.addEventListener?.('change', onReduce);
  return {
    stop() {
      stopped = true;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      resized?.disconnect();
      reduceQuery?.removeEventListener?.('change', onReduce);
      try { ctx.clearRect(0, 0, W, H); } catch { /* gone */ }
    },
  };
}
