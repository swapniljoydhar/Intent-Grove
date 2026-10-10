// Feature-by-feature verification in a REAL loaded extension.
// Complements test-extension-load.mjs (platform gates) by walking every
// user-facing surface end to end: onboarding, resume/browse UI, badge
// lifecycle, companion chip copy/buttons, compost + rewards + toast,
// post-compost continuity, Go Home from the popup, Pause Site, the settings
// round-trip, the dashboard (tree, trail, compost, stats, theme, export,
// clear, import, forget), and the popup completion ritual — including the
// [hidden] CSS fixes in vivo.
//
// Role protocol (from test-extension-load.mjs — same hard-won constraints):
//   extPage  : extension-origin UI only (ext->ext navigations, reliable)
//   webPage  : http-native tracked tab (http->http only)
//   no routed cross-origin commits, no Playwright WebUI gotos, no page churn
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBraveExecutablePath } from './scripts/browser-runtime.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-grove-ext-'));
for (const entry of ['manifest.json', 'background', 'content', 'dashboard', 'icons', 'newtab', 'popup', 'settings', 'shared']) {
  fs.cpSync(path.join(repoRoot, entry), path.join(extDir, entry), { recursive: true });
}

function pageHtml(title, links) {
  const body = links.map(([href, testId]) => {
    const text = testId === 'p1' ? 'Open a research result'
      : testId.startsWith('next') ? 'View related information'
        : testId.startsWith('self') ? 'Review this page' : testId;
    return `<p><a id="link-${testId.replace(/\W/g, '')}" href="${href}">${text}</a></p>`;
  }).join('\n');
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/serp') { res.end(pageHtml('Search results', [['/p/1', 'p1']])); return; }
  const match = /^\/p\/(\d+)$/.exec(url.pathname);
  if (match) {
    const n = Number(match[1]);
    const titles = ['Search results', 'Program overview', 'Admission requirements', 'Scholarship options', 'Application timeline', 'Research opportunities'];
    res.end(pageHtml(titles[n] || `Related result ${n}`, [[`/p/${n + 1}`, `next${n + 1}`], [`/p/${n}`, `self${n}`]]));
    return;
  }
  res.end(pageHtml('Root', [['/p/1', 'p1']]));
});
let baseUrl;
let context, extensionId, sw, webPage, extPage, swErrors = [], webErrors = [];
// Set CAPTURE_ONBOARDING_GUIDE=1 with BRAVE_EXECUTABLE_PATH pointing at
// Brave to refresh these real extension screenshots from local test fixtures.
const guideImageDir = path.join(repoRoot, 'newtab', 'guide-images');
async function captureGuide(name, page, selector = null) {
  if (process.env.CAPTURE_ONBOARDING_GUIDE !== '1') return Promise.resolve();
  fs.mkdirSync(guideImageDir, { recursive: true });
  await page.waitForTimeout(700); // let the companion's real entrance motion settle before capture
  const target = selector ? page.locator(selector) : page;
  return target.screenshot({ path: path.join(guideImageDir, name) });
}

