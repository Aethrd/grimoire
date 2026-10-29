package com.grimoire.ereader;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Vertical writing, laid out again as horizontal lines.
 *
 * The recogniser on the phone is trained on lines that run across the page.
 * Given a manga bubble -- Japanese or Chinese set in columns, top to bottom,
 * the columns read right to left -- it reads the columns as if they were
 * lines lying on their side, and a kana on its side is a letter: イ comes out
 * T, あ comes out A. So the columns are found, each is cut into its
 * characters, and the characters are set side by side as an ordinary line,
 * which the recogniser reads well.
 *
 * Cutting a column into characters leans on how Japanese is typeset: every
 * character, the small kana and the punctuation included, takes the same
 * square, as tall as the column is wide. So the column is cut where the ink
 * stops, and the pieces put back together until each is about one square:
 * the two strokes of ニ become one character, っ and た stay two.
 *
 * Plain Java, with no Android in it, so that it can be tried off the phone.
 */
final class VerticalLayout {

    private VerticalLayout() {}

    /** A rectangle, left and top inclusive, right and bottom exclusive. */
    static final class Box {
        int left, top, right, bottom;

        Box(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        Box copy() { return new Box(left, top, right, bottom); }
        int width() { return right - left; }
        int height() { return bottom - top; }
        float centreX() { return (left + right) / 2f; }

        void union(Box other) {
            left = Math.min(left, other.left);
            top = Math.min(top, other.top);
            right = Math.max(right, other.right);
            bottom = Math.max(bottom, other.bottom);
        }

        @Override public String toString() { return "[" + left + "," + top + " " + width() + "x" + height() + "]"; }
    }

    /** A patch of the picture as brightness, and which of it is ink. */
    static final class Gray {
        final int[] lum;
        final int w, h;
        final int threshold;
        /** Light letters on a dark ground, as sound effects often are. */
        final boolean light;

        Gray(int[] lum, int w, int h) {
            this.lum = lum;
            this.w = w;
            this.h = h;
            int[] hist = new int[256];
            for (int v : lum) hist[Math.max(0, Math.min(255, v))]++;
            threshold = otsu(hist, lum.length);
            int dark = 0;
            for (int v : lum) if (v < threshold) dark++;
            // The letters are the lesser part of a patch cut close round them.
            light = dark > lum.length * 0.6;
        }

        boolean ink(int x, int y) {
            int v = lum[y * w + x];
            return light ? v >= threshold : v < threshold;
        }

        /** Brightness from packed ARGB pixels. */
        static Gray of(int[] argb, int w, int h) {
            int[] lum = new int[argb.length];
            for (int i = 0; i < argb.length; i++) {
                int c = argb[i];
                lum[i] = (((c >> 16) & 255) * 299 + ((c >> 8) & 255) * 587 + (c & 255) * 114) / 1000;
            }
            return new Gray(lum, w, h);
        }
    }

    /** One character's square, in the column it was cut from. */
    static final class Cell {
        int top, bottom;            // rows within the column's patch
        int inkLeft, inkRight;      // the ink's own extent across
        int pieces;                 // how many separate runs of ink it was made of
        /** A long-vowel bar or a vertical ellipsis: drawn turned, these are
         *  their horizontal selves (ー, …), not a stroke the recogniser
         *  would take for l or 1. */
        boolean turn;
        /** Small kana and punctuation: kept small, and set on the line's
         *  foot as they would be in horizontal type. */
        boolean small;

        int height() { return bottom - top; }
        int inkWidth() { return inkRight - inkLeft + 1; }
    }

    static int otsu(int[] hist, int total) {
        long sum = 0;
        for (int i = 0; i < 256; i++) sum += (long) i * hist[i];
        long sumB = 0;
        long wB = 0;
        double best = -1;
        int t = 128;
        for (int i = 0; i < 256; i++) {
            wB += hist[i];
            if (wB == 0) continue;
            long wF = total - wB;
            if (wF == 0) break;
            sumB += (long) i * hist[i];
            double mB = sumB / (double) wB;
            double mF = (sum - sumB) / (double) wF;
            double between = (double) wB * wF * (mB - mF) * (mB - mF);
            if (between > best) {
                best = between;
                t = i + 1;
            }
        }
        return t;
    }

