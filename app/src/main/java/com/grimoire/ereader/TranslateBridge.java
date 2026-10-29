package com.grimoire.ereader;

import android.app.Activity;
import android.content.SharedPreferences;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.languageid.LanguageIdentification;
import com.google.mlkit.nl.languageid.LanguageIdentifier;
import com.google.mlkit.nl.translate.TranslatorOptions;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Translation, through one of three engines.
 *
 *   ondevice  ML Kit. No key, no account, no sign-up, and no network at all
 *             once the language model is on the device. Models are ~30MB and
 *             fetched on demand, so none ship in the APK. This is the default,
 *             because "does it need an API key" should be answered with no.
 *   deepl     Best quality by a distance, but needs a key and sends your text
 *             to DeepL. Free tier is 500,000 characters a month.
 *   libre     LibreTranslate. Free software you can self-host, so the text
 *             goes to a server you chose -- possibly your own. A key is
 *             optional and depends on the instance.
 *   llm       A large language model -- Claude, ChatGPT, Gemini, or anything
 *             that speaks OpenAI's chat format -- with your own key, billed
 *             by its provider. Reads a page's parts together.
 *
 * All of it lives natively rather than in the reader. ML Kit is an Android
 * library and unreachable from a page; DeepL sends no CORS headers and says
 * plainly that it does not permit client-side calls, because a key in a page
 * is a key anyone can read out of it.
 *
 * Keys are held in app-private storage, never cross the bridge and never
 * appear in the DOM. JavaScript can set one, clear one, and ask whether one is
 * present; it cannot read it back.
 */
public class TranslateBridge {

    private static final String TAG = "GrimoireTranslate";
    private static final String PREFS = "grimoire_translate";
    private static final String KEY_AUTH = "deepl_key";
    private static final String KEY_ENGINE = "engine";
    private static final String KEY_LIBRE_URL = "libre_url";
    private static final String KEY_LIBRE_AUTH = "libre_key";

    static final String ENGINE_ONDEVICE = "ondevice";
    static final String ENGINE_DEEPL = "deepl";
    static final String ENGINE_LIBRE = "libre";
    /** A large language model -- Claude, ChatGPT, Gemini, or another --
     *  with the reader's own key (LlmTranslator). */
    static final String ENGINE_LLM = "llm";
    private static final String KEY_LLM_PROVIDER = "llm_provider";
    private static final String KEY_LLM_BASE = "llm_base";

    /** Free keys carry this suffix and must use a different host. */
    private static final String FREE_SUFFIX = ":fx";
    private static final String HOST_FREE = "https://api-free.deepl.com";
    private static final String HOST_PRO = "https://api.deepl.com";

    private static final int TIMEOUT_MS = 20000;
    /** DeepL caps a request body; well under it, and enough for a chapter. */
    private static final int MAX_CHARS = 100_000;

    private final MainActivity activity;
    private final WebView webView;
    private final SharedPreferences prefs;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    TranslateBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    /* ── key management ───────────────────────────────────────────────── */

