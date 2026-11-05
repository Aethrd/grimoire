package com.grimoire.ereader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Translation by a large language model: Claude, ChatGPT, Gemini, or any
 * service that speaks OpenAI's chat format (OpenRouter, DeepSeek, a model run
 * on your own computer with Ollama or LM Studio).
 *
 * A model is sent a page's parts together -- the bubbles of a picture, the
 * paragraphs of a chapter -- as a JSON array, and asked for an array of the
 * same length back. It reads them as one text, so names, tone and a sentence
 * running from one bubble into the next come out right; each translation
 * still goes back to its own place.
 *
 * With them, where there are any: the book's glossary (the names and terms it
 * is to render one way every time), the reader's own instructions, how the
 * translation of what came before ended, and the page itself as a picture,
 * for a model that can see.
 *
 * Plain Java, no Android in it: the request and its answer can be tried off
 * the phone.
 */
final class LlmTranslator {

    private LlmTranslator() {}

    static final String ANTHROPIC = "anthropic";
    static final String OPENAI = "openai";
    static final String GEMINI = "gemini";
    /** Anything that answers OpenAI's chat format at an address you give. */
    static final String CUSTOM = "custom";
    /** OpenRouter: one account for DeepSeek, Claude, GPT, Gemini and many
     *  more, signed in to from the app rather than a key copied over
     *  (TranslateBridge.connectOpenRouter). Its chat format is OpenAI's. */
    static final String OPENROUTER = "openrouter";
    static final String OPENROUTER_BASE = "https://openrouter.ai/api/v1";

    /** The fast, inexpensive model of each, until another is named. */
    static String defaultModel(String provider) {
        switch (provider) {
            case ANTHROPIC: return "claude-haiku-5-5";
            case OPENAI: return "gpt-6-luna";
            case GEMINI: return "gemini-3.8-flash";
            // Its own choice of model for each request, until one is picked.
            case OPENROUTER: return "openrouter/auto";
            default: return "";
        }
    }

    static boolean known(String provider) {
        return ANTHROPIC.equals(provider) || OPENAI.equals(provider)
                || GEMINI.equals(provider) || CUSTOM.equals(provider) || OPENROUTER.equals(provider);
    }

    private static final int CONNECT_MS = 20000;
    /** A model takes its time over a long page. */
    private static final int READ_MS = 150000;
    /** Parts sent in one request: enough for a chapter's worth of context,
     *  and an answer that fits in what a model will write at once. */
    private static final int CHUNK_CHARS = 4000;
    private static final int CHUNK_ITEMS = 80;

    /** One provider, as set up. */
    static final class Setup {
        final String provider, key, model, base;

        Setup(String provider, String key, String model, String base) {
            this.provider = provider;
            this.key = key;
            this.model = model == null || model.trim().isEmpty() ? defaultModel(provider) : model.trim();
            this.base = base == null ? "" : base.trim().replaceAll("/+$", "");
        }

        Setup withKey(String other) {
            return new Setup(provider, other, model, base);
        }
    }

    /** A name or term, and how it is to be rendered every time. */
    static final class Term {
        final String source, target, kind, gender, note;

        Term(String source, String target, String kind, String gender, String note) {
            this.source = source == null ? "" : source.trim();
            this.target = target == null ? "" : target.trim();
            this.kind = kind == null ? "" : kind.trim();
            this.gender = gender == null ? "" : gender.trim();
            this.note = note == null ? "" : note.trim();
        }
    }

    /** Everything sent beside the text. All of it optional. */
    static final class Options {
        /** What surrounds the text: not translated, read for sense. */
        String context;
        /** The reader's own instructions, in place of the usual opening. */
        String instructions;
        final List<Term> glossary = new ArrayList<>();
        /** How the translation of what came before ended, to carry on from. */
        String previous;
        /** The page as a picture, base64, for a model that can see. */
        String imageData;
        String imageType = "image/jpeg";
        /** Asked again because parts came back untranslated: say so. */
        boolean insist;

