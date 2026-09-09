package com.grimoire.ereader;

import android.app.Application;
import androidx.appcompat.app.AppCompatDelegate;

public class GrimoireApp extends Application {
    /** Where the last crash is left, for the reader to show on next launch. */
    static java.io.File crashFile(android.content.Context context) {
        return new java.io.File(context.getFilesDir(), "last-crash.txt");
    }

    @Override
    public void onCreate() {
        super.onCreate();

        /* A crash is otherwise invisible.
         *
         * When the process dies the app simply vanishes and whatever launched
         * it comes back -- which looks exactly like the app declining to do
         * anything, and says nothing about why. The reason is written down
         * here and shown the next time the reader starts.
         */
        final Thread.UncaughtExceptionHandler previous =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try (java.io.PrintWriter out =
                         new java.io.PrintWriter(crashFile(this), "UTF-8")) {
                out.println(new java.util.Date());
                out.println("on thread: " + thread.getName());
                error.printStackTrace(out);
            } catch (Throwable ignored) {
                // Nothing useful to do if even recording it fails.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
    }
}