    /** The recogniser's lines, gathered into columns: whatever stands in the
     *  same strip of the page belongs to the same column. */
    static List<Box> columnsOf(List<Box> units) {
        List<Box> cols = new ArrayList<>();
        for (Box u : units) cols.add(u.copy());
        boolean merged = true;
        while (merged) {
            merged = false;
            search:
            for (int i = 0; i < cols.size(); i++) {
                for (int j = i + 1; j < cols.size(); j++) {
                    Box a = cols.get(i);
                    Box b = cols.get(j);
                    int overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                    if (overlap > 0.5f * Math.min(a.width(), b.width())) {
                        a.union(b);
                        cols.remove(j);
                        merged = true;
                        break search;
                    }
                }
            }
        }
        return cols;
    }

    /** Mostly columns, standing taller than they are wide. */
    static boolean looksVertical(List<Box> columns) {
        long all = 0;
        long tall = 0;
        boolean anyLong = false;
        for (Box c : columns) {
            long area = (long) c.width() * c.height();
            all += area;
            if (c.height() >= c.width() * 1.6f) tall += area;
            if (c.height() >= c.width() * 2f) anyLong = true;
        }
        return all > 0 && anyLong && tall >= all * 0.6;
    }

    /** How wide a character's square is: the width of the body columns,
     *  leaving out the ruby beside them. */
    static float emOf(List<Box> columns) {
        int widest = 0;
        for (Box c : columns) widest = Math.max(widest, c.width());
        List<Integer> widths = new ArrayList<>();
        for (Box c : columns) if (c.width() >= widest * 0.6f) widths.add(c.width());
        if (widths.isEmpty()) return widest;
        Collections.sort(widths);
        return widths.get(widths.size() / 2);
    }

    /** The columns of the text itself: ruby (the small reading beside a
     *  kanji) is half the width or less, and is left out. */
    static List<Box> withoutRuby(List<Box> columns, float em) {
        List<Box> body = new ArrayList<>();
        for (Box c : columns) if (c.width() >= em * 0.55f) body.add(c);
        return body.isEmpty() ? columns : body;
    }

    /** Right to left, as the columns are read. */
    static void inReadingOrder(List<Box> columns) {
        Collections.sort(columns, (a, b) -> Float.compare(b.centreX(), a.centreX()));
    }

    /**
     * A patch the recogniser took for one column, cut into the columns it
     * really is, each trimmed to its ink. Two columns side by side often
     * come back as one line; a column of い does not become two, because
     * the pieces of a real column are cut into characters about as tall as
     * they are wide, and the halves of い are not.
     *
     * @return boxes relative to the patch
     */
    static List<Box> split(Gray g) {
        List<Box> pieces = new ArrayList<>();
        int[] colInk = new int[g.w];
        for (int y = 0; y < g.h; y++) for (int x = 0; x < g.w; x++) if (g.ink(x, y)) colInk[x]++;
        int empty = Math.max(1, Math.round(g.h * 0.015f));
        int x = 0;
        List<int[]> runs = new ArrayList<>();
        while (x < g.w) {
            if (colInk[x] > empty) {
                int start = x;
                while (x < g.w && colInk[x] > empty) x++;
                runs.add(new int[] { start, x });
            } else x++;
        }
        if (runs.isEmpty()) return pieces;
        // Gaps narrower than a sliver are inside a character, not between columns.
        int minGap = Math.max(2, Math.round(g.w * 0.03f));
        List<int[]> merged = new ArrayList<>();
        for (int[] run : runs) {
            if (!merged.isEmpty() && run[0] - merged.get(merged.size() - 1)[1] < minGap) merged.get(merged.size() - 1)[1] = run[1];
            else merged.add(run);
        }
        List<Box> candidate = new ArrayList<>();
        for (int[] run : merged) {
            if (run[1] - run[0] < Math.max(2, g.w * 0.08f)) continue;
            Box b = trim(g, new Box(run[0], 0, run[1], g.h));
            if (b != null) candidate.add(b);
        }
        if (candidate.size() <= 1) {
            Box whole = trim(g, new Box(0, 0, g.w, g.h));
            if (whole != null) pieces.add(whole);
            return pieces;
        }
        // Each piece must cut into characters roughly square.
        for (Box b : candidate) {
            List<int[]> runsDown = rowRuns(g, b);
            if (runsDown.isEmpty()) continue;
            List<Integer> heights = new ArrayList<>();
            for (int[] r : runsDown) heights.add(r[1] - r[0]);
            Collections.sort(heights);
            float ratio = heights.get(heights.size() / 2) / (float) Math.max(1, b.width());
            if (ratio > 1.7f && b.height() > b.width() * 3) {
                // Long strokes, not characters: one column after all.
                Box whole = trim(g, new Box(0, 0, g.w, g.h));
                if (whole != null) pieces.add(whole);
                return pieces;
            }
        }
        return candidate;
    }