    /** Whether a key is set, and which plan it is. Never the key itself. */
    @JavascriptInterface
    public String status() {
        JSONObject out = new JSONObject();
        try {
            String engine = engine();
            String key = prefs.getString(KEY_AUTH, null);
            String libreUrl = prefs.getString(KEY_LIBRE_URL, null);

            out.put("engine", engine);
            out.put("deeplConfigured", key != null && !key.isEmpty());
            out.put("plan", key == null ? null : (key.endsWith(FREE_SUFFIX) ? "free" : "pro"));
            // Enough to recognise which key is in use without exposing it.
            out.put("hint", key == null || key.length() < 8 ? null
                    : key.substring(0, 4) + "\u2026" + key.substring(key.length() - 3));
            out.put("libreUrl", libreUrl);

            String provider = prefs.getString(KEY_LLM_PROVIDER, LlmTranslator.ANTHROPIC);
            String llmKey = prefs.getString("llm_key_" + provider, null);
            String llmBase = prefs.getString(KEY_LLM_BASE, "");
            boolean llmReady = LlmTranslator.CUSTOM.equals(provider)
                    ? !llmBase.isEmpty() && prefs.getBoolean("llm_ready_custom", false)
                    : llmKey != null && !llmKey.isEmpty();
            out.put("llmProvider", provider);
            out.put("llmModel", prefs.getString("llm_model_" + provider, LlmTranslator.defaultModel(provider)));
            out.put("llmBase", llmBase);
            out.put("llmConfigured", llmReady);
            out.put("llmHint", llmKey == null || llmKey.length() < 10 ? null
                    : llmKey.substring(0, 6) + "\u2026" + llmKey.substring(llmKey.length() - 3));

            // On-device needs nothing configured, which is the point of it.
            out.put("configured", ENGINE_ONDEVICE.equals(engine)
                    || (ENGINE_DEEPL.equals(engine) && key != null && !key.isEmpty())
                    || (ENGINE_LIBRE.equals(engine) && libreUrl != null && !libreUrl.isEmpty())
                    || (ENGINE_LLM.equals(engine) && llmReady));
            out.put("offline", ENGINE_ONDEVICE.equals(engine));
        } catch (JSONException ignored) {
        }
        return out.toString();
    }

    private String engine() {
        return prefs.getString(KEY_ENGINE, ENGINE_ONDEVICE);
    }

    @JavascriptInterface
    public void setEngine(final String requestId, final String engine) {
        if (!ENGINE_ONDEVICE.equals(engine) && !ENGINE_DEEPL.equals(engine) && !ENGINE_LIBRE.equals(engine)
                && !ENGINE_LLM.equals(engine)) {
            fail(requestId, "Unknown translation engine");
            return;
        }
        prefs.edit().putString(KEY_ENGINE, engine).apply();
        succeed(requestId, status());
    }

    @JavascriptInterface
    public void setLibre(final String requestId, final String url, final String key) {
        String clean = url == null ? "" : url.trim().replaceAll("/+$", "");
        if (clean.isEmpty()) { fail(requestId, "No server address given"); return; }
        if (!clean.startsWith("https://") && !clean.startsWith("http://")) {
            fail(requestId, "The address needs to start with https:// or http://");
            return;
        }
        prefs.edit()
                .putString(KEY_LIBRE_URL, clean)
                .putString(KEY_LIBRE_AUTH, key == null ? "" : key.trim())
                .apply();
        succeed(requestId, status());
    }

    @JavascriptInterface
    public void setKey(final String requestId, final String key) {
        final String trimmed = key == null ? "" : key.trim();
        if (trimmed.isEmpty()) {
            fail(requestId, "No key given");
            return;
        }
        io.execute(() -> {
            try {
                // Verify before storing, so a typo is caught here rather than
                // silently failing on the first chapter someone translates.
                fetchUsage(trimmed);
                prefs.edit().putString(KEY_AUTH, trimmed).apply();
                succeed(requestId, status());
            } catch (Exception e) {
                fail(requestId, describe(e));
            }
        });
    }

