// Gate 0–2 + Gate 5: load Intent Grove as a REAL extension in Brave locally
// (Playwright-managed Chromium on CI runners that do not have Brave installed).
// This is the suite the audit kept demanding: the manifest itself (world:"MAIN"
// bridge, newtab override, service worker, content scripts) executes here —
// nothing is mocked except the open web (a local HTTP server + one routed
// search stub). Closed shadow DOM is asserted through CDP with pierce:true.
//
// Product semantics this suite respects (and therefore encodes):
// - Untracked tabs never show a chip and never grow branches ("unrelated tabs
//   must not become branches"), so every flow plants a mission and navigates
//   within the tab the worker is tracking.
// - The companion host #intent-grove-root is a zero-size, pointer-events:none
//   container (children are position:fixed inside a closed shadow root), so
//   presence is asserted with state:'attached', never "visible".
//
// Harness constraints learned the hard way on small CI containers:
// - Pages are REUSED (one web-origin page, one extension-origin page) instead
//   of created per test; renderer churn on ~1GB/2-core boxes caused random
//   "Target crashed" cascades.
// - No Playwright goto('chrome://newtab'): a WebUI-mapped navigation leaves
//   CDP request interception in a state where the next extension-page ->
//   https navigation (the plant flow's tabs.update) sporadically aborts. The
//   override is verified through a real browser-opened tab instead.
// - The routed search engine responds with a 302 onto the local server:
//   committing a fulfilled cross-process document from a chrome-extension://
//   tab is flaky under interception; a redirect commits through ordinary
//   local navigation.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { resolveBraveExecutablePath } from './scripts/browser-runtime.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// --- Build a clean extension directory (mirrors scripts/package.mjs entries) ---
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-grove-ext-'));
for (const entry of ['manifest.json', 'background', 'content', 'dashboard', 'icons', 'newtab', 'popup', 'settings', 'shared']) {
  fs.cpSync(path.join(repoRoot, entry), path.join(extDir, entry), { recursive: true });
}

// --- Local web server: hermetic stand-in for "the open web" ---
function pageHtml(title, links) {
  const body = links.map(([href, text]) => `<p><a id="link-${text.replace(/\W/g, '')}" href="${href}">${text}</a></p>`).join('\n');
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/spa') { res.end(pageHtml('SPA host', [['/p/1', 'p1']])); return; }
  if (url.pathname === '/serp') { res.end(pageHtml('Search results', [['/p/1', 'p1']])); return; }
  const match = /^\/p\/(\d+)$/.exec(url.pathname);
  if (match) {
    const n = Number(match[1]);
    res.end(pageHtml(`Page ${n}`, [[`/p/${n + 1}`, `next${n + 1}`], [`/p/${n}`, `self${n}`]]));
    return;
  }
  if (url.pathname === '/churn') {
    res.end('<!doctype html><html><head><title>Churn 0</title></head><body><h1>Title churn probe</h1><script>let i = 0; const t = setInterval(() => { i++; if (i >= 8) { clearInterval(t); document.title = "Churn final"; } else { document.title = "Churn " + i; } }, 200);</script></body></html>');
    return;
  }
  if (/^\/r\/\d+$/.test(url.pathname)) { res.end(pageHtml(`Rapid ${url.pathname}`, [])); return; }
  res.end(pageHtml('Root', [['/p/1', 'p1']]));
});
let baseUrl;

let context, extensionId, sw, webPage, extPage, httpPage, swErrors = [], webErrors = [];

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
  // Verify-by-readback: the worker's async onInstalled seeding can land right
  // after an early write and clobber it. Re-apply until storage matches.
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
function activeSessionOf(state) {
  return state?.sessions?.find((s) => s.id === state.activeSessionId) ?? null;
}

