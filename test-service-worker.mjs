import assert from 'node:assert/strict';
import { MEMORY_LIMITS, SERVICE_WORKER } from './shared/constants.js';
import { test } from 'node:test';

const store = {};
const sessionStore = {};
const messages = [];
const tabActions = [];
const searchActions = [];
const windowActions = [];
const syncWrites = [];
const tabInfo = new Map();
const listeners = { installed: [], message: [], updated: [], removed: [], created: [], startup: [], committed: [], historyStateUpdated: [] };
const alarms = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(key) { const keys = Array.isArray(key) ? key : [key]; return Object.fromEntries(keys.filter((item) => item in store).map((item) => [item, structuredClone(store[item])])); },
      async set(value) { Object.assign(store, structuredClone(value)); },
      async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete store[item]; }
    },
    session: {
      async get(key) { return key in sessionStore ? { [key]: structuredClone(sessionStore[key]) } : {}; },
      async set(value) { Object.assign(sessionStore, structuredClone(value)); }
    },
    sync: { async set(value) { syncWrites.push(structuredClone(value)); } }
  },
  runtime: {
    id: 'test',
    getURL(path) { return `chrome-extension://test/${path}`; },
    onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
    onMessage: { addListener(fn) { listeners.message.push(fn); } },
    onStartup: { addListener(fn) { listeners.startup.push(fn); } }
  },
  alarms: { create(name, info) { alarms.push([name, info]); }, onAlarm: { addListener(fn) { listeners.alarm = fn; } } },
  search: { async query(info) { searchActions.push(info); } },
  webNavigation: { onCommitted: { addListener(fn) { listeners.committed.push(fn); } }, onHistoryStateUpdated: { addListener(fn) { listeners.historyStateUpdated.push(fn); } } },
  windows: { async update(id, patch) { windowActions.push(['update', id, patch]); } },
  tabs: {
    onCreated: { addListener(fn) { listeners.created.push(fn); } },
    onUpdated: { addListener(fn) { listeners.updated.push(fn); } },
    onRemoved: { addListener(fn) { listeners.removed.push(fn); } },
    async query() { return [...tabInfo.values()].map((tab) => structuredClone(tab)); },
    async remove(id) { tabActions.push(['remove', id]); },
    async get(id) { const tab = tabInfo.get(id); if (!tab) throw new Error('No tab'); return structuredClone({ id, windowId: 1, ...tab }); },
    async update(id, patch) { const next = { ...(tabInfo.get(id) || { id, windowId: 1 }), ...patch }; tabInfo.set(id, next); tabActions.push(['update', id, patch]); },
    async create(info) { const id = 99 + tabInfo.size; tabInfo.set(id, { id, windowId: 1, ...info }); tabActions.push(['create', info]); return { id, ...info }; }
  }
};
globalThis.ServiceWorkerGlobalScope = class {};
globalThis.self = new globalThis.ServiceWorkerGlobalScope();

await import('./background/service-worker.js');
assert.deepEqual(alarms, [['storageQuotaCheck', { periodInMinutes: 5 }]], 'service worker should register persistent quota maintenance');
const handler = listeners.message[0];
async function rawSend(message, sender) {
  return await new Promise((resolve, reject) => handler(message, sender, (response) => response?.error ? reject(new Error(response.error)) : resolve(response)));
}
async function send(message, tab = undefined) {
  if (tab?.id != null) { const current = { ...(tabInfo.get(tab.id) || {}), windowId: 1, ...tab }; if (message?.type === 'OBSERVE_PAGE' && typeof message.url === 'string') { current.url = message.url; current.title = message.title || current.title; } tabInfo.set(tab.id, current); }
  const sender = tab ? { id: 'test', tab, url: `https://page.test/${tab.id}` } : { id: 'test', url: 'chrome-extension://test/dashboard/index.html' };
  return rawSend(message, sender);
}
assert.equal(await rawSend({ type: 'CLEAR_DATA' }, undefined), null, 'missing sender must be rejected without throwing');
assert.equal(await rawSend({ type: 'toString' }, { id: 'test', url: 'chrome-extension://test/dashboard/index.html' }), null, 'inherited property names must not be accepted as message types');
const inheritedMessage = Object.create({ type: 'CLEAR_DATA' });
assert.equal(await rawSend(inheritedMessage, { id: 'test', url: 'chrome-extension://test/dashboard/index.html' }), null, 'inherited message fields must not bypass own-property validation');
function session() { return store.intentGroveState.sessions.find((s) => s.id === store.intentGroveState.activeSessionId); }

// Chromium forks keep the chrome.* extension API and chrome-extension:// sender origin,
// but expose their own new-tab placeholders (chrome://, brave://, edge://, opera://, vivaldi://).
const chromiumNewTabs = [
  'chrome://newtab', 'chrome://new-tab-page', 'brave://newtab', 'brave://newtab/',
  'edge://newtab', 'opera://startpage', 'vivaldi://newtab', 'chrome://vivaldi-webui/startpage'
];
for (const newTabUrl of chromiumNewTabs) {
  await send({ type: 'START_MISSION', mission: 'Research in Chromium', tab: { id: 801, url: newTabUrl, title: 'New Tab' } });
  assert.equal(session().origin.url, newTabUrl, `${newTabUrl} should survive validation as a new-tab placeholder`);
  await send({ type: 'OBSERVE_PAGE', url: 'chrome://settings', title: 'Settings' }, { id: 801 });
  assert.equal(session().origin.url, newTabUrl, 'restricted browser pages must not become the mission origin');
  await send({ type: 'OBSERVE_PAGE', url: 'https://search.brave.com/search?q=trees', title: 'Search' }, { id: 801 });
  assert.equal(session().nodes.length, 1, 'the first ordinary page replaces the placeholder, not an extra branch');
  assert.equal(session().nodes[0].depth, 0);
  assert.equal(session().origin.url, 'https://search.brave.com/search?q=trees');
  await send({ type: 'LINK_CLICK', url: 'https://example.com/trees', title: 'Trees' }, { id: 801 });
  await send({ type: 'OBSERVE_PAGE', url: 'https://example.com/trees', title: 'Trees' }, { id: 801 });
  assert.equal(session().nodes.at(-1).depth, 1, 'a link from the first page should grow exactly one branch');
  await send({ type: 'CLEAR_DATA' });
}
tabInfo.delete(801);