    /** The box shrunk to the ink inside it, or null if there is none. */
    static Box trim(Gray g, Box b) {
        int l = Integer.MAX_VALUE, t = Integer.MAX_VALUE, r = -1, bt = -1;
        for (int y = b.top; y < b.bottom; y++) {
            for (int x = b.left; x < b.right; x++) {
                if (!g.ink(x, y)) continue;
                if (x < l) l = x;
                if (x > r) r = x;
                if (y < t) t = y;
                if (y > bt) bt = y;
            }
        }
        if (r < 0) return null;
        return new Box(l, t, r + 1, bt + 1);
    }

    /** Runs of rows with ink in them, within a box. */
    static List<int[]> rowRuns(Gray g, Box b) {
        List<int[]> runs = new ArrayList<>();
        int need = Math.max(1, Math.round(b.width() * 0.04f));
        int y = b.top;
        while (y < b.bottom) {
            if (rowInk(g, b, y) >= need) {
                int start = y;
                while (y < b.bottom && rowInk(g, b, y) >= need) y++;
                if (y - start >= 2) runs.add(new int[] { start, y });
            } else y++;
        }
        return runs;
    }

    private static int rowInk(Gray g, Box b, int y) {
        int n = 0;
        for (int x = b.left; x < b.right; x++) if (g.ink(x, y)) n++;
        return n;
    }

    /**
     * A column (the whole patch) cut into its characters, top to bottom.
     *
     * @param em  the width of a character's square, in the patch's pixels
     */
    static List<Cell> cells(Gray g, float em) {
        Box all = new Box(0, 0, g.w, g.h);
        List<int[]> runs = rowRuns(g, all);
        List<Cell> cells = new ArrayList<>();
        if (runs.isEmpty() || em <= 0) return cells;

        // Typeset text first: it stands on a grid of squares.
        List<int[]> grid = grid(g, em);
        if (grid != null) {
            for (int[] square : grid) {
                Cell cell = cellOf(g, square[0], square[1], em);
                if (cell != null) cells.add(cell);
            }
            return cells;
        }

        // A run much taller than a square is characters touching: cut it
        // where the ink is thinnest, near each square's edge.
        List<int[]> segs = new ArrayList<>();
        for (int[] run : runs) {
            int h = run[1] - run[0];
            if (h <= em * 1.35f) { segs.add(run); continue; }
            int k = Math.max(2, Math.round(h / em));
            int prev = run[0];
            int reach = Math.max(1, Math.round(em * 0.25f));
            for (int i = 1; i < k; i++) {
                int target = run[0] + Math.round(i * h / (float) k);
                int best = target;
                int least = Integer.MAX_VALUE;
                for (int y = Math.max(prev + 1, target - reach); y <= Math.min(run[1] - 1, target + reach); y++) {
                    int ink = rowInk(g, all, y);
                    if (ink < least) { least = ink; best = y; }
                }
                segs.add(new int[] { prev, best });
                prev = best;
            }
            segs.add(new int[] { prev, run[1] });
        }

        // Lettering drawn by hand is often taller than it is wide, so the
        // square is tried at a few heights, and the one the column fits best
        // is kept: typeset text fits the width itself.
        List<int[]> groups = null;
        double fit = Double.MAX_VALUE;
        for (float stretch : new float[] { 1f, 1.15f, 1.3f, 1.5f }) {
            float pitch = em * stretch;
            List<int[]> tried = group(segs, pitch);
            double off = 0;
            int full = 0;
            for (int[] gr : tried) {
                int h = segs.get(gr[1] - 1)[1] - segs.get(gr[0])[0];
                if (h < pitch * 0.6f) continue;
                off += Math.abs(pitch - h) / pitch;
                full++;
            }
            // Lightly against stretching, so that typeset text keeps its square.
            double score = full == 0 ? Double.MAX_VALUE : off / full + (stretch - 1f) * 0.15;
            if (score < fit) {
                fit = score;
                groups = tried;
            }
        }
        if (groups == null) groups = group(segs, em);

        for (int[] group : groups) {
            Cell cell = new Cell();
            cell.top = segs.get(group[0])[0];
            cell.bottom = segs.get(group[1] - 1)[1];
            cell.pieces = group[1] - group[0];
            int l = g.w, r = -1;
            for (int y = cell.top; y < cell.bottom; y++) {
                for (int x = 0; x < g.w; x++) {
                    if (!g.ink(x, y)) continue;
                    if (x < l) l = x;
                    if (x > r) r = x;
                }
            }
            if (r < 0) continue;
            cell.inkLeft = l;
            cell.inkRight = r;
            boolean dots = cell.pieces >= 3;
            for (int s = group[0]; s < group[1] && dots; s++) {
                if (segs.get(s)[1] - segs.get(s)[0] >= em * 0.22f) dots = false;
            }
            boolean narrow = cell.inkWidth() < em * 0.3f;
            cell.turn = (narrow && ((cell.pieces == 1 && cell.height() >= em * 0.6f) || dots))
                    || cornerBracket(g, cell, em);
            cell.small = !cell.turn && cell.height() < em * 0.55f && cell.inkWidth() < em * 0.7f;
            cells.add(cell);
        }
        return cells;
    }

