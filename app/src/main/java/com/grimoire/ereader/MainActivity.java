package com.grimoire.ereader;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import java.io.File;
import java.io.InputStream;

import org.json.JSONObject;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

public class MainActivity extends AppCompatActivity {

    private static final String TAG = "Grimoire";

    /** Virtual origin the bundled reader is served from. */
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html";

    private WebView webView;

    /** A file handed over before the page was ready to take it. */
    private GrimoireBridge bridge;
    /** The downloader's: its shown site is closed by the back gesture first. */
    private WebBridge webBridge;
    private String pendingUri;
    private final java.util.concurrent.ExecutorService staging =
            java.util.concurrent.Executors.newSingleThreadExecutor();
    private boolean readerReady;
    private WebViewAssetLoader assetLoader;
    private boolean contentReady = false;

    private ValueCallback<Uri[]> pendingFileCallback;
    private ActivityResultLauncher<String[]> filePicker;


    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        // Hold the splash until the reader has painted its first frame, so the
        // user never sees a white flash between the system splash and the app.
        splash.setKeepOnScreenCondition(() -> !contentReady);

        filePicker = registerForActivityResult(
                new ActivityResultContracts.OpenMultipleDocuments(),
                uris -> {
                    if (pendingFileCallback == null) return;
                    Uri[] result = (uris == null || uris.isEmpty())
                            ? null
                            : uris.toArray(new Uri[0]);
                    /* Kept, so the file can be read from this side if the
                     * WebView cannot read it from its own.
                     *
                     * The renderer is a separate sandboxed process and is
                     * handed a file descriptor rather than the grant itself;
                     * when that descriptor is refused -- a provider that
                     * backs the file with a download, a grant the renderer
                     * did not inherit -- the page sees NotReadableError while
                     * this process can still open the very same URI. Without
                     * the URI kept here there is nothing to retry with: the
                     * page is given a File and never learns where it came
                     * from. */
                    if (result != null) {
                        remember(result);
                        for (Uri uri : result) {
                            try {
                                getContentResolver().takePersistableUriPermission(
                                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            } catch (SecurityException ignored) {
                                // Not all providers grant persistable access; the
                                // one-shot read is still valid for this session.
                            }
                        }
                    }
                    pendingFileCallback.onReceiveValue(result);
                    pendingFileCallback = null;
                });

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                /* Files handed over from elsewhere are served, not passed.
                 *
                 * They used to cross the JavaScript bridge as base64, which
                 * holds the whole file three times over at the peak -- the
                 * bytes, the string built from them, and the array decoded
                 * back out of it. A book of any size died of that. Staged on
                 * disk and fetched over this origin, it streams instead, and
                 * the size ceiling goes away with it. */
                .addPathHandler("/handoff/",
                        new WebViewAssetLoader.InternalStoragePathHandler(this, handoffDir(this)))
                .build();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        configureWebView();
        applyInsetsToCss();
        installBackHandler();

        restoreStagedExport(savedInstanceState);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }

