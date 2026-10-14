# Releasing

There is no app store here. A release is a signed APK attached to a GitHub
release, which you or anyone else installs directly.

## Updating without uninstalling

Every build -- the debug APK from **Actions → CI** as much as a release -- is
signed with `app/signing/grimoire.keystore`, which lives in the repository.
Android installs an update only over an app signed with the same key, so any
APK built from this repository installs straight over the last one, library
and all. Before it was there, each CI run signed with a key made fresh for
that run, and every update meant uninstalling first, which deletes every book.

The key is not secret and does not need to be: it only shows that an update
came from the same place as the app it replaces. Do not delete or regenerate
it -- a different key is a different app as far as Android is concerned.

The debug build's version number is the CI run number, so each one is newer
than the last.

## Optional: a signing key of your own

The shared key is enough for installing your own builds. A private key, kept
out of the repository, is only worth having if others install the APK and you
want only your builds to be able to update it.

```bash
keytool -genkeypair -v \
  -keystore release.jks -alias grimoire \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Grimoire, O=Grimoire, C=AU"
```

**Keep this file.** Android keys app data to the signing certificate, so two
APKs signed with different keys are unrelated apps as far as the system is
concerned — installing one over the other is refused. Lose the key and every
future update forces an uninstall, which deletes the library: every book, every
bookmark, every reading position.

Add four repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | `base64 -w0 release.jks` |
| `KEYSTORE_PASSWORD` | store password |
| `KEY_ALIAS` | `grimoire` |
| `KEY_PASSWORD` | key password |

Without them the build still runs, signs with the shared key, and says so.
Switching an installed app from the shared key to a private one needs one
last uninstall -- back up first (Settings → Data & vault → Save a backup).

For local builds, `keystore.properties` in the project root does the same job
and is git-ignored:

```properties
storeFile=/absolute/path/to/release.jks
storePassword=…
keyAlias=grimoire
keyPassword=…
```

## Each release

```bash
git tag v1.2.0 && git push origin v1.2.0
```

The workflow builds, checks the APK declares no permissions, verifies the
signing certificate is not the debug key, and attaches the APK to a GitHub
release. `versionCode` comes from the run number, so it always increases.

You can also run it by hand from **Actions → Release → Run workflow**.

## The permission check

The release build fails outright if the APK requests any permission. The app is
meant to declare none, and a merged manifest from a future dependency is
exactly the sort of thing that would slip one in unnoticed. If that check ever
fires, find out what pulled it in before overriding it — and update
`docs/privacy-policy.md` if the answer is that you want it.

## Installing

Download the APK from the release and open it on the device. Android will ask
you to allow installing from that source; that prompt is normal for anything
not from a store.