    /**
     * The squares of typeset text: the pitch and starting point at which the
     * cuts between squares run through the least ink. Each character of
     * typeset Japanese or Chinese takes one square, small kana and
     * punctuation included, so a ？ is cut with its dot and a 」 is a
     * square of its own. Lettering drawn by hand keeps to no grid; then the
     * cuts cannot avoid the ink, and this answers null.
     *
     * @return [top, bottom) of each square with ink in it
     */
    static List<int[]> grid(Gray g, float width) {
        int[] rowInk = new int[g.h];
        for (int y = 0; y < g.h; y++) for (int x = 0; x < g.w; x++) if (g.ink(x, y)) rowInk[y]++;
        float bestCost = Float.MAX_VALUE;
        float bestPitch = 0;
        int bestPhase = 0;
        float step = Math.max(0.5f, width * 0.01f);
        for (float pitch = width * 0.95f; pitch <= width * 1.3f; pitch += step) {
            if (g.h < pitch * 1.5f) return null;      // a single character: nothing to cut
            int reach = Math.max(1, Math.round(pitch * 0.04f));
            for (int phase = -Math.round(pitch) + 1; phase <= 0; phase++) {
                long ink = 0;
                int cuts = 0;
                for (float c = phase + pitch; c < g.h - reach; c += pitch) {
                    int at = Math.round(c);
                    for (int y = Math.max(0, at - reach); y <= Math.min(g.h - 1, at + reach); y++) ink += rowInk[y];
                    cuts++;
                }
                if (cuts == 0) continue;
                float cost = ink / (float) (cuts * (2 * reach + 1) * g.w);
                if (cost < bestCost - 1e-6f) {
                    bestCost = cost;
                    bestPitch = pitch;
                    bestPhase = phase;
                }
            }
        }
        // A grid that cuts ink is no grid.
        if (bestPitch == 0 || bestCost > 0.02f) return null;
        List<int[]> squares = new ArrayList<>();
        for (float top = bestPhase; top < g.h; top += bestPitch) {
            int a = Math.max(0, Math.round(top));
            int b = Math.min(g.h, Math.round(top + bestPitch));
            boolean any = false;
            for (int y = a; y < b && !any; y++) any = rowInk[y] > 0;
            if (any) squares.add(new int[] { a, b });
        }
        return squares;
    }

