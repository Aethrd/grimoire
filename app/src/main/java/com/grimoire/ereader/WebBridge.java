package com.grimoire.ereader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.List;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

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
    private final java.net.CookieManager cookies = new java.net.CookieManager(null, CookiePolicy.ACCEPT_ALL);
    /** One page rendered at a time. Two at once share the site's cookies,
     *  and a site that keeps "the chapter being read" with them handed each
     *  the other's chapter (5화 came back as 6화, and 6화 as 5화). */
    private final ExecutorService renderer = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    /** How long a page may take to settle, and how long it must stay still
     *  to count as settled -- each longer at every level of patience the page
     *  asks for (a chapter that came back empty is asked for more patiently). */
    private static final long RENDER_MAX_MS = 40000;
    private static final long RENDER_MAX_STEP_MS = 10000;
    private static final long RENDER_QUIET_MS = 2500;
    private static final long RENDER_QUIET_STEP_MS = 2000;
    private static final long RENDER_POLL_MS = 700;
    /** A page still waiting on a request this many quiet spells on has one
     *  that never ends (a live feed, an advert): it is taken as it stands. */
    private static final int RENDER_STUCK_SPELLS = 4;
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
        // Nor are the cookies the renderer was given last time (see render).
        try {
            CookieManager.getInstance().removeAllCookies(null);
        } catch (Exception ignored) {
            // No WebView provider yet: then there are none to clear either.
        }
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

    /**
     * Open one address in an unseen browser, let its scripts build the page,
     * and answer as fetch does, with the page as it then stands.
     *
     * For sites that send an empty frame and build every page in script, and
     * for those that let only a browser past their bot check: to either, a
     * plain request gets nothing to read. The page is loaded in a WebView of
     * its own, never the reader's, with scripts on and nothing of the app
     * reachable from it. It counts as ready once its text and links have
     * stopped changing for a moment (a contents page scrolled to the end on
     * the way, for a list that loads more as it is scrolled), or at the latest after
     * RENDER_MAX_MS, and the browser is thrown away after each page.
     *
     * Cookies: the reader keeps none, but a bot check is passed by a cookie,
     * so while the app is open the renderer's are kept, and handed to plain
     * fetches of the same site too. They are cleared when the app next opens.
     */
    @JavascriptInterface
    public void render(final String id, final String address, final String patience, final String list) {
        // Scrolled to the end only for a contents page, for a list that loads
        // more as it is scrolled. Never a chapter: a reader that puts the
        // next chapter under this one when the end is reached would go on
        // adding chapters for as long as it was scrolled (a hundred, once).
        final boolean scroll = "1".equals(list);
        int level = 0;
        try {
            level = Math.max(0, Math.min(3, Integer.parseInt(String.valueOf(patience).trim())));
        } catch (NumberFormatException ignored) {
            // Not a number: the usual patience.
        }
        final long quietMs = RENDER_QUIET_MS + level * RENDER_QUIET_STEP_MS;
        // Other sites' adverts and trackers kept out, until a page that came
        // back without its chapter is asked for patiently: then nothing is.
        final boolean ownSiteOnly = level < 2;
        final long maxMs = RENDER_MAX_MS + level * RENDER_MAX_STEP_MS;
        renderer.execute(() -> {
            String safeId = id == null ? "x" : id.replaceAll("[^A-Za-z0-9_-]", "_");
            File target = new File(dir(), safeId);
            try {
                URL url = new URL(address);
                String scheme = url.getProtocol().toLowerCase(Locale.ROOT);
                if (!scheme.equals("http") && !scheme.equals("https")) {
                    throw new IOException("only web addresses can be downloaded");
                }
                Rendering job = new Rendering(address, quietMs, maxMs, scroll, ownSiteOnly);
                main.post(job::start);
                if (!job.done.await(maxMs + 20000, TimeUnit.MILLISECONDS)) {
                    main.post(job::finish);
                    throw new IOException("the site took too long to answer");
                }
                if (job.error != null) throw new IOException(job.error);
                // Decoded here, not on the main thread: a page can run to
                // megabytes, and the app would stop answering meanwhile.
                Object text = new JSONTokener(job.raw == null ? "null" : job.raw).nextValue();
                if (!(text instanceof String) || ((String) text).isEmpty()) {
                    throw new IOException("the page came back empty");
                }
                // Its scripts, styles, frames and icons out before the reader
                // parses it: it needs the words and the links, and a page of
                // adverts is mostly the rest -- parsed on the app's own thread.
                String lean;
                try {
                    lean = LEAN.matcher((String) text).replaceAll("");
                } catch (Throwable tooMuch) {
                    lean = (String) text;   // the whole page, then: slower, not lost
                }
                byte[] bytes = lean.getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = new FileOutputStream(target)) {
                    out.write(bytes);
                }
                keepRenderedCookies(job.finalUrl);
                JSONObject result = new JSONObject();
                result.put("url", job.finalUrl);
                result.put("status", 200);
                result.put("type", "text/html; charset=utf-8");
                result.put("bytes", bytes.length);
                result.put("rendered", true);
                result.put("path", ORIGIN + "/handoff/web/" + Uri.encode(safeId));
                settle(id, true, result.toString());
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                Log.w(TAG, "Could not render " + address, e);
                settle(id, false, describe(e));
            }
        });
    }

    /** What the renderer's browser was given, kept for plain fetches too. */
    private void keepRenderedCookies(String address) {
        try {
            String header = CookieManager.getInstance().getCookie(address);
            if (header == null || header.isEmpty()) return;
            URI uri = new URI(address);
            for (String part : header.split(";\\s*")) {
                int eq = part.indexOf('=');
                if (eq <= 0) continue;
                HttpCookie cookie = new HttpCookie(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
                cookie.setPath("/");
                cookie.setVersion(0);
                cookies.getCookieStore().add(uri, cookie);
            }
        } catch (Exception ignored) {
            // A cookie that will not carry over only means the next fetch renders too.
        }
    }

    /* ── the unseen browser ───────────────────────────────────────────────
     *
     * One, used for page after page, not one made and thrown away for each:
     * six hundred WebViews made and destroyed in a row leave the renderer
     * a little more behind each time, and a second long build in the same
     * sitting ran out of room. Between pages it is emptied (a blank page,
     * its history cleared) so the last site's scripts stop; every
     * BROWSER_USES pages it is replaced, and BROWSER_IDLE_MS after the last
     * page it is closed, so a finished build gives its memory back. All of
     * it on the main thread.
     */
    private static final int BROWSER_USES = 25;
    private static final long BROWSER_IDLE_MS = 20000;
    private WebView browser;
    private int browserUses;
    private boolean browserTracked;
    /** The page the browser is reading now; its events go to it, others' nowhere. */
    private volatile Rendering current;
    private final Runnable closeBrowser = this::dropBrowser;

    private void dropBrowser() {
        WebView gone = browser;
        browser = null;
        browserUses = 0;
        if (gone == null) return;
        try {
            gone.stopLoading();
            ViewGroup parent = (ViewGroup) gone.getParent();
            if (parent != null) parent.removeView(gone);
            gone.removeAllViews();
            gone.destroy();
        } catch (Exception ignored) {
            // Gone either way.
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView browserFor(Rendering job) {
        main.removeCallbacks(closeBrowser);
        if (browser != null && browserUses >= BROWSER_USES) dropBrowser();
        if (browser == null) {
            WebView view = new WebView(activity);
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setUserAgentString(userAgent);
            settings.setLoadsImagesAutomatically(false); // pictures are fetched later, as files
            settings.setBlockNetworkImage(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            CookieManager manager = CookieManager.getInstance();
            manager.setAcceptCookie(true);
            manager.setAcceptThirdPartyCookies(view, true);
            view.setWebViewClient(new BrowserClient());
            // Laid out at the screen's size, as the page would be, but under
            // the reader and fully transparent: never seen or touched.
            view.setAlpha(0f);
            view.setFocusable(false);
            view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            ViewGroup root = activity.findViewById(android.R.id.content);
            if (root != null) {
                root.addView(view, 0, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            // Counting the page's own requests from before its first script
            // runs: a chapter fetched after the page opens is only there once
            // its request has come back. Once, for every page it will load.
            browserTracked = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
            if (browserTracked) {
                WebViewCompat.addDocumentStartJavaScript(view, TRACKER, Collections.singleton("*"));
            }
            browser = view;
        }
        browserUses += 1;
        current = job;
        return browser;
    }

    /** Done with a page: the browser emptied for the next, or closed if none comes. */
    private void browserDone(Rendering job) {
        if (current == job) current = null;
        WebView view = browser;
        if (view != null) {
            try {
                view.stopLoading();
                view.loadUrl("about:blank");
                view.clearHistory();
            } catch (Exception ignored) {
                dropBrowser();
            }
        }
        main.removeCallbacks(closeBrowser);
        main.postDelayed(closeBrowser, BROWSER_IDLE_MS);
    }

    /** The browser's events, passed to the page it is reading; the blank page between is no one's. */
    private final class BrowserClient extends WebViewClient {
        private Rendering reading(String url) {
            if (url != null && url.startsWith("about:")) return null;
            return current;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
            // Redirects within the web are followed; anything that would leave
            // it (an app link, a store) is not.
            String s = request.getUrl().getScheme();
            if ("about".equalsIgnoreCase(s)) return false;
            return s == null || !(s.equalsIgnoreCase("http") || s.equalsIgnoreCase("https"));
        }

        /* Every web page in the app shares one renderer. If Android reclaims
         * it, each view is told, and one that does not answer takes the whole
         * app down: the browser is let go (a new one is made for the next
         * page), the page it was reading is tried again, and the reader's own
         * view rebuilds itself. */
        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            if (v == browser) {
                browser = null;
                browserUses = 0;
            }
            try {
                ViewGroup parent = (ViewGroup) v.getParent();
                if (parent != null) parent.removeView(v);
                v.destroy();
            } catch (Exception ignored) {
                // Gone either way.
            }
            Rendering job = current;
            if (job != null) job.fail("Android stopped the page's browser to free memory");
            return true;
        }

        /* Another site's adverts, trackers and frames: kept out, so the page
         * costs the phone a fraction of what it would. Its own site, the
         * common script libraries and Cloudflare's check still load. */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
            Rendering job = current;
            if (job == null) {
                // Between pages: nothing of the last one may go on loading.
                String s = request.getUrl().getScheme();
                return "about".equalsIgnoreCase(s) ? null
                        : new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
            if (!job.ownSiteOnly || request.isForMainFrame()) return null;
            String host = request.getUrl().getHost();
            if (host == null || ALLOWED_ELSEWHERE.contains(host.toLowerCase(Locale.ROOT))) return null;
            String own = job.site;
            if (own != null && own.equals(siteOf(host))) return null;
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
            Rendering job = reading(url);
            if (job == null) return;
            job.finalUrl = url;
            String moved = siteOf(Uri.parse(url).getHost());
            if (moved != null) job.site = moved;
            // Without the document-start hook (an old WebView), as early as can
            // be: later requests are still counted.
            if (!browserTracked) v.evaluateJavascript(TRACKER, null);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            Rendering job = reading(url);
            if (job == null) return;
            job.finalUrl = url;
            job.pageFinished();
        }

        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest request, WebResourceResponse response) {
            Rendering job = current;
            if (job != null && request.isForMainFrame()) job.mainStatus = response.getStatusCode();
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError err) {
            Rendering job = reading(request.getUrl().toString());
            if (job != null && request.isForMainFrame()) {
                job.fail("the page could not be opened: " + err.getDescription());
            }
        }
    }

    /** One page in the unseen browser. Everything but the waiting runs on the main thread. */
    private final class Rendering {
        final String address;
        final long quietMs;
        final long maxMs;
        final boolean scroll;
        final boolean ownSiteOnly;
        /** The site the page is on, for telling its own requests from others'. */
        volatile String site;
        final CountDownLatch done = new CountDownLatch(1);
        /** The page as evaluateJavascript gave it: a JSON string, decoded off the main thread. */
        volatile String raw;
        volatile String error;
        volatile String finalUrl;
        volatile int mainStatus;
        private WebView view;
        private boolean loaded;
        private String lastShape = "";
        private long stillSince;
        private long startedAt;

        Rendering(String address, long quietMs, long maxMs, boolean scroll, boolean ownSiteOnly) {
            this.address = address;
            this.quietMs = quietMs;
            this.maxMs = maxMs;
            this.scroll = scroll;
            this.ownSiteOnly = ownSiteOnly;
            this.site = siteOf(Uri.parse(address).getHost());
            this.finalUrl = address;
        }

        void start() {
            try {
                startedAt = System.currentTimeMillis();
                view = browserFor(this);
                view.loadUrl(address);
                main.postDelayed(() -> { if (!loaded && view != null) { loaded = true; poll(); } }, maxMs / 2);
            } catch (Exception e) {
                fail(describe(e));
            }
        }

        void pageFinished() {
            if (!loaded && view != null) {
                loaded = true;
                main.postDelayed(this::poll, RENDER_POLL_MS);
            }
        }

        /** Still changing? Scroll on, and look again shortly. */
        private void poll() {
            if (view == null) return;
            view.evaluateJavascript(scroll ? SCROLL + SHAPE : SHAPE, (value) -> {
                if (view == null) return;
                String reply = value == null ? "" : value;
                // "pending|text|links|checking|resources|title": all but the
                // pending count make the page's shape.
                int bar = reply.indexOf('|');
                int pending = 0;
                try {
                    pending = Integer.parseInt(reply.substring(1, Math.max(1, bar)));
                } catch (Exception ignored) {
                    // Unreadable: as though nothing were pending.
                }
                String shape = bar < 0 ? reply : reply.substring(bar + 1);
                long now = System.currentTimeMillis();
                boolean waiting = shape.contains("|checking|"); // a bot check still at work
                if (!shape.equals(lastShape) || waiting) {
                    lastShape = shape;
                    stillSince = now;
                }
                long still = now - stillSince;
                boolean blank = shape.startsWith("0|");
                // Settled: nothing more on its way and nothing changing -- or
                // nothing changing for so long that what is still on its way
                // is not the page.
                boolean settled = !waiting && !blank
                        && ((pending <= 0 && still >= quietMs) || still >= quietMs * RENDER_STUCK_SPELLS);
                if (settled || now - startedAt >= maxMs) {
                    take();
                } else {
                    main.postDelayed(this::poll, RENDER_POLL_MS);
                }
            });
        }

        private void take() {
            if (mainStatus == 404) {
                fail("that page does not exist (404)");
                return;
            }
            view.evaluateJavascript("'<!DOCTYPE html>'+document.documentElement.outerHTML", (value) -> {
                if (lastShape.contains("|checking|")) {
                    error = "the site only lets a browser in (it is behind a bot check), and its check did not finish";
                } else {
                    raw = value;
                }
                finish();
            });
        }

        void fail(String why) {
            if (error == null && raw == null) error = why;
            finish();
        }

        void finish() {
            if (done.getCount() == 0) return;
            if (view != null) {
                view = null;
                browserDone(this);
            }
            done.countDown();
        }
    }

    /** Counts the page's fetch and XMLHttpRequest calls still on their way, in window.__grimoirePending. */
    private static final String TRACKER = "(function(){if(window.__grimoirePending!==undefined)return;"
            + "window.__grimoirePending=0;"
            + "var f=window.fetch;if(f){window.fetch=function(){window.__grimoirePending++;var p;"
            + "try{p=f.apply(this,arguments);}catch(e){window.__grimoirePending--;throw e;}"
            + "var d=function(){window.__grimoirePending--;};p.then(d,d);return p;};}"
            + "var X=window.XMLHttpRequest;if(X&&X.prototype){var s=X.prototype.send;"
            + "X.prototype.send=function(){window.__grimoirePending++;var done=false;"
            + "var d=function(){if(!done){done=true;window.__grimoirePending--;}};"
            + "this.addEventListener('loadend',d);try{return s.apply(this,arguments);}catch(e){d();throw e;}};}"
            + "})();";

    /** What is still on its way, then the page's shape -- text length, link count, a bot check at
     *  work, resources loaded, title -- which changes while it is still being built. */
    /** What a page parsed by the reader can do without. */
    private static final Pattern LEAN = Pattern.compile(
            "<(script|style|iframe|svg|template|noscript)\\b[^>]*>.*?</\\1\\s*>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    /** Hosts a page from anywhere may need: script libraries and a bot check. */
    private static final java.util.Set<String> ALLOWED_ELSEWHERE = new java.util.HashSet<>(java.util.Arrays.asList(
            "challenges.cloudflare.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com",
            "ajax.googleapis.com", "code.jquery.com", "cdn.tailwindcss.com"));

    /** The site a host belongs to: example.com for www.example.com, and
     *  example.co.kr for img.example.co.kr. */
    static String siteOf(String host) {
        if (host == null || host.isEmpty()) return null;
        String[] labels = host.toLowerCase(Locale.ROOT).split("\\.");
        int n = labels.length;
        if (n <= 2) return host.toLowerCase(Locale.ROOT);
        boolean twoPart = labels[n - 1].length() == 2
                && java.util.Arrays.asList("co", "com", "net", "org", "or", "ne", "go", "ac", "gov", "edu")
                        .contains(labels[n - 2]);
        int keep = twoPart ? 3 : 2;
        StringBuilder out = new StringBuilder();
        for (int i = n - keep; i < n; i++) {
            if (out.length() > 0) out.append('.');
            out.append(labels[i]);
        }
        return out.toString();
    }

    private static final String SCROLL = "try{if(document.body)window.scrollTo(0,document.body.scrollHeight);}catch(e){}";
    private static final String SHAPE = "(function(){try{var b=document.body;"
            + "var t=document.title||'';"
            + "var c=/just a moment|checking your browser|잠시만 기다|請稍候|请稍候|attention required/i.test(t+' '+(b?b.textContent.slice(0,300):''));"
            + "var r=(window.performance&&performance.getEntriesByType)?performance.getEntriesByType('resource').length:0;"
            + "return (window.__grimoirePending||0)+'|'+(b?b.textContent.length:0)+'|'+document.links.length+'|'+(c?'checking':'')+'|'+r+'|'+t;"
            + "}catch(e){return '0|0|0||0|';}})()";

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
                // Fresh every time, as a refresh is: a refusal or an error
                // page kept by a cache along the way would only be served
                // again when the page is asked for again.
                connection.setUseCaches(false);
                connection.setRequestProperty("Cache-Control", "no-cache");
                connection.setRequestProperty("Pragma", "no-cache");
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
        if (status == 429) return "the site turned the request away (429, too many requests)";
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