        static Options of(String json) {
            Options options = new Options();
            if (json == null || json.trim().isEmpty()) return options;
            try {
                JSONObject o = new JSONObject(json);
                options.context = o.optString("context", null);
                options.instructions = o.optString("instructions", null);
                options.previous = o.optString("previous", null);
                options.insist = o.optBoolean("insist", false);
                JSONObject image = o.optJSONObject("image");
                if (image != null) {
                    options.imageData = image.optString("data", null);
                    options.imageType = image.optString("type", "image/jpeg");
                }
                JSONArray terms = o.optJSONArray("glossary");
                for (int i = 0; terms != null && i < terms.length(); i++) {
                    JSONObject t = terms.optJSONObject(i);
                    if (t == null) continue;
                    Term term = new Term(t.optString("source"), t.optString("target"), t.optString("kind"),
                            t.optString("gender"), t.optString("note"));
                    if (!term.source.isEmpty() && !term.target.isEmpty()) options.glossary.add(term);
                }
            } catch (JSONException ignored) {
                // Nothing beside the text, then.
            }
            return options;
        }

        static Options context(String context) {
            Options options = new Options();
            options.context = context;
            return options;
        }
    }

    /** A service's answer when it was not a success: the code says what to do next. */
    static final class HttpError extends IOException {
        final int code;
        /** The key is refused or spent: another key may work where this one cannot. */
        final boolean keySpent;

        HttpError(int code, String message, boolean keySpent) {
            super(message);
            this.code = code;
            this.keySpent = keySpent;
        }
    }

    /**
     * Translate the texts, in order. Long batches go in pieces, each told
     * where the last left off.
     */
    static List<String> translate(Setup setup, List<String> texts, String target, String source,
                                  String context) throws IOException, JSONException {
        return translate(setup, texts, target, source, Options.context(context));
    }

    static List<String> translate(Setup setup, List<String> texts, String target, String source,
                                  Options options) throws IOException, JSONException {
        List<String> out = new ArrayList<>();
        int start = 0;
        String before = options.context;
        boolean first = true;
        while (start < texts.size()) {
            int end = start;
            int chars = 0;
            while (end < texts.size() && end - start < CHUNK_ITEMS
                    && (end == start || chars + texts.get(end).length() <= CHUNK_CHARS)) {
                chars += texts.get(end).length();
                end++;
            }
            List<String> part = texts.subList(start, end);
            Options piece = new Options();
            piece.context = before;
            piece.instructions = options.instructions;
            piece.glossary.addAll(options.glossary);
            piece.previous = first ? options.previous : null;
            piece.insist = options.insist;
            // The picture goes with the first piece; a page's bubbles are one piece anyway.
            if (first) {
                piece.imageData = options.imageData;
                piece.imageType = options.imageType;
            }
            out.addAll(ask(setup, part, target, source, piece));
            // The next piece is told how this one ended.
            StringBuilder tail = new StringBuilder();
            for (int i = Math.max(start, end - 6); i < end; i++) tail.append(texts.get(i)).append('\n');
            before = tail.toString();
            start = end;
            first = false;
        }
        return out;
    }

    /** What the answer must be, whatever else the instructions say: the
     *  reader's own instructions cannot take this away, or nothing could be
     *  put back where it came from. */
    static final String OUTPUT_RULES = "Reply with only a JSON array of the translated strings: the same "
            + "number of strings as were sent, in the same order, and nothing else -- no notes, no "
            + "commentary, no markdown.";