    /** One square of the grid as a character, trimmed to its ink. */
    private static Cell cellOf(Gray g, int from, int to, float em) {
        int l = g.w, r = -1, t = -1, b = -1;
        for (int y = from; y < to; y++) {
            for (int x = 0; x < g.w; x++) {
                if (!g.ink(x, y)) continue;
                if (x < l) l = x;
                if (x > r) r = x;
                if (t < 0) t = y;
                b = y + 1;
            }
        }
        if (r < 0) return null;
        Cell cell = new Cell();
        cell.top = t;
        cell.bottom = b;
        cell.inkLeft = l;
        cell.inkRight = r;
        List<int[]> runs = rowRuns(g, new Box(0, t, g.w, b));
        cell.pieces = Math.max(1, runs.size());
        boolean dots = cell.pieces >= 3;
        for (int[] run : runs) if (run[1] - run[0] >= em * 0.22f) dots = false;
        boolean narrow = cell.inkWidth() < em * 0.3f;
        cell.turn = (narrow && ((cell.pieces == 1 && cell.height() >= em * 0.6f) || dots))
                || cornerBracket(g, cell, em);
        cell.small = !cell.turn && cell.height() < em * 0.55f && cell.inkWidth() < em * 0.7f;
        return cell;
    }

    /**
     * Runs put back together into characters. Cheapest grouping wins: each
     * character costs a little, and costs more the further it is from the
     * pitch; nothing taller than a pitch and a quarter, and no gap inside a
     * character wider than half of one.
     *
     * @return [first run, run after the last) for each character
     */
    static List<int[]> group(List<int[]> segs, float em) {
        int n = segs.size();
        double[] best = new double[n + 1];
        int[] from = new int[n + 1];
        java.util.Arrays.fill(best, Double.MAX_VALUE);
        best[0] = 0;
        for (int i = 1; i <= n; i++) {
            int maxGap = 0;
            for (int j = i - 1; j >= 0; j--) {
                if (j < i - 1) maxGap = Math.max(maxGap, segs.get(j + 1)[0] - segs.get(j)[1]);
                int h = segs.get(i - 1)[1] - segs.get(j)[0];
                if (j < i - 1 && (h > em * 1.25f || maxGap > em * 0.5f)) break;
                if (best[j] == Double.MAX_VALUE) continue;
                double cost = best[j] + Math.abs(em - h) / em + 0.35;
                if (cost < best[i]) {
                    best[i] = cost;
                    from[i] = j;
                }
            }
        }
        List<int[]> groups = new ArrayList<>();
        for (int i = n; i > 0; i = from[i]) groups.add(0, new int[] { from[i], i });
        return groups;
    }

    /* ── the whole of it ─────────────────────────────────────────────── */

    /** Where the picture's pixels come from: a Bitmap on the phone, an
     *  image file off it. */
    interface Pixels {
        int width();
        int height();
        /** Packed ARGB, row by row, for the box. */
        int[] argb(Box box);
    }

    /** One character, from where in the picture to where on the sheet. */
    static final class Placement {
        Box src;
        float x, y, w, h;       // on the sheet; for a turned one, before turning
        boolean turn;
    }

    /** One line of the sheet, and the column it came from. */
    static final class Row {
        int column;
        float top, bottom;
        boolean light;
    }

    /** The columns, set out as lines on a sheet to be read. */
    static final class Sheet {
        int width, height;
        int columns;
        final List<Placement> placed = new ArrayList<>();
        final List<Row> rows = new ArrayList<>();
    }

    /** Characters on one sheet line, at most. A line much longer than this is
     *  scaled down by the recogniser until its characters are too small. */
    static final int PER_ROW = 14;
    /** The height a character is set at on the sheet, in pixels. */
    static final float EM_PIXELS = 72f;