async function waitForServiceWorker(ctx, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = ctx.serviceWorkers();
    if (workers.length) return workers[0];
    const raced = await ctx.waitForEvent('serviceworker', { timeout: Math.max(250, deadline - Date.now()) }).catch(() => null);
    if (raced) return raced;
  }
  throw new Error('service worker never registered — the manifest failed to load');
}
async function readState() {
  return await sw.evaluate(() => chrome.storage.local.get('intentGroveState').then((r) => r.intentGroveState ?? null));
}
async function resetState() {
  await sw.evaluate(() => chrome.storage.local.remove('intentGroveState'));
  await new Promise((r) => setTimeout(r, 250));
}
async function writeState(state) {
  await sw.evaluate((st) => chrome.storage.local.set({ intentGroveState: st }), state);
  await new Promise((r) => setTimeout(r, 300)); // let the worker's onChanged invalidate its cache
}
async function patchSettings(patch) {
  const apply = async () => sw.evaluate(async (p) => {
    const key = 'intentGroveState';
    const current = (await chrome.storage.local.get(key))[key] ?? null;
    const base = current ?? {
      schemaVersion: 4, activeSessionId: null, sessions: [], compostItems: [],
      settings: { gentleDepth: 4, choiceDepth: 5, ambientMotion: true, growthAnimationTrigger: 'none', excludedSites: [], searchEngine: 'duckduckgo', enableRewards: false },
      onboardingCompleted: true, rewardHistory: []
    };
    base.settings = { ...base.settings, ...p };
    base.onboardingCompleted = true;
    await chrome.storage.local.set({ [key]: base });
  }, patch);
  await apply();
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = await sw.evaluate(() => chrome.storage.local.get('intentGroveState').then((r) => r.intentGroveState?.settings ?? null));
    if (stored && Object.entries(patch).every(([k, v]) => stored[k] === v)) return;
    await new Promise((r) => setTimeout(r, 300));
    await apply();
  }
  throw new Error(`patchSettings could not stabilize: ${JSON.stringify(patch)}`);
}
async function waitForState(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await readState();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`state condition never met: ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}
const activeSessionOf = (state) => state?.sessions?.find((s) => s.id === state.activeSessionId) ?? null;
async function badge() {
  return sw.evaluate(() => Promise.all([
    chrome.action.getBadgeText({}),
    chrome.action.getBadgeBackgroundColor({}).then((c) => (Array.isArray(c) ? `rgba(${c.join(',')})` : String(c))),
  ]).then(([text, color]) => ({ text, color })));
}
// Plant via the page's own messaging context (no engine step — see
// test-extension-load.mjs for why routed engine commits are avoided), then
// land the tracked tab on the local SERP through a reliable http navigation.
async function plantMission(missionText, trackedPage, responsePlan = 'decide') {
  await extPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await extPage.waitForSelector('#mission-form', { timeout: 15000 });
  const response = await extPage.evaluate(({ mission, responsePlan: plan }) => chrome.runtime.sendMessage({ type: 'START_MISSION', mission, missionNote: '', responsePlan: plan }), { mission: missionText, responsePlan });
  assert.ok(response && response.id, `START_MISSION must return a session (got ${JSON.stringify(response)?.slice(0, 120)})`);
  await waitForState((s) => activeSessionOf(s)?.mission === missionText, `mission planted: ${missionText}`);
  await trackedPage.goto(`${baseUrl}/serp`);
  await waitForState(
    (s) => activeSessionOf(s)?.mission === missionText && activeSessionOf(s)?.origin?.url === `${baseUrl}/serp`,
    'SERP became the mission origin'
  );
  return trackedPage;
}

// --- closed-shadow helpers (CDP pierce) ---
const attrOf = (node, name) => { const i = node.attributes?.indexOf(name) ?? -1; return i >= 0 ? node.attributes[i + 1] : undefined; };
const classOf = (node) => (attrOf(node, 'class') || '').split(/\s+/);
function walkDom(node, out = []) {
  out.push(node);
  for (const sr of node.shadowRoots || []) walkDom(sr, out);
  for (const child of node.children || []) walkDom(child, out);
  return out;
}
async function shadowAll(page, cdp, pred) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return walkDom(root).filter(pred);
}
function textOf(node) {
  const parts = [];
  (function collect(n) {
    if (n.nodeType === 3 && n.nodeValue) parts.push(n.nodeValue);
    (n.children || []).forEach(collect);
  })(node);
  return parts.join('').trim();
}
async function chipInfo(page, cdp) {
  const chips = await shadowAll(page, cdp, (n) => classOf(n).includes('chip'));
  if (!chips.length) return { present: false };
  const states = await shadowAll(page, cdp, (n) => classOf(n).includes('chip-state'));
  const missions = await shadowAll(page, cdp, (n) => classOf(n).includes('chip-mission'));
  return {
    present: true,
    hidden: chips[0].attributes?.includes('hidden'),
    minimized: classOf(chips[0]).includes('minimized'),
    stateText: states[0] ? textOf(states[0]) : '',
    missionText: missions[0] ? textOf(missions[0]) : '',
  };
}
async function waitForChip(page, cdp, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let info;
  while (Date.now() < deadline) {
    info = await chipInfo(page, cdp);
    if (predicate(info)) return info;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`chip condition never met: ${label} (last: ${JSON.stringify(info)})`);
}
async function choiceCardVisible(page, cdp) {
  const cards = await shadowAll(page, cdp, (n) => classOf(n).includes('choice-card'));
  return Boolean(cards.length) && !cards[0].attributes?.includes('hidden');
}
async function textInShadowClass(page, cdp, className) {
  const nodes = await shadowAll(page, cdp, (n) => classOf(n).includes(className));
  return nodes[0] ? textOf(nodes[0]) : '';
}
async function shadowBounds(page, cdp, className) {
  const nodes = await shadowAll(page, cdp, (n) => classOf(n).includes(className));
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: nodes[0].backendNodeId });
  const quad = model.border;
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}
async function findToastVisible(page, cdp) {
  const finds = await shadowAll(page, cdp, (n) => classOf(n).includes('forest-find'));
  return Boolean(finds.length) && !finds[0].attributes?.includes('hidden');
}
async function clickShadow(page, cdp, pred) {
  const nodes = await shadowAll(page, cdp, pred);
  assert.ok(nodes.length >= 1, 'shadow node to click must exist');
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: nodes[0].backendNodeId });
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "nearest" }); }',
    awaitPromise: true,
  });
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: nodes[0].backendNodeId });
  const xs = [model.content[0], model.content[2], model.content[4], model.content[6]];
  const ys = [model.content[1], model.content[3], model.content[5], model.content[7]];
  const x = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const displayOf = (page, selector) => page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).display, selector);

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-grove-test-profile-'));
  const executablePath = resolveBraveExecutablePath();
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    acceptDownloads: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    chromiumSandbox: false,
    args: [
      ...(executablePath ? ['--headless=new'] : []),
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--disable-features=BackForwardCache,MediaRouter',
    ],
  });
  sw = await waitForServiceWorker(context);
  extensionId = new URL(sw.url()).host;
  sw.on('console', (msg) => { if (msg.type() === 'error') swErrors.push(`[sw] ${msg.text().slice(0, 300)}`); });
  context.on('weberror', (err) => webErrors.push(`[weberror] ${String(err.error()).slice(0, 300)}`));
  context.on('page', (page) => {
    page.on('pageerror', (e) => webErrors.push(`[pageerror] ${String(e).slice(0, 300)}`));
    page.on('crash', () => webErrors.push(`[pagecrash] ${page.url().slice(0, 120)}`));
  });
  // Guard route: the engine URL must never reach the open web from this suite.
  await context.route('https://duckduckgo.com/**', (route) => route.fulfill({ status: 204 }));
  // Let onInstalled seeding finish, then close startup debris.
  for (let i = 0; i < 40; i++) {
    const seeded = await sw.evaluate(() => chrome.storage.local.get('intentGroveState').then((r) => Boolean(r.intentGroveState))).catch(() => false);
    if (seeded) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const p of context.pages()) {
    const u = p.url();
    if (u === 'about:blank' || u.startsWith(`chrome-extension://${extensionId}/newtab`)) await p.close().catch(() => {});
  }
  webPage = await context.newPage();
  extPage = await context.newPage();
});