await send({ type: 'START_MISSION', mission: 'Find a good laptop to buy.', tab: { id: 7, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
assert.ok(Array.isArray(session().activeIntervals), 'sessions should track active-tab intervals');
await send({ type: 'OBSERVE_PAGE', url: 'https://example.com', title: 'Origin' }, { id: 7, openerTabId: undefined });
assert.equal(session().nodes[0].depth, 0, 'first ordinary page must become depth 0');
assert.equal(session().origin.tabId, 7, 'origin tab must be remembered');
const activeView = await send({ type: 'GET_ACTIVE_VIEW' }, { id: 7 });
assert.equal(activeView.session.mission, 'Find a good laptop to buy.', 'active view should carry the current mission');
assert.equal(activeView.session.node.depth, 0, 'active view should carry only the current node depth');
assert.equal('nodes' in activeView.session, false, 'active view should not serialize full branch history to page scripts');
assert.equal((await send({ type: 'GET_ACTIVE_VIEW' }, { id: 88 })).session, null, 'untracked tabs should not receive a mission chip view');
await send({ type: 'SPA_NAVIGATION', url: 'https://example.com/route', title: 'Route' }, { id: 7 });
assert.equal(session().nodes.at(-1).navigationKind, 'spa', 'history-state route changes should create SPA branches');
const spaCount = session().nodes.length;
await send({ type: 'SPA_NAVIGATION', url: 'https://example.com/route', title: 'Route' }, { id: 7 });
assert.equal(session().nodes.length, spaCount, 'duplicate SPA route observations should not grow the garden twice');
await send({ type: 'SPA_NAVIGATION', url: 'https://example.com/route', title: 'Updated route title' }, { id: 7 });
assert.equal(session().nodes.at(-1).title, 'Updated route title', 'same-URL SPA title changes should update the existing node');

await send({ type: 'CLEAR_DATA' });
	tabInfo.clear();
	tabInfo.set(11, { id: 11, windowId: 1, url: 'chrome-extension://test/newtab/index.html', title: 'Intent Grove' });
	await send({ type: 'START_MISSION', mission: 'Use browser default', openSearch: true, tab: { url: 'chrome-extension://test/newtab/index.html', title: 'Intent Grove' } });
	assert.deepEqual(searchActions.at(-1), { text: 'Use browser default', tabId: 11 }, 'Browser default should use the browser search provider API');
	await send({ type: 'CLEAR_DATA' });
	await send({ type: 'UPDATE_SETTINGS', settings: { searchEngine: 'brave' } });
	await send({ type: 'START_MISSION', mission: 'Find quiet study music', openSearch: true, tab: { url: 'chrome-extension://test/newtab/index.html', title: 'Intent Grove' } });
assert.equal(tabActions.at(-1)?.[0], 'update', 'planting from New Tab should navigate the active browser tab');
assert.equal(tabActions.at(-1)?.[1], 11);
	assert.match(tabActions.at(-1)?.[2]?.url || '', /search\.brave\.com\/search\?q=Find%20quiet%20study%20music/, 'planting should open the selected search engine for the mission');
	await send({ type: 'PAUSE_SITE' }, { id: 11, url: 'https://search.brave.com/search?q=Find%20quiet%20study%20music', title: 'Search' });
	assert.deepEqual((await send({ type: 'GET_SNAPSHOT' })).settings.excludedSites, ['search.brave.com'], 'the companion can pause itself on the current site');

await send({ type: 'OBSERVE_PAGE', url: 'https://unrelated.example', title: 'Unrelated' }, { id: 88 });
assert.equal(session().nodes.length, 1, 'unrelated tabs must not become branches');

for (const [i, path] of ['/battery', '/mines', '/bolivia', '/inca', '/weapons'].entries()) {
  const url = `https://example.com${path}`;
  await send({ type: 'LINK_CLICK', url, title: path, targetBlank: false }, { id: 11 });
  await send({ type: 'OBSERVE_PAGE', url, title: path }, { id: 11 });
  assert.equal(session().nodes.at(-1).depth, i + 1, `link ${path} should create depth ${i + 1}`);
}
assert.equal(Math.max(...session().nodes.map((n) => n.depth)), 5, 'five links should reach interruption depth');
assert.equal(session().nodes.at(-1).state, 'interrupted', 'depth 5 should be interrupted');
assert.equal(session().nodes.slice(0, -1).some((node) => node.tabIds?.includes(7)), false, 'a navigating tab should not remain attached to historical nodes');

await send({ type: 'COMPOST', url: 'https://example.com/weapons', title: 'Weapons' }, { id: 11 });
assert.equal(store.intentGroveState.schemaVersion, 4, 'state should use the current compact schema');
assert.equal('transitions' in session(), false, 'nodes should be the only branch relationship source');
assert.equal(store.intentGroveState.compostItems.length, 1, 'compost should save one item');
assert.equal(tabActions.some((action) => action[0] === 'remove' && action[1] === 7), false, 'compost must not close the current tab');

await send({ type: 'CLEAR_DATA' });
tabActions.length = 0;
await send({ type: 'START_MISSION', mission: 'First mission', tab: { id: 7, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'START_MISSION', mission: 'Research history', missionNote: 'Understand the roots before choosing a direction.', tab: { id: 9, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
assert.equal(session().note, 'Understand the roots before choosing a direction.', 'mission note should be stored with the active garden');
assert.equal(store.intentGroveState.sessions[0].status, 'completed', 'starting a new mission should complete the prior garden');
assert.equal(store.intentGroveState.sessions[0].endReason, 'mission_changed', 'prior garden should record the reason for change');
await send({ type: 'CLEAR_DATA' });
tabActions.length = 0;
await send({ type: 'START_MISSION', mission: 'Research history', tab: { id: 7, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example', title: 'History' }, { id: 7 });
const beforeDuplicate = session().nodes.length;
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example', title: 'History duplicate' }, { id: 8, openerTabId: 7 });
assert.equal(session().nodes.length, beforeDuplicate, 'duplicate tab should reuse the known path');
assert.equal(session().nodes.find((node) => node.url === 'https://history.example/').tabIds.includes(8), true, 'known path should attach duplicate tab alias');
const beforeNewTab = session().nodes.length;
await send({ type: 'LINK_CLICK', url: 'https://history.example/inca', title: 'Inca', targetBlank: true }, { id: 7 });
assert.equal(session().nodes.length, beforeNewTab, 'new-tab click should wait for the destination tab before adding a node');
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example/inca', title: 'Inca' }, { id: 8, openerTabId: 7 });
assert.equal(session().nodes.at(-1).depth, 1, 'new tab link should inherit source depth');
const beforeRedirect = session().nodes.length;
await send({ type: 'LINK_CLICK', url: 'https://search.example/redirect?target=https%3A%2F%2Fhistory.example%2Ffinal', title: 'Redirect', targetBlank: false }, { id: 7 });
await send({ type: 'OBSERVE_PAGE', url: 'https://search.example/redirect?target=https%3A%2F%2Fhistory.example%2Ffinal', title: 'Redirect' }, { id: 7 });
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example/final', title: 'Final' }, { id: 7 });
assert.equal(session().nodes.length, beforeRedirect + 1, 'redirect journey should resolve to one branch node');
const beforeMultiHop = session().nodes.length;
await send({ type: 'LINK_CLICK', url: 'https://search.example/url?target=https%3A%2F%2Fsearch.example%2Fredirect%3Fdest%3Dhttps%253A%252F%252Fhistory.example%252Fdeep', title: 'Multi-hop result', targetBlank: false }, { id: 7 });
await send({ type: 'OBSERVE_PAGE', url: 'https://search.example/url?target=https%3A%2F%2Fsearch.example%2Fredirect%3Fdest%3Dhttps%253A%252F%252Fhistory.example%252Fdeep', title: 'Transport one' }, { id: 7 });
await send({ type: 'OBSERVE_PAGE', url: 'https://search.example/redirect?dest=https%3A%2F%2Fhistory.example%2Fdeep', title: 'Transport two' }, { id: 7 });
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example/deep', title: 'Final destination' }, { id: 7 });
assert.equal(session().nodes.length, beforeMultiHop + 1, 'multi-hop redirect should resolve to one branch node');
assert.equal(session().nodes.at(-1).relationshipConfidence, 'direct', 'resolved redirect should remain a direct structural branch');
assert.equal(session().pendingRedirects.length, 0, 'resolved redirect should clear pending transport state');
const pruneTarget = session().nodes.find((node) => node.depth === 1);
const beforePruneNodes = session().nodes.length;
await send({ type: 'PRUNE_NODE', sessionId: session().id, nodeId: pruneTarget.id, toCompost: true });
assert.equal(session().nodes.length, beforePruneNodes, 'pruning should preserve the historical node');
assert.equal(session().nodes.find((node) => node.id === pruneTarget.id).state, 'pruned', 'pruning should mark the node without deleting it');
assert.equal(store.intentGroveState.compostItems.some((item) => item.url === pruneTarget.url), true, 'returning a branch to compost should save its canonical path');
const prunedCount = session().nodes.length;
await send({ type: 'OBSERVE_PAGE', url: pruneTarget.url, title: 'Pruned path' }, { id: 61 });
assert.equal(session().nodes.length, prunedCount, 'a pruned path must not become an active known-path alias again');
const eventCountBeforeInvalidPrune = session().events.length;
await send({ type: 'PRUNE_NODE', sessionId: 'not-this-session', nodeId: pruneTarget.id, toCompost: true });
assert.equal(session().events.length, eventCountBeforeInvalidPrune, 'cross-session prune requests must not mutate the garden');
await send({ type: 'UPDATE_SETTINGS', settings: { gentleDepth: 2, choiceDepth: 3 } });
assert.equal((await send({ type: 'GET_SNAPSHOT' })).thresholds.DESATURATE, 2, 'gentle depth should be locally configurable');
await send({ type: 'UPDATE_SETTINGS', settings: { gentleDepth: 99, choiceDepth: 0 } });
const clamped = await send({ type: 'GET_SNAPSHOT' });
assert.equal(clamped.thresholds.DESATURATE, 8, 'gentle depth should clamp to the safe maximum');
assert.equal(clamped.thresholds.INTERRUPT, 9, 'choice depth should remain one step after the gentle threshold');
await send({ type: 'OBSERVE_PAGE', url: 'https://unlinked.example', title: 'Unlinked' }, { id: 7 });
assert.equal(session().nodes.at(-1).depth, 0, 'manual or external navigation should remain neutral');
const nodeCountBeforeReturn = session().nodes.length;
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example', title: 'History again' }, { id: 7 });
assert.equal(session().nodes.length, nodeCountBeforeReturn, 'returning to a known URL should reuse its node');
listeners.committed[0]?.({ frameId: 0, tabId: 7, transitionType: 'back_forward', transitionQualifiers: [] });
await send({ type: 'OBSERVE_PAGE', url: 'https://history.example', title: 'History back' }, { id: 7 });
assert.equal(session().nodes.find((node) => node.url === 'https://history.example/').confidence, 'low', 'back/forward returns should be low confidence');
await send({ type: 'GO_HOME' });
assert.equal(tabActions.some((a) => a[0] === 'remove'), false, 'Go Home must not close tracked tabs automatically');
const goHomeUpdate = tabActions.findLast((a) => a[0] === 'update' && a[1] === 7);
assert(goHomeUpdate, 'Go Home should activate origin tab');
assert.equal(goHomeUpdate[2].active, true, 'Go Home should activate the origin tab');
assert.equal(goHomeUpdate[2].url, undefined, 'Go Home must not re-navigate a tab already on the origin URL (that would reload the page and lose scroll/state)');
await send({ type: 'END_MISSION', reason: 'user_ended' });
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Search root test', tab: { id: 7, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://search.example/search?q=focus', title: 'Search results' }, { id: 7 });
assert.equal(session().nodes[0].depth, 0, 'directly opened search page should remain a neutral root');
await send({ type: 'END_MISSION', reason: 'user_ended' });
assert.equal((await send({ type: 'GET_SNAPSHOT' })).session, null, 'completed mission should not reappear as active page state');
assert.equal((await send({ type: 'GET_SNAPSHOT', includeHistory: true })).session.mission, 'Search root test', 'dashboard history should expose the latest completed garden');
assert.equal(store.intentGroveState.sessions.length <= 12, true, 'session history should remain bounded');
assert.equal(store.intentGroveState.sessions.at(-1).events.length <= 72, true, 'event history should remain bounded');
const forgetId = store.intentGroveState.sessions.at(-1).id;
await send({ type: 'DELETE_SESSION', sessionId: forgetId });
assert.equal(store.intentGroveState.sessions.some((item) => item.id === forgetId), false, 'selected garden should be deletable without clearing all history');

await send({ type: 'START_MISSION', mission: 'Boundary safety', tab: { id: 31, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://safe.example', title: 'Safe' }, { id: 31 });
const safeNodeCount = session().nodes.length; const safeCompostCount = store.intentGroveState.compostItems.length; const safeEvents = session().events.length;
await send({ type: 'OBSERVE_PAGE', url: 'javascript:alert(1)', title: 'Unsafe' }, { id: 31 });
await send({ type: 'LINK_CLICK', url: 'data:text/html,<script>alert(1)</script>', title: 'Unsafe', targetBlank: false }, { id: 31 });
await send({ type: 'COMPOST', url: 'javascript:alert(1)', title: 'Unsafe' }, { id: 31 });
assert.equal(session().nodes.length, safeNodeCount, 'unsafe URL schemes must not create nodes');
assert.equal(store.intentGroveState.compostItems.length, safeCompostCount, 'unsafe URL schemes must not create compost items');
assert.equal(session().events.length, safeEvents, 'unsafe URL schemes must not create navigation events');
const beforeInvalidMutation = JSON.stringify(store.intentGroveState);
await send({ type: 'PRUNE_NODE', sessionId: 'bad.id', nodeId: 'bad.id', toCompost: true });
assert.equal(JSON.stringify(store.intentGroveState), beforeInvalidMutation, 'invalid identifiers must not mutate state');
await send({ type: 'LINK_CLICK', title: 'Missing URL', targetBlank: false }, { id: 31 });
assert.equal(JSON.stringify(store.intentGroveState), beforeInvalidMutation, 'messages missing required fields must not mutate state');
await send({ type: 'CLEAR_DATA' }, { id: 31 });
assert.equal(JSON.stringify(store.intentGroveState), beforeInvalidMutation, 'content-script senders must not clear all local data');
assert.equal(await send({ type: 'GET_SNAPSHOT' }, { id: 31 }), null, 'content-script senders must not receive the full garden snapshot');
await send({ type: 'UPDATE_SETTINGS', settings: { gentleDepth: 1, choiceDepth: 2 } }, { id: 31 });
const protectedSettings = await send({ type: 'GET_SNAPSHOT' });
assert.equal(protectedSettings.thresholds.DESATURATE, 4, 'content-script senders must not alter global settings');
await Promise.all([send({ type: 'UPDATE_SETTINGS', settings: { gentleDepth: 3, choiceDepth: 4 } }), send({ type: 'UPDATE_SETTINGS', settings: { gentleDepth: 5, choiceDepth: 6 } })]);
const concurrentSnapshot = await send({ type: 'GET_SNAPSHOT' });
assert.equal(concurrentSnapshot.thresholds.INTERRUPT >= concurrentSnapshot.thresholds.DESATURATE + 1, true, 'concurrent settings updates must preserve threshold ordering');
await listeners.removed[0](31);
tabActions.length = 0;
await send({ type: 'GO_HOME' });
assert.equal(tabActions.some((action) => action[0] === 'update'), false, 'stale origin removal must not target a reused tab');
assert.equal(tabActions.some((action) => action[0] === 'create' && action[1].url === 'https://safe.example/'), true, 'stale origin removal should recover with a safe new origin tab');

await assert.doesNotReject(() => send(null), 'null runtime messages must be ignored safely');
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Pending collision', tab: { id: 101, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://origin.example', title: 'Origin' }, { id: 101 });
await send({ type: 'LINK_CLICK', url: 'https://origin.example/a', title: 'A', targetBlank: false }, { id: 101 });
await send({ type: 'OBSERVE_PAGE', url: 'https://origin.example/a', title: 'A' }, { id: 101 });
const aNode = session().nodes.at(-1);
await send({ type: 'OBSERVE_PAGE', url: 'https://origin.example', title: 'Origin' }, { id: 102, openerTabId: 101 });
await send({ type: 'LINK_CLICK', url: 'https://origin.example/b', title: 'B', targetBlank: false }, { id: 102 });
await send({ type: 'OBSERVE_PAGE', url: 'https://origin.example/b', title: 'B' }, { id: 102 });
const bNode = session().nodes.at(-1);
await send({ type: 'LINK_CLICK', url: 'https://shared.example/path', title: 'Shared', targetBlank: true }, { id: 101 });
await send({ type: 'LINK_CLICK', url: 'https://shared.example/path', title: 'Shared', targetBlank: true }, { id: 102 });
const shared = await send({ type: 'OBSERVE_PAGE', url: 'https://shared.example/path', title: 'Shared' }, { id: 101 });
assert.equal(shared.parentId, aNode.id, 'same-destination pending links must retain the source-tab relationship');
assert.notEqual(shared.parentId, bNode.id, 'pending links from another source tab must not overwrite this relationship');
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Alias care', tab: { id: 201, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://alias.example', title: 'Alias' }, { id: 201 });
await send({ type: 'OBSERVE_PAGE', url: 'https://alias.example', title: 'Alias duplicate' }, { id: 202, openerTabId: 201 });
await send({ type: 'COMPOST', url: 'https://alias.example', title: 'Alias' }, { id: 201 });
const closedAliasNode = session().nodes.find((node) => node.url === 'https://alias.example/');
assert.deepEqual(closedAliasNode.tabIds, [], 'composting a path must detach every live tab alias');

await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Reused origin', tab: { id: 300, url: 'https://origin.example/home', title: 'Origin' } });
tabInfo.set(300, { id: 300, windowId: 1, url: 'https://unrelated.example/reused', title: 'Unrelated' });
tabActions.length = 0;
await send({ type: 'GO_HOME' });
assert.equal(tabActions.some((action) => action[0] === 'update' && action[1] === 300), false, 'Go Home must not target an unrelated tab that reused the origin ID');
assert.equal(tabActions.some((action) => action[0] === 'create' && action[1].url === 'https://origin.example/home'), true, 'Go Home should create a safe origin tab when the stored tab identity is stale');
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Redirect reuse', tab: { id: 400, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://redirect-origin.example', title: 'Redirect origin' }, { id: 400 });
await send({ type: 'LINK_CLICK', url: 'https://redirect.example/redirect?target=https%3A%2F%2Ffinal.example', title: 'Redirect', targetBlank: false }, { id: 400 });
assert.equal(session().pendingRedirects.length, 1, 'redirect should create pending state');
await listeners.removed[0](400);
assert.equal(session().pendingRedirects.length, 0, 'tab removal must clear pending redirect state');
const beforeReusedTab = session().nodes.length;
await send({ type: 'OBSERVE_PAGE', url: 'https://reused.example', title: 'Reused tab' }, { id: 400 });
assert.equal(session().nodes.length, beforeReusedTab, 'a reused tab must not inherit a removed tab redirect relationship');
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Other window', tab: { id: 500, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://window-two.example/home', title: 'Window two' }, { id: 500 });
tabInfo.set(500, { id: 500, windowId: 2, url: 'https://window-two.example/home', title: 'Window two' });
tabActions.length = 0; windowActions.length = 0;
await send({ type: 'GO_HOME' });
assert.equal(windowActions.some((action) => action[0] === 'update' && action[1] === 2 && action[2].focused === true), true, 'Go Home should focus the origin window');

// Test node close and reopen lifecycle
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Node close and reopen lifecycle', tab: { id: 600, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://lifecycle.example/first', title: 'First page' }, { id: 600 });
const firstNodeId = session().nodes.at(-1).id;
await send({ type: 'LINK_CLICK', url: 'https://lifecycle.example/second', title: 'Second page', targetBlank: false }, { id: 600 });
await send({ type: 'OBSERVE_PAGE', url: 'https://lifecycle.example/second', title: 'Second page' }, { id: 600 });

// Verify first page node is closed when navigated away
const firstNodeAfterNav = session().nodes.find(n => n.id === firstNodeId);
assert.ok(firstNodeAfterNav.closedAt, 'first page node must be marked as closed after navigating away');

// Return to first page URL and verify node is reopened
await send({ type: 'OBSERVE_PAGE', url: 'https://lifecycle.example/first', title: 'First page again' }, { id: 600 });
const firstNodeAfterReturn = session().nodes.find(n => n.id === firstNodeId);
assert.equal(firstNodeAfterReturn.closedAt, undefined, 'first page node must be reopened (closedAt cleared) when returning to its URL');

// Test import/export roundtrip
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Export import test', tab: { id: 700, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://export.example/page', title: 'Export page' }, { id: 700 });
const exported = await send({ type: 'EXPORT_DATA' });
assert.ok(exported.data, 'export should return data');
assert.equal(exported.data.sessions.length, 1, 'export should contain one session');
assert.equal(exported.data.sessions[0].mission, 'Export import test', 'export should preserve mission');

