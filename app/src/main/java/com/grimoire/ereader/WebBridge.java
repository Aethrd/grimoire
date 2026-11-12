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
    /** A few at a time -- books from different sites side by side. Each site is
     *  still asked no faster than its delay allows (web.js, pacer): this is only
     *  how many requests, to all sites together, may be on their way at once. */
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final java.net.CookieManager cookies = new java.net.CookieManager(null, CookiePolicy.ACCEPT_ALL);
    /** A few pages rendered at once -- each in a browser of its own -- but never
     *  two of one site: those share the site's cookies, and a site that keeps
     *  "the chapter being read" with them handed each the other's chapter (5화
     *  came back as 6화, and 6화 as 5화). Books from different sites downloaded
     *  side by side no longer wait on one another's pages. */
    private static final int RENDER_BROWSERS = 3;
    private final ExecutorService renderer = Executors.newFixedThreadPool(RENDER_BROWSERS);
    private final java.util.Set<String> renderingSites = new java.util.HashSet<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    /** How long a page may take to settle, and how long it must stay still
     *  to count as settled -- each longer at every level of patience the page
     *  asks for (a chapter that came back empty is asked for more patiently). */
    private static final long RENDER_MAX_MS = 40000;
    private static final long RENDER_MAX_STEP_MS = 10000;
    /** How long a page that says to wait -- a check at work, "잠시만 기다려",
     *  a spinner -- is waited on, on the same page, before it is given up:
     *  never reloaded meanwhile. */
    private static final long RENDER_WAIT_MS = 180000;
    private static final long RENDER_QUIET_MS = 2500;
    private static final long RENDER_QUIET_STEP_MS = 2000;
    /** How often the open page is looked at. Looking is on the phone, in the page already
     *  there -- it asks the site for nothing -- so it can be often. */
    private static final long RENDER_POLL_MS = 100;
    /** How long a chapter's story must stop growing to be taken, and longer on a try
     *  asked for patiently (its last try came back short). */
    private static final long STORY_STILL_MS = 500;
    /** Characters of story below which a text-only chapter is taken to have none yet. */
    private static final int STORY_SOME = 200;
    /** How long a text-only chapter with no story yet is watched, on the same page, before
     *  it is let go -- and only then asked for again: a reload is a request, and a delay.
     *  Watched while the page is still doing something; let go sooner once it has gone
     *  wholly still (STORY_GIVE_UP_MS), when nothing more is coming of it. */
    private static final long STORY_WAIT_MS = 90000;
    private static final long STORY_GIVE_UP_MS = 20000;
    private static final long STORY_STILL_PATIENT_MS = 2000;
    /** Once a chapter's story is there and still, the page is stayed on a few seconds more,
     *  as a reader would -- 3 s, give or take 1 -- and taken only if its story has not
     *  grown meanwhile. The time is taken off the delay before the next page (web.js,
     *  pacer), so a chapter takes no longer, and pages are no closer together. */
    private static final long CONFIRM_MS = 3000;
    private static final long CONFIRM_JITTER_MS = 1000;
    /** How long a page whose content is plainly there -- a list with its
     *  chapters, a chapter with its story -- must stay still. The full quiet
     *  spell is for a page where that cannot be seen. */
    private static final long READY_QUIET_MS = 900;
    private static final long READY_LIST_QUIET_MS = 1200;
    /** A chapter's story, in one block of text, long enough to be the chapter. */
    private static final int READY_STORY = 1500;
    /** A short chapter: this much, over at least this many lines. */
    private static final int SHORT_STORY = 400;
    private static final int SHORT_STORY_LINES = 8;
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
        /* The sites' cookies are kept from one launch to the next, as a phone's
         * browser keeps them: a check the reader passed is passed still, until
         * the site says it has run out, and the site sees the reader it saw
         * before rather than someone new each time the app is opened. Cleared
         * for a site with forgetSite. */
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
        final boolean scroll = list != null && (list.equals("1") || list.startsWith("1:"));
        /* "1:gap:jitter": a contents page whose "show more" is pressed, as a reader
         * would, gap ± jitter apart, for as long as it brings more (see poll). */
        long gap = -1;
        long jitter = 0;
        if (scroll && list.startsWith("1:")) {
            String[] bits = list.split(":");
            try {
                gap = Math.max(0, Long.parseLong(bits[1]));
                if (bits.length > 2) jitter = Math.max(0, Long.parseLong(bits[2]));
            } catch (NumberFormatException ignored) {
                gap = -1;
            }
        }
        final long pressGap = gap;
        final long pressJitter = jitter;
        // "t": a chapter wanted for its text alone -- one with none is no chapter.
        final boolean textOnly = "t".equals(list);
        // "2", or "0o": a level, and "o" when the site has been found to need
        // nothing kept out (its pages come only with everything let in).
        String asked = String.valueOf(patience).trim();
        boolean open = asked.endsWith("o");
        if (open) asked = asked.substring(0, asked.length() - 1);
        int level = 0;
        try {
            level = Math.max(0, Math.min(3, Integer.parseInt(asked)));
        } catch (NumberFormatException ignored) {
            // Not a number: the usual patience.
        }
        final long quietMs = RENDER_QUIET_MS + level * RENDER_QUIET_STEP_MS;
        // Other sites' adverts and trackers kept out, unless the page is asked
        // for with everything let in ("o"): the waiting and the letting in are
        // asked for apart (see web.js, askAgain).
        final boolean ownSiteOnly = !open;
        final long maxMs = RENDER_MAX_MS + level * RENDER_MAX_STEP_MS;
        /* Pictures, fonts and video left out only where other sites' adverts are kept
         * out anyway. A site found to need everything let in may be one that holds its
         * chapter back until its adverts have shown: leaving out their pictures did that
         * to every chapter, each then coming only at the third try. */
        final boolean skipHeavy = ownSiteOnly;
        renderer.execute(() -> {
            String safeId = id == null ? "x" : id.replaceAll("[^A-Za-z0-9_-]", "_");
            File target = new File(dir(), safeId);
            try {
                URL url = new URL(address);
                String scheme = url.getProtocol().toLowerCase(Locale.ROOT);
                if (!scheme.equals("http") && !scheme.equals("https")) {
                    throw new IOException("only web addresses can be downloaded");
                }
                // Pictures, fonts and video are never what the reader takes from a page --
                // the pictures it keeps are fetched on their own, from their addresses --
                // so they are not loaded. At the most patient try, everything is.
                Rendering job = new Rendering(address, quietMs, maxMs, scroll, ownSiteOnly, skipHeavy, textOnly);
                job.pressGap = pressGap;
                job.pressJitter = pressJitter;
                // One page of a site at a time: another of its pages waits its turn here.
                String siteKey = job.site == null ? address : job.site;
                synchronized (renderingSites) {
                    while (renderingSites.contains(siteKey)) renderingSites.wait();
                    renderingSites.add(siteKey);
                }
                try {
                    main.post(job::start);
                    if (!job.done.await((pressGap >= 0 ? PRESS_MAX_MS : RENDER_WAIT_MS) + 20000, TimeUnit.MILLISECONDS)) {
                        main.post(job::finish);
                        throw new IOException("the site took too long to answer");
                    }
                } finally {
                    synchronized (renderingSites) {
                        renderingSites.remove(siteKey);
                        renderingSites.notifyAll();
                    }
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
                result.put("dwell", job.dwell);
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

    /* ── the site, shown ───────────────────────────────────────────────────
     *
     * A site behind a check -- Cloudflare's "Just a moment", "잠시만
     * 기다리십시오" -- that the unseen browser cannot pass: it is not shown,
     * and some checks want to be seen, or a box ticked. So the site is shown
     * instead, over the app, in a browser of the same kind with the same
     * cookies: the check is passed there, by itself or by a tap, and what it
     * leaves (its cookie) lets the unseen browser in after. Done, at the
     * foot, closes it. Also what to open to see a site as the downloader does.
     */
    private View shown;
    private String shownId;
    private WebView shownView;

    @JavascriptInterface
    public void showSite(final String id, final String address) {
        openShown(id, address, false);
    }

    /** The site shown to pick chapters from by hand: long-press one and drag over the
     *  rest (or tap the first and then the last), then Use selected -- the links in
     *  the selection, in the page's order, are what is answered. */
    @JavascriptInterface
    public void pickFromSite(final String id, final String address) {
        openShown(id, address, true);
    }

    /** Whether the shown site is for picking links (see pickFromSite). */
    private boolean shownPicking;

    /* Into a page shown for picking: links marked by the finger.
     *
     *   hold a link, then drag: every link from it to the one under the finger
     *   is marked; near the top or bottom the page scrolls on. The hold is
     *   noticed by the app, before the page (see openShown's touch listener),
     *   which tells the page here: holdAt, dragTo, release -- Android's own
     *   long-press (a selection, a link's menu) or the page starting to scroll
     *   otherwise took the touch away, and the hold did nothing;
     *   or tap one chapter, then another: both and everything between marked.
     *
     * A chapter tapped is marked, not followed. What only opens out the list --
     * "더보기", "펼치기", "Show more", a link that goes nowhere but the page's own
     * script -- is let through: some lists are opened out before they can be
     * picked from. The page's guards against selecting and copying (and its
     * long-press menu) are set aside. Added before the page's own scripts run. */
    private static final String PICKABLE = "(function(){if(window.__gPick)return;var p=window.__gPick={start:null,from:null,at:0};"
            + "var css='*{-webkit-user-select:text!important;user-select:text!important}"
            + ".__gPicked{background:rgba(216,167,177,.38)!important;outline:1px solid #d8a7b1!important}"
            + ".__gPickStart{outline:3px solid #d8a7b1!important;outline-offset:2px}';"
            + "var addStyle=function(){if(document.getElementById('__gPickStyle'))return;var st=document.createElement('style');st.id='__gPickStyle';"
            + "st.textContent=css;(document.head||document.documentElement).appendChild(st);};"
            + "if(document.documentElement)addStyle();document.addEventListener('DOMContentLoaded',addStyle);"
            + "['selectstart','copy'].forEach(function(t){window.addEventListener(t,function(e){e.stopImmediatePropagation();},true);});"
            + "window.addEventListener('contextmenu',function(e){e.preventDefault();e.stopImmediatePropagation();},true);"
            /* A chapter: a link, or what a reader's own contents list holds its address
             * in -- data-href, data-url, data-link -- where its items are no links. */
            + "var SEL='a[href],[data-href],[data-url],[data-link]';"
            + "var hrefOf=function(e){var h=e.getAttribute('href');return h!=null?h:(e.getAttribute('data-href')||e.getAttribute('data-url')||e.getAttribute('data-link')||'');};"
            + "var all=function(){return Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(chapterish);};"
            /* A link to another page, not one that only opens out the list. */
            + "var MORE=/^\\s*([+▼▽∨⌄]|(이전|다음)?\\s*(회차|목록)?\\s*(더\\s*보기|펼치기|펼쳐보기|전체\\s*보기|모두\\s*보기)|전체|show\\s*(more|all)|load\\s*more|view\\s*all|see\\s*all|more|expand|all\\s*chapters)\\s*[▼▽+…]*\\s*$/i;"
            + "var chapterish=function(a){var h=hrefOf(a);if(!h||/^\\s*(#|javascript:)/i.test(h))return false;"
            + "try{var u=new URL(h,location.href);if(!/^https?:$/.test(u.protocol))return false;"
            + "if(u.origin+u.pathname+u.search===location.origin+location.pathname+location.search)return false;}catch(x){return false;}"
            + "return !MORE.test((a.textContent||'').replace(/\\s+/g,' '));};"
            + "var mark=function(x,y){var l=all(),i=l.indexOf(x),j=l.indexOf(y);if(i<0||j<0)return;if(i>j){var t=i;i=j;j=t;}"
            + "l.forEach(function(a,k){if(k>=i&&k<=j)a.classList.add('__gPicked');else a.classList.remove('__gPicked');});};"
            + "var linkAt=function(x,y){var w=window.innerWidth,xs=[x,w*.25,w*.5,w*.75];for(var i=0;i<xs.length;i++){"
            + "var e=document.elementFromPoint(xs[i],y),a=e&&e.closest?e.closest(SEL):null;if(a&&chapterish(a))return a;}return null;};"
            /* Something meant to be pressed, with no address to it: a reader's list whose
             * chapters its own script opens -- there is nothing there to take. */
            + "var addressless=function(x,y){var e=document.elementFromPoint(x,y);if(!e||!e.closest)return false;"
            + "var it=e.closest('li,button,[role=\"button\"],[role=\"listitem\"],[role=\"option\"],[onclick],[tabindex]');"
            + "if(!it&&getComputedStyle(e).cursor==='pointer')it=e;"
            + "return !!it&&!it.closest(SEL)&&/\\S/.test(it.textContent||'');};"
            + "var drag=false,quiet=false,moved=false,fx=0,fy=0,roll=null;"
            /* Quiet (the Drag switch on, where a touch begins at once): nothing marked
             * until the finger moves off the chapter it began on, and one that never
             * does was a tap -- the first or the last of a range. */
            + "var follow=function(){var a=linkAt(fx,fy);if(!a||!p.from)return;if(quiet&&!moved&&a===p.from)return;moved=true;mark(p.from,a);};"
            + "var tap=function(a){if(!p.start){p.start=a;a.classList.add('__gPickStart');return;}"
            + "var x=p.start;p.start=null;x.classList.remove('__gPickStart');mark(x,a);};"
            + "var begin=function(a,x,y,q){drag=true;quiet=!!q;moved=false;p.from=a;"
            + "if(!quiet){p.start=null;Array.prototype.forEach.call(document.querySelectorAll('.__gPickStart'),function(b){b.classList.remove('__gPickStart');});mark(a,a);}"
            + "fx=x;fy=y;clearInterval(roll);roll=setInterval(function(){var h=window.innerHeight,edge=90;"
            + "if(fy>h-edge)window.scrollBy(0,Math.round(6+(fy-(h-edge))/2));else if(fy<edge)window.scrollBy(0,-Math.round(6+(edge-fy)/2));"
            + "follow();},40);};"
            + "var end=function(){if(drag){drag=false;clearInterval(roll);p.at=Date.now();}};"
            /* The app's hold: where the finger is, in the screen's own pixels. */
            + "var toPage=function(x,y){var v=window.visualViewport,d=window.devicePixelRatio||1,s=v?v.scale:1;"
            + "return{x:x/(d*s)+(v?v.offsetLeft:0),y:y/(d*s)+(v?v.offsetTop:0)};};"
            + "p.holdAt=function(x,y,q){var c=toPage(x,y),a=linkAt(c.x,c.y);if(!a)return addressless(c.x,c.y)?'none':false;begin(a,c.x,c.y,q);return true;};"
            + "p.dragTo=function(x,y){if(!drag)return;var c=toPage(x,y);fx=c.x;fy=c.y;follow();};"
            + "p.release=function(){var was=drag&&quiet&&!moved,a=p.from;end();if(was&&a)tap(a);};"
            /* Lifted before the app took the touch: the page had it all, its tap included. */
            + "p.cancelHold=function(){drag=false;clearInterval(roll);};"
            /* The page's own hold, where the app does not catch it (the tests; an old Android). */
            + "var hold=null,down=null;"
            + "window.addEventListener('touchstart',function(e){if(window.__gPickNative||e.touches.length!==1)return;var t=e.touches[0];"
            + "var a=linkAt(t.clientX,t.clientY);if(!a)return;down={x:t.clientX,y:t.clientY};clearTimeout(hold);"
            + "hold=setTimeout(function(){begin(a,down.x,down.y);try{navigator.vibrate&&navigator.vibrate(15);}catch(x){}},450);},{capture:true,passive:true});"
            + "window.addEventListener('touchmove',function(e){if(window.__gPickNative)return;var t=e.touches[0];"
            + "if(!drag){if(down&&(Math.abs(t.clientX-down.x)>16||Math.abs(t.clientY-down.y)>16)){clearTimeout(hold);down=null;}return;}"
            + "e.preventDefault();fx=t.clientX;fy=t.clientY;follow();},{capture:true,passive:false});"
            + "var up=function(){clearTimeout(hold);down=null;if(!window.__gPickNative)end();};"
            + "window.addEventListener('touchend',up,true);window.addEventListener('touchcancel',up,true);"
            + "window.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest(SEL):null;if(!a||!chapterish(a))return;"
            + "e.preventDefault();e.stopImmediatePropagation();if(Date.now()-p.at<400)return;tap(a);},true);})();";

    /** The picking script, said to come from the app's own hold (see holdToPick). */
    private static final String PICKING_STARTS = "window.__gPickNative=1;" + PICKABLE;

    /** The Drag switch in the picker's bar: on, a touch on a chapter picks at once, no hold. */
    private boolean pickDrag;
    /** Said already, for the page shown: its list's items have no addresses. */
    private boolean toldNoAddress;

    /**
     * Hold and drag to pick, noticed here, before the page: a finger held still
     * on a chapter (a little sooner than Android's own long-press, so the page's
     * text selection or link menu never gets it -- and those are turned off
     * besides), and the page is asked to begin there (__gPick.holdAt). Once it
     * has, the touch is the app's: the page is told it was cancelled, so it
     * neither scrolls nor selects, and every move is passed on (dragTo) until
     * the finger lifts (release). A finger that moves first is the page's: a
     * scroll. With the Drag switch on there is no hold: a touch on a chapter
     * begins at once (and one never moved is a tap, the first or last of a
     * range); a touch anywhere else is still the page's, to scroll or press.
     */
    @SuppressLint("ClickableViewAccessibility")
    private void holdToPick(final WebView view) {
        final int slop = android.view.ViewConfiguration.get(activity).getScaledTouchSlop();
        final long hold = Math.max(300, Math.round(android.view.ViewConfiguration.getLongPressTimeout() * 0.75));
        // The page's own long-press -- a selection, a link's menu -- is not had here.
        view.setOnLongClickListener((v) -> true);
        view.setHapticFeedbackEnabled(false);
        view.setOnTouchListener(new View.OnTouchListener() {
            private float downX;
            private float downY;
            private long downTime;
            private boolean down;
            private boolean asking;
            private boolean dragging;
            private long lastMove;
            private float atX;
            private float atY;
            private final Runnable begin = () -> {
                if (!down || dragging) return;
                asking = true;
                final boolean quiet = pickDrag;
                view.evaluateJavascript("window.__gPick&&__gPick.holdAt(" + downX + "," + downY + "," + quiet + ")", (began) -> {
                    asking = false;
                    if ("\"none\"".equals(began) && !toldNoAddress) {
                        toldNoAddress = true;
                        android.widget.Toast.makeText(activity,
                                "These chapters have no addresses - the site's reader opens them by its own script, so the app can't take them. Try the book's own contents page on the site.",
                                android.widget.Toast.LENGTH_LONG).show();
                    }
                    if (!"true".equals(began)) return;          // not on a chapter: the page's touch
                    if (!down) {
                        // Lifted meanwhile: the page had the whole touch, its tap too.
                        view.evaluateJavascript("window.__gPick&&__gPick.cancelHold()", null);
                        return;
                    }
                    dragging = true;
                    if (!quiet) {
                        view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS,
                                android.view.HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
                    }
                    android.view.MotionEvent cancel = android.view.MotionEvent.obtain(downTime, android.os.SystemClock.uptimeMillis(),
                            android.view.MotionEvent.ACTION_CANCEL, atX, atY, 0);
                    view.onTouchEvent(cancel);
                    cancel.recycle();
                    view.evaluateJavascript("window.__gPick&&__gPick.dragTo(" + atX + "," + atY + ")", null);
                });
            };

            @Override
            public boolean onTouch(View v, android.view.MotionEvent e) {
                switch (e.getActionMasked()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        downX = e.getX();
                        downY = e.getY();
                        atX = downX;
                        atY = downY;
                        downTime = e.getDownTime();
                        down = true;
                        dragging = false;
                        asking = false;
                        v.removeCallbacks(begin);
                        if (pickDrag) begin.run();
                        else v.postDelayed(begin, hold);
                        return false;
                    case android.view.MotionEvent.ACTION_POINTER_DOWN:
                        v.removeCallbacks(begin);
                        return dragging;
                    case android.view.MotionEvent.ACTION_MOVE:
                        atX = e.getX();
                        atY = e.getY();
                        if (dragging) {
                            long now = android.os.SystemClock.uptimeMillis();
                            if (now - lastMove >= 30) {
                                lastMove = now;
                                view.evaluateJavascript("window.__gPick&&__gPick.dragTo(" + atX + "," + atY + ")", null);
                            }
                            return true;
                        }
                        if (!pickDrag && Math.hypot(atX - downX, atY - downY) > slop) v.removeCallbacks(begin);
                        return false;
                    case android.view.MotionEvent.ACTION_UP:
                    case android.view.MotionEvent.ACTION_CANCEL:
                        down = false;
                        v.removeCallbacks(begin);
                        if (dragging) {
                            dragging = false;
                            view.evaluateJavascript("window.__gPick&&__gPick.dragTo(" + e.getX() + "," + e.getY() + ");"
                                    + "window.__gPick&&__gPick.release()", null);
                            return true;
                        }
                        return false;
                    default:
                        return dragging;
                }
            }
        });
    }

    /** The links marked (or, failing that, in the page's selection), in the page's
     *  order, as [{url, text}]. */
    private static final String PICKED = "(function(){try{var out=[],seen={},s=window.getSelection();"
            + "var as=document.querySelectorAll('a[href],[data-href],[data-url],[data-link]'),marked=document.querySelectorAll('.__gPicked').length>0;"
            + "for(var i=0;i<as.length;i++){var a=as[i],u='';"
            + "try{u=new URL(a.getAttribute('href')!=null?a.getAttribute('href'):(a.getAttribute('data-href')||a.getAttribute('data-url')||a.getAttribute('data-link')||''),location.href).href;}catch(x){continue;}"
            + "if(!/^https?:/i.test(u)||seen[u])continue;var hit=false;"
            + "if(marked)hit=a.classList.contains('__gPicked');"
            + "else if(s)for(var r=0;r<s.rangeCount&&!hit;r++)hit=s.getRangeAt(r).intersectsNode(a);"
            + "if(hit){seen[u]=1;out.push({url:u,text:(a.textContent||'').replace(/\\s+/g,' ').trim()});}}"
            + "return JSON.stringify(out);}catch(e){return '[]';}})()";

    @SuppressLint("SetJavaScriptEnabled")
    private void openShown(final String id, final String address, final boolean pick) {
        main.post(() -> {
            try {
                Uri uri = Uri.parse(address);
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
                if (!scheme.equals("http") && !scheme.equals("https")) {
                    settle(id, false, "only web addresses can be opened");
                    return;
                }
                finishShown();
                final WebView view = new WebView(activity);
                WebSettings settings = view.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(true);
                settings.setUserAgentString(userAgent);
                settings.setAllowFileAccess(false);
                settings.setAllowContentAccess(false);
                settings.setSupportMultipleWindows(false);
                CookieManager manager = CookieManager.getInstance();
                manager.setAcceptCookie(true);
                manager.setAcceptThirdPartyCookies(view, true);
                view.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        String s = request.getUrl().getScheme();
                        return s == null || !(s.equalsIgnoreCase("http") || s.equalsIgnoreCase("https"));
                    }

                    @Override
                    public void onPageCommitVisible(WebView v, String url) {
                        if (pick) v.evaluateJavascript(PICKING_STARTS, null);
                    }

                    @Override
                    public void onPageFinished(WebView v, String url) {
                        if (pick) v.evaluateJavascript(PICKING_STARTS, null);
                    }

                    @Override
                    public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                        closeShown();
                        settle(id, false, "Android stopped the page's browser to free memory");
                        return true;
                    }
                });

                android.widget.LinearLayout column = new android.widget.LinearLayout(activity);
                column.setOrientation(android.widget.LinearLayout.VERTICAL);
                column.setBackgroundColor(0xFF15131A);
                column.setFitsSystemWindows(true);
                column.setClickable(true);   // nothing under it is touched meanwhile
                column.addView(view, new android.widget.LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

                android.widget.LinearLayout bar = new android.widget.LinearLayout(activity);
                bar.setOrientation(android.widget.LinearLayout.HORIZONTAL);
                bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
                int pad = Math.round(12 * activity.getResources().getDisplayMetrics().density);
                bar.setPadding(pad, pad / 2, pad, pad / 2);
                android.widget.TextView note = new android.widget.TextView(activity);
                note.setText(pick
                        ? "Hold a chapter, then drag over the rest - or tap the first, then the last. Drag on: no hold needed."
                        : "Let the site's check pass (tap it if it asks), then Done.");
                note.setTextColor(0xFFE6E1EA);
                note.setTextSize(13);
                bar.addView(note, new android.widget.LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                // Picking: the note on a line of its own, the buttons under it, so neither is squeezed.
                android.widget.LinearLayout buttons = bar;
                if (pick) {
                    bar.setOrientation(android.widget.LinearLayout.VERTICAL);
                    bar.setGravity(android.view.Gravity.NO_GRAVITY);
                    note.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    buttons = new android.widget.LinearLayout(activity);
                    buttons.setOrientation(android.widget.LinearLayout.HORIZONTAL);
                    buttons.setGravity(android.view.Gravity.END | android.view.Gravity.CENTER_VERTICAL);
                    bar.addView(buttons, new android.widget.LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                }
                pickDrag = false;
                toldNoAddress = false;
                if (pick) {
                    // The Drag switch: a touch on a chapter picks at once; off, the page scrolls as ever.
                    final android.widget.Button drag = new android.widget.Button(activity);
                    drag.setText("Drag: off");
                    drag.setAllCaps(false);
                    drag.setOnClickListener((b) -> {
                        pickDrag = !pickDrag;
                        drag.setText(pickDrag ? "Drag: on" : "Drag: off");
                    });
                    buttons.addView(drag);
                }
                android.widget.Button done = new android.widget.Button(activity);
                done.setText(pick ? "Use selected" : "Done");
                done.setAllCaps(false);
                done.setOnClickListener((b) -> finishShown());
                buttons.addView(done);
                column.addView(bar, new android.widget.LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

                if (pick) {
                    // Before the page's own scripts, so a tap never gets past it; and
                    // again once it shows, where that cannot be done.
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        WebViewCompat.addDocumentStartJavaScript(view, PICKING_STARTS, Collections.singleton("*"));
                    }
                    holdToPick(view);
                }

                ViewGroup root = activity.findViewById(android.R.id.content);
                if (root == null) {
                    settle(id, false, "the site could not be shown");
                    return;
                }
                root.addView(column, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                shown = column;
                shownId = id;
                shownView = view;
                shownPicking = pick;
                view.loadUrl(address);
            } catch (Exception e) {
                settle(id, false, describe(e));
            }
        });
    }

    /** Done (or back): what the site left kept, the site closed, the page told. Picking,
     *  the links selected are read off the page first, and told too. */
    private void finishShown() {
        WebView view = shownView;
        if (shownPicking && view != null) {
            shownPicking = false;
            final String title = view.getTitle();
            view.evaluateJavascript(PICKED, (picked) -> finishShown(picked, title));
            return;
        }
        finishShown(null, null);
    }

    private void finishShown(String picked, String title) {
        String id = shownId;
        WebView view = shownView;
        String at = view != null && view.getUrl() != null ? view.getUrl() : null;
        if (at != null) keepRenderedCookies(at);
        // Kept now, not whenever the browser next saves: the app may be closed first.
        try { CookieManager.getInstance().flush(); } catch (Exception ignored) { /* kept later */ }
        closeShown();
        if (id == null) return;
        JSONObject result = new JSONObject();
        try {
            result.put("url", at);
            if (picked != null) {
                // evaluateJavascript answers with the string JSON-quoted: unquoted, then read.
                String list = picked;
                if (list.startsWith("\"")) list = new org.json.JSONTokener(list).nextValue().toString();
                result.put("links", new org.json.JSONArray(list));
                result.put("title", title == null ? "" : title);
            }
        } catch (JSONException ignored) { /* none picked */ }
        settle(id, true, result.toString());
    }

    /** The shown site, closed: its browser destroyed with it. */
    private void closeShown() {
        View gone = shown;
        shown = null;
        shownId = null;
        shownView = null;
        shownPicking = false;
        if (gone == null) return;
        try {
            ViewGroup parent = (ViewGroup) gone.getParent();
            if (parent != null) parent.removeView(gone);
            if (gone instanceof ViewGroup) {
                ViewGroup group = (ViewGroup) gone;
                for (int i = 0; i < group.getChildCount(); i++) {
                    if (group.getChildAt(i) instanceof WebView) ((WebView) group.getChildAt(i)).destroy();
                }
            }
        } catch (Exception ignored) {
            // Gone either way.
        }
    }

    /** Whether the shown site is up (the back gesture closes it first). */
    boolean closeShownIfOpen() {
        if (shown == null) return false;
        // Back, while picking, is leaving without: nothing picked is answered.
        shownPicking = false;
        finishShown();
        return true;
    }

    /** Pause & keep: the page the renderer is on is left now, not waited out.
     *  (Its answer, and any plain fetch's still on its way, are ignored.) */
    @JavascriptInterface
    public void stopAll() {
        main.post(() -> {
            for (Browser each : browsers) {
                Rendering job = each.current;
                if (job != null) job.fail("paused");
            }
        });
    }

    /** A site's cookies forgotten -- the browser's and the plain fetches' -- so it sees
     *  someone new: for a site stuck on a check, or one the reader would rather. */
    @JavascriptInterface
    public void forgetSite(final String address) {
        main.post(() -> {
            try {
                URI uri = new URI(address);
                String host = uri.getHost();
                if (host == null) return;
                CookieManager manager = CookieManager.getInstance();
                String site = siteOf(host);
                for (String place : new String[]{host, site}) {
                    String header = manager.getCookie("https://" + place);
                    if (header == null) continue;
                    for (String part : header.split(";\\s*")) {
                        int eq = part.indexOf('=');
                        if (eq <= 0) continue;
                        String name = part.substring(0, eq).trim();
                        for (String scheme : new String[]{"https://", "http://"}) {
                            manager.setCookie(scheme + place, name + "=; Max-Age=0; Path=/");
                            manager.setCookie(scheme + place, name + "=; Max-Age=0; Path=/; Domain=." + site);
                        }
                    }
                }
                manager.flush();
                // And the plain fetches' copies, kept by the address they came with.
                java.net.CookieStore store = cookies.getCookieStore();
                for (URI kept : store.getURIs().toArray(new URI[0])) {
                    String keptHost = kept.getHost();
                    if (keptHost == null || !keptHost.endsWith(site)) continue;
                    for (HttpCookie cookie : store.get(kept).toArray(new HttpCookie[0])) store.remove(kept, cookie);
                }
            } catch (Exception ignored) {
                // Nothing to forget, or nothing that would be.
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
     * A few (one for each page rendered at once), each used for page after
     * page, not one made and thrown away for each:
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
    /** The unseen browsers: as many as pages rendered at once (RENDER_BROWSERS). Main thread only. */
    private final List<Browser> browsers = new java.util.ArrayList<>();

    /** One unseen browser, and the page it is reading now: its events go to that page, others' nowhere. */
    private final class Browser {
        WebView view;
        int uses;
        boolean tracked;
        volatile Rendering current;
        final Runnable close = this::drop;

        void drop() {
            WebView gone = view;
            view = null;
            uses = 0;
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
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView browserFor(Rendering job) {
        // A browser not reading a page -- one already made, if there is one.
        Browser free = null;
        for (Browser each : browsers) {
            if (each.current != null) continue;
            if (free == null || (free.view == null && each.view != null)) free = each;
        }
        if (free == null) {
            free = new Browser();
            browsers.add(free);
        }
        final Browser b = free;
        main.removeCallbacks(b.close);
        if (b.view != null && b.uses >= BROWSER_USES) b.drop();
        if (b.view == null) {
            WebView view = new WebView(activity);
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setUserAgentString(userAgent);
            settings.setLoadsImagesAutomatically(false); // pictures are fetched later, as files
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            CookieManager manager = CookieManager.getInstance();
            manager.setAcceptCookie(true);
            manager.setAcceptThirdPartyCookies(view, true);
            view.setWebViewClient(new BrowserClient(b));
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
            b.tracked = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
            if (b.tracked) {
                WebViewCompat.addDocumentStartJavaScript(view, TRACKER, Collections.singleton("*"));
            }
            b.view = view;
        }
        b.uses += 1;
        b.current = job;
        job.browser = b;
        return b.view;
    }

    /** Done with a page: its browser emptied for the next, or closed if none comes. */
    private void browserDone(Rendering job) {
        Browser b = job.browser;
        if (b == null) return;
        if (b.current == job) b.current = null;
        WebView view = b.view;
        if (view != null) {
            try {
                view.stopLoading();
                view.loadUrl("about:blank");
                view.clearHistory();
            } catch (Exception ignored) {
                b.drop();
            }
        }
        main.removeCallbacks(b.close);
        main.postDelayed(b.close, BROWSER_IDLE_MS);
    }

    /** A browser's events, passed to the page it is reading; the blank page between is no one's. */
    private final class BrowserClient extends WebViewClient {
        private final Browser b;

        BrowserClient(Browser b) {
            this.b = b;
        }

        private Rendering reading(String url) {
            if (url != null && url.startsWith("about:")) return null;
            return b.current;
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
            if (v == b.view) {
                b.view = null;
                b.uses = 0;
            }
            try {
                ViewGroup parent = (ViewGroup) v.getParent();
                if (parent != null) parent.removeView(v);
                v.destroy();
            } catch (Exception ignored) {
                // Gone either way.
            }
            Rendering job = b.current;
            if (job != null) job.fail("Android stopped the page's browser to free memory");
            return true;
        }

        /* Another site's adverts, trackers and frames: kept out, so the page
         * costs the phone a fraction of what it would. Its own site, the
         * common script libraries and Cloudflare's check still load. */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
            Rendering job = b.current;
            if (job == null) {
                // Between pages: nothing of the last one may go on loading.
                String s = request.getUrl().getScheme();
                return "about".equalsIgnoreCase(s) ? null
                        : new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
            if (request.isForMainFrame()) return null;
            String host = request.getUrl().getHost();
            if (host == null || ALLOWED_ELSEWHERE.contains(host.toLowerCase(Locale.ROOT))) return null;
            if (job.lean && isHeavy(request)) {
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
            if (!job.ownSiteOnly) return null;
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
            if (!b.tracked) v.evaluateJavascript(TRACKER, null);
            job.begin();
        }

        /** The page is on show: its first paint, adverts or no adverts. */
        @Override
        public void onPageCommitVisible(WebView v, String url) {
            Rendering job = reading(url);
            if (job == null) return;
            job.visible = true;
            job.begin();
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
            Rendering job = b.current;
            if (job != null && request.isForMainFrame()) {
                job.mainStatus = response.getStatusCode();
                Map<String, String> headers = response.getResponseHeaders();
                if (headers != null) {
                    for (Map.Entry<String, String> header : headers.entrySet()) {
                        if ("retry-after".equalsIgnoreCase(header.getKey())) job.retryAfter = header.getValue();
                    }
                }
            }
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
        /** Pictures, fonts and video not loaded (see render). */
        final boolean lean;
        /** A chapter wanted for its text alone (see STORY_WAIT_MS). */
        final boolean textOnly;
        /** The page has finished loading (or been given long enough to). */
        private boolean finished;
        /** The page is on show (see onPageCommitVisible). */
        boolean visible;
        private int lastStory = -1;
        /* Pressing a list's "show more": how far apart (-1: never), how many times
         * so far, when next, the list's length at the last press, and how many
         * presses in a row brought nothing. */
        long pressGap = -1;
        long pressJitter;
        private int presses;
        private long nextPress;
        private int linksAtPress = -1;
        private int flat;
        private boolean pressedOut;
        private long storySince;
        /** Staying on to confirm the story (see CONFIRM_MS): since when, for how long, at what length. */
        private long confirmBegan;
        private long confirmAt;
        private long confirmFor;
        private int confirmStory = -1;
        /** How long the page was stayed on to confirm it: credited against the next delay. */
        volatile long dwell;
        /** The site the page is on, for telling its own requests from others'. */
        volatile String site;
        final CountDownLatch done = new CountDownLatch(1);
        /** The page as evaluateJavascript gave it: a JSON string, decoded off the main thread. */
        volatile String raw;
        volatile String error;
        volatile String finalUrl;
        volatile int mainStatus;
        /** What a site that said "too many requests" asked to be given (Retry-After). */
        volatile String retryAfter;
        private WebView view;
        /** The browser it is read in (see browserFor). */
        Browser browser;
        private boolean loaded;
        private String lastShape = "";
        /** What it was opened for is plainly on the page: then it is kept. */
        private boolean there;
        private long stillSince;
        private long startedAt;

        Rendering(String address, long quietMs, long maxMs, boolean scroll, boolean ownSiteOnly, boolean lean,
                  boolean textOnly) {
            this.address = address;
            this.textOnly = textOnly;
            this.lean = lean;
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
                // The reader's view turns cookies off whenever it is set up;
                // a check passed is a cookie, so they are on for every page.
                CookieManager.getInstance().setAcceptCookie(true);
                view.loadUrl(address);
                main.postDelayed(() -> {
                    finished = true;
                    if (!loaded && view != null) { loaded = true; poll(); }
                }, maxMs / 2);
            } catch (Exception e) {
                fail(describe(e));
            }
        }

        void pageFinished() {
            finished = true;
            begin();
        }

        /* Looked at from the moment the page begins to come, not only once it has
         * finished loading: "finished" waits on every picture and advert frame, and
         * the chapter is on show -- what a reader waits for -- well before. */
        void begin() {
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
                // "pending|text|links|checking|resources|chapters|title": all
                // but the pending count make the page's shape.
                String[] parts = reply.replace("\"", "").split("\\|", 10);
                int textLength = 0;
                int chapterLinks = 0;
                // Every link on the page: what a list's "show more" adds to (the
                // chapter count above stops at nine -- enough to know a list).
                int allLinks = 0;
                boolean loading = false;
                int storyLength = 0;
                int storyLines = 0;
                try {
                    storyLength = Integer.parseInt(parts[7]);
                    storyLines = Integer.parseInt(parts[8]);
                } catch (Exception ignored) {
                    // Unreadable: as though no story were there yet.
                }
                try {
                    textLength = Integer.parseInt(parts[1]);
                    chapterLinks = Integer.parseInt(parts[5]);
                    allLinks = Integer.parseInt(parts[2]);
                    loading = "1".equals(parts[6]);
                } catch (Exception ignored) {
                    // Unreadable: as though nothing were there yet.
                }
                int bar = reply.indexOf('|');
                int pending = 0;
                try {
                    pending = Integer.parseInt(reply.substring(1, Math.max(1, bar)));
                } catch (Exception ignored) {
                    // Unreadable: as though nothing were pending.
                }
                String shape = bar < 0 ? reply : reply.substring(bar + 1);
                long now = System.currentTimeMillis();
                // "Too many requests": said at once -- nothing on the page is coming, and
                // the download slows down for it (see web.js).
                if (mainStatus == 429) {
                    fail(tooMany(retryAfter));
                    return;
                }
                // Blocked outright: said at once, never waited out or retried.
                if (shape.contains("|blocked|")) {
                    fail(BLOCKED);
                    return;
                }
                boolean waiting = shape.contains("|checking|"); // a bot check still at work
                if (!shape.equals(lastShape) || waiting) {
                    lastShape = shape;
                    stillSince = now;
                }
                long still = now - stillSince;
                boolean blank = shape.startsWith("0|");
                /* What it was opened for, there to see: a list showing its
                 * chapters, a chapter its story. Then it is taken once it has
                 * been still a moment, not after the whole quiet spell --
                 * twenty-three pages of a list were five minutes of waiting. */
                // A chapter asked for again (patiently) gets the whole spell:
                // its text being there did not mean its story was, last time.
                boolean patient = quietMs > RENDER_QUIET_MS;
                // A chapter's story: long, or shorter over many lines.
                boolean storyThere = storyLength >= READY_STORY
                        || (storyLength >= SHORT_STORY && storyLines >= SHORT_STORY_LINES);
                boolean ready = scroll ? chapterLinks >= 3 : !patient && storyThere;
                // Plainly there, whatever else the page seems to be doing.
                there = scroll ? chapterLinks >= 3 : storyThere;
                /* A chapter with no story on it yet is given longer to be still: a
                 * site that puts the chapter up a few seconds after the page opens
                 * shows nothing changing meanwhile, and taken then, it was all a
                 * retry -- a whole delay -- to come back for. */
                long need = ready ? Math.min(quietMs, scroll ? READY_LIST_QUIET_MS : READY_QUIET_MS)
                        : (!scroll && !there ? quietMs * 2 : quietMs);
                // Settled: nothing more on its way and nothing changing -- or
                // nothing changing for so long that what is still on its way
                // is not the page.
                // A chapter whose page still shows "loading" is not ready, however
                // still it is (a site that waits before putting the chapter up).
                /* Says to wait -- a check at work, a chapter's "loading" -- while
                 * what it was opened for is not there yet: then it is waited on,
                 * on the same page, not taken, timed out or reloaded, for up to
                 * RENDER_WAIT_MS. Once the chapter is there, a spinner left
                 * going elsewhere on the page (comments, adverts) holds nothing:
                 * that held every chapter for the whole three minutes. */
                /* A chapter wanted for its text, with none yet: watched on the same page
                 * for up to STORY_WAIT_MS, however still it is, rather than taken empty and
                 * loaded again -- which asks the site again, after the whole delay. Not a
                 * page that answered with an error: that has nothing coming. A chapter
                 * with pictures wanted may be all pictures, and is not held so. */
                // Gone wholly still -- nothing changing, nothing of its own on the way: given up.
                boolean deadStill = still >= STORY_GIVE_UP_MS && pending == 0;
                boolean noStoryYet = textOnly && !scroll && storyLength < STORY_SOME && mainStatus < 400
                        && now - startedAt < STORY_WAIT_MS && !deadStill;
                boolean holding = !there && (waiting || (!scroll && loading) || noStoryYet);
                boolean busy = pending > 0 || holding;
                /* A chapter is taken once its story is there and has stopped growing --
                 * whatever the adverts and the rest of the page go on doing, and before
                 * the page has "finished": that waited on every advert, and the page's
                 * shape, which every advert loaded changes, kept a chapter that was all
                 * there waiting out the stuck fallback (sixteen seconds for five). */
                if (storyLength != lastStory) {
                    lastStory = storyLength;
                    storySince = now;
                }
                // With nothing more of its own on the way -- or so long still that what is
                // (a feed kept open) is not more of the chapter.
                long storyStill = now - storySince;
                boolean storyDone = !scroll && !waiting && storyThere
                        && storyStill >= (patient ? STORY_STILL_PATIENT_MS : STORY_STILL_MS)
                        && (pending == 0 || storyStill >= quietMs);
                /* Otherwise once it is quiet -- given a spell longer while it has not
                 * "finished", since a page still coming can sit still a moment on a slow
                 * script. Never waiting on "finished" itself: on a site whose adverts
                 * never stop, that came only at the twenty-second fallback, and the
                 * chapter was taken then, mid-change, short. */
                long settle = finished ? need : need + quietMs;
                if (storyDone && confirmBegan == 0) {
                    confirmBegan = now;
                    confirmAt = now;
                    confirmFor = CONFIRM_MS + Math.round((Math.random() * 2 - 1) * CONFIRM_JITTER_MS);
                    confirmStory = storyLength;
                }
                boolean settled;
                if (confirmBegan > 0) {
                    // Confirming: taken once it has stayed as it was the whole time; if
                    // it grew, it was not done -- watched again, as long, from now.
                    if (storyLength != confirmStory) {
                        confirmStory = storyLength;
                        confirmAt = now;
                    }
                    settled = now - confirmAt >= confirmFor;
                    if (settled) dwell = now - confirmBegan;
                } else {
                    settled = (finished || visible) && !blank && !holding
                            && ((!busy && still >= settle) || still >= quietMs * RENDER_STUCK_SPELLS);
                }
                long limit = holding ? RENDER_WAIT_MS : presses > 0 ? PRESS_MAX_MS : maxMs;
                /* A list settled: its "show more" pressed, if it has one, and the list
                 * watched again -- until there is none, presses stop bringing more,
                 * or enough have been pressed. Spaced as the reader's list pages are. */
                if (settled && scroll && pressGap >= 0 && !pressedOut && now - startedAt < limit) {
                    if (now < nextPress) {
                        main.postDelayed(this::poll, RENDER_POLL_MS);
                        return;
                    }
                    // Judged once a press, when the next is due: two in a row that
                    // brought nothing, and the list is as long as it goes.
                    if (linksAtPress >= 0) flat = allLinks > linksAtPress ? 0 : flat + 1;
                    if (flat >= 2 || presses >= PRESS_MAX) {
                        pressedOut = true;
                        take();
                        return;
                    }
                    final int before = allLinks;
                    view.evaluateJavascript(SHOW_MORE, (pressed) -> {
                        if (view == null || done.getCount() == 0) return;
                        if ("\"pressed\"".equals(pressed)) {
                            presses++;
                            linksAtPress = before;
                            long spacing = Math.max(1000, pressGap + Math.round((Math.random() * 2 - 1) * pressJitter));
                            nextPress = System.currentTimeMillis() + spacing;
                            main.postDelayed(this::poll, RENDER_POLL_MS);
                        } else {
                            pressedOut = true;
                            take();
                        }
                    });
                    return;
                }
                if (settled || now - startedAt >= limit) {
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
                if (lastShape.contains("|checking|") && !there) {
                    error = "the site wants its browser check passed (a bot check) — tap Open the site, let the check pass there, then Done";
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

    /** Counts the page's own fetch and XMLHttpRequest calls still on their way, in
     *  window.__grimoirePending. Only the site's own: an advert's or a tracker's call that
     *  never ends (a long poll, a beacon kept open) once said "still loading" for good, so a
     *  chapter with all its text there waited out the stuck fallback instead of being done. */
    private static final String TRACKER = "(function(){if(window.__grimoirePending!==undefined)return;"
            + "window.__grimoirePending=0;"
            + "var site=function(h){var p=String(h||'').toLowerCase().split('.');"
            + "var n=(p.length>2&&p[p.length-1].length==2&&p[p.length-2].length<=3)?3:2;return p.slice(-n).join('.');};"
            + "var own=function(u){try{var h=new URL(String(u&&u.url||u),location.href).hostname;"
            + "return site(h)==site(location.hostname);}catch(e){return true;}};"
            + "var f=window.fetch;if(f){window.fetch=function(r){if(!own(r))return f.apply(this,arguments);"
            + "window.__grimoirePending++;var p;"
            + "try{p=f.apply(this,arguments);}catch(e){window.__grimoirePending--;throw e;}"
            + "var d=function(){window.__grimoirePending--;};p.then(d,d);return p;};}"
            + "var X=window.XMLHttpRequest;if(X&&X.prototype){var o=X.prototype.open,s=X.prototype.send;"
            + "X.prototype.open=function(m,u){this.__grimoireOwn=own(u);return o.apply(this,arguments);};"
            + "X.prototype.send=function(){if(this.__grimoireOwn===false)return s.apply(this,arguments);"
            + "window.__grimoirePending++;var done=false;"
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

    private static final Pattern HEAVY = Pattern.compile(
            "\\.(jpe?g|png|gif|webp|avif|bmp|ico|svg|woff2?|ttf|otf|eot|mp4|webm|m4v|mov|mp3|m4a|ogg|wav)$",
            Pattern.CASE_INSENSITIVE);

    /** A picture, a font or a video: by its address, or by what it asks to be sent. */
    static boolean isHeavy(WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path != null && HEAVY.matcher(path).find()) return true;
        String accept = request.getRequestHeaders() == null ? null : request.getRequestHeaders().get("Accept");
        if (accept == null) return false;
        String a = accept.toLowerCase(Locale.ROOT);
        return a.startsWith("image/") || a.startsWith("video/") || a.startsWith("audio/") || a.startsWith("font/");
    }

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

    /** What a site that has blocked the connection is said to have done. */
    static final String BLOCKED = "the site has blocked this connection (Cloudflare: \u201cSorry, you have been blocked\u201d) "
            + "\u2014 asking again now only makes it last longer; wait some hours, and go slower";

    private static final String SCROLL = "try{if(document.body)window.scrollTo(0,document.body.scrollHeight);}catch(e){}";

    /** How many times a list's "show more" is pressed, at most; and for how long. */
    private static final int PRESS_MAX = 300;
    private static final long PRESS_MAX_MS = 15 * 60000;

    /* A list's "show more" (더보기, 이전 회차 더 보기, 펼치기, Show more, Load more…),
     * pressed: one that is on show and opens out this page -- a button, or a link
     * to nowhere but the page's script -- never a link to another page (those are
     * the list's pages, read on their own). Answers "pressed" or "none". */
    private static final String SHOW_MORE = "(function(){try{"
            + "var MORE=/^\\s*[+▼▽∨⌄]?\\s*((이전|다음)\\s*)?((회차|목록|화|에피소드)\\s*)?(더\\s*보기|펼치기|펼쳐\\s*보기|전체\\s*보기|모두\\s*보기|불러오기|더\\s*불러오기)"
            + "|^\\s*(show|load|view|see|read)\\s+(more|all|older)\\b|^\\s*more(\\s+(chapters|episodes))?\\s*[▼▽+…]*\\s*$|^\\s*older\\s+(chapters|episodes)|^\\s*expand\\b/i;"
            + "var CH=/\\d+\\s*(화|회|장)|chapter\\s*\\d|episode\\s*\\d|第/i,u=location.origin+location.pathname.replace(/\\/+$/,'')+'/';"
            /* In the page's own order: the chapter links met so far counted, so the one
             * pressed is the one that follows the most of them -- the list's own, not a
             * "more" in the menu above it. One with no chapters before it is not pressed. */
            + "var c=document.querySelectorAll('a,button,[role=\"button\"],[onclick],input[type=\"button\"],[class*=\"more\" i],[id*=\"more\" i]'),k=0,best=null,bk=0;"
            + "for(var i=0;i<c.length;i++){var e=c[i];"
            + "if(e.tagName==='A'&&e.href&&((e.href.indexOf(u)===0)||CH.test(e.textContent||''))){k++;}"
            + "if(e.disabled||e.querySelectorAll('a,button').length>2)continue;"
            + "var t=(e.value||e.textContent||'').replace(/\\s+/g,' ').trim();if(!t||t.length>30||!MORE.test(t))continue;"
            + "var a=e.closest('a[href]');if(a){var h=a.getAttribute('href')||'';if(h&&!/^\\s*(#|javascript:)/i.test(h)){"
            + "var v=new URL(a.href,location.href);if(v.origin+v.pathname+v.search!==location.origin+location.pathname+location.search)continue;}}"
            + "var r=e.getBoundingClientRect(),st=getComputedStyle(e);if(!r.width||!r.height||st.visibility==='hidden'||st.display==='none')continue;"
            + "if(k>bk){best=e;bk=k;}}"
            + "if(!best)return 'none';"
            + "try{best.scrollIntoView({block:'center'});}catch(x){}best.click();return 'pressed';"
            + "}catch(e){return 'none';}})()";
    private static final String SHAPE = "(function(){try{var b=document.body;"
            + "var t=document.title||'';"
            + "var r=(window.performance&&performance.getEntriesByType)?performance.getEntriesByType('resource').length:0;"
            /* Looked at often, so worked out again only when the page has changed since (a
             * MutationObserver says so), or a second has passed: otherwise what it was last
             * time. Looking is in the phone, at the page already there: it asks the site
             * for nothing, however often. */
            + "if(window.MutationObserver&&!window.__gObs){try{window.__gObs=new MutationObserver(function(){window.__gDirty=1;});"
            + "window.__gObs.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true});}catch(e){}}"
            + "var now=Date.now(),C=window.__gS;"
            + "if(C&&window.__gObs&&!window.__gDirty&&now-window.__gAt<1000)"
            + "return (window.__grimoirePending||0)+'|'+C[0]+'|'+C[1]+'|'+C[2]+'|'+r+'|'+C[3]+'|'+C[4]+'|'+C[5]+'|'+C[6]+'|'+t;"
            + "window.__gDirty=0;window.__gAt=now;"
            // Links that look like chapters: under this page's address, or
            // named as one ("14화", "Chapter 3", "第三章").
            + "var u=location.origin+location.pathname.replace(/\\/+$/,'')+'/',k=0,L=document.links;"
            + "for(var i=0;i<L.length&&k<9;i++){var h=L[i].href||'',x=L[i].textContent||'';"
            + "if(h.indexOf(u)===0||/\\d+\\s*(화|회|장)|chapter\\s*\\d|第/i.test(x))k++;}"
            // The text a reader would read: the page's scripts and styles are not it.
            + "var n=b?b.textContent.length:0,S=b?b.querySelectorAll('script,style'):[];"
            + "for(var j=0;j<S.length;j++)n-=S[j].textContent.length;"
            /* A bot check at work: a page that is nothing but the check -- its
             * title or Cloudflare's own markup says so, and there is next to
             * nothing else on it. Never by words in the page (a hidden "please
             * wait" made every page of a site look like a check), nor by a
             * check widget tucked into a whole page's sign-in form. */
            + "var sign=/just a moment|checking your browser|잠시만 기다|請稍候|请稍候|attention required/i.test(t)"
            + "||!!window._cf_chl_opt||!!document.querySelector('#challenge-form,#challenge-running,#cf-challenge-running,"
            + ".cf-browser-verification,#cf-please-wait,#turnstile-wrapper');"
            + "var c=sign&&n<1500&&L.length<10;"
            // Blocked outright -- Cloudflare's "Sorry, you have been blocked":
            // not a check, and nothing to wait for.
            + "var blk=n<6000&&/you have been blocked|you are unable to access|access denied|error 1020/i.test(b?b.textContent.slice(0,3000):'');"
            // A loading message or spinner on show -- a site that waits a
            // moment before it puts the chapter up shows one meanwhile.
            // Shown only: a hidden one is a site at rest.
            // Only what says so: a spinner or progress bar, or a short "wait"
            // message -- not a picture's lazy-loading placeholder.
            + "var w=0,B=document.querySelectorAll('[aria-busy=\"true\"],[role=\"progressbar\"],[class*=\"loading\"],[class*=\"spinner\"],[class*=\"loader\"],[id*=\"loading\"],[id*=\"loader\"]');"
            + "for(var q=0;q<B.length&&q<40;q++){var e=B[q];if(e.tagName==='IMG'||e.querySelector('img'))continue;"
            + "var tx=(e.textContent||'').trim(),cl=String(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className);"
            + "var sp=/spinner|progress/i.test(cl+' '+(e.getAttribute('role')||''))||e.getAttribute('aria-busy')==='true';"
            + "var say=tx.length>0&&tx.length<120&&/잠시만|기다려|로딩|불러오는|loading|please wait/i.test(tx);"
            + "if(!sp&&!say)continue;var st=getComputedStyle(e);"
            + "if(st.display!=='none'&&st.visibility!=='hidden'&&st.opacity!=='0'&&e.getClientRects().length){w=1;break;}}"
            /* The story itself: the most text in one block -- its lines, as <p>s or <br>s or
             * <div>s, counted together -- leaving out links, menus and list items. The whole
             * page's text is no measure: on a site whose menus and comment box come to a few
             * thousand characters, the page was "there" before its chapter had arrived. */
            /* And its lines, so a short chapter -- a few hundred characters over many lines --
             * is known as one too. A comment section is no story, however long. */
            + "var s=0,sl=0;try{var M=new Map(),N=new Map(),X=new Map(),W=document.createTreeWalker(b,4),nd,cnt=0,"
            + "IN=/^(P|SPAN|B|I|EM|STRONG|FONT|U|S|SMALL|BIG|SUB|SUP|MARK|RUBY|RT|BR|CENTER)$/,"
            + "NO=/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|A|BUTTON|SELECT|OPTION|LI|NAV|HEADER|FOOTER|ASIDE|TEXTAREA|LABEL)$/,"
            + "CM=/comment|reply|\uB313\uAE00|disqus|cmt/i,"
            + "ex=function(e){if(X.has(e))return X.get(e);var r=false,a=e;"
            + "for(var d=0;a&&a!==b&&d<6;d++,a=a.parentElement){var cn=a.className;"
            + "if(CM.test(String(a.id||'')+' '+String(cn&&cn.baseVal!==undefined?cn.baseVal:cn||''))){r=true;break;}}"
            + "X.set(e,r);return r;},"
            + "add=function(e,l){var v=(M.get(e)||0)+l,c=(N.get(e)||0)+1;M.set(e,v);N.set(e,c);if(v>s){s=v;sl=c;}};"
            + "while((nd=W.nextNode())&&cnt<30000){cnt++;var l=nd.nodeValue.trim().length;if(!l)continue;"
            + "var p=nd.parentElement,no=false;while(p&&p!==b){if(NO.test(p.tagName)){no=true;break;}"
            + "if(!IN.test(p.tagName))break;p=p.parentElement;}if(no||!p||ex(p))continue;"
            + "add(p,l);var g=p.parentElement;if(g&&p!==b&&p.tagName==='DIV')add(g,l);}}catch(e){}"
            + "window.__gS=[n,L.length,(blk?'blocked':c?'checking':''),k,w,s,sl];"
            + "return (window.__grimoirePending||0)+'|'+n+'|'+L.length+'|'+(blk?'blocked':c?'checking':'')+'|'+r+'|'+k+'|'+w+'|'+s+'|'+sl+'|'+t;"
            + "}catch(e){return '0|0|0||0|0|0|0|0|';}})()";

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

    /** Whether the page sent with a refusal is Cloudflare's "you have been blocked". */
    private static boolean blockedPage(HttpURLConnection connection) {
        try (InputStream in = connection.getErrorStream()) {
            if (in == null) return false;
            byte[] head = new byte[8192];
            int got = 0;
            for (int n; got < head.length && (n = in.read(head, got, head.length - got)) > 0; ) got += n;
            String text = new String(head, 0, got, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
            return text.contains("you have been blocked") || text.contains("error 1020")
                    || text.contains("you are unable to access");
        } catch (Exception e) {
            return false;
        }
    }

    /** Why a site said no, in words that say what to do about it. */
    private static String refusal(int status, HttpURLConnection connection) {
        String server = String.valueOf(connection.getHeaderField("Server")).toLowerCase(Locale.ROOT);
        boolean guarded = connection.getHeaderField("cf-mitigated") != null
                || (server.contains("cloudflare") && (status == 403 || status == 503));
        if (guarded) {
            // Blocked outright, or a check: the page it sent says which.
            if (blockedPage(connection)) return BLOCKED;
            return "the site only lets a browser in (it is behind a bot check), so it refused the download";
        }
        if (status == 404) return "that page does not exist (404)";
        if (status == 401 || status == 403) return "the site refused (" + status + ") -- it may need you to be signed in";
        if (status == 429) return tooMany(connection.getHeaderField("Retry-After"));
        return "the site answered " + status;
    }

    /** "Too many requests", with the wait the site asked for when it said one in seconds. */
    static String tooMany(String retryAfter) {
        long seconds = -1;
        try {
            if (retryAfter != null) seconds = Long.parseLong(retryAfter.trim());
        } catch (NumberFormatException ignored) {
            // A date, or nothing usable: the download's own wait stands.
        }
        return "the site turned the request away (429, too many requests"
                + (seconds > 0 ? "; it asks for a wait of " + seconds + " s" : "") + ")";
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
