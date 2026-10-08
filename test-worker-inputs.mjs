// Worker input surfaces that no other suite could reach: the Alt+F command
// handler (chrome.commands.onCommand) and the context-menu handler
// (chrome.contextMenus.onClicked). Both are registered behind optional
// chaining, so mock harnesses that omit those APIs silently skip them —
// this file supplies them and exercises every branch.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = {};
const listeners = { installed: [], message: [], committed: [], historyStateUpdated: [], created: [], updated: [], removed: [], command: [], menu: [] };
const tabActions = [];
const tabInfo = new Map();

globalThis.chrome = {
  storage: { local: {
    async get(key) { const keys = Array.isArray(key) ? key : [key]; return Object.fromEntries(keys.filter((item) => item in store).map((item) => [item, structuredClone(store[item])])); },
    async set(value) { Object.assign(store, structuredClone(value)); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete store[item]; }
  } },
  runtime: { id: 'test', getURL(p) { return `chrome-extension://test/${p}`; },
    onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
    onMessage: { addListener(fn) { listeners.message.push(fn); } } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  search: { async query() {} },
  commands: { onCommand: { addListener(fn) { listeners.command.push(fn); } } },
  contextMenus: {
    onClicked: { addListener(fn) { listeners.menu.push(fn); } },
    async removeAll() {}, async create() {}
  },
  webNavigation: { onCommitted: { addListener(fn) { listeners.committed.push(fn); } }, onHistoryStateUpdated: { addListener(fn) { listeners.historyStateUpdated.push(fn); } } },
  windows: { async update() {} },
  tabs: {
    onCreated: { addListener(fn) { listeners.created.push(fn); } },
    onUpdated: { addListener(fn) { listeners.updated.push(fn); } },
    onRemoved: { addListener(fn) { listeners.removed.push(fn); } },
    async query() { return [...tabInfo.values()].map((t) => structuredClone(t)); },
    async get(id) { const t = tabInfo.get(id); if (!t) throw new Error('No tab'); return structuredClone({ id, windowId: 1, ...t }); },
    async update(id, patch) { const next = { ...(tabInfo.get(id) || { id, windowId: 1 }), ...patch }; tabInfo.set(id, next); tabActions.push(['update', id, patch]); },
    async create(info) { const id = 900 + tabInfo.size; tabInfo.set(id, { id, windowId: 1, ...info }); tabActions.push(['create', info]); return { id, ...info }; },
    async remove(id) { tabActions.push(['remove', id]); }
  }
};
globalThis.ServiceWorkerGlobalScope = class {};
globalThis.self = new globalThis.ServiceWorkerGlobalScope();

await import('./background/service-worker.js');
const { clearStateCache } = await import('./shared/state.js');
const handler = listeners.message[0];
async function send(message, tab) {
  const sender = tab ? { id: 'test', tab, url: `https://page.test/${tab.id}` } : { id: 'test', url: 'chrome-extension://test/dashboard/index.html' };
  return await new Promise((resolve, reject) => handler(message, sender, (r) => r?.error ? reject(new Error(r.error)) : resolve(r)));
}
function session() { return store.intentGroveState.sessions.find((s) => s.id === store.intentGroveState.activeSessionId); }
const settle = () => new Promise((r) => setTimeout(r, 60));

assert.equal(listeners.command.length, 1, 'the toggle-mission command listener must be registered');
assert.equal(listeners.menu.length, 1, 'the context-menu click listener must be registered');

await test('Alt+F starts a mission from the active tab when none is running', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); tabInfo.set(1, { id: 1, windowId: 1, url: 'https://article.example/deep-dive', title: 'A long article' });
  await listeners.command[0]('toggle-mission');
  await settle();
  assert.equal(session().mission, 'A long article', 'mission is named after the active tab title');
  assert.equal(session().origin.url, 'https://article.example/deep-dive', 'origin is the tab the shortcut fired on');
});

await test('Alt+F names browser new tabs "New Tab" instead of an internal URL', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); tabInfo.set(2, { id: 2, windowId: 1, url: 'chrome://newtab', title: '' });
  await listeners.command[0]('toggle-mission');
  await settle();
  assert.equal(session().mission, 'New Tab', 'a new-tab placeholder must not become the mission name');
});

await test('Alt+F ends the running mission (toggle)', async () => {
  await listeners.command[0]('toggle-mission');
  await settle();
  const ended = store.intentGroveState.sessions.at(-1);
  assert.equal(ended.status, 'completed');
  assert.equal(ended.endReason, 'user_ended');
  assert.equal(store.intentGroveState.activeSessionId, null);
});

