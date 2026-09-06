package com.grimoire.ereader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
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

    private final Activity activity;
    private final WebView webView;

    GrimoireBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
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
    @JavascriptInterface
    public String readContentUri(String uriString) {
        try {
            Uri uri = Uri.parse(uriString);
            if (!"content".equals(uri.getScheme())) return null;
            try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                if (in == null) return null;
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                int n;
                long total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > 96L * 1024 * 1024) return null; // sanity ceiling
                    out.write(buf, 0, n);
                }
                return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Stop the screen dimming while someone is mid-chapter. */
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
