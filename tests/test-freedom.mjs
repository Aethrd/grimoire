import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* These assert the shape of the build, not its behaviour: no paywall, no ads,
 * no sign-in, no network. They exist because those are easy things to
 * reintroduce by accident — a dependency, a stray import, one merged manifest
 * entry — and hard to notice once they are back. */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const jsFiles = fs.readdirSync(path.join(root, 'app/src/main/assets/www/js'));
const allJs = jsFiles.map((f) => read(`app/src/main/assets/www/js/${f}`)).join('\n');

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok  ' + name); pass++; };

console.log('no paywall');

t('no gating vocabulary anywhere in the reader', () => {
  for (const word of ['supporter', 'isSupporter', 'entitlement', 'billing', 'purchase', 'paywall']) {
    assert.ok(!new RegExp(word, 'i').test(allJs), `"${word}" is back in the reader`);
  }
});

t('no billing dependency in the build', () => {
  const gradle = read('app/build.gradle.kts');
  assert.ok(!/billing/i.test(gradle), 'a billing library was added');
});

t('no supporter screen', () => {
  const html = read('app/src/main/assets/www/index.html');
  assert.ok(!/data-screen="supporter"/.test(html));
  assert.ok(!/data-go="supporter"/.test(html));
});

console.log('no ads');

t('no advertising SDK or ad vocabulary', () => {
  const gradle = read('app/build.gradle.kts');
  for (const word of ['admob', 'ads', 'adview', 'rewarded', 'interstitial']) {
    assert.ok(!new RegExp(word, 'i').test(gradle), `"${word}" in build.gradle.kts`);
  }
  assert.ok(!/rewarded|interstitial|admob/i.test(allJs));
});

console.log('no sign-in');

t('no account, credential or OAuth code', () => {
  for (const word of ['GrimoireAccount', 'credential', 'oauth', 'signIn', 'googleid', 'accessToken']) {
    assert.ok(!new RegExp(word, 'i').test(allJs), `"${word}" is back in the reader`);
  }
});

t('no auth libraries in the dependency graph', () => {
  const catalog = read('gradle/libs.versions.toml');
  for (const word of ['credentials', 'googleid', 'play-services-auth']) {
    assert.ok(!catalog.includes(word), `"${word}" is back in the version catalog`);
  }
});

t('the Java bridge exposes nothing account-shaped', () => {
  const java = fs.readdirSync(path.join(root, 'app/src/main/java/com/grimoire/ereader'));
  assert.ok(!java.includes('GoogleAccountBridge.java'));
  assert.ok(!java.includes('DriveAppData.java'));
  const bridge = read('app/src/main/java/com/grimoire/ereader/GrimoireBridge.java');
  assert.ok(!/token|credential|account/i.test(bridge));
});

console.log('no network');

t('the manifest declares INTERNET and nothing else', () => {
  // One permission, for DeepL translation. Anything else means a dependency
  // merged something in.
  const manifest = read('app/src/main/AndroidManifest.xml');
  const withoutComments = manifest.replace(/<!--[\s\S]*?-->/g, '');
  const declared = [...withoutComments.matchAll(/<uses-permission android:name="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(declared, ['android.permission.INTERNET']);
});

t('nothing in the reader itself can reach the network', () => {
  // DeepL refuses client-side calls, so every request is made natively. That
  // keeps the page unable to talk to anything, which is worth preserving even
  // now that the app has INTERNET.
  assert.ok(!/fetch\s*\(\s*["\x60']https?:/i.test(allJs));
  assert.ok(!/XMLHttpRequest/.test(allJs));
  assert.ok(!/EventSource|WebSocket/.test(allJs));
});

t('nothing reaches the network unless translation is asked for', () => {
  // The premise changed when on-device translation was added: there is now a
  // path that needs no key at all. What still has to hold is that each engine
  // refuses until it is configured, and that none of them run on their own.
  const java = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');

  const deepl = java.slice(java.indexOf('translateWithDeepL(String'));
  assert.match(deepl.slice(0, 600), /getString\(KEY_AUTH/,
    'the DeepL path does not check for a key first');
  assert.match(deepl.slice(0, 700), /No DeepL key is set/);

  const libre = java.slice(java.indexOf('translateWithLibre(String'));
  assert.match(libre.slice(0, 600), /getString\(KEY_LIBRE_URL/,
    'the LibreTranslate path does not check for a server first');

  // On-device fetches a model once. Doing that on someone's mobile data
  // without asking is not on, so it is Wi-Fi only.
  const ondevice = java.slice(java.indexOf('translateOnDevice(String'));
  assert.match(ondevice.slice(0, 2000), /requireWifi\(\)/,
    'the model download does not require Wi-Fi');
});

t('the default engine needs no account and no key', () => {
  // This is the answer to "does translation really need an API".
  const java = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  assert.match(java, /return prefs\.getString\(KEY_ENGINE, ENGINE_ONDEVICE\)/,
    'the keyless engine is not the default');
  const js = read('app/src/main/assets/www/js/translate.js');
  assert.match(js, /\['ondevice',/);
});

t('the DeepL key never crosses the bridge', () => {
  const java = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  // status() may report that a key exists, and a hint, but never the key.
  const status = java.slice(java.indexOf('public String status()'), java.indexOf('setKey'));
  assert.ok(!/out\.put\("key"/.test(status), 'status() returns the key itself');
  assert.match(status, /configured/);
  const js = read('app/src/main/assets/www/js/translate.js');
  assert.ok(!/getKey|readKey/.test(js), 'the page tries to read the key back');
});

console.log(`\n${pass} assertions passed`);