await send({ type: 'CLEAR_DATA' });
assert.equal((await send({ type: 'GET_SNAPSHOT' })).session, null, 'clearing data should remove active session');

const imported = await send({ type: 'IMPORT_DATA', payload: exported });
assert.ok(imported.imported, 'import should succeed');
const afterImport = await send({ type: 'GET_SNAPSHOT', includeHistory: true });
assert.equal(afterImport.session.mission, 'Export import test', 'import should restore session');
assert.equal(afterImport.session.nodes[0].url, 'https://export.example/page', 'import should restore nodes');

await send({ type: 'COMPLETE_ONBOARDING' });
await send({ type: 'UPDATE_SETTINGS', settings: { ambientMotion: false } });
const importedWithExistingPreferences = await send({
  type: 'IMPORT_DATA',
  payload: { data: { sessions: [], compostItems: [], settings: { ambientMotion: true }, onboardingCompleted: false } }
});
assert.ok(importedWithExistingPreferences.imported, 'import should merge a valid state with existing preferences');
const afterPreferenceImport = await send({ type: 'GET_SNAPSHOT' });
assert.equal(afterPreferenceImport.state.onboardingCompleted, true, 'import must not erase onboarding completion');
assert.equal(afterPreferenceImport.settings.ambientMotion, true, 'import should apply the imported settings explicitly');