// Plant a mission on the shared extension page, then land the tracked tab on
// the local SERP stub so the session's origin replant (placeholder -> real
// root) runs exactly as it does in production after the engine navigation.
async function plantMission(missionText, senderPage, trackedPage) {
  // Role protocol (empirically derived on this Chromium/new-headless stack):
  //   ext->ext and http->http renderer navigations: always reliable.
  //   web->ext browser-issued (OPEN_PLANTING_PAGE): reliable (asserted in vivo).
  //   ext->http after a tab has round-tripped, and any routed cross-origin
  //   commit: sporadically ERR_ABORTED — both classes are avoided entirely.
  // The sender page plants from the extension origin; the tracked page lands
  // on the local SERP through a same-class navigation and replants the
  // placeholder origin exactly like a real search landing would.
  await senderPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await senderPage.waitForSelector('#mission-form', { timeout: 15000 });
  // Plant through the page's own messaging context WITHOUT the openSearch
  // engine step: the engine URL is an external origin only the CDP route can
  // answer, and routed browser-initiated commits are this stack's flakiest
  // class. The engine URL contract (search.query for 'default', exact
  // per-engine tabs.update URLs) is pinned by the worker unit tests; every
  // product path downstream of the landing is exercised identically here.
  const response = await senderPage.evaluate((mission) => chrome.runtime.sendMessage({
    type: 'START_MISSION',
    mission,
    missionNote: 'planted by the real-extension suite',
  }), missionText);
  assert.ok(response && response.id, `START_MISSION must return the created session (got ${JSON.stringify(response)?.slice(0, 120)})`);
  await waitForState((s) => activeSessionOf(s)?.mission === missionText, `mission planted: ${missionText}`);
  assert.ok(
    !trackedPage.url().startsWith('chrome-extension://'),
    'tracked page must live on an http origin: this stack aborts ext->http crossings except right after tab creation, so tracked tabs are http-native for life (see protocol notes)'
  );
  await trackedPage.goto(`${baseUrl}/serp`);
  await waitForState(
    (s) => activeSessionOf(s)?.mission === missionText && activeSessionOf(s)?.origin?.url === `${baseUrl}/serp`,
    'SERP became the mission origin (placeholder replant on the tracked tab)'
  );
  return trackedPage;
}