after(async () => {
  await context?.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
});

test('F1  onboarding: overlay shows on first run, dismiss persists and moves focus', async () => {
  await resetState();
  await extPage.addInitScript(() => {
    Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: async () => true } });
  });
  await extPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await extPage.waitForSelector('#onboarding-overlay:not([hidden])', { timeout: 10000 });
  await extPage.waitForFunction(() => document.querySelector('.browser-notice-step')?.hidden === false);
  assert.match(
    await extPage.locator('.browser-notice-step').innerText(),
    /Customize Brave.*Hide footer on New Tab page.*can.t hide it/s,
    'first-run onboarding must explain the actual Brave footer control and that it is browser-owned'
  );
  assert.match(await extPage.locator('.browser-notice-arrow').innerText(), /bottom edge/i, 'first-run onboarding arrow must identify where to look');
  assert.equal(await extPage.locator('.browser-notice-arrow').isVisible(), true, 'first-run onboarding must point toward the browser-owned bottom notice');
  assert.equal(await extPage.locator('[data-guide-slide]').count(), 4, 'walkthrough must introduce the four core surfaces');
  assert.match(await extPage.locator('[data-guide-slide="0"]').innerText(), /optional personal note stays on this device/i);
  assert.match(await extPage.locator('[data-guide-slide="1"]').innerText(), /cannot tell whether a page was useful/i);
  if (process.env.CAPTURE_ONBOARDING_GUIDE !== '1') {
    for (const image of await extPage.locator('[data-guide-slide] img').all()) {
      await image.evaluate(img => img.decode());
      assert.ok(await image.evaluate(img => img.naturalWidth >= 700), 'walkthrough imagery must load as full-size captures');
    }
  }
  await extPage.click('#guide-next');
  assert.equal(await extPage.textContent('#guide-progress'), '2 of 4');
  await extPage.click('#guide-previous');
  assert.equal(await extPage.textContent('#guide-progress'), '1 of 4');
  const originalViewport = extPage.viewportSize();
  await extPage.setViewportSize({ width: 1000, height: 620 });
  await extPage.locator('#mission-form').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await extPage.locator('#onboarding-overlay').evaluate(el => { el.hidden = true; });
  await captureGuide('01-intention.png', extPage);
  await extPage.locator('#onboarding-overlay').evaluate(el => { el.hidden = false; });
  await extPage.evaluate(() => window.scrollTo(0, 0));
  await extPage.setViewportSize(originalViewport);
  await extPage.click('#onboarding-start');
  await extPage.waitForSelector('#onboarding-overlay', { state: 'hidden', timeout: 5000 });
  const focused = await extPage.evaluate(() => document.activeElement?.id);
  assert.equal(focused, 'mission-input', 'dismissing onboarding must move focus to the mission field');
  await waitForState((s) => s.onboardingCompleted === true, 'onboarding completion persisted');
});

test('F2  new-tab UI: resume/browse buttons follow the session (CSS [hidden] fix in vivo)', async () => {
  // No session: resume button must be truly hidden (author display:flex used
  // to defeat the hidden attribute).
  await extPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await extPage.waitForSelector('#mission-form');
  assert.equal(await displayOf(extPage, '#resume-mission-btn'), 'none', 'resume must be hidden with no session');
  // Plant, reload, resume appears with the mission name.
  const response = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'START_MISSION', mission: 'Resume UI probe', missionNote: '' }));
  assert.ok(response?.id);
  await extPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await extPage.waitForSelector('#resume-mission-btn:not([hidden])', { timeout: 10000 });
  assert.equal(await displayOf(extPage, '#resume-mission-btn'), 'flex', 'resume must be visible with an active session');
  assert.match(await extPage.textContent('#resume-mission-btn'), /Resume UI probe/, 'resume button names the active mission');
  // Browse freely ends the session and hides resume again.
  await extPage.click('#browse-freely-btn');
  await waitForState((s) => s.activeSessionId === null, 'browse-freely ends the mission');
  await extPage.waitForSelector('#resume-mission-btn', { state: 'hidden', timeout: 5000 });
  assert.equal(await displayOf(extPage, '#resume-mission-btn'), 'none', 'resume hides again after browse-freely');
});