// Import merges must be repeatable and persist independently of the worker cache.
await test('import deduplicates sessions and applies incoming record conflicts', async () => {
  await send({ type: 'IMPORT_DATA', payload: exported });
  assert.equal(store.intentGroveState.sessions.length, 1, 'repeat imports must not duplicate sessions');
  const revised = structuredClone(exported);
  revised.data.sessions[0].mission = 'Revised imported mission';
  await send({ type: 'IMPORT_DATA', payload: revised });
  assert.equal(store.intentGroveState.sessions.length, 1);
  assert.equal(store.intentGroveState.sessions[0].mission, 'Revised imported mission');
  assert.equal(store.intentGroveState.activeSessionId, exported.data.activeSessionId);
});

await test('import preserves existing and incoming rewards without duplicating occurrences', async () => {
  const { clearStateCache } = await import('./shared/state.js');
  const now = Date.now();
  const local = { rewardId: 'seed_1', timestamp: now - 2000 };
  const incoming = { rewardId: 'seed_1', timestamp: now - 1000 };
  store.intentGroveState.rewardHistory = [local];
  clearStateCache();
  const payload = { data: { rewardHistory: [local, incoming] } };
  await send({ type: 'IMPORT_DATA', payload });
  assert.deepEqual(store.intentGroveState.rewardHistory, [local, incoming]);
  await send({ type: 'IMPORT_DATA', payload });
  await send({ type: 'IMPORT_DATA', payload: { data: {} } });
  clearStateCache();
  assert.deepEqual((await send({ type: 'EXPORT_DATA' })).data.rewardHistory, [local, incoming],
    'repeat and legacy imports must preserve reward history after a fresh storage read');
});

