package com.grimoire.ereader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
            Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(bitmap, 0)));
            addBlocks(text, 0, 0, height, blocks, all);
        } else {
            int step = Math.max(1, Math.round(slice * (1 - OVERLAP)));
            for (int top = 0; top < height; top += step) {
                int bottom = Math.min(height, top + slice);
                Bitmap piece = Bitmap.createBitmap(bitmap, 0, top, width, bottom - top);
                try {
                    Text text = Tasks.await(recogniser.process(InputImage.fromBitmap(piece, 0)));
                    // Each slice keeps the lines that start in its own part;
                    // the overlap is the next slice's.
                    int ownTop = top == 0 ? 0 : top + Math.round(slice * OVERLAP / 2);
                    int ownBottom = bottom >= height ? height : top + step + Math.round(slice * OVERLAP / 2);
                    addBlocks(text, top, ownTop, ownBottom, blocks, all);
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

    private static void addBlocks(Text text, int offset, int ownTop, int ownBottom,
                                  JSONArray blocks, StringBuilder all) throws Exception {
        for (Text.TextBlock block : text.getTextBlocks()) {
            Rect box = block.getBoundingBox();
            if (box == null) continue;
            int top = box.top + offset;
            if (top < ownTop || top >= ownBottom) continue;
            JSONObject out = new JSONObject();
            out.put("text", block.getText());
            out.put("x", box.left);
            out.put("y", top);
            out.put("w", box.width());
            out.put("h", box.height());
            JSONArray lines = new JSONArray();
            for (Text.Line line : block.getLines()) lines.put(line.getText());
            out.put("lines", lines);
            blocks.put(out);
            all.append(block.getText()).append("\n\n");
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