    /**
     * The sheet for one block of text, or null when it is not set in columns.
     *
     * @param units the recogniser's lines for the block, in picture pixels
     */
    static Sheet layout(Pixels picture, List<Box> units) {
        List<Box> found = new ArrayList<>();
        for (Box u : columnsOf(clamp(units, picture))) {
            if (u.width() < 2 || u.height() < 2) continue;
            Gray g = Gray.of(picture.argb(u), u.width(), u.height());
            for (Box piece : split(g)) {
                found.add(new Box(u.left + piece.left, u.top + piece.top, u.left + piece.right, u.top + piece.bottom));
            }
        }
        if (found.isEmpty() || !looksVertical(found)) return null;
        float em = emOf(found);
        if (em < 4) return null;
        List<Box> body = withoutRuby(found, em);
        inReadingOrder(body);

        float scale = Math.max(0.5f, Math.min(4f, EM_PIXELS / em));
        int pad = Math.max(1, Math.round(em * 0.06f));
        int widest = 0;
        for (Box c : body) widest = Math.max(widest, c.width());
        float slot = (widest + pad * 2) * scale + em * scale * 0.15f;
        float rowHeight = em * scale * 1.8f;
        float margin = em * scale * 0.8f;

        Sheet sheet = new Sheet();
        sheet.columns = body.size();
        int longest = 0;
        for (int c = 0; c < body.size(); c++) {
            Box col = body.get(c);
            Gray g = Gray.of(picture.argb(col), col.width(), col.height());
            List<Cell> cells = cells(g, em);
            for (int start = 0; start < cells.size(); start += PER_ROW) {
                int end = Math.min(cells.size(), start + PER_ROW);
                Row row = new Row();
                row.column = c;
                row.light = g.light;
                row.top = margin + sheet.rows.size() * rowHeight;
                row.bottom = row.top + rowHeight;
                float cy = (row.top + row.bottom) / 2f;
                float baseline = cy + em * scale * 0.5f;
                for (int k = start; k < end; k++) {
                    Cell cell = cells.get(k);
                    Placement p = new Placement();
                    // A turned one is cut close round its ink, so that it
                    // lies along the middle of the line once turned.
                    int from = cell.turn ? col.left + cell.inkLeft : col.left;
                    int to = cell.turn ? col.left + cell.inkRight + 1 : col.right;
                    p.src = new Box(Math.max(0, from - pad), col.top + cell.top,
                            Math.min(picture.width(), to + pad), col.top + cell.bottom);
                    p.w = p.src.width() * scale;
                    p.h = p.src.height() * scale;
                    float cx = margin + (k - start) * slot + slot / 2f;
                    p.x = cx - p.w / 2f;
                    p.y = cell.small ? baseline - p.h : cy - p.h / 2f;
                    p.turn = cell.turn;
                    sheet.placed.add(p);
                }
                longest = Math.max(longest, end - start);
                sheet.rows.add(row);
            }
        }
        if (sheet.rows.isEmpty()) return null;
        sheet.width = Math.round(margin * 2 + longest * slot);
        sheet.height = Math.round(margin * 2 + sheet.rows.size() * rowHeight);
        return sheet;
    }

    private static List<Box> clamp(List<Box> units, Pixels picture) {
        List<Box> out = new ArrayList<>();
        for (Box u : units) {
            Box b = new Box(Math.max(0, u.left), Math.max(0, u.top),
                    Math.min(picture.width(), u.right), Math.min(picture.height(), u.bottom));
            if (b.width() > 0 && b.height() > 0) out.add(b);
        }
        return out;
    }

    /** A line the recogniser read off the sheet. */
    static final class Read {
        final String text;
        final Box box;
        Read(String text, Box box) { this.text = text; this.box = box; }
    }

    /** What the recogniser read off the sheet, back into the columns it came
     *  from, in the order they are read. */
    static List<String> columnTexts(Sheet sheet, List<Read> lines) {
        List<List<Read>> perRow = new ArrayList<>();
        for (int i = 0; i < sheet.rows.size(); i++) perRow.add(new ArrayList<>());
        for (Read line : lines) {
            if (line.box == null || line.text == null) continue;
            float cy = (line.box.top + line.box.bottom) / 2f;
            int best = -1;
            float nearest = Float.MAX_VALUE;
            for (int i = 0; i < sheet.rows.size(); i++) {
                Row row = sheet.rows.get(i);
                float d = cy < row.top ? row.top - cy : cy > row.bottom ? cy - row.bottom : 0;
                if (d < nearest) { nearest = d; best = i; }
            }
            if (best >= 0) perRow.get(best).add(line);
        }
        String[] columns = new String[sheet.columns];
        for (int i = 0; i < columns.length; i++) columns[i] = "";
        for (int i = 0; i < perRow.size(); i++) {
            List<Read> row = perRow.get(i);
            Collections.sort(row, (a, b) -> Integer.compare(a.box.left, b.box.left));
            StringBuilder text = new StringBuilder();
            for (Read r : row) text.append(r.text);
            columns[sheet.rows.get(i).column] += tidy(text.toString());
        }
        List<String> out = new ArrayList<>();
        for (String c : columns) if (!c.isEmpty()) out.add(c);
        return out;
    }