await test('import reads current state after a queued clear completes', async () => {
  const originalSet = chrome.storage.local.set;
  let releaseWrite;
  let notifyWrite;
  const started = new Promise((resolve) => { notifyWrite = resolve; });
  const blocked = new Promise((resolve) => { releaseWrite = resolve; });
  chrome.storage.local.set = async (value) => {
    notifyWrite();
    await blocked;
    return originalSet(value);
  };
  let clearing;
  let importing;
  try {
    clearing = send({ type: 'CLEAR_DATA' });
    await started;
    importing = send({ type: 'IMPORT_DATA', payload: { data: {} } });
    // Let the import reach the queue while the clear's storage write is held.
    await new Promise((resolve) => setImmediate(resolve));
    releaseWrite();
    await Promise.all([clearing, importing]);
    assert.deepEqual(store.intentGroveState.sessions, [], 'import must not resurrect pre-clear sessions');
    assert.deepEqual(store.intentGroveState.rewardHistory, []);
  } finally {
    releaseWrite();
    await Promise.allSettled([clearing, importing]);
    chrome.storage.local.set = originalSet;
  }
});

// Test onboarding completion
await send({ type: 'CLEAR_DATA' });
const beforeOnboarding = await send({ type: 'GET_SNAPSHOT' });
assert.equal(beforeOnboarding.state.onboardingCompleted, false, 'new state should not have onboarding completed');
await send({ type: 'COMPLETE_ONBOARDING' });
const afterOnboarding = await send({ type: 'GET_SNAPSHOT' });
assert.equal(afterOnboarding.state.onboardingCompleted, true, 'onboarding should be marked as completed');

// Test local settings persistence
await send({ type: 'UPDATE_SETTINGS', settings: { gentleDepth: 6, choiceDepth: 8 } });
const afterSettings = await send({ type: 'GET_SNAPSHOT' });
assert.equal(afterSettings.settings.gentleDepth, 6, 'settings update should persist');
assert.equal(afterSettings.settings.choiceDepth, 8, 'settings update should persist');
assert.equal(syncWrites.length, 0, 'settings must remain local and never mirror to chrome.storage.sync');

await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Read the next chapter', tab: { id: 7, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await send({ type: 'OBSERVE_PAGE', url: 'https://example.com', title: 'Reader' }, { id: 7 });
await send({ type: 'SPA_NAVIGATION', url: 'https://example.com/reader/chapter-2', title: 'Chapter 2' }, { id: 7 });
assert.equal(session().nodes.at(-1).navigationKind, 'spa', 'SPA route changes must be tracked on any ordinary HTTPS domain');
assert.equal(session().nodes.at(-1).depth, 1, 'the first SPA route must grow one branch');
const nodeCountAfterSpa = session().nodes.length;
await send({ type: 'SPA_NAVIGATION', url: 'https://example.com/reader/chapter-2', title: 'Chapter 2' }, { id: 7 });
assert.equal(session().nodes.length, nodeCountAfterSpa, 'duplicate SPA route notifications must be ignored');
await listeners.historyStateUpdated[0]({ frameId: 0, tabId: 7, url: 'https://example.com/reader/chapter-3' });
assert.equal(session().nodes.at(-1).navigationKind, 'spa', 'webNavigation history events must track SPA routes outside the old domain allowlist');
assert.equal(session().nodes.at(-1).url, 'https://example.com/reader/chapter-3');

tabActions.length = 0;
// Loading-phase placeholders must NOT trigger a takeover: while the tab is
// still loading, tab.url transiently reports the browser NTP even when our
// own override is resolving it — acting there races (and aborts) the
// override's own load. This fixture pins the race-free, commit-only contract.
await listeners.updated[0](901, { status: 'loading', url: 'brave://newtab/' }, { id: 901, url: 'brave://newtab/', pendingUrl: 'brave://newtab/' });
assert.equal(tabActions.some((action) => action[0] === 'update' && action[1] === 901), false, 'loading-phase NTP placeholders must not trigger a takeover');
await listeners.updated[0](901, { status: 'complete', url: 'brave://newtab/' }, { id: 901, url: 'brave://newtab/' });
assert.equal(tabActions.some((action) => action[0] === 'update' && action[1] === 901 && action[2].url === 'chrome-extension://test/newtab/index.html'), true, 'Brave dashboard new tabs must be replaced by Intent Grove once committed');
tabActions.length = 0;
// There is deliberately no tabs.onCreated takeover listener (it can only see
// uncommitted/placeholder URLs); committed Chrome NTPs are taken over via
// onUpdated 'complete'.
assert.equal(listeners.created.length, 0, 'no onCreated takeover listener may be registered');
await listeners.updated[0](902, { status: 'complete', url: 'chrome://newtab' }, { id: 902, url: 'chrome://newtab' });
assert.equal(tabActions.some((action) => action[0] === 'update' && action[1] === 902 && action[2].url === 'chrome-extension://test/newtab/index.html'), true, 'Chrome new tabs must be replaced by Intent Grove when the override is skipped');
tabActions.length = 0;
await listeners.updated[0](903, { status: 'complete', url: 'https://example.com/' }, { id: 903, url: 'https://example.com/' });
assert.equal(tabActions.some((action) => action[0] === 'update' && action[1] === 903), false, 'ordinary pages must not be rewritten to the planting page');
tabActions.length = 0;
await listeners.updated[0](904, { status: 'complete', url: 'chrome://settings' }, { id: 904, url: 'chrome://settings' });
assert.equal(tabActions.some((action) => action[0] === 'update' && action[1] === 904), false, 'settings pages must not be rewritten to the planting page');

// Calendar regressions use a fixed UTC clock, independent of the host timezone.
const realDateNow = Date.now;
Date.now = () => Date.parse('2026-09-17T12:00:00Z');
try {
  await send({ type: 'CLEAR_DATA' });
  const emptyStats = await send({ type: 'GET_DASHBOARD_STATS' });
  assert.deepEqual(emptyStats.weeklyData.map((day) => day.date), [
    '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14',
    '2026-09-15', '2026-09-16', '2026-09-17'
  ], 'weekly statistics must contain seven distinct consecutive UTC dates');
  assert.equal(emptyStats.weeklyTrendData.length, 8, 'intention trends must contain eight consecutive UTC weeks');
  assert.equal(emptyStats.weeklyTrendData[0].weekStart, '2026-07-27');
  assert.equal(emptyStats.weeklyTrendData.at(-1).weekStart, '2026-09-14');
  assert.ok(emptyStats.weeklyTrendData.every((week) => week.intentionsStarted === 0 && week.averageDeepestPath === 0));
  assert.equal(emptyStats.currentStreak, 0);

  const trendSession = (id, startedAt, depths) => ({
    id, mission: id, status: 'completed', startedAt, endedAt: startedAt + 60000,
    origin: { url: 'https://example.com/' }, events: [],
    nodes: depths.map((depth, index) => ({ id: `${id}-node-${index}`, url: `https://example.com/${index}`, depth, firstSeenAt: startedAt + index * 1000 }))
  });
  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [
    trendSession('trend-current-a', Date.parse('2026-09-15T10:00:00Z'), [0, 2, 3]),
    trendSession('trend-current-b', Date.parse('2026-09-16T10:00:00Z'), [0, 1]),
    trendSession('trend-previous', Date.parse('2026-09-10T10:00:00Z'), [0, 5])
  ] } } });
  const trendStats = await send({ type: 'GET_DASHBOARD_STATS' });
  assert.deepEqual(
    trendStats.weeklyTrendData.slice(-2).map(({ weekStart, intentionsStarted, averageDeepestPath }) => ({ weekStart, intentionsStarted, averageDeepestPath })),
    [
      { weekStart: '2026-09-07', intentionsStarted: 1, averageDeepestPath: 5 },
      { weekStart: '2026-09-14', intentionsStarted: 2, averageDeepestPath: 2 }
    ],
    'weekly trends must count intentions by start date and average the deepest navigation step across sessions'
  );

  await send({ type: 'CLEAR_DATA' });
  const overnight = {
    id: 'calendar_overnight', mission: 'Read across midnight', status: 'completed',
    startedAt: Date.parse('2026-09-16T23:30:00Z'),
    endedAt: Date.parse('2026-09-17T00:30:00Z'),
    origin: { url: 'https://example.com/' }, nodes: [], events: []
  };
  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [overnight] } } });
  const stats = await send({ type: 'GET_DASHBOARD_STATS' });
  assert.equal(stats.totalFocusTime, 3600, 'elapsed session time must not change');
  assert.equal(stats.currentStreak, 1, 'an unattended session spanning midnight counts only its recorded start day');
  assert.deepEqual(stats.weeklyData.map((day) => day.minutes), [0, 0, 0, 0, 0, 30, 30],
    'a session crossing UTC midnight must split between its two dates');

  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [{
    ...overnight, id: 'calendar_engaged',
    events: [{ id: 'e1', type: 'navigation', at: Date.parse('2026-09-17T00:10:00Z') }]
  }] } } });
  const engagedStreak = await send({ type: 'GET_DASHBOARD_STATS' });
  assert.equal(engagedStreak.currentStreak, 2, 'a recorded trail action adds its day to the tending streak');

  await send({ type: 'CLEAR_DATA' });
  const historical = {
    ...overnight, id: 'calendar_historical',
    startedAt: Date.parse('2025-09-17T10:00:00Z'),
    endedAt: Date.parse('2025-09-17T11:00:00Z'),
    nodes: [{ id: 'historical_root', url: 'https://example.com/', depth: 0,
      firstSeenAt: Date.parse('2025-09-17T10:00:00Z') }]
  };
  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [historical] } } });
  const imported = (await send({ type: 'EXPORT_DATA' })).data.sessions[0];
  assert.equal(imported.startedAt, historical.startedAt, 'a one-year-old session is within the five-year import limit');
  assert.equal(imported.endedAt, historical.endedAt);
  assert.equal(imported.nodes[0].firstSeenAt, historical.nodes[0].firstSeenAt,
    'valid historical node timestamps must survive import');
} finally {
  Date.now = realDateNow;
}

