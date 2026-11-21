package com.grimoire.ereader;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.pm.PackageManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.content.IntentFilter;
import android.os.Environment;
import android.provider.MediaStore;
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
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import java.util.concurrent.Executors;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
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

    /**
     * How many books the library held when last drawn, kept outside the web
     * storage (in the app's own preferences), so that a library that opens
     * empty can be told from one that is empty. Tonight's scare: after a
     * crash the shelf came up empty with the default look, and four minutes
     * later every book was back. -1 when never marked.
     */
    @JavascriptInterface
    public int libraryMark() {
        return activity.getSharedPreferences("library", Activity.MODE_PRIVATE).getInt("books", -1);
    }

    @JavascriptInterface
    public void markLibrary(int books) {
        activity.getSharedPreferences("library", Activity.MODE_PRIVATE).edit().putInt("books", Math.max(0, books)).apply();
    }

    /**
     * How much the library's own files hold on the phone, in bytes: the web
     * storage's folder, read from outside it. A library that opens empty with
     * gigabytes still here has not been lost; it has not opened. -1 if the
     * folder cannot be found.
     */
    @JavascriptInterface
    public long libraryOnDisk() {
        long total = -1;
        java.io.File data = new java.io.File(activity.getApplicationInfo().dataDir);
        for (String place : new String[] {"app_webview/Default/IndexedDB", "app_webview/IndexedDB"}) {
            java.io.File dir = new java.io.File(data, place);
            if (!dir.isDirectory()) continue;
            total = Math.max(0, total) + sizeOf(dir, 0);
        }
        return total;
    }

    private static long sizeOf(java.io.File file, int depth) {
        if (depth > 8) return 0;
        if (file.isFile()) return file.length();
        long sum = 0;
        java.io.File[] inside = file.listFiles();
        if (inside != null) for (java.io.File each : inside) sum += sizeOf(each, depth + 1);
        return sum;
    }

    /**
     * The whole app started again: a new process, so the web storage is
     * opened afresh. Reloading the page keeps the same process -- and the
     * same storage that would not open.
     */
    @JavascriptInterface
    public void restartApp() {
        activity.runOnUiThread(() -> {
            Intent again = activity.getPackageManager().getLaunchIntentForPackage(activity.getPackageName());
            if (again == null) return;
            Intent fresh = Intent.makeRestartActivityTask(again.getComponent());
            activity.startActivity(fresh);
            activity.finishAffinity();
            Runtime.getRuntime().exit(0);
        });
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

    /** Android's bar at the foot put away (a book open) or shown again (anywhere else). */
    @JavascriptInterface
    public void readingBars(boolean hide) {
        if (!(activity instanceof MainActivity)) return;
        final MainActivity host = (MainActivity) activity;
        activity.runOnUiThread(() -> host.setReadingBars(hide));
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

    /* ── the export pipe ──────────────────────────────────────────────────
     *
     * The bytes of a file being written out, posted from the page as they
     * are (an ArrayBuffer, by androidx.webkit's message listener) rather than
     * as base64 text through appendExport: no text made of them in the page,
     * none decoded here, and a third less to carry across. "to:<name>" says
     * which file the next piece is for; each piece is appended in order on a
     * thread of its own, and answered "ok" or "failed" once written, so the
     * page sends no faster than the file is written. */
    private final ExecutorService pipeWriter = Executors.newSingleThreadExecutor();
    private String pipeTarget = null;

    /** One message from the page's MythosPipe (MainActivity registers it, for this app's own origin). */
    void pipeMessage(WebMessageCompat message, boolean mainFrame, JavaScriptReplyProxy reply) {
        if (!mainFrame || message == null) return;
        if (message.getType() == WebMessageCompat.TYPE_STRING) {
            String data = message.getData();
            if (data != null && data.startsWith("to:")) pipeTarget = new File(data.substring(3)).getName();
            return;
        }
        if (message.getType() != WebMessageCompat.TYPE_ARRAY_BUFFER) return;
        final byte[] bytes = message.getArrayBuffer();
        final String target = pipeTarget;
        pipeWriter.execute(() -> {
            boolean ok = target != null && appendBytes(target, bytes);
            activity.runOnUiThread(() -> {
                try { reply.postMessage(ok ? "ok" : "failed"); } catch (Throwable e) { Log.w(TAG, "No answer to the pipe", e); }
            });
        });
    }

    private boolean appendBytes(String handle, byte[] bytes) {
        try {
            File file = new File(new File(activity.getCacheDir(), "exports"), new File(handle).getName());
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(file, true)) {
                out.write(bytes);
            }
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "Could not add to " + handle, e);
            return false;
        }
    }

    /**
     * How warm the phone is: Android's own thermal status (0 none, 1 light,
     * 2 moderate, 3 severe and up; -1 before Android 10) and the battery's
     * temperature in degrees C (-1 if unknown). Read when asked, from a
     * sticky broadcast -- nothing registered, nothing kept running.
     */
    @JavascriptInterface
    public String heat() {
        int status = -1;
        float celsius = -1f;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                PowerManager power = activity.getSystemService(PowerManager.class);
                if (power != null) status = power.getCurrentThermalStatus();
            }
        } catch (Throwable e) {
            Log.w(TAG, "No thermal status", e);
        }
        try {
            Intent battery = activity.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int tenths = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
                if (tenths != Integer.MIN_VALUE) celsius = tenths / 10f;
            }
        } catch (Throwable e) {
            Log.w(TAG, "No battery temperature", e);
        }
        return "{\"status\":" + status + ",\"celsius\":" + celsius + "}";
    }

    /** An export stopped before it was saved: its staged file deleted, nothing offered. */
    @JavascriptInterface
    public void discardExport(String handle) {
        if (handle == null) return;
        File file = new File(new File(activity.getCacheDir(), "exports"), new File(handle).getName());
        //noinspection ResultOfMethodCallIgnored
        file.delete();
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

    /* ── automatic backups ────────────────────────────────────────────────
     *
     * A folder chosen once and kept (the permission persisted), so a backup
     * can be written there later without asking: on a schedule, or when the
     * queue finishes. The newest few automatic ones are kept, the rest
     * removed; a backup saved by hand is never touched. */

    /** Ask for the folder. Answered in window.Grimoire.backupFolderChosen(name or null). */
    @JavascriptInterface
    public void chooseBackupFolder() {
        if (activity instanceof MainActivity) ((MainActivity) activity).chooseBackupFolder();
    }

    /** The chosen folder's name, or "" when there is none (or it can no longer be written). */
    @JavascriptInterface
    public String backupFolderName() {
        return activity instanceof MainActivity ? ((MainActivity) activity).backupFolderName() : "";
    }

    /** Write a staged backup into the folder, keeping the newest `keep` automatic ones.
     *  Answered in window.Grimoire.backupWritten(ok, message). */
    @JavascriptInterface
    public void writeBackup(String handle, int keep) {
        final File file = new File(new File(activity.getCacheDir(), "exports"), new File(handle).getName());
        if (activity instanceof MainActivity) ((MainActivity) activity).writeBackup(file, keep);
    }

    /** An export of many zips: its folder, asked for before it starts (exportSetFolderChosen). */
    @JavascriptInterface
    public void chooseExportSetFolder() {
        if (activity instanceof MainActivity) ((MainActivity) activity).chooseExportSetFolder();
    }

    /** One full zip of that export, saved into its folder now (exportPartSaved). */
    @JavascriptInterface
    public void saveExportPart(String handle, String mimeType, String reply) {
        final File file = new File(new File(activity.getCacheDir(), "exports"), new File(handle).getName());
        if (activity instanceof MainActivity) ((MainActivity) activity).saveExportPart(file, mimeType, reply);
    }

    /** The folder of an export cut off, if it can still be written to: its name, else "". */
    @JavascriptInterface
    public String exportSetFolderName() {
        return activity instanceof MainActivity ? ((MainActivity) activity).exportSetFolderName() : "";
    }

    /** That export over: its folder let go of. */
    @JavascriptInterface
    public void releaseExportSetFolder() {
        if (activity instanceof MainActivity) ((MainActivity) activity).releaseExportSetFolder();
    }


    /**
     * Finish several files at once -- an export in parts -- and ask once for a
     * folder to put them all in, not once per file.
     */
    @JavascriptInterface
    public void finishExportSet(String handles, String mimeType) {
        java.util.List<File> files = new java.util.ArrayList<>();
        try {
            org.json.JSONArray names = new org.json.JSONArray(handles);
            File dir = new File(activity.getCacheDir(), "exports");
            for (int i = 0; i < names.length(); i++) {
                File file = new File(dir, new File(names.getString(i)).getName());
                if (file.exists()) files.add(file);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read the parts of an export", e);
        }
        if (files.isEmpty()) {
            Log.w(TAG, "Nothing staged for an export in parts");
            return;
        }
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).offerExportSet(files, mimeType);
        }
    }

    /**
     * Finish a picture, straight into the phone's Pictures folder.
     *
     * Saving a picture is not like saving a book: it belongs where the gallery
     * will show it, and asking where to put each one is a chore. It goes into
     * Pictures/Grimoire through the media store, which needs no permission
     * from Android 10 on. Before that it would, and the app asks for none, so
     * there -- and for anything the media store will not take as a picture --
     * it is saved the ordinary way, by choosing where.
     */
    @JavascriptInterface
    public void saveToPictures(String handle, String mimeType) {
        final File file = new File(new File(activity.getCacheDir(), "exports"),
                new File(handle).getName());
        if (!file.exists()) {
            Log.w(TAG, "Nothing staged for " + handle);
            return;
        }
        if (!(activity instanceof MainActivity)) return;
        final MainActivity main = (MainActivity) activity;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            main.offerExport(file, mimeType, false);
            return;
        }
        io.execute(() -> intoPictures(main, file, mimeType));
    }

    /** Only reached on Android 10 and later; see saveToPictures. */
    @android.annotation.TargetApi(Build.VERSION_CODES.Q)
    private void intoPictures(MainActivity main, File file, String mimeType) {
        {
            ContentResolver resolver = activity.getContentResolver();
            Uri uri = null;
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, file.getName());
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + File.separator + "Mythos");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = resolver.insert(
                        MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
                if (uri == null) throw new java.io.IOException("The media store gave nowhere to write");
                try (InputStream in = new java.io.FileInputStream(file);
                     OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new java.io.IOException("Could not open the picture to write");
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                }
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                callReader("window.Grimoire.pictureSaved(" + JSONObject.quote(file.getName()) + ")");
            } catch (Throwable e) {
                Log.w(TAG, "Could not save " + file.getName() + " to Pictures", e);
                if (uri != null) {
                    try { resolver.delete(uri, null, null); } catch (Throwable ignored) { }
                }
                main.offerExport(file, mimeType, false);
            }
        }
    }

    private void callReader(String call) {
        final String js = "window.Grimoire && " + call;
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
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

    /* ── telling you a build is done ──────────────────────────────────
     *
     * A website of six hundred chapters takes an hour or two to download.
     * With "Notify me" turned on in Build, its end -- built, paused, or
     * stopped at a chapter the site would not give -- is a notification,
     * and a tap on it brings the app back. Nothing else is ever notified.
     */
    private static final String BUILD_CHANNEL = "builds";
    private static final int BUILD_NOTICE = 4201;
    /** The request code MainActivity's permission answer comes back with. */
    static final int ASK_TO_NOTIFY = 4202;

    /** Whether a notification would be shown: allowed, and not turned off. */
    @JavascriptInterface
    public boolean canNotify() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity,
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(activity).areNotificationsEnabled();
    }

    /** Ask Android for leave to notify (Android 13 on); the answer comes back
     *  to window.Grimoire.notifyAnswer. */
    @JavascriptInterface
    public void askToNotify() {
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity,
                    Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(activity,
                        new String[] { Manifest.permission.POST_NOTIFICATIONS }, ASK_TO_NOTIFY);
            } else {
                answerNotify();
            }
        });
    }

    /** Tell the page whether it may notify now. */
    void answerNotify() {
        final String js = "window.Grimoire && window.Grimoire.notifyAnswer && window.Grimoire.notifyAnswer("
                + canNotify() + ")";
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    /** Whether a build is under way: if Android reclaims the reader's memory
     *  meanwhile, the build goes with it, and that is what is said after. */
    static volatile boolean building = false;

    /* What the app was in the middle of, written down as it goes (each book
     * of an export), so that if it is cut off -- its page crashing, or
     * Android closing the whole app for memory, which leaves no other trace
     * -- the next start can say where it was. Cleared when the work ends. */
    static volatile String workingNow = null;

    @JavascriptInterface
    public void working(String what) {
        workingNow = (what == null || what.isEmpty()) ? null : what + " · " + memoryNow();
        activity.getSharedPreferences("work", Context.MODE_PRIVATE).edit().putString("now", workingNow).apply();
    }

    /** The app's own memory and the phone's free memory, as it is now: written down with each step of an export. */
    private String memoryNow() {
        try {
            Runtime runtime = Runtime.getRuntime();
            long java = (runtime.totalMemory() - runtime.freeMemory()) >> 20;
            long nativeHeap = android.os.Debug.getNativeHeapAllocatedSize() >> 20;
            android.app.ActivityManager manager = (android.app.ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
            android.app.ActivityManager.MemoryInfo info = new android.app.ActivityManager.MemoryInfo();
            if (manager != null) manager.getMemoryInfo(info);
            return "app " + java + "+" + nativeHeap + " MB, phone free " + (info.availMem >> 20) + " MB"
                    + (info.lowMemory ? " (low)" : "");
        } catch (Throwable e) {
            return "memory unknown";
        }
    }

    /**
     * Why Android says the app last ended, if it ended badly and recently:
     * closed for low memory, crashed (in Java or native code), stopped
     * responding, killed for another reason -- Android 11 and later keep it.
     * Null when it ended normally, or the phone does not say. Each exit is
     * reported once (by its time).
     */
    @JavascriptInterface
    public String lastExit() {
        if (Build.VERSION.SDK_INT < 30) return null;
        try {
            android.app.ActivityManager manager = (android.app.ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) return null;
            java.util.List<android.app.ApplicationExitInfo> exits =
                    manager.getHistoricalProcessExitReasons(activity.getPackageName(), 0, 5);
            android.content.SharedPreferences prefs = activity.getSharedPreferences("work", Context.MODE_PRIVATE);
            long seen = prefs.getLong("exitSeen", 0);
            for (android.app.ApplicationExitInfo exit : exits) {
                if (exit.getTimestamp() <= seen) break;
                /* The app itself only: Android also lists the helper processes
                 * it starts and ends as it likes (the reading page's sandboxed
                 * renderer, "isolated not needed"), which are not the app
                 * being closed, and were said as if they were. */
                if (!activity.getPackageName().equals(exit.getProcessName())) continue;
                String why;
                switch (exit.getReason()) {
                    case android.app.ApplicationExitInfo.REASON_LOW_MEMORY: why = "Android closed it to free memory (the phone ran low)"; break;
                    case android.app.ApplicationExitInfo.REASON_CRASH: why = "it crashed (in the app's Java code)"; break;
                    case android.app.ApplicationExitInfo.REASON_CRASH_NATIVE: why = "it crashed (in native code)"; break;
                    case android.app.ApplicationExitInfo.REASON_ANR: why = "it stopped responding, and Android closed it"; break;
                    case android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: why = "Android closed it for using too much of the phone"; break;
                    // Signalled, "other", frozen: how Android ends an app it is done with in the
                    // background, or one swiped away -- ordinary, so nothing to say.
                    default: continue;   // asked to, updated, or a normal exit: nothing to say
                }
                prefs.edit().putLong("exitSeen", exits.get(0).getTimestamp()).apply();
                String said = exit.getDescription();
                return why + " at " + new java.text.SimpleDateFormat("h:mm a", java.util.Locale.getDefault())
                        .format(new java.util.Date(exit.getTimestamp()))
                        + " · it was using " + (exit.getPss() >> 10) + " MB"
                        + (said == null || said.isEmpty() ? "" : " · " + said);
            }
            if (!exits.isEmpty()) prefs.edit().putLong("exitSeen", exits.get(0).getTimestamp()).apply();
        } catch (Throwable e) {
            Log.w(TAG, "No exit reasons", e);
        }
        return null;
    }

    /** What was under way when the app was last cut off, once; null if it finished. */
    @JavascriptInterface
    public String cutOff() {
        android.content.SharedPreferences prefs = activity.getSharedPreferences("work", Context.MODE_PRIVATE);
        String was = prefs.getString("now", null);
        prefs.edit().remove("now").apply();
        workingNow = null;
        return was;
    }

    @JavascriptInterface
    public void buildRunning(final boolean running) {
        building = running;
    }

    /** One notification for a build's end; a newer one takes its place. */
    @JavascriptInterface
    public void notify(final String title, final String text) {
        if (!canNotify()) return;
        try {
            NotificationManager manager = activity.getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26 && manager != null) {
                NotificationChannel channel = new NotificationChannel(
                        BUILD_CHANNEL, "Builds", NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("When a book being built is done, paused or stopped");
                manager.createNotificationChannel(channel);
            }
            Intent open = new Intent(activity, MainActivity.class)
                    .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent tap = PendingIntent.getActivity(activity, 0, open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            String body = text == null ? "" : text;
            NotificationCompat.Builder notice = new NotificationCompat.Builder(activity, BUILD_CHANNEL)
                    .setSmallIcon(R.mipmap.ic_launcher_monochrome)
                    .setContentTitle(title == null ? "Mythos" : title)
                    .setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setContentIntent(tap)
                    .setAutoCancel(true);
            NotificationManagerCompat.from(activity).notify(BUILD_NOTICE, notice.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Not allowed to notify", e);
        }
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