test('F2b  New Tab lets a person choose and save a private reminder response plan', async () => {
  await resetState();
  await extPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await extPage.waitForSelector('#mission-form');
  if (await extPage.locator('#onboarding-overlay').isVisible()) await extPage.click('#onboarding-skip');
  await extPage.locator('.optional-details summary').click();
  await extPage.locator('input[name="return-plan"][value="save"]').check();
  await extPage.fill('#mission-input', 'Read about native plants');
  await extPage.locator('#mission-form').evaluate(form => form.requestSubmit());
  await waitForState((s) => activeSessionOf(s)?.mission === 'Read about native plants', 'form-created mission');
  assert.equal(activeSessionOf(await readState())?.responsePlan, 'save', 'the selected response plan travels with the planted mission');
  await extPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await extPage.waitForSelector('#active:not([hidden])');
  await extPage.click('#end');
  await extPage.waitForSelector('#completion:not([hidden])');
  await extPage.click('#complete');
  await waitForState((s) => !activeSessionOf(s), 'plan-test mission ended through the popup');
  let cleared = await badge();
  for (let i = 0; i < 20 && cleared.text !== ''; i++) { await new Promise((r) => setTimeout(r, 100)); cleared = await badge(); }
  assert.equal(cleared.text, '', 'ending the plan-test session also clears its toolbar badge');
});

test('F3  badge lifecycle: planted green, paused gold, deep warm, ended empty', async () => {
  await resetState();
  await patchSettings({});
  const empty = await badge();
  assert.equal(empty.text, '', 'no mission means no badge');
  await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'START_MISSION', mission: 'Badge probe', missionNote: '' }));
  await waitForState((s) => Boolean(activeSessionOf(s)), 'badge probe mission planted');
  await waitForState(async () => true, 'tick'); // storage write flushed
  let b = await badge();
  for (let i = 0; i < 20 && b.text !== '🌱'; i++) { await new Promise((r) => setTimeout(r, 200)); b = await badge(); }
  assert.equal(b.text, '🌱', 'active mission shows the seedling badge');
  assert.match(b.color, /113,\s*155,\s*108/, 'shallow mission badge is green');
  await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'PAUSE_INTERVENTION', paused: true }));
  for (let i = 0; i < 20; i++) { b = await badge(); if (b.text === '⏸') break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(b.text, '⏸', 'paused mission shows the pause badge');
  await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'PAUSE_INTERVENTION', paused: false }));
  // Deep fixture: force a depth-6 garden, then any mutation refreshes the badge.
  const now = Date.now();
  const state = await readState();
  const session = activeSessionOf(state);
  const deepNodes = Array.from({ length: 7 }, (_, d) => ({
    id: `node_deep_${d}`, tabIds: [], url: `https://deep.example/${d}`, title: `Deep ${d}`,
    parentId: d ? `node_deep_${d - 1}` : null, depth: d, firstSeenAt: now - (7 - d) * 1000,
    relationshipConfidence: 'direct', confidence: 'high', navigationKind: d ? 'link' : 'mission-origin', state: 'normal'
  }));
  session.nodes = deepNodes;
  session.origin = { tabId: null, windowId: null, url: 'https://deep.example/0', title: 'Deep 0' };
  await writeState(state);
  await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'PAUSE_INTERVENTION', paused: true }));
  await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'PAUSE_INTERVENTION', paused: false }));
  for (let i = 0; i < 20; i++) { b = await badge(); if (b.text === '🌱' && /189,\s*132,\s*115/.test(b.color)) break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(b.text, '🌱');
  assert.match(b.color, /189,\s*132,\s*115/, 'deep mission badge turns warm at the choice threshold');
  await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'END_MISSION', reason: 'user_ended' }));
  for (let i = 0; i < 20; i++) { b = await badge(); if (b.text === '') break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(b.text, '', 'ending the mission clears the badge');
});

