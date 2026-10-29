package com.grimoire.ereader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
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

    /** The fast, inexpensive model of each, until another is named. */
    static String defaultModel(String provider) {
        switch (provider) {
            case ANTHROPIC: return "claude-haiku-5-5";
            case OPENAI: return "gpt-6-luna";
            case GEMINI: return "gemini-3.8-flash";
            default: return "";
        }
    }

    static boolean known(String provider) {
        return ANTHROPIC.equals(provider) || OPENAI.equals(provider)
                || GEMINI.equals(provider) || CUSTOM.equals(provider);
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
    }

    /**
     * Translate the texts, in order. Long batches go in pieces, each told
     * where the last left off.
     */
    static List<String> translate(Setup setup, List<String> texts, String target, String source,
                                  String context) throws IOException, JSONException {
        List<String> out = new ArrayList<>();
        int start = 0;
        String before = context;
        while (start < texts.size()) {
            int end = start;
            int chars = 0;
            while (end < texts.size() && end - start < CHUNK_ITEMS
                    && (end == start || chars + texts.get(end).length() <= CHUNK_CHARS)) {
                chars += texts.get(end).length();
                end++;
            }
            List<String> part = texts.subList(start, end);
            out.addAll(ask(setup, part, target, source, before));
            // The next piece is told how this one ended.
            StringBuilder tail = new StringBuilder();
            for (int i = Math.max(start, end - 6); i < end; i++) tail.append(texts.get(i)).append('\n');
            before = tail.toString();
            start = end;
        }
        return out;
    }

    static String instructions(String target, String source) {
        String from = source == null || source.isEmpty() ? "" : " from " + languageName(source);
        return "You translate for a reading app. The user sends a JSON array of strings: consecutive parts of "
                + "one page of a book or comic -- speech bubbles, captions or paragraphs, in reading order. "
                + "Translate each string" + from + " into " + languageName(target) + ". Read them together "
                + "for context: keep names, terms and tone consistent, and keep each translation in its own "
                + "place even when a sentence runs on from one part into the next. Translate faithfully and "
                + "naturally, keeping the register as written -- casual speech stays casual, sound effects "
                + "become English-style sound effects. Reply with only a JSON array of the translated "
                + "strings: the same number of strings as were sent, in the same order, and nothing else.";
    }

    static String message(List<String> texts, String context) {
        StringBuilder text = new StringBuilder();
        if (context != null && !context.trim().isEmpty()) {
            text.append("For context only -- what comes before or around these, not to be translated:\n")
                    .append(context.trim()).append("\n\n");
        }
        text.append("Translate:\n").append(new JSONArray(texts).toString());
        return text.toString();
    }

    private static List<String> ask(Setup setup, List<String> texts, String target, String source,
                                     String context) throws IOException, JSONException {
        String system = instructions(target, source);
        String user = message(texts, context);
        String reply;
        switch (setup.provider) {
            case ANTHROPIC: {
                JSONObject body = new JSONObject();
                body.put("model", setup.model);
                body.put("max_tokens", 8192);
                body.put("system", system);
                JSONArray messages = new JSONArray();
                messages.put(new JSONObject().put("role", "user").put("content", user));
                body.put("messages", messages);
                String answer = post("https://api.anthropic.com/v1/messages", body.toString(),
                        "x-api-key", setup.key, "anthropic-version", "2026-10-21");
                JSONArray content = new JSONObject(answer).optJSONArray("content");
                StringBuilder all = new StringBuilder();
                for (int i = 0; content != null && i < content.length(); i++) {
                    JSONObject part = content.getJSONObject(i);
                    if ("text".equals(part.optString("type"))) all.append(part.optString("text"));
                }
                reply = all.toString();
                break;
            }
            case GEMINI: {
                JSONObject body = new JSONObject();
                JSONArray contents = new JSONArray();
                contents.put(new JSONObject().put("role", "user").put("parts",
                        new JSONArray().put(new JSONObject().put("text", system + "\n\n" + user))));
                body.put("contents", contents);
                String url = "https://generativelanguage.googleapis.com/v1beta/models/"
                        + setup.model + ":generateContent";
                String answer = post(url, body.toString(), "x-goog-api-key", setup.key);
                JSONArray candidates = new JSONObject(answer).optJSONArray("candidates");
                StringBuilder all = new StringBuilder();
                if (candidates != null && candidates.length() > 0) {
                    JSONArray parts = candidates.getJSONObject(0).optJSONObject("content") == null ? null
                            : candidates.getJSONObject(0).getJSONObject("content").optJSONArray("parts");
                    for (int i = 0; parts != null && i < parts.length(); i++) {
                        all.append(parts.getJSONObject(i).optString("text"));
                    }
                }
                reply = all.toString();
                break;
            }
            default: {
                // OpenAI, and everything that speaks its chat format.
                String base = OPENAI.equals(setup.provider) ? "https://api.openai.com/v1" : setup.base;
                if (base.isEmpty()) throw new IOException("No address is set for the model's service.");
                JSONObject body = new JSONObject();
                body.put("model", setup.model);
                JSONArray messages = new JSONArray();
                messages.put(new JSONObject().put("role", "system").put("content", system));
                messages.put(new JSONObject().put("role", "user").put("content", user));
                body.put("messages", messages);
                String answer = setup.key.isEmpty()
                        ? post(base + "/chat/completions", body.toString())
                        : post(base + "/chat/completions", body.toString(),
                                "Authorization", "Bearer " + setup.key);
                JSONArray choices = new JSONObject(answer).optJSONArray("choices");
                reply = choices == null || choices.length() == 0 ? ""
                        : choices.getJSONObject(0).getJSONObject("message").optString("content");
                break;
            }
        }
        return parseArray(reply, texts.size());
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

    /** POST, with headers given as name, value, name, value. */
    private static String post(String address, String body, String... headers) throws IOException {
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
            String said = said(read(connection.getErrorStream()));
            switch (code) {
                case 401:
                case 403: throw new IOException("The model's service refused the key." + said);
                case 404: throw new IOException("The service has no model by that name." + said);
                case 429: throw new IOException("The model's service is busy, or the account is out of credit." + said);
                default: throw new IOException("The model's service answered " + code + "." + said);
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