    /** The usual opening, with {source} and {target} where the languages go. */
    static final String DEFAULT_INSTRUCTIONS = "You translate for a reading app. The user sends a JSON array of "
            + "strings: consecutive parts of one page of a book or comic -- speech bubbles, captions or "
            + "paragraphs, in reading order. Translate each string from {source} into {target}. Read them "
            + "together for context: keep names, terms and tone consistent, and keep each translation in its "
            + "own place even when a sentence runs on from one part into the next. Translate faithfully and "
            + "naturally, keeping the register as written -- casual speech stays casual, sound effects become "
            + "English-style sound effects.";

    static String instructions(String target, String source) {
        return instructions(target, source, null);
    }

    static String instructions(String target, String source, String custom) {
        String from = source == null || source.isEmpty() ? "the original language" : languageName(source);
        String into = languageName(target);
        String opening = custom == null || custom.trim().isEmpty() ? DEFAULT_INSTRUCTIONS : custom.trim();
        boolean named = opening.contains("{target}") || opening.contains("{source}");
        opening = opening.replace("{target}", into).replace("{source}", from);
        // The reader's own words may not name the languages; then they are said.
        if (!named) opening = opening + "\n\nTranslate from " + from + " into " + into + ".";
        return opening + "\n\n" + OUTPUT_RULES;
    }

    /**
     * The glossary's entries that matter here: those whose name appears in
     * the text or its context. Sending a whole series' glossary with every
     * bubble would cost more than the bubble.
     */
    static List<Term> relevant(List<Term> glossary, List<String> texts, String context) {
        StringBuilder all = new StringBuilder(context == null ? "" : context);
        for (String t : texts) all.append('\n').append(t);
        String haystack = all.toString().toLowerCase(Locale.ROOT);
        List<Term> out = new ArrayList<>();
        for (Term term : glossary) {
            if (haystack.contains(term.source.toLowerCase(Locale.ROOT))) out.add(term);
        }
        return out;
    }

    static String message(List<String> texts, String context) {
        Options options = new Options();
        options.context = context;
        return message(texts, options);
    }

    static String message(List<String> texts, Options options) {
        StringBuilder text = new StringBuilder();
        List<Term> terms = relevant(options.glossary, texts, options.context);
        if (!terms.isEmpty()) {
            text.append("Glossary -- render these names and terms exactly like this, every time they appear:\n");
            for (Term term : terms) {
                text.append("- ").append(term.source).append(" = ").append(term.target);
                List<String> about = new ArrayList<>();
                if (!term.kind.isEmpty()) about.add(term.kind);
                if (!term.gender.isEmpty()) about.add(term.gender);
                if (!term.note.isEmpty()) about.add(term.note);
                if (!about.isEmpty()) text.append(" (").append(String.join("; ", about)).append(')');
                text.append('\n');
            }
            text.append('\n');
        }
        if (options.previous != null && !options.previous.trim().isEmpty()) {
            text.append("How the translation of the text before this ended -- carry on in the same voice, "
                    + "not to be translated again:\n").append(options.previous.trim()).append("\n\n");
        }
        if (options.context != null && !options.context.trim().isEmpty()) {
            text.append("For context only -- what comes before or around these, not to be translated:\n")
                    .append(options.context.trim()).append("\n\n");
        }
        if (options.imageData != null) {
            text.append("The picture is the page these come from: read the faces, the scene and who is "
                    + "speaking for tone. Translate only the strings given.\n\n");
        }
        if (options.insist) {
            text.append("Some of these came back untranslated last time. Translate every string fully into "
                    + "the target language; leave nothing in the original script, except a name in the "
                    + "glossary as given.\n\n");
        }
        text.append("Translate:\n").append(new JSONArray(texts).toString());
        return text.toString();
    }