test('F4  companion copy tracks depth; choice card appears at the threshold', async () => {
  await resetState();
  await patchSettings({ gentleDepth: 2, choiceDepth: 3 });
  const page = await plantMission('Compare computer science programs', webPage, 'return');
  assert.equal(activeSessionOf(await readState())?.responsePlan, 'return', 'the chosen if-then plan persists with its mission');
  const cdp = await context.newCDPSession(page);
  let info = await waitForChip(page, cdp, (c) => c.present && !c.hidden, 'chip visible on the tracked page');
  assert.equal(info.missionText, 'Compare computer science programs', 'chip shows the mission');
  assert.equal(info.stateText, 'Growing from this mission', 'root copy at depth 0');
  await page.click('#link-p1');
  await page.waitForURL(`${baseUrl}/p/1`);
  const cdp1 = await context.newCDPSession(page);
  info = await waitForChip(page, cdp1, (c) => c.present && !c.hidden && c.stateText === '1 branch deep', 'depth-1 copy');
  await page.click('#link-next2');
  await page.waitForURL(`${baseUrl}/p/2`);
  const cdp2 = await context.newCDPSession(page);
  await waitForChip(page, cdp2, (c) => c.present && !c.hidden && c.stateText === 'This branch is getting long', 'gentle-threshold copy');
  await page.click('#link-next3');
  await page.waitForURL(`${baseUrl}/p/3`);
  const cdp3 = await context.newCDPSession(page);
  await waitForChip(page, cdp3, (c) => c.present && !c.hidden && c.stateText === 'A moment to check in', 'choice-threshold copy');
  let card = false;
  for (let i = 0; i < 40 && !card; i++) { card = await choiceCardVisible(page, cdp3); if (!card) await new Promise((r) => setTimeout(r, 250)); }
  assert.ok(card, 'choice card appears at the choice threshold');
  assert.match(await textInShadowClass(page, cdp3, 'choice-plan'), /You chose: return to your intention.*All options remain available/);
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 1000, height: 620 });
  const chipBounds = await shadowBounds(page, cdp3, 'chip');
  const cardBounds = await shadowBounds(page, cdp3, 'choice-card');
  assert.ok(chipBounds.bottom < cardBounds.top || cardBounds.bottom < chipBounds.top || chipBounds.right < cardBounds.left || cardBounds.right < chipBounds.left,
    'the reminder must not cover its own companion controls at a compact viewport');
  await captureGuide('02-choice.png', page);
  await page.setViewportSize(originalViewport);
});

test('F5  chip controls: minimize toggles, pause rests the forest, resume restores', async () => {
  const page = webPage; // still on /p/3 with the card up from F4
  const cdp = await context.newCDPSession(page);
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'minimize');
  await waitForChip(page, cdp, (c) => c.present && c.minimized, 'chip minimized');
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'minimize');
  await waitForChip(page, cdp, (c) => c.present && !c.minimized, 'chip restored');
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'pause');
  await waitForState((s) => activeSessionOf(s)?.interventionPaused === true, 'pause persisted');
  await waitForChip(page, cdp, (c) => c.present && c.stateText === 'Grove resting', 'resting copy');
  let b = await badge();
  for (let i = 0; i < 20 && b.text !== '⏸'; i++) { await new Promise((r) => setTimeout(r, 200)); b = await badge(); }
  assert.equal(b.text, '⏸', 'paused badge in vivo');
  let card = true;
  for (let i = 0; i < 20 && card; i++) { card = await choiceCardVisible(page, cdp); await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(!card, 'pausing hides the choice card');
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'pause');
  await waitForState((s) => activeSessionOf(s)?.interventionPaused === false, 'resume persisted');
  await waitForChip(page, cdp, (c) => c.present && c.stateText === 'A moment to check in', 'check-in copy returns after resume');
});

test('F6  compost from the card: item saved, node composted, reward earned, toast shown', async () => {
  await patchSettings({ enableRewards: true });
  const page = webPage;
  // The card is once-per-URL by design (no nagging): after the F5 pause /
  // resume cycle it will not re-show on /p/3, so walk one link deeper to a
  // FRESH url (/p/4, depth 4 >= choice 3) where it legitimately appears.
  await page.click('#link-next4');
  await page.waitForURL(`${baseUrl}/p/4`);
  const cdp = await context.newCDPSession(page);
  let card = false;
  for (let i = 0; i < 40 && !card; i++) { card = await choiceCardVisible(page, cdp); if (!card) await new Promise((r) => setTimeout(r, 250)); }
  assert.ok(card, 'choice card appears on the new deep URL');
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'compost');
  await waitForState((s) => (s.compostItems ?? []).some((it) => it.url === `${baseUrl}/p/4`), 'compost item saved from the card');
  const state = await readState();
  const node = activeSessionOf(state).nodes.find((n) => n.url === `${baseUrl}/p/4`);
  assert.equal(node.state, 'composted', 'the page node is composted');
  assert.equal(state.rewardHistory.length, 1, 'the compost choice earns exactly one reward');
  let toast = false;
  for (let i = 0; i < 30 && !toast; i++) { toast = await findToastVisible(page, cdp); if (!toast) await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(toast, 'Grove Note toast is shown in the closed shadow root');
  // Chip hides while the tab sits on a composted (terminal) node — honest state.
  await waitForChip(page, cdp, (c) => c.present && c.hidden, 'chip rests after composting the current page');
  await extPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await extPage.waitForSelector('#compost-reminder:not([hidden])', { timeout: 5000 });
  assert.match(await extPage.textContent('#compost-reminder-copy'), /1 saved curiosity is resting/,
    'the planting page gently resurfaces the saved curiosity');
});

test('F7  post-compost continuity: the tab keeps growing the garden (orphan fix in vivo)', async () => {
  const page = webPage; // sitting on the composted /p/4
  await page.click('#link-next5');
  await page.waitForURL(`${baseUrl}/p/5`);
  await waitForState(
    (s) => (activeSessionOf(s)?.nodes ?? []).some((n) => n.url === `${baseUrl}/p/5`),
    'navigation after compost is still tracked'
  );
  const node = activeSessionOf(await readState()).nodes.find((n) => n.url === `${baseUrl}/p/5`);
  assert.equal(node.relationshipConfidence, 'external', 'post-compost re-entry is a neutral external path');
  const cdp = await context.newCDPSession(page);
  const info = await waitForChip(page, cdp, (c) => c.present && !c.hidden, 'chip returns after re-entry');
  assert.equal(info.missionText, 'Compare computer science programs', 'chip shows the ongoing mission again');
});

