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
            List<String> deeplKeys = keysIn(key);
            String first = deeplKeys.isEmpty() ? null : deeplKeys.get(0);
            out.put("deeplConfigured", first != null);
            out.put("deeplKeys", deeplKeys.size());
            out.put("plan", first == null ? null : (first.endsWith(FREE_SUFFIX) ? "free" : "pro"));
            // Enough to recognise which key is in use without exposing it.
            out.put("hint", first == null || first.length() < 8 ? null
                    : first.substring(0, 4) + "\u2026" + first.substring(first.length() - 3));
            out.put("libreUrl", libreUrl);

            String provider = prefs.getString(KEY_LLM_PROVIDER, LlmTranslator.ANTHROPIC);
            List<String> llmKeys = keysIn(prefs.getString("llm_key_" + provider, null));
            String llmKey = llmKeys.isEmpty() ? null : llmKeys.get(0);
            String llmBase = prefs.getString(KEY_LLM_BASE, "");
            boolean llmReady = LlmTranslator.CUSTOM.equals(provider)
                    ? !llmBase.isEmpty() && prefs.getBoolean("llm_ready_custom", false)
                    : llmKey != null && !llmKey.isEmpty();
            out.put("llmProvider", provider);
            out.put("llmModel", prefs.getString("llm_model_" + provider, LlmTranslator.defaultModel(provider)));
            out.put("llmBase", llmBase);
            out.put("llmConfigured", llmReady);
            out.put("llmKeys", llmKeys.size());
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
            // Several keys, one to a line: each is checked before any is kept,
            // so a typo is caught here rather than on the first chapter.
            List<String> keys = keysIn(trimmed);
            for (int i = 0; i < keys.size(); i++) {
                try {
                    fetchUsage(keys.get(i));
                } catch (Exception e) {
                    fail(requestId, (keys.size() > 1 ? "Key " + (i + 1) + ": " : "") + describe(e));
                    return;
                }
            }
            prefs.edit().putString(KEY_AUTH, String.join("\n", keys)).putInt(KEY_AUTH + "_at", 0).apply();
            succeed(requestId, status());
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
                // Each key tried with a word of translation: several, one to a line,
                // are taken in turn when one runs out.
                List<String> keys = keysIn(cleanKey);
                if (keys.isEmpty()) keys.add("");
                for (int i = 0; i < keys.size(); i++) {
                    try {
                        List<String> probe = LlmTranslator.translate(setup.withKey(keys.get(i)),
                                java.util.Collections.singletonList("こんにちは"), "EN-GB", "ja", (String) null);
                        if (probe.isEmpty()) throw new IOException("The model gave no answer.");
                    } catch (Exception e) {
                        fail(requestId, (keys.size() > 1 ? "Key " + (i + 1) + ": " : "") + describe(e));
                        return;
                    }
                }
                SharedPreferences.Editor edit = prefs.edit()
                        .putString(KEY_LLM_PROVIDER, provider)
                        .putString("llm_model_" + provider, setup.model)
                        .putString(KEY_ENGINE, ENGINE_LLM);
                if (!cleanKey.isEmpty()) {
                    edit.putString("llm_key_" + provider, String.join("\n", keysIn(cleanKey)))
                            .putInt("llm_key_" + provider + "_at", 0);
                }
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
            List<String> keys = keysIn(prefs.getString(KEY_AUTH, null));
            if (keys.isEmpty()) { fail(requestId, "No DeepL key is set"); return; }
            try {
                // The key in use now: the one a quota running out would move on from.
                int at = Math.max(0, prefs.getInt(KEY_AUTH + "_at", 0)) % keys.size();
                succeed(requestId, fetchUsage(keys.get(at)));
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
        run(requestId, textsJson, targetLang, sourceLang, LlmTranslator.Options.context(context), null);
    }

    /**
     * As translate, with everything else that helps (LlmTranslator.Options,
     * as JSON): the context around the text; the book's glossary; how the
     * part before ended; the reader's own instructions for a model; and the
     * page as a picture, for a model that can see. DeepL takes the context,
     * the glossary and what came before; a model takes all of it; on-device
     * and LibreTranslate take none of it, and translate as before.
     */
    @JavascriptInterface
    public void translateWith(final String requestId, final String textsJson,
                              final String targetLang, final String sourceLang,
                              final String optionsJson) {
        run(requestId, textsJson, targetLang, sourceLang, LlmTranslator.Options.of(optionsJson), null);
    }

    /**
     * A question for the language model set up, and its answer as text: how
     * a book's names and terms are found for its glossary. Only a model can
     * be asked; the other engines say so.
     */
    @JavascriptInterface
    public void complete(final String requestId, final String system, final String user) {
        io.execute(() -> {
            try {
                if (!ENGINE_LLM.equals(engine())) {
                    fail(requestId, "Finding names needs an AI model as the translator — Settings → Translation.");
                    return;
                }
                String answer = withLlmKeys((setup) -> LlmTranslator.complete(setup, system, user));
                JSONObject result = new JSONObject();
                result.put("text", answer);
                succeed(requestId, result.toString());
            } catch (Exception e) {
                fail(requestId, describe(e));
            }
        });
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
        run(requestId, textsJson, targetLang, sourceLang, new LlmTranslator.Options(), "xml");
    }

    private void run(final String requestId, final String textsJson,
                     final String targetLang, final String sourceLang,
                     final LlmTranslator.Options options, final String tagHandling) {
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
                    case ENGINE_DEEPL: translateWithDeepL(requestId, texts, targetLang, sourceLang, chars, options, tagHandling); break;
                    case ENGINE_LIBRE: translateWithLibre(requestId, texts, targetLang, sourceLang, chars); break;
                    case ENGINE_LLM: translateWithLlm(requestId, texts, targetLang, sourceLang, options, chars); break;
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
                                    int chars, LlmTranslator.Options options, String tagHandling) throws Exception {
        if (keysIn(prefs.getString(KEY_AUTH, null)).isEmpty()) {
            fail(requestId, "No DeepL key is set. Add one, or switch to on-device translation.");
            return;
        }

        JSONObject body = new JSONObject();
        body.put("text", texts);
        body.put("target_lang", targetLang.toUpperCase());
        // Keeps paragraph structure rather than reflowing it, which matters
        // when the result is put back into a chapter.
        body.put("preserve_formatting", true);
        // What came before, and what is around: DeepL reads it for sense and
        // charges nothing for it.
        StringBuilder context = new StringBuilder();
        if (options.previous != null && !options.previous.trim().isEmpty()) context.append(options.previous.trim()).append('\n');
        if (options.context != null && !options.context.trim().isEmpty()) context.append(options.context.trim());
        if (context.length() > 0) body.put("context", context.toString());
        if (tagHandling != null) body.put("tag_handling", tagHandling);
        // The model DeepL's own website translates with. Left unasked, the
        // API answers with the one made for speed, which is the difference
        // between pasting a page into deepl.com and having it translated here.
        body.put("model_type", "quality_optimized");
        // The language, where it is known: a short bubble, misread a little,
        // is easily taken for another.
        String from = sourceLang == null ? "" : base(sourceLang).toUpperCase(java.util.Locale.ROOT);
        if (DEEPL_SOURCES.contains(from)) body.put("source_lang", from);

        final String into = base(targetLang).toUpperCase(java.util.Locale.ROOT);
        String response = withDeepLKeys((key) -> {
            // The book's glossary, as a DeepL glossary: names rendered the
            // same every time. It needs the source language said; one that
            // cannot be made is no reason not to translate.
            JSONObject request = new JSONObject(body.toString());
            if (body.has("source_lang") && !options.glossary.isEmpty()) {
                String glossary = deepLGlossary(key, from, into, options.glossary);
                if (glossary != null) request.put("glossary_id", glossary);
            }
            return post(key, "/v2/translate", request.toString());
        });
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
                                  LlmTranslator.Options options, int chars) throws Exception {
        String provider = prefs.getString(KEY_LLM_PROVIDER, LlmTranslator.ANTHROPIC);
        if (!LlmTranslator.CUSTOM.equals(provider) && keysIn(prefs.getString("llm_key_" + provider, "")).isEmpty()) {
            fail(requestId, "No key is set for the model. Add one in Settings → Translation.");
            return;
        }
        List<String> in = new ArrayList<>();
        for (int i = 0; i < texts.length(); i++) in.add(texts.getString(i));
        List<String> translated = withLlmKeys((setup) ->
                LlmTranslator.translate(setup, in, targetLang, sourceLang, options));
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

    /* ── several keys ─────────────────────────────────────────────────────
     *
     * A key field may hold several keys, one to a line. The one in use is
     * remembered; when it is refused or runs out of quota or credit, the next
     * is tried, and the next, and the one that worked is used from then on.
     * Only when every key has failed does the translation fail -- with the
     * last one's reason.
     */

    /** The keys in a stored or typed value: one to a line (or a comma, or a space between). */
    static List<String> keysIn(String value) {
        List<String> out = new ArrayList<>();
        if (value == null) return out;
        for (String part : value.split("[\\s,;]+")) {
            String key = part.trim();
            if (!key.isEmpty() && !out.contains(key)) out.add(key);
        }
        return out;
    }

    interface Keyed<T> {
        T run(String key) throws Exception;
    }

    private <T> T withKeys(String pref, Keyed<T> work) throws Exception {
        List<String> keys = keysIn(prefs.getString(pref, ""));
        if (keys.isEmpty()) keys.add("");
        int start = Math.max(0, prefs.getInt(pref + "_at", 0)) % keys.size();
        Exception last = null;
        for (int n = 0; n < keys.size(); n++) {
            int at = (start + n) % keys.size();
            try {
                T result = work.run(keys.get(at));
                if (at != start) prefs.edit().putInt(pref + "_at", at).apply();
                return result;
            } catch (LlmTranslator.HttpError e) {
                if (!e.keySpent) throw e;
                last = e;
                if (keys.size() > 1) Log.w(TAG, "Key " + (at + 1) + " of " + keys.size() + " spent; trying the next");
            }
        }
        if (keys.size() > 1 && last != null) {
            throw new IOException("Every key has been refused or has run out. The last said: " + last.getMessage());
        }
        throw last;
    }

    private String withDeepLKeys(Keyed<String> work) throws Exception {
        return withKeys(KEY_AUTH, work);
    }

    interface Modelled<T> {
        T run(LlmTranslator.Setup setup) throws Exception;
    }

    private <T> T withLlmKeys(Modelled<T> work) throws Exception {
        String provider = prefs.getString(KEY_LLM_PROVIDER, LlmTranslator.ANTHROPIC);
        LlmTranslator.Setup setup = new LlmTranslator.Setup(provider, "",
                prefs.getString("llm_model_" + provider, ""), prefs.getString(KEY_LLM_BASE, ""));
        return withKeys("llm_key_" + provider, (key) -> work.run(setup.withKey(key)));
    }

    /* ── DeepL glossaries ─────────────────────────────────────────────────
     *
     * A book's glossary, made a DeepL glossary for its pair of languages and
     * kept by what it holds: the same entries are the same glossary, used
     * again; changed entries are a new one, and the oldest are deleted once
     * there are more than a handful, so an account is not filled with them.
     */
    private static final String KEY_GLOSSARIES = "deepl_glossaries";
    private static final int KEEP_GLOSSARIES = 12;

    private String deepLGlossary(String key, String from, String into, List<LlmTranslator.Term> terms) {
        StringBuilder tsv = new StringBuilder();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (LlmTranslator.Term term : terms) {
            String source = term.source.replaceAll("[\\t\\r\\n]+", " ").trim();
            String target = term.target.replaceAll("[\\t\\r\\n]+", " ").trim();
            if (source.isEmpty() || target.isEmpty() || !seen.add(source)) continue;
            tsv.append(source).append('\t').append(target).append('\n');
        }
        if (tsv.length() == 0) return null;
        try {
            String id = hashOf(hostFor(key) + key + "|" + from + "|" + into + "|" + tsv);
            JSONObject kept = new JSONObject(prefs.getString(KEY_GLOSSARIES, "{}"));
            JSONObject known = kept.optJSONObject(id);
            if (known != null) return known.getString("id");

            JSONObject body = new JSONObject();
            body.put("name", "Quire " + from + "-" + into);
            body.put("source_lang", from);
            body.put("target_lang", into.toLowerCase(java.util.Locale.ROOT));
            body.put("entries", tsv.toString());
            body.put("entries_format", "tsv");
            String made = new JSONObject(post(key, "/v2/glossaries", body.toString())).getString("glossary_id");
            kept.put(id, new JSONObject().put("id", made).put("key", hashOf(key)).put("at", System.currentTimeMillis()));
            // The oldest made with this key go, beyond a handful.
            List<String> mine = new ArrayList<>();
            for (java.util.Iterator<String> it = kept.keys(); it.hasNext();) {
                String k = it.next();
                if (hashOf(key).equals(kept.getJSONObject(k).optString("key"))) mine.add(k);
            }
            java.util.Collections.sort(mine, (a, b) -> Long.compare(
                    kept.optJSONObject(a).optLong("at"), kept.optJSONObject(b).optLong("at")));
            while (mine.size() > KEEP_GLOSSARIES) {
                String old = mine.remove(0);
                try {
                    request(key, "DELETE", "/v2/glossaries/" + kept.getJSONObject(old).getString("id"), null);
                } catch (Exception ignored) {
                    // Gone already, or never there: forgotten either way.
                }
                kept.remove(old);
            }
            prefs.edit().putString(KEY_GLOSSARIES, kept.toString()).apply();
            return made;
        } catch (Exception e) {
            Log.w(TAG, "No DeepL glossary for " + from + "-" + into + ": " + describe(e));
            return null;
        }
    }

    private static String hashOf(String text) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 12; i++) out.append(String.format("%02x", bytes[i]));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            return Integer.toHexString(text.hashCode());
        }
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
        return LlmTranslator.withRetries(() -> request(key, "POST", path, body));
    }

    private String request(String key, String method, String path, String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(hostFor(key) + path).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestProperty("Authorization", "DeepL-Auth-Key " + key);
            if (body != null) connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("User-Agent", "Quire/" + BuildConfig.VERSION_NAME);

            if (body != null) {
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            } else if ("POST".equals(method)) {
                // Nothing to send: a plain GET.
                connection.setRequestMethod("GET");
            }

            int code = connection.getResponseCode();
            if (code >= 200 && code < 300) return read(connection.getInputStream());

            // DeepL's errors are specific and worth passing through in plain
            // words rather than as a status number.
            switch (code) {
                case 401:
                case 403: throw new LlmTranslator.HttpError(code, "DeepL rejected that key. Copy it again from "
                        + "Account → API Keys & Limits: a DeepL API key, not a password, and a free one ends in :fx.", true);
                case 429: throw new LlmTranslator.HttpError(code, "Too many requests. Wait a moment and try again.", false);
                case 456: throw new LlmTranslator.HttpError(code, "This key has used its character quota for the period.", true);
                case 400: throw new LlmTranslator.HttpError(code, "DeepL could not read that request: "
                        + read(connection.getErrorStream()), false);
                default: throw new LlmTranslator.HttpError(code, "DeepL returned HTTP " + code, false);
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