    /**
     * Set up a language model: which service, the key, the model, and for
     * another service its address. Tried with a word of translation before
     * it is kept, so a wrong key or model name is caught here; then it
     * becomes the translator.
     */
    @JavascriptInterface
    public void setLlm(final String requestId, final String provider, final String key,
                       final String model, final String base) {
        if (!LlmTranslator.known(provider)) { fail(requestId, "Unknown model service"); return; }
        // No key given: the one already kept for that service, so that only
        // the model can be changed.
        String given = key == null ? "" : key.trim();
        if (given.isEmpty()) given = prefs.getString("llm_key_" + provider, "");
        final String cleanKey = given;
        final String cleanBase = base == null ? "" : base.trim().replaceAll("/+$", "");
        if (!LlmTranslator.CUSTOM.equals(provider) && cleanKey.isEmpty()) { fail(requestId, "No key given"); return; }
        if (LlmTranslator.CUSTOM.equals(provider)
                && !cleanBase.startsWith("https://") && !cleanBase.startsWith("http://")) {
            fail(requestId, "The address must start with https:// (or http:// for one on your own network)");
            return;
        }
        io.execute(() -> {
            try {
                LlmTranslator.Setup setup = new LlmTranslator.Setup(provider, cleanKey, model, cleanBase);
                if (setup.model.isEmpty()) { fail(requestId, "Name the model to use"); return; }
                List<String> probe = LlmTranslator.translate(setup,
                        java.util.Collections.singletonList("こんにちは"), "EN-GB", "ja", null);
                if (probe.isEmpty()) throw new IOException("The model gave no answer.");
                SharedPreferences.Editor edit = prefs.edit()
                        .putString(KEY_LLM_PROVIDER, provider)
                        .putString("llm_model_" + provider, setup.model)
                        .putString(KEY_ENGINE, ENGINE_LLM);
                if (!cleanKey.isEmpty()) edit.putString("llm_key_" + provider, cleanKey);
                else edit.remove("llm_key_" + provider);
                if (LlmTranslator.CUSTOM.equals(provider)) {
                    edit.putString(KEY_LLM_BASE, cleanBase).putBoolean("llm_ready_custom", true);
                }
                edit.apply();
                succeed(requestId, status());
            } catch (Exception e) {
                fail(requestId, describe(e));
            }
        });
    }

    /** Forget a model service's key. */
    @JavascriptInterface
    public void clearLlm(final String requestId, final String provider) {
        SharedPreferences.Editor edit = prefs.edit().remove("llm_key_" + provider);
        if (LlmTranslator.CUSTOM.equals(provider)) edit.remove("llm_ready_custom");
        if (ENGINE_LLM.equals(engine())) edit.putString(KEY_ENGINE, ENGINE_ONDEVICE);
        edit.apply();
        succeed(requestId, status());
    }

    @JavascriptInterface
    public void clearKey(final String requestId) {
        prefs.edit().remove(KEY_AUTH).apply();
        succeed(requestId, status());
    }

    /** Characters used this billing period, so the free 500k is visible. */
    @JavascriptInterface
    public void usage(final String requestId) {
        io.execute(() -> {
            String key = prefs.getString(KEY_AUTH, null);
            if (key == null) { fail(requestId, "No DeepL key is set"); return; }
            try {
                succeed(requestId, fetchUsage(key));
            } catch (Exception e) {
                fail(requestId, describe(e));
            }
        });
    }

    /* ── translation ──────────────────────────────────────────────────── */

    /**
     * Translate a batch. Input and output are JSON arrays of strings in the
     * same order, because DeepL returns them that way and callers rely on it
     * to match a translated chapter title back to its chapter.
     */
    @JavascriptInterface
    public void translate(final String requestId, final String textsJson,
                          final String targetLang, final String sourceLang) {
        translateWithContext(requestId, textsJson, targetLang, sourceLang, null);
    }

    /**
     * As translate, with text that surrounds the batch -- the other bubbles
     * on a page -- for DeepL to read for names and tone. It is not
     * translated and not charged. The other engines take no context and
     * translate as before.
     */
    @JavascriptInterface
    public void translateWithContext(final String requestId, final String textsJson,
                                     final String targetLang, final String sourceLang,
                                     final String context) {
        run(requestId, textsJson, targetLang, sourceLang, context, null);
    }

    /**
     * A page translated whole, its parts marked with XML tags that DeepL
     * keeps where they belong in the translation: every sentence is then
     * translated knowing the others, and the parts can still be put back
     * where they came from. The other engines do not read tags; they are
     * asked as translateWithContext would ask them.
     */
    @JavascriptInterface
    public void translateTagged(final String requestId, final String textsJson,
                                final String targetLang, final String sourceLang) {
        run(requestId, textsJson, targetLang, sourceLang, null, "xml");
    }

