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
                    lastPicked.clear();
                    if (result != null) {
                        java.util.Collections.addAll(lastPicked, result);
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

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }

        handleIncomingIntent(getIntent());
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
                pushInsets(lastInsets);
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
                pendingNotice = crashed
                        ? "The reader ran out of room and restarted. Nothing was lost."
                        : "Android reclaimed the reader's memory. Nothing was lost.";
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
    private void applyInsetsToCss() {
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
                            | WindowInsetsCompat.Type.ime());
            lastInsets = bars;
            pushInsets(bars);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    private void pushInsets(Insets i) {
        if (webView == null) return;
        float d = getResources().getDisplayMetrics().density;
        String js = String.format(
                java.util.Locale.US,
                "(function(){var r=document.documentElement.style;" +
                        "r.setProperty('--safe-top','%.1fpx');" +
                        "r.setProperty('--safe-right','%.1fpx');" +
                        "r.setProperty('--safe-bottom','%.1fpx');" +
                        "r.setProperty('--safe-left','%.1fpx');" +
                        "window.dispatchEvent(new CustomEvent('grimoire:insets'));})();",
                i.top / d, i.right / d, i.bottom / d, i.left / d);
        webView.evaluateJavascript(js, null);
    }

    /* ── writing files out ────────────────────────────────────────────────
     *
     * Either to a place the person picks, or to whatever app will take it.
     * The first is what "export" usually means and what was missing: a backup
     * belongs somewhere findable, not only in a share sheet.
     */

    private static final int PICK_EXPORT_TARGET = 4301;
    private File staged;
    private String stagedType;

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

            staged = file;
            stagedType = mimeType;
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

    @Override
    protected void onActivityResult(int request, int result, @Nullable Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_EXPORT_TARGET) return;

        final Uri target = result == RESULT_OK && data != null ? data.getData() : null;
        final File source = staged;
        staged = null;
        if (target == null || source == null) return;

        staging.execute(() -> {
            try (InputStream in = new java.io.FileInputStream(source);
                 java.io.OutputStream out = getContentResolver().openOutputStream(target)) {
                if (out == null) throw new java.io.IOException("nowhere to write");
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                tellReader("window.Grimoire.exportSaved("
                        + JSONObject.quote(source.getName()) + ")");
            } catch (Throwable e) {
                Log.w(TAG, "Could not write " + source.getName(), e);
                tellReader("window.Grimoire.exportFailed("
                        + JSONObject.quote("That file could not be saved") + ")");
            } finally {
                //noinspection ResultOfMethodCallIgnored
                source.delete();
            }
        });
    }

    /* What the picker last handed over, by URI.
     *
     * Only the most recent pick: this exists to retry a file the page has in
     * front of it right now, not to hold on to anything. */
    private final java.util.List<Uri> lastPicked = new java.util.ArrayList<>();

    /**
     * Copy a picked file into the app's own storage and tell the page where.
     *
     * The page asks for this only after its own read of the file has failed.
     * Reading it here instead works because the grant belongs to this
     * process; serving it back over the asset origin works because that is
     * an ordinary same-origin fetch with no content provider in the middle.
     *
     * Matched by name first and size second, because a File is all the page
     * has and it carries nothing that identifies the URI it came from. A
     * single pick needs neither.
     */
    void stageForRead(String id, String name, long size) {
        staging.execute(() -> {
            Uri found = null;

            if (lastPicked.size() == 1) {
                found = lastPicked.get(0);
            } else {
                for (Uri uri : lastPicked) {
                    String its = bridge != null ? bridge.displayName(uri.toString()) : null;
                    if (its != null && its.equals(name)) { found = uri; break; }
                }
                if (found == null && size > 0) {
                    for (Uri uri : lastPicked) {
                        if (sizeOf(uri) == size) { found = uri; break; }
                    }
                }
            }

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

    private void installBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
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

        /* No grant is taken here.
         *
         * The read permission travels with the intent and already applies to
         * this process, and the file is read straight away rather than kept
         * for later -- so granting anything to ourselves bought nothing. It
         * also had to be handed a computed flag, which lint rejects outright:
         * grantUriPermission takes one of a fixed set of constants.
         */
        pendingUri = data.toString();
        // Delivered when the reader says it is ready, not after a guessed
        // delay. Opening a file from elsewhere is always a cold start, and
        // four hundred milliseconds is not enough for the page to have loaded
        // -- the call landed on a window with no Grimoire on it and vanished.
        deliverPendingUri();
    }

    /** Called from JavaScript once the reader has booted. */
    void onReaderReady() {
        readerReady = true;
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

    private void tellReader(String call) {
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript("window.Grimoire && " + call, null);
        });
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
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