// --- Closed-shadow inspection via CDP (pierce sees closed roots) ---
function attrOf(node, name) {
  const i = node.attributes?.indexOf(name) ?? -1;
  return i >= 0 ? node.attributes[i + 1] : undefined;
}
function classOf(node) { return (attrOf(node, 'class') || '').split(/\s+/); }
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
async function chipInfo(page, cdp) {
  const chips = await shadowAll(page, cdp, (n) => classOf(n).includes('chip'));
  if (!chips.length) return { present: false };
  return { present: true, hidden: chips[0].attributes?.includes('hidden') };
}
async function choiceCardVisible(page, cdp) {
  const cards = await shadowAll(page, cdp, (n) => classOf(n).includes('choice-card'));
  return Boolean(cards.length) && !cards[0].attributes?.includes('hidden');
}
async function clickShadow(page, cdp, pred) {
  const nodes = await shadowAll(page, cdp, pred);
  assert.ok(nodes.length >= 1, 'shadow node to click must exist');
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: nodes[0].backendNodeId });
  const [x1, y1, x2, y2] = model.content;
  const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function chipBox(page, cdp) {
  const chips = await shadowAll(page, cdp, (n) => classOf(n).includes('chip'));
  if (!chips.length) return null;
  try {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: chips[0].backendNodeId });
    const [x1, y1, x2, y2] = model.content;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  } catch { return null; }
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-grove-test-profile-'));
  const executablePath = resolveBraveExecutablePath();
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }), // new headless is required for extension support
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
  assert.match(sw.url(), /chrome-extension:\/\/[a-z]{32}\/background\/service-worker\.js/);

  sw.on('console', (msg) => { if (msg.type() === 'error') swErrors.push(`[sw] ${msg.text().slice(0, 300)}`); });
  context.on('weberror', (err) => webErrors.push(`[weberror] ${String(err.error()).slice(0, 300)}`));
  context.on('page', (page) => {
    page.on('pageerror', (e) => webErrors.push(`[pageerror] ${String(e).slice(0, 300)}`));
    page.on('crash', () => webErrors.push(`[pagecrash] ${page.url().slice(0, 120)}`));
  });
  if (process.env.FF_DEBUG) {
    await sw.evaluate(() => {
      globalThis.__nav = [];
      const tu = chrome.tabs.update.bind(chrome.tabs);
      chrome.tabs.update = (...a) => { globalThis.__nav.push(`${Date.now()} tabs.update ${JSON.stringify(a).slice(0, 130)}`); return tu(...a); };
      if (chrome.search?.query) { const sq = chrome.search.query.bind(chrome.search); chrome.search.query = (...a) => { globalThis.__nav.push(`${Date.now()} search.query ${JSON.stringify(a).slice(0, 90)}`); return sq(...a); }; }
    });
    sw.on('console', (m) => console.log(`    [sw:${m.type()}]`, m.text().slice(0, 180)));
  }

  // Route the search engine deterministically: ABORT it. Whether Chromium
  // commits a fulfilled/redirected browser-initiated cross-process navigation
  // under CDP request interception is environment lottery (observed both ways
  // on identical builds in this sandbox); aborting keeps the tab on the
  // planting page every time. The product-side contract (START_MISSION issues
  // tabs.update with the correct engine URL) is pinned by the worker unit
  // tests and visible in FF_DEBUG nav traces; the "search page becomes the
  // mission root" logic is exercised identically below no matter who issues
  // the navigation.
  await context.route('https://duckduckgo.com/**', (route) => {
    if (process.env.FF_DEBUG) console.log(`    [route] hit ${route.request().url().slice(0, 60)}`);
    // 204 No Content: Chromium cleanly cancels the navigation and keeps the
    // current document — deterministic, hermetic, and free of the flaky
    // "commit a routed cross-process response" path entirely (aborts leave
    // error-page commits racing the next goto; fulfilled documents/redirects
    // sporadically never commit on the first attempts in this stack). The
    // engine-navigation CONTRACT (correct URL issued via tabs.update /
    // search.query) is asserted by the worker unit tests and visible in
    // FF_DEBUG traces; committing an https document from the worker is
    // browser behavior, covered in vivo by OPEN_PLANTING_PAGE (Gate: choice
    // card) for the extension-page direction.
    return route.fulfill({ status: 204 });
  });

  // Let the worker's onInstalled seeding finish before touching storage, then
  // close the install-tab debris so no renderer is wasted on idle pages.
  for (let i = 0; i < 40; i++) {
    const seeded = await sw.evaluate(() => chrome.storage.local.get('intentGroveState').then((r) => Boolean(r.intentGroveState))).catch(() => false);
    if (seeded) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const p of context.pages()) {
    const u = p.url();
    if (u === 'about:blank' || u.startsWith(`chrome-extension://${extensionId}/newtab`)) await p.close().catch(() => {});
  }

  // Two long-lived pages with fixed origin roles (no per-test page churn —
  // renderer process creation is crash-prone on ~1GB containers):
  //   extPage  — extension-origin sender (plant form) / later tracked http tab
  //   webPage  — http-origin page (companion probe, tracked tab) / later sender
  // Test 6's OPEN_PLANTING_PAGE moves webPage web->ext (reliable class); from
  // there webPage serves as the extension-origin sender for tests 7-8 while
  // extPage takes over as the tracked http tab. See plantMission's protocol.
  webPage = await context.newPage();
  extPage = await context.newPage();
  // httpPage is http-native for life (born on the local origin, only ever
  // http->http afterwards): the dependable tracked tab for the sync and
  // rate-budget gates.
  httpPage = await context.newPage();
  await httpPage.goto(`${baseUrl}/`);

  await resetState();
  await patchSettings({ searchEngine: 'duckduckgo', growthAnimationTrigger: 'none', ambientMotion: false });
});

after(async () => {
  await context?.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
});