await test('Alt+F ignores unrelated commands and missing tabs', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); // no active tab at all
  await listeners.command[0]('some-other-command');
  await listeners.command[0]('toggle-mission');
  await settle();
  assert.equal(store.intentGroveState.sessions.length, 0, 'no mission may be created without an active tab');
});

await test('context menu: start mission from a link targets the link, and only navigates when needed', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); tabInfo.set(3, { id: 3, windowId: 1, url: 'https://blog.example/post', title: 'Blog post' });
  tabActions.length = 0;
  await listeners.menu[0]({ menuItemId: 'intent-grove-start', linkUrl: 'https://target.example/guide', selectionText: '  Reading the guide  ' }, { id: 3, windowId: 1, url: 'https://blog.example/post', title: 'Blog post' });
  await settle();
  assert.equal(session().mission, 'Reading the guide', 'selection text becomes the mission, trimmed and compacted');
  assert.equal(session().origin.url, 'https://target.example/guide', "a link's mission targets the link destination, not the host page");
  assert.deepEqual(tabActions.at(-1), ['update', 3, { url: 'https://target.example/guide' }], 'the tab is navigated to the link target');

  // Same-URL case: no redundant reload of the page the tab already shows.
  tabActions.length = 0;
  await listeners.menu[0]({ menuItemId: 'intent-grove-start', linkUrl: 'https://target.example/guide' }, { id: 3, windowId: 1, url: 'https://target.example/guide', title: 'Guide' });
  await settle();
  assert.equal(tabActions.some((a) => a[0] === 'update'), false, 'starting from a link the tab already shows must not reload it');
});

await test('context menu: start mission from the page falls back to the page title', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); tabInfo.set(4, { id: 4, windowId: 1, url: 'https://docs.example/intro', title: 'Documentation intro' });
  await listeners.menu[0]({ menuItemId: 'intent-grove-start' }, { id: 4, windowId: 1, url: 'https://docs.example/intro', title: 'Documentation intro' });
  await settle();
  assert.equal(session().mission, 'Documentation intro');
  assert.equal(session().origin.url, 'https://docs.example/intro');
});

await test('context menu: save-for-later handles links and pages distinctly', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); tabInfo.set(5, { id: 5, windowId: 1, url: 'https://reader.example/now', title: 'Reading now' });
  await send({ type: 'START_MISSION', mission: 'Compost menu probe', tab: { id: 5, url: 'https://reader.example/now', title: 'Reading now' } });
  // A LINK target is saved without touching the tab's own node.
  await listeners.menu[0]({ menuItemId: 'intent-grove-compost', linkUrl: 'https://later.example/article', linkText: 'An article for later' }, { id: 5, windowId: 1, url: 'https://reader.example/now', title: 'Reading now' });
  await settle();
  let items = store.intentGroveState.compostItems;
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://later.example/article');
  assert.equal(items[0].title, 'An article for later');
  // The PAGE itself: saves and composts the tab's current node.
  await listeners.menu[0]({ menuItemId: 'intent-grove-compost' }, { id: 5, windowId: 1, url: 'https://reader.example/now', title: 'Reading now' });
  await settle();
  items = store.intentGroveState.compostItems;
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://reader.example/now', 'newest save first');
  const node = session().nodes.find((n) => n.url === 'https://reader.example/now');
  assert.equal(node.state, 'composted', 'composting the page composts its node');
});

await test('context menu: end mission completes the garden', async () => {
  await listeners.menu[0]({ menuItemId: 'intent-grove-end' }, { id: 5, windowId: 1, url: 'https://reader.example/now', title: 'Reading now' });
  await settle();
  assert.equal(store.intentGroveState.activeSessionId, null);
  assert.equal(store.intentGroveState.sessions.at(-1).endReason, 'user_ended');
});

await test('context menu: unknown items are ignored; unsafe page URLs are sanitized, never persisted', async () => {
  clearStateCache();
  await send({ type: 'CLEAR_DATA' });
  tabInfo.clear(); tabInfo.set(6, { id: 6, windowId: 1, url: 'https://safe.example/x', title: 'Safe' });
  await listeners.menu[0]({ menuItemId: 'something-else' }, { id: 6, windowId: 1, url: 'https://safe.example/x', title: 'Safe' });
  await settle();
  assert.equal(store.intentGroveState.sessions.length, 0, 'unknown menu items must do nothing');
  // A blank selection on a page with an unsafe URL still plants (the menu is
  // always available), but the origin must sanitize to the new-tab placeholder.
  await listeners.menu[0]({ menuItemId: 'intent-grove-start', selectionText: '   ' }, { id: 6, windowId: 1, url: 'javascript:alert(1)', title: '' });
  await settle();
  assert.equal(store.intentGroveState.sessions.length, 1);
  assert.equal(session().origin.url, 'chrome://newtab', 'unsafe page URLs must fall back to the new-tab placeholder');
  assert.ok(!JSON.stringify(store.intentGroveState).includes('javascript:'), 'no unsafe scheme may be persisted anywhere');
});

