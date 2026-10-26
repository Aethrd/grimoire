package com.grimoire.ereader;

import android.app.Activity;
import android.net.Uri;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pages fetched from the web, for the bulk downloader.
 *
 * A page cannot do this itself: every site it would ask is another origin,
 * and almost none of them send the headers that would let a page read what
 * they answer. So the request is made here, natively, and only ever because
 * the reader asked for one particular address -- nothing is fetched on its
 * own, and nothing but http and https is fetched at all.
 *
 * What comes back is written to a file and served to the page over the app's
 * own origin, the same way a file handed over from another app is, rather
 * than sent across the bridge as text: a long chapter with its pictures is
 * megabytes, and a string that size crossing the bridge is held three times
 * over.
 *
 * Cookies a site sets are kept in memory for as long as the app is open, so a
 * site that hands out a session on its contents page still recognises the
 * chapters asked for after it. They are never written anywhere, and the
 * reader's own WebView keeps none.
 */
public class WebBridge {

    private static final String TAG = "GrimoireWeb";
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int CONNECT_MS = 15000;
    private static final int READ_MS = 30000;
    private static final int MAX_REDIRECTS = 8;
    /** A chapter is kilobytes and a picture a few megabytes. Anything past
     *  this is not a page of a book. */
    private static final long MAX_BYTES = 40L * 1024 * 1024;

    private final Activity activity;
    private final WebView webView;
    /** Two at a time: quick enough, and gentle on a site being read. */
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
    private final String userAgent;

    WebBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        String agent;
        try {
            // The phone's own browser engine, as itself: a site serves this
            // the same page it would serve the browser.
            agent = WebSettings.getDefaultUserAgent(activity);
        } catch (Exception e) {
            agent = "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Mobile";
        }
        this.userAgent = agent;
        // Whatever an earlier run left behind is of no use now.
        File[] old = dir().listFiles();
        if (old != null) for (File file : old) //noinspection ResultOfMethodCallIgnored
            file.delete();
    }

    private File dir() {
        File dir = new File(MainActivity.handoffDir(activity), "web");
        if (!dir.exists() && !dir.mkdirs()) Log.w(TAG, "Could not make the download directory");
        return dir;
    }

    /**
     * Fetch one address. Answers through window.Grimoire.settleWeb with the
     * address it ended up at, the status, the type, and where the page can
     * read what came back.
     */
    @JavascriptInterface
    public void fetch(final String id, final String address) {
        io.execute(() -> {
            String safeId = id == null ? "x" : id.replaceAll("[^A-Za-z0-9_-]", "_");
            File target = new File(dir(), safeId);
            try {
                JSONObject result = download(address, target);
                result.put("path", ORIGIN + "/handoff/web/" + Uri.encode(safeId));
                settle(id, true, result.toString());
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                Log.w(TAG, "Could not fetch " + address, e);
                settle(id, false, describe(e));
            }
        });
    }

    /** The page has read what was fetched; the file can go. */
    @JavascriptInterface
    public void release(String id) {
        if (id == null) return;
        //noinspection ResultOfMethodCallIgnored
        new File(dir(), id.replaceAll("[^A-Za-z0-9_-]", "_")).delete();
    }

    private JSONObject download(String address, File target) throws IOException, JSONException {
        URL url = new URL(address);
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            String scheme = url.getProtocol().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) {
                throw new IOException("only web addresses can be downloaded");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_MS);
                connection.setReadTimeout(READ_MS);
                connection.setRequestProperty("User-Agent", userAgent);
                connection.setRequestProperty("Accept",
                        "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8");
                connection.setRequestProperty("Accept-Language",
                        Locale.getDefault().toLanguageTag() + ",en;q=0.8");
                addCookies(connection, url);

                int status = connection.getResponseCode();
                keepCookies(connection, url);

                // Followed by hand: Android's own following stops at a change
                // between http and https, which is most redirects there are.
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("the site redirected to nowhere");
                    url = new URL(url, location);
                    continue;
                }
                if (status >= 400) throw new IOException(refusal(status, connection));

                long length = connection.getContentLengthLong();
                if (length > MAX_BYTES) throw new IOException("that file is too large to be a page");
                long total = 0;
                try (InputStream in = connection.getInputStream();
                     OutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        total += n;
                        if (total > MAX_BYTES) throw new IOException("that file is too large to be a page");
                        out.write(buffer, 0, n);
                    }
                }

                JSONObject result = new JSONObject();
                result.put("url", url.toString());
                result.put("status", status);
                String type = connection.getContentType();
                result.put("type", type == null ? "" : type);
                result.put("bytes", total);
                return result;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("the site redirected too many times");
    }

    /** Why a site said no, in words that say what to do about it. */
    private static String refusal(int status, HttpURLConnection connection) {
        String server = String.valueOf(connection.getHeaderField("Server")).toLowerCase(Locale.ROOT);
        boolean guarded = connection.getHeaderField("cf-mitigated") != null
                || (server.contains("cloudflare") && (status == 403 || status == 503));
        if (guarded) {
            return "the site only lets a browser in (it is behind a bot check), so it refused the download";
        }
        if (status == 404) return "that page does not exist (404)";
        if (status == 401 || status == 403) return "the site refused (" + status + ") -- it may need you to be signed in";
        if (status == 429) return "the site says too many requests (429) -- wait a while and try again";
        return "the site answered " + status;
    }

    private void addCookies(HttpURLConnection connection, URL url) {
        try {
            Map<String, List<String>> headers = cookies.get(url.toURI(), new java.util.HashMap<>());
            List<String> sent = headers.get("Cookie");
            if (sent != null && !sent.isEmpty()) {
                connection.setRequestProperty("Cookie", android.text.TextUtils.join("; ", sent));
            }
        } catch (Exception ignored) {
            // A cookie that will not go is a page that may still come.
        }
    }

    private void keepCookies(HttpURLConnection connection, URL url) {
        try {
            URI uri = url.toURI();
            Map<String, List<String>> headers = connection.getHeaderFields();
            for (Map.Entry<String, List<String>> header : headers.entrySet()) {
                if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Set-Cookie")) continue;
                for (String value : header.getValue()) {
                    for (HttpCookie cookie : HttpCookie.parse(value)) cookies.getCookieStore().add(uri, cookie);
                }
            }
        } catch (Exception ignored) {
            // Kept where it can be; a site that sets a strange one still answers.
        }
    }

    private void settle(String id, boolean ok, String payload) {
        // Quoted, so it crosses as text and is parsed once on the other side.
        final String js = "window.Grimoire && window.Grimoire.settleWeb && window.Grimoire.settleWeb("
                + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload) + ")";
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    private static String describe(Exception e) {
        if (e instanceof java.net.UnknownHostException) return "that address could not be found -- is the phone online?";
        if (e instanceof java.net.SocketTimeoutException) return "the site took too long to answer";
        if (e instanceof javax.net.ssl.SSLException) return "the site's secure connection could not be checked";
        if (e instanceof java.net.MalformedURLException) return "that is not a web address";
        String message = e.getMessage();
        return message == null ? e.getClass().getSimpleName() : message;
    }
}