    /**
     * The corner brackets of vertical type, ﹁ and ﹂: a bar along one end
     * and a stroke down the far side, and nothing along the other two. They
     * are 「 and 」 turned a quarter, and are turned back. (コ has a bar at
     * both ends; フ's stroke leans, and never runs straight down one side.)
     */
    static boolean cornerBracket(Gray g, Cell cell, float em) {
        int w = cell.inkWidth();
        int h = cell.height();
        if (w < 4 || h < 4) return false;
        // The vertical forms are wide and short, half a square tall at
        // most: ヒ is a stroke down and a bar along the foot too, but as
        // tall as any character.
        if (h > em * 0.62f) return false;
        int ink = 0;
        for (int y = cell.top; y < cell.bottom; y++)
            for (int x = cell.inkLeft; x <= cell.inkRight; x++) if (g.ink(x, y)) ink++;
        if (ink > w * h * 0.5f) return false;
        int band = Math.max(1, Math.round(h * 0.25f));
        int side = Math.max(1, Math.round(w * 0.25f));
        boolean barTop = barIn(g, cell, cell.top, cell.top + band, 0.75f);
        boolean barBottom = barIn(g, cell, cell.bottom - band, cell.bottom, 0.75f);
        boolean right = stemIn(g, cell, cell.inkRight + 1 - side, cell.inkRight + 1, 0.8f);
        boolean left = stemIn(g, cell, cell.inkLeft, cell.inkLeft + side, 0.8f);
        boolean opening = barTop && right && !barBottom && !left
                && !barIn(g, cell, cell.bottom - band, cell.bottom, 0.5f)
                && !stemIn(g, cell, cell.inkLeft, cell.inkLeft + side, 0.5f);
        boolean closing = barBottom && left && !barTop && !right
                && !barIn(g, cell, cell.top, cell.top + band, 0.5f)
                && !stemIn(g, cell, cell.inkRight + 1 - side, cell.inkRight + 1, 0.5f);
        return opening || closing;
    }

    /** A row within [from, to) inked across this much of the cell. */
    private static boolean barIn(Gray g, Cell cell, int from, int to, float share) {
        int need = Math.round(cell.inkWidth() * share);
        for (int y = Math.max(cell.top, from); y < Math.min(cell.bottom, to); y++) {
            int n = 0;
            for (int x = cell.inkLeft; x <= cell.inkRight; x++) if (g.ink(x, y)) n++;
            if (n >= need) return true;
        }
        return false;
    }

    /** A column within [from, to) inked down this much of the cell. */
    private static boolean stemIn(Gray g, Cell cell, int from, int to, float share) {
        int need = Math.round(cell.height() * share);
        for (int x = Math.max(cell.inkLeft, from); x < Math.min(cell.inkRight + 1, to); x++) {
            int n = 0;
            for (int y = cell.top; y < cell.bottom; y++) if (g.ink(x, y)) n++;
            if (n >= need) return true;
        }
        return false;
    }

    /** Vertical forms of punctuation, as their ordinary selves. */
    static String tidy(String text) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case ' ': case '　': case '\n': break;
                case '︙': out.append('…'); break;          // ︙
                case '︰': out.append('‥'); break;          // ︰
                case '﹁': out.append('「'); break;
                case '﹂': out.append('」'); break;
                case '﹃': out.append('『'); break;
                case '﹄': out.append('』'); break;
                case '︵': out.append('（'); break;
                case '︶': out.append('）'); break;
                case '︑': out.append('、'); break;
                case '︒': out.append('。'); break;
                case '|': case '｜': case '丨': out.append('ー'); break;
                default: out.append(c);
            }
        }
        return out.toString();
    }
}