// Forgetting a site must persist even when only saved items match.
await send({ type: 'CLEAR_DATA' });
await send({ type: 'IMPORT_DATA', payload: { data: {
  sessions: [],
  compostItems: [
    { id: 'forget_saved', url: 'https://www.saved.example/article', title: 'Remove me', savedAt: Date.now() },
    { id: 'keep_saved', url: 'https://other.example/article', title: 'Keep me', savedAt: Date.now() }
  ]
} } });
assert.equal(store.intentGroveState.compostItems.length, 2, 'fixture must be persisted');
await send({ type: 'FORGET_SITE', hostname: 'saved.example' });
assert.deepEqual(store.intentGroveState.compostItems.map((item) => item.id), ['keep_saved'],
  'compost-only forgetting must persist deletion and preserve unrelated saved items');
assert.equal(await send({ type: 'FORGET_SITE', hostname: 'saved.example' }), null,
  'forgetting a site with no remaining matches is a no-op');

await test('Forget Site removes origin-only and event-only metadata durably', async () => {
  const { clearStateCache } = await import('./shared/state.js');
  await send({ type: 'CLEAR_DATA' });
  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [
    { id: 'origin_only', origin: { url: 'https://www.forgotten.example/private', title: 'Private title', tabId: 77, windowId: 1 }, nodes: [], events: [] },
    { id: 'event_only', origin: { url: 'https://keep.example/' }, nodes: [], events: [
      { id: 'private_event', type: 'link_opened', url: 'https://forgotten.example/private' },
      { id: 'keep_event', type: 'link_opened', url: 'https://keep.example/' }
    ] }
  ] } } });
  const result = await send({ type: 'FORGET_SITE', hostname: 'WWW.FORGOTTEN.EXAMPLE' });
  assert.ok(result?.removed > 0, 'metadata-only deletion must count as a persistent change');
  clearStateCache();
  const data = (await send({ type: 'EXPORT_DATA' })).data;
  assert.equal(JSON.stringify(data).includes('forgotten.example'), false);
  assert.equal(data.sessions[0].origin.title, 'Forgotten origin');
  assert.equal(data.sessions[0].origin.tabId, null);
  assert.equal(data.sessions[0].origin.windowId, null);
  assert.deepEqual(data.sessions[1].events.map((event) => event.id), ['keep_event']);
  assert.equal(await send({ type: 'FORGET_SITE', hostname: 'forgotten.example' }), null);
});

await test('Forget Site repairs surviving descendants and removes deleted-node references', async () => {
  const { clearStateCache } = await import('./shared/state.js');
  await send({ type: 'CLEAR_DATA' });
  await send({ type: 'IMPORT_DATA', payload: { data: { activeSessionId: 'forget_tree', sessions: [{
    id: 'forget_tree', origin: { url: 'https://forgotten.example/', tabId: 71, windowId: 1 },
    nodes: [
      { id: 'deleted_root', url: 'https://forgotten.example/', depth: 0, tabIds: [71] },
      { id: 'survivor', url: 'https://keep.example/', parentId: 'deleted_root', depth: 1, tabIds: [72], relationshipConfidence: 'direct' },
      { id: 'deleted_middle', url: 'https://www.forgotten.example/page', parentId: 'survivor', depth: 2 },
      { id: 'child', url: 'https://other.example/', parentId: 'deleted_middle', depth: 3, relationshipConfidence: 'direct' },
      { id: 'grandchild', url: 'https://other.example/next', parentId: 'child', depth: 4, state: 'gentle' }
    ],
    events: [{ id: 'deleted_ref', type: 'pruned', nodeId: 'deleted_root' }, { id: 'kept_ref', type: 'navigation', nodeId: 'survivor' }],
    pendingRedirects: [{ tabId: 71, parentId: 'deleted_root' }, { tabId: 72, parentId: 'survivor' }],
    activeIntervals: [{ tabId: 71, startedAt: Date.now() }, { tabId: 72, startedAt: Date.now() }]
  }] } } });
  await send({ type: 'FORGET_SITE', hostname: 'forgotten.example' });
  clearStateCache();
  const data = (await send({ type: 'EXPORT_DATA' })).data;
  const tree = data.sessions[0];
  assert.deepEqual(tree.nodes.map(({ id, parentId, depth }) => ({ id, parentId, depth })), [
    { id: 'survivor', parentId: null, depth: 0 },
    { id: 'child', parentId: null, depth: 0 },
    { id: 'grandchild', parentId: 'child', depth: 1 }
  ]);
  assert.equal(tree.nodes[0].relationshipConfidence, 'external');
  assert.equal(tree.nodes[0].confidence, 'low');
  assert.equal(tree.nodes[2].state, 'normal');
  assert.deepEqual(tree.events.map((event) => event.id), ['kept_ref']);
  assert.deepEqual(tree.pendingRedirects.map((entry) => entry.parentId), ['survivor']);
  assert.deepEqual(tree.activeIntervals.map((entry) => entry.tabId), [72]);
  assert.equal(data.activeSessionId, 'forget_tree');
  // A forgotten origin must not act as an unplanted New Tab placeholder and
  // overwrite an unrelated surviving root on the next page observation.
  await send({ type: 'OBSERVE_PAGE', url: 'https://keep.example/next', title: 'Next' }, { id: 72 });
  assert.equal(store.intentGroveState.sessions[0].nodes[0].url, 'https://keep.example/');
});