        /* Only a book that has just been sent here is opened.
         *
         * Android hands an activity the intent it was first started with for
         * as long as its task lives. Opened from a file manager once, the app
         * was given that same file again every time it was opened from recent
         * apps -- after the book had been closed, and after the app had been
         * closed -- and every time Android rebuilt it after reclaiming its
         * memory. Each of those opened the book again. A relaunch from recents
         * says so in its flags, and a rebuild has saved state; neither is a
         * file being sent, so neither opens one. */
        if (savedInstanceState == null && !launchedFromHistory(getIntent())) {
            handleIncomingIntent(getIntent());
        }
    }

    private static boolean launchedFromHistory(@Nullable Intent intent) {
        return intent != null
                && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
    }

    /* Build the WebView again after its renderer died.
     *
     * The dead one is taken out of the layout and destroyed before the new
     * one goes in: leaving it attached keeps a zombie view on screen and its
     * JavaScript bridges alive, which is worse than the crash. Everything the
     * new view needs is set up by the same two calls as at launch, so there is
     * no second configuration path to keep in step with the first.
     */
    private void rebuildWebView() {
        WebView dead = webView;

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        contentReady = false;
        // A new page, not ready until it says so: anything sent before then
        // is held (see tellReader) rather than lost on a half-loaded page.
        readerReady = false;
        configureWebView();
        applyInsetsToCss();
        webView.loadUrl(START_URL);

        if (dead != null) {
            if (dead.getParent() instanceof ViewGroup) {
                ((ViewGroup) dead.getParent()).removeView(dead);
            }
            dead.destroy();
        }
    }

    /** Said once the page is up, because before that there is nowhere to say it. */
    @Nullable
    private String pendingNotice;

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage for library + progress
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);           // assets come via the loader, not file://
        s.setAllowContentAccess(true);         // content:// for imported books
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);                    // the reader controls its own type scale

        // Let the WebView follow the system light/dark setting without the page
        // having to opt in. The reader's own CSS media query still wins if it
        // defines a dark theme.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, true);
        }

        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        bridge = new GrimoireBridge(this, webView);
        webView.addJavascriptInterface(bridge, "GrimoireNative");
        // Kept in its own object because it is the only thing in the app that
        // touches the network, and it should be obvious where that boundary is.
        webView.addJavascriptInterface(new TranslateBridge(this, webView), "GrimoireTranslate");
        // The downloader's, kept apart for the same reason: it reaches the
        // network, and only for an address the reader was given.
        webBridge = new WebBridge(this, webView);
        webView.addJavascriptInterface(webBridge, "GrimoireWeb");
        // Reading text out of pictures, on the phone: nothing leaves it.
        webView.addJavascriptInterface(new OcrBridge(this, webView), "GrimoireOcr");
        CookieManager.getInstance().setAcceptCookie(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (ORIGIN.equals(url.getScheme() + "://" + url.getHost())) {
                    return false; // in-app navigation
                }
                // Anything external opens in the browser, never inside the reader.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception e) {
                    Log.w(TAG, "No handler for " + url, e);
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                contentReady = true;
                pushInsets(lastInsets, keyboardUp());
                if (pendingNotice != null) {
                    tellReader("window.Grimoire.notice(" + JSONObject.quote(pendingNotice) + ")");
                    pendingNotice = null;
                }
            }

            /* The renderer died, and the app did not have to.
             *
             * The whole app is one WebView, and when its render process is
             * killed -- by the system reclaiming memory, or by the renderer
             * itself crashing on a very large book -- the view is left dead.
             * Without this the default behaviour is to take the whole process
             * down with it, which from the outside is the app vanishing while
             * somebody was reading.
             *
             * A dead WebView cannot be revived, so the old one is destroyed
             * and a new one built in its place. That costs the current page
             * and nothing else: the library, the reading positions and the
             * marks are all in IndexedDB, so the new view opens on the shelf
             * with everything still there.
             */
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && detail != null && detail.didCrash();
                Log.w(TAG, crashed
                        ? "Render process crashed; rebuilding the WebView"
                        : "Render process killed by the system; rebuilding the WebView");

                if (view != webView) {
                    // A view we have already replaced. Let it go.
                    view.destroy();
                    return true;
                }

                // Said on the way back in, because by then there is something
                // to say it in.
                // A build under way lived in that renderer, and went with it.
                pendingNotice = GrimoireBridge.building
                        ? "Android reclaimed the app's memory during a build, which stopped it. "
                          + "Build again: where a website got to is not kept from a build that was cut off."
                        : crashed
                        ? "The reader ran out of room and restarted. Nothing was lost."
                        : "Android reclaimed the reader's memory. Nothing was lost.";
                GrimoireBridge.building = false;
                rebuildWebView();
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                // accept="" often carries extensions (".epub"); the document
                // picker only understands MIME types, so drop anything else.
                java.util.List<String> mime = new java.util.ArrayList<>();
                String[] accepted = params.getAcceptTypes();
                if (accepted != null) {
                    for (String t : accepted) {
                        if (t != null && t.contains("/")) mime.add(t.trim());
                    }
                }
                if (mime.isEmpty()) {
                    mime.add("application/epub+zip");
                    mime.add("application/pdf");
                    mime.add("text/plain");
                }
                String[] types = mime.toArray(new String[0]);
                try {
                    filePicker.launch(types);
                } catch (Exception e) {
                    pendingFileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(@NonNull ConsoleMessage m) {
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                }
                return true;
            }
        });

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    private Insets lastInsets = Insets.NONE;

    /**
     * The activity draws edge to edge, so the reader needs to know where the
     * status bar, gesture bar and any display cutout are. We expose them as CSS
     * custom properties; env(safe-area-inset-*) is unreliable in WebView.
     */
    private WindowInsetsCompat lastWindowInsets;

    private void applyInsetsToCss() {
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            lastWindowInsets = windowInsets;
            pushFrom(windowInsets);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    /* The bars and cutout always; the keyboard only while this window has the
     * focus -- in split screen the keyboard moved to the app beside it left its
     * height here, stale, and the tab bar stood a keyboard's height up over an
     * empty space. A window without the focus has no keyboard of its own. */
    private void pushFrom(WindowInsetsCompat windowInsets) {
        Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        boolean ime = windowInsets.isVisible(WindowInsetsCompat.Type.ime()) && hasWindowFocus();
        if (ime) bars = Insets.max(bars, windowInsets.getInsets(WindowInsetsCompat.Type.ime()));
        lastInsets = bars;
        pushInsets(bars, ime);
    }

    /** The focus come or gone (split screen, a dialog, the notification shade): the keyboard counted again. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (webView == null) return;
        if (lastWindowInsets != null) pushFrom(lastWindowInsets);
        ViewCompat.requestApplyInsets(webView);
    }

    /* With them, whether the keyboard shows -- and the last moment it did
     * (GrimoireImeAt), for the page to tell a back that slipped past the
     * keyboard (Samsung's clipboard, as its items are deleted, hides it for a
     * moment) from one meant for the screen. */
    private void pushInsets(Insets i, boolean ime) {
        if (webView == null) return;
        float d = getResources().getDisplayMetrics().density;
        String js = String.format(
                java.util.Locale.US,
                "(function(){var r=document.documentElement.style;" +
                        "var ime=%b;if(ime||window.GrimoireIme)window.GrimoireImeAt=Date.now();window.GrimoireIme=ime;" +
                        "r.setProperty('--safe-top','%.1fpx');" +
                        "r.setProperty('--safe-right','%.1fpx');" +
                        "r.setProperty('--safe-bottom','%.1fpx');" +
                        "r.setProperty('--safe-left','%.1fpx');" +
                        "window.dispatchEvent(new CustomEvent('grimoire:insets'));})();",
                ime, i.top / d, i.right / d, i.bottom / d, i.left / d);
        webView.evaluateJavascript(js, null);
    }

    /* ── writing files out ────────────────────────────────────────────────
     *
     * Either to a place the person picks, or to whatever app will take it.
     * The first is what "export" usually means and what was missing: a backup
     * belongs somewhere findable, not only in a share sheet.
     */

    private static final int PICK_EXPORT_TARGET = 4301;
    /** An export in parts: one folder asked for, every part written into it. */
    private static final int PICK_EXPORT_FOLDER = 4302;
    /** Automatic backups: the folder they go into, chosen once and kept. */
    private static final int PICK_BACKUP_FOLDER = 4303;
    private static final String BACKUP_TREE = "backupTree";
    /** Only these are an automatic backup's, and only these are ever removed. */
    private static final String AUTO_BACKUP_PREFIX = "quire-backup-auto-";
    private static final String STAGED_SET = "stagedSet";
    private java.util.List<File> stagedSet = new java.util.ArrayList<>();
    private String stagedSetType;
    private File staged;
    private String stagedType;

    /* Kept somewhere that outlives this activity.
     *
     * Picking where to save opens another app, and while it is open Android
     * is free to shut Grimoire down -- which it does readily after a large
     * export, the largest thing the app ever holds in memory. The choice then
     * comes back to a fresh copy of the activity that had never heard of the
     * file, and was dropped without a word: the person was left in the file
     * picker, and nothing was saved. The file itself is on disk throughout,
     * so remembering where it is, across that restart, is all it takes. */
    private static final String STAGED_PATH = "grimoire.stagedExport";
    private static final String STAGED_TYPE = "grimoire.stagedExportType";

    private void rememberStaged(@Nullable File file, @Nullable String type) {
        staged = file;
        stagedType = type;
        getSharedPreferences("exports", MODE_PRIVATE).edit()
                .putString(STAGED_PATH, file == null ? null : file.getAbsolutePath())
                .putString(STAGED_TYPE, type)
                .apply();
    }

    private void restoreStagedExport(@Nullable Bundle state) {
        String path = state != null ? state.getString(STAGED_PATH) : null;
        String type = state != null ? state.getString(STAGED_TYPE) : null;
        if (path == null) {
            android.content.SharedPreferences prefs = getSharedPreferences("exports", MODE_PRIVATE);
            path = prefs.getString(STAGED_PATH, null);
            type = prefs.getString(STAGED_TYPE, null);
        }
        if (path != null && new File(path).exists()) {
            staged = new File(path);
            stagedType = type;
        }
    }

    void offerExport(File file, String mimeType, boolean share) {
        runOnUiThread(() -> {
            if (share) {
                try {
                    Uri uri = androidx.core.content.FileProvider.getUriForFile(
                            this, getPackageName() + ".files", file);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(mimeType);
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(send, "Send " + file.getName()));
                } catch (Exception e) {
                    Log.w(TAG, "Could not share " + file.getName(), e);
                }
                return;
            }

            rememberStaged(file, mimeType);
            Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            create.addCategory(Intent.CATEGORY_OPENABLE);
            create.setType(mimeType);
            create.putExtra(Intent.EXTRA_TITLE, file.getName());
            try {
                startActivityForResult(create, PICK_EXPORT_TARGET);
            } catch (Exception e) {
                Log.w(TAG, "No document picker available", e);
                tellReader("window.Grimoire.exportFailed("
                        + JSONObject.quote("This phone has no file picker to save with") + ")");
            }
        });
    }

    /** The parts of an export, kept should Android close the app while the folder is being chosen. */
    private void rememberSet(java.util.List<File> files, @Nullable String type) {
        stagedSet = new java.util.ArrayList<>(files);
        stagedSetType = type;
        StringBuilder paths = new StringBuilder();
        for (File file : files) paths.append(file.getAbsolutePath()).append('\n');
        getSharedPreferences("exports", MODE_PRIVATE).edit()
                .putString(STAGED_SET, files.isEmpty() ? null : paths.toString())
                .putString(STAGED_SET + "Type", type)
                .apply();
    }

    private void restoreSet() {
        android.content.SharedPreferences prefs = getSharedPreferences("exports", MODE_PRIVATE);
        String paths = prefs.getString(STAGED_SET, null);
        stagedSet = new java.util.ArrayList<>();
        if (paths != null) {
            for (String path : paths.split("\n")) {
                if (!path.isEmpty() && new File(path).exists()) stagedSet.add(new File(path));
            }
        }
        stagedSetType = prefs.getString(STAGED_SET + "Type", "application/zip");
    }

    /** Several files: a folder chosen once, and each written into it under its own name. */
    void offerExportSet(java.util.List<File> files, String mimeType) {
        runOnUiThread(() -> {
            rememberSet(files, mimeType);
            Intent tree = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            tree.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                startActivityForResult(tree, PICK_EXPORT_FOLDER);
            } catch (Exception e) {
                Log.w(TAG, "No folder picker available", e);
                tellReader("window.Grimoire.exportFailed("
                        + JSONObject.quote("This phone has no folder picker to save with") + ")");
            }
        });
    }

    private void savedSetInto(@Nullable Uri tree) {
        if (stagedSet.isEmpty()) restoreSet();
        final java.util.List<File> files = new java.util.ArrayList<>(stagedSet);
        final String type = stagedSetType == null ? "application/zip" : stagedSetType;
        rememberSet(new java.util.ArrayList<>(), null);
        if (tree == null) {
            for (File file : files) //noinspection ResultOfMethodCallIgnored
                file.delete();
            tellReader("window.Grimoire.exportFailed(" + JSONObject.quote("Not saved — no folder was chosen") + ")");
            return;
        }
        staging.execute(() -> {
            int saved = 0;
            String failed = null;
            try {
                Uri folder = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,
                        android.provider.DocumentsContract.getTreeDocumentId(tree));
                for (File file : files) {
                    try {
                        Uri doc = android.provider.DocumentsContract.createDocument(
                                getContentResolver(), folder, type, file.getName());
                        if (doc == null) throw new java.io.IOException("the folder would not take it");
                        copyInto(doc, file);
                        long written = writtenSize(doc);
                        if (written >= 0 && written != file.length()) {
                            throw new java.io.IOException("wrote " + written + " bytes of " + file.length());
                        }
                        saved++;
                    } catch (Throwable e) {
                        Log.w(TAG, "Could not write " + file.getName(), e);
                        if (failed == null) failed = file.getName();
                    } finally {
                        //noinspection ResultOfMethodCallIgnored
                        file.delete();
                    }
                }
            } catch (Throwable e) {
                Log.w(TAG, "Could not use that folder", e);
                for (File file : files) //noinspection ResultOfMethodCallIgnored
                    file.delete();
                failed = "that folder";
            }
            tellReader("window.Grimoire.exportSetSaved(" + saved + "," + files.size() + ","
                    + JSONObject.quote(failed == null ? "" : failed) + ")");
        });
    }

    void chooseBackupFolder() {
        runOnUiThread(() -> {
            Intent tree = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            tree.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                startActivityForResult(tree, PICK_BACKUP_FOLDER);
            } catch (Exception e) {
                Log.w(TAG, "No folder picker available", e);
                tellReader("window.Grimoire.backupFolderChosen(null)");
            }
        });
    }

    private void backupFolderPicked(@Nullable Uri tree) {
        if (tree == null) {
            tellReader("window.Grimoire.backupFolderChosen(null)");
            return;
        }
        try {
            getContentResolver().takePersistableUriPermission(tree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            Log.w(TAG, "That folder's permission could not be kept", e);
        }
        // The folder before it, let go: a folder no longer used holds no permission.
        String before = getSharedPreferences("exports", MODE_PRIVATE).getString(BACKUP_TREE, null);
        if (before != null && !before.equals(tree.toString())) {
            try {
                getContentResolver().releasePersistableUriPermission(Uri.parse(before),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) { /* already gone */ }
        }
        getSharedPreferences("exports", MODE_PRIVATE).edit().putString(BACKUP_TREE, tree.toString()).apply();
        tellReader("window.Grimoire.backupFolderChosen(" + JSONObject.quote(backupFolderName()) + ")");
    }

    @Nullable
    private Uri backupTree() {
        String saved = getSharedPreferences("exports", MODE_PRIVATE).getString(BACKUP_TREE, null);
        if (saved == null) return null;
        Uri tree = Uri.parse(saved);
        for (android.content.UriPermission held : getContentResolver().getPersistedUriPermissions()) {
            if (held.getUri().equals(tree) && held.isWritePermission()) return tree;
        }
        return null;
    }

    String backupFolderName() {
        Uri tree = backupTree();
        if (tree == null) return "";
        Uri folder = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,
                android.provider.DocumentsContract.getTreeDocumentId(tree));
        try (android.database.Cursor c = getContentResolver().query(folder,
                new String[] { android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            Log.w(TAG, "Could not name the backup folder", e);
        }
        return "the folder chosen";
    }

    void writeBackup(File file, int keep) {
        staging.execute(() -> {
            Uri tree = backupTree();
            if (tree == null || !file.exists()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                tellReader("window.Grimoire.backupWritten(false," + JSONObject.quote(tree == null
                        ? "the backup folder can no longer be written — choose it again" : "nothing was staged") + ")");
                return;
            }
            try {
                String rootId = android.provider.DocumentsContract.getTreeDocumentId(tree);
                Uri folder = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
                Uri doc = android.provider.DocumentsContract.createDocument(getContentResolver(), folder,
                        "application/json", file.getName());
                if (doc == null) throw new java.io.IOException("the folder would not take it");
                copyInto(doc, file);
                long written = writtenSize(doc);
                if (written >= 0 && written != file.length()) {
                    throw new java.io.IOException("wrote " + written + " bytes of " + file.length());
                }
                pruneBackups(tree, rootId, Math.max(1, keep));
                tellReader("window.Grimoire.backupWritten(true," + JSONObject.quote(file.getName()) + ")");
            } catch (Throwable e) {
                Log.w(TAG, "Could not write an automatic backup", e);
                tellReader("window.Grimoire.backupWritten(false," + JSONObject.quote(String.valueOf(e.getMessage())) + ")");
            } finally {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    /** The newest `keep` automatic backups stay (their names sort by when they were made); older ones go. */
    private void pruneBackups(Uri tree, String rootId, int keep) {
        Uri children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, rootId);
        java.util.List<String[]> found = new java.util.ArrayList<>();   // { name, documentId }
        try (android.database.Cursor c = getContentResolver().query(children, new String[] {
                android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String name = c.getString(0);
                if (name != null && name.startsWith(AUTO_BACKUP_PREFIX) && name.endsWith(".json")) {
                    found.add(new String[] { name, c.getString(1) });
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not list the backup folder", e);
            return;
        }
        found.sort((a, b) -> b[0].compareTo(a[0]));
        for (int i = keep; i < found.size(); i++) {
            try {
                android.provider.DocumentsContract.deleteDocument(getContentResolver(),
                        android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, found.get(i)[1]));
            } catch (Exception e) {
                Log.w(TAG, "Could not remove an old backup " + found.get(i)[0], e);
            }
        }
    }

    @Override
    protected void onActivityResult(int request, int result, @Nullable Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_BACKUP_FOLDER) {
            backupFolderPicked(result == RESULT_OK && data != null ? data.getData() : null);
            return;
        }
        if (request == PICK_EXPORT_FOLDER) {
            savedSetInto(result == RESULT_OK && data != null ? data.getData() : null);
            return;
        }
        if (request != PICK_EXPORT_TARGET) return;

        final Uri target = result == RESULT_OK && data != null ? data.getData() : null;
        if (staged == null) restoreStagedExport(null);
        final File source = staged;
        rememberStaged(null, null);

        if (target == null) {
            // Backed out of the picker: nothing to write, and nothing to keep.
            if (source != null) {
                //noinspection ResultOfMethodCallIgnored
                source.delete();
                tellReader("window.Grimoire.exportFailed("
                        + JSONObject.quote("Not saved — no place was chosen") + ")");
            }
            return;
        }
        if (source == null || !source.exists()) {
            // Never silent: this is exactly where an export used to vanish.
            tellReader("window.Grimoire.exportFailed("
                    + JSONObject.quote("The export was lost while the save screen was open. "
                    + "Please export it again.") + ")");
            return;
        }

        staging.execute(() -> {
            final long expected = source.length();
            try {
                copyInto(target, source);
                /* Checked, not assumed. A file saved over an older, larger one
                 * kept the end of the old one where the provider would not
                 * truncate: a zip with a stranger's tail, which no file app
                 * would open and which the importer read as the pages of
                 * whatever book used to be there. */
                long written = writtenSize(target);
                if (written >= 0 && written != expected) {
                    throw new java.io.IOException("wrote " + written + " bytes of " + expected);
                }
                // Said once the file is whole and closed, not before.
                tellReader("window.Grimoire.exportSaved("
                        + JSONObject.quote(source.getName()) + ")");
            } catch (Throwable e) {
                Log.w(TAG, "Could not write " + source.getName(), e);
                tellReader("window.Grimoire.exportFailed(" + JSONObject.quote(
                        "That file could not be saved properly. Save it under a new name rather "
                                + "than over an existing file.") + ")");
            } finally {
                //noinspection ResultOfMethodCallIgnored
                source.delete();
            }
        });
    }

    /* Written over whatever was there, entirely.
     *
     * "w" is documented to truncate and, on a good many providers, does not:
     * writing a smaller file over a larger one leaves the larger one's end in
     * place. "wt" says truncate in so many words. A provider that refuses
     * "wt" gets "w", and the size check after catches it if it misbehaves. */
    private void copyInto(Uri target, File source) throws java.io.IOException {
        java.io.OutputStream out = null;
        try {
            out = getContentResolver().openOutputStream(target, "wt");
        } catch (IllegalArgumentException | java.io.FileNotFoundException | SecurityException e) {
            Log.w(TAG, "No \"wt\" for " + target + "; writing with \"w\"", e);
        }
        if (out == null) out = getContentResolver().openOutputStream(target, "w");
        if (out == null) throw new java.io.IOException("nowhere to write");
        try (InputStream in = new java.io.FileInputStream(source); java.io.OutputStream o = out) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) o.write(buffer, 0, n);
            o.flush();
        }
    }

    /** How big a document actually is on disk now -- asked of the file
     *  itself, not of the listing, which can lag behind a write -- or -1
     *  when the provider will not say. */
    private long writtenSize(Uri uri) {
        try (android.os.ParcelFileDescriptor fd = getContentResolver().openFileDescriptor(uri, "r")) {
            return fd == null ? -1 : fd.getStatSize();
        } catch (Exception e) {
            return -1;
        }
    }

    /* Everything the picker has handed over, by URI -- not only the latest.
     *
     * This exists to read a file the page could not read itself, and the page
     * may still be working through an earlier pick when a later one arrives:
     * a second folder chosen while the first is importing. Keeping only the
     * latest pick meant every remaining file of the first import could no
     * longer be found, and the whole of it failed; and where the latest pick
     * was a single file, that one file was handed back for every request --
     * imported again and again under other files' names. */
    private static final class Picked {
        final Uri uri;
        String name;            // looked up once, when first needed
        long size = -2;         // -2: not looked up yet
        Picked(Uri uri) { this.uri = uri; }
    }

    private final java.util.List<Picked> picked = new java.util.ArrayList<>();
    /** Enough for several large folders; the oldest go first beyond it. */
    private static final int PICKED_KEPT = 5000;

    private void remember(Uri[] uris) {
        synchronized (picked) {
            for (Uri uri : uris) {
                picked.removeIf(p -> p.uri.equals(uri));
                picked.add(new Picked(uri));
            }
            while (picked.size() > PICKED_KEPT) picked.remove(0);
        }
    }

    private String nameOf(Picked p) {
        if (p.name == null) {
            String its = bridge != null ? bridge.displayName(p.uri.toString()) : null;
            p.name = its != null ? its : "";
        }
        return p.name;
    }

    private long sizeOf(Picked p) {
        if (p.size == -2) p.size = sizeOf(p.uri);
        return p.size;
    }

    /**
     * The picked file a page's File stands for, matched on its name and its
     * size, newest pick first. Null rather than a guess: a wrong file staged
     * under this name is worse than a file reported unreadable.
     */
    private Uri findPicked(String name, long size) {
        java.util.List<Picked> all;
        synchronized (picked) { all = new java.util.ArrayList<>(picked); }
        java.util.Collections.reverse(all);

        Uri byName = null;
        int named = 0;
        for (Picked p : all) {
            if (name == null || !name.equals(nameOf(p))) continue;
            long its = sizeOf(p);
            if (size > 0 && its == size) return p.uri;      // name and size: certain
            if (size <= 0 || its < 0) { named += 1; if (byName == null) byName = p.uri; }
        }
        // The name alone, where the size could not be compared and only one
        // file has that name.
        if (named == 1) return byName;

        // The size alone, where the provider does not give names -- and only
        // if exactly one picked file is that size.
        if (size > 0) {
            Uri only = null;
            for (Picked p : all) {
                if (sizeOf(p) != size) continue;
                if (only != null) return null;
                only = p.uri;
            }
            return only;
        }
        return null;
    }

    /**
     * Copy a picked file into the app's own storage and tell the page where.
     *
     * The page asks for this only after its own read of the file has failed.
     * Reading it here instead works because the grant belongs to this
     * process; serving it back over the asset origin works because that is
     * an ordinary same-origin fetch with no content provider in the middle.
     */
    void stageForRead(String id, String name, long size) {
        staging.execute(() -> {
            Uri found = findPicked(name, size);

            if (found == null) {
                settleStage(id, false, "that file is no longer the one being opened");
                return;
            }

            String safe = (name == null || name.isEmpty() ? "file" : name)
                    .replaceAll("[^A-Za-z0-9._\\- ]", "_");
            java.io.File target = new java.io.File(handoffDir(this), safe);

            try (InputStream in = getContentResolver().openInputStream(found);
                 java.io.OutputStream out = new java.io.FileOutputStream(target)) {
                if (in == null) throw new java.io.IOException("nothing to read");
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            } catch (Throwable e) {
                Log.w(TAG, "Could not stage " + found + " for reading", e);
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                settleStage(id, false, "Android would not let the app read it either");
                return;
            }

            settleStage(id, true, ORIGIN + "/handoff/" + Uri.encode(safe));
        });
    }

    private void settleStage(String id, boolean ok, String payload) {
        tellReader("window.Grimoire.settleFile("
                + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload) + ")");
    }

    private long sizeOf(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(
                uri, new String[] { android.provider.OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getLong(0);
            }
        } catch (Throwable ignored) {
            // A provider that will not say is one more reason to match on name.
        }
        return -1;
    }

    /** Where a file handed over from elsewhere is staged before it is read. */
    static java.io.File handoffDir(android.content.Context context) {
        java.io.File dir = new java.io.File(context.getFilesDir(), "handoff");
        if (!dir.exists() && !dir.mkdirs()) Log.w(TAG, "Could not make the handoff directory");
        return dir;
    }

    /** Whether the on-screen keyboard is showing (and with it, whatever panel of it is open). */
    private boolean keyboardUp() {
        if (webView == null) return false;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
        return insets != null && insets.isVisible(WindowInsetsCompat.Type.ime()) && hasWindowFocus();
    }

    private void installBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                /* The keyboard up: a back that reaches here is not the reader leaving.
                 * The keyboard takes a back to close itself before it ever comes here;
                 * one that slips past it -- Samsung's clipboard, as its items are
                 * deleted -- left the screen being typed in. Not acted on. */
                if (keyboardUp()) return;
                // A site shown to pass its check: back is Done.
                if (webBridge != null && webBridge.closeShownIfOpen()) return;
                // Give the reader first refusal: it may want to close a menu or
                // exit a chapter rather than leave the app.
                webView.evaluateJavascript(
                        "(window.Grimoire && window.Grimoire.onBack) ? " +
                                "String(!!window.Grimoire.onBack()) : 'false'",
                        value -> {
                            if ("true".equals(value)) return;
                            if (webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                setEnabled(false);
                                getOnBackPressedDispatcher().onBackPressed();
                            }
                        });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // "Notify me" in Build: the answer goes back to the page either way.
        if (requestCode == GrimoireBridge.ASK_TO_NOTIFY && bridge != null) bridge.answerNotify();
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    /** Hand a book opened from outside the app to the reader as a content:// URI. */
    private void handleIncomingIntent(@Nullable Intent intent) {
        if (intent == null) return;
        Uri data = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            data = intent.getData();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            data = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (data == null) {
            Log.w(TAG, "A view intent arrived with no file on it: " + intent.getAction());
            return;
        }
        // "Back to Quire" from the page shown after signing in to OpenRouter:
        // being brought to the front was all it asked for.
        if ("quire".equals(data.getScheme())) {
            setIntent(new Intent(Intent.ACTION_MAIN));
            return;
        }

        /* No grant is taken here.
         *
         * The read permission travels with the intent and already applies to
         * this process, and the file is read straight away rather than kept
         * for later -- so granting anything to ourselves bought nothing. It
         * also had to be handed a computed flag, which lint rejects outright:
         * grantUriPermission takes one of a fixed set of constants.
         */
        pendingUri = data.toString();
        // Handled: what the activity was started with is from here on just
        // the app being open, so nothing that asks for it later finds a file.
        setIntent(new Intent(Intent.ACTION_MAIN));
        // Delivered when the reader says it is ready, not after a guessed
        // delay. Opening a file from elsewhere is always a cold start, and
        // four hundred milliseconds is not enough for the page to have loaded
        // -- the call landed on a window with no Grimoire on it and vanished.
        deliverPendingUri();
    }

    /** Called from JavaScript once the reader has booted. */
    void onReaderReady() {
        readerReady = true;
        flushHeldCalls();
        deliverPendingUri();
    }

    private void deliverPendingUri() {
        if (!readerReady || pendingUri == null) return;
        final Uri uri = Uri.parse(pendingUri);
        pendingUri = null;

        /* Copied to disk on a background thread, in fixed-size pieces, so a
         * large book costs a buffer rather than its own length in memory. */
        staging.execute(() -> {
            String name = bridge != null ? bridge.displayName(uri.toString()) : null;
            if (name == null || name.isEmpty()) name = "book";
            final String safe = name.replaceAll("[^A-Za-z0-9._\\- ]", "_");

            java.io.File target = new java.io.File(handoffDir(this), safe);
            try (InputStream in = getContentResolver().openInputStream(uri);
                 java.io.OutputStream out = new java.io.FileOutputStream(target)) {
                if (in == null) throw new java.io.IOException("nothing to read");
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            } catch (Throwable e) {
                Log.w(TAG, "Could not stage " + uri, e);
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                tellReader("window.Grimoire.handoffFailed("
                        + JSONObject.quote("That file could not be read") + ")");
                return;
            }

            tellReader("window.Grimoire.openExternalBook("
                    + JSONObject.quote(ORIGIN + "/handoff/" + Uri.encode(safe))
                    + "," + JSONObject.quote(safe) + ")");
        });
    }

    /* Said once there is a page to say it to.
     *
     * The result of an export arrives when the person comes back from the
     * file picker -- which is often to an app Android restarted meanwhile,
     * whose page has not loaded yet. Sent then, "Saved" landed on nothing and
     * the export looked as if it had never happened. Held until the reader
     * says it is ready, then delivered in order. */
    private final java.util.List<String> heldCalls = new java.util.ArrayList<>();

    private void tellReader(String call) {
        runOnUiThread(() -> {
            if (!readerReady || webView == null) {
                heldCalls.add(call);
                return;
            }
            webView.evaluateJavascript("window.Grimoire && " + call, null);
        });
    }

    private void flushHeldCalls() {
        runOnUiThread(() -> {
            if (!readerReady || webView == null) return;
            for (String call : heldCalls) webView.evaluateJavascript("window.Grimoire && " + call, null);
            heldCalls.clear();
        });
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
        if (staged != null) {
            outState.putString(STAGED_PATH, staged.getAbsolutePath());
            outState.putString(STAGED_TYPE, stagedType);
        }
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
