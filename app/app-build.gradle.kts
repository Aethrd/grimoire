import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// versionCode / versionName are injected by CI:
//   gradle bundleRelease -PversionCode=42 -PversionName=1.2.0
val appVersionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
val appVersionName = (project.findProperty("versionName") as String?) ?: "0.1.0"

// Signing config comes from env vars in CI, or a local keystore.properties
// that is git-ignored. Neither present -> release builds fall back to debug
// signing so the project still assembles on a clean clone.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

fun secret(envName: String, propName: String): String? =
    System.getenv(envName) ?: keystoreProps.getProperty(propName)

val storeFilePath = secret("KEYSTORE_FILE", "storeFile")
val hasReleaseSigning = storeFilePath != null && file(storeFilePath).exists()

/* ── pdf.js ───────────────────────────────────────────────────────────────
 *
 * pdf.js and its character maps are 4.3MB of unmodified library code, and the
 * cmaps alone are 169 files. Committing that to git is a poor trade for a
 * personal project, so the build fetches it instead -- the same way it already
 * fetches every other dependency, just from a different registry.
 *
 * The result is git-ignored and lands in the assets directory, so the APK
 * still ships it and the app still makes no network calls at runtime.
 */
val pdfJsVersion = "4.10.38"
val vendorDir = file("src/main/assets/www/vendor")

val vendorPdfJs by tasks.registering {
    description = "Fetches pdf.js into the bundled assets."
    group = "build setup"

    val marker = File(vendorDir, "pdf.min.mjs")
    // Skipped entirely once present, so an ordinary rebuild costs nothing and
    // an offline rebuild works.
    outputs.file(marker)
    outputs.upToDateWhen { marker.exists() }

    doLast {
        val archive = File(layout.buildDirectory.get().asFile, "pdfjs-$pdfJsVersion.tgz")
        if (!archive.exists()) {
            archive.parentFile.mkdirs()
            val url = "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-$pdfJsVersion.tgz"
            logger.lifecycle("Fetching pdf.js $pdfJsVersion…")
            uri(url).toURL().openStream().use { input ->
                archive.outputStream().use { output -> input.copyTo(output) }
            }
        }

        // The legacy build, because minSdk is 26 and the modern one assumes a
        // newer JS baseline than an old WebView provides.
        copy {
            from(tarTree(resources.gzip(archive))) {
                include("package/legacy/build/pdf.min.mjs")
                include("package/legacy/build/pdf.worker.min.mjs")
                eachFile { path = name }
            }
            into(vendorDir)
            includeEmptyDirs = false
        }
        // Character maps, without which most Korean and Japanese PDFs extract
        // as nothing, and the base fourteen fonts.
        for (dir in listOf("cmaps", "standard_fonts")) {
            copy {
                from(tarTree(resources.gzip(archive))) {
                    include("package/$dir/**")
                    eachFile { path = path.removePrefix("package/") }
                }
                into(vendorDir)
                includeEmptyDirs = false
            }
        }
        logger.lifecycle("pdf.js vendored into ${vendorDir.relativeTo(rootDir)}")
    }
}

tasks.named("preBuild") { dependsOn(vendorPdfJs) }

android {
    namespace = "com.grimoire.ereader"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.grimoire.ereader"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(storeFilePath!!)
                storePassword = secret("KEYSTORE_PASSWORD", "storePassword")
                keyAlias = secret("KEY_ALIAS", "keyAlias")
                keyPassword = secret("KEY_PASSWORD", "keyPassword")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = false
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("No release keystore found -- signing release with the debug key. This build CANNOT be uploaded to Play.")
                signingConfigs.getByName("debug")
            }
        }
    }


    // Play requires a bundle; keep the language splits but ship one universal
    // density/abi since this app has no native code.
    bundle {
        language { enableSplit = false }
    }

    androidResources {
        // .dc.html exports can contain pre-compressed fonts; do not double-compress.
        noCompress += listOf("woff2", "epub")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        disable += "GoogleAppIndexingWarning"
        // So CI can print the whole failure list instead of just the first one.
        textReport = true
        htmlReport = true
    }

    dependenciesInfo {
        // Keep the dependency blob out of the APK; Play still gets it in the AAB.
        includeInApk = false
        includeInBundle = true
    }
}

/*
 * Kotlin's stdlib was split across three artifacts until 1.8.0, when
 * kotlin-stdlib-jdk7 and kotlin-stdlib-jdk8 were folded into kotlin-stdlib.
 * A dependency built before that still asks for the old artifacts by name, so
 * the same classes arrive twice and D8 refuses to guess which copy to dex.
 *
 * Two halves to the fix, because either alone would be luck:
 *
 *   exclude      drops the pre-1.8 artifacts wherever they are requested.
 *                Safe only if kotlin-stdlib is 1.8.0 or newer, since that is
 *                where their classes now live.
 *   constraint   guarantees exactly that, rather than relying on some other
 *                dependency happening to pull a new enough stdlib.
 *
 * This survives a future dependency reintroducing the problem, which pinning
 * one library's version would not.
 */
configurations.configureEach {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk7")
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk8")
}

dependencies {
    constraints {
        implementation("org.jetbrains.kotlin:kotlin-stdlib:${libs.versions.kotlin.get()}") {
            because("the jdk7/jdk8 stdlib artifacts are excluded above, and their classes only exist in kotlin-stdlib from 1.8.0 onwards")
        }
    }

    implementation(libs.androidx.activity)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core)
    implementation(libs.androidx.splashscreen)
    implementation(libs.androidx.webkit)
    implementation(libs.mlkit.translate)

}