await test('quota maintenance waits behind a queued clear instead of restoring old history', async () => {
  await send({ type: 'CLEAR_DATA' });
  await send({ type: 'IMPORT_DATA', payload: { data: {
    compostItems: Array.from({ length: 25 }, (_, i) => ({ id: `quota-${i}`, url: `https://quota.example/${i}`, savedAt: Date.now() }))
  } } });
  const originalSet = chrome.storage.local.set;
  const originalQuota = chrome.storage.local.getBytesInUse;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const writeStarted = new Promise((resolve) => { started = resolve; });
  let quotaCalls = 0;
  let writes = 0;
  chrome.storage.local.getBytesInUse = async () => { quotaCalls++; return 10 * 1024 * 1024; };
  chrome.storage.local.set = async (value) => {
    if (++writes === 1) { started(); await gate; }
    return originalSet(value);
  };
  let clear;
  let maintenance;
  let callsWhileBlocked;
  try {
    clear = send({ type: 'CLEAR_DATA' });
    await writeStarted;
    maintenance = listeners.alarm({ name: 'storageQuotaCheck' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    callsWhileBlocked = quotaCalls;
    release();
    await clear;
    await maintenance;
    assert.equal(callsWhileBlocked, 0, 'quota maintenance must not read stale history while clear is pending');
    assert.equal(quotaCalls, 1, 'one alarm should perform one quota check');
    assert.deepEqual(store.intentGroveState.compostItems, []);
    assert.equal(writes, 1, 'empty cleared history requires no compaction write');
  } finally {
    release();
    await Promise.allSettled([clear, maintenance]);
    chrome.storage.local.set = originalSet;
    if (originalQuota === undefined) delete chrome.storage.local.getBytesInUse;
    else chrome.storage.local.getBytesInUse = originalQuota;
  }
});

// Durability: a transient storage write failure must not silently drop the
// user's action — mutate() retries once against freshly loaded state.
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Retry durability', tab: { id: 800, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
const originalSet = globalThis.chrome.storage.local.set;
let setFailures = 0;
globalThis.chrome.storage.local.set = async (value) => {
  if (setFailures === 0) { setFailures += 1; throw new Error('simulated transient write failure'); }
  return originalSet(value);
};
await send({ type: 'OBSERVE_PAGE', url: 'https://retry.example/page', title: 'Retry page' }, { id: 800 });
globalThis.chrome.storage.local.set = originalSet;
assert.equal(setFailures, 1, 'fixture must have exercised exactly one failed write');
assert.equal(store.intentGroveState.sessions[0].nodes.some((node) => node.url === 'https://retry.example/page'), true,
  'a transient write failure must be retried so the user action is not lost');

// onSuspend must be registered as a lifecycle listener when available.
assert.equal(typeof globalThis.chrome.runtime.onSuspend, 'undefined', 'test mock omits onSuspend; listener registration must tolerate its absence');

// Rate-limit state is per-tab and must be cleaned up when the tab is removed,
// otherwise long sessions accumulate one entry per tab forever.
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Rate map cleanup', tab: { id: 900, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
const rateSender = { id: 'test', tab: { id: 900, url: 'https://rate.example/' } };
let lastView = null;
for (let i = 0; i < SERVICE_WORKER.RATE_LIMIT_MAX_REQUESTS; i++) lastView = await rawSend({ type: 'GET_ACTIVE_VIEW' }, rateSender);
assert.notEqual(lastView, null, 'messages within the limit must be answered');
assert.deepEqual(await rawSend({ type: 'GET_ACTIVE_VIEW' }, rateSender), { rateLimited: true },
  'the message past the budget must return the distinguishable throttle signal — a bare null was indistinguishable from "no mission" and hid the companion chip mid-session');
await listeners.removed[0](900);
assert.notEqual(await rawSend({ type: 'GET_ACTIVE_VIEW' }, rateSender), null,
  'tab removal must clear the per-tab rate-limit entry so a replacement tab is not blocked');

// Badge state must track mission depth live: green while shallow, warm when
// the choice threshold is reached, cleared when the mission ends.
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const badgeCalls = [];
globalThis.chrome.action = {
  setBadgeText: (info) => badgeCalls.push(['text', info.text]),
  setBadgeBackgroundColor: (info) => badgeCalls.push(['color', info.color])
};
badgeCalls.length = 0;
await send({ type: 'CLEAR_DATA' });
await flush(); // CLEAR_DATA performs its own badge clear; drop it before asserting start behavior
badgeCalls.length = 0;
await send({ type: 'START_MISSION', mission: 'Badge depth', tab: { id: 950, url: 'chrome-extension://test/newtab/index.html', title: 'New Tab' } });
await flush();
assert.equal(badgeCalls.length, 2, 'mission start must set both badge text and color exactly once');
assert.equal(badgeCalls[0][1].length > 0, true, 'mission start must show a badge label');
assert.equal(badgeCalls[1][1], '#719b6c', 'mission start must use the healthy color');
badgeCalls.length = 0;
for (let i = 1; i <= 5; i++) {
  await send({ type: 'LINK_CLICK', url: `https://deep.example/level-${i}`, title: `Level ${i}`, targetBlank: false }, { id: 950 });
  await send({ type: 'OBSERVE_PAGE', url: `https://deep.example/level-${i}`, title: `Level ${i}` }, { id: 950 });
}
await flush();
assert.equal(session().nodes.at(-1).depth, 5, 'fixture must reach the choice threshold depth');
const lastColor = [...badgeCalls].reverse().find((call) => call[0] === 'color')?.[1];
assert.equal(lastColor, '#bd8473', 'reaching the choice threshold must recolor the badge without ending the mission');
badgeCalls.length = 0;
await send({ type: 'END_MISSION', reason: 'user_ended' });
await flush();
assert.deepEqual(badgeCalls, [['text', ''], ['color', '#00000000']], 'ending the mission must clear the badge');
await send({ type: 'CLEAR_DATA' });
await send({ type: 'START_MISSION', mission: 'Do not guess a parent', tab: { id: 70, url: 'https://root.example/', title: 'Root' } });
await send({ type: 'LINK_CLICK', url: 'https://orphan.example/', title: 'Orphan' }, { id: 71 });
assert.equal(session().nodes.length, 1, 'an unmapped tab must not attach a link to the most recent unrelated node');
// --- R2/R3: drift accounting, note privacy, non-graded completion rewards, aged compost, streak milestones ---
{
  const nowTs = Date.now();
  const mkNode = (id, depth, url) => ({ id, url, title: id, parentId: null, depth, firstSeenAt: nowTs - 60000, closedAt: nowTs - 30000, relationshipConfidence: 'direct', confidence: 'high', navigationKind: 'link' });
  const mkSession = (id, nodes) => ({ id, mission: `${id} probe`, note: '', status: 'active', startedAt: nowTs - 120000, endedAt: null, origin: { url: nodes[0].url, title: 'Root', tabId: null, windowId: null }, nodes, events: [], activeIntervals: [], pendingRedirects: [], interventionPaused: false });
  await send({ type: 'CLEAR_DATA' });
  await send({ type: 'UPDATE_SETTINGS', settings: { enableRewards: true, gentleDepth: 4 } });
  await send({ type: 'START_MISSION', mission: 'Drift probe', missionNote: 'a private why', tab: { id: 860, url: 'https://drift.example/root', title: 'Root' } });
  const view = await send({ type: 'GET_ACTIVE_VIEW' }, { id: 860, url: 'https://drift.example/root' });
  assert.equal(view.hasNote, true, 'the view reports that a private note exists');
  assert.ok(!JSON.stringify(view).includes('a private why'), 'the note text itself must never reach a page context');
  assert.deepEqual(view.drift, { pages: 0, seconds: 0 }, 'a fresh root reports zero drift');

  // Completion rewards never infer whether a browsing path matched the intention.
  const lushNodes = Array.from({ length: 9 }, (_, i) => mkNode(`lush-${i}`, i === 0 ? 0 : 1, `https://lush.example/p${i}`));
  lushNodes.push(mkNode('lush-deep', 5, 'https://lush.example/deep'));
  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [mkSession('lush-session', lushNodes)], activeSessionId: 'lush-session', settings: { enableRewards: true, gentleDepth: 4 } } } });
  const lushEnd = await send({ type: 'END_MISSION', reason: 'user_ended' });
  assert.equal(lushEnd?.reward?.tier, 'blooms', 'completion rewards use the same tier regardless of path depth');
  assert.equal(lushEnd?.reward?.trigger, 'session_end_user_ended');
  assert.match(lushEnd?.reward?.note || '', /deliberately/, 'the reward reflects the choice to end, not a presumed outcome');

  // A deeper path receives the same completion treatment.
  const sparseNodes = [mkNode('sp-0', 0, 'https://sparse.example/p0'), mkNode('sp-1', 4, 'https://sparse.example/p1'), mkNode('sp-2', 5, 'https://sparse.example/p2'), mkNode('sp-3', 6, 'https://sparse.example/p3')];
  await send({ type: 'CLEAR_DATA' });
  await send({ type: 'IMPORT_DATA', payload: { data: { sessions: [mkSession('sparse-session', sparseNodes)], activeSessionId: 'sparse-session', settings: { enableRewards: true, gentleDepth: 4 } } } });
  const sparseEnd = await send({ type: 'END_MISSION', reason: 'user_ended' });
  assert.equal(sparseEnd?.reward?.tier, 'blooms', 'path depth does not change the reward tier');

  // Aged compost + streak milestone surface as data, never as copy.
  await send({ type: 'IMPORT_DATA', payload: { data: { compostItems: [{ id: 'aged-1', url: 'https://aged.example/', title: 'Aged curiosity', mission: 'old mission', savedAt: nowTs - 8 * 24 * 60 * 60 * 1000 }, { id: 'fresh-1', url: 'https://fresh.example/', title: 'Fresh', mission: 'now', savedAt: nowTs - 1000 }] } } });
  const stats = await send({ type: 'GET_DASHBOARD_STATS' });
  assert.equal(stats.agedSavedCount, 1, 'exactly the week-old curiosity counts as aged');
  assert.ok(stats.streakMilestone === null || typeof stats.streakMilestone === 'string', 'the milestone is a key the dashboard words, never copy from the worker');
  await send({ type: 'CLEAR_DATA' });
}