test('F8  Go Home from the popup: activates the origin tab without reload and earns a return reward', async () => {
  await resetState();
  await patchSettings({ enableRewards: true });
  const page = await plantMission('Go Home probe', webPage); // origin tab = webPage on /serp
  const tabsBefore = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  await extPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await extPage.waitForSelector('#active:not([hidden])', { timeout: 10000 });
  assert.equal(await extPage.textContent('#mission'), 'Go Home probe', 'popup shows the active mission');
  assert.equal(await displayOf(extPage, '#popup-footer'), 'flex', 'popup footer visible with an active session');
  await extPage.click('#return');
  await waitForState((s) => (s.rewardHistory ?? []).some((r) => r.rewardId.startsWith('seed_')), 'return-to-root reward earned', 8000);
  const tabsAfter = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  assert.equal(tabsAfter, tabsBefore, 'Go Home to an intact origin tab must not open a new tab');
  const origin = activeSessionOf(await readState()).origin;
  const originActive = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), origin.tabId);
  assert.equal(originActive, true, 'Go Home activates the origin tab');
});

test('F9  Pause Site from the chip adds the exclusion and hides the companion', async () => {
  const page = webPage; // tracked, chip visible, mission active from F8
  const cdp = await context.newCDPSession(page);
  await waitForChip(page, cdp, (c) => c.present && !c.hidden, 'chip visible before pausing the site');
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'pause-site');
  await waitForState((s) => (s.settings.excludedSites ?? []).includes('127.0.0.1'), 'site exclusion persisted');
  await waitForChip(page, cdp, (c) => c.present && c.hidden, 'chip hides on the paused site');
});

