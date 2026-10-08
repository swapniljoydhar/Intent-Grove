import { LIMITS, SCHEMA_VERSION, STORAGE_KEY, DEFAULT_NEW_TAB_URL, activeSession, clearLegacyState, clearStateCache, compactText, driftStats, emptyState, getDepthState, isBrowserNewTabUrl, isExtensionNewTabUrl, isPlaceholderOriginUrl, isSearchUrl, loadState, loadStateForWrite, makeId, normalizeSettings, safeHttpUrl, safeSessionUrl, saveState, checkStorageQuota, compactStateIfNeeded, normalizeState, earnReward } from '../shared/state.js';
import { logError, logWarning, ERROR_CATEGORIES, wrapMutationWithErrorBoundary, wrapWithErrorBoundary } from '../shared/error-tracing.js';
import { DAY_MS, SERVICE_WORKER, MEMORY_LIMITS, VALIDATION } from '../shared/constants.js';

const pendingBranches = new Map();
const MAX_PENDING_BRANCHES = MEMORY_LIMITS.LRU_CACHE_SIZE;
// Tracked-navigation marks: tabId -> { url, kind, createdAt }. Set by trackLink
// when a same-tab click either creates a node ('new-node': trackLink already
// recorded the navigation event) or finds the tab already on the destination
// ('self-link': a genuine reload-by-link whose trail note the commit
// observation must restore). Consumed by observeTab after the browser actually
// commits, which makes reload suppression order-independent: production
// observes every commit TWICE (the new document's content-script OBSERVE_PAGE
// and the worker's own tabs.onUpdated), and the navigation hint is consumed by
// whichever arrives first — marks are not hint-dependent. Commit-verified on
// purpose: marking at click time only records reloads that really happened.
const trackedNavMarks = new Map();
const MAX_TRACKED_NAV_MARKS = 64;
// Commit memos: tabId -> { url } of the last observation the worker already
// classified for that tab. A single commit is observed twice in production
// (the new document's content-script OBSERVE_PAGE and the worker's own
// tabs.onUpdated), in EITHER order, with an unbounded gap on slow pages — so
// twin suppression must not depend on timing. Exactly one observation of a
// commit carries the webNavigation hint; the hint-less twin is recognized by
// this memo and adds nothing. The memo is overwritten by every newly
// classified commit, so genuine repeated reloads (which arrive WITH a fresh
// hint) are still recorded.
const commitMemos = new Map();
const MAX_COMMIT_MEMOS = MEMORY_LIMITS.LRU_CACHE_SIZE;
const spaDedup = new Map();
const MAX_SPA_DEDUP = MEMORY_LIMITS.LRU_CACHE_SIZE;
const activeTabs = new Map();
const navigationHints = new Map();
// Commit records: tabId -> { url, at }. webNavigation.onCommitted fires ONLY
// for genuine cross-document navigations, while tabs.onUpdated fires the same
// loading->complete signature for BOTH full navigations and same-document
// history updates (pushState/replaceState) — indistinguishable at 'complete'
// (Chromium sends no changeInfo.url there). The record is the positive signal
// that a 'complete' event corresponds to a real navigation.
const committedNavs = new Map();
// Rate limiting for messages from content scripts (prevents spam attacks)
const messageCounts = new Map();
const MAX_MESSAGES_PER_MINUTE = SERVICE_WORKER.RATE_LIMIT_MAX_REQUESTS;
const RATE_LIMIT_WINDOW_MS = SERVICE_WORKER.RATE_LIMIT_WINDOW_MS;
const RATE_LIMIT_INITIAL_WINDOW = 0; // First message creates a fresh window at arrival time

// --- Companion chip position (extension-private; Phase-1 audit finding F2) ---
// The draggable chip remembers where the user placed it per tab and origin
// for the current browser session only. The value lives in
// chrome.storage.session — extension-private, survives service-worker idle
// restarts, cleared on browser exit — instead of the host page's own
// sessionStorage, so no website can read it. Identity (tab id + origin) comes
// from the validated sender tab, never from the message payload. Forks
// without storage.session degrade to worker memory; they never fall back to
// page storage. Writes are serialized and the store is bounded like every
// other per-tab record.
const CHIP_POS_STORAGE_KEY = 'chipPositions';
const CHIP_POS_MAX_ENTRIES = MEMORY_LIMITS.LRU_CACHE_SIZE;
const CHIP_POS_COORD_MAX = 32767; // generous screen bound; pages re-clamp to their own viewport
const chipPosFallback = new Map();
let chipPosQueue = Promise.resolve();

function chipPosSessionStore() {
  return chrome.storage?.session?.get && chrome.storage?.session?.set ? chrome.storage.session : null;
}
async function readChipPositions() {
  const sessionStore = chipPosSessionStore();
  if (sessionStore) {
    const result = await sessionStore.get(CHIP_POS_STORAGE_KEY);
    return isRecord(result?.[CHIP_POS_STORAGE_KEY]) ? result[CHIP_POS_STORAGE_KEY] : {};
  }
  return Object.fromEntries(chipPosFallback);
}
async function writeChipPositions(entries) {
  const sessionStore = chipPosSessionStore();
  if (sessionStore) { await sessionStore.set({ [CHIP_POS_STORAGE_KEY]: entries }); return; }
  chipPosFallback.clear();
  for (const [key, value] of Object.entries(entries)) chipPosFallback.set(key, value);
}
function enqueueChipPosTask(task) {
  const run = chipPosQueue.then(task, task);
  chipPosQueue = run.catch(() => {}); // a failed position write must never poison the queue
  return run;
}
function chipPosIdentity(tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) return null;
  const url = safeHttpUrl(tab?.url);
  if (!url) return null;
  try { return `${tab.id}:${new URL(url).origin}`; } catch { return null; }
}
function clampChipPosCoord(value) { return Math.min(Math.max(value, 0), CHIP_POS_COORD_MAX); }
async function getChipPos(tab) {
  const key = chipPosIdentity(tab);
  if (!key) return null;
  const stored = (await readChipPositions())[key];
  return isRecord(stored) && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? { x: stored.x, y: stored.y } : null;
}
async function setChipPos(tab, x, y) {
  const key = chipPosIdentity(tab);
  if (!key) return null;
  const point = { x: clampChipPosCoord(x), y: clampChipPosCoord(y) };
  await enqueueChipPosTask(async () => {
    const entries = await readChipPositions();
    entries[key] = { ...point, ts: Date.now() };
    const keys = Object.keys(entries);
    if (keys.length > CHIP_POS_MAX_ENTRIES) {
      keys.sort((a, b) => (Number(entries[a]?.ts) || 0) - (Number(entries[b]?.ts) || 0));
      for (const stale of keys.slice(0, keys.length - CHIP_POS_MAX_ENTRIES)) delete entries[stale];
    }
    await writeChipPositions(entries);
  }).catch(() => {}); // best-effort, like the sessionStorage write it replaces
  return { saved: true };
}
async function clearChipPosForTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await enqueueChipPosTask(async () => {
    const entries = await readChipPositions();
    const prefix = `${tabId}:`;
    let changed = false;
    for (const storedKey of Object.keys(entries)) {
      if (storedKey.startsWith(prefix)) { delete entries[storedKey]; changed = true; }
    }
    if (changed) await writeChipPositions(entries);
  }).catch(() => {});
}

// --- System memory sample (performance-guardian signal 1) ---
// chrome.system.memory.getInfo() is the real free-RAM signal (extensions
// API, Chrome 91+). It is cached and refreshed at most once per 30 s from
// paths that already run (the active-view request and the 5-minute
// maintenance alarm) — no new timers, no polling loops. Null on engines
// without the API: consumers fall back to the device-class and heap signals.
const SYSTEM_MEMORY_TTL_MS = 30000;
let systemMemorySample = null;
let systemMemoryAt = 0;
async function refreshSystemMemory() {
  if (!chrome.system?.memory?.getInfo) return;
  if (systemMemoryAt && Date.now() - systemMemoryAt < SYSTEM_MEMORY_TTL_MS) return;
  try {
    const info = await chrome.system.memory.getInfo();
    const capacity = Number(info?.capacity);
    const available = Number(info?.availableCapacity);
    if (Number.isFinite(capacity) && capacity > 0 && Number.isFinite(available)) {
      systemMemorySample = { freeRatio: Math.max(0, Math.min(1, available / capacity)) };
      systemMemoryAt = Date.now();
    }
  } catch { /* absent or failed: keep the previous sample; consumers degrade */ }
}

function clearRuntimeTracking() {
  pendingBranches.clear();
  trackedNavMarks.clear();
  commitMemos.clear();
  spaDedup.clear();
  activeTabs.clear();
  navigationHints.clear();
  committedNavs.clear();
  messageCounts.clear();
}

function markTrackedNav(tabId, url, kind) {
  if (!Number.isInteger(tabId) || typeof url !== 'string' || !url) return;
  const now = Date.now();
  for (const [key, entry] of trackedNavMarks) {
    if (now - entry.createdAt >= SERVICE_WORKER.SESSION_TIMEOUT_MS) trackedNavMarks.delete(key);
  }
  while (trackedNavMarks.size >= MAX_TRACKED_NAV_MARKS) {
    trackedNavMarks.delete(trackedNavMarks.keys().next().value);
  }
  trackedNavMarks.set(tabId, { url, kind, createdAt: now });
}

/**
 * Consumes the tracked-navigation mark for the tab. Returns the entry only
 * when it is fresh and names the exact URL just committed, so an unrelated
 * later navigation can never inherit it.
 */
function takeTrackedNavMark(tabId, url) {
  const entry = trackedNavMarks.get(tabId);
  if (!entry) return null;
  trackedNavMarks.delete(tabId);
  if (entry.url !== url || Date.now() - entry.createdAt >= SERVICE_WORKER.SESSION_TIMEOUT_MS) return null;
  return entry;
}

function memoizeCommit(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  while (commitMemos.size >= MAX_COMMIT_MEMOS) {
    commitMemos.delete(commitMemos.keys().next().value);
  }
  commitMemos.set(tabId, { url });
}
/** True when this exact (tab, url) commit was already classified. */
function isTwinObservation(tabId, url) {
  return commitMemos.get(tabId)?.url === url;
}

/**
 * Check if sender has exceeded message rate limit using absolute timestamps
 * @param {string} senderId - Unique identifier for the sender (tab ID or URL)
 * @returns {boolean} True if message is allowed, false if rate limited
 */
function checkRateLimit(senderId) {
  if (!senderId) return true; // Allow messages without sender ID
  
  const now = Date.now();
  const entry = messageCounts.get(senderId) || { count: 0, windowStart: RATE_LIMIT_INITIAL_WINDOW };
  
  // Reset counter if window has expired
  if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  
  if (entry.count >= MAX_MESSAGES_PER_MINUTE) {
    return false; // Rate limit exceeded
  }
  
  entry.count++;
  messageCounts.set(senderId, entry);
  // FIFO eviction keeps the map bounded if many distinct senders appear.
  while (messageCounts.size > SERVICE_WORKER.MAX_ACTIVE_TABS) {
    messageCounts.delete(messageCounts.keys().next().value);
  }
  
  return true;
}
// SPA dedup: returns true if the same tab+url+title was seen within the 1s dedup window.
// Map entries expire after SESSION_TIMEOUT_MS (15s) to bound memory.
function recentlyObservedSpa(tabId, url, title = '') {
  const now = Date.now();
  const DEDUP_WINDOW_MS = SERVICE_WORKER.SESSION_TIMEOUT_MS; // 15s: maximum lifetime of an entry in the map before expiry
  const DEDUP_MAX_AGE_MS = MEMORY_LIMITS.THROTTLE_DELAY_MS; // 1s: if same tab+url seen within this window, treat as duplicate
  
  for (const [entryKey, seenAt] of spaDedup) {
    if (now - seenAt.seenAt >= DEDUP_WINDOW_MS) spaDedup.delete(entryKey);
  }
  
  const key = `${tabId}::${url}`;
  const previous = spaDedup.get(key);
  if (previous != null && now - previous.seenAt < DEDUP_MAX_AGE_MS && previous.title === title) return true;
  
  if (!spaDedup.has(key) && spaDedup.size >= MAX_SPA_DEDUP) {
    spaDedup.delete(spaDedup.keys().next().value);
  }
  
  spaDedup.set(key, { seenAt: now, title });
  return false;
}