    private void run(final String requestId, final String textsJson,
                     final String targetLang, final String sourceLang,
                     final String context, final String tagHandling) {
        io.execute(() -> {
            try {
                JSONArray texts = new JSONArray(textsJson);
                int chars = 0;
                for (int i = 0; i < texts.length(); i++) chars += texts.getString(i).length();
                if (chars > MAX_CHARS) {
                    fail(requestId, "That is too much text for one request. Translate a chapter at a time.");
                    return;
                }

                switch (engine()) {
                    case ENGINE_DEEPL: translateWithDeepL(requestId, texts, targetLang, sourceLang, chars, context, tagHandling); break;
                    case ENGINE_LIBRE: translateWithLibre(requestId, texts, targetLang, sourceLang, chars); break;
                    case ENGINE_LLM: translateWithLlm(requestId, texts, targetLang, sourceLang, context, chars); break;
                    default: translateOnDevice(requestId, texts, targetLang, sourceLang, chars); break;
                }
            } catch (Exception e) {
                fail(requestId, describe(e));
            }
        });
    }

    /* ── on-device (ML Kit) ───────────────────────────────────────────── */

    /**
     * ML Kit needs to be told both languages; it does not sniff. The source
     * comes from the book's own declared language, which EPUBs carry, so in
     * practice the reader never has to ask. Where a book declares nothing the
     * caller passes what the user chose.
     */
    private void translateOnDevice(String requestId, JSONArray texts,
                                   String targetLang, String sourceLang, int chars) {
        String target = TranslateLanguage.fromLanguageTag(base(targetLang));
        if (target == null) {
            fail(requestId, "On-device translation does not cover that language. Try DeepL for it.");
            return;
        }

        String declared = sourceLang == null || sourceLang.isEmpty()
                ? null : TranslateLanguage.fromLanguageTag(base(sourceLang));

        if (declared != null) {
            startTranslation(requestId, texts, declared, target, chars);
            return;
        }

        /*
         * Nothing declared, so work it out from the text.
         *
         * Switching translation on means wanting whatever is foreign
         * translated, not answering a question about which language a
         * scraped EPUB happens to be in. The identification model is bundled
         * and needs no download, so this costs nothing but a moment.
         */
        StringBuilder sample = new StringBuilder();
        for (int i = 0; i < texts.length() && sample.length() < 400; i++) {
            try {
                sample.append(texts.getString(i)).append(' ');
            } catch (JSONException ignored) {
            }
        }

        final LanguageIdentifier identifier = LanguageIdentification.getClient();
        identifier.identifyLanguage(sample.toString())
                .addOnSuccessListener(code -> {
                    identifier.close();
                    if (code == null || "und".equals(code)) {
                        fail(requestId, "Could not tell what language that is. "
                                + "Set the language in the book\u2019s details.");
                        return;
                    }
                    String detected = TranslateLanguage.fromLanguageTag(base(code));
                    if (detected == null) {
                        fail(requestId, "On-device translation does not cover " + code + ".");
                        return;
                    }
                    startTranslation(requestId, texts, detected, target, chars);
                })
                .addOnFailureListener(e -> {
                    identifier.close();
                    fail(requestId, describe(e));
                });
    }

    /** Both languages known: fetch the models if needed, then translate. */
    private void startTranslation(String requestId, JSONArray texts,
                                  String source, String target, int chars) {
        if (source.equals(target)) {
            // Already in the target language. Nothing to do, and asking ML Kit
            // for a same-language translator is an error.
            echo(requestId, texts, chars);
            return;
        }

        final Translator translator = Translation.getClient(new TranslatorOptions.Builder()
                .setSourceLanguage(source)
                .setTargetLanguage(target)
                .build());

        // Wi-Fi only by default: a model is around 30MB, and quietly spending
        // that on someone's mobile data is not on.
        DownloadConditions conditions = new DownloadConditions.Builder().requireWifi().build();

        translator.downloadModelIfNeeded(conditions)
                .addOnSuccessListener(ignored -> translateAll(requestId, translator, texts, chars))
                .addOnFailureListener(e -> {
                    translator.close();
                    fail(requestId, "Could not fetch the " + source + " language pack. "
                            + "It needs Wi-Fi the first time, then works offline. ("
                            + describe(e) + ")");
                });
    }

    /** Sequential rather than parallel: ML Kit is on-device and the ordering
     *  of results is what the caller matches translations back with. */
    private void translateAll(String requestId, Translator translator, JSONArray texts, int chars) {
        final JSONArray out = new JSONArray();
        translateNext(requestId, translator, texts, out, 0, chars);
    }

