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
import org.json.JSONException;
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
        recogniseWith(id, scripts, null);
    }

    /**
     * Which steps of the reading to take. All on in use; the accuracy check
     * turns them off to measure what each is worth, on the same pictures.
     */
    static final class Steps {
        boolean columns = true;    // vertical text laid out as lines and read again
        boolean closer = true;     // small text cut out, enlarged and read again
        boolean tiles = true;      // a large page searched again in quarters, for small text missed
        boolean compare = true;    // columns read from the cleaned and the original pixels, the surer kept
        boolean straighten = true; // a page on the slant read again straightened

        static Steps of(String json) {
            Steps steps = new Steps();
            if (json == null || json.isEmpty()) return steps;
            try {
                JSONObject o = new JSONObject(json);
                steps.columns = o.optBoolean("columns", true);
                steps.closer = o.optBoolean("closer", true);
                steps.tiles = o.optBoolean("tiles", true);
                steps.compare = o.optBoolean("compare", true);
                steps.straighten = o.optBoolean("straighten", true);
            } catch (JSONException ignored) {
                // All of them, then.
            }
            return steps;
        }
    }

    /** As recognise, with the steps to take (Steps, as JSON). */
    @JavascriptInterface
    public void recogniseWith(final String id, final String scripts, final String stepsJson) {
        final Steps steps = Steps.of(stepsJson);
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
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                    settle(id, false, "that picture could not be opened");
                    return;
                }
                bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                if (bitmap == null) {
                    settle(id, false, "that picture could not be opened");
                    return;
                }
                // A photo taken sideways says so in its EXIF, and is shown
                // turned upright; read it upright too, or the text is read on
                // its side and the places found do not match the picture shown.
                Bitmap upright = upright(bitmap, bytes);
                if (upright != bitmap) {
                    bitmap.recycle();
                    bitmap = upright;
                }
                JSONObject result = new JSONObject();
                result.put("width", bitmap.getWidth());
                result.put("height", bitmap.getHeight());
                JSONObject found = new JSONObject();
                JSONObject failed = new JSONObject();
                String firstError = null;
                for (String script : (scripts == null ? "latin" : scripts).split(",")) {
                    String name = script.trim();
                    if (name.isEmpty()) continue;
                    // One script failing loses only its own reading: what the
                    // others found is kept, and the failure said with it.
                    try {
                        found.put(name, read(bitmap, name, steps));
                    } catch (Throwable e) {
                        Log.w(TAG, "Could not read the picture in " + name, e);
                        String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                        failed.put(name, why);
                        if (firstError == null) firstError = why;
                    }
                }
                if (found.length() == 0) {
                    settle(id, false, firstError == null ? "the text could not be read" : firstError);
                    return;
                }
                result.put("results", found);
                if (failed.length() > 0) result.put("failed", failed);
                settle(id, true, result.toString());
            } catch (Throwable e) {
                Log.w(TAG, "Could not read the picture", e);
                settle(id, false, e.getMessage() == null ? "the text could not be read" : e.getMessage());
            } finally {
                if (bitmap != null) bitmap.recycle();
            }
        });
    }

    /** The picture turned as its EXIF orientation says it is shown; itself
     *  when it says nothing, or anything goes wrong. */
    static Bitmap upright(Bitmap bitmap, byte[] bytes) {
        int orientation;
        try {
            orientation = new android.media.ExifInterface(new java.io.ByteArrayInputStream(bytes))
                    .getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION,
                            android.media.ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception e) {
            return bitmap;   // a PNG or WebP without EXIF, or none readable
        }
        android.graphics.Matrix m = new android.graphics.Matrix();
        switch (orientation) {
            case android.media.ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case android.media.ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case android.media.ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
            case android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
            case android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
            case android.media.ExifInterface.ORIENTATION_TRANSPOSE: m.postRotate(90); m.postScale(-1, 1); break;
            case android.media.ExifInterface.ORIENTATION_TRANSVERSE: m.postRotate(270); m.postScale(-1, 1); break;
            default: return bitmap;
        }
        try {
            return Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), m, true);
        } catch (Throwable e) {
            return bitmap;
        }
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
    private JSONObject read(Bitmap bitmap, String script, Steps steps) throws Exception {
        TextRecognizer recogniser = recogniser(script);
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int slice = Math.max(1, Math.round(width * SLICE));
        JSONArray blocks = new JSONArray();
        StringBuilder all = new StringBuilder();
        JSONObject read = new JSONObject();

        if (height <= slice * 1.25f) {
            Piece piece = readPiece(recogniser, script, bitmap, steps);
            List<Found> found = piece.found;
            // A page on the slant -- a photographed or scanned page -- is
            // read again straightened, and kept if read with more certainty.
            if (steps.straighten && Math.abs(piece.angle) >= 2f && Math.abs(piece.angle) <= 30f) {
                Found[] straight = straightened(recogniser, script, bitmap, piece.angle, steps);
                if (straight != null && better(straight, found)) {
                    found = java.util.Arrays.asList(straight);
                    read.put("straightened", piece.angle);
                }
            }
            if (steps.tiles && Math.max(width, height) >= TILE_FROM) {
                int added = addMissed(recogniser, script, bitmap, found, steps);
                if (added > 0) read.put("tilesAdded", added);
            }
            addBlocks(found, 0, 0, height, blocks, all);
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
                    addBlocks(readPiece(recogniser, script, piece, steps).found, top, ownTop, ownBottom, blocks, all);
                } finally {
                    piece.recycle();
                }
                if (bottom >= height) break;
            }
        }
        read.put("text", all.toString().trim());
        read.put("blocks", blocks);
        return read;
    }

    /** A page this large is searched again in quarters for small text. The
     *  recogniser looks for text on a scaled-down copy of the whole page, so
     *  ruby, side notes and small captions on a big page can go unfound. */
    private static final int TILE_FROM = 1800;

    /**
     * The page searched again in four overlapping quarters, each at full
     * detail. Only text the first search did not find is added -- nothing
     * found already is replaced -- so this can find more, and cannot lose
     * any. A find must be text in the script, read with fair certainty.
     *
     * @return how many blocks were added
     */
    private int addMissed(TextRecognizer recogniser, String script, Bitmap bitmap,
                          List<Found> found, Steps steps) throws Exception {
        int w = bitmap.getWidth();
        int h = bitmap.getHeight();
        int tw = Math.round(w * 0.56f);
        int th = Math.round(h * 0.56f);
        int added = 0;
        boolean columns = "japanese".equals(script) || "chinese".equals(script);
        for (int ty = 0; ty < 2; ty++) {
            for (int tx = 0; tx < 2; tx++) {
                int left = tx == 0 ? 0 : w - tw;
                int top = ty == 0 ? 0 : h - th;
                Bitmap tile = Bitmap.createBitmap(bitmap, left, top, tw, th);
                try {
                    Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(tile, 0)));
                    for (Text.TextBlock block : text.getTextBlocks()) {
                        Rect r = block.getBoundingBox();
                        if (r == null) continue;
                        Rect at = new Rect(r.left + left, r.top + top, r.right + left, r.bottom + top);
                        if (covered(at, found)) continue;
                        String said = block.getText();
                        int own = columns || "korean".equals(script) ? ownLetters(said) : letters(said);
                        if (own < 2) continue;
                        float sure = confidence(block);
                        if (sure >= 0 && sure < 0.5f) continue;
                        Found f = new Found();
                        f.box = at;
                        f.text = said;
                        for (Text.Line line : block.getLines()) {
                            f.lines.add(line.getText());
                            f.raw.add(line.getText());
                        }
                        f.confidence = sure;
                        f.source = "tile";
                        found.add(f);
                        added++;
                    }
                } finally {
                    tile.recycle();
                }
            }
        }
        return added;
    }

    /** Whether a box is mostly within text already found. */
    private static boolean covered(Rect box, List<Found> found) {
        long area = (long) Math.max(1, box.width()) * Math.max(1, box.height());
        for (Found f : found) {
            if (f.box == null) continue;
            int w = Math.min(box.right, f.box.right) - Math.max(box.left, f.box.left);
            int h = Math.min(box.bottom, f.box.bottom) - Math.max(box.top, f.box.top);
            if (w > 0 && h > 0 && (long) w * h > area * 0.3) return true;
        }
        return false;
    }

    /**
     * The page turned level and read again; the blocks' places mapped back
     * onto the page as it is, so that an overlay still lands on its bubble.
     */
    private Found[] straightened(TextRecognizer recogniser, String script, Bitmap bitmap,
                                 float angle, Steps steps) throws Exception {
        android.graphics.Matrix turn = new android.graphics.Matrix();
        turn.postRotate(-angle);
        Bitmap level = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), turn, true);
        try {
            // Where the turned page's corner landed: createBitmap shifts the
            // turned picture to start at (0, 0).
            float[] corners = { 0, 0, bitmap.getWidth(), 0, 0, bitmap.getHeight(), bitmap.getWidth(), bitmap.getHeight() };
            turn.mapPoints(corners);
            float minX = Math.min(Math.min(corners[0], corners[2]), Math.min(corners[4], corners[6]));
            float minY = Math.min(Math.min(corners[1], corners[3]), Math.min(corners[5], corners[7]));
            android.graphics.Matrix back = new android.graphics.Matrix();
            back.postTranslate(minX, minY);
            back.postRotate(angle);
            Steps once = Steps.of(null);
            once.columns = steps.columns;
            once.closer = steps.closer;
            once.compare = steps.compare;
            once.straighten = false;
            once.tiles = false;
            List<Found> found = readPiece(recogniser, script, level, once).found;
            Found[] out = new Found[found.size()];
            for (int i = 0; i < found.size(); i++) {
                Found f = found.get(i);
                if (f.box != null) {
                    float[] centre = { f.box.exactCenterX(), f.box.exactCenterY() };
                    back.mapPoints(centre);
                    int hw = f.box.width() / 2, hh = f.box.height() / 2;
                    f.box = new Rect(Math.round(centre[0]) - hw, Math.round(centre[1]) - hh,
                            Math.round(centre[0]) + hw, Math.round(centre[1]) + hh);
                }
                out[i] = f;
            }
            return out;
        } finally {
            level.recycle();
        }
    }

    /** Whether one reading of a page is better than another: surer where
     *  the recogniser says how sure, else more of the text. */
    private static boolean better(Found[] a, List<Found> b) {
        float ca = meanConfidence(java.util.Arrays.asList(a));
        float cb = meanConfidence(b);
        if (ca >= 0 && cb >= 0) return ca > cb + 0.03f;
        int la = 0, lb = 0;
        for (Found f : a) la += letters(f.text);
        for (Found f : b) lb += letters(f.text);
        return la > lb * 1.1f;
    }

    private static float meanConfidence(List<Found> found) {
        float sum = 0;
        int n = 0;
        for (Found f : found) {
            if (f.confidence < 0) continue;
            sum += f.confidence;
            n++;
        }
        return n == 0 ? -1 : sum / n;
    }

    /* How sure the recogniser was, where this version of it says: looked up
     * by name, so that a version without it reads as "not known" (-1) rather
     * than the app failing to build or run. */
    private static final Map<Class<?>, java.lang.reflect.Method> SURE = new ConcurrentHashMap<>();
    private static final Map<Class<?>, java.lang.reflect.Method> ANGLE = new ConcurrentHashMap<>();
    private static final java.lang.reflect.Method NONE;
    static {
        java.lang.reflect.Method none = null;
        try {
            none = Object.class.getMethod("hashCode");
        } catch (NoSuchMethodException ignored) {
            // Cannot happen.
        }
        NONE = none;
    }

    private static float call(Object target, String name, Map<Class<?>, java.lang.reflect.Method> cache) {
        if (target == null) return -1;
        java.lang.reflect.Method method = cache.get(target.getClass());
        if (method == null) {
            try {
                method = target.getClass().getMethod(name);
            } catch (NoSuchMethodException e) {
                method = NONE;
            }
            cache.put(target.getClass(), method);
        }
        if (method == NONE) return Float.NaN;
        try {
            Object value = method.invoke(target);
            return value instanceof Number ? ((Number) value).floatValue() : Float.NaN;
        } catch (Exception e) {
            return Float.NaN;
        }
    }

    /** A line's certainty, 0 to 1, or -1 if not known. */
    static float confidence(Text.Line line) {
        float v = call(line, "getConfidence", SURE);
        return Float.isNaN(v) ? -1 : v;
    }

    /** A block's certainty: its least certain line, or -1 if not known. */
    static float confidence(Text.TextBlock block) {
        float least = -1;
        for (Text.Line line : block.getLines()) {
            float c = confidence(line);
            if (c < 0) return -1;
            least = least < 0 ? c : Math.min(least, c);
        }
        return least;
    }

    /** The slant of a page's lines, in degrees: the middle one of them, or 0. */
    static float slant(List<Text.TextBlock> blocks) {
        List<Float> angles = new ArrayList<>();
        for (Text.TextBlock block : blocks) {
            for (Text.Line line : block.getLines()) {
                float a = call(line, "getAngle", ANGLE);
                if (!Float.isNaN(a)) angles.add(a);
            }
        }
        if (angles.size() < 3) return 0;
        java.util.Collections.sort(angles);
        return angles.get(angles.size() / 2);
    }

    /** What one block of text came to. */
    static final class Found {
        String text;
        Rect box;
        final List<String> lines = new ArrayList<>();
        /** The lines exactly as the recogniser gave them, before vertical
         *  punctuation was turned back into ordinary forms. */
        final List<String> raw = new ArrayList<>();
        /** Read from columns, right to left; its lines are those columns. */
        boolean vertical;
        /** How sure the recogniser was, 0 to 1 (its least sure line), or -1. */
        float confidence = -1;
        /** Which reading this is: page, closer, columns, tile. */
        String source = "page";
        /** For columns read twice (cleaned and as drawn): whether the two
         *  readings agreed, or null when read once. */
        Boolean agree;
    }

    /** A picture's blocks, and the slant of its lines. */
    static final class Piece {
        final List<Found> found = new ArrayList<>();
        float angle;
    }

    /**
     * One picture (or one slice of a tall one), read.
     *
     * Japanese and Chinese set in columns are read twice: once to find where
     * the columns are, and again with their characters laid out as lines
     * (VerticalLayout), which the recogniser reads far better than columns.
     */
    private Piece readPiece(TextRecognizer recogniser, String script, Bitmap bitmap, Steps steps) throws Exception {
        Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(bitmap, 0)));
        Piece piece = new Piece();
        List<Found> out = piece.found;
        List<Text.TextBlock> blocks = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) if (block.getBoundingBox() != null) blocks.add(block);
        piece.angle = slant(blocks);
        boolean columns = steps.columns && ("japanese".equals(script) || "chinese".equals(script));
        if (!columns) {
            for (Text.TextBlock block : blocks) out.add(steps.closer ? closer(recogniser, bitmap, block) : plain(block));
            return piece;
        }
        List<List<Text.TextBlock>> groups = bubbles(blocks);
        for (List<Text.TextBlock> bubble : groups) {
            // Where the page's other text is, so that columns of theirs
            // are not taken in by this one.
            List<VerticalLayout.Box> others = new ArrayList<>();
            for (List<Text.TextBlock> other : groups) {
                if (other == bubble) continue;
                for (Text.TextBlock block : other) {
                    Rect r = block.getBoundingBox();
                    others.add(new VerticalLayout.Box(r.left, r.top, r.right, r.bottom));
                }
            }
            Found found = null;
            try {
                found = readColumns(recogniser, bitmap, bubble, others, steps);
            } catch (Exception e) {
                Log.w(TAG, "Could not lay the columns out", e);
            }
            if (found != null) out.add(found);
            else for (Text.TextBlock block : bubble) out.add(steps.closer ? closer(recogniser, bitmap, block) : plain(block));
        }
        return piece;
    }

    private static Found plain(Text.TextBlock block) {
        Found found = new Found();
        found.text = block.getText();
        found.box = new Rect(block.getBoundingBox());
        for (Text.Line line : block.getLines()) {
            found.lines.add(line.getText());
            found.raw.add(line.getText());
        }
        found.confidence = confidence(block);
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
                found.source = "closer";
                StringBuilder all = new StringBuilder();
                float least = -1;
                for (Text.Line l : lines) {
                    found.lines.add(l.getText());
                    found.raw.add(l.getText());
                    if (all.length() > 0) all.append('\n');
                    all.append(l.getText());
                    float c = confidence(l);
                    least = c < 0 || least == -2 ? -2 : (least < 0 ? c : Math.min(least, c));
                }
                found.confidence = least < 0 ? -1 : least;
                found.text = all.toString();
                // Kept when it has as much of the text, and -- where the
                // recogniser says how sure it is -- is no less sure.
                if (letters(found.text) < letters(first.text) * 0.6f) return first;
                if (found.confidence >= 0 && first.confidence >= 0 && found.confidence + 0.02f < first.confidence) {
                    return first;
                }
                return found;
            } finally {
                big.recycle();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read the block again", e);
            return first;
        }
    }

    /** Kana, kanji and hangul: what a page of manga or manhwa is written in. */
    private static int ownLetters(String text) {
        if (text == null) return 0;
        int n = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x3400 && c <= 0x4DBF)
                    || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF)) n++;
        }
        return n;
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
                                     List<Text.TextBlock> bubble,
                                     List<VerticalLayout.Box> others, Steps steps) throws Exception {
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
        }, units, others);
        if (sheet == null) return null;

        // Read from the patch cleaned of the drawing; and, where that reading
        // is not plainly sure, again from the patch as drawn -- cleaning can
        // take a stroke with the drawing. The surer of the two is kept.
        // (A sure reading is not read twice: that only costs time.)
        Sheeted cleaned = readSheet(recogniser, sheet, sheet.source);
        boolean doubtful = cleaned.columns.isEmpty() || cleaned.confidence < SURE_ENOUGH;
        Sheeted drawn = steps.compare && doubtful ? readSheet(recogniser, sheet, sheet.original) : null;
        Sheeted chosen = cleaned;
        if (drawn != null && !drawn.columns.isEmpty()) {
            if (cleaned.columns.isEmpty()) chosen = drawn;
            else if (cleaned.confidence >= 0 && drawn.confidence >= 0) {
                if (drawn.confidence > cleaned.confidence + 0.03f) chosen = drawn;
            } else if (ownLetters(drawn.joined()) > ownLetters(cleaned.joined()) * 1.15f) {
                chosen = drawn;
            }
        }
        List<String> columns = chosen.columns;
        if (columns.isEmpty()) return null;
        // Lettering the cleaning took for the drawing (drawn across a
        // door frame, say) is lost from the sheet; when much is lost,
        // the first reading, muddled as it may be, has more of the text.
        // Counted in the script's own characters only: a muddled first
        // reading is full of stray Latin letters, and those are no text.
        int before = 0;
        for (Text.TextBlock block : bubble) before += ownLetters(block.getText());
        int after = ownLetters(chosen.joined());
        if (after < before * 0.6f) return null;
        Found found = new Found();
        found.vertical = true;
        found.box = whole;
        found.lines.addAll(columns);
        found.raw.addAll(chosen.raw);
        found.text = chosen.joined();
        found.confidence = chosen.confidence;
        found.source = "columns";
        if (drawn != null) found.agree = cleaned.joined().equals(drawn.joined());
        return found;
    }

    /** Certainty above which a reading is not checked by reading it again.
     *  (The recogniser's certainty is a guide, not a promise.) */
    private static final float SURE_ENOUGH = 0.8f;

    /** What one sheet came to: its columns, as read and tidied. */
    static final class Sheeted {
        final List<String> columns = new ArrayList<>();
        final List<String> raw = new ArrayList<>();
        float confidence = -1;

        String joined() {
            StringBuilder out = new StringBuilder();
            for (String c : columns) out.append(c);
            return out.toString();
        }
    }

    /** The sheet drawn from the given pixels (the patch cleaned, or as it
     *  was) and read. */
    private static Sheeted readSheet(TextRecognizer recogniser, VerticalLayout.Sheet sheet, int[] pixels)
            throws Exception {
        Sheeted out = new Sheeted();
        if (pixels == null) return out;
        Bitmap page = Bitmap.createBitmap(Math.max(1, sheet.width), Math.max(1, sheet.height), Bitmap.Config.ARGB_8888);
        Bitmap source = Bitmap.createBitmap(pixels, sheet.sourceWidth, sheet.sourceHeight, Bitmap.Config.ARGB_8888);
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
            float least = -1;
            boolean known = true;
            for (Text.TextBlock block : text.getTextBlocks()) {
                for (Text.Line line : block.getLines()) {
                    Rect r = line.getBoundingBox();
                    if (r == null) continue;
                    lines.add(new VerticalLayout.Read(line.getText(),
                            new VerticalLayout.Box(r.left, r.top, r.right, r.bottom)));
                    float c = confidence(line);
                    if (c < 0) known = false;
                    else least = least < 0 ? c : Math.min(least, c);
                }
            }
            out.columns.addAll(VerticalLayout.columnTexts(sheet, lines));
            out.raw.addAll(VerticalLayout.columnTextsRaw(sheet, lines));
            out.confidence = known ? least : -1;
            return out;
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
            JSONArray raw = new JSONArray();
            for (String line : block.raw) raw.put(line);
            out.put("raw", raw);
            if (block.confidence >= 0) out.put("confidence", block.confidence);
            out.put("source", block.source);
            if (block.agree != null) out.put("agree", block.agree.booleanValue());
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
