package com.grimoire.ereader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Rect;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Text read out of pictures, on the phone.
 *
 * ML Kit's text recogniser: no account, no key, and no network -- the models
 * for Latin, Chinese, Japanese and Korean script are inside the app. The page
 * hands over a picture in pieces (begin, append), asks for it to be read in
 * one or more scripts (recognise), and is answered through
 * window.Grimoire.settleOcr with the text and where each block of it sits.
 *
 * A very tall picture -- a strip of a webtoon, many screens long -- is read
 * in overlapping slices, because the recogniser scales whatever it is given
 * down to a working size and a strip scaled to that is too small to read.
 */
public class OcrBridge {

    private static final String TAG = "GrimoireOcr";
    /** A slice as tall as this many times its width. */
    private static final float SLICE = 1.6f;
    /** How much each slice overlaps the next, so no line is cut in two. */
    private static final float OVERLAP = 0.15f;

    private final Activity activity;
    private final WebView webView;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, ByteArrayOutputStream> incoming = new ConcurrentHashMap<>();
    private final Map<String, TextRecognizer> recognisers = new HashMap<>();

    OcrBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /** A picture is on its way, in pieces. */
    @JavascriptInterface
    public void begin(String id) {
        incoming.put(id, new ByteArrayOutputStream());
    }

