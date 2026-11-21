/* Several keys for a translation service: turned every so many requests,
 * a second service fallen back on when every key of the first runs out, and
 * each key tested before a long run. The keys themselves stay native; the
 * bridge is stood in for here, and the settings driven as a reader would. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const www = (file) => new URL(`../app/src/main/assets/www/js/${file}`, import.meta.url).href;
const translate = await import(www('translate.js'));
const panels = await import(www('panels.js'));
const screens = await import(www('screens.js'));
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass++; };
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

let state = {
  engine: 'llm', llmProvider: 'anthropic', llmModel: 'claude-haiku-5-5', llmConfigured: true, configured: true,
  llmKeys: 3, llmHint: 'sk-ant…xyz', llmRotateEvery: 0, llmFallback: '',
  llmReady: { anthropic: { keys: 3, model: 'claude-haiku-5-5' } },
};
const calls = [];
const settle = (id, value) => setTimeout(() => translate.settle(id, true, typeof value === 'string' ? value : JSON.stringify(value)), 1);
window.GrimoireTranslate = globalThis.window.GrimoireTranslate = {
  status: () => JSON.stringify(state),
  setLlm(id, provider, key, model, base) {
    calls.push(['setLlm', provider, key, model, base]);
    settle(id, { ...state, rejected: [{ n: 2, hint: 'sk-ant…bad', ok: false, why: 'The key was refused' }] });
  },
  addLlm(id, provider, key, model, base) {
    calls.push(['addLlm', provider, key, model, base]);
    state = { ...state, llmReady: { ...state.llmReady, [provider]: { keys: 1, model: model || 'gpt-6-luna' } } };
    settle(id, { ...state, rejected: [] });
  },
  setLlmOptions(id, every, fallback) {
    calls.push(['setLlmOptions', every, fallback]);
    state = { ...state, llmRotateEvery: every, llmFallback: fallback };
    settle(id, state);
  },
  testKeys(id, provider) {
    calls.push(['testKeys', provider]);
    settle(id, provider === 'anthropic'
      ? [{ n: 1, hint: 'sk-ant…aaa', ok: true, ms: 840 }, { n: 2, hint: 'sk-ant…bbb', ok: false, why: 'Out of credit', ms: 300 },
        { n: 3, hint: 'sk-ant…ccc', ok: true, ms: 910 }]
      : [{ n: 1, hint: 'sk-pro…ddd', ok: true, ms: 1200 }]);
  },
  clearLlm(id, provider) { calls.push(['clearLlm', provider]); settle(id, state); },
  models(id) { settle(id, []); },
};

const host = document.createElement('div');
document.body.appendChild(host);
const keysCard = () => host.querySelector('.keys-card');
const button = (text, root = host) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.hidden);
const said = () => screens.notices().map((n) => n.text || n.message || String(n)).join('\n');

await panels.openLanguage(host);
await tick(30);

await t('the keys are said by count, never shown; turning every so many requests is set and kept', async () => {
  assert.ok(keysCard(), 'no Keys card for a service in use');
  assert.match(keysCard().textContent, /Claude: 3 keys/);
  const every = keysCard().querySelector('input[type=number]');
  assert.equal(every.value, '0');
  every.value = '5';
  every.dispatchEvent(new window.Event('change'));
  await tick(20);
  assert.deepEqual(calls.at(-1), ['setLlmOptions', 5, '']);
});

await t('every key tested on asking: each said worked or not, and why', async () => {
  button('Test all keys', keysCard()).click();
  await tick(40);
  const lines = [...keysCard().querySelectorAll('.key-result')].map((l) => l.textContent);
  assert.deepEqual(lines, [
    '✓ Key 1 (sk-ant…aaa) — works, 0.8 s',
    '✗ Key 2 (sk-ant…bbb) — Out of credit',
    '✓ Key 3 (sk-ant…ccc) — works, 0.9 s',
  ]);
});

await t('another service kept to fall back on, without becoming the translator, and chosen', async () => {
  [...host.querySelectorAll('button')].find((b) => b.dataset.code === 'openai').click();
  await tick();
  const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === 'AI model');
  card.querySelector('textarea, input[type=password], input:not([type=url]):not([type=number])').value = 'sk-proj-fallback';
  button('Keep as fallback instead').click();
  await tick(60);
  assert.equal(calls.find((c) => c[0] === 'addLlm')[1], 'openai');
  assert.ok(!calls.some((c) => c[0] === 'setLlm'), 'made the translator');
  assert.deepEqual(calls.at(-1), ['setLlmOptions', 5, 'openai']);
  await panels.openLanguage(host);
  await tick(30);
  const chips = [...keysCard().querySelectorAll('.chip')];
  assert.deepEqual(chips.map((c) => c.textContent), ['Nothing', 'ChatGPT · gpt-6-luna']);
  assert.equal(chips[1].getAttribute('aria-pressed'), 'true');
  // Tested as well as the main one.
  calls.length = 0;
  button('Test all keys', keysCard()).click();
  await tick(60);
  assert.deepEqual(calls.filter((c) => c[0] === 'testKeys').map((c) => c[1]), ['anthropic', 'openai']);
});

await t('connecting with a bad key among good ones keeps the good, and says which was not kept and why', async () => {
  host.replaceChildren();
  await panels.openLanguage(host);
  await tick(30);
  [...host.querySelectorAll('button')].find((b) => b.dataset.code === 'anthropic').click();
  await tick();
  const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === 'AI model');
  card.querySelector('textarea, input[type=password], input:not([type=url]):not([type=number])').value = 'sk-ant-good\nsk-ant-bad';
  button('Connect', card).click();
  await tick(40);
  assert.match(said(), /Connected — 1 key not kept: key 2 \(sk-ant…bad\): The key was refused/);
});

await t('natively: turned every N requests, passed over when spent, the fallback only for the service’s failures', () => {
  const bridge = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  // Turned: every rotateEvery requests, the next key.
  assert.match(bridge, /if \(count >= rotateEvery\) \{\s*count = 0;\s*start = \(start \+ 1\) % keys\.size\(\);/);
  assert.match(bridge, /return withKeys\("llm_key_" \+ provider, \(key\) -> work\.run\(setup\.withKey\(key\)\), rotate\);/);
  // Fallback: its own keys and model, only for keys spent, limits, server or auth failures.
  assert.match(bridge, /if \(back\.isEmpty\(\) \|\| back\.equals\(provider\) \|\| !llmReady\(back\) \|\| !fallsBack\(e\)\) throw e;/);
  assert.match(bridge, /return http\.keySpent \|\| http\.code == 429 \|\| http\.code >= 500 \|\| http\.code == 401 \|\| http\.code == 403;/);
  // Tested: a hint of each key, never the key.
  const probe = bridge.slice(bridge.indexOf('private JSONObject probeKey('), bridge.indexOf('private static String hintOf('));
  assert.match(probe, /out\.put\("hint", hintOf\(setup\.key\)\);/);
  assert.ok(!/out\.put\("key"/.test(probe), 'a key handed to the page');
  // Kept: the keys that worked; the rest said.
  assert.match(bridge, /if \(tried\.optBoolean\("ok"\)\) working\.add\(keys\.get\(i\)\);/);
  // Not in cloud backups: the translation settings are not among what is backed up.
  const rules = read('app/src/main/res/xml/data_extraction_rules.xml');
  assert.ok(!/sharedpref/.test(rules), 'keys backed up to the cloud');
});

console.log(`\n${pass} checks passed`);
process.exit(0);