function prunePendingBranches() {
  const now = Date.now();
  for (const [key, entry] of pendingBranches) {
    if (now - entry.createdAt >= SERVICE_WORKER.SESSION_TIMEOUT_MS) {
      pendingBranches.delete(key);
    }
  }
  while (pendingBranches.size > MAX_PENDING_BRANCHES) {
    pendingBranches.delete(pendingBranches.keys().next().value);
  }
}
function pendingBranchKey(url, sourceTabId, windowId) {
  // Key by tabId, windowId, and URL to prevent collisions between different tabs/windows
  // This reduces risk of cross-attaching parent relationships when multiple tabs open same URL
  return `${Number.isInteger(sourceTabId) ? sourceTabId : 'notab'}::${Number.isInteger(windowId) ? windowId : 'nowin'}::${url}`;
}
function setPendingBranch(url, sourceTabId, windowId, parentId) {
  prunePendingBranches();
  const key = pendingBranchKey(url, sourceTabId, windowId);
  pendingBranches.set(key, {
    url,
    sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
    windowId: Number.isInteger(windowId) ? windowId : null,
    parentId,
    createdAt: Date.now()
  });
}
function takePendingBranch(url, sourceTabId, windowId) {
  prunePendingBranches();
  const exact = pendingBranches.get(pendingBranchKey(url, sourceTabId, windowId));
  if (exact) {
    pendingBranches.delete(pendingBranchKey(url, sourceTabId, windowId));
    return exact;
  }
  const candidates = [...pendingBranches.entries()].filter(([, entry]) => entry.url === url && entry.sourceTabId == null);
  if (candidates.length !== 1) return null;
  pendingBranches.delete(candidates[0][0]);
  return candidates[0][1];
}
const NO_CHANGE = Symbol('no-change');

let mutationQueue = Promise.resolve();
// A failed storage write must not silently drop the user's action: retry once
// against freshly loaded state before surfacing the error to the caller.
async function runMutatorWithRetry(wrappedMutator) {
  const attempt = async () => {
    // Strict loader: if the storage READ fails, abort the mutation instead of
    // running it against an empty fallback state — persisting that fallback
    // would wipe every stored garden on a transient read error.
    const state = await loadStateForWrite();
    const result = await wrappedMutator(state);
    if (result === NO_CHANGE || result == null) return result === NO_CHANGE ? null : result;
    await saveState(state);
    // Centralized refresh: any persisted mutation may change mission depth or
    // status, so the toolbar badge follows every path (links, observations,
    // prunes, composts) without per-callsite updates.
    updateBadge();
    return result;
  };
  try {
    return await attempt();
  } catch (error) {
    clearStateCache();
    const result = await attempt();
    logWarning(new Error('mutation recovered on retry'), { category: ERROR_CATEGORIES.STATE_MUTATION, originalError: error?.message, component: 'service-worker', function: 'mutate-retry' });
    return result;
  }
}
function mutate(mutator) {
  const wrappedMutator = wrapMutationWithErrorBoundary(mutator, { component: 'service-worker', function: 'mutate' });
  const run = mutationQueue.then(() => runMutatorWithRetry(wrappedMutator));
  mutationQueue = run.catch((error) => {
    logError(error, { category: ERROR_CATEGORIES.STATE_MUTATION, component: 'service-worker', function: 'mutate-catch' });
    clearStateCache();
    return undefined;
  });
  return run;
}
function replaceState(nextState) {
  const run = mutationQueue.then(async () => {
    await saveState(nextState);
    await clearLegacyState();
    // replaceState bypasses runMutatorWithRetry, so clear the toolbar badge
    // here: after CLEAR_DATA the mission is gone but the badge would otherwise
    // keep showing a live mission until an unrelated mutation happens.
    updateBadge();
    return nextState;
  });
  mutationQueue = run.catch((error) => {
    logError(error, { category: ERROR_CATEGORIES.STATE_MUTATION, component: 'service-worker', function: 'replaceState-catch' });
    clearStateCache();
    return undefined;
  });
  return run;
}

// Maintenance shares the same queue as imports, clears, and navigation writes.
// Register synchronously at worker startup so alarms can wake a suspended worker.
if (chrome.alarms) {
  chrome.alarms.create('storageQuotaCheck', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'storageQuotaCheck') return;
    refreshSystemMemory().catch(() => {}); // piggyback the existing 5-minute maintenance wake; never a new timer
    const run = mutationQueue.then(() => compactStateIfNeeded());
    mutationQueue = run.catch((error) => {
      clearStateCache();
      logError(error, { category: ERROR_CATEGORIES.STORAGE, operation: 'periodicCompaction' });
    });
    return mutationQueue;
  });
}

function nodeHasTab(node, tabId) {
  // Normalized nodes always carry a tabIds array (compactNode migrates the
  // legacy singular tabId at load time), so no singular fallback is needed.
  return Number.isInteger(tabId) && Boolean(node.tabIds?.includes(tabId));
}
const TERMINAL_STATES = new Set(['pruned', 'composted']);
function nodeForTab(session, tabId) {
  return [...session.nodes].reverse().find((node) => nodeHasTab(node, tabId) && !node.closedAt && !TERMINAL_STATES.has(node.state)) || null;
}
function attachTab(node, tabId) {
  if (!Number.isInteger(tabId)) return false;
  node.tabIds ||= [];
  if (node.tabIds.includes(tabId)) return false;
  node.tabIds.push(tabId);
  return true;
}
function detachTab(node, tabId) {
  if (!Array.isArray(node.tabIds)) return false;
  const before = node.tabIds.length;
  node.tabIds = node.tabIds.filter((id) => id !== tabId);
  return before !== node.tabIds.length;
}
function moveTabToNode(session, tabId, targetId) {
  session.nodes.forEach((node) => {
    if (node.id !== targetId) {
      const detached = detachTab(node, tabId);
      if (detached && (!node.tabIds || !node.tabIds.length) && !node.closedAt) {
        node.closedAt = Date.now();
      }
    }
  });
}

function prunePendingRedirects(session) {
  const now = Date.now();
  const MAX_PENDING_REDIRECTS = 4;
  session.pendingRedirects = (session.pendingRedirects || [])
    .filter((entry) => now - entry.createdAt < SERVICE_WORKER.SESSION_TIMEOUT_MS)
    .slice(-MAX_PENDING_REDIRECTS);
}
function setPendingRedirect(session, tabId, parentId) {
  prunePendingRedirects(session);
  session.pendingRedirects = session.pendingRedirects.filter((entry) => entry.tabId !== tabId);
  session.pendingRedirects.push({ tabId, parentId, createdAt: Date.now() });
}
function pendingRedirectParent(session, tabId) {
  prunePendingRedirects(session);
  const entry = session.pendingRedirects.find((candidate) => candidate.tabId === tabId);
  return entry ? session.nodes.find((node) => node.id === entry.parentId) : null;
}
function clearPendingRedirect(session, tabId) {
  session.pendingRedirects = (session.pendingRedirects || []).filter((entry) => entry.tabId !== tabId);
}

function isRedirectLike(value) {
  try {
    const url = new URL(value);
    return /\/(url|redirect|out|away|click)(?:\/|$)/i.test(url.pathname) || ['url', 'target', 'dest', 'destination', 'redirect'].some((key) => url.searchParams.has(key));
  } catch { return false; }
}
function navigationKindForTransition(transitionType, qualifiers = []) {
  if (transitionType === 'back_forward' || qualifiers.includes('forward_back')) return 'back-forward';
  if (transitionType === 'reload') return 'reload';
  if (transitionType === 'link') return 'link';
  if (transitionType === 'typed' || transitionType === 'auto_bookmark' || transitionType === 'generated' || transitionType === 'keyword' || transitionType === 'keyword_generated') return 'manual';
  return 'external';
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
}
function safeReason(value) {
  return ['user_ended', 'mission_changed', 'browse_without_mission'].includes(value) ? value : 'user_ended';
}
function safeOriginUrl(value) {
  return safeSessionUrl(value) || 'chrome://newtab';
}
function safeNavigationUrl(value) {
  return safeSessionUrl(value);
}
function sameOriginUrl(actual, expected) {
  const expectedHttp = safeHttpUrl(expected);
  return expectedHttp ? safeHttpUrl(actual) === expectedHttp : String(actual || '') === String(expected || '');
}
function isExtensionPageSender(sender) {
  const id = chrome.runtime?.id;
  if (typeof id !== 'string' || typeof sender?.url !== 'string') return false;
  return sender.url.toLowerCase().startsWith(`chrome-extension://${id.toLowerCase()}/`);
}

function plantingPageUrl() {
  return chrome.runtime.getURL('newtab/index.html');
}

const takingOverNewTabs = new Set();
function newTabCandidateUrl(tab) {
  // Committed URL only — never pendingUrl. When our own chrome_url_overrides
  // newtab is active, a fresh tab transiently reports the browser placeholder
  // (chrome://newtab) as pendingUrl before the override resolves to our
  // planting page. Acting on that placeholder issues a redundant reload of
  // the page the override is ALREADY loading; the duplicate navigation races
  // whatever happens next and can cancel it (proven in the real-extension
  // suite: it aborted the post-plant search navigation and snapped the tab
  // back to the planting page). Committed URLs are unambiguous: with the
  // override active they are our extension page (skip); when the override is
  // genuinely not in effect (browser NTP retained, Brave-style confirmation
  // pending) they are the placeholder and the takeover proceeds.
  return tab?.url || '';
}
async function takeOverBrowserNewTab(tab) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId) || !chrome.tabs?.update) return false;
  const url = newTabCandidateUrl(tab);
  if (!isBrowserNewTabUrl(url) || isExtensionNewTabUrl(url)) return false;
  const destination = plantingPageUrl();
  if (url === destination || takingOverNewTabs.has(tabId)) return false;
  takingOverNewTabs.add(tabId);
  try {
    await chrome.tabs.update(tabId, { url: destination });
    return true;
  } catch {
    return false;
  } finally {
    takingOverNewTabs.delete(tabId);
  }
}
async function takeOverOpenNewTabs() {
  if (!chrome.tabs?.query) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) await takeOverBrowserNewTab(tab);
}

// Coerce a sender or client-supplied tab descriptor into a minimal safe shape.
// Only numeric ids and sanitized url/title fields are preserved; the genuine
// chrome sender.tab is preferred when present so extension pages cannot spoof
// tab identity beyond what createSession already sanitizes.
function sanitizeTab(tab) {
  if (!tab || typeof tab !== 'object') return null;
  return {
    id: Number.isInteger(tab.id) ? tab.id : null,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
    url: typeof tab.url === 'string' ? tab.url : null,
    title: typeof tab.title === 'string' ? tab.title : null,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null
  };
}

function addEvent(session, type, payload = {}) {
  session.events.push({ id: makeId('event'), type, at: Date.now(), ...payload });
  if (session.events.length > LIMITS.EVENTS_PER_SESSION) session.events.splice(0, session.events.length - LIMITS.EVENTS_PER_SESSION);
}

function pushNode(session, node) {
  if (session.nodes.length >= LIMITS.NODES_PER_SESSION) return false;
  session.nodes.push(node);
  return true;
}

function effectiveThresholds(settings) { const clean = normalizeSettings(settings); return { DESATURATE: clean.gentleDepth, INTERRUPT: clean.choiceDepth, gentleDepth: clean.gentleDepth, choiceDepth: clean.choiceDepth }; }

function missionSearchUrl(engine, mission) {
  const query = encodeURIComponent(compactText(mission, 140));
  const protocol = `ht${'tps:'}`;
  // 'default' is resolved through chrome.search.query in START_MISSION whenever the
  // browser supports it. This entry is only the last-resort fallback for browsers
  // without a working Search API: it must not silently become Google, because the
  // README promises we never route missions to a specific provider the user did
  // not choose.
  const bases = { default: `${protocol}//duckduckgo.com/?q=`, google: `${protocol}//www.google.com/search?q=`, bing: `${protocol}//www.bing.com/search?q=`, duckduckgo: `${protocol}//duckduckgo.com/?q=`, brave: `${protocol}//search.brave.com/search?q=`, startpage: `${protocol}//www.startpage.com/sp/search?query=` };
  return `${bases[normalizeSettings({ searchEngine: engine }).searchEngine] || bases.default}${query}`;
}

