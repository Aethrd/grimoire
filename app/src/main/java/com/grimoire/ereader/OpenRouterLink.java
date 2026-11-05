package com.grimoire.ereader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Signing in to OpenRouter from the app, so a translation model can be used
 * without a key being copied from a website and pasted in.
 *
 * OpenRouter's own way for an app to be given a key (OAuth with PKCE): the
 * browser is sent to openrouter.ai, where the reader signs in -- or makes an
 * account -- and approves; openrouter.ai then sends the browser back to the
 * app with a one-time code, which the app trades, with a secret only it
 * holds, for a key of the reader's own. The key is theirs, billed to their
 * OpenRouter credits (free models cost nothing), and can be deleted at
 * openrouter.ai/keys at any time.
 *
 * "Back to the app" is a tiny web server on the phone itself, listening only
 * on its own loopback address (127.0.0.1 and ::1, never the network) for the
 * one request that carries the code -- OpenRouter's documented way for an
 * app (RFC 8252's for native apps). It stops as soon as that has arrived, or
 * after ten minutes, or when the sign-in is cancelled.
 *
 * Plain Java, no Android in it: tried off the phone against a stand-in.
 */
final class OpenRouterLink {

    static final String AUTH = "https://openrouter.ai/auth";
    static final String KEYS = "https://openrouter.ai/api/v1/auth/keys";
    static final String MODELS = "https://openrouter.ai/api/v1/models";
    static final long WAIT_MS = 10 * 60 * 1000;
    private static final String PATH = "/quire";

    private static final SecureRandom RANDOM = new SecureRandom();

    final String verifier;
    final String challenge;
    final String state;
    final int port;
    private final ServerSocket v4;
    private final ServerSocket v6;
    private volatile boolean cancelled;

    private OpenRouterLink(ServerSocket v4, ServerSocket v6) {
        this.v4 = v4;
        this.v6 = v6;
        this.port = v4.getLocalPort();
        this.verifier = random(48);
        this.challenge = challengeOf(verifier);
        this.state = random(16);
    }

    /** Listening, on a port of its own, for the browser to come back. */
    static OpenRouterLink open() throws IOException {
        ServerSocket v4 = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        ServerSocket v6 = null;
        try {
            // "localhost" may be looked up as ::1 first; listened for there too.
            v6 = new ServerSocket(v4.getLocalPort(), 8, InetAddress.getByName("::1"));
        } catch (IOException ignored) {
            // No IPv6 loopback on this phone: 127.0.0.1 is enough.
        }
        return new OpenRouterLink(v4, v6);
    }

    String callback() {
        return "http://localhost:" + port + PATH;
    }

    /** Where the browser is sent to sign in. */
    String authUrl(String label) {
        return AUTH + "?callback_url=" + encode(callback())
                + "&code_challenge=" + challenge
                + "&code_challenge_method=S256"
                + "&state=" + state
                + "&key_label=" + encode(label);
    }

    void cancel() {
        cancelled = true;
        close();
    }

    void close() {
        try { v4.close(); } catch (IOException ignored) { /* closed */ }
        if (v6 != null) try { v6.close(); } catch (IOException ignored) { /* closed */ }
    }

    /**
     * The code, once the browser comes back with it.
     *
     * @throws IOException when the sign-in was turned down, cancelled, or
     *   not finished in time
     */
    String waitForCode(long timeoutMs) throws IOException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        v4.setSoTimeout(250);
        if (v6 != null) v6.setSoTimeout(250);
        try {
            while (System.currentTimeMillis() < deadline) {
                if (cancelled) throw new IOException("Signing in was cancelled.");
                for (ServerSocket server : new ServerSocket[] { v4, v6 }) {
                    if (server == null) continue;
                    Socket socket;
                    try {
                        socket = server.accept();
                    } catch (SocketTimeoutException e) {
                        continue;
                    } catch (IOException e) {
                        if (cancelled) throw new IOException("Signing in was cancelled.");
                        throw e;
                    }
                    String code = answer(socket);
                    if (code != null) return code;
                }
            }
            throw new IOException("Signing in took too long. Try again, and finish within ten minutes.");
        } finally {
            close();
        }
    }

    /** One request to the little server: the code, or null for anything else. */
    private String answer(Socket socket) throws IOException {
        try (Socket s = socket) {
            s.setSoTimeout(5000);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            String[] parts = line == null ? new String[0] : line.split(" ");
            String target = parts.length >= 2 ? parts[1] : "";
            if (!target.startsWith(PATH)) {
                reply(s, 404, "Not here.");
                return null;
            }
            Map<String, String> query = queryOf(target);
            if (query.containsKey("error") || !query.containsKey("code")) {
                reply(s, 200, "Signing in to OpenRouter was not finished. You can close this page and try again in Quire.");
                throw new IOException("OpenRouter did not give access" + (query.containsKey("error")
                        ? " (" + query.get("error") + ")." : "."));
            }
            // Only this sign-in's own answer: anything else could be a page
            // trying to slip a key of its choosing into the app.
            if (query.containsKey("state") && !state.equals(query.get("state"))) {
                reply(s, 400, "That answer was not for this sign-in.");
                return null;
            }
            reply(s, 200, "Signed in. Go back to Quire — it is finishing the connection.");
            return query.get("code");
        }
    }

    private static void reply(Socket socket, int status, String message) throws IOException {
        String html = "<!doctype html><html><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Quire</title>"
                + "<style>body{font:18px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;background:#141218;color:#eee}"
                + "b{display:block;font-size:22px;margin-bottom:8px}"
                + "a{display:inline-block;margin-top:24px;padding:12px 22px;border-radius:24px;"
                + "background:#d0bcff;color:#21005d;text-decoration:none;font-weight:600}</style></head><body><b>Quire</b>"
                + message.replace("&", "&amp;").replace("<", "&lt;")
                + (status == 404 ? "" : "<br><a href=\"quire://back\">Back to Quire</a>") + "</body></html>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : status == 404 ? " Not Found" : " Bad Request")
                + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        OutputStream out = socket.getOutputStream();
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    static Map<String, String> queryOf(String target) {
        Map<String, String> out = new HashMap<>();
        int at = target.indexOf('?');
        if (at < 0) return out;
        for (String pair : target.substring(at + 1).split("&")) {
            int eq = pair.indexOf('=');
            try {
                String key = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), "UTF-8");
                String value = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                out.put(key, value);
            } catch (IllegalArgumentException | java.io.UnsupportedEncodingException ignored) {
                // A broken pair is no pair.
            }
        }
        return out;
    }

    /** The code traded for the reader's own key. */
    static String exchange(String keysUrl, String code, String verifier) throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("code", code);
        body.put("code_verifier", verifier);
        body.put("code_challenge_method", "S256");
        String key = new JSONObject(LlmTranslator.post(keysUrl, body.toString())).optString("key", "");
        if (key.isEmpty()) throw new IOException("OpenRouter gave no key.");
        return key;
    }

    /* ── models ─────────────────────────────────────────────────────────── */

    /**
     * OpenRouter's models, as the app lists them: id, name, whether free,
     * whether it takes pictures, how much text it reads at once.
     */
    static JSONArray models(String listJson) throws JSONException {
        JSONArray data = new JSONObject(listJson).optJSONArray("data");
        JSONArray out = new JSONArray();
        for (int i = 0; data != null && i < data.length(); i++) {
            JSONObject model = data.optJSONObject(i);
            if (model == null || model.optString("id").isEmpty()) continue;
            JSONObject pricing = model.optJSONObject("pricing");
            boolean free = model.optString("id").endsWith(":free") || (pricing != null
                    && isZero(pricing.optString("prompt", "1")) && isZero(pricing.optString("completion", "1")));
            JSONObject architecture = model.optJSONObject("architecture");
            JSONArray inputs = architecture == null ? null : architecture.optJSONArray("input_modalities");
            boolean vision = inputs != null && inputs.toString().contains("\"image\"");
            out.put(new JSONObject()
                    .put("id", model.optString("id"))
                    .put("name", model.optString("name", model.optString("id")))
                    .put("free", free)
                    .put("vision", vision)
                    .put("context", model.optLong("context_length", 0)));
        }
        return out;
    }

    private static boolean isZero(String price) {
        try {
            return Double.parseDouble(price) == 0;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** A model to start with: a free DeepSeek if there is one, else OpenRouter's own pick. */
    static String startingModel(JSONArray models) {
        for (int i = 0; i < models.length(); i++) {
            JSONObject model = models.optJSONObject(i);
            if (model == null || !model.optBoolean("free")) continue;
            String id = model.optString("id");
            if (id.toLowerCase(Locale.ROOT).startsWith("deepseek/")) return id;
        }
        return LlmTranslator.defaultModel(LlmTranslator.OPENROUTER);
    }

    /* ── PKCE ───────────────────────────────────────────────────────────── */

    static String random(int bytes) {
        byte[] out = new byte[bytes];
        RANDOM.nextBytes(out);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(out);
    }

    static String challengeOf(String verifier) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String encode(String text) {
        try {
            return URLEncoder.encode(text, "UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