    private void translateNext(String requestId, Translator translator, JSONArray texts,
                               JSONArray out, int index, int chars) {
        if (index >= texts.length()) {
            translator.close();
            try {
                JSONObject result = new JSONObject();
                result.put("texts", out);
                result.put("detected", new JSONArray());
                result.put("characters", chars);
                result.put("engine", ENGINE_ONDEVICE);
                succeed(requestId, result.toString());
            } catch (JSONException e) {
                fail(requestId, "Could not assemble the translation");
            }
            return;
        }
        try {
            translator.translate(texts.getString(index))
                    .addOnSuccessListener(value -> {
                        out.put(value);
                        translateNext(requestId, translator, texts, out, index + 1, chars);
                    })
                    .addOnFailureListener(e -> {
                        translator.close();
                        fail(requestId, describe(e));
                    });
        } catch (JSONException e) {
            translator.close();
            fail(requestId, "Could not read the text to translate");
        }
    }

    /** Which language models are already on the device. */
    @JavascriptInterface
    public void models(final String requestId) {
        RemoteModelManager.getInstance()
                .getDownloadedModels(TranslateRemoteModel.class)
                .addOnSuccessListener(models -> {
                    JSONArray out = new JSONArray();
                    for (TranslateRemoteModel model : models) out.put(model.getLanguage());
                    succeed(requestId, out.toString());
                })
                .addOnFailureListener(e -> fail(requestId, describe(e)));
    }

    /**
     * Fetch one language model, explicitly.
     *
     * Models are per language, not per pair and not all at once: reading
     * Korean books in English needs the Korean model and the English one, and
     * nothing else. Around 30MB each, once, and then it is offline forever.
     * The reader works out which languages your library actually contains and
     * offers only those.
     */
    @JavascriptInterface
    public void downloadModel(final String requestId, final String languageTag) {
        String code = TranslateLanguage.fromLanguageTag(base(languageTag));
        if (code == null) { fail(requestId, "On-device translation does not cover that language"); return; }
        DownloadConditions conditions = new DownloadConditions.Builder().requireWifi().build();
        RemoteModelManager.getInstance()
                .download(new TranslateRemoteModel.Builder(code).build(), conditions)
                .addOnSuccessListener(ignored -> succeed(requestId, "{\"downloaded\":true}"))
                .addOnFailureListener(e -> fail(requestId,
                        "Could not fetch that language pack. It needs Wi-Fi. (" + describe(e) + ")"));
    }

    /** Whether on-device translation covers a language at all. */
    @JavascriptInterface
    public boolean supports(String languageTag) {
        return TranslateLanguage.fromLanguageTag(base(languageTag)) != null;
    }

    /** Free the space a model takes, once it is no longer wanted. */
    @JavascriptInterface
    public void deleteModel(final String requestId, final String languageTag) {
        String code = TranslateLanguage.fromLanguageTag(base(languageTag));
        if (code == null) { fail(requestId, "Unknown language"); return; }
        RemoteModelManager.getInstance()
                .deleteDownloadedModel(new TranslateRemoteModel.Builder(code).build())
                .addOnSuccessListener(ignored -> succeed(requestId, "{\"deleted\":true}"))
                .addOnFailureListener(e -> fail(requestId, describe(e)));
    }

    /** ML Kit wants a bare language code, not a regional tag like EN-GB. */
    private static String base(String tag) {
        if (tag == null) return null;
        int dash = tag.indexOf('-');
        return (dash == -1 ? tag : tag.substring(0, dash)).toLowerCase();
    }

    private void echo(String requestId, JSONArray texts, int chars) {
        try {
            JSONObject result = new JSONObject();
            result.put("texts", texts);
            result.put("detected", new JSONArray());
            result.put("characters", chars);
            succeed(requestId, result.toString());
        } catch (JSONException e) {
            fail(requestId, "Could not assemble the translation");
        }
    }

    /* ── DeepL ────────────────────────────────────────────────────────── */