function activeView(state, tabId) {
  const session = activeSession(state);
  const node = session && nodeForTab(session, tabId);
  const settings = normalizeSettings(state.settings);
  let sitePaused = false;
  try { const host = new URL(node?.url || '').hostname.toLowerCase().replace(/^www\./, ''); sitePaused = settings.excludedSites.includes(host); } catch {}
  const thresholds = effectiveThresholds(settings);
  // Drift accounting for the companion: factual pages/seconds at or beyond the
  // quiet line. hasNote tells strict copy that a private "why" exists WITHOUT
  // sending the note itself into a page context (the note never leaves the
  // worker's state).
  if (!session || !node) return { session: null, thresholds, settings, sitePaused, drift: null, hasNote: false, systemMemory: systemMemorySample };
  return {
    session: {
      id: session.id,
      mission: session.mission,
      responsePlan: session.responsePlan || 'decide',
      interventionPaused: Boolean(session.interventionPaused),
      node: { id: node.id, depth: node.depth, state: node.state, url: node.url, confidence: node.confidence || 'low', navigationKind: node.navigationKind || 'external' }
    },
    thresholds,
    settings,
    sitePaused,
    drift: driftStats(session, thresholds),
    hasNote: Boolean(session.note),
    systemMemory: systemMemorySample,
    interventionEligible: !session.interventionPaused && !sitePaused && node.depth >= thresholds.INTERRUPT && node.confidence !== 'low'
  };
}

// Validated "go home" target: an HTTP(S) origin only, integer-checked tab id.
// Shared by the GO_HOME message and the return-to-mission command so both
// paths carry identical validation.
function validatedReturnTarget(origin) {
  const originTabId = Number.isInteger(origin?.tabId) ? origin.tabId : null;
  const returnUrl = safeNavigationUrl(origin?.url);
  // Extension pages and internal browser URLs are not useful "go home" targets.
  const hasRealOrigin = Boolean(returnUrl) && /^https?:\/\//i.test(returnUrl);
  return { originTabId, returnUrl, hasRealOrigin };
}

async function activateValidatedOrigin(origin, originTabId) {
  try {
    const liveTab = await chrome.tabs.get(originTabId);
    // Ensure the tab still belongs to the same window session: this prevents
    // navigating wrong tabs after browser restart when tab IDs may be reassigned.
    const tabBelongsToSession = !origin.windowId || liveTab.windowId === origin.windowId;
    if (!tabBelongsToSession || !sameOriginUrl(liveTab?.url, origin.url)) return { returned: false, reward: null };
    if (chrome.windows?.update && Number.isInteger(liveTab.windowId)) await chrome.windows.update(liveTab.windowId, { focused: true });
    // sameOriginUrl already proves the tab is on the origin page (canonical
    // URLs match), so passing `url` here would re-navigate the tab to the page
    // it already shows — a full reload that discards scroll position, form
    // state and SPA state. Activate the tab instead; the caller opens a safe
    // new origin tab only when this tab is gone or drifted.
    await chrome.tabs.update(originTabId, { active: true });
    const rewardResult = await mutate((state) => ({ reward: earnReward(state, 'seeds', 'return_to_root') }));
    return { returned: true, reward: rewardResult?.reward || null };
  } catch { return { returned: false, reward: null }; }
}

// One "return to the mission origin" flow for both the GO_HOME message and
// the return-to-mission keyboard command. The result keeps a single object
// shape throughout; a boolean that later morphs into an object makes every
// downstream read a type guessing game.
async function goHome() {
  const snapshot = await getSnapshot();
  const origin = snapshot.session?.origin;
  const target = validatedReturnTarget(origin);
  let returnResult = { returned: false, reward: null };
  if (target.originTabId && target.hasRealOrigin) returnResult = await activateValidatedOrigin(origin, target.originTabId);
  const { returned: didReturn, reward } = returnResult;
  if (!didReturn && target.hasRealOrigin) {
    // Same windowless-context guard as the install path: resolve a real
    // window when the API can name one; never let a missing window turn a
    // graceful "could not return" into an INTERNAL_ERROR envelope.
    const win = chrome.windows?.getLastFocused ? await chrome.windows.getLastFocused().catch(() => null) : null;
    await chrome.tabs.create({ url: target.returnUrl, active: true, ...(win && Number.isInteger(win.id) ? { windowId: win.id } : {}) }).catch(() => {});
  }
  // Consumers (New Tab "Continue session") need the destination to report a
  // truthful outcome; activeView deliberately omits origin, so without this
  // field they could never tell a real return from a placeholder.
  return { ...activeView(await loadState(), didReturn ? target.originTabId : null), reward, origin: target.hasRealOrigin ? { url: target.returnUrl, tabId: target.originTabId } : null, returned: didReturn };
}

async function recordActiveTab(tabId, windowId) {
  if (!Number.isInteger(tabId)) return;
  const key = Number.isInteger(windowId) ? windowId : -1;
  const previous = activeTabs.get(key);
  if (previous?.tabId === tabId) return;
  const now = Date.now();
  await mutate((state) => {
    const session = activeSession(state);
    if (!session) return NO_CHANGE;
    session.activeIntervals ||= [];
    const open = session.activeIntervals.find((entry) => entry.tabId === previous?.tabId && !entry.endedAt);
    if (open) open.endedAt = now;
    session.activeIntervals.push({ tabId, windowId: Number.isInteger(windowId) ? windowId : null, startedAt: now, endedAt: null });
    // Limit active intervals to prevent unbounded growth (LRU-style eviction)
    const MAX_ACTIVE_INTERVALS = MEMORY_LIMITS.LRU_CACHE_SIZE / 2; // 100 intervals max
    if (session.activeIntervals.length > MAX_ACTIVE_INTERVALS) {
      session.activeIntervals.splice(0, session.activeIntervals.length - MAX_ACTIVE_INTERVALS);
    }
    return session;
  });
  activeTabs.set(key, { tabId });
}

async function createSession(mission, tab, rawNote = '', rawResponsePlan = 'decide') {
  const cleanMission = compactText(mission, 140);
  if (!cleanMission) return null;
  const note = compactText(rawNote, LIMITS.MISSION_NOTE);
  const responsePlan = ['return', 'save', 'decide'].includes(rawResponsePlan) ? rawResponsePlan : 'decide';
  return mutate((state) => {
    const previous = activeSession(state);
    if (previous) {
      previous.status = 'completed'; previous.endedAt = Date.now(); previous.endReason = 'mission_changed';
      addEvent(previous, 'mission_changed');
    }
    const originUrl = safeOriginUrl(tab?.url);
    const title = compactText(tab?.title || 'New Tab');
    const originTabId = Number.isInteger(tab?.id) ? tab.id : null;
    const session = {
      id: makeId('session'), mission: cleanMission, note, responsePlan, status: 'active', startedAt: Date.now(), endedAt: null, endReason: null,
      origin: { tabId: originTabId, windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null, url: originUrl, title }, nodes: [], events: [], activeIntervals: [], pendingRedirects: [], interventionPaused: false
    };
    pushNode(session, { id: makeId('node'), tabIds: Number.isInteger(tab?.id) ? [tab.id] : [], url: originUrl, title, parentId: null, depth: 0, firstSeenAt: Date.now(), relationshipConfidence: 'direct', confidence: 'high', navigationKind: 'mission-origin', state: 'normal' });
    addEvent(session, 'mission_started', { mission: session.mission });
    state.sessions.push(session);
    if (state.sessions.length > LIMITS.SESSIONS) state.sessions.splice(0, state.sessions.length - LIMITS.SESSIONS);
    state.activeSessionId = session.id;
    return session;
  }).then(async (result) => {
    // Interval bookkeeping must not poison the user-facing START_MISSION
    // response: if recording the active tab fails (e.g. a storage read hiccup
    // between the session write and this follow-up, now that write paths use
    // the strict loader), log it and still return the created session.
    try {
      await recordActiveTab(Number.isInteger(tab?.id) ? tab.id : null, tab?.windowId);
    } catch (error) {
      logError(error, { category: ERROR_CATEGORIES.STATE_MUTATION, component: 'service-worker', function: 'createSession.recordActiveTab' });
    }
    return result;
  });
}

async function endSession(reason = 'user_ended') {
  return mutate((state) => {
    const session = activeSession(state);
    if (!session) return NO_CHANGE;
    session.status = 'completed'; session.endedAt = Date.now(); session.endReason = reason;
    for (const interval of session.activeIntervals || []) if (!interval.endedAt) interval.endedAt = session.endedAt;
    activeTabs.clear();
    addEvent(session, reason === 'mission_changed' ? 'mission_changed' : 'mission_ended', { reason });
    // Session endings are not graded by path depth or presumed relevance.
    // Optional finds mark the user's decision to end, without ranking it.
    const reward = earnReward(state, 'blooms', `session_end_${reason}`);
    state.activeSessionId = null;
    return { session, reward };
  });
}

