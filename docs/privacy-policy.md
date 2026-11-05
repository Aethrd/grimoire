# Quire Privacy Policy

_Last updated: 5 September 2026_

Quire collects nothing and sends nothing anywhere, with exactly one
exception you have to switch on yourself: translation.

The app declares one permission, `INTERNET`, and uses it for one thing:
translation, when you ask for it.

The default engine runs **on your device**. It needs no account and no API
key. The only thing it ever downloads is a language pack, once, over Wi-Fi;
after that it translates offline and nothing you read is sent anywhere.

If you prefer, you can switch to DeepL or to a LibreTranslate server. Those
send the text being translated to that service. Both are off unless you
configure them.

There is no account, no sync, no analytics, no crash reporting and no
advertising. The release build fails if any permission other than `INTERNET`
appears in the APK.

## What is stored, and where

On your device, inside the app's own storage:

- The books you import and their contents
- Your reading position, bookmarks and highlights
- Your reading history, which the stats page is calculated from
- Your display preferences

Uninstalling the app deletes all of it.

## Translation

**On device (the default).** Text is translated on your phone and is not sent
anywhere. A language pack of around 30MB is downloaded once, over Wi-Fi.

**DeepL.** If you enter an API key, the text being translated is sent to DeepL
over HTTPS. Which text depends on the switches you set:

- **Book titles** — the titles on your shelf, once each.
- **Chapter names** — a book's chapter names, once per book.
- **Body text** — only the chapter you press the translate button on.

**LibreTranslate.** The same, but sent to whichever server you nominate — which
may be one you run yourself.

Your book files are never uploaded — only the words being translated, and only
by the engines that leave the device at all. Every result is cached so nothing
is sent twice.

Your API key is stored in the app's private storage and is never shown to the
page, logged, or sent anywhere except to DeepL as your authorisation. Remove it
in Language settings and the app stops making requests immediately.

What DeepL does with text you send them is covered by their privacy policy, not
this one. If that matters to you, leave translation switched off — everything
else in the app works without it.

## What is not here

No account. No sign-in. No sync. No analytics. No crash reporting. No
advertising identifier. No advertisements. No in-app purchases. No third-party
SDKs of any kind. DeepL is contacted only when you translate something, and
only if you have given the app a key.

## Files you open

When you open a book, Android grants read access to that one file through the
Storage Access Framework. Quire reads it and does not modify it. It has no
access to the rest of your storage.

## System backup

If you have Android backup enabled, your reading data may be included in it.
That is between you and Google, covered by their backup encryption and your
account settings. The private vault is excluded from backup.

## Changes

If a future version ever adds a network feature, this policy will be updated
and the permission will appear in the manifest before that version is
published. You can check for yourself: the manifest is in the repository, and
every release run prints the APK's permission list.

## Contact

Open an issue on the project's GitHub repository.
