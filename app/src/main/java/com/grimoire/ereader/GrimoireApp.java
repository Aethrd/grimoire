package com.grimoire.ereader;

import android.app.Application;
import androidx.appcompat.app.AppCompatDelegate;

public class GrimoireApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
    }
}