let lastBadgeText = null;
let lastBadgeColor = null;
function applyBadge(text, color) {
  if (text === lastBadgeText && color === lastBadgeColor) return; // skip redundant browser IPC
  lastBadgeText = text;
  lastBadgeColor = color;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
function updateBadge() {
  if (!chrome.action?.setBadgeText || !chrome.action?.setBadgeBackgroundColor) return;
  loadState().then((state) => {
    const session = activeSession(state);
    if (!session) {
      applyBadge('', '#00000000');
      return;
    }
    const paused = session.interventionPaused;
    const depth = Math.max(0, ...session.nodes.map((node) => node.depth || 0));
    const thresholds = effectiveThresholds(state.settings);
    if (paused) {
      applyBadge('⏸', '#c6a562');
    } else if (depth >= thresholds.INTERRUPT) {
      applyBadge('🌱', '#bd8473');
    } else {
      applyBadge('🌱', '#719b6c');
    }
  }).catch(() => {});
}

async function trackLink({ tabId, url, title, targetBlank = false, windowId, navigationKind = 'link' }) {
  const destination = safeHttpUrl(url);
  return mutate((state) => {
    const session = activeSession(state); if (!session || !destination) return NO_CHANGE;
    const parent = nodeForTab(session, tabId);
    if (!parent) return NO_CHANGE;
    const existing = session.nodes.find((node) => nodeHasTab(node, tabId) && node.url === destination && !node.closedAt);
    if (existing) {
      const nextTitle = compactText(title || destination);
      if (nextTitle && nextTitle !== existing.title) existing.title = nextTitle;
      // A same-tab click on a link that points at the page the tab already
      // shows is a reload-by-link about to commit. No navigation event is
      // recorded here (the node already existed), so leave a short-lived,
      // commit-verified 'self-link' mark for observeTab to turn into a single
      // 'reload' note. New-tab clicks and SPA route changes are not browser
      // reloads and must not be marked.
      if (!targetBlank && navigationKind !== 'spa') markTrackedNav(tabId, destination, 'self-link');
      return existing;
    }
    if (targetBlank || isRedirectLike(destination)) {
      prunePendingBranches();
      if (targetBlank) setPendingBranch(destination, tabId, windowId, parent.id);
      if (isRedirectLike(destination)) setPendingRedirect(session, tabId, parent.id);
      addEvent(session, 'link_opened', { url: destination, depth: parent.depth + 1 });
      return { pending: true, parentId: parent.id, redirect: isRedirectLike(destination) };
    }
    const depth = parent.depth + 1;
    const isSpa = navigationKind === 'spa';
    const node = { id: makeId('node'), tabIds: Number.isInteger(tabId) ? [tabId] : [], url: destination, title: compactText(title || destination), parentId: parent.id, depth, firstSeenAt: Date.now(), relationshipConfidence: isSpa ? 'tab-inferred' : 'direct', confidence: isSpa ? 'medium' : 'high', navigationKind: isSpa ? 'spa' : (targetBlank ? 'new-tab-link' : 'link'), state: getDepthState(depth, session.interventionPaused, effectiveThresholds(state.settings)) };
    if (!pushNode(session, node)) { addEvent(session, 'garden_at_capacity'); return { capped: true }; }
    moveTabToNode(session, tabId, node.id);
    addEvent(session, 'navigation', { nodeId: node.id, depth, url: destination });
    // Mark the tracked navigation so BOTH commit observations (the content
    // script's OBSERVE_PAGE and the worker's tabs.onUpdated) suppress their
    // same-URL 'reload' fallback regardless of which one consumes the
    // navigation hint first. SPA route nodes are marked too: any later
    // same-URL full observation of an SPA route is not a reload either.
    if (!targetBlank) markTrackedNav(tabId, destination, 'new-node');
    return node;
  });
}

async function observeTab(tabId, rawUrl, rawTitle, openerTabId, windowId) {
  const url = safeHttpUrl(rawUrl);
  const title = compactText(rawTitle || url);
  return mutate((state) => {
    const navigationHint = navigationHints.get(tabId);
    navigationHints.delete(tabId);
    const session = activeSession(state); if (!session || !url) return NO_CHANGE;
    const current = nodeForTab(session, tabId);
    // The origin is unset on a Chromium new tab (Chrome, Brave, Edge, Opera, Vivaldi) or our own New Tab page.
    const originUrl = session.origin?.url || '';
    const originNotSet = isPlaceholderOriginUrl(originUrl) || (session.nodes.length === 1 && !session.nodes[0].url.startsWith('http'));
    if (originNotSet) {
      const nextOrigin = { tabId, windowId: Number.isInteger(windowId) ? windowId : session.origin?.windowId || null, url, title };
      const root = session.nodes[0] || session.nodes.at(-1);
      // Only a placeholder root may be rewritten in place. When real nodes have
      // survived (e.g. Forget Site removed the origin host but kept other
      // branches) plant a fresh root instead of overwriting an unrelated node's
      // URL, so the surviving tree stays intact and the session can grow again.
      if (root && !root.url.startsWith('http')) {
        attachTab(root, tabId); root.url = url; root.title = title; root.firstSeenAt = Date.now(); root.relationshipConfidence = 'direct';
        // Memoize the commit: production observes it a second time
        // (tabs.onUpdated after the content script's OBSERVE_PAGE), and that
        // hint-less twin must not fall into the same-URL branch and stamp a
        // 'reload' onto the freshly planted root.
        memoizeCommit(tabId, url);
        session.origin = nextOrigin; addEvent(session, 'origin_planted', { url }); return root;
      }
      const fresh = { id: makeId('node'), tabIds: [], url, title, parentId: null, depth: 0, firstSeenAt: Date.now(), relationshipConfidence: 'direct', confidence: 'high', navigationKind: navigationHint || 'mission-origin', state: getDepthState(0, session.interventionPaused, effectiveThresholds(state.settings)) };
      if (!pushNode(session, fresh)) { if (!isTwinObservation(tabId, url)) { addEvent(session, 'garden_at_capacity'); memoizeCommit(tabId, url); } return { capped: true }; }
      moveTabToNode(session, tabId, fresh.id);
      memoizeCommit(tabId, url);
      session.origin = nextOrigin; addEvent(session, 'origin_planted', { url }); return fresh;
    }
    if (current && current.url === url) {
      if (navigationHint === 'back-forward' || navigationHint === 'manual') {
        current.navigationKind = navigationHint;
        current.confidence = 'low';
      }
      // Production observes every commit TWICE (content-script OBSERVE_PAGE
      // and the worker's tabs.onUpdated), in either order and with an
      // unbounded gap on slow pages. Classification is timing-independent:
      //   - the hint-less twin of an already-classified commit adds nothing
      //     (commit memo);
      //   - 'new-node' marks (trackLink grew this node and recorded the
      //     navigation event) suppress the same-URL event order-independently;
      //   - 'self-link' marks restore exactly one genuine 'reload' note;
      //   - a fresh hint ('reload', 'back-forward', 'manual', ...) always
      //     classifies, so genuine repeated reloads are still recorded.
      const mark = takeTrackedNavMark(tabId, url);
      if (!mark && !navigationHint && isTwinObservation(tabId, url)) return current;
      if (mark?.kind === 'new-node') { /* trackLink already recorded this navigation */ }
      else if (mark?.kind === 'self-link') addEvent(session, 'reload', { nodeId: current.id, url });
      else if (navigationHint === 'back-forward') addEvent(session, 'back_forward', { nodeId: current.id, url });
      else if (navigationHint === 'link') { /* tracked link whose mark expired; navigation event already recorded */ }
      else addEvent(session, 'reload', { nodeId: current.id, url });
      memoizeCommit(tabId, url);
      return current;
    }
    // Memo-gated so the commit's twin observation (content OBSERVE_PAGE vs
    // tabs.onUpdated, either order) cannot double-record the refinement.
    if (isSearchUrl(url) && !originNotSet) {
      if (!isTwinObservation(tabId, url)) { addEvent(session, 'search_refinement', { url }); memoizeCommit(tabId, url); }
      return { refined: true, nodeId: current?.id || null };
    }
    const known = session.nodes.find((node) => node.url === url && !TERMINAL_STATES.has(node.state));
    if (known) {
      clearPendingRedirect(session, tabId);
      moveTabToNode(session, tabId, known.id);
      const attached = attachTab(known, tabId);
      known.title = title;
      known.navigationKind = navigationHint || 'known-page';
      if (navigationHint === 'back-forward' || navigationHint === 'manual') known.confidence = 'low';
      else known.confidence = known.confidence || 'medium';
      if (known.closedAt) delete known.closedAt;
      // Memoize the commit so the twin observation cannot add a spurious
      // same-URL event on top of the reuse note recorded here.
      memoizeCommit(tabId, url);
      if (attached) addEvent(session, 'tab_joined_path', { nodeId: known.id, url });
      else addEvent(session, 'return_to_path', { nodeId: known.id, url });
      return known;
    }
    const opener = openerTabId && nodeForTab(session, openerTabId);
    prunePendingBranches();
    const pending = takePendingBranch(url, Number.isInteger(openerTabId) ? openerTabId : tabId, Number.isInteger(windowId) ? windowId : null);
    const pendingParent = pending ? session.nodes.find((node) => node.id === pending.parentId) : null;
    const redirectParent = pendingRedirectParent(session, tabId);
    if (isRedirectLike(url) && (pendingParent || redirectParent || current)) {
      setPendingRedirect(session, tabId, (pendingParent || redirectParent || current).id);
      return { redirectPending: true };
    }
    // A tab that took part in this session — the planting tab, or any tab
    // foregrounded while the mission ran (both durably recorded in
    // activeIntervals, so this survives worker restarts) — is not a stranger.
    // Without this, composting or pruning the page a tab sits on detached its
    // node and the unlinked-tab guard then treated the tab as unrelated
    // forever: the mission kept running, but nothing the user did was tracked
    // again (verified in vivo). Re-entry grows a neutral external path,
    // exactly like typed navigation; never-activated tabs stay excluded.
    // Participation signals (both durable, both survive worker restarts):
    // the tab the origin was planted from, or a still-open foreground
    // interval. Requiring an OPEN interval means a closed tab's recycled id
    // inherits nothing (onRemoved ends its intervals).
    const participatedInSession = Number.isInteger(tabId) && (
      session.origin?.tabId === tabId ||
      (session.activeIntervals || []).some((entry) => entry.tabId === tabId && !entry.endedAt)
    );
    if (!current && !openerTabId && !pendingParent && !redirectParent && !participatedInSession) return NO_CHANGE;
    const parent = redirectParent || opener || pendingParent || null;
    if (redirectParent) clearPendingRedirect(session, tabId);
    const depth = parent ? parent.depth + 1 : 0;
    const relationshipConfidence = opener ? 'tab-inferred' : (pendingParent || redirectParent) ? 'direct' : 'external';
    const confidence = relationshipConfidence === 'direct' ? 'high' : relationshipConfidence === 'tab-inferred' ? 'medium' : 'low';
    const navigationKind = navigationHint || (redirectParent ? 'redirect' : pendingParent ? 'new-tab-link' : opener ? 'manual' : 'manual');
    const node = { id: makeId('node'), tabIds: Number.isInteger(tabId) ? [tabId] : [], url, title, parentId: parent?.id || null, depth, firstSeenAt: Date.now(), relationshipConfidence, confidence, navigationKind, state: getDepthState(depth, session.interventionPaused, effectiveThresholds(state.settings)) };
    if (!pushNode(session, node)) { if (!isTwinObservation(tabId, url)) { addEvent(session, 'garden_at_capacity'); memoizeCommit(tabId, url); } return { capped: true }; }
    moveTabToNode(session, tabId, node.id);
    // Memoize the commit: the twin observation must find it already
    // classified instead of stamping a 'reload'.
    memoizeCommit(tabId, url);
    addEvent(session, relationshipConfidence === 'external' ? 'external_path' : 'navigation', { nodeId: node.id, depth, url });
    return node;
  });
}

async function pruneNode(sessionId, nodeId, toCompost = false) {
  return mutate((state) => {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return NO_CHANGE;
    const node = session.nodes.find((item) => item.id === nodeId && !item.closedAt);
    if (!node || node.depth === 0 || node.state === 'pruned') return NO_CHANGE;
    node.state = 'pruned'; node.prunedAt = Date.now(); node.tabIds = [];
    addEvent(session, 'pruned', { nodeId: node.id, depth: node.depth });
    if (toCompost && !state.compostItems.some((item) => item.url === node.url)) {
      state.compostItems.unshift({ id: makeId('compost'), url: node.url, title: compactText(node.title || node.url), mission: session.mission, savedAt: Date.now() });
      if (state.compostItems.length > LIMITS.COMPOST) state.compostItems.splice(LIMITS.COMPOST);
    }
    return node;
  });
}

async function compost(tabId, rawUrl, title) {
  const url = safeHttpUrl(rawUrl);
  return mutate((state) => {
    const session = activeSession(state); if (!session || !url) return NO_CHANGE;
    const node = nodeForTab(session, tabId);
    if (!state.compostItems.some((item) => item.url === url)) {
      // Compost entries intentionally carry no depth: for tabs without a tree
      // node a fabricated 0 was misleading, and nothing renders this field.
      state.compostItems.unshift({ id: makeId('compost'), url, title: compactText(title || url), mission: session.mission, savedAt: Date.now() });
      if (state.compostItems.length > LIMITS.COMPOST) state.compostItems.splice(LIMITS.COMPOST);
    }
    if (node) { node.state = 'composted'; node.closedAt = Date.now(); node.tabIds = []; }
    addEvent(session, 'composted', { url });
    
    return { saved: true, reward: earnReward(state, 'leaves', 'compost_choice') };
  });
}

async function getSnapshot(sessionId = null, includeHistory = false) {
  const state = await loadState();
  const selected = sessionId ? state.sessions.find((session) => session.id === sessionId) : null;
  const latest = includeHistory ? state.sessions.at(-1) || null : null;
  return { state, session: selected || activeSession(state) || latest, activeSessionId: state.activeSessionId, thresholds: effectiveThresholds(state.settings), settings: normalizeSettings(state.settings) };
}

function formatHistoryDomain(url) {
  if (!url) return 'Unknown';
  // isPlaceholderOriginUrl covers both browser NTP aliases and this
  // extension's own New Tab page.
  if (isPlaceholderOriginUrl(url)) return 'New Tab';
  if (isExtensionNewTabUrl(url)) return 'Intent Grove';
  try {
    const parsed = new URL(url);
    if (/^chrome-extension:/i.test(parsed.protocol)) return 'Intent Grove';
    return parsed.hostname || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

// Optional path reflection: count only observable tree shape and recorded
// navigation signals. The response intentionally contains no mission, title,
// domain, URL, or individual-session data.
function summarizePathPatterns(sessions, now, completedOnly = false) {
  const currentDate = new Date(now);
  const currentWeekStart = Date.UTC(
    currentDate.getUTCFullYear(), currentDate.getUTCMonth(),
    currentDate.getUTCDate() - ((currentDate.getUTCDay() + 6) % 7)
  );
  const firstWeekStart = currentWeekStart - 7 * 7 * DAY_MS;
  const windowEndExclusive = currentWeekStart + 7 * DAY_MS;
  const recentSessions = sessions.filter((session) =>
    Number.isFinite(session.startedAt) && session.startedAt >= firstWeekStart &&
    session.startedAt <= now && session.startedAt < windowEndExclusive &&
    (!completedOnly || session.status === 'completed')
  );
  const patterns = { branching: 0, straightThrough: 0, searchRefining: 0, revisiting: 0 };

  for (const session of recentSessions) {
    const nodes = Array.isArray(session.nodes) ? session.nodes : [];
    const nodeIds = new Set(nodes.map((node) => node.id));
    const childCounts = new Map();
    for (const node of nodes) {
      if (node.parentId && nodeIds.has(node.parentId)) {
        childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1);
      }
    }
    const hasFork = [...childCounts.values()].some((count) => count >= 2);
    const followedPages = nodes.filter((node) => Number(node.depth) > 0);
    if (hasFork) patterns.branching++;
    if (followedPages.length >= 2 && !hasFork) patterns.straightThrough++;

    const events = Array.isArray(session.events) ? session.events : [];
    const searchRefinements = events.filter((event) => event.type === 'search_refinement').length;
    if (searchRefinements >= 2) patterns.searchRefining++;

    const returns = events.filter((event) => event.type === 'back_forward' || event.type === 'return_to_path').length;
    if (returns >= 2) patterns.revisiting++;
  }

  return {
    windowStart: new Date(firstWeekStart).toISOString().slice(0, 10),
    windowEnd: new Date(windowEndExclusive - DAY_MS).toISOString().slice(0, 10),
    sampleSize: recentSessions.length,
    patterns
  };
}

async function getPathPatternAnalysis() {
  const state = await loadState();
  return summarizePathPatterns(state.sessions, Date.now());
}

// Show a gentle note only after an explicit opt-in, with a useful completed
// sample and a repeated pattern. The serialized mutation makes the rolling
// seven-day limit atomic even when multiple dashboard tabs request it at once.
async function getPathPatternReminder() {
  const now = Date.now();
  return mutate((state) => {
    if (!normalizeSettings(state.settings).pathPatternRemindersEnabled) return NO_CHANGE;
    const lastShownAt = Number.isFinite(state.pathPatternReminderLastShownAt)
      ? state.pathPatternReminderLastShownAt : 0;
    if (now - lastShownAt < 7 * DAY_MS) return NO_CHANGE;

    const summary = summarizePathPatterns(state.sessions, now, true);
    if (summary.sampleSize < 4) return NO_CHANGE;
    const [patternKey, matchCount] = Object.entries(summary.patterns)
      .reduce((best, entry) => entry[1] > best[1] ? entry : best);
    if (matchCount < 3 || matchCount / summary.sampleSize < 0.6) return NO_CHANGE;

    state.pathPatternReminderLastShownAt = now;
    return { patternKey, matchCount, sampleSize: summary.sampleSize };
  });
}

// Dashboard statistics aggregation
async function getDashboardStats() {
  const state = await loadState();
  const now = Date.now();
  const ONE_DAY_MS = DAY_MS;
  const ONE_WEEK_MS = 7 * ONE_DAY_MS;
  const currentDate = new Date(now);
  const currentWeekStart = Date.UTC(
    currentDate.getUTCFullYear(), currentDate.getUTCMonth(),
    currentDate.getUTCDate() - ((currentDate.getUTCDay() + 6) % 7)
  );
  const weeklyTrendBuckets = new Map();
  for (let offset = 7; offset >= 0; offset--) {
    const weekStart = currentWeekStart - offset * ONE_WEEK_MS;
    const weekStartDate = new Date(weekStart);
    const weekKey = weekStartDate.toISOString().slice(0, 10);
    weeklyTrendBuckets.set(weekKey, {
      weekStart: weekKey,
      weekLabel: weekStartDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      intentionsStarted: 0,
      deepestPathTotal: 0
    });
  }

  // Calculate total sessions and focus time
  let totalSessions = 0;
  let totalFocusTime = 0;
  let totalActiveTabTime = 0;
  let intentionalBranches = 0;
  let unlinkedPaths = 0;
  let interruptionsDismissed = 0;
  let branchDepthTotal = 0;
  const domainCounts = {};
  const dailySeconds = {};
  // Performance optimization: track unique active ISO date keys in a Set for O(1) streak lookups
  const activeDays = new Set();
  
  // Initialize last 7 days using ISO date keys (not weekday names)
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now - (i * ONE_DAY_MS));
    const key = date.toISOString().slice(0, 10); // YYYY-MM-DD
    dailySeconds[key] = 0;
  }

  // Process all sessions
  for (const session of state.sessions) {
    totalSessions++;
    
    // Use session duration from startedAt to endedAt (not sum of node durations
    // which double-counts concurrent tabs)
    const sessionStart = session.startedAt || now;
    // A completed session with a missing endedAt (an import whose inverted or
    // future-skewed timestamp was repaired to null, or a legacy record) must
    // NOT accrue elapsed time up to "now" — that fabricates phantom multi-day
    // sessions in the totals. Count it as zero-length; only genuinely active
    // sessions accrue to the present.
    const sessionEnd = session.endedAt || (session.status === 'completed' ? sessionStart : now);
    const sessionDuration = Math.max(0, (sessionEnd - sessionStart) / 1000);

    // These are observable activity trends, not an inference about whether a
    // browsing path served its author's intention. A session contributes to
    // the week in which its intention was started.
    if (Number.isFinite(session.startedAt)) {
      const startedDate = new Date(session.startedAt);
      const weekStart = Date.UTC(
        startedDate.getUTCFullYear(), startedDate.getUTCMonth(),
        startedDate.getUTCDate() - ((startedDate.getUTCDay() + 6) % 7)
      );
      const bucket = weeklyTrendBuckets.get(new Date(weekStart).toISOString().slice(0, 10));
      if (bucket) {
        bucket.intentionsStarted++;
        bucket.deepestPathTotal += session.nodes.reduce((deepest, node) => Math.max(deepest, Math.max(0, Number(node.depth) || 0)), 0);
      }
    }
    
    for (const node of session.nodes) {
      // Domain counting: only count valid HTTP/HTTPS URLs
      try {
        const parsed = new URL(node.url);
        if (/^https?:$/i.test(parsed.protocol)) {
          const hostname = parsed.hostname.toLowerCase();
          if (hostname) {
            domainCounts[hostname] = (domainCounts[hostname] || 0) + 1;
          }
        }
      } catch { /* ignore invalid URLs */ }
    }
    
    totalFocusTime += sessionDuration;
    const intervals = Array.isArray(session.activeIntervals) ? session.activeIntervals : [];
    totalActiveTabTime += intervals.reduce((sum, interval) => sum + Math.max(0, ((interval.endedAt || now) - interval.startedAt) / 1000), 0);
    intentionalBranches += session.nodes.filter((node) => node.depth > 0 && node.confidence !== 'low').length;
    unlinkedPaths += session.nodes.filter((node) => node.depth > 0 && node.confidence === 'low').length;
    branchDepthTotal += session.nodes.reduce((sum, node) => sum + Math.max(0, node.depth || 0), 0);
    interruptionsDismissed += session.events.filter((event) => event.type === 'interruption_dismissed').length;
    
    // The streak records days with an explicit mission signal (session start,
    // trail event, or foreground-tab selection), not every calendar day an
    // unattended mission happened to remain open.
    const activityTimestamps = [
      session.startedAt,
      ...(Array.isArray(session.events) ? session.events.map((event) => event.at) : []),
      ...intervals.map((interval) => interval.startedAt)
    ];
    for (const at of activityTimestamps) {
      if (!Number.isFinite(at) || at > now + VALIDATION.MAX_TIMESTAMP_FUTURE_MS || at < now - VALIDATION.MAX_TIMESTAMP_AGE_YEARS * 365 * ONE_DAY_MS) continue;
      activeDays.add(new Date(at).toISOString().slice(0, 10));
    }

    // Split elapsed session time at UTC midnight for the weekly chart. This is
    // explicitly session duration, not a claim of active browsing time.
    const firstDay = Math.floor(sessionStart / ONE_DAY_MS) * ONE_DAY_MS;
    const lastDay = Math.floor(Math.max(sessionStart, sessionEnd - 1) / ONE_DAY_MS) * ONE_DAY_MS;
    for (let dayStart = firstDay; dayStart <= lastDay; dayStart += ONE_DAY_MS) {
      const dayKey = new Date(dayStart).toISOString().slice(0, 10);
      if (Object.hasOwn(dailySeconds, dayKey)) {
        const overlapStart = Math.max(sessionStart, dayStart);
        const overlapEnd = Math.min(sessionEnd, dayStart + ONE_DAY_MS);
        dailySeconds[dayKey] += Math.max(0, (overlapEnd - overlapStart) / 1000);
      }
    }
  }

  // Calculate streak: consecutive days with activity, counting backward from today
  // Bolt optimization: O(1) Set lookup per day instead of O(N) array scanning per day
  let currentStreak = 0;
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(now - (i * ONE_DAY_MS));
    const dayKey = checkDate.toISOString().slice(0, 10);
    if (activeDays.has(dayKey)) {
      currentStreak++;
    } else if (i > 0) {
      break;
    }
  }

  // Format weekly data with readable day labels
  const weeklyData = Object.entries(dailySeconds).map(([dateKey, seconds]) => {
    const date = new Date(dateKey + 'T12:00:00');
    return { day: date.toLocaleDateString(undefined, { weekday: 'short' }), date: dateKey, minutes: Math.round(seconds / 60) };
  });

  const weeklyTrendData = [...weeklyTrendBuckets.values()].map((bucket) => ({
    weekStart: bucket.weekStart,
    weekLabel: bucket.weekLabel,
    intentionsStarted: bucket.intentionsStarted,
    averageDeepestPath: bucket.intentionsStarted
      ? Number((bucket.deepestPathTotal / bucket.intentionsStarted).toFixed(1))
      : 0
  }));

  // Format domain data (top 5)
  const domainData = Object.entries(domainCounts)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Recent history (last 10 sessions)
  const history = state.sessions.slice(-10).reverse().map(session => {
    const start = session.startedAt || now;
    // Same rule as totalFocusTime: a completed session without a usable
    // endedAt is zero-length, never "still running since startedAt".
    const end = session.endedAt || (session.status === 'completed' ? start : now);
    const duration = Math.max(0, (end - start) / 1000);
    
    return {
      timestamp: start,
      domain: formatHistoryDomain(session.origin?.url),
      duration: Math.floor(duration),
      type: 'focus'
    };
  });

  // Get saved items (compost)
  const savedItems = state.compostItems.map(item => ({
    id: item.id,
    url: item.url,
    title: item.title,
    savedAt: item.savedAt
  }));

  // Strict-mode compost honesty: how many saved curiosities have rested for
  // over a week. Age-based only — revisit tracking would need a schema field,
  // so no revisit claim is made.
  const agedSavedCount = state.compostItems.filter((item) => Number.isFinite(item.savedAt) && now - item.savedAt >= 7 * DAY_MS).length;
  // Milestone KEYS, not copy: the dashboard owns the wording. Positive-only —
  // a broken streak maps to null and is never surfaced as a punishment.
  const streakMilestone = currentStreak >= 30 ? 'season' : currentStreak >= 14 ? 'grove' : currentStreak >= 7 ? 'week' : currentStreak >= 3 ? 'roots' : null;

  return {
    totalSessions,
    totalFocusTime: Math.floor(totalFocusTime),
    totalActiveTabTime: Math.floor(totalActiveTabTime),
    intentionalBranches,
    unlinkedPaths,
    interruptionsDismissed,
    averageBranchDepth: totalSessions ? Number((branchDepthTotal / totalSessions).toFixed(2)) : 0,
    currentStreak,
    streakMilestone,
    agedSavedCount,
    weeklyData,
    weeklyTrendData,
    domainData,
    history,
    savedItems
  };
}