    /** The source languages DeepL accepts by name: anything else is left
     *  for it to recognise. */
    private static final java.util.Set<String> DEEPL_SOURCES = new java.util.HashSet<>(java.util.Arrays.asList(
            "AR", "BG", "CS", "DA", "DE", "EL", "EN", "ES", "ET", "FI", "FR", "HU", "ID", "IT", "JA", "KO",
            "LT", "LV", "NB", "NL", "PL", "PT", "RO", "RU", "SK", "SL", "SV", "TR", "UK", "ZH"));

    private void translateWithDeepL(String requestId, JSONArray texts, String targetLang, String sourceLang,
                                    int chars, String context, String tagHandling) throws Exception {
        String key = prefs.getString(KEY_AUTH, null);
        if (key == null) {
            fail(requestId, "No DeepL key is set. Add one, or switch to on-device translation.");
            return;
        }

        JSONObject body = new JSONObject();
        body.put("text", texts);
        body.put("target_lang", targetLang.toUpperCase());
        // Keeps paragraph structure rather than reflowing it, which matters
        // when the result is put back into a chapter.
        body.put("preserve_formatting", true);
        if (context != null && !context.trim().isEmpty()) body.put("context", context);
        if (tagHandling != null) body.put("tag_handling", tagHandling);
        // The model DeepL's own website translates with. Left unasked, the
        // API answers with the one made for speed, which is the difference
        // between pasting a page into deepl.com and having it translated here.
        body.put("model_type", "quality_optimized");
        // The language, where it is known: a short bubble, misread a little,
        // is easily taken for another.
        String from = sourceLang == null ? "" : base(sourceLang).toUpperCase(java.util.Locale.ROOT);
        if (DEEPL_SOURCES.contains(from)) body.put("source_lang", from);

        String response = post(key, "/v2/translate", body.toString());
        JSONArray translations = new JSONObject(response).getJSONArray("translations");

        JSONArray out = new JSONArray();
        JSONArray detected = new JSONArray();
        for (int i = 0; i < translations.length(); i++) {
            JSONObject t = translations.getJSONObject(i);
            out.put(t.getString("text"));
            detected.put(t.optString("detected_source_language", ""));
        }

        JSONObject result = new JSONObject();
        result.put("texts", out);
        result.put("detected", detected);
        result.put("characters", chars);
        result.put("engine", ENGINE_DEEPL);
        succeed(requestId, result.toString());
    }

    /* ── a language model ─────────────────────────────────────────────── */

    private void translateWithLlm(String requestId, JSONArray texts, String targetLang, String sourceLang,
                                  String context, int chars) throws Exception {
        String provider = prefs.getString(KEY_LLM_PROVIDER, LlmTranslator.ANTHROPIC);
        String key = prefs.getString("llm_key_" + provider, "");
        LlmTranslator.Setup setup = new LlmTranslator.Setup(provider, key,
                prefs.getString("llm_model_" + provider, ""), prefs.getString(KEY_LLM_BASE, ""));
        if (!LlmTranslator.CUSTOM.equals(provider) && key.isEmpty()) {
            fail(requestId, "No key is set for the model. Add one in Settings → Translation.");
            return;
        }
        List<String> in = new ArrayList<>();
        for (int i = 0; i < texts.length(); i++) in.add(texts.getString(i));
        List<String> translated = LlmTranslator.translate(setup, in, targetLang, sourceLang, context);
        JSONArray out = new JSONArray();
        for (String t : translated) out.put(t);
        JSONObject result = new JSONObject();
        result.put("texts", out);
        result.put("characters", chars);
        result.put("engine", ENGINE_LLM);
        succeed(requestId, result.toString());
    }

    /* ── LibreTranslate ───────────────────────────────────────────────── */

