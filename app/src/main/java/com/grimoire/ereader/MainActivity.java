package com.grimoire.ereader;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
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
                    if (result != null) {
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
        webView.addJavascriptInterface(new GrimoireBridge(this, webView), "GrimoireNative");
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
        if (data == null) return;
        final String uri = data.toString().replace("'", "\\'");
        webView.postDelayed(() -> webView.evaluateJavascript(
                "window.Grimoire && window.Grimoire.openExternalBook && " +
                        "window.Grimoire.openExternalBook('" + uri + "')", null), 400);
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
