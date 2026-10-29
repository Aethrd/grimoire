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

        /** With the threshold and polarity already known (a part of a
         *  patch, or a patch cleaned). */
        Gray(int[] lum, int w, int h, int threshold, boolean light) {
            this.lum = lum;
            this.w = w;
            this.h = h;
            this.threshold = threshold;
            this.light = light;
        }

        boolean ink(int x, int y) {
            int v = lum[y * w + x];
            return light ? v >= threshold : v < threshold;
        }

        /** A box of this patch, as a patch of its own. */
        Gray part(Box b) {
            int[] out = new int[b.width() * b.height()];
            for (int y = 0; y < b.height(); y++) System.arraycopy(lum, (b.top + y) * w + b.left, out, y * b.width(), b.width());
            return new Gray(out, b.width(), b.height(), threshold, light);
        }

        /** Brightness from packed ARGB pixels. */
        static Gray of(int[] argb, int w, int h) {
            return new Gray(lumOf(argb), w, h);
        }

        static int[] lumOf(int[] argb) {
            int[] lum = new int[argb.length];
            for (int i = 0; i < argb.length; i++) {
                int c = argb[i];
                lum[i] = (((c >> 16) & 255) * 299 + ((c >> 8) & 255) * 587 + (c & 255) * 114) / 1000;
            }
            return lum;
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

    /**
     * Which of a patch's ink is lettering.
     *
     * Narration is often set straight over the drawing -- hair, speed lines,
     * a bubble's outline, screentone -- and that ink fills the gaps between
     * columns. Lettering comes in pieces no bigger than a character; the
     * drawing's lines run on far longer, and screentone is dots far smaller.
     * So the ink is taken apart into its connected pieces and only those of
     * a character's size are kept, with a pixel round each for the soft
     * edge of the strokes.
     *
     * @param em about the size of a character, or 0 when not known
     */
    static boolean[] lettering(Gray g, float em) {
        int n = g.w * g.h;
        boolean[] keep = new boolean[n];
        boolean[] seen = new boolean[n];
        int[] stack = new int[n];
        // Pieces are made of strong ink only: lettering is near black (near
        // white, for light letters), and grey lines of the drawing that run
        // through it -- seen through a bubble, or a screentone -- then do
        // not join it to the drawing. Its soft edges are put back after.
        // (Dark grey lettering on a pale ground counts: strong is judged
        // against the page's own threshold.)
        int strongDark = Math.min(g.threshold, Math.max(110, Math.round(g.threshold * 0.7f)));
        int strongLight = Math.max(g.threshold, 185);
        boolean[] ink = new boolean[n];
        for (int i = 0; i < n; i++) ink[i] = g.light ? g.lum[i] >= strongLight : g.lum[i] <= strongDark;
        float big = em > 0 ? em * 2.5f : Float.MAX_VALUE;
        // Smaller than a dot of an ellipsis: grey screentone is not strong
        // ink to begin with, so what is left this small is all specks.
        float speck = em > 0 ? Math.max(1.5f, em * 0.07f) : 1.5f;
        // ...but only where the drawing round about is grey. The pieces of
        // all the ink, grey and strong, are found first: one far bigger than
        // a character that is mostly strong ink is the drawing's own black
        // (hatching, hair, a shadow), and what is strong in it is not
        // lettering however it breaks apart.
        int[] parent = new int[n];
        java.util.Arrays.fill(parent, -1);
        List<Boolean> blackDrawing = new ArrayList<>();
        for (int start = 0; start < n; start++) {
            if (parent[start] >= 0 || !g.ink(start % g.w, start / g.w)) continue;
            int label = blackDrawing.size();
            int top = 0, count = 0, strong = 0;
            stack[top++] = start;
            parent[start] = label;
            int l = g.w, r = -1, t = g.h, b = -1;
            while (top > 0) {
                int at = stack[--top];
                count++;
                if (ink[at]) strong++;
                int x = at % g.w, y = at / g.w;
                if (x < l) l = x;
                if (x > r) r = x;
                if (y < t) t = y;
                if (y > b) b = y;
                for (int dy = -1; dy <= 1; dy++) {
                    int yy = y + dy;
                    if (yy < 0 || yy >= g.h) continue;
                    for (int dx = -1; dx <= 1; dx++) {
                        int xx = x + dx;
                        if (xx < 0 || xx >= g.w) continue;
                        int next = yy * g.w + xx;
                        if (parent[next] >= 0 || !g.ink(xx, yy)) continue;
                        parent[next] = label;
                        stack[top++] = next;
                    }
                }
            }
            boolean huge = r - l + 1 > big || b - t + 1 > big;
            blackDrawing.add(huge && strong > count * 0.6f);
        }
        int[] members = new int[n];
        for (int start = 0; start < n; start++) {
            if (seen[start] || !ink[start]) continue;
            int top = 0;
            int count = 0;
            stack[top++] = start;
            seen[start] = true;
            int l = g.w, r = -1, t = g.h, b = -1;
            int core = g.light ? 0 : 255;
            while (top > 0) {
                int at = stack[--top];
                members[count++] = at;
                int v = g.lum[at];
                core = g.light ? Math.max(core, v) : Math.min(core, v);
                int x = at % g.w;
                int y = at / g.w;
                if (x < l) l = x;
                if (x > r) r = x;
                if (y < t) t = y;
                if (y > b) b = y;
                for (int dy = -1; dy <= 1; dy++) {
                    int yy = y + dy;
                    if (yy < 0 || yy >= g.h) continue;
                    for (int dx = -1; dx <= 1; dx++) {
                        int xx = x + dx;
                        if (xx < 0 || xx >= g.w) continue;
                        int next = yy * g.w + xx;
                        if (seen[next] || !ink[next]) continue;
                        seen[next] = true;
                        stack[top++] = next;
                    }
                }
            }
            int bw = r - l + 1;
            int bh = b - t + 1;
            if (bw > big || bh > big) {                      // the drawing
                // ...unless there are letters in it: black letters in a white
                // halo on a black ground touch the ground, and come out as
                // one piece with it.
                if (em > 0 && !g.light) lettersIn(g, members, count, l, t, r, b, em, keep);
                continue;
            }
            if (Math.max(bw, bh) < speck) continue;           // screentone
            if (parent[members[0]] >= 0 && blackDrawing.get(parent[members[0]])) continue;
            // Lettering is inked solid: every stroke has a black core (a
            // white one, for light letters). Shading and the specks at the
            // edge of a gradient are grey all through.
            if (g.light ? core < Math.max(185, 255 - (255 - g.threshold) * 0.55f)
                        : core > Math.min(75, g.threshold * 0.55f)) continue;
            // A patch of solid black the size of a character is shadow, not
            // strokes (ー is solid too, but thin).
            // (Bold kanji -- 警, 最 -- are dense, but not this dense.)
            if (em > 0 && count > bw * bh * 0.8f && Math.min(bw, bh) > em * 0.35f) continue;
            // Cut by the patch's edge: the drawing runs on past it, and the
            // patch was taken wide enough that the lettering does not.
            if (l == 0 || t == 0 || r == g.w - 1 || b == g.h - 1) continue;
            for (int i = 0; i < count; i++) keep[members[i]] = true;
        }
        boolean[] grown = new boolean[n];
        for (int y = 0; y < g.h; y++) {
            for (int x = 0; x < g.w; x++) {
                if (!keep[y * g.w + x]) continue;
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                    int xx = x + dx, yy = y + dy;
                    if (xx >= 0 && xx < g.w && yy >= 0 && yy < g.h) grown[yy * g.w + xx] = true;
                }
            }
        }
        return grown;
    }

    /**
     * The letters inside one great piece of ink: what is left of it once its
     * solid parts (and a rim round them) are taken away, kept where it is a
     * character's size and stands mostly in light -- touching the solid
     * only at its tips, as letters in a halo do. Scraps of the drawing left
     * the same way lie along the solid, and are not kept.
     */
    private static void lettersIn(Gray g, int[] members, int count, int l, int t, int r, int b,
                                  float em, boolean[] keep) {
        int w = r - l + 1;
        int h = b - t + 1;
        boolean[] piece = new boolean[w * h];
        for (int i = 0; i < count; i++) {
            int at = members[i];
            piece[(at / g.w - t) * w + (at % g.w - l)] = true;
        }
        int k = Math.max(1, Math.round(em * 0.15f));
        boolean[] solid = boxAll(piece, w, h, k);
        if (!any(solid)) return;
        boolean[] near = boxAny(solid, w, h, k + 1);
        boolean[] rest = new boolean[w * h];
        for (int i = 0; i < rest.length; i++) rest[i] = piece[i] && !near[i];
        boolean[] seen = new boolean[w * h];
        int[] stack = new int[w * h];
        int[] found = new int[w * h];
        for (int start = 0; start < rest.length; start++) {
            if (!rest[start] || seen[start]) continue;
            int top = 0, n = 0;
            stack[top++] = start;
            seen[start] = true;
            int pl = w, pr = -1, pt = h, pb = -1;
            int core = 255;
            while (top > 0) {
                int at = stack[--top];
                found[n++] = at;
                int x = at % w, y = at / w;
                pl = Math.min(pl, x); pr = Math.max(pr, x); pt = Math.min(pt, y); pb = Math.max(pb, y);
                core = Math.min(core, g.lum[(y + t) * g.w + x + l]);
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                    int xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                    int next = yy * w + xx;
                    if (seen[next] || !rest[next]) continue;
                    seen[next] = true;
                    stack[top++] = next;
                }
            }
            int pw = pr - pl + 1, ph = pb - pt + 1;
            if (pw > em * 1.3f || ph > em * 1.3f) continue;
            if (Math.max(pw, ph) < em * 0.15f) continue;
            if (core > 75) continue;
            // Strokes, not a patch: a letter inks well under half its box.
            if (n > pw * ph * 0.65f) continue;
            // How much of what lies round it is the solid's rim.
            int ring = 0, rim = 0;
            for (int y = Math.max(0, pt - 2); y <= Math.min(h - 1, pb + 2); y++) {
                for (int x = Math.max(0, pl - 2); x <= Math.min(w - 1, pr + 2); x++) {
                    int i = y * w + x;
                    if (rest[i]) continue;
                    ring++;
                    if (near[i]) rim++;
                }
            }
            if (rim > ring * 0.2f) continue;
            for (int i = 0; i < n; i++) {
                int x = found[i] % w, y = found[i] / w;
                keep[(y + t) * g.w + x + l] = true;
            }
        }
    }

    private static boolean any(boolean[] mask) {
        for (boolean v : mask) if (v) return true;
        return false;
    }

    /** Where every pixel of the (2r+1)-square round a point is set. */
    static boolean[] boxAll(boolean[] mask, int w, int h, int r) {
        int[] sum = integral(mask, w, h);
        boolean[] out = new boolean[w * h];
        int area = (2 * r + 1) * (2 * r + 1);
        for (int y = r; y < h - r; y++) {
            for (int x = r; x < w - r; x++) {
                if (boxSum(sum, w, x - r, y - r, x + r + 1, y + r + 1) == area) out[y * w + x] = true;
            }
        }
        return out;
    }

    /** Where any pixel of the (2r+1)-square round a point is set. */
    static boolean[] boxAny(boolean[] mask, int w, int h, int r) {
        int[] sum = integral(mask, w, h);
        boolean[] out = new boolean[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int l = Math.max(0, x - r), t = Math.max(0, y - r);
                int rr = Math.min(w, x + r + 1), b = Math.min(h, y + r + 1);
                if (boxSum(sum, w, l, t, rr, b) > 0) out[y * w + x] = true;
            }
        }
        return out;
    }

    private static int[] integral(boolean[] mask, int w, int h) {
        int[] sum = new int[(w + 1) * (h + 1)];
        for (int y = 0; y < h; y++) {
            int row = 0;
            for (int x = 0; x < w; x++) {
                if (mask[y * w + x]) row++;
                sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
            }
        }
        return sum;
    }

    private static int boxSum(int[] sum, int w, int l, int t, int r, int b) {
        int stride = w + 1;
        return sum[b * stride + r] - sum[t * stride + r] - sum[b * stride + l] + sum[t * stride + l];
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

    /** In the order they are read: columns standing side by side (at about
     *  the same height) right to left; one group of them above another, the
     *  upper first. */
    static void inReadingOrder(List<Box> columns) {
        List<Box> byTop = new ArrayList<>(columns);
        Collections.sort(byTop, (a, b) -> Integer.compare(a.top, b.top));
        List<List<Box>> rows = new ArrayList<>();
        for (Box c : byTop) {
            List<Box> home = null;
            for (List<Box> row : rows) {
                for (Box other : row) {
                    int overlap = Math.min(other.bottom, c.bottom) - Math.max(other.top, c.top);
                    if (overlap >= Math.min(other.height(), c.height()) / 3f) { home = row; break; }
                }
                if (home != null) break;
            }
            if (home == null) { home = new ArrayList<>(); rows.add(home); }
            home.add(c);
        }
        columns.clear();
        for (List<Box> row : rows) {
            Collections.sort(row, (a, b) -> Float.compare(b.centreX(), a.centreX()));
            columns.addAll(row);
        }
    }

    /**
     * The columns of text in a patch of the picture.
     *
     * Found by where the ink is dense, across: a column of characters inks
     * most of the rows it stands in, the gap between two columns very few.
     * The gaps are not always clean -- ruby, the small reading set beside a
     * kanji, stands in them, and so does English set sideways beside a
     * title -- but ruby is sparse and narrow, so it falls below the line
     * that dense columns stand above, and anything left that is much
     * narrower than the columns (ruby, a panel's edge) is dropped after.
     * A column with a long empty stretch in it is two: one bubble above
     * another.
     *
     * @return boxes relative to the patch, trimmed to their ink
     */
    /** How much of its inked rows a column of characters inks, at least. */
    static float FILLED = 0.26f;

    static List<Box> columnsIn(Gray g) { return columnsIn(g, 0); }

    /** @param em a character's size, if known, or 0 */
    static List<Box> columnsIn(Gray g, float em) {
        List<Box> out = new ArrayList<>();
        int[] colInk = new int[g.w];
        for (int y = 0; y < g.h; y++) for (int x = 0; x < g.w; x++) if (g.ink(x, y)) colInk[x]++;
        List<Integer> inked = new ArrayList<>();
        for (int v : colInk) if (v > 0) inked.add(v);
        if (inked.isEmpty()) return out;
        Collections.sort(inked);
        float peak = inked.get((int) ((inked.size() - 1) * 0.9f));
        float high = peak * 0.25f;
        float low = Math.max(1f, peak * 0.06f);

        List<int[]> runs = runsAbove(colInk, high, 0, g.w);
        // A short column -- two characters beside columns of ten -- inks
        // fewer rows, and falls under that line but for a sliver. Looked for
        // again, more gently: a gentle run that holds no column of the usual
        // width, and is that wide itself, is a column. Ruby is narrower.
        if (!runs.isEmpty()) {
            int widestRun = 0;
            for (int[] run : runs) widestRun = Math.max(widestRun, run[1] - run[0]);
            List<Integer> found = new ArrayList<>();
            for (int[] run : runs) if (run[1] - run[0] >= widestRun * 0.5f) found.add(run[1] - run[0]);
            Collections.sort(found);
            int usual = found.get(found.size() / 2);
            List<int[]> kept = new ArrayList<>();
            for (int[] gentle : runsAbove(colInk, peak * 0.1f, 0, g.w)) {
                List<int[]> inside = new ArrayList<>();
                boolean real = false;
                for (int[] run : runs) {
                    if (run[0] >= gentle[0] && run[1] <= gentle[1]) {
                        inside.add(run);
                        if (run[1] - run[0] >= usual * 0.6f) real = true;
                    }
                }
                if (real) kept.addAll(inside);
                else if (gentle[1] - gentle[0] >= usual * 0.6f && gentle[1] - gentle[0] <= usual * 1.6f) kept.add(gentle);
                else kept.addAll(inside);
            }
            runs = kept;
        }
        // A dip inside a column (a few characters with a gap down their
        // middle) is narrow beside the column; the gap between columns is not.
        List<int[]> merged = new ArrayList<>();
        for (int[] run : runs) {
            if (!merged.isEmpty()) {
                int[] last = merged.get(merged.size() - 1);
                int gap = run[0] - last[1];
                int narrower = Math.min(run[1] - run[0], last[1] - last[0]);
                int wider = Math.max(run[1] - run[0], last[1] - last[0]);
                // Ruby beside a column is close too, but far sparser.
                float denser = Math.max(meanInk(colInk, run), meanInk(colInk, last));
                float sparser = Math.min(meanInk(colInk, run), meanInk(colInk, last));
                // Only halves of a column: like in width and in ink. Ruby and
                // English set sideways beside a title are narrower.
                if (gap < Math.max(2, wider * 0.15f) && narrower > wider * 0.4f && sparser > denser * 0.5f) {
                    last[1] = run[1];
                    continue;
                }
            }
            merged.add(run);
        }
        // Two columns set close can come out as one run twice the width:
        // cut where the ink is thinnest, near where the line between them
        // would be.
        if (merged.size() > 0) {
            List<Integer> found = new ArrayList<>();
            for (int[] run : merged) found.add(run[1] - run[0]);
            Collections.sort(found);
            // The usual width: the middle one of several; of one or two, the
            // narrower, or a character's size as the recogniser saw it.
            int usual = found.size() > 2 ? found.get(found.size() / 2) : found.get(0);
            if (found.size() <= 2 && em > 0) usual = Math.min(usual, Math.round(em));
            List<int[]> cut = new ArrayList<>();
            for (int[] run : merged) {
                int w = run[1] - run[0];
                if (usual <= 0 || w < usual * 1.6f) { cut.add(run); continue; }
                int k = Math.max(2, Math.round(w / (float) usual));
                int prev = run[0];
                for (int i = 1; i < k; i++) {
                    int target = run[0] + Math.round(i * w / (float) k);
                    int reach = Math.max(1, Math.round(usual * 0.3f));
                    int best = target;
                    for (int xx = Math.max(prev + 1, target - reach); xx <= Math.min(run[1] - 1, target + reach); xx++) {
                        if (colInk[xx] < colInk[best]) best = xx;
                    }
                    cut.add(new int[] { prev, best });
                    prev = best + 1;
                }
                cut.add(new int[] { prev, run[1] });
            }
            merged = cut;
        }
        // Out to the column's edges, where the strokes are thinner.
        for (int i = 0; i < merged.size(); i++) {
            int[] run = merged.get(i);
            int floor = i == 0 ? 0 : merged.get(i - 1)[1];
            int ceiling = i == merged.size() - 1 ? g.w : merged.get(i + 1)[0];
            // A little way only: the thin ends of strokes, not whatever
            // stands beside the column.
            int reach = Math.max(1, Math.round((run[1] - run[0]) * 0.2f));
            int from = run[0];
            int to = run[1];
            while (run[0] - 1 >= floor && from - run[0] < reach && colInk[run[0] - 1] >= low) run[0]--;
            while (run[1] < ceiling && run[1] - to < reach && colInk[run[1]] >= low) run[1]++;
        }

        List<Box> columns = new ArrayList<>();
        for (int[] run : merged) {
            int w = run[1] - run[0];
            if (w < 3) continue;
            // Down the column: cut where nothing is inked for longer than a
            // character and a half.
            int need = 1;
            int y = 0;
            int start = -1;
            int lastInk = -1;
            for (; y <= g.h; y++) {
                boolean any = false;
                if (y < g.h) {
                    int n = 0;
                    for (int xx = run[0]; xx < run[1] && n < need; xx++) if (g.ink(xx, y)) n++;
                    any = n >= need;
                }
                if (any) {
                    if (start < 0) start = y;
                    else if (y - lastInk > w * 1.5f) {
                        addColumn(g, columns, run, start, lastInk + 1);
                        start = y;
                    }
                    lastInk = y;
                }
            }
            if (start >= 0) addColumn(g, columns, run, start, lastInk + 1);
        }
        if (columns.isEmpty()) return out;
        // The typical width, from the columns with the most ink: a stray
        // mark or a strip of ruby has little.
        List<int[]> weighed = new ArrayList<>();
        int[] inkOf = new int[columns.size()];
        int[] rowsOf = new int[columns.size()];
        for (int i = 0; i < columns.size(); i++) {
            Box c = columns.get(i);
            int ink = 0;
            int rows = 0;
            for (int yy = c.top; yy < c.bottom; yy++) {
                int before = ink;
                for (int xx = c.left; xx < c.right; xx++) if (g.ink(xx, yy)) ink++;
                if (ink > before) rows++;
            }
            inkOf[i] = ink;
            rowsOf[i] = Math.max(1, rows);
            weighed.add(new int[] { c.width(), ink });
        }
        Collections.sort(weighed, (p, q) -> Integer.compare(q[1], p[1]));
        List<Integer> widths = new ArrayList<>();
        for (int i = 0; i < Math.max(1, (weighed.size() + 1) / 2); i++) widths.add(weighed.get(i)[0]);
        Collections.sort(widths);
        int typical = widths.get(widths.size() / 2);
        List<Float> fills = new ArrayList<>();
        for (int i = 0; i < columns.size(); i++) fills.add(inkOf[i] / (float) (columns.get(i).width() * rowsOf[i]));
        Collections.sort(fills);
        float usualFill = fills.get(fills.size() / 2);
        for (int i = 0; i < columns.size(); i++) {
            Box c = columns.get(i);
            // Narrow ones are ruby or a panel's edge; flat ones are a stray mark.
            if (c.width() < typical * 0.5f) continue;
            if (c.height() < typical * 0.5f) continue;
            // Thin scraps of the drawing -- speed lines broken by the
            // cleaning -- ink a little of each row they cross; characters
            // ink a good part of theirs. (Counted over the inked rows only,
            // so the space between characters does not count against them.)
            // Against the other columns, as a thin typeface inks less than a
            // bold one throughout.
            float filled = inkOf[i] / (float) (c.width() * rowsOf[i]);
            if (filled < FILLED && filled < usualFill * 0.65f) continue;
            out.add(c);
        }
        return out;
    }

    private static List<int[]> runsAbove(int[] colInk, float line, int from, int to) {
        List<int[]> runs = new ArrayList<>();
        int x = from;
        while (x < to) {
            if (colInk[x] >= line) {
                int start = x;
                while (x < to && colInk[x] >= line) x++;
                runs.add(new int[] { start, x });
            } else x++;
        }
        return runs;
    }

    /** A short stretch of a column that is small, or thinly inked. */
    private static boolean scrap(Gray g, Box column, int[] piece) {
        int w = column.width();
        int h = piece[1] - piece[0];
        if (h < w * 0.35f) return true;
        if (h > w * 2f) return false;
        int ink = 0;
        int rows = 0;
        for (int y = piece[0]; y < piece[1]; y++) {
            int before = ink;
            for (int x = column.left; x < column.right; x++) if (g.ink(x, y)) ink++;
            if (ink > before) rows++;
        }
        return ink < w * Math.max(1, rows) * 0.15f;
    }

    private static float meanInk(int[] colInk, int[] run) {
        long sum = 0;
        for (int x = run[0]; x < run[1]; x++) sum += colInk[x];
        return sum / (float) Math.max(1, run[1] - run[0]);
    }

    private static void addColumn(Gray g, List<Box> columns, int[] run, int top, int bottom) {
        Box b = trim(g, new Box(run[0], top, run[1], bottom));
        if (b == null) return;
        // Scraps of the drawing just past either end -- standing apart from
        // the characters, and thin -- are not part of the column. A full
        // stop stands close to the character before it.
        int w = b.width();
        List<int[]> pieces = new ArrayList<>();
        for (int[] stretch : rowRuns(g, b)) {
            if (!pieces.isEmpty() && stretch[0] - pieces.get(pieces.size() - 1)[1] <= w * 0.6f) {
                pieces.get(pieces.size() - 1)[1] = stretch[1];
            } else pieces.add(new int[] { stretch[0], stretch[1] });
        }
        while (pieces.size() > 1 && scrap(g, b, pieces.get(pieces.size() - 1))) pieces.remove(pieces.size() - 1);
        while (pieces.size() > 1 && scrap(g, b, pieces.get(0))) pieces.remove(0);
        if (!pieces.isEmpty()) {
            b.top = pieces.get(0)[0];
            b.bottom = pieces.get(pieces.size() - 1)[1];
        }
        Box tight = trim(g, b);
        if (tight != null) columns.add(tight);
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
            // Firmly against stretching: typeset kana are often a little
            // shorter than square, and two of them stretched together fit a
            // taller square well -- which reads っ and た as one character.
            double score = full == 0 ? Double.MAX_VALUE : off / full + (stretch - 1f) * 0.6;
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
        // Kana are set closer than a full square more often than not, and a
        // column is as wide as its widest character: from three quarters of
        // the width up.
        for (float pitch = width * 0.75f; pitch <= width * 1.3f; pitch += step) {
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
        /** The patch the characters are cut from, cleaned of the drawing:
         *  packed ARGB, sourceWidth wide. Placements' boxes are within it. */
        int[] source;
        int sourceWidth, sourceHeight;
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
        return layout(picture, units, Collections.<Box>emptyList());
    }

    /**
     * @param others where the recogniser found the page's other text: a
     *   column found beyond this block's own lines that stands in one of
     *   them is theirs, not this block's, and is left to them
     */
    static Sheet layout(Pixels picture, List<Box> units, List<Box> others) {
        // The recogniser's lines say where the text is, not how it runs: read
        // across columns, they are short and wide. So the columns are found
        // afresh, in the whole patch the lines cover, a little beyond it.
        List<Box> clamped = clamp(units, picture);
        if (clamped.isEmpty()) return null;
        Box region = clamped.get(0).copy();
        for (Box u : clamped) region.union(u);
        final Box own = region.copy();
        List<Integer> thickness = new ArrayList<>();
        for (Box u : clamped) thickness.add(Math.min(u.width(), u.height()));
        Collections.sort(thickness);
        // Wide enough to take in a column the recogniser missed altogether
        // beside the ones it found -- a short first column, say, or one
        // with ruby -- and the ends of columns it cut short. What is not
        // lettering is cleaned out below.
        int least = Math.max(2, Math.round(Math.max(region.width(), region.height()) * 0.03f));
        int character = thickness.get(thickness.size() / 2);
        int growAcross = Math.max(least, Math.round(character * 1.6f));
        int growDown = Math.max(least, character);
        region = new Box(Math.max(0, region.left - growAcross), Math.max(0, region.top - growDown),
                Math.min(picture.width(), region.right + growAcross), Math.min(picture.height(), region.bottom + growDown));
        if (region.width() < 4 || region.height() < 4) return null;
        int[] argb = picture.argb(region);
        Gray raw = Gray.of(argb, region.width(), region.height());
        // A character's size, from the recogniser's lines: read down a
        // column or across columns, a line is a character thick.
        List<Integer> thick = new ArrayList<>();
        for (Box u : clamped) thick.add(Math.min(u.width(), u.height()));
        Collections.sort(thick);
        float hint = thick.get(thick.size() / 2);
        // Dark letters on a light ground, or light on dark: judged by which
        // finds columns of characters. (Majority alone misleads: black
        // lettering beside a black silhouette is in a mostly dark patch.)
        int[] clean = null;
        Gray patch = null;
        List<Box> found = null;
        long bestScore = 0;
        for (boolean light : new boolean[] { raw.light, !raw.light }) {
            Gray seen = new Gray(raw.lum, region.width(), region.height(), raw.threshold, light);
            boolean[] keep = lettering(seen, hint);
            int ground = light ? 0xFF000000 : 0xFFFFFFFF;
            // Within the lettering, only the solid ink and a pixel of soft
            // edge round it: shading that touches a stroke is grey, and
            // would be read as a mark of its own.
            int w = region.width();
            int h = region.height();
            boolean[] solid = new boolean[argb.length];
            for (int i = 0; i < argb.length; i++) {
                int v = raw.lum[i];
                solid[i] = light ? v >= 230 : v <= 60;
            }
            int[] tried = new int[argb.length];
            for (int i = 0; i < argb.length; i++) {
                boolean use = false;
                if (keep[i]) {
                    int v = raw.lum[i];
                    use = light ? v >= 195 : v <= 110;
                    if (!use) {
                        int x = i % w;
                        int y = i / w;
                        for (int dy = -1; dy <= 1 && !use; dy++) {
                            for (int dx = -1; dx <= 1 && !use; dx++) {
                                int xx = x + dx, yy = y + dy;
                                if (xx >= 0 && xx < w && yy >= 0 && yy < h && solid[yy * w + xx]) use = true;
                            }
                        }
                    }
                }
                tried[i] = use ? argb[i] : ground;
            }
            Gray cleaned = new Gray(Gray.lumOf(tried), region.width(), region.height(), raw.threshold, light);
            List<Box> columns = columnsIn(cleaned, hint);
            if (columns.isEmpty() || !looksVertical(columns)) continue;
            long score = 0;
            for (Box c : columns) score += c.height();
            // The first guess wins unless the other is clearly better.
            if (found == null || score > bestScore * 1.3f) {
                clean = tried;
                patch = cleaned;
                found = columns;
                bestScore = score;
            }
        }
        if (found == null) return null;      // within the patch from here on
        // Columns reached only by looking beyond this block's lines, that
        // stand in another block's text, are that block's.
        if (!others.isEmpty()) {
            List<Box> mine = new ArrayList<>();
            for (Box c : found) {
                Box at = new Box(region.left + c.left, region.top + c.top, region.left + c.right, region.top + c.bottom);
                float cx = (at.left + at.right) / 2f;
                float cy = (at.top + at.bottom) / 2f;
                boolean inside = cx >= own.left && cx <= own.right && cy >= own.top && cy <= own.bottom;
                boolean theirs = false;
                if (!inside) {
                    for (Box o : others) {
                        int w = Math.min(at.right, o.right) - Math.max(at.left, o.left);
                        int h = Math.min(at.bottom, o.bottom) - Math.max(at.top, o.top);
                        if (w > 0 && h > 0 && (long) w * h > (long) at.width() * at.height() * 0.3) { theirs = true; break; }
                    }
                }
                if (!theirs) mine.add(c);
            }
            found = mine;
            if (found.isEmpty() || !looksVertical(found)) return null;
        }
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
        sheet.source = clean;
        sheet.sourceWidth = region.width();
        sheet.sourceHeight = region.height();
        int longest = 0;
        for (int c = 0; c < body.size(); c++) {
            Box col = body.get(c);
            Gray g = patch.part(col);
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
                            Math.min(region.width(), to + pad), col.top + cell.bottom);
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
    static boolean cornerBracket(Gray g, Cell whole, float em) {
        // Judged on the square's largest run of ink: a dot of the ？ before
        // a bracket sometimes falls into the bracket's square.
        List<int[]> runs = rowRuns(g, new Box(whole.inkLeft, whole.top, whole.inkRight + 1, whole.bottom));
        if (runs.isEmpty()) return false;
        int[] body = runs.get(0);
        for (int[] run : runs) if (run[1] - run[0] > body[1] - body[0]) body = run;
        Cell cell = new Cell();
        cell.top = body[0];
        cell.bottom = body[1];
        cell.inkLeft = g.w;
        cell.inkRight = -1;
        for (int y = cell.top; y < cell.bottom; y++) {
            for (int x = whole.inkLeft; x <= whole.inkRight; x++) {
                if (!g.ink(x, y)) continue;
                cell.inkLeft = Math.min(cell.inkLeft, x);
                cell.inkRight = Math.max(cell.inkRight, x);
            }
        }
        if (cell.inkRight < 0) return false;
        // The bracket must be most of the square: こ is two strokes, and its
        // lower one alone would pass for 」.
        int all = 0;
        int mine = 0;
        for (int y = whole.top; y < whole.bottom; y++) {
            for (int x = whole.inkLeft; x <= whole.inkRight; x++) {
                if (!g.ink(x, y)) continue;
                all++;
                if (y >= cell.top && y < cell.bottom) mine++;
            }
        }
        if (mine < all * 0.8f) return false;
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
        if (ink > w * h * 0.6f) return false;
        int band = Math.max(1, Math.round(h * 0.25f));
        int side = Math.max(1, Math.round(w * 0.25f));
        boolean barTop = barIn(g, cell, cell.top, cell.top + band, 0.75f);
        boolean barBottom = barIn(g, cell, cell.bottom - band, cell.bottom, 0.75f);
        boolean right = stemIn(g, cell, cell.inkRight + 1 - side, cell.inkRight + 1, 0.8f);
        boolean left = stemIn(g, cell, cell.inkLeft, cell.inkLeft + side, 0.8f);
        // (The double ones, 『』, are drawn in outline: their inner strokes
        // reach part of the way along the other sides, not all of it.)
        boolean opening = barTop && right && !barBottom && !left
                && !barIn(g, cell, cell.bottom - band, cell.bottom, 0.7f)
                && !stemIn(g, cell, cell.inkLeft, cell.inkLeft + side, 0.7f);
        boolean closing = barBottom && left && !barTop && !right
                && !barIn(g, cell, cell.top, cell.top + band, 0.7f)
                && !stemIn(g, cell, cell.inkRight + 1 - side, cell.inkRight + 1, 0.7f);
        // And the corner the bracket opens towards is empty: っ in a heavy
        // face has a bar along its top and a stroke down its right, but
        // curls back into that corner.
        if (opening) opening = emptyIn(g, cell, cell.inkLeft, cell.inkLeft + Math.round(w * 0.5f),
                cell.top + Math.round(h * 0.6f), cell.bottom);
        if (closing) closing = emptyIn(g, cell, cell.inkRight + 1 - Math.round(w * 0.5f), cell.inkRight + 1,
                cell.top, cell.top + Math.round(h * 0.4f));
        return opening || closing;
    }

    private static boolean emptyIn(Gray g, Cell cell, int left, int right, int top, int bottom) {
        int ink = 0;
        int area = 0;
        for (int y = Math.max(cell.top, top); y < Math.min(cell.bottom, bottom); y++) {
            for (int x = Math.max(cell.inkLeft, left); x < Math.min(cell.inkRight + 1, right); x++) {
                area++;
                if (g.ink(x, y)) ink++;
            }
        }
        return ink <= area * 0.08f;
    }

    /** A row within [from, to) inked unbroken across this much of the
     *  cell: a ruled stroke, not a curve. */
    private static boolean barIn(Gray g, Cell cell, int from, int to, float share) {
        int need = Math.round(cell.inkWidth() * share);
        for (int y = Math.max(cell.top, from); y < Math.min(cell.bottom, to); y++) {
            int n = 0;
            for (int x = cell.inkLeft; x <= cell.inkRight; x++) {
                n = g.ink(x, y) ? n + 1 : 0;
                if (n >= need) return true;
            }
        }
        return false;
    }

    /** A column within [from, to) inked unbroken down this much of the cell. */
    private static boolean stemIn(Gray g, Cell cell, int from, int to, float share) {
        int need = Math.round(cell.height() * share);
        for (int x = Math.max(cell.inkLeft, from); x < Math.min(cell.inkRight + 1, to); x++) {
            int n = 0;
            for (int y = cell.top; y < cell.bottom; y++) {
                n = g.ink(x, y) ? n + 1 : 0;
                if (n >= need) return true;
            }
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