    /** A piece of it, as base64. */
    @JavascriptInterface
    public boolean append(String id, String base64) {
        ByteArrayOutputStream out = incoming.get(id);
        if (out == null) return false;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            out.write(bytes, 0, bytes.length);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** Let go of a picture that will not be read after all. */
    @JavascriptInterface
    public void cancel(String id) {
        incoming.remove(id);
    }

    /**
     * Read the picture in each of the scripts named ("korean,latin"), and
     * answer with what each found.
     */
    @JavascriptInterface
    public void recognise(final String id, final String scripts) {
        final ByteArrayOutputStream out = incoming.remove(id);
        io.execute(() -> {
            if (out == null) {
                settle(id, false, "the picture did not arrive");
                return;
            }
            Bitmap bitmap = null;
            try {
                byte[] bytes = out.toByteArray();
                /* Opened no wider than the recogniser can use. A scan at
                 * 4000 pixels wide is sixty megabytes as a bitmap, and the
                 * recogniser works at a fraction of that anyway. Tall strips
                 * keep their width, and are read in slices below. */
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inSampleSize = 1;
                while (bounds.outWidth / (options.inSampleSize * 2) >= 1600) options.inSampleSize *= 2;
                bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                if (bitmap == null) {
                    settle(id, false, "that picture could not be opened");
                    return;
                }
                JSONObject result = new JSONObject();
                result.put("width", bitmap.getWidth());
                result.put("height", bitmap.getHeight());
                JSONObject found = new JSONObject();
                for (String script : (scripts == null ? "latin" : scripts).split(",")) {
                    String name = script.trim();
                    if (name.isEmpty()) continue;
                    found.put(name, read(bitmap, name));
                }
                result.put("results", found);
                settle(id, true, result.toString());
            } catch (Throwable e) {
                Log.w(TAG, "Could not read the picture", e);
                settle(id, false, e.getMessage() == null ? "the text could not be read" : e.getMessage());
            } finally {
                if (bitmap != null) bitmap.recycle();
            }
        });
    }

    /**
     * Hand the picture to Google Lens instead, for lettering the recogniser
     * here cannot read: drawn, slanted, stretched, run down the page. Lens
     * reads on Google's side, so this is the one place a picture leaves the
     * phone, and only when the reader asks. Lens on its own if it is there,
     * else the Google app, which opens the same thing; else the share sheet.
     *
     * @return "" when something was opened, otherwise why not
     */
    @JavascriptInterface
    public String lens(String id) {
        ByteArrayOutputStream out = incoming.remove(id);
        if (out == null) return "the picture did not arrive";
        try {
            byte[] bytes = out.toByteArray();
            String type = typeOf(bytes);
            File dir = new File(activity.getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) return "there was nowhere to put the picture";
            File file = new File(dir, "picture-to-read." + type.substring(type.indexOf('/') + 1));
            try (OutputStream file_out = new FileOutputStream(file)) {
                file_out.write(bytes);
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", file);
            String[] apps = { "com.google.ar.lens", "com.google.android.googlequicksearchbox" };
            for (String app : apps) {
                try {
                    activity.startActivity(sendTo(uri, type).setPackage(app));
                    return "";
                } catch (ActivityNotFoundException | SecurityException ignored) {
                    // Not on this phone; the next one, or the share sheet.
                }
            }
            activity.startActivity(Intent.createChooser(sendTo(uri, type), "Read the text with…"));
            return "";
        } catch (Exception e) {
            Log.w(TAG, "Could not hand the picture to Lens", e);
            return e.getMessage() == null ? "the picture could not be handed over" : e.getMessage();
        }
    }

    private static Intent sendTo(Uri uri, String type) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(type);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        return send;
    }

    /** What kind of picture the bytes are, from their first few. */
    private static String typeOf(byte[] b) {
        if (b.length > 3 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (b.length > 2 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) return "image/jpeg";
        if (b.length > 11 && b[0] == 'R' && b[1] == 'I' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        if (b.length > 2 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
        return "image/png";
    }

    private TextRecognizer recogniser(String script) {
        TextRecognizer found = recognisers.get(script);
        if (found != null) return found;
        switch (script) {
            case "korean":
                found = TextRecognition.getClient(new KoreanTextRecognizerOptions.Builder().build());
                break;
            case "japanese":
                found = TextRecognition.getClient(new JapaneseTextRecognizerOptions.Builder().build());
                break;
            case "chinese":
                found = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
                break;
            default:
                found = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                break;
        }
        recognisers.put(script, found);
        return found;
    }

    /** Every block of text in the picture, read in one script. */
    private JSONObject read(Bitmap bitmap, String script) throws Exception {
        TextRecognizer recogniser = recogniser(script);
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int slice = Math.max(1, Math.round(width * SLICE));
        JSONArray blocks = new JSONArray();
        StringBuilder all = new StringBuilder();

        if (height <= slice * 1.25f) {
            addBlocks(readPiece(recogniser, script, bitmap), 0, 0, height, blocks, all);
        } else {
            int step = Math.max(1, Math.round(slice * (1 - OVERLAP)));
            for (int top = 0; top < height; top += step) {
                int bottom = Math.min(height, top + slice);
                Bitmap piece = Bitmap.createBitmap(bitmap, 0, top, width, bottom - top);
                try {
                    // Each slice keeps the blocks that start in its own part;
                    // the overlap is the next slice's.
                    int ownTop = top == 0 ? 0 : top + Math.round(slice * OVERLAP / 2);
                    int ownBottom = bottom >= height ? height : top + step + Math.round(slice * OVERLAP / 2);
                    addBlocks(readPiece(recogniser, script, piece), top, ownTop, ownBottom, blocks, all);
                } finally {
                    piece.recycle();
                }
                if (bottom >= height) break;
            }
        }
        JSONObject read = new JSONObject();
        read.put("text", all.toString().trim());
        read.put("blocks", blocks);
        return read;
    }

    /** What one block of text came to. */
    static final class Found {
        String text;
        Rect box;
        final List<String> lines = new ArrayList<>();
        /** Read from columns, right to left; its lines are those columns. */
        boolean vertical;
    }

    /**
     * One picture (or one slice of a tall one), read.
     *
     * Japanese and Chinese set in columns are read twice: once to find where
     * the columns are, and again with their characters laid out as lines
     * (VerticalLayout), which the recogniser reads far better than columns.
     */
    private List<Found> readPiece(TextRecognizer recogniser, String script, Bitmap bitmap) throws Exception {
        Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(bitmap, 0)));
        List<Found> out = new ArrayList<>();
        List<Text.TextBlock> blocks = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) if (block.getBoundingBox() != null) blocks.add(block);
        boolean columns = "japanese".equals(script) || "chinese".equals(script);
        if (!columns) {
            for (Text.TextBlock block : blocks) out.add(closer(recogniser, bitmap, block));
            return out;
        }
        for (List<Text.TextBlock> bubble : bubbles(blocks)) {
            Found found = null;
            try {
                found = readColumns(recogniser, bitmap, bubble);
            } catch (Exception e) {
                Log.w(TAG, "Could not lay the columns out", e);
            }
            if (found != null) out.add(found);
            else for (Text.TextBlock block : bubble) out.add(closer(recogniser, bitmap, block));
        }
        return out;
    }

    private static Found plain(Text.TextBlock block) {
        Found found = new Found();
        found.text = block.getText();
        found.box = new Rect(block.getBoundingBox());
        for (Text.Line line : block.getLines()) found.lines.add(line.getText());
        return found;
    }

    /** How tall a block's lines are (how wide, for columns): its characters' size. */
    private static int thickness(Text.TextBlock block) {
        List<Integer> sizes = new ArrayList<>();
        for (Text.Line line : block.getLines()) {
            Rect r = line.getBoundingBox();
            if (r != null) sizes.add(Math.min(r.width(), r.height()));
        }
        if (sizes.isEmpty()) {
            Rect r = block.getBoundingBox();
            return Math.min(r.width(), r.height());
        }
        java.util.Collections.sort(sizes);
        return sizes.get(sizes.size() / 2);
    }

    /**
     * A block read again, closer: cut out, enlarged until its characters are
     * a good size for the recogniser, and read. Small text on a whole page
     * is read at whatever size the page is scaled to; cut out, it is read at
     * full detail. The closer reading is kept when it finds about as much
     * as the first, or more.
     */
    private static Found closer(TextRecognizer recogniser, Bitmap bitmap, Text.TextBlock block) {
        Found first = plain(block);
        try {
            int line = thickness(block);
            if (line <= 0 || line >= 40) return first;      // large enough already
            float scale = Math.min(4f, 56f / line);
            Rect box = block.getBoundingBox();
            int pad = Math.max(2, Math.round(line * 0.6f));
            Rect src = new Rect(Math.max(0, box.left - pad), Math.max(0, box.top - pad),
                    Math.min(bitmap.getWidth(), box.right + pad), Math.min(bitmap.getHeight(), box.bottom + pad));
            if (src.width() < 2 || src.height() < 2) return first;
            if ((double) src.width() * scale * src.height() * scale > 6_000_000) {
                scale = (float) Math.sqrt(6_000_000.0 / ((double) src.width() * src.height()));
            }
            if (scale <= 1.05f) return first;
            int w = Math.max(1, Math.round(src.width() * scale));
            int h = Math.max(1, Math.round(src.height() * scale));
            Bitmap big = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            try {
                Canvas canvas = new Canvas(big);
                canvas.drawColor(Color.WHITE);
                canvas.drawBitmap(bitmap, src, new RectF(0, 0, w, h), new Paint(Paint.FILTER_BITMAP_FLAG));
                Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(big, 0)));
                List<Text.Line> lines = new ArrayList<>();
                for (Text.TextBlock b : text.getTextBlocks()) lines.addAll(b.getLines());
                java.util.Collections.sort(lines, (a, c) -> {
                    Rect ra = a.getBoundingBox();
                    Rect rc = c.getBoundingBox();
                    if (ra == null || rc == null) return 0;
                    return ra.top != rc.top ? Integer.compare(ra.top, rc.top) : Integer.compare(ra.left, rc.left);
                });
                Found found = new Found();
                found.box = new Rect(box);
                StringBuilder all = new StringBuilder();
                for (Text.Line l : lines) {
                    found.lines.add(l.getText());
                    if (all.length() > 0) all.append('\n');
                    all.append(l.getText());
                }
                found.text = all.toString();
                if (letters(found.text) < letters(first.text) * 0.6f) return first;
                return found;
            } finally {
                big.recycle();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read the block again", e);
            return first;
        }
    }