    private static List<String> ask(Setup setup, List<String> texts, String target, String source,
                                     Options options) throws IOException, JSONException {
        String system = instructions(target, source, options.instructions);
        String user = message(texts, options);
        String reply;
        try {
            reply = request(setup, system, user, options.imageData, options.imageType);
        } catch (HttpError e) {
            // A model that cannot take pictures says so with a 400 or the like:
            // the page is asked again without the picture, rather than lost.
            if (options.imageData == null || e.keySpent || e.code < 400 || e.code >= 500) throw e;
            Options plain = new Options();
            plain.context = options.context;
            plain.instructions = options.instructions;
            plain.glossary.addAll(options.glossary);
            plain.previous = options.previous;
            plain.insist = options.insist;
            reply = request(setup, system, message(texts, plain), null, null);
        }
        return parseArray(reply, texts.size());
    }

    /** A plain question and its answer: for finding a book's names. */
    static String complete(Setup setup, String system, String user) throws IOException, JSONException {
        return request(setup, system, user, null, null);
    }

    private static String request(Setup setup, String system, String user, String imageData, String imageType)
            throws IOException, JSONException {
        switch (setup.provider) {
            case ANTHROPIC: {
                JSONObject body = new JSONObject();
                body.put("model", setup.model);
                body.put("max_tokens", 8192);
                body.put("system", system);
                JSONArray content = new JSONArray();
                if (imageData != null) {
                    content.put(new JSONObject().put("type", "image").put("source", new JSONObject()
                            .put("type", "base64").put("media_type", imageType).put("data", imageData)));
                }
                content.put(new JSONObject().put("type", "text").put("text", user));
                JSONArray messages = new JSONArray();
                messages.put(new JSONObject().put("role", "user").put("content", content));
                body.put("messages", messages);
                String answer = post("https://api.anthropic.com/v1/messages", body.toString(),
                        "x-api-key", setup.key, "anthropic-version", "2026-10-21");
                JSONArray parts = new JSONObject(answer).optJSONArray("content");
                StringBuilder all = new StringBuilder();
                for (int i = 0; parts != null && i < parts.length(); i++) {
                    JSONObject part = parts.getJSONObject(i);
                    if ("text".equals(part.optString("type"))) all.append(part.optString("text"));
                }
                return all.toString();
            }
            case GEMINI: {
                JSONObject body = new JSONObject();
                JSONArray parts = new JSONArray();
                if (imageData != null) {
                    parts.put(new JSONObject().put("inline_data", new JSONObject()
                            .put("mime_type", imageType).put("data", imageData)));
                }
                parts.put(new JSONObject().put("text", system + "\n\n" + user));
                JSONArray contents = new JSONArray();
                contents.put(new JSONObject().put("role", "user").put("parts", parts));
                body.put("contents", contents);
                String url = "https://generativelanguage.googleapis.com/v1beta/models/"
                        + setup.model + ":generateContent";
                String answer = post(url, body.toString(), "x-goog-api-key", setup.key);
                JSONArray candidates = new JSONObject(answer).optJSONArray("candidates");
                StringBuilder all = new StringBuilder();
                if (candidates != null && candidates.length() > 0) {
                    JSONObject content = candidates.getJSONObject(0).optJSONObject("content");
                    JSONArray answerParts = content == null ? null : content.optJSONArray("parts");
                    for (int i = 0; answerParts != null && i < answerParts.length(); i++) {
                        all.append(answerParts.getJSONObject(i).optString("text"));
                    }
                }
                return all.toString();
            }
            default: {
                // OpenAI, and everything that speaks its chat format.
                String base = OPENAI.equals(setup.provider) ? "https://api.openai.com/v1"
                        : OPENROUTER.equals(setup.provider) ? OPENROUTER_BASE : setup.base;
                if (base.isEmpty()) throw new IOException("No address is set for the model's service.");
                JSONObject body = new JSONObject();
                body.put("model", setup.model);
                JSONArray messages = new JSONArray();
                messages.put(new JSONObject().put("role", "system").put("content", system));
                if (imageData != null) {
                    JSONArray content = new JSONArray();
                    content.put(new JSONObject().put("type", "text").put("text", user));
                    content.put(new JSONObject().put("type", "image_url").put("image_url",
                            new JSONObject().put("url", "data:" + imageType + ";base64," + imageData)));
                    messages.put(new JSONObject().put("role", "user").put("content", content));
                } else {
                    messages.put(new JSONObject().put("role", "user").put("content", user));
                }
                body.put("messages", messages);
                String answer;
                if (OPENROUTER.equals(setup.provider)) {
                    // Named, so the reader's OpenRouter activity says which app it was.
                    answer = post(base + "/chat/completions", body.toString(),
                            "Authorization", "Bearer " + setup.key, "X-Title", "Quire");
                } else if (setup.key.isEmpty()) {
                    answer = post(base + "/chat/completions", body.toString());
                } else {
                    answer = post(base + "/chat/completions", body.toString(), "Authorization", "Bearer " + setup.key);
                }
                JSONArray choices = new JSONObject(answer).optJSONArray("choices");
                return choices == null || choices.length() == 0 ? ""
                        : choices.getJSONObject(0).getJSONObject("message").optString("content");
            }
        }
    }