test('Gate 0: manifest loads, service worker runs, bridge registered MAIN-world', async () => {
  assert.ok(extensionId, 'extension id resolved from the live service worker');
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.minimum_chrome_version, '111');
  const bridgeEntry = manifest.content_scripts.find((e) => e.js.includes('content/spa-bridge.js'));
  assert.equal(bridgeEntry.world, 'MAIN', 'bridge must be registered for the page world');
  // Empirical pin for the performance guardian's primary signal: the docs
  // promise chrome.system.memory to extensions (Chrome 91+, "system.memory"
  // permission). If a future engine regresses this, the guardian degrades to
  // device-class + heap signals — but this gate must then be updated, not
  // silently skipped.
  const sysmem = await sw.evaluate(async () => {
    try {
      const info = await chrome.system?.memory?.getInfo?.();
      return info && Number(info.capacity) > 0 ? { ok: true, gb: Math.round(info.capacity / 1073741824) } : { ok: false, reason: 'missing' };
    } catch (error) { return { ok: false, reason: String(error) }; }
  });
  assert.ok(sysmem.ok && sysmem.gb >= 1, `chrome.system.memory must be live in Chromium — got ${JSON.stringify(sysmem)}`);
});

test('Gate 0: a real new tab resolves to the planting page override', async () => {
  // Verified the way a user triggers it — a genuine browser new tab. (A
  // Playwright goto('chrome://newtab') poisons the next routed extension-page
  // navigation; see harness notes at the top.)
  const tabId = await sw.evaluate(async () => {
    const [anyTab] = await chrome.tabs.query({});
    return chrome.tabs.create({ windowId: anyTab?.windowId }).then((t) => t.id);
  });
  let url = '';
  for (let i = 0; i < 40; i++) {
    url = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url).catch(() => ''), tabId);
    if (url.startsWith('chrome-extension://')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(url, /^chrome-extension:\/\/[a-z]{32}\/newtab\/index\.html/, 'a real new tab must resolve to the planting page override');
  await sw.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tabId);
});

test('Gate 0: companion host + MAIN-world bridge inject on an ordinary http page', async () => {
  await webPage.goto(`${baseUrl}/p/1`);
  await webPage.waitForSelector('#intent-grove-root', { state: 'attached', timeout: 15000 });
  const patched = await webPage.evaluate(() => {
    const src = history.pushState.toString();
    return { own: Object.prototype.hasOwnProperty.call(history, 'pushState'), announces: src.includes('announce') };
  });
  assert.ok(patched.own && patched.announces, `MAIN-world bridge must own history.pushState (got ${JSON.stringify(patched)})`);
});

test('Gate 1: link click grows exactly one branch — no spurious reload; real reload and self-link each record exactly one', async () => {
  const page = await plantMission('E2E research mission', extPage, webPage);
  await page.click('#link-p1');
  await page.waitForURL(`${baseUrl}/p/1`);
  const state = await waitForState(
    (s) => (activeSessionOf(s)?.nodes ?? []).some((n) => n.url === `${baseUrl}/p/1` && n.depth === 1),
    'depth-1 branch from a real link click'
  );
  const events = activeSessionOf(state).events.map((e) => e.type);
  assert.ok(events.includes('navigation'), 'link navigation must be recorded');
  assert.equal(events.filter((e) => e === 'reload').length, 0, 'ordinary link click must not record a reload (dual-observation fix, in vivo)');

  await page.reload();
  await waitForState((s) => activeSessionOf(s).events.filter((e) => e.type === 'reload').length === 1, 'one reload event after F5 (both observations, one event)');

  await page.click('#link-self1');
  await page.waitForURL(`${baseUrl}/p/1`);
  await waitForState((s) => activeSessionOf(s).events.filter((e) => e.type === 'reload').length === 2, 'self-link reload recorded exactly once (commit-verified mark, in vivo)');
});

