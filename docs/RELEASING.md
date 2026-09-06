# Releasing

There is no app store here. A release is a signed APK attached to a GitHub
release, which you or anyone else installs directly.

## Once: make a signing key

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

Without them the build still runs, signs with the debug key, and warns. Fine
for a one-off test, not for anything you intend to update.

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