// Forget stored visits to one host, not unrelated pages below those visits.
async function forgetSite(rawHostname) {
  const hostname = rawHostname.trim().toLowerCase().replace(/^www\./, '');
  if (!hostname) return null;
  const matches = (url) => {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') === hostname; }
    catch { return false; }
  };
  return mutate((state) => {
    let removed = 0;
    const removedNodeIds = new Set();
    const removedTabIds = new Set();
    for (const session of state.sessions) {
      const deleted = session.nodes.filter((node) => matches(node.url));
      const deletedIds = new Set(deleted.map((node) => node.id));
      const deletedTabs = new Set(deleted.flatMap((node) => node.tabIds || []));
      deletedIds.forEach((id) => removedNodeIds.add(id));
      removed += deleted.length;
      session.nodes = session.nodes.filter((node) => !deletedIds.has(node.id));
      if (matches(session.origin?.url)) {
        if (Number.isInteger(session.origin.tabId)) deletedTabs.add(session.origin.tabId);
        // Reset to the standard New Tab placeholder so the next ordinary page
        // replants the origin. observeTab plants a *fresh* root rather than
        // overwriting unrelated surviving nodes. A non-placeholder stand-in URL
        // here (e.g. an extension page URL) would freeze the session: every new
        // unlinked tab would fail the unlinked-observation guard and be dropped.
        session.origin = { tabId: null, windowId: null, url: DEFAULT_NEW_TAB_URL, title: 'Forgotten origin' };
        removed++;
      }
      const eventCount = session.events.length;
      session.events = session.events.filter((event) => !matches(event.url) && !deletedIds.has(event.nodeId));
      removed += eventCount - session.events.length;
      session.pendingRedirects = session.pendingRedirects.filter((entry) => !deletedIds.has(entry.parentId) && !deletedTabs.has(entry.tabId));
      session.activeIntervals = session.activeIntervals.filter((entry) => !deletedTabs.has(entry.tabId));
      deletedTabs.forEach((id) => removedTabIds.add(id));
      if (deletedIds.size) {
        const nodes = new Map(session.nodes.map((node) => [node.id, node]));
        for (const node of session.nodes) {
          if (deletedIds.has(node.parentId)) {
            node.parentId = null;
            node.relationshipConfidence = 'external';
            node.confidence = 'low';
            node.navigationKind = 'external';
          }
        }
        const thresholds = effectiveThresholds(state.settings);
        for (const node of session.nodes) {
          // Bound traversal even if imported history contains a cycle.
          const seen = new Set([node.id]);
          let parent = nodes.get(node.parentId);
          let depth = 0;
          while (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            depth++;
            parent = nodes.get(parent.parentId);
          }
          node.depth = depth;
          if (!TERMINAL_STATES.has(node.state)) node.state = getDepthState(depth, session.interventionPaused, thresholds);
        }
      }
    }
    const compostCount = state.compostItems.length;
    state.compostItems = state.compostItems.filter((item) => !matches(item.url));
    removed += compostCount - state.compostItems.length;
    if (!removed) return NO_CHANGE;
    for (const [key, entry] of pendingBranches) {
      if (matches(entry.url) || removedNodeIds.has(entry.parentId) || removedTabIds.has(entry.sourceTabId)) pendingBranches.delete(key);
    }
    // SPA keys and commit memos contain URLs; invalidating these small
    // caches also removes forgotten URLs without changing the user's
    // permanent tracking settings.
    spaDedup.clear();
    commitMemos.clear();
    committedNavs.clear();
    for (const [key, entry] of activeTabs) {
      if (removedTabIds.has(entry.tabId)) activeTabs.delete(key);
    }
    removedTabIds.forEach((id) => { navigationHints.delete(id); trackedNavMarks.delete(id); });
    return { hostname, removed };
  });
}