test('Gate 2: page-world pushState reaches the worker through the bridge; hostile synthetic event is a no-op', async () => {
  const page = await plantMission('Bridge probe mission', extPage, webPage);
  // Stay inside the tracked tab: same-tab navigation keeps tracking.
  await page.goto(`${baseUrl}/spa`);
  await waitForState((s) => (activeSessionOf(s)?.nodes ?? []).some((n) => n.url === `${baseUrl}/spa`), 'spa host observed in the tracked tab');
  const countBefore = activeSessionOf(await readState()).nodes.length;

  await page.evaluate(() => { history.pushState({ chapter: 1 }, '', '/spa-route-1'); });
  await waitForState(
    (s) => (activeSessionOf(s)?.nodes ?? []).some((n) => n.url === `${baseUrl}/spa-route-1` && n.navigationKind === 'spa'),
    'bridge-delivered pushState becomes an spa branch'
  );
  const spaNodes = activeSessionOf(await readState()).nodes.filter((n) => n.url === `${baseUrl}/spa-route-1`);
  assert.equal(spaNodes.length, 1, 'one pushState must create exactly one branch');

  await page.evaluate(() => { document.dispatchEvent(new CustomEvent('intent-grove-history')); });
  await new Promise((r) => setTimeout(r, 800));
  const after = await readState();
  assert.equal(activeSessionOf(after).nodes.length, countBefore + 1, 'synthetic bridge event must not create nodes');
});

test('Gate 1: deep branch raises the choice card and "Start a new mission" really navigates (OPEN_PLANTING_PAGE in vivo)', async () => {
  await resetState();
  await patchSettings({ gentleDepth: 2, choiceDepth: 3 });
  const page = await plantMission('Choice card probe', extPage, webPage);
  for (const to of [1, 2, 3]) {
    await page.click(`#link-${to === 1 ? 'p1' : `next${to}`}`);
    await page.waitForURL(to === 1 ? `${baseUrl}/p/1` : `${baseUrl}/p/${to}`);
  }
  await waitForState((s) => Math.max(...activeSessionOf(s).nodes.map((n) => n.depth)) >= 3, 'depth 3 reached through real link clicks');

  const cdp = await context.newCDPSession(page);
  let visible = false;
  for (let i = 0; i < 40 && !visible; i++) {
    visible = await choiceCardVisible(page, cdp);
    if (!visible) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(visible, 'choice card must appear at the choice threshold (closed shadow, asserted via CDP pierce)');

  const secondaryAction = (await shadowAll(page, cdp, (node) => attrOf(node, 'data-action') === 'mission-here'))[0];
  assert.ok(secondaryAction, 'the current-page mission action is present in the choice card');
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: secondaryAction.backendNodeId });
  const styleResult = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function () { const style = getComputedStyle(this); const card = this.closest('.choice-card'); return { display: style.display, borderWidth: style.borderWidth, overflowY: getComputedStyle(card).overflowY, maxHeight: getComputedStyle(card).maxHeight }; }`,
    returnByValue: true
  });
  assert.equal(styleResult.result.value.display, 'block', 'the current-page mission action must render as a styled full-width action');
  assert.notEqual(styleResult.result.value.borderWidth, '0px', 'the current-page mission action must have its own visible control treatment');
  assert.equal(styleResult.result.value.overflowY, 'auto', 'the choice card must scroll instead of being clipped on short windows');
  assert.notEqual(styleResult.result.value.maxHeight, 'none', 'the choice card height must be bounded by the viewport');

  const missionBefore = activeSessionOf(await readState()).mission;
  await clickShadow(page, cdp, (n) => attrOf(n, 'data-action') === 'mission');
  await page.waitForURL(/chrome-extension:\/\/[a-z]{32}\/newtab\/index\.html/, { timeout: 15000 });
  // In-vivo proof of the Phase-1 fix: the WEB PAGE could never perform this
  // navigation itself (WAR is empty); the worker did it via OPEN_PLANTING_PAGE.
  const state = await waitForState(
    (s) => s.sessions.some((x) => x.mission === missionBefore && x.status === 'completed' && x.endReason === 'mission_changed'),
    'previous mission completed as mission_changed'
  );
  assert.equal(state.activeSessionId, null, 'no mission is active right after choosing "Start a new mission"');
});

test('Gate 1: cross-context sync — ending a mission from New Tab hides the chip on an idle tracked page', async () => {
  await resetState();
  await patchSettings({});
  // extPage remains the extension-origin sender; the http-native httpPage is
  // the tracked tab (webPage stays parked on the extension origin after
  // test 6's OPEN_PLANTING_PAGE landing and serves as the ending context).
  const tracked = await plantMission('Sync probe mission', extPage, httpPage);
  // Move the tracked tab to an idle local page; then it stops navigating.
  await tracked.goto(`${baseUrl}/p/50`);
  await waitForState((s) => (activeSessionOf(s)?.nodes ?? []).some((n) => n.url === `${baseUrl}/p/50`), 'idle page is tracked');

  const cdp = await context.newCDPSession(tracked);
  let chipVisible = false;
  for (let i = 0; i < 40 && !chipVisible; i++) {
    const info = await chipInfo(tracked, cdp);
    chipVisible = info.present && !info.hidden;
    if (!chipVisible) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(chipVisible, 'chip must be visible on the tracked page while the mission is active');

  // End the mission from a DIFFERENT extension context: webPage is already
  // on the extension origin (test 6's landing), so an ext->ext reload of the
  // planting page is all it takes.
  await webPage.goto(`chrome-extension://${extensionId}/newtab/index.html`);
  await webPage.waitForSelector('#browse-freely-btn');
  const toolbarSettings = await webPage.evaluate(() => chrome.action.getUserSettings());
  assert.equal(typeof toolbarSettings.isOnToolbar, 'boolean', 'the real browser must expose toolbar pin state');
  await webPage.waitForFunction(() => document.querySelector('#pin-help')?.hidden === false);
  assert.equal(await webPage.locator('#pin-state').textContent(), toolbarSettings.isOnToolbar ? 'Pinned' : 'Not pinned');
  await webPage.click('#browse-freely-btn');
  await waitForState((s) => s.activeSessionId === null, 'mission ended from the New Tab context');

  // The idle page must notice WITHOUT any navigation — storage.onChanged sync.
  let hid = false;
  for (let i = 0; i < 40 && !hid; i++) {
    const info = await chipInfo(tracked, cdp);
    hid = info.present && info.hidden;
    if (!hid) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(hid, 'idle page chip must hide via storage sync after the mission ends elsewhere');
});