// --- Companion chip position: extension-private session storage (Phase-1 audit F2 fix) ---
{
  const tabA = { id: 810, url: 'https://chip-a.example/article' };
  const tabB = { id: 811, url: 'https://chip-a.example/article' };
  const tabAOtherOrigin = { id: 810, url: 'https://chip-b.example/other' };
  assert.equal(await send({ type: 'GET_CHIP_POS' }, tabA), null, 'an unset tab must report no saved chip position');
  assert.deepEqual(await send({ type: 'SET_CHIP_POS', x: 123.4, y: 567.8 }, tabA), { saved: true }, 'a validated content sender must save the chip position');
  assert.deepEqual(await send({ type: 'GET_CHIP_POS' }, tabA), { x: 123.4, y: 567.8 }, 'the chip position must round-trip exactly');
  assert.equal(await send({ type: 'GET_CHIP_POS' }, tabB), null, 'chip positions must not leak across tabs');
  assert.equal(await send({ type: 'GET_CHIP_POS' }, tabAOtherOrigin), null, 'chip positions must not leak across origins within one tab');
  assert.equal(await send({ type: 'GET_CHIP_POS' }), null, 'extension-page senders (no tab) must not read chip positions');
  assert.deepEqual(Object.keys(sessionStore.chipPositions || {}), ['810:https://chip-a.example'], 'positions must live in chrome.storage.session keyed by tab and origin');
  assert.equal(store.chipPositions, undefined, 'chip positions must never touch persistent local storage');
  await listeners.removed[0](810);
  assert.equal(await send({ type: 'GET_CHIP_POS' }, tabA), null, 'closing a tab must clear its chip positions');
  for (let index = 0; index < MEMORY_LIMITS.LRU_CACHE_SIZE + 5; index++) {
    await send({ type: 'SET_CHIP_POS', x: 10, y: 10 }, { id: 5000 + index, url: 'https://cap.example/' });
  }
  assert.ok(Object.keys(sessionStore.chipPositions).length <= MEMORY_LIMITS.LRU_CACHE_SIZE, 'the chip-position store must stay bounded');
  // Forks without storage.session degrade to worker memory, never to page storage.
  const sessionApi = chrome.storage.session;
  delete chrome.storage.session;
  assert.deepEqual(await send({ type: 'SET_CHIP_POS', x: 42, y: 24 }, { id: 812, url: 'https://fallback.example/' }), { saved: true }, 'the fallback must accept saves without storage.session');
  assert.deepEqual(await send({ type: 'GET_CHIP_POS' }, { id: 812, url: 'https://fallback.example/' }), { x: 42, y: 24 }, 'the fallback must round-trip in worker memory');
  chrome.storage.session = sessionApi;
}

// --- Chip-position reads must respect the content-sender rate budget and recover in a fresh window ---
{
  const budgetTab = { id: 850, url: 'https://budget.example/page' };
  const budgetSender = { id: 'test', tab: budgetTab, url: 'https://budget.example/page' };
  for (let i = 0; i < SERVICE_WORKER.RATE_LIMIT_MAX_REQUESTS; i++) await rawSend({ type: 'GET_CHIP_POS' }, budgetSender);
  assert.deepEqual(await rawSend({ type: 'GET_CHIP_POS' }, budgetSender), { rateLimited: true },
    'chip-position reads past the budget must return the distinguishable throttle signal');
  const realNow = Date.now;
  try {
    const base = realNow();
    Date.now = () => base + SERVICE_WORKER.RATE_LIMIT_WINDOW_MS + 1000;
    assert.equal(await rawSend({ type: 'GET_CHIP_POS' }, budgetSender), null,
      'a fresh rate window must restore chip-position reads — the content-side retry relies on this');
  } finally {
    Date.now = realNow;
  }
  await listeners.removed[0](850);
}

// --- Guardian signal 1 relay: the system.memory sample rides the active view ---
{
  await send({ type: 'CLEAR_DATA' });
  await send({ type: 'START_MISSION', mission: 'Sysmem relay probe', tab: { id: 880, url: 'https://sysmem.example/', title: 'S' } });
  let memView = await send({ type: 'GET_ACTIVE_VIEW' }, { id: 880, url: 'https://sysmem.example/' });
  assert.equal(memView.systemMemory, null, 'with the API absent the relayed sample must be null so fallback signals take over');
  chrome.system = { memory: { getInfo: async () => ({ capacity: 8 * 1073741824, availableCapacity: 536870912 }) } };
  memView = await send({ type: 'GET_ACTIVE_VIEW' }, { id: 880, url: 'https://sysmem.example/' });
  assert.ok(memView.systemMemory && Math.abs(memView.systemMemory.freeRatio - 0.0625) < 0.001, 'a live sample must relay the free ratio');
  delete chrome.system;
  await listeners.removed[0](880);
}

// --- Windowless-install race (the CI "No current window" F13 trace) ---
{
  const creates = () => tabActions.filter((entry) => entry[0] === 'create').length;
  chrome.windows.getLastFocused = async () => { throw new Error('No current window'); };
  const before = creates();
  await listeners.installed[0]({ reason: 'install' });
  assert.equal(creates(), before, 'a windowless install must skip the welcome tab quietly, not throw');
  chrome.windows.getLastFocused = async () => ({ id: 42 });
  await listeners.installed[0]({ reason: 'install' });
  const welcomes = tabActions.filter((entry) => entry[0] === 'create').slice(before);
  assert.equal(welcomes.length, 1, 'an install with a resolvable window opens exactly one welcome tab');
  assert.equal(welcomes[0][1].windowId, 42, 'the welcome tab targets the resolved window explicitly');
  assert.match(String(welcomes[0][1].url), /newtab\/index\.html$/, 'the welcome tab is the planting page');
  delete chrome.windows.getLastFocused;
  await send({ type: 'CLEAR_DATA' });
}

console.log('service-worker behavioral tests passed');