await test('chip-position surface rejects hostile payloads and never trusts sender-provided identity', async () => {
  const tab = { id: 77, url: 'https://host.example/page' };
  assert.equal(await send({ type: 'SET_CHIP_POS', x: '12', y: 3 }, tab), null, 'string coordinates must fail schema validation');
  assert.equal(await send({ type: 'SET_CHIP_POS', x: NaN, y: 3 }, tab), null, 'NaN must fail validation');
  assert.equal(await send({ type: 'SET_CHIP_POS', x: Infinity, y: 3 }, tab), null, 'Infinity must fail validation');
  assert.equal(await send({ type: 'SET_CHIP_POS', x: 3 }, tab), null, 'a missing coordinate must fail validation');
  assert.equal(await send({ type: 'SET_CHIP_POS', x: { valueOf: () => 5 }, y: 3 }, tab), null, 'object coordinates must fail validation');
  assert.equal(await send({ type: 'SET_CHIP_POS', x: [4, 5], y: 3 }, tab), null, 'array coordinates must fail validation');
  assert.equal(await send({ type: 'GET_CHIP_POS' }, { id: 77, url: 'chrome://settings/' }), null, 'non-http sender tabs must be refused');
  assert.equal(await send({ type: 'GET_CHIP_POS' }), null, 'extension-page senders without a tab must be refused');
  assert.equal(await send({ type: 'SET_CHIP_POS', x: 5, y: 5 }), null, 'saves without a sender tab must be refused');
  const hostile = { type: 'SET_CHIP_POS', x: 1e9, y: -1e9 };
  Object.defineProperty(hostile, '__proto__', { value: { polluted: true }, enumerable: false });
  assert.deepEqual(await send(hostile, tab), { saved: true }, 'extreme finite coordinates must be accepted and clamped');
  assert.deepEqual(await send({ type: 'GET_CHIP_POS' }, tab), { x: 32767, y: 0 }, 'stored coordinates must be clamped into screen bounds');
  assert.equal({}.polluted, undefined, 'chip-position handling must not pollute prototypes');
  await listeners.removed[0](77);
  assert.equal(await send({ type: 'GET_CHIP_POS' }, tab), null, 'closing the tab must clear its chip position even in fallback mode');
});

await test('return-to-mission command reuses the validated go-home flow', async () => {
  await send({ type: 'CLEAR_DATA' });
  tabInfo.set(55, { id: 55, url: 'https://origin.example/start', title: 'Start', windowId: 1 });
  await send({ type: 'START_MISSION', mission: 'Command return probe', tab: { id: 55, url: 'https://origin.example/start', title: 'Start' } });
  await listeners.command[0]('return-to-mission');
  await settle();
  const activated = tabActions.filter((entry) => entry[0] === 'update' && entry[1] === 55);
  assert.ok(activated.length >= 1, 'the command must activate the validated origin tab');
});

await test('new settings keys survive hostile UPDATE_SETTINGS payloads', async () => {
  await send({ type: 'UPDATE_SETTINGS', settings: { strictMode: 'yes', ramGuard: 0, ramGuardLevel: 'many', gentleDepth: 4, choiceDepth: 5 } });
  const snap = await send({ type: 'GET_SNAPSHOT' });
  assert.equal(snap.settings.strictMode, false, 'strict mode requires an explicit true');
  assert.equal(snap.settings.ramGuard, true, 'only an explicit false opts out of the guardian');
  assert.equal(snap.settings.ramGuardLevel, 3, 'a non-numeric sensitivity falls back to the default');
});

await test('path-pattern summaries are limited to extension pages and return aggregates only', async () => {
  await send({ type: 'CLEAR_DATA' });
  const result = await send({ type: 'GET_PATH_PATTERN_ANALYSIS' });
  assert.deepEqual(result.patterns, { branching: 0, straightThrough: 0, searchRefining: 0, revisiting: 0 });
  assert.equal(result.sampleSize, 0);
  assert.equal(Object.hasOwn(result, 'sessions'), false, 'analysis must not return individual browsing sessions');
  assert.equal(Object.hasOwn(result, 'domains'), false, 'analysis must not return domain data');
  assert.equal(await send({ type: 'GET_PATH_PATTERN_ANALYSIS' }, { id: 77, url: 'https://host.example/page' }), null,
    'ordinary web pages must not request dashboard path-pattern summaries');
});

console.log('test-worker-inputs.mjs: command + context-menu surfaces passed');
