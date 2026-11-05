/* Signing in to OpenRouter instead of pasting a key, and choosing among its
 * models.
 *
 * The sign-in itself -- the browser, the loopback answer, the trade of the
 * code for a key -- is native (OpenRouterLink.java) and is tried off the
 * phone in Java. Here the bridge is stood in for, and the settings panel is
 * driven the way a reader would drive it. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './harness.mjs';

const window = await boot();
const www = (file) => new URL(`../app/src/main/assets/www/js/${file}`, import.meta.url).href;
const translate = await import(www('translate.js'));
const panels = await import(www('panels.js'));
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); pass++; };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

let state = { engine: 'llm', llmProvider: 'anthropic', llmConfigured: false, configured: false };
const calls = [];
let pendingConnect = null;
const MODELS = [
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', free: false, vision: true, context: 400000 },
  { id: 'qwen/qwen3-235b:free', name: 'Qwen3 235B (free)', free: true, vision: false, context: 131072 },
  { id: 'deepseek/deepseek-v4:free', name: 'DeepSeek V4 (free)', free: true, vision: false, context: 163840 },
  { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', free: false, vision: true, context: 1000000 },
];
window.GrimoireTranslate = globalThis.window.GrimoireTranslate = {
  status: () => JSON.stringify(state),
  connectOpenRouter(id) { calls.push(['connect']); pendingConnect = id; },
  cancelOpenRouter() {
    calls.push(['cancel']);
    const id = pendingConnect;
    pendingConnect = null;
    setTimeout(() => translate.settle(id, false, 'Signing in was cancelled.'), 1);
  },
  openRouterModels(id) { calls.push(['models']); setTimeout(() => translate.settle(id, true, MODELS), 1); },
  setLlm(id, provider, key, model, base) {
    calls.push(['setLlm', provider, key, model, base]);
    state = { ...state, llmModel: model };
    setTimeout(() => translate.settle(id, true, JSON.stringify(state)), 1);
  },
  clearLlm(id, provider) {
    calls.push(['clearLlm', provider]);
    state = { engine: 'ondevice', llmProvider: provider, llmConfigured: false, configured: true };
    setTimeout(() => translate.settle(id, true, JSON.stringify(state)), 1);
  },
  models(id) { setTimeout(() => translate.settle(id, true, []), 1); },
};

const host = document.createElement('div');
document.body.appendChild(host);
const buttons = () => [...host.querySelectorAll('button')];
const button = (text) => buttons().find((b) => b.textContent.trim() === text && !b.hidden);
const aiCard = () => [...host.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === 'AI model');
const openRouterChip = () => buttons().find((b) => b.dataset.code === 'openrouter');

console.log('signing in');

await t('OpenRouter is one of the AI services, offering to sign in rather than a key box', async () => {
  assert.ok(translate.LLM_PROVIDERS.some(([code, label]) => code === 'openrouter' && label === 'OpenRouter'));
  await panels.openLanguage(host);
  openRouterChip().click();
  assert.ok(button('Sign in with OpenRouter'), 'no sign-in button');
  assert.ok(button('Paste a key instead'));
  assert.equal(aiCard().querySelector('.keys-box'), null, 'a key box is shown before it is asked for');
  assert.match(host.textContent, /no key to copy/i);
});

await t('pasting a key is still there, for those who want it', async () => {
  button('Paste a key instead').click();
  assert.ok(aiCard().querySelector('.keys-box'));
  assert.ok(button('Connect'));
  openRouterChip().click();
  assert.ok(button('Sign in with OpenRouter'), 'choosing OpenRouter again goes back to signing in');
});

await t('signing in waits for the browser, and can be cancelled', async () => {
  button('Sign in with OpenRouter').click();
  await tick();
  assert.deepEqual(calls.at(-1), ['connect']);
  const waiting = buttons().find((b) => /Waiting for the browser/.test(b.textContent));
  assert.ok(waiting && waiting.disabled);
  assert.ok(button('Cancel'));
  assert.ok(!button('Paste a key instead'), 'the paste link stays while waiting');
  button('Cancel').click();
  await tick(10);
  assert.deepEqual(calls.at(-1), ['cancel']);
  assert.ok(button('Sign in with OpenRouter') && !button('Sign in with OpenRouter').disabled, 'not ready to try again');
  assert.ok(!button('Cancel'));
  assert.match(document.body.textContent, /Signing in was cancelled/);
});

await t('once the browser comes back, the panel says so', async () => {
  button('Sign in with OpenRouter').click();
  await tick();
  state = { engine: 'llm', llmProvider: 'openrouter', llmModel: 'deepseek/deepseek-v4:free', llmConfigured: true,
    llmLinked: true, llmKeys: 1, llmHint: 'sk-or-…f3a', configured: true };
  translate.settle(pendingConnect, true, JSON.stringify(state));
  await tick(20);
  assert.match(host.textContent, /Signed in with OpenRouter/);
  assert.match(host.textContent, /deepseek\/deepseek-v4:free/);
  assert.ok(button('Sign out'));
  assert.ok(!button('Sign in with OpenRouter'));
});

console.log('\nchoosing a model');

await t('free models first, then by name; searched by name or id', () => {
  assert.deepEqual(translate.sortModels(MODELS).map((m) => m.id),
    ['deepseek/deepseek-v4:free', 'qwen/qwen3-235b:free', 'anthropic/claude-sonnet-5-5', 'openai/gpt-6-luna']);
  assert.deepEqual(translate.sortModels(MODELS, 'claude').map((m) => m.id), ['anthropic/claude-sonnet-5-5']);
  assert.deepEqual(translate.sortModels(MODELS, 'deep v4').map((m) => m.id), ['deepseek/deepseek-v4:free']);
  assert.equal(translate.sortModels(MODELS, '', true).length, 2);
  assert.deepEqual(translate.sortModels(null), []);
});

await t('the model list opens on asking, marks the one in use, free and picture-reading', async () => {
  const change = buttons().find((b) => b.classList.contains('or-current'));
  assert.ok(change, 'no way to change the model');
  change.click();
  await tick(10);
  assert.deepEqual(calls.at(-1), ['models']);
  const rows = [...host.querySelectorAll('.or-row')];
  assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelector('.or-id').textContent, 'deepseek/deepseek-v4:free');
  assert.equal(rows[0].getAttribute('aria-pressed'), 'true');
  assert.ok(rows[0].querySelector('.or-tag.free'));
  assert.match(rows.at(-1).textContent, /Sees pictures/);
});

await t('search and the free filter narrow the list', async () => {
  const search = host.querySelector('.or-models input[type="search"]');
  search.value = 'sonnet';
  search.oninput();
  assert.deepEqual([...host.querySelectorAll('.or-row .or-id')].map((e) => e.textContent), ['anthropic/claude-sonnet-5-5']);
  search.value = '';
  search.oninput();
  button('Free only').click();
  assert.equal(host.querySelectorAll('.or-row').length, 2);
  search.value = 'nothing like this';
  search.oninput();
  assert.match(host.querySelector('.or-list').textContent, /No model matches/);
  search.value = '';
  search.oninput();
  button('Free only').click();
});

await t('choosing a model keeps the key from signing in, and changes only the model', async () => {
  const qwen = [...host.querySelectorAll('.or-row')].find((r) => /qwen/.test(r.textContent));
  qwen.click();
  await tick(20);
  assert.deepEqual(calls.at(-1), ['setLlm', 'openrouter', '', 'qwen/qwen3-235b:free', '']);
  assert.match(host.textContent, /qwen\/qwen3-235b:free/);
});

await t('signing out forgets the key, and says where to cancel it for good', async () => {
  button('Sign out').click();
  await tick(20);
  assert.deepEqual(calls.at(-1), ['clearLlm', 'openrouter']);
  assert.match(document.body.textContent, /openrouter\.ai\/keys/);
});

console.log('\nthe native side');

await t('the bridge signs in in the browser, keeps the key, and lists models without one', () => {
  const bridge = read('app/src/main/java/com/grimoire/ereader/TranslateBridge.java');
  assert.match(bridge, /public void connectOpenRouter\(final String requestId\)/);
  assert.match(bridge, /public void cancelOpenRouter\(\)/);
  assert.match(bridge, /public void openRouterModels\(final String requestId\)/);
  assert.match(bridge, /putString\("llm_key_" \+ LlmTranslator\.OPENROUTER, key\)/);
  assert.match(bridge, /out\.put\("llmLinked"/);
  // Waiting for the browser must not hold up translation.
  const connect = bridge.slice(bridge.indexOf('public void connectOpenRouter('), bridge.indexOf('public void cancelOpenRouter('));
  assert.match(connect, /new Thread\(/);
  assert.ok(!/io\.execute/.test(connect));
  const llm = read('app/src/main/java/com/grimoire/ereader/LlmTranslator.java');
  assert.match(llm, /OPENROUTER_BASE = "https:\/\/openrouter\.ai\/api\/v1"/);
  const manifest = read('app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:scheme="quire" android:host="back"/);
  const main = read('app/src/main/java/com/grimoire/ereader/MainActivity.java');
  assert.match(main, /"quire"\.equals\(data\.getScheme\(\)\)/, 'Back to Quire would be taken for a book');
});

console.log(`\n${pass} assertions passed`);