    private void translateWithLibre(String requestId, JSONArray texts, String targetLang,
                                    String sourceLang, int chars) throws Exception {
        String url = prefs.getString(KEY_LIBRE_URL, null);
        if (url == null || url.isEmpty()) {
            fail(requestId, "No LibreTranslate server is set.");
            return;
        }
        String key = prefs.getString(KEY_LIBRE_AUTH, "");

        JSONObject body = new JSONObject();
        // LibreTranslate accepts an array and returns one in the same order.
        body.put("q", texts);
        body.put("source", sourceLang == null || sourceLang.isEmpty() ? "auto" : base(sourceLang));
        body.put("target", base(targetLang));
        body.put("format", "text");
        if (!key.isEmpty()) body.put("api_key", key);

        HttpURLConnection connection = (HttpURLConnection) new URL(url + "/translate").openConnection();
        String response;
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("That server returned HTTP " + code
                        + (code == 403 ? ". It may require an API key." : ""));
            }
            response = read(connection.getInputStream());
        } finally {
            connection.disconnect();
        }

        JSONObject parsed = new JSONObject(response);
        JSONArray out = new JSONArray();
        Object translated = parsed.get("translatedText");
        if (translated instanceof JSONArray) {
            JSONArray list = (JSONArray) translated;
            for (int i = 0; i < list.length(); i++) out.put(list.getString(i));
        } else {
            out.put(String.valueOf(translated));
        }

        JSONObject result = new JSONObject();
        result.put("texts", out);
        result.put("detected", new JSONArray());
        result.put("characters", chars);
        result.put("engine", ENGINE_LIBRE);
        succeed(requestId, result.toString());
    }

    /* ── HTTP ─────────────────────────────────────────────────────────── */

    /** Asked with GET, as DeepL documents it: an empty POST is a request
     *  it may refuse, and then a good key reads as a bad one. */
    private String fetchUsage(String key) throws IOException, JSONException {
        return post(key, "/v2/usage", null);
    }

    /** The host depends on the plan, and the key itself says which. */
    private static String hostFor(String key) {
        return key.endsWith(FREE_SUFFIX) ? HOST_FREE : HOST_PRO;
    }

    private String post(String key, String path, String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(hostFor(key) + path).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestProperty("Authorization", "DeepL-Auth-Key " + key);
            if (body != null) connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("User-Agent", "Grimoire/" + BuildConfig.VERSION_NAME);

            if (body != null) {
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            } else {
                // Nothing to send: a plain GET.
                connection.setRequestMethod("GET");
            }

            int code = connection.getResponseCode();
            if (code >= 200 && code < 300) return read(connection.getInputStream());

            // DeepL's errors are specific and worth passing through in plain
            // words rather than as a status number.
            switch (code) {
                case 401:
                case 403: throw new IOException("DeepL rejected that key. Copy it again from Account → API Keys & Limits: "
                        + "a DeepL API key, not a password, and a free one ends in :fx.");
                case 429: throw new IOException("Too many requests. Wait a moment and try again.");
                case 456: throw new IOException("This key has used its character quota for the period.");
                case 400: throw new IOException("DeepL could not read that request: " + read(connection.getErrorStream()));
                default: throw new IOException("DeepL returned HTTP " + code);
            }
        } finally {
            connection.disconnect();
        }
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

    /* ── plumbing ─────────────────────────────────────────────────────── */

    private void succeed(String requestId, String payloadJson) {
        settle(requestId, true, payloadJson);
    }

    private void fail(String requestId, String message) {
        settle(requestId, false, JSONObject.quote(message));
    }

    private void settle(String requestId, boolean ok, String payloadJson) {
        // Quoted, so the payload crosses as text and is parsed once on the
        // other side. Injected raw it became a JavaScript object literal, and
        // the reader -- which expected text -- parsed it into nothing.
        // Quoting also sidesteps U+2028 and U+2029, which are legal in JSON
        // strings and were line terminators in JavaScript.
        final String js = "window.Grimoire && window.Grimoire.settle("
                + JSONObject.quote(requestId) + "," + ok + ","
                + JSONObject.quote(payloadJson) + ")";
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    private static String describe(Exception e) {
        String message = e.getMessage();
        if (message == null) return e.getClass().getSimpleName();
        // A key must never reach a log line or a toast.
        return message.replaceAll("[0-9a-f\\-]{8,}(:fx)?", "[key]");
    }
}
