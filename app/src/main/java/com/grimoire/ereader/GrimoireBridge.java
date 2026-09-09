package com.grimoire.ereader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * The only native surface exposed to the reader. Everything here is callable
 * from JS as window.GrimoireNative.*
 *
 * Keep this small. Every method added here is attack surface, and anything that
 * touches user files must stay read-only.
 */
public class GrimoireBridge {

    private static final String TAG = "GrimoireBridge";

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final Activity activity;
    private final WebView webView;

    GrimoireBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /**
     * Hand a file to whatever the person wants to do with it.
     *
     * A WebView has no download handling at all -- no DownloadListener means
     * an <a download> click is simply ignored, which is why the export
     * buttons appeared to do nothing. So the text is written to the app's own
     * cache and offered through the share sheet, where it can be saved to
     * Files, sent somewhere, or opened. Nothing is written outside the app
     * unless the person chooses to, and no permission is involved.
     */
    @JavascriptInterface
    public boolean saveText(String name, String mimeType, String content) {
        try {
            File dir = new File(activity.getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) return false;

            // Whatever the page asked for, this only ever writes one file in
            // one directory: a name is a name, not a path.
            String safe = new File(name == null ? "export.txt" : name).getName();
            File file = new File(dir, safe);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
            }

            Uri uri = FileProvider.getUriForFile(
                    activity, activity.getPackageName() + ".files", file);

            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeType == null ? "text/plain" : mimeType);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_TITLE, safe);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(send, "Save " + safe));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Could not offer " + name + " for saving", e);
            return false;
        }
    }

    @JavascriptInterface
    public String platform() {
        return "android";
    }

    @JavascriptInterface
    public String versionName() {
        return BuildConfig.VERSION_NAME;
    }

    @JavascriptInterface
    public int versionCode() {
        return BuildConfig.VERSION_CODE;
    }

    /** Read an imported book the user picked, as base64. Read-only, no writes. */
    /**
     * What killed the app last time, if anything did.
     *
     * Read once and cleared, so it is reported on the next launch and not
     * every launch after that.
     */
    @JavascriptInterface
    public String lastCrash() {
        try {
            File file = GrimoireApp.crashFile(activity);
            if (!file.exists()) return null;
            byte[] bytes = new byte[(int) Math.min(file.length(), 8192)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                int read = in.read(bytes);
                if (read <= 0) return null;
                return new String(bytes, 0, read, StandardCharsets.UTF_8);
            } finally {
                // Deleted whether or not it could be read: a report that
                // cannot be read is not worth showing every time.
                if (!file.delete()) Log.w(TAG, "Could not clear the crash report");
            }
        } catch (Throwable e) {
            Log.w(TAG, "Could not read the crash report", e);
            return null;
        }
    }

    /** The reader has booted and can take a file handed to it from outside. */
    @JavascriptInterface
    public void ready() {
        // Typed loosely here, so a file handed over before the page loaded is
        // delivered rather than dropped.
        if (activity instanceof MainActivity) {
            final MainActivity host = (MainActivity) activity;
            activity.runOnUiThread(host::onReaderReady);
        }
    }

    /**
     * The name the file actually has.
     *
     * A content:// URI's last path segment is a document id -- "msf:1234" or
     * an encoded tree path -- not a filename. Taking it for one meant the
     * reader saw no extension, could not tell what the file was, and refused
     * it. The provider knows the real name; it only has to be asked.
     */
    @JavascriptInterface
    public String displayName(String uriString) {
        try {
            Uri uri = Uri.parse(uriString);
            try (Cursor cursor = activity.getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read the name of " + uriString, e);
        }
        return null;
    }

    /**
     * Read a file handed to the app from elsewhere.
     *
     * Asynchronous, because this used to be a blocking call returning the
     * whole file as base64: JavaScript sat waiting for it and the app looked
     * frozen for as long as the read took.
     */
    @JavascriptInterface
    public void readContentUri(final String requestId, final String uriString) {
        io.execute(() -> {
            try {
                Uri uri = Uri.parse(uriString);

                // Asked before reading. The provider usually knows the size,
                // and refusing up front costs nothing where reading to find
                // out costs everything.
                long declared = declaredSize(uri);
                if (declared > MAX_HANDOFF_BYTES) {
                    settle(requestId, false, "TOO_LARGE");
                    return;
                }

                if (!"content".equals(uri.getScheme()) && !"file".equals(uri.getScheme())) {
                    settle(requestId, false, "That is not a file this app can open.");
                    return;
                }
                try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                    if (in == null) {
                        settle(requestId, false, "That file could not be opened.");
                        return;
                    }
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    long total = 0;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        // Base64 across the bridge costs a third again on top,
                        // so this is a real ceiling rather than a formality.
                        if (total > MAX_HANDOFF_BYTES) {
                            settle(requestId, false, "TOO_LARGE");
                            return;
                        }
                        out.write(buf, 0, n);
                    }
                    settle(requestId, true, Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                }
            } catch (OutOfMemoryError e) {
                // An Error, not an Exception: left uncaught it takes the whole
                // process down rather than this one read.
                Log.w(TAG, "Ran out of memory reading " + uriString, e);
                settle(requestId, false, "TOO_LARGE");
            } catch (Throwable e) {
                Log.w(TAG, "Could not read " + uriString, e);
                settle(requestId, false, "That file could not be read.");
            }
        });
    }

    /** What the provider says the file's size is, or -1 if it will not say. */
    private long declaredSize(Uri uri) {
        try (Cursor cursor = activity.getContentResolver()
                .query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getLong(0);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not measure " + uri, e);
        }
        return -1;
    }

    /* Deliberately well below what the phone could hold.
     *
     * A file crossing this bridge is held three times over at the peak: the
     * bytes read out of the provider, the base64 string built from them, and
     * the array JavaScript decodes it back into. Ninety-six megabytes of book
     * therefore meant well over two hundred in flight, and the read thread
     * died of it -- taking the process with it, which from the outside looked
     * like the app opening and immediately going away again.
     */
    private static final long MAX_HANDOFF_BYTES = 32L * 1024 * 1024;

    /** Answers an asynchronous call, the same way the translation bridge does. */
    private void settle(String requestId, boolean ok, String payload) {
        final String js = "window.Grimoire && window.Grimoire.settleFile("
                + JSONObject.quote(requestId) + "," + ok + "," + JSONObject.quote(payload) + ")";
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    @JavascriptInterface
    public void keepScreenOn(final boolean on) {
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    @JavascriptInterface
    public void shareText(final String text) {
        activity.runOnUiThread(() -> {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            activity.startActivity(Intent.createChooser(send, null));
        });
    }
}