test('Gate 5: sustained research pace (40 rapid navigations) loses no observations and keeps the chip alive', async () => {
  // The hero use case: a fast, continuous research session in one tab.
  // ~3 companion messages per navigation x 40 navigations ≈ 120+/min on this
  // tab's sender key — above the historical 100/min budget (where the chip
  // vanished and tracking silently dropped), inside the corrected one.
  await resetState();
  await patchSettings({});
  // Roles from test 7 persist: extPage sends (extension origin), the
  // http-native httpPage is the tracked tab.
  const page = await plantMission('Rate cliff probe', extPage, httpPage);
  const started = Date.now();
  for (let i = 1; i <= 40; i++) {
    await page.goto(`${baseUrl}/r/${i}`);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const state = await waitForState(
    (s) => (activeSessionOf(s)?.nodes ?? []).filter((n) => n.url.includes('/r/')).length >= 40,
    'all 40 rapid observations recorded',
    20000
  );
  const rapidNodes = activeSessionOf(state).nodes.filter((n) => n.url.includes('/r/')).length;
  assert.equal(rapidNodes, 40, `every rapid navigation must be tracked (${rapidNodes}/40 in ${elapsed}s)`);

  const cdp = await context.newCDPSession(page);
  let chipVisible = false;
  for (let i = 0; i < 40 && !chipVisible; i++) {
    const info = await chipInfo(page, cdp);
    chipVisible = info.present && !info.hidden;
    if (!chipVisible) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(chipVisible, 'chip must survive a sustained research pace');
  console.log(`    Gate 5: 40 navigations in ${elapsed}s — ${rapidNodes}/40 tracked, chip alive`);
});

test('Gate 6: chip drag position persists across reload through extension-private storage, never page sessionStorage', async () => {
  // Audit F2 fix, in vivo: the remembered position must survive a reload via
  // the service worker's chrome.storage.session, and the host page's own
  // sessionStorage must never see it at any point.
  await resetState();
  await patchSettings({});
  // Roles from tests 7-8 persist: extPage sends (extension origin), the
  // http-native httpPage is the tracked tab. No extra renderer is spawned -
  // surplus tabs crash this sandbox after the rapid-navigation gate.
  const page = await plantMission('Chip position probe', extPage, httpPage);
  const cdp = await context.newCDPSession(page);
  try {
    let chipVisible = false;
    for (let i = 0; i < 40 && !chipVisible; i++) {
      const info = await chipInfo(page, cdp);
      chipVisible = info.present && !info.hidden;
      if (!chipVisible) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(chipVisible, 'chip must be visible on the tracked page while the mission is active');
    await new Promise((r) => setTimeout(r, 400)); // let slide-in and the origin ritual settle for stable box measurements
    const chipBefore = await chipBox(page, cdp);
    assert.ok(chipBefore, 'the chip box must be measurable before the drag');
    const seeds = await shadowAll(page, cdp, (n) => classOf(n).includes('chip-seed'));
    assert.ok(seeds.length >= 1, 'the drag handle must exist inside the closed shadow root');
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: seeds[0].backendNodeId });
    const [hx1, hy1, hx2, hy2] = model.content;
    const startX = (hx1 + hx2) / 2;
    const startY = (hy1 + hy2) / 2;
    const targetX = Math.max(60, startX - 220);
    const targetY = startY + 140;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + ((targetX - startX) * step) / 6, y: startY + ((targetY - startY) * step) / 6, button: 'left', buttons: 1 });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: targetY, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 250));
    const chipAfter = await chipBox(page, cdp);
    assert.ok(chipAfter, 'the chip box must be measurable after the drag');
    assert.ok(
      Math.abs(chipAfter.x - chipBefore.x) > 100 || Math.abs(chipAfter.y - chipBefore.y) > 100,
      `the drag must move the chip (before=${JSON.stringify(chipBefore)}, after=${JSON.stringify(chipAfter)})`
    );
    assert.equal(await page.evaluate(() => sessionStorage.getItem('ff-chip-pos')), null, 'the host page sessionStorage must never hold the chip position');
    await new Promise((r) => setTimeout(r, 400)); // let the immediate SET_CHIP_POS reach chrome.storage.session
    await page.reload();
    await page.waitForSelector('#intent-grove-root', { state: 'attached', timeout: 15000 });
    let restored = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      restored = await chipBox(page, cdp);
      if (restored && Math.abs(restored.x - chipAfter.x) <= 4 && Math.abs(restored.y - chipAfter.y) <= 4) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(
      restored && Math.abs(restored.x - chipAfter.x) <= 4 && Math.abs(restored.y - chipAfter.y) <= 4,
      `the position must survive reload via extension-private storage (after=${JSON.stringify(chipAfter)}, restored=${JSON.stringify(restored)})`
    );
    assert.equal(await page.evaluate(() => sessionStorage.getItem('ff-chip-pos')), null, 'the position must still never appear in page storage after restore');
  } finally {
    await cdp.detach().catch(() => {});
  }
});

test('Gate 7: title-only churn is time-throttled — one node, final title lands, no message flood', async () => {
  // The production breaker from the Phase 4 QA review, pinned in vivo: a page
  // mutating <title> every 200ms used to fire two worker messages per change.
  // With the 5s title throttle the node stays single, the trailing send
  // delivers the final title, and churn cannot spend the tab's rate budget.
  await resetState();
  const page = await plantMission('Title churn probe', extPage, httpPage);
  await page.goto(`${baseUrl}/churn`);
  await page.waitForTimeout(7000); // 1.6s of churn + the 5s trailing throttle window
  const state = await readState();
  const churnNodes = (activeSessionOf(state)?.nodes ?? []).filter((n) => n.url === `${baseUrl}/churn`);
  assert.equal(churnNodes.length, 1, 'title churn must never create duplicate nodes');
  assert.equal(churnNodes[0].title, 'Churn final', 'the trailing throttled send must deliver the final title');
});

test('no uncaught errors surfaced anywhere during the real-extension run', async () => {
  const real = [...swErrors, ...webErrors].filter((e) => !/rate limit/i.test(e));
  assert.deepEqual(real, [], 'service worker and pages must stay free of uncaught errors');
});
