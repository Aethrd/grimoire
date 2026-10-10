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

    /**
     * Read a picked file from this side, because the page could not read it.
     *
     * The page is handed a File by the WebView and never learns which URI it
     * came from, so when the renderer is refused the file descriptor -- the
     * NotReadableError the page reports -- it has nothing to retry with. This
     * is the retry: the activity still holds the grant, so it copies the file
     * into the app's own storage and answers with a URL the page can simply
     * fetch.
     *
     * Asynchronous on purpose. A bridge method runs on a binder thread and
     * the page waits on its return value, so copying a six-hundred-megabyte
     * volume inside one would stall the renderer for the length of the copy.
     */
    @JavascriptInterface
    public void stageForRead(String id, String name, double size) {
        if (!(activity instanceof MainActivity)) return;
        ((MainActivity) activity).stageForRead(id, name, (long) size);
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

    /* ── writing files out ───────────────────────────────────────────────
     *
     * A file is staged in pieces and then handed to the system.
     *
     * Sending it across in one go means holding the whole thing three times
     * over -- the bytes, the base64 built from them, and what Java decodes
     * back out of it -- which is what killed the app when files came the other
     * way. So the reader sends a few megabytes at a time and this appends
     * them to a file on disk, which costs a buffer however large the book is.
     */

    /** Start a file. Returns the name to send the pieces under. */
    @JavascriptInterface
    public String beginExport(String name) {
        try {
            File dir = new File(activity.getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) return null;
            String safe = new File(name == null ? "export" : name).getName();
            File file = new File(dir, safe);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return safe;
        } catch (Throwable e) {
            Log.w(TAG, "Could not start an export", e);
            return null;
        }
    }

    /** Add a piece. Returns false if it could not be written. */
    @JavascriptInterface
    public boolean appendExport(String handle, String base64) {
        try {
            File file = new File(new File(activity.getCacheDir(), "exports"),
                    new File(handle).getName());
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(file, true)) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "Could not add to " + handle, e);
            return false;
        }
    }

    /**
     * Finish, and ask where to put it.
     *
     * Saving somewhere of the person's choosing, not only handing the file to
     * whatever app will take it: a backup belongs in a folder they can find
     * again, not in a chat thread.
     */
    @JavascriptInterface
    public void finishExport(String handle, String mimeType, boolean share) {
        final File file = new File(new File(activity.getCacheDir(), "exports"),
                new File(handle).getName());
        if (!file.exists()) {
            Log.w(TAG, "Nothing staged for " + handle);
            return;
        }
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).offerExport(file, mimeType, share);
        }
    }

    /**
     * Throw away the staged copy of a file handed over from elsewhere.
     *
     * Called once the reader has taken what it needs. The copy exists only to
     * be fetched over the asset origin, and a book-sized file left in private
     * storage for no reason is a book-sized file wasted.
     */
    @JavascriptInterface
    public void clearHandoff() {
        io.execute(() -> {
            java.io.File[] staged = MainActivity.handoffDir(activity).listFiles();
            if (staged == null) return;
            for (java.io.File file : staged) {
                if (!file.delete()) Log.w(TAG, "Could not clear " + file.getName());
            }
        });
    }

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
