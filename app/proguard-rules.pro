# The JS bridge is reached by name from the reader, so R8 must not touch it.
-keepclassmembers class com.grimoire.ereader.GrimoireBridge {
    public *;
}
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Readable stack traces from Play Console crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