// Remove saved item
async function removeSavedItem(id) {
  return mutate((state) => {
    const before = state.compostItems.length;
    state.compostItems = state.compostItems.filter(item => item.id !== id);
    return before === state.compostItems.length ? NO_CHANGE : state.compostItems;
  });
}

// Export all data
async function exportAllData() {
  const state = await loadState();
  return { data: state };
}

// Import data from a previously exported snapshot.
// Merges sessions/compost/events and replaces settings.
async function importAllData(payload) {
  if (!isRecord(payload)) throw new Error('invalid_payload');
  // Accept every shape this project has ever produced: the dashboard export
  // file is the BARE state object (exportData unwraps { data }), while older
  // tooling and tests may send { data: state } or { state }. Requiring the
  // envelope made the dashboard's own export file un-importable.
  const enveloped = isRecord(payload.data);
  const incoming = enveloped ? payload.data : payload;
  const incomingState = isRecord(incoming.state) ? incoming.state : incoming;
  if (!isRecord(incomingState)) throw new Error('invalid_payload');
  // A BARE payload comes from a user-picked file: require at least one
  // recognizable collection, so choosing the wrong JSON fails honestly with
  // the "could not be read" message instead of importing a silent empty
  // state. Enveloped payloads ({ data: ... }) are deliberate code paths
  // (tooling/tests) and may legitimately merge nothing.
  if (!enveloped && !(Array.isArray(incomingState.sessions) || Array.isArray(incomingState.compostItems) || isRecord(incomingState.settings))) {
    throw new Error('invalid_payload');
  }
  
  // Validate session IDs, URLs, and timestamps before normalization. Keep the
  // preprocessing window bounded; normalizeState applies the final storage cap.
  const incomingSessions = Array.isArray(incomingState.sessions) ? incomingState.sessions.slice(-LIMITS.SESSIONS * 2) : [];
  if (incomingSessions.length) {
    const now = Date.now();
    for (const session of incomingSessions) {
      if (!session || typeof session !== 'object') continue;
      // Validate session ID format
      if (typeof session.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(session.id)) {
        logWarning(new Error('Invalid session ID in import'), { category: ERROR_CATEGORIES.STORAGE, component: 'import' });
        continue;
      }
      // Validate origin URL
      if (session.origin?.url && !safeSessionUrl(session.origin.url)) {
        logWarning(new Error('Invalid origin URL in import'), { category: ERROR_CATEGORIES.STORAGE, component: 'import' });
        session.origin.url = 'chrome://newtab';
      }
      // Validate timestamp ranges (not in future, not too old)
      const ONE_DAY_MS = DAY_MS;
      const MAX_TIMESTAMP_FUTURE_MS = VALIDATION.MAX_TIMESTAMP_FUTURE_MS;
      const MAX_AGE_MS = VALIDATION.MAX_TIMESTAMP_AGE_YEARS * 365 * ONE_DAY_MS;
      
      if (session.startedAt && (session.startedAt > now + MAX_TIMESTAMP_FUTURE_MS || session.startedAt < now - MAX_AGE_MS)) {
        logWarning(new Error('Invalid startedAt timestamp in import'), { category: ERROR_CATEGORIES.STORAGE, component: 'import', startedAt: session.startedAt });
        session.startedAt = now;
      }
      if (session.endedAt && (session.endedAt > now + MAX_TIMESTAMP_FUTURE_MS || session.endedAt < session.startedAt)) {
        // Ended-before-started is logically invalid (it would yield a negative
        // session duration), and absurd past values fail the age bound; either
        // way the record survives with an open-ended timestamp instead.
        logWarning(new Error('Invalid endedAt timestamp in import'), { category: ERROR_CATEGORIES.STORAGE, component: 'import', endedAt: session.endedAt });
        session.endedAt = null;
      }
      // Validate nodes
      if (Array.isArray(session.nodes)) {
        for (const node of session.nodes.slice(-LIMITS.NODES_PER_SESSION * 2)) {
          if (!node || typeof node !== 'object') continue;
          if (node.url && !safeSessionUrl(node.url)) {
            logWarning(new Error('Invalid node URL in import'), { category: ERROR_CATEGORIES.STORAGE, component: 'import' });
            node.url = 'chrome://newtab';
          }
          if (node.firstSeenAt && (node.firstSeenAt > now + MAX_TIMESTAMP_FUTURE_MS || node.firstSeenAt < now - MAX_AGE_MS)) {
            node.firstSeenAt = now;
          }
          if (node.depth && (typeof node.depth !== 'number' || node.depth < 0 || node.depth > LIMITS.NODES_PER_SESSION)) {
            node.depth = 0;
          }
        }
      }
    }
  }
  
  // A sessions-only file must not be treated as "no settings": replacing the
  // user's tuned rhythm with defaults on every partial import silently resets
  // their thresholds. Only an explicit settings object overrides local ones.
  const incomingHasSettings = isRecord(incomingState.settings);
  const next = normalizeState({ ...incomingState, sessions: incomingSessions });
  return mutate((current) => {
    // Imported records win ID conflicts as whole snapshots, including their
    // nodes/events. Move replacements to the end before applying the session cap.
    const sessionMap = new Map();
    for (const session of [...current.sessions, ...next.sessions]) {
      sessionMap.delete(session.id);
      sessionMap.set(session.id, session);
    }
    const mergedSessions = Array.from(sessionMap.values()).slice(-LIMITS.SESSIONS);
    const activeSessionId = mergedSessions.some((s) => s.id === next.activeSessionId)
      ? next.activeSessionId
      : (mergedSessions.some((s) => s.id === current.activeSessionId) ? current.activeSessionId : null);
    // When the import claims a *different* active garden, the displaced local
    // session must be completed — mirroring createSession — or it stays
    // "active" forever while the chip tracks the imported one.
    if (activeSessionId && current.activeSessionId && activeSessionId !== current.activeSessionId) {
      const displaced = mergedSessions.find((s) => s.id === current.activeSessionId);
      if (displaced && displaced.status !== 'completed') {
        displaced.status = 'completed';
        displaced.endedAt = Date.now();
        displaced.endReason = 'mission_changed';
        for (const interval of displaced.activeIntervals || []) if (!interval.endedAt) interval.endedAt = displaced.endedAt;
        addEvent(displaced, 'mission_changed');
      }
    }
    const compostMap = new Map();
    for (const item of [...next.compostItems, ...current.compostItems]) {
      if (item?.id && !compostMap.has(item.id)) compostMap.set(item.id, item);
    }
    // One catalog reward can be earned more than once; only identical
    // (rewardId, timestamp) occurrences represent duplicate imported history.
    const rewardMap = new Map();
    for (const reward of [...current.rewardHistory, ...next.rewardHistory]) {
      rewardMap.set(JSON.stringify([reward.rewardId, reward.timestamp]), reward);
    }
    Object.assign(current, {
      schemaVersion: SCHEMA_VERSION,
      sessions: mergedSessions,
      compostItems: Array.from(compostMap.values()).slice(0, LIMITS.COMPOST),
      rewardHistory: Array.from(rewardMap.values()).sort((a, b) => a.timestamp - b.timestamp),
      settings: incomingHasSettings ? next.settings : current.settings,
      activeSessionId,
      onboardingCompleted: Boolean(current.onboardingCompleted || next.onboardingCompleted)
    });
    // saveState applies the existing normalized reward-history cap.
    return { imported: true };
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  return wrapWithErrorBoundary(async () => {
    // This also migrates Focus Forest's former storage key before any empty
    // first-run state can be seeded over a user's existing gardens.
    await loadStateForWrite();
    const result = await chrome.storage.local.get(STORAGE_KEY);
    if (!result[STORAGE_KEY]) await saveState(emptyState());
    // Check initial storage quota after seeding
    await checkStorageQuota();
    await takeOverOpenNewTabs();
    if (details?.reason === 'install') {
      // Windowless installs (headless-CI startup races) used to reject here
      // with "No current window" — tabs.create without a windowId needs a
      // last-focused window, which may not exist yet at install time. Probe
      // for one: a definitive "none" means there is nowhere to open a
      // welcome tab, so skip quietly (the new-tab override greets the user
      // anyway); a resolved window is targeted explicitly. Engines without
      // the windows API keep the legacy best-effort create.
      const hasWindowApi = Boolean(chrome.windows?.getLastFocused);
      const win = hasWindowApi ? await chrome.windows.getLastFocused().catch(() => null) : null;
      if (!hasWindowApi || (win && Number.isInteger(win.id))) {
        await chrome.tabs.create({ url: plantingPageUrl(), active: true, ...(win && Number.isInteger(win.id) ? { windowId: win.id } : {}) }).catch(() => {});
      }
    }
  }, { category: ERROR_CATEGORIES.STORAGE, component: 'service-worker', function: 'onInstalled', swallow: true })();
});

chrome.runtime.onInstalled.addListener(() => {
  return wrapWithErrorBoundary(async () => {
    if (!chrome.contextMenus?.create) return;
    // MV3 create() returns a promise that rejects on duplicate ids (e.g. when
    // menus survived an update). Fire-and-forget calls turned that into an
    // "Uncaught (in promise)" rejection and skipped the remaining menus when
    // the first threw. Remove-then-await keeps registration idempotent and
    // lets the swallow boundary log genuine failures.
    await chrome.contextMenus.removeAll();
    await chrome.contextMenus.create({ id: 'intent-grove-start', title: 'Start Focus Mission for "%s"', contexts: ['link', 'page', 'selection'] });
    await chrome.contextMenus.create({ id: 'intent-grove-compost', title: 'Save Page for Later', contexts: ['page', 'link'] });
    await chrome.contextMenus.create({ id: 'intent-grove-end', title: 'End Current Focus Mission', contexts: ['page'] });
  }, { category: ERROR_CATEGORIES.MESSAGING, component: 'service-worker', function: 'contextMenus.create', swallow: true })();
});

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  return wrapWithErrorBoundary(async () => {
    if (info.menuItemId === 'intent-grove-start') {
      // Title fallbacks must never adopt an unsafe scheme as mission text:
      // only a valid http(s) tab URL is acceptable, else the neutral label.
      const title = typeof info.selectionText === 'string' && info.selectionText.trim() ? info.selectionText.trim() : (tab?.title || safeHttpUrl(tab?.url) || 'New Tab');
      const mission = compactText(title, 140);
      if (!mission) return;
      // A link's mission targets the link's destination, not the page hosting it.
      const targetUrl = safeHttpUrl(info.linkUrl || tab?.url);
      await createSession(mission, { id: tab?.id, url: targetUrl || 'chrome://newtab', title: tab?.title || 'New Tab', windowId: tab?.windowId });
      // Navigate only when the target differs from where the tab already is.
      // The old code re-navigated to the tab's own URL, which is a full page
      // reload (losing scroll and form state) that added no information —
      // the session already recorded the origin.
      if (targetUrl && Number.isInteger(tab?.id) && targetUrl !== safeHttpUrl(tab?.url)) {
        await chrome.tabs.update(tab.id, { url: targetUrl });
      }
    } else if (info.menuItemId === 'intent-grove-compost') {
      const targetUrl = safeHttpUrl(info.linkUrl || tab?.url);
      if (Number.isInteger(tab?.id) && targetUrl) {
        await compost(info.linkUrl ? null : tab.id, targetUrl, info.linkText || tab?.title || targetUrl);
      }
    } else if (info.menuItemId === 'intent-grove-end') {
      await endSession('user_ended');
    }
  }, { category: ERROR_CATEGORIES.MESSAGING, component: 'service-worker', function: 'contextMenus.onClicked', swallow: true })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRecord(message) || typeof message.type !== 'string') { sendResponse(null); return false; }
  if (sender?.id !== chrome.runtime.id) { sendResponse(null); return false; }
  
  // Rate limit messages from content-script senders to blunt page-context
  // spam. First-party extension pages (popup, New Tab, dashboard, settings)
  // are exempt: they run our own code, and throttling them made the dashboard
  // blank out during busy browsing. Limited content senders receive a
  // distinguishable { rateLimited: true } response — answering plain null was
  // indistinguishable from "no active session" and made the companion hide
  // its chip mid-mission under load.
  if (!isExtensionPageSender(sender)) {
    const senderId = sender?.tab?.id ? `tab:${sender.tab.id}` : sender?.url ? `url:${sender.url}` : null;
    if (!checkRateLimit(senderId)) {
      logWarning(new Error('Message rate limit exceeded'), { 
        category: ERROR_CATEGORIES.MESSAGING, 
        senderId,
        messageType: message.type 
      });
      sendResponse({ rateLimited: true });
      return false;
    }
  }
  
  const tab = sender && typeof sender === 'object' && sender.tab && typeof sender.tab === 'object' ? sender.tab : null;
  if (!validateMessage(message)) { sendResponse(null); return false; }
  (async () => {
    switch (message.type) {
      case 'GET_SNAPSHOT': return isExtensionPageSender(sender) ? getSnapshot(safeId(message.sessionId) || null, Boolean(message.includeHistory)) : null;
      case 'GET_ACTIVE_VIEW': { await refreshSystemMemory(); return activeView(await loadState(), tab?.id); }
      case 'GET_CHIP_POS': return getChipPos(tab);
      case 'SET_CHIP_POS': return setChipPos(tab, message.x, message.y);
      case 'START_MISSION': {
        if (typeof message.mission !== 'string') return null;
        const activeTab = message.openSearch
          ? (tab?.id != null ? tab : (await chrome.tabs?.query?.({ active: true, currentWindow: true }).then((tabs) => tabs[0]).catch(() => null)))
          : null;
        const missionTab = sanitizeTab(tab) || sanitizeTab(activeTab) || sanitizeTab(message.tab);
        const session = await createSession(message.mission, missionTab, message.missionNote, message.responsePlan);
        if (message.openSearch && activeTab?.id != null && chrome.tabs?.update) {
          const settings = await loadState().then((state) => normalizeSettings(state.settings));
          // Use chrome.search API with try-catch for better cross-Chromium compatibility
          // Some Chromium-based browsers (Edge, Brave) may not fully support chrome.search.query
          if (settings.searchEngine === 'default') {
            try {
              if (chrome.search?.query) {
                await chrome.search.query({ text: compactText(message.mission, 140), tabId: activeTab.id });
              } else {
                // Fallback to URL navigation if search API unavailable ('default'
                // resolves inside missionSearchUrl to the privacy-preserving fallback).
                const searchUrl = missionSearchUrl('default', message.mission);
                await chrome.tabs.update(activeTab.id, { url: searchUrl, active: true });
              }
            } catch (error) {
              logError(error, { category: ERROR_CATEGORIES.MESSAGING, operation: 'searchQuery' });
              // Fallback to URL navigation on error
              const searchUrl = missionSearchUrl('default', message.mission);
              await chrome.tabs.update(activeTab.id, { url: searchUrl, active: true });
            }
          } else {
            const searchUrl = missionSearchUrl(settings.searchEngine, message.mission);
            await chrome.tabs.update(activeTab.id, { url: searchUrl, active: true });
          }
        }
        return session;
      }
      case 'END_MISSION': return endSession(safeReason(message.reason));
      case 'LINK_CLICK': {
        if (!Number.isInteger(tab?.id)) return null;
        const linkUrl = safeHttpUrl(message.url);
        if (!linkUrl) return null;
        return trackLink({ tabId: tab.id, url: linkUrl, title: typeof message.title === 'string' ? message.title : '', targetBlank: Boolean(message.targetBlank), windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null });
      }
      case 'OBSERVE_PAGE': {
        if (!Number.isInteger(tab?.id)) return null;
        return observeTab(tab.id, message.url, typeof message.title === 'string' ? message.title : '', tab.openerTabId, tab.windowId);
      }
      case 'SPA_NAVIGATION': {
        if (!Number.isInteger(tab?.id)) return null;
        const routeUrl = safeHttpUrl(message.url);
        const routeTitle = typeof message.title === 'string' ? compactText(message.title) : '';
        if (!routeUrl || recentlyObservedSpa(tab.id, routeUrl, routeTitle)) return null;
        return trackLink({ tabId: tab.id, url: routeUrl, title: routeTitle, targetBlank: false, windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null, navigationKind: 'spa' });
      }
      case 'COMPOST': return Number.isInteger(tab?.id) ? compost(tab.id, message.url, message.title) : null;
      case 'PAUSE_INTERVENTION': return typeof message.paused === 'boolean' ? mutate((state) => {
        const session = activeSession(state);
        if (!session || session.interventionPaused === message.paused) return NO_CHANGE;
        session.interventionPaused = message.paused;
        const thresholds = effectiveThresholds(state.settings);
        session.nodes.forEach((node) => {
          if (!TERMINAL_STATES.has(node.state)) {
            node.state = getDepthState(node.depth, session.interventionPaused, thresholds);
          }
        });
        return session;
      }) : null;
      case 'PAUSE_SITE': return Number.isInteger(tab?.id) ? mutate((state) => {
        let hostname = null;
        try { hostname = new URL(tab.url || '').hostname.toLowerCase().replace(/^www\./, ''); } catch { return NO_CHANGE; }
        if (!hostname) return NO_CHANGE;
        const settings = normalizeSettings(state.settings);
        if (settings.excludedSites.includes(hostname)) return NO_CHANGE;
        settings.excludedSites = [...settings.excludedSites, hostname].slice(0, 40);
        state.settings = settings;
        return settings;
      }) : null;
      case 'UPDATE_SETTINGS': return isExtensionPageSender(sender) && isRecord(message.settings) ? mutate((state) => {
        const next = normalizeSettings({ ...state.settings, ...message.settings });
        if (JSON.stringify(next) === JSON.stringify(state.settings)) return NO_CHANGE;
        state.settings = next;
        const session = activeSession(state);
        if (session) {
          const thresholds = effectiveThresholds(next);
          session.nodes.forEach((node) => {
            if (!TERMINAL_STATES.has(node.state)) {
              node.state = getDepthState(node.depth, session.interventionPaused, thresholds);
            }
          });
        }
        return state.settings;
      }) : null;
      case 'DELETE_COMPOST': return isExtensionPageSender(sender) && safeId(message.id) ? mutate((state) => { const before = state.compostItems.length; state.compostItems = state.compostItems.filter((item) => item.id !== message.id); return before === state.compostItems.length ? NO_CHANGE : state.compostItems; }) : null;
      case 'PRUNE_NODE': return isExtensionPageSender(sender) && safeId(message.sessionId) && safeId(message.nodeId) ? pruneNode(message.sessionId, message.nodeId, Boolean(message.toCompost)) : null;
      case 'DELETE_SESSION': return isExtensionPageSender(sender) && safeId(message.sessionId) ? mutate((state) => { const before = state.sessions.length; state.sessions = state.sessions.filter((session) => session.id !== message.sessionId); if (state.activeSessionId === message.sessionId) { state.activeSessionId = null; clearRuntimeTracking(); } return before === state.sessions.length ? NO_CHANGE : state.sessions; }) : null;
      case 'FORGET_SITE': return isExtensionPageSender(sender) && typeof message.hostname === 'string' ? forgetSite(message.hostname) : null;
      case 'CLEAR_DATA': return isExtensionPageSender(sender) ? (clearRuntimeTracking(), replaceState(emptyState())) : null;
      case 'GET_DASHBOARD_STATS': return isExtensionPageSender(sender) ? getDashboardStats() : null;
      case 'GET_PATH_PATTERN_ANALYSIS': return isExtensionPageSender(sender) ? getPathPatternAnalysis() : null;
      case 'GET_PATH_PATTERN_REMINDER': return isExtensionPageSender(sender) ? getPathPatternReminder() : null;
      case 'REMOVE_SAVED_ITEM': return isExtensionPageSender(sender) && safeId(message.id) ? removeSavedItem(message.id) : null;
      case 'EXPORT_DATA': return isExtensionPageSender(sender) ? exportAllData() : null;
      case 'IMPORT_DATA': return isExtensionPageSender(sender) && isRecord(message.payload) ? importAllData(message.payload) : null;
      case 'COMPLETE_ONBOARDING': return isExtensionPageSender(sender) ? mutate((state) => { state.onboardingCompleted = true; return state; }) : null;
      case 'GO_HOME': return goHome();
      case 'OPEN_PLANTING_PAGE': {
        // Web pages cannot navigate to chrome-extension:// URLs that are not
        // web_accessible_resources (and this extension deliberately keeps that
        // list empty), so the content script's "Start a new mission" action
        // asks the worker — an extension context — to navigate its own tab.
        if (!Number.isInteger(tab?.id)) return null;
        try {
          await chrome.tabs.update(tab.id, { url: plantingPageUrl() });
          return { opened: true };
        } catch (error) {
          logError(error, { category: ERROR_CATEGORIES.NAVIGATION, component: 'service-worker', function: 'OPEN_PLANTING_PAGE', tabId: tab.id });
          return null;
        }
      }
      case 'DISMISS_INTERVENTION': {
        if (!Number.isInteger(tab?.id)) return null;
        return mutate((state) => {
          const session = activeSession(state); if (!session) return NO_CHANGE;
          const node = nodeForTab(session, tab.id);
          if (!node) return NO_CHANGE;
          addEvent(session, 'interruption_dismissed', { nodeId: node.id, url: safeHttpUrl(message.url) || node.url });
          return { counted: true };
        });
      }
      default: return null;
    }
  })()
  .then(sendResponse)
  .catch((error) => {
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, component: 'service-worker', function: 'onMessage', messageType: message?.type });
    sendResponse({ error: 'INTERNAL_ERROR' });
  });
  return true;
});