    /** The array out of the model's answer, which may come fenced in
     *  markdown or with a word before it. */
    static List<String> parseArray(String reply, int expected) throws IOException {
        if (reply == null) throw new IOException("The model gave no answer.");
        int open = reply.indexOf('[');
        int close = reply.lastIndexOf(']');
        if (open < 0 || close <= open) throw new IOException("The model's answer was not a list of translations.");
        JSONArray array;
        try {
            array = new JSONArray(reply.substring(open, close + 1));
        } catch (JSONException e) {
            throw new IOException("The model's answer was not a list of translations.");
        }
        if (array.length() != expected) {
            throw new IOException("The model gave " + array.length() + " translations for " + expected + " parts.");
        }
        List<String> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) out.add(array.optString(i, ""));
        return out;
    }

    /** What a language tag is called, for the instructions. */
    static String languageName(String tag) {
        String t = tag == null ? "" : tag.toUpperCase(Locale.ROOT);
        switch (t) {
            case "EN-GB": return "British English";
            case "EN-US": return "American English";
            case "PT-BR": return "Brazilian Portuguese";
            case "PT-PT": return "European Portuguese";
            case "ZH-HANT": return "Traditional Chinese";
            default: break;
        }
        String base = t.split("-")[0];
        switch (base) {
            case "EN": return "English";
            case "JA": return "Japanese";
            case "ZH": return "Simplified Chinese";
            case "KO": return "Korean";
            case "DE": return "German";
            case "FR": return "French";
            case "ES": return "Spanish";
            case "IT": return "Italian";
            case "NL": return "Dutch";
            case "PL": return "Polish";
            case "PT": return "Portuguese";
            case "RU": return "Russian";
            default: return tag;
        }
    }

    /* ── asking again ─────────────────────────────────────────────────────
     *
     * A busy service answers 429 or 503 and is fine a moment later; a phone
     * on a train loses its connection for a second. So a request that fails
     * that way is tried again, after a pause that grows -- or as long as the
     * service asks for, within reason -- and only the third failure is one.
     */

    static final int ATTEMPTS = 3;
    /** Pauses between attempts. Replaceable so a test need not wait. */
    static long[] waits = { 1500, 4000 };

    /** Whether an answer with this code is worth asking again. */
    static boolean retryable(int code) {
        return code == 408 || code == 429 || code == 500 || code == 502 || code == 503 || code == 504 || code == 529;
    }

    /** Whether the key is what is wrong: refused, out of credit, or out of quota. */
    static boolean spends(int code, String body) {
        if (code == 401 || code == 402 || code == 403) return true;
        String said = body == null ? "" : body.toLowerCase(Locale.ROOT);
        if (code == 429 && (said.contains("quota") || said.contains("credit") || said.contains("billing")
                || said.contains("resource_exhausted"))) return true;
        return code == 400 && (said.contains("credit balance") || said.contains("billing"));
    }

    /** One request, made in the way of the HTTP layer below. */
    interface Exchange {
        String run() throws IOException;
    }

    /** The exchange tried up to three times, waiting between. */
    static String withRetries(Exchange exchange) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            try {
                return exchange.run();
            } catch (HttpError e) {
                if (e.keySpent || !retryable(e.code)) throw e;
                last = e;
            } catch (SocketTimeoutException | java.net.ConnectException | java.net.UnknownHostException e) {
                last = e;
            }
            if (attempt + 1 < ATTEMPTS) pause(attempt);
        }
        // Rate-limited three times running: the key is as good as spent for
        // now, and another one, if there is one, is worth a try.
        if (last instanceof HttpError && ((HttpError) last).code == 429) {
            throw new HttpError(429, last.getMessage(), true);
        }
        throw last;
    }

    /** How long the service said to wait, if it said, within reason. */
    static final ThreadLocal<Long> asked = new ThreadLocal<>();

    private static void pause(int attempt) {
        long wait = waits[Math.min(attempt, waits.length - 1)];
        Long said = asked.get();
        if (said != null && said > 0) wait = Math.min(20000, Math.max(wait, said));
        asked.remove();
        try {
            Thread.sleep(wait);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** POST, with headers given as name, value, name, value; tried again when it is worth it. */
    static String post(String address, String body, String... headers) throws IOException {
        return withRetries(() -> postOnce(address, body, headers));
    }

    /** GET, for lists a service publishes: OpenRouter's models. */
    static String get(String address) throws IOException {
        return withRetries(() -> {
            HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
            try {
                connection.setConnectTimeout(CONNECT_MS);
                connection.setReadTimeout(60000);
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300) return read(connection.getInputStream());
                throw new HttpError(code, "The service answered " + code + "." + said(read(connection.getErrorStream())), false);
            } finally {
                connection.disconnect();
            }
        });
    }

    private static String postOnce(String address, String body, String... headers) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_MS);
            connection.setReadTimeout(READ_MS);
            connection.setRequestProperty("Content-Type", "application/json");
            for (int i = 0; i + 1 < headers.length; i += 2) connection.setRequestProperty(headers[i], headers[i + 1]);
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code >= 200 && code < 300) return read(connection.getInputStream());
            String error = read(connection.getErrorStream());
            String said = said(error);
            String retryAfter = connection.getHeaderField("Retry-After");
            if (retryAfter != null) {
                try {
                    asked.set((long) (Double.parseDouble(retryAfter.trim()) * 1000));
                } catch (NumberFormatException ignored) {
                    // A date rather than seconds: the usual wait, then.
                }
            }
            boolean spent = spends(code, error);
            switch (code) {
                case 401:
                case 403: throw new HttpError(code, "The model's service refused the key." + said, true);
                case 402: throw new HttpError(code, "The model's service account is out of credit." + said, true);
                case 404: throw new HttpError(code, "The service has no model by that name." + said, false);
                case 429: throw new HttpError(code, spent
                        ? "The model's service account is out of credit or quota." + said
                        : "The model's service is busy." + said, spent);
                default: throw new HttpError(code, "The model's service answered " + code + "." + said, spent);
            }
        } finally {
            connection.disconnect();
        }
    }

    /** The service's own words for what went wrong, briefly. */
    private static String said(String error) {
        if (error == null || error.isEmpty()) return "";
        String message = error;
        try {
            Object parsed = new JSONObject(error).opt("error");
            if (parsed instanceof JSONObject) message = ((JSONObject) parsed).optString("message", error);
            else if (parsed instanceof String) message = (String) parsed;
        } catch (JSONException ignored) {
            // Not JSON; the text as it is.
        }
        message = message.replaceAll("\\s+", " ").trim();
        if (message.length() > 180) message = message.substring(0, 180) + "…";
        return message.isEmpty() ? "" : " (" + message + ")";
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }
}