test('F10 settings page: save round-trip, reset to defaults, exclusion clears and chip returns', async () => {
  await extPage.goto(`chrome-extension://${extensionId}/settings/index.html`);
  await extPage.waitForFunction(() => /already tending|could not read/.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
  const originalViewport = extPage.viewportSize();
  await extPage.setViewportSize({ width: 1000, height: 620 });
  await captureGuide('04-settings.png', extPage);
  await extPage.setViewportSize(originalViewport);
  await extPage.evaluate(() => {
    const set = (sel, value, evt) => { const el = document.querySelector(sel); el.value = value; el.dispatchEvent(new Event(evt, { bubbles: true })); };
    set('#gentle', '3', 'input');
    set('#choice', '4', 'input');
    set('#search-engine', 'bing', 'change');
    const excluded = document.querySelector('#excluded-sites');
    excluded.value = '';
    excluded.dispatchEvent(new Event('input', { bubbles: true }));
    const rewards = document.querySelector('#enable-rewards');
    rewards.checked = true;
    rewards.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await extPage.click('#save');
  await extPage.waitForFunction(() => /tending the grove now/.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
  let settings = (await readState()).settings;
  assert.deepEqual(
    { g: settings.gentleDepth, c: settings.choiceDepth, e: settings.searchEngine, x: settings.excludedSites, r: settings.enableRewards },
    { g: 3, c: 4, e: 'bing', x: [], r: true },
    'saved settings must round-trip through the worker'
  );
  // The paused-site chip must come back once the exclusion clears (cross-context sync).
  const cdp = await context.newCDPSession(webPage);
  await waitForChip(webPage, cdp, (c) => c.present && !c.hidden, 'chip returns after the exclusion is cleared from Settings');
  // Reset restores the true defaults.
  await extPage.click('#reset');
  await extPage.waitForFunction(() => /original rhythm has returned/.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
  settings = (await readState()).settings;
  assert.deepEqual(
    { g: settings.gentleDepth, c: settings.choiceDepth, e: settings.searchEngine, r: settings.enableRewards },
    { g: 4, c: 5, e: 'default', r: false },
    'reset must restore the shared defaults'
  );
  await patchSettings({ searchEngine: 'duckduckgo' }); // keep later flows hermetic
});

test('F11 dashboard: tree, trail, compost, stats, theme, export, clear, import, forget', async () => {
  await resetState();
  const now = Date.now();
  const fixture = {
    schemaVersion: 4,
    activeSessionId: 'session_fx_active',
    sessions: [
      { id: 'session_fx_done', mission: 'Completed garden', note: 'reflected', status: 'completed', startedAt: now - 7200000, endedAt: now - 3600000, endReason: 'user_ended',
        origin: { tabId: null, windowId: null, url: 'https://done.example/start', title: 'Start' },
        nodes: [
          { id: 'node_fx_root', tabIds: [], url: 'https://done.example/start', title: 'Start', parentId: null, depth: 0, firstSeenAt: now - 7200000, relationshipConfidence: 'direct', confidence: 'high', navigationKind: 'mission-origin', state: 'normal' },
          { id: 'node_fx_leaf', tabIds: [], url: 'https://done.example/leaf', title: 'Leaf page', parentId: 'node_fx_root', depth: 1, firstSeenAt: now - 7000000, closedAt: now - 3600000, relationshipConfidence: 'direct', confidence: 'high', navigationKind: 'link', state: 'normal' }
        ],
        events: [
          { id: 'ev_fx1', type: 'mission_started', at: now - 7200000, mission: 'Completed garden' },
          { id: 'ev_fx2', type: 'navigation', at: now - 7000000, nodeId: 'node_fx_leaf', depth: 1, url: 'https://done.example/leaf' }
        ],
        activeIntervals: [], pendingRedirects: [], interventionPaused: false },
      { id: 'session_fx_active', mission: 'Active garden', note: '', status: 'active', startedAt: now - 600000, endedAt: null, endReason: null,
        origin: { tabId: null, windowId: null, url: 'https://active.example/home', title: 'Home' },
        nodes: [{ id: 'node_fx_a', tabIds: [], url: 'https://active.example/home', title: 'Home', parentId: null, depth: 0, firstSeenAt: now - 600000, relationshipConfidence: 'direct', confidence: 'high', navigationKind: 'mission-origin', state: 'normal' }],
        events: [{ id: 'ev_fx3', type: 'mission_started', at: now - 600000, mission: 'Active garden' }],
        activeIntervals: [], pendingRedirects: [], interventionPaused: false }
    ],
    compostItems: [{ id: 'compost_fx1', url: 'https://saved.example/later', title: 'Saved curiosity', mission: 'Completed garden', savedAt: now - 5000000 }],
    settings: { gentleDepth: 4, choiceDepth: 5, ambientMotion: false, growthAnimationTrigger: 'none', excludedSites: [], searchEngine: 'duckduckgo', enableRewards: false },
    onboardingCompleted: true,
    rewardHistory: []
  };
  await writeState(fixture);
  await extPage.goto(`chrome-extension://${extensionId}/dashboard/index.html`);
  await extPage.waitForFunction(() => Boolean(document.querySelector('#tree')?.dataset.treeMode), null, { timeout: 15000 });
  const originalViewport = extPage.viewportSize();
  await extPage.selectOption('#session-select', { index: 1 });
  await extPage.waitForFunction(() => document.querySelectorAll('#tree .node').length === 2);
  await extPage.setViewportSize({ width: 1000, height: 620 });
  await captureGuide('03-garden.png', extPage, '#tree');
  await extPage.setViewportSize(originalViewport);
  await extPage.selectOption('#session-select', { index: 0 });
  await extPage.waitForFunction(() => /Active garden/.test(document.querySelector('#mission')?.textContent || ''));
  assert.match(await extPage.textContent('#mission'), /Active garden/, 'dashboard shows the active mission');
  const options = await extPage.$$eval('#session-select option', (els) => els.length);
  assert.equal(options, 2, 'session picker lists both gardens');
  const events = await extPage.$$eval('#events .event', (els) => els.length);
  assert.ok(events >= 1, 'trail notes render');
  const compost = await extPage.$$eval('#compost .compost-item', (els) => els.length);
  assert.equal(compost, 1, 'compost pile renders the saved item');
  // Leaf selection via the picker exposes the branch detail.
  await extPage.selectOption('#tree-page-select', { index: 1 });
  await extPage.waitForSelector('#branch-detail:not([hidden])', { timeout: 5000 });
  // Stats tab
  await extPage.click('[data-tab="stats"]');
  await extPage.waitForFunction(() => document.querySelector('#totalSessions')?.textContent === '2', null, { timeout: 10000 });
  assert.equal(await extPage.textContent('#savedCount'), '1');
  // An upgrade must migrate the former theme key and preserve the user's choice.
  await extPage.evaluate(() => {
    localStorage.removeItem('intent-grove-theme');
    localStorage.setItem('focus-forest-theme', 'dark');
  });
  await extPage.reload();
  await extPage.waitForSelector('#theme-toggle');
  assert.equal(await extPage.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
  assert.equal(await extPage.evaluate(() => localStorage.getItem('intent-grove-theme')), 'dark');
  assert.equal(await extPage.evaluate(() => localStorage.getItem('focus-forest-theme')), null);
  // Theme toggle
  await extPage.click('#theme-toggle');
  assert.equal(await extPage.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
  assert.equal(await extPage.evaluate(() => localStorage.getItem('intent-grove-theme')), 'light');
  await extPage.click('#theme-toggle');
  assert.equal(await extPage.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
  await extPage.click('#theme-toggle'); // back to light for later pages
  // Export -> capture the browser download handoff -> parse. Edge/Brave
  // headless extension contexts do not consistently surface Playwright's
  // Download event, so intercept only the final anchor click while exercising
  // the real worker export and UI serialization path.
  await extPage.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.startsWith('intent-grove-export-')) {
        window.__intentGroveExport = { filename: this.download, href: this.href };
        return;
      }
      return click.call(this);
    };
  });
  await extPage.click('[data-tab="stats"]'); // page reload restores the default Garden Map tab
  await extPage.click('#exportData');
  await extPage.waitForFunction(() => Boolean(window.__intentGroveExport), null, { timeout: 10000 });
  const exportCapture = await extPage.evaluate(async () => ({
    filename: window.__intentGroveExport.filename,
    data: JSON.parse(await (await fetch(window.__intentGroveExport.href)).text()),
  }));
  assert.match(exportCapture.filename, /^intent-grove-export-\d{4}-\d{2}-\d{2}\.json$/);
  const exportPath = path.join(os.tmpdir(), exportCapture.filename);
  fs.writeFileSync(exportPath, JSON.stringify(exportCapture.data));
  const exported = exportCapture.data;
  assert.equal(exported.sessions.length, 2, 'export contains both gardens');
  // Clear local data through the confirm dialog
  await extPage.click('#clear');
  await extPage.waitForSelector('#care-dialog:not([hidden])', { timeout: 5000 });
  await extPage.click('#care-confirm');
  await waitForState((s) => (s?.sessions ?? []).length === 0, 'clear local data empties the forest');
  // Import the exported file back
  await extPage.setInputFiles('#importFile', exportPath);
  await extPage.waitForFunction(() => /Import complete/.test(document.querySelector('#import-status')?.textContent || ''), null, { timeout: 15000 });
  await waitForState((s) => (s?.sessions ?? []).length === 2, 'import restores both gardens');
  fs.unlinkSync(exportPath);
  // Forget the selected garden
  await extPage.click('[data-tab="map"]');
  await extPage.waitForFunction(() => Boolean(document.querySelector('#tree')?.dataset.treeMode), null, { timeout: 10000 });
  await extPage.click('#forget');
  await extPage.waitForSelector('#care-dialog:not([hidden])', { timeout: 5000 });
  await extPage.click('#care-confirm');
  await waitForState((s) => (s?.sessions ?? []).length === 1, 'forget garden removes exactly the selected session');
});

test('F12 popup: empty-state footer hidden, plant via form, completion ritual, end', async () => {
  // One completed session remains from F11 — the popup must show the empty state.
  await extPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await extPage.waitForSelector('#empty:not([hidden])', { timeout: 10000 });
  assert.equal(await displayOf(extPage, '#popup-footer'), 'none', 'empty state hides the footer ([hidden] guard in vivo)');
  // Plant through the real popup form.
  await extPage.fill('#plant-input', 'Popup ritual probe');
  await extPage.click('#plant');
  await extPage.waitForSelector('#active:not([hidden])', { timeout: 10000 });
  assert.equal(await extPage.textContent('#mission'), 'Popup ritual probe');
  assert.equal(await displayOf(extPage, '#popup-footer'), 'flex', 'footer returns with an active session');
  // Completion ritual
  await extPage.click('#end');
  await extPage.waitForSelector('#completion:not([hidden])', { timeout: 5000 });
  const copy = await extPage.textContent('#completion-copy');
  assert.match(copy, /Popup ritual probe/, 'reflection copy names the mission');
  assert.equal(await displayOf(extPage, '#popup-footer'), 'none', 'ritual hides the footer ([hidden] guard in vivo)');
  await extPage.click('#keep');
  await extPage.waitForSelector('#active:not([hidden])', { timeout: 5000 });
  await extPage.click('#end');
  await extPage.waitForSelector('#completion:not([hidden])', { timeout: 5000 });
  await extPage.click('#complete');
  await extPage.waitForSelector('#empty:not([hidden])', { timeout: 10000 });
  await waitForState((s) => s.activeSessionId === null, 'let-it-rest completes the mission');
  let b = await badge();
  for (let i = 0; i < 20 && b.text !== ''; i++) { await new Promise((r) => setTimeout(r, 200)); b = await badge(); }
  assert.equal(b.text, '', 'badge clears after the ritual');
});

test('F13 the current page can become a fresh mission without leaving the page', async () => {
  await resetState();
  await patchSettings({ gentleDepth: 2, choiceDepth: 3 });
  const page = await plantMission('Follow this research', webPage);
  await page.click('#link-p1');
  await page.waitForURL(`${baseUrl}/p/1`);
  for (let depth = 2; depth <= 3; depth++) {
    await page.click(`#link-next${depth}`);
    await page.waitForURL(`${baseUrl}/p/${depth}`);
  }
  const cdp = await context.newCDPSession(page);
  let card = false;
  for (let i = 0; i < 40 && !card; i++) { card = await choiceCardVisible(page, cdp); if (!card) await new Promise((resolve) => setTimeout(resolve, 250)); }
  assert.equal(card, true, 'the current page must reach the configured choice point');
  const title = await page.title();
  await clickShadow(page, cdp, (node) => attrOf(node, 'data-action') === 'mission-here');
  await waitForState((state) => activeSessionOf(state)?.mission === title, 'the current page title becomes the new mission');
  const current = await readState();
  assert.equal(activeSessionOf(current)?.origin?.url, `${baseUrl}/p/3`, 'the current page becomes the new garden root');
  assert.equal(current.sessions.at(-2)?.status, 'completed', 'the previous garden is preserved as completed');
});

test('F14 no uncaught errors surfaced during the whole feature walk', async () => {
  const real = [...swErrors, ...webErrors].filter((e) => !/rate limit/i.test(e));
  assert.deepEqual(real, [], 'service worker and pages must stay free of uncaught errors');
});