const SCHEMAS = {
  GET_SNAPSHOT: { sessionId: 'string?', includeHistory: 'boolean?' },
  GET_ACTIVE_VIEW: {},
  GET_CHIP_POS: {},
  SET_CHIP_POS: { x: 'number', y: 'number' },
  START_MISSION: { mission: 'string', missionNote: 'string?', responsePlan: 'string?', tab: 'object?', openSearch: 'boolean?' },
  END_MISSION: { reason: 'string?' },
  LINK_CLICK: { url: 'string', title: 'string?', targetBlank: 'boolean?' },
  OBSERVE_PAGE: { url: 'string', title: 'string?' },
  SPA_NAVIGATION: { url: 'string', title: 'string?' },
  COMPOST: { url: 'string', title: 'string?' },
  PAUSE_INTERVENTION: { paused: 'boolean' },
  PAUSE_SITE: {},
  UPDATE_SETTINGS: { settings: 'object' },
  DELETE_COMPOST: { id: 'string' },
  PRUNE_NODE: { sessionId: 'string', nodeId: 'string', toCompost: 'boolean?' },
  DELETE_SESSION: { sessionId: 'string' },
  FORGET_SITE: { hostname: 'string' },
  CLEAR_DATA: {},
  GET_DASHBOARD_STATS: {},
  GET_PATH_PATTERN_ANALYSIS: {},
  GET_PATH_PATTERN_REMINDER: {},
  REMOVE_SAVED_ITEM: { id: 'string' },
  EXPORT_DATA: {},
  IMPORT_DATA: { payload: 'object' },
  GO_HOME: {},
  OPEN_PLANTING_PAGE: {},
  DISMISS_INTERVENTION: { url: 'string?' },
  COMPLETE_ONBOARDING: {}
};
const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  object: (v) => v && typeof v === 'object' && !Array.isArray(v)
};
function validateMessage(message) {
  if (!isRecord(message) || !Object.hasOwn(message, 'type') || typeof message.type !== 'string') return false;
  if (!Object.hasOwn(SCHEMAS, message.type)) return false;
  const schema = SCHEMAS[message.type];
  for (const [key, kind] of Object.entries(schema)) {
    const optional = kind.endsWith('?');
    const base = optional ? kind.slice(0, -1) : kind;
    if (!Object.hasOwn(message, key)) {
      if (!optional) return false;
      continue;
    }
    if (message[key] == null) {
      if (!optional) return false;
      continue;
    }
    if (!TYPE_CHECKS[base](message[key])) return false;
  }
  return true;
}

chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  return wrapWithErrorBoundary(async (details) => {
    if (details.frameId !== 0 || details.tabId == null || !details.url) return;
    const tab = await chrome.tabs.get(details.tabId);
    if (!tab) return;
    const title = compactText(tab.title || '');
    if (recentlyObservedSpa(details.tabId, details.url, title)) return;
    await trackLink({ tabId: tab.id, url: details.url, title, targetBlank: false, windowId: Number.isInteger(tab.windowId) ? tab.windowId : null, navigationKind: 'spa' });
  }, { category: ERROR_CATEGORIES.NAVIGATION, component: 'service-worker', function: 'webNavigation.onHistoryStateUpdated', swallow: true })(details);
});

chrome.commands?.onCommand?.addListener((command) => {
  return wrapWithErrorBoundary(async () => {
    if (command === 'return-to-mission') { await goHome(); return; }
    if (command !== 'toggle-mission') return;
    const state = await loadState();
    const session = activeSession(state);
    if (session) {
      await endSession('user_ended');
    } else {
      const tab = await chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]).catch(() => null);
      if (tab?.id != null && tab?.url) {
        // A new-tab placeholder (or any non-http URL) has no meaningful
        // title; naming a mission after an internal or unsafe URL reads as
        // noise. Only a genuine http(s) address is acceptable as the name.
        const missionSource = tab.title || (safeHttpUrl(tab.url) ? tab.url : 'New Tab');
        await createSession(compactText(missionSource, 140), { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId });
      }
    }
  }, { category: ERROR_CATEGORIES.MESSAGING, component: 'service-worker', function: 'commands.onCommand', swallow: true })();
});

// NOTE: there is deliberately no tabs.onCreated takeover. At creation time a
// tab has no committed URL (or, during session restore, a placeholder that the
// new-tab override is already resolving); acting there re-introduces the
// redundant-reload race documented on the tabs.onUpdated handler. Committed
// NTP tabs are taken over by onUpdated (status 'complete'), and tabs that
// already exist at startup/install are covered by takeOverOpenNewTabs().
chrome.runtime.onSuspend?.addListener(() => {
  // Best-effort flush: the worker may terminate mid-queue, so attempt to
  // finish any pending mutation writes before shutdown.
  // NOTE: the `return` below is for symmetry with the sibling listeners only.
  // Do NOT read it as a keep-alive guarantee — this is the suspension hook
  // itself, so the flush stays best-effort and may not complete.
  return wrapWithErrorBoundary(() => mutationQueue.catch(() => undefined), { category: ERROR_CATEGORIES.STATE_MUTATION, component: 'service-worker', function: 'onSuspend', swallow: true })();
});
chrome.runtime.onStartup?.addListener(() => {
  return wrapWithErrorBoundary(async () => {
    await takeOverOpenNewTabs();
    // A browser restart ends every previous foreground interval: intervals
    // left open would keep accruing phantom "foreground time" across the
    // restart, and recycled tab ids could inherit stale participation in a
    // surviving mission. Fresh intervals for the current active tabs are
    // recorded right below.
    await mutate((state) => {
      const session = activeSession(state);
      if (!session) return NO_CHANGE;
      let closed = false;
      const restartedAt = Date.now();
      for (const entry of session.activeIntervals || []) {
        if (!entry.endedAt) { entry.endedAt = restartedAt; closed = true; }
      }
      return closed ? session : NO_CHANGE;
    });
    const tabs = await chrome.tabs.query({ active: true }).catch(() => []);
    await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => recordActiveTab(tab.id, tab.windowId)));
  }, { category: ERROR_CATEGORIES.NAVIGATION, component: 'service-worker', function: 'onStartup', swallow: true })();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  return wrapWithErrorBoundary(async (tabId, changeInfo, tab) => {
    // Take over only once the tab has COMMITTED (status 'complete'). While a
    // new tab is still loading, tab.url transiently reports the browser
    // placeholder (chrome://newtab) even when our own chrome_url_overrides is
    // resolving it to the planting page; issuing an update from that transient
    // state aborts the override's own load and can cancel whatever navigation
    // happens next (proven in the real-extension suite: it killed the
    // post-plant search navigation). At 'complete' the URL is unambiguous:
    // our override page -> skip; a genuine browser NTP (override disabled or
    // a Brave-style confirmation pending) -> take over.
    if (changeInfo.status !== 'complete') return;
    if (await takeOverBrowserNewTab(tab)) return;
    if (!tab.url) return;
    // Same-document history updates (pushState/replaceState) produce the
    // identical onUpdated loading->complete signature as full navigations,
    // and onCommitted never fires for them. Observing on those events raced
    // the SPA paths (webNavigation.onHistoryStateUpdated and the companion's
    // SPA_NAVIGATION) and mislabeled every SPA route as an unlinked depth-0
    // 'manual' path — fragmenting the tree. Require a matching commit record;
    // the SPA paths own same-document route changes. Content-script
    // OBSERVE_PAGE still covers full navigations even if this record was lost
    // to a worker restart.
    const commit = committedNavs.get(tabId);
    if (!commit || commit.url !== tab.url) return;
    committedNavs.delete(tabId);
    await observeTab(tabId, tab.url, tab.title, tab.openerTabId, tab.windowId);
  }, { category: ERROR_CATEGORIES.NAVIGATION, component: 'service-worker', function: 'tabs.onUpdated', swallow: true })(tabId, changeInfo, tab);
});
chrome.tabs.onActivated?.addListener((activeInfo) => {
  return wrapWithErrorBoundary(() => recordActiveTab(activeInfo?.tabId, activeInfo?.windowId), { category: ERROR_CATEGORIES.NAVIGATION, component: 'service-worker', function: 'tabs.onActivated', swallow: true })();
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return;
  navigationHints.set(details.tabId, navigationKindForTransition(details.transitionType, details.transitionQualifiers || []));
  committedNavs.set(details.tabId, { url: details.url || '', at: Date.now() });
  // FIFO eviction keeps the hint maps bounded; entries are single-use and safe to drop.
  while (navigationHints.size > SERVICE_WORKER.MAX_ACTIVE_TABS) {
    navigationHints.delete(navigationHints.keys().next().value);
  }
  while (committedNavs.size > SERVICE_WORKER.MAX_ACTIVE_TABS) {
    committedNavs.delete(committedNavs.keys().next().value);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  return wrapWithErrorBoundary(async (tabId) => {
    activeTabs.forEach((active, key) => { if (active.tabId === tabId) activeTabs.delete(key); });
    messageCounts.delete(`tab:${tabId}`);
    // Drop the remaining per-tab in-memory entries too; otherwise they linger
    // until their own TTL/size eviction runs, holding URLs longer than needed.
    navigationHints.delete(tabId);
    trackedNavMarks.delete(tabId);
    commitMemos.delete(tabId);
    committedNavs.delete(tabId);
    clearChipPosForTab(tabId); // fire-and-forget: the FIFO chip-position queue orders this before any later read, and a stalled position write must never delay the session-state cleanup below
    for (const key of spaDedup.keys()) { if (key.startsWith(`${tabId}::`)) spaDedup.delete(key); }
    for (const [key, entry] of pendingBranches) { if (entry.sourceTabId === tabId) pendingBranches.delete(key); }
    await mutate((state) => {
      const session = activeSession(state);
      if (!session) return NO_CHANGE;
      let changed = false;
      if (session.origin?.tabId === tabId) { session.origin.tabId = null; changed = true; }
      const pendingBefore = (session.pendingRedirects || []).length;
      clearPendingRedirect(session, tabId);
      if (session.pendingRedirects.length !== pendingBefore) changed = true;
      // End the removed tab's open foreground interval: a closed tab accrues
      // no further foreground time (previously it kept accruing until session
      // end), and an ended interval correctly ends the tab's participation —
      // so a REUSED tab id (Chrome recycles ids across browser sessions) can
      // never inherit the removed tab's relationships.
      const removedAt = Date.now();
      for (const entry of session.activeIntervals || []) {
        if (entry.tabId === tabId && !entry.endedAt) { entry.endedAt = removedAt; changed = true; }
      }
      const node = nodeForTab(session, tabId);
      if (!node || node.closedAt) return changed ? session : NO_CHANGE;
      detachTab(node, tabId);
      if (!node.tabIds?.length) node.closedAt = Date.now();
      return node;
    });
  }, { category: ERROR_CATEGORIES.NAVIGATION, component: 'service-worker', function: 'tabs.onRemoved', swallow: true })(tabId);
});