    private static int letters(String text) {
        if (text == null) return 0;
        int n = 0;
        for (int i = 0; i < text.length(); i++) if (!Character.isWhitespace(text.charAt(i))) n++;
        return n;
    }

    /** Blocks close together are one bubble's: the recogniser often hands
     *  back each column of a bubble on its own, or -- reading across the
     *  columns -- each row of characters. */
    private static List<List<Text.TextBlock>> bubbles(List<Text.TextBlock> blocks) {
        int n = blocks.size();
        int[] parent = new int[n];
        int[] size = new int[n];
        for (int i = 0; i < n; i++) {
            parent[i] = i;
            size[i] = thickness(blocks.get(i));
        }
        for (int i = 0; i < n; i++) {
            Rect a = blocks.get(i).getBoundingBox();
            for (int j = i + 1; j < n; j++) {
                Rect b = blocks.get(j).getBoundingBox();
                int reach = Math.round(Math.max(size[i], size[j]) * 0.6f);
                Rect grown = new Rect(a.left - reach, a.top - reach, a.right + reach, a.bottom + reach);
                if (Rect.intersects(grown, b)) parent[find(parent, i)] = find(parent, j);
            }
        }
        List<List<Text.TextBlock>> out = new ArrayList<>();
        List<Integer> roots = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            int root = find(parent, i);
            int at = roots.indexOf(root);
            if (at < 0) {
                roots.add(root);
                out.add(new ArrayList<>());
                at = out.size() - 1;
            }
            out.get(at).add(blocks.get(i));
        }
        return out;
    }

    private static int find(int[] parent, int i) {
        while (parent[i] != i) i = parent[i] = parent[parent[i]];
        return i;
    }

    /** A bubble's columns, cut into characters, set as lines, and read. */
    private static Found readColumns(TextRecognizer recogniser, final Bitmap bitmap,
                                     List<Text.TextBlock> bubble) throws Exception {
        List<VerticalLayout.Box> units = new ArrayList<>();
        Rect whole = null;
        for (Text.TextBlock block : bubble) {
            Rect box = block.getBoundingBox();
            if (whole == null) whole = new Rect(box); else whole.union(box);
            for (Text.Line line : block.getLines()) {
                Rect r = line.getBoundingBox();
                if (r != null) units.add(new VerticalLayout.Box(r.left, r.top, r.right, r.bottom));
            }
        }
        VerticalLayout.Sheet sheet = VerticalLayout.layout(new VerticalLayout.Pixels() {
            @Override public int width() { return bitmap.getWidth(); }
            @Override public int height() { return bitmap.getHeight(); }
            @Override public int[] argb(VerticalLayout.Box b) {
                int[] px = new int[b.width() * b.height()];
                bitmap.getPixels(px, 0, b.width(), b.left, b.top, b.width(), b.height());
                return px;
            }
        }, units);
        if (sheet == null) return null;

        Bitmap page = Bitmap.createBitmap(Math.max(1, sheet.width), Math.max(1, sheet.height), Bitmap.Config.ARGB_8888);
        // The characters are cut from the patch cleaned of the drawing.
        Bitmap source = Bitmap.createBitmap(sheet.source, sheet.sourceWidth, sheet.sourceHeight, Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(page);
            canvas.drawColor(Color.WHITE);
            Paint dark = new Paint();
            dark.setColor(Color.BLACK);
            for (VerticalLayout.Row row : sheet.rows) {
                if (row.light) canvas.drawRect(0, row.top, sheet.width, row.bottom, dark);
            }
            Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
            for (VerticalLayout.Placement p : sheet.placed) {
                Rect src = new Rect(p.src.left, p.src.top, p.src.right, p.src.bottom);
                RectF dst = new RectF(p.x, p.y, p.x + p.w, p.y + p.h);
                if (p.turn) {
                    canvas.save();
                    canvas.rotate(-90, dst.centerX(), dst.centerY());
                    canvas.drawBitmap(source, src, dst, paint);
                    canvas.restore();
                } else {
                    canvas.drawBitmap(source, src, dst, paint);
                }
            }
            Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(page, 0)));
            List<VerticalLayout.Read> lines = new ArrayList<>();
            for (Text.TextBlock block : text.getTextBlocks()) {
                for (Text.Line line : block.getLines()) {
                    Rect r = line.getBoundingBox();
                    if (r == null) continue;
                    lines.add(new VerticalLayout.Read(line.getText(),
                            new VerticalLayout.Box(r.left, r.top, r.right, r.bottom)));
                }
            }
            List<String> columns = VerticalLayout.columnTexts(sheet, lines);
            if (columns.isEmpty()) return null;
            // Lettering the cleaning took for the drawing (drawn across a
            // door frame, say) is lost from the sheet; when much is lost,
            // the first reading, muddled as it may be, has more of the text.
            int before = 0;
            for (Text.TextBlock block : bubble) before += letters(block.getText());
            int after = 0;
            for (String column : columns) after += letters(column);
            if (after < before * 0.6f) return null;
            Found found = new Found();
            found.vertical = true;
            found.box = whole;
            found.lines.addAll(columns);
            StringBuilder joined = new StringBuilder();
            for (String column : columns) joined.append(column);
            found.text = joined.toString();
            return found;
        } finally {
            page.recycle();
            source.recycle();
        }
    }

    private static void addBlocks(List<Found> found, int offset, int ownTop, int ownBottom,
                                  JSONArray blocks, StringBuilder all) throws Exception {
        for (Found block : found) {
            Rect box = block.box;
            if (box == null) continue;
            int top = box.top + offset;
            if (top < ownTop || top >= ownBottom) continue;
            JSONObject out = new JSONObject();
            out.put("text", block.text);
            out.put("x", box.left);
            out.put("y", top);
            out.put("w", box.width());
            out.put("h", box.height());
            if (block.vertical) out.put("vertical", true);
            JSONArray lines = new JSONArray();
            for (String line : block.lines) lines.put(line);
            out.put("lines", lines);
            blocks.put(out);
            all.append(block.text).append("\n\n");
        }
    }

    private void settle(String id, boolean ok, String payload) {
        final String js = "window.Grimoire && window.Grimoire.settleOcr && window.Grimoire.settleOcr("
                + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload) + ")";
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }
}
