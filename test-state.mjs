import assert from 'node:assert';
import { describe, it } from 'node:test';

const storage = {};
const changeListeners = [];
let heldSetCount = 0;
let failNextGet = false;
let failNextSet = false;
const setStartResolvers = [];
const setReleaseResolvers = [];

globalThis.chrome = {
  runtime: { id: 'test' },
  storage: {
    local: {
      async get(key) {
        if (failNextGet) { failNextGet = false; throw new Error('simulated storage read failure'); }
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((item) => item in storage).map((item) => [item, structuredClone(storage[item])]));
      },
      async set(value) {
        if (failNextSet) { failNextSet = false; throw new Error('simulated storage write failure'); }
        Object.assign(storage, structuredClone(value));
        if (heldSetCount <= 0) return;
        heldSetCount -= 1;
        setStartResolvers.shift()?.();
        await new Promise((resolve) => { setReleaseResolvers.push(resolve); });
      },
      async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete storage[item]; }
    },
    onChanged: {
      addListener(listener) { changeListeners.push(listener); }
    }
  }
};

const {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  isSearchUrl,
  isBrowserNewTabUrl,
  isExtensionNewTabUrl,
  isPlaceholderOriginUrl,
  safeHttpUrl,
  safeSessionUrl,
  canonicalUrl,
  normalizeSettings,
  compactText,
  getDepthState,
  LIMITS,
  DEFAULT_SETTINGS,
  normalizeState,
  emptyState,
  earnReward,
  canEarnReward,
  selectRandomReward,
  rewardHistoryView,
  rewardNote,
  driftStats,
  REWARD_CATALOG,
  loadState,
  saveState,
  loadStateForWrite,
  clearStateCache,
  compactStateIfNeeded,
  STORAGE_QUOTA_CRITICAL_THRESHOLD,
  makeId
} = await import('./shared/state.js');

describe('storage namespace migration', () => {
  it('moves legacy gardens to Intent Grove storage before removing the old key', async () => {
    const priorCurrent = storage[STORAGE_KEY];
    const priorLegacy = storage[LEGACY_STORAGE_KEY];
    delete storage[STORAGE_KEY];
    storage[LEGACY_STORAGE_KEY] = sessionFixture('legacy-garden');
    clearStateCache();
    try {
      const migrated = await loadStateForWrite();
      assert.equal(migrated.sessions[0].id, 'legacy-garden');
      assert.equal(storage[STORAGE_KEY].sessions[0].id, 'legacy-garden');
      assert.equal(Object.hasOwn(storage, LEGACY_STORAGE_KEY), false, 'old key should be removed only after the canonical copy is saved');
    } finally {
      if (priorCurrent === undefined) delete storage[STORAGE_KEY]; else storage[STORAGE_KEY] = priorCurrent;
      if (priorLegacy === undefined) delete storage[LEGACY_STORAGE_KEY]; else storage[LEGACY_STORAGE_KEY] = priorLegacy;
      clearStateCache();
    }
  });

  it('retains the old garden if writing the canonical key fails during migration', async () => {
    const priorCurrent = storage[STORAGE_KEY];
    const priorLegacy = storage[LEGACY_STORAGE_KEY];
    delete storage[STORAGE_KEY];
    storage[LEGACY_STORAGE_KEY] = sessionFixture('safe-legacy-garden');
    clearStateCache();
    failNextSet = true;
    try {
      await assert.rejects(loadStateForWrite(), /simulated storage write failure/);
      assert.equal(Object.hasOwn(storage, STORAGE_KEY), false);
      assert.equal(storage[LEGACY_STORAGE_KEY].sessions[0].id, 'safe-legacy-garden');
    } finally {
      if (priorCurrent === undefined) delete storage[STORAGE_KEY]; else storage[STORAGE_KEY] = priorCurrent;
      if (priorLegacy === undefined) delete storage[LEGACY_STORAGE_KEY]; else storage[LEGACY_STORAGE_KEY] = priorLegacy;
      clearStateCache();
    }
  });
});

function fireStorageChange(newValue, oldValue = undefined) {
  for (const listener of changeListeners) {
    listener({ [STORAGE_KEY]: { oldValue, newValue } }, 'local');
  }
}

function sessionFixture(id) {
  return {
    sessions: [{
      id,
      mission: 'm',
      status: 'active',
      startedAt: 1,
      origin: { url: 'https://example.com', title: 'Example' },
      nodes: [{ id: `${id}-n`, url: 'https://example.com/page', title: 'Page', parentId: null, depth: 0, state: 'normal' }],
      events: []
    }],
    activeSessionId: id,
    compostItems: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}

describe('shared/state.js core functions', () => {
  it('keeps only a supported private response plan and defaults old or invalid data to decide', () => {
    const base = sessionFixture('plan-fixture');
    assert.strictEqual(normalizeState(base).sessions[0].responsePlan, 'decide');
    base.sessions[0].responsePlan = 'save';
    assert.strictEqual(normalizeState(base).sessions[0].responsePlan, 'save');
    base.sessions[0].responsePlan = 'open-a-new-tab';
    assert.strictEqual(normalizeState(base).sessions[0].responsePlan, 'decide');
  });

  it('compactText trims and truncates', () => {
    assert.strictEqual(compactText('  hello world  '), 'hello world');
    assert.strictEqual(compactText('a'.repeat(200), 50), 'a'.repeat(50));
    assert.strictEqual(compactText(''), '');
  });

  it('safeHttpUrl accepts http/https and rejects others', () => {
    assert.ok(safeHttpUrl('https://example.com/path'));
    assert.ok(safeHttpUrl('http://example.com'));
    assert.strictEqual(safeHttpUrl('ftp://example.com'), null);
    assert.strictEqual(safeHttpUrl('not-a-url'), null);
  });

  it('isSearchUrl detects known search engines and query params', () => {
    assert.ok(isSearchUrl('https://www.google.com/search?q=cats'));
    assert.ok(isSearchUrl('https://search.brave.com/search?q=trees'));
    assert.ok(isSearchUrl('https://search.brave.com/'));
    assert.ok(isSearchUrl('https://duckduckgo.com/?q=test'));
    assert.ok(isSearchUrl('https://bing.com/search?q=hello'));
    assert.ok(isSearchUrl('https://yahoo.com/search?p=term'));
    assert.strictEqual(isSearchUrl('https://example.com/page'), false);
  });

  it('normalizeSettings clamps and defaults', () => {
    const base = { gentleDepth: 4, choiceDepth: 5, ambientMotion: true, growthAnimationTrigger: 'mission-origin', excludedSites: [], searchEngine: 'default', enableRewards: false, strictMode: false, ramGuard: true, ramGuardLevel: 3, pathPatternRemindersEnabled: false };
    assert.deepStrictEqual(normalizeSettings(base), { ...base });
    assert.deepStrictEqual(normalizeSettings({}), { gentleDepth: 4, choiceDepth: 5, ambientMotion: true, growthAnimationTrigger: 'mission-origin', excludedSites: [], searchEngine: 'default', enableRewards: false, strictMode: false, ramGuard: true, ramGuardLevel: 3, pathPatternRemindersEnabled: false });
    assert.deepStrictEqual(normalizeSettings({ gentleDepth: 1, choiceDepth: 1 }), { gentleDepth: 2, choiceDepth: 3, ambientMotion: true, growthAnimationTrigger: 'mission-origin', excludedSites: [], searchEngine: 'default', enableRewards: false, strictMode: false, ramGuard: true, ramGuardLevel: 3, pathPatternRemindersEnabled: false });
    assert.deepStrictEqual(normalizeSettings({ growthAnimationTrigger: 'invalid' }), { gentleDepth: 4, choiceDepth: 5, ambientMotion: true, growthAnimationTrigger: 'mission-origin', excludedSites: [], searchEngine: 'default', enableRewards: false, strictMode: false, ramGuard: true, ramGuardLevel: 3, pathPatternRemindersEnabled: false });
    assert.equal(normalizeSettings({ searchEngine: 'brave' }).searchEngine, 'brave');
    assert.equal(normalizeSettings({ strictMode: true }).strictMode, true);
    assert.equal(normalizeSettings({ strictMode: 'yes' }).strictMode, false, 'strict mode requires an explicit true');
    assert.equal(normalizeSettings({ ramGuard: false }).ramGuard, false, 'the guardian opt-out must survive normalization');
    assert.equal(normalizeSettings({ ramGuard: 'no' }).ramGuard, true, 'only an explicit false opts out');
    assert.equal(normalizeSettings({ ramGuardLevel: 99 }).ramGuardLevel, 5, 'sensitivity clamps high');
    assert.equal(normalizeSettings({ ramGuardLevel: -3 }).ramGuardLevel, 1, 'sensitivity clamps low');
    assert.equal(normalizeSettings({ pathPatternRemindersEnabled: true }).pathPatternRemindersEnabled, true);
    assert.equal(normalizeSettings({ pathPatternRemindersEnabled: 'yes' }).pathPatternRemindersEnabled, false, 'reminders require explicit opt-in');
    // interventionsPaused was removed: it was written but never read anywhere.
    assert.equal(Object.hasOwn(normalizeSettings({ interventionsPaused: true }), 'interventionsPaused'), false);
    assert.equal(Object.hasOwn(emptyState().settings, 'interventionsPaused'), false);
    assert.deepStrictEqual(normalizeSettings({ excludedSites: ['WWW.Example.com', 'example.com', ''] }).excludedSites, ['example.com']);
  });

  it('normalizeSettings coerces fractional thresholds to whole branch counts', () => {
    // Thresholds are branch COUNTS. Math.min/Math.max alone preserve fractions,
    // and settings/app.js's editableSettings() rejects a non-integer with
    // 'Invalid settings acknowledgement' -- which leaves the Options page
    // permanently unreadable, with Save AND "Return to the original rhythm"
    // both disabled. Coercion belongs here, at the storage trust boundary, for
    // every accepted input shape (a hand-edited import file is a real source).
    const cases = [
      [{ gentleDepth: 4.5, choiceDepth: 5.7 }, { gentleDepth: 5, choiceDepth: 6 }],
      [{ gentleDepth: '4.5', choiceDepth: '5.7' }, { gentleDepth: 5, choiceDepth: 6 }],
      [{ gentleDepth: 2.4 }, { gentleDepth: 2, choiceDepth: 5 }],
      [{ choiceDepth: 9.9 }, { gentleDepth: 4, choiceDepth: 10 }]
    ];
    for (const [input, expected] of cases) {
      const out = normalizeSettings(input);
      assert.ok(Number.isInteger(out.gentleDepth), `gentleDepth must be an integer for ${JSON.stringify(input)}`);
      assert.ok(Number.isInteger(out.choiceDepth), `choiceDepth must be an integer for ${JSON.stringify(input)}`);
      assert.strictEqual(out.gentleDepth, expected.gentleDepth);
      assert.strictEqual(out.choiceDepth, expected.choiceDepth);
    }
    // The one-branch gap must survive rounding in both directions.
    const rounded = normalizeSettings({ gentleDepth: 7.6, choiceDepth: 3.2 });
    assert.ok(rounded.choiceDepth >= rounded.gentleDepth + 1, 'choiceDepth must stay at least one branch beyond gentleDepth after rounding');
    // Integer input must round-trip untouched.
    assert.strictEqual(normalizeSettings({ gentleDepth: 4 }).gentleDepth, 4);
  });

  it('persists bounded reward history and keeps reward records minimal', () => {
    const state = emptyState();
    state.settings.enableRewards = true;
    state.sessions.push({ id: 'reward-session', startedAt: Date.now(), status: 'active', nodes: [], events: [] });
    state.activeSessionId = 'reward-session';
    const reward = earnReward(state, 'leaves', 'test-choice');
    assert.ok(reward?.id);
    assert.deepEqual(Object.keys(state.rewardHistory[0]).sort(), ['rewardId', 'timestamp']);
    const normalized = normalizeState(state);
    assert.equal(normalized.rewardHistory.length, 1);
    assert.equal(normalized.rewardHistory[0].rewardId, reward.id);
    assert.equal(canEarnReward(normalized), false, 'cooldown should prevent an immediate second reward');
    assert.equal(selectRandomReward('leaves', 0).id, 'leaf_1');
  });

  it('every reward tier is reachable and requested tiers are honoured', () => {
    for (const tier of Object.keys(REWARD_CATALOG)) {
      assert.ok(REWARD_CATALOG[tier].length > 0, `${tier} must not be empty`);
      assert.equal(selectRandomReward(tier, 0).id, REWARD_CATALOG[tier][0].id);
      // Fresh state per tier so the cooldown does not mask a reachable tier.
      const state = emptyState();
      state.settings.enableRewards = true;
      const reward = earnReward(state, tier, 'tier-reachability');
      assert.equal(reward?.tier, tier, `${tier} must be earnable`);
      assert.ok(REWARD_CATALOG[tier].some((item) => item.id === reward.id));
    }
    assert.equal(selectRandomReward('missing-tier', 0), null);
  });

  it('rewards stay off until the user enables them', () => {
    const state = emptyState();
    assert.equal(state.settings.enableRewards, false, 'rewards are opt-in');
    assert.equal(earnReward(state, 'leaves', 'test-choice'), null);
    assert.deepEqual(state.rewardHistory, []);
  });

  it('reward copy avoids scores, durations and urgency', () => {
    const banned = /\b(score|points?|streak|combo|productive|productivity|minutes?|hours?|faster|hurry|deadline|expires?|limited time|don'?t lose|level up|rank)\b/i;
    const strings = [];
    for (const tier of Object.keys(REWARD_CATALOG)) for (const item of REWARD_CATALOG[tier]) strings.push(item.text);
    strings.push(rewardNote('return_to_root'), rewardNote('compost_choice'), rewardNote('session_end_user_ended'), rewardNote('mission_changed'));
    for (const text of strings) {
      assert.ok(text && text.length > 0, 'copy must not be empty');
      assert.doesNotMatch(text, banned, `reward copy must stay non-scoring: ${text}`);
    }
  });

  it('resolves stored reward history into newest-first finds', () => {
    const now = Date.now();
    const history = [
      { rewardId: 'seed_1', timestamp: now - 3000 },
      { rewardId: 'not_in_catalog', timestamp: now - 2000 },
      { rewardId: 'bloom_2', timestamp: now - 1000 }
    ];
    const finds = rewardHistoryView(history);
    assert.deepEqual(finds.map((find) => find.id), ['bloom_2', 'seed_1'], 'newest first, unknown ids skipped');
    assert.equal(finds[0].text, 'A session tended with care.');
    assert.equal(finds[0].tier, 'blooms');
    assert.equal(finds[1].tier, 'seeds');
    assert.equal(rewardHistoryView(history, 1).length, 1);
    assert.deepEqual(rewardHistoryView(null), []);
    assert.deepEqual(rewardHistoryView([{ rewardId: 'seed_1', timestamp: 'nope' }]), []);
  });

  it('explains why a reward appeared without inventing a reason', () => {
    assert.match(rewardNote('return_to_root'), /came back/);
    assert.match(rewardNote('session_end_browse_without_mission'), /set the garden down/);
    assert.match(rewardNote('mission_changed'), /new direction/);
    assert.equal(rewardNote('unknown_trigger'), '');
    assert.equal(rewardNote(''), '');
    assert.equal(rewardNote(undefined), '');
    const state = emptyState();
    state.settings.enableRewards = true;
    assert.match(earnReward(state, 'seeds', 'return_to_root').note, /came back/);
  });

  it('getDepthState maps explicit and default thresholds to states', () => {
    assert.strictEqual(getDepthState(0, false, { gentleDepth: 4, choiceDepth: 5 }), 'normal');
    assert.strictEqual(getDepthState(4, false, { gentleDepth: 4, choiceDepth: 5 }), 'desaturated');
    assert.strictEqual(getDepthState(5, false, { gentleDepth: 4, choiceDepth: 5 }), 'interrupted');
    assert.strictEqual(getDepthState(3, true, { gentleDepth: 4, choiceDepth: 5 }), 'paused');
    assert.strictEqual(getDepthState(4), 'desaturated');
    assert.strictEqual(getDepthState(5), 'interrupted');
  });

  it('canonicalUrl rejects malformed values instead of returning unsafe raw strings', () => {
    assert.strictEqual(canonicalUrl('not-a-url'), null);
    assert.strictEqual(canonicalUrl('javascript:alert(1)'), null);
    assert.strictEqual(canonicalUrl('https://user:password@example.com/private'), null);
    assert.strictEqual(canonicalUrl('https://example.com/path?utm_source=x#fragment'), 'https://example.com/path');
    assert.strictEqual(canonicalUrl(`https://example.com/${'x'.repeat(LIMITS.URL)}`), null);
    assert.strictEqual(safeHttpUrl(`https://example.com/${'x'.repeat(LIMITS.URL)}`), null);
  });

  it('recognizes Chromium new tabs without accepting arbitrary privileged URLs', () => {
    const accepted = [
      'chrome://newtab', 'chrome://newtab/', 'chrome://new-tab-page', 'chrome://new-tab-page/',
      'chrome://new-tab-page-third-party', 'brave://newtab', 'brave://newtab/', 'edge://newtab',
      'edge://newtab/', 'opera://startpage', 'opera://newtab', 'vivaldi://newtab', 'vivaldi://startpage',
      'chromium://newtab', 'chrome://vivaldi-webui/startpage'
    ];
    for (const url of accepted) {
      assert.strictEqual(isBrowserNewTabUrl(url), true, url);
      assert.strictEqual(safeSessionUrl(url), url);
      assert.strictEqual(safeHttpUrl(url), null, 'internal tabs must never become ordinary browsing pages');
    }
    for (const url of ['brave://settings', 'brave://history', 'brave://newtab.evil/', 'brave://newtab/settings',
      'brave://user@newtab/', 'brave://newtab:80/', 'chrome://newtab/other', 'brave-extension://test/newtab/index.html',
      'edge://settings', 'edge://newtab/settings', 'opera://settings', 'vivaldi://settings',
      'chrome://settings', 'chrome://extensions', 'chrome://vivaldi-webui/settings']) {
      assert.strictEqual(isBrowserNewTabUrl(url), false, url);
      assert.strictEqual(safeSessionUrl(url), null);
    }
    assert.strictEqual(isExtensionNewTabUrl('chrome-extension://test/newtab/index.html'), true);
    assert.strictEqual(isPlaceholderOriginUrl('edge://newtab'), true);
    assert.strictEqual(isPlaceholderOriginUrl('chrome-extension://test/newtab/index.html'), true);
    assert.strictEqual(isExtensionNewTabUrl('chrome-extension://other/newtab/index.html'), false);
  });

  it('safeSessionUrl accepts only the current extension origin or new-tab placeholder', () => {
    assert.strictEqual(safeSessionUrl('chrome://newtab'), 'chrome://newtab');
    assert.strictEqual(safeSessionUrl('chrome-extension://test/newtab/index.html'), 'chrome-extension://test/newtab/index.html');
    assert.strictEqual(safeSessionUrl('chrome-extension://test/'), 'chrome-extension://test/');
    assert.strictEqual(safeSessionUrl('chrome-extension://other/newtab/index.html'), null);
    assert.strictEqual(safeSessionUrl('chrome-extension://test'), null);
    assert.strictEqual(safeSessionUrl('javascript:alert(1)'), null);
    assert.strictEqual(safeSessionUrl(`chrome-extension://test/${'x'.repeat(LIMITS.URL)}`), null);
  });
});

describe('security invariants', () => {
  it('safeHttpUrl rejects dangerous schemes', () => {
    assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);
    assert.strictEqual(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
    assert.strictEqual(safeHttpUrl('file:///etc/passwd'), null);
    assert.strictEqual(safeHttpUrl('vbscript:msgbox(1)'), null);
    assert.strictEqual(safeHttpUrl('about:blank'), null);
  });

  it('safeHttpUrl strips tracking parameters and hashes', () => {
    const u = safeHttpUrl('https://example.com/path?utm_source=x&id=1#frag');
    assert.ok(u);
    assert.ok(!u.includes('utm_source'));
    assert.ok(u.includes('id=1'));
    assert.ok(!u.includes('#frag'));
  });

  it('compactText never throws on weird input', () => {
    assert.strictEqual(compactText(null), '');
    assert.strictEqual(compactText(undefined), '');
    assert.strictEqual(compactText(123), '123');
    assert.strictEqual(compactText('a\nb\tc'), 'a b c');
  });
});

describe('normalizeState migration and bounds', () => {
  it('migrates legacy tabId to tabIds and drops the tabId field', () => {
    const legacy = {
      sessions: [{
        id: 's1', mission: 'm', status: 'active', startedAt: 1,
        origin: { tabId: 5, url: 'https://example.com', title: 'Ex' },
        nodes: [{ id: 'n1', tabId: 7, url: 'https://example.com/page', title: 'Pg', parentId: null, depth: 0, state: 'normal' }],
        events: []
      }],
      activeSessionId: 's1'
    };
    const result = normalizeState(legacy);
    assert.strictEqual(result.schemaVersion, 5);
    assert.strictEqual(result.pathPatternReminderLastShownAt, 0, 'older state gets a fresh local cooldown');
    assert.strictEqual(normalizeState({ pathPatternReminderLastShownAt: -10 }).pathPatternReminderLastShownAt, 0);
    assert.strictEqual(normalizeState({ pathPatternReminderLastShownAt: 123.9 }).pathPatternReminderLastShownAt, 123);
    const node = result.sessions[0].nodes[0];
    assert.deepStrictEqual(node.tabIds, [7]);
    assert.ok(!('tabId' in node), 'legacy tabId should not survive normalization');
  });

  it('rejects javascript: URLs during normalization', () => {
    const poisoned = {
      sessions: [{
        id: 's1', mission: 'm', status: 'active', startedAt: 1,
        origin: { url: 'javascript:alert(1)' },
        nodes: [{ id: 'n1', url: 'javascript:alert(1)', title: 'x', parentId: null, depth: 0, state: 'normal' }],
        events: []
      }],
      compostItems: [{ id: 'c1', url: 'javascript:alert(1)', title: 'x', mission: 'm', depth: 1, savedAt: 1 }]
    };
    const result = normalizeState(poisoned);
    assert.strictEqual(result.sessions[0].origin.url, 'chrome://newtab');
    assert.strictEqual(result.sessions[0].nodes.length, 0);
    assert.strictEqual(result.compostItems.length, 0);
  });

  it('caps sessions, nodes, events, and compost to LIMITS', () => {
    const big = { ...emptyState() };
    big.sessions = Array.from({ length: LIMITS.SESSIONS + 5 }, (_, i) => ({
      id: `s${i}`, mission: 'm', status: 'completed', startedAt: i, endedAt: i + 1,
      origin: { url: 'https://example.com' },
      nodes: Array.from({ length: LIMITS.NODES_PER_SESSION + 5 }, (_, j) => ({ id: `n${i}_${j}`, url: `https://example.com/${j}`, title: 't', parentId: null, depth: 0, state: 'normal' })),
      events: Array.from({ length: LIMITS.EVENTS_PER_SESSION + 5 }, (_, k) => ({ id: `e${k}`, type: 'navigation', at: k }))
    }));
    big.compostItems = Array.from({ length: LIMITS.COMPOST + 5 }, (_, i) => ({ id: `c${i}`, url: `https://example.com/c${i}`, title: 't', mission: 'm', depth: 1, savedAt: i }));
    const result = normalizeState(big);
    assert.ok(result.sessions.length <= LIMITS.SESSIONS, `sessions ${result.sessions.length}`);
    for (const sess of result.sessions) {
      assert.ok(sess.nodes.length <= LIMITS.NODES_PER_SESSION, `nodes ${sess.nodes.length}`);
      assert.ok(sess.events.length <= LIMITS.EVENTS_PER_SESSION, `events ${sess.events.length}`);
    }
    assert.ok(result.compostItems.length <= LIMITS.COMPOST, `compost ${result.compostItems.length}`);
  });
});

describe('critical-quota compost compaction', () => {
  for (const behavior of ['retention', 'change result']) {
    it(`handles compost-only ${behavior}`, async () => {
      const originalGetBytesInUse = chrome.storage.local.getBytesInUse;
      const originalStoredState = storage[STORAGE_KEY];
      const items = Array.from({ length: 25 }, (_, index) => ({
        id: `saved-${index}`, url: `https://example.com/saved-${index}`,
        title: `Saved page ${index}`, mission: 'Research', depth: 1,
        savedAt: 25000 - index * 1000
      }));
      try {
        chrome.storage.local.getBytesInUse = async () => STORAGE_QUOTA_CRITICAL_THRESHOLD + 1;
        storage[STORAGE_KEY] = { ...emptyState(), compostItems: items };
        clearStateCache();
        const changed = await compactStateIfNeeded();
        if (behavior === 'retention') {
          assert.deepStrictEqual(storage[STORAGE_KEY].compostItems.map((item) => item.id),
            items.slice(0, 20).map((item) => item.id), 'persist the newest 20 saves, not the oldest');
          clearStateCache();
          assert.deepStrictEqual((await loadState()).compostItems.map((item) => item.id),
            items.slice(0, 20).map((item) => item.id), 'retention must survive a fresh storage read');
        } else {
          assert.strictEqual(changed, true, 'compost-only persistence must report a change');
          assert.strictEqual(await compactStateIfNeeded(), false, 'already compacted state must report no change');
        }
        assert.deepStrictEqual(storage[STORAGE_KEY].sessions, [], 'fixture must not remove any sessions');
      } finally {
        if (originalGetBytesInUse === undefined) delete chrome.storage.local.getBytesInUse;
        else chrome.storage.local.getBytesInUse = originalGetBytesInUse;
        if (originalStoredState === undefined) delete storage[STORAGE_KEY];
        else storage[STORAGE_KEY] = originalStoredState;
        clearStateCache();
      }
    });
  }
  it('does not expose unpersisted compaction after a failed write', async () => {
    const originalGetBytesInUse = chrome.storage.local.getBytesInUse;
    const originalStoredState = storage[STORAGE_KEY];
    try {
      chrome.storage.local.getBytesInUse = async () => STORAGE_QUOTA_CRITICAL_THRESHOLD + 1;
      storage[STORAGE_KEY] = { ...emptyState(), compostItems: Array.from({ length: 25 }, (_, i) => ({
        id: `failure-${i}`, url: `https://example.com/${i}`, savedAt: i
      })) };
      clearStateCache();
      const before = structuredClone(await loadState());
      failNextSet = true;
      await assert.rejects(compactStateIfNeeded(), /simulated storage write failure/);
      assert.deepStrictEqual(await loadState(), before, 'failed compaction must leave cached history intact');
      clearStateCache();
      assert.deepStrictEqual(await loadState(), before, 'cache and durable state must agree');
    } finally {
      failNextSet = false;
      if (originalGetBytesInUse === undefined) delete chrome.storage.local.getBytesInUse;
      else chrome.storage.local.getBytesInUse = originalGetBytesInUse;
      if (originalStoredState === undefined) delete storage[STORAGE_KEY];
      else storage[STORAGE_KEY] = originalStoredState;
      clearStateCache();
    }
  });
});

describe('storage cache and invalidation', () => {
  it('caches reads, invalidates on external storage changes, and ignores changes during own writes', async () => {
    clearStateCache();
    storage[STORAGE_KEY] = sessionFixture('s1');
    const first = await loadState();
    storage[STORAGE_KEY] = sessionFixture('s2');
    assert.strictEqual((await loadState()).sessions[0].id, 's1');

    fireStorageChange(storage[STORAGE_KEY], sessionFixture('s1'));
    const refreshed = await loadState();
    assert.strictEqual(refreshed.sessions[0].id, 's2');

    const next = sessionFixture('s3');
    heldSetCount = 1;
    const started = new Promise((resolve) => { setStartResolvers.push(resolve); });
    const savePromise = saveState(next);
    await started;
    fireStorageChange(next, refreshed);
    assert.strictEqual((await loadState()).sessions[0].id, 's2', 'own-write change must not evict cache while save is in flight');
    setReleaseResolvers.shift()?.();
    await savePromise;
    assert.strictEqual((await loadState()).sessions[0].id, 's3');

    const overlapBase = await loadState();
    heldSetCount = 2;
    const firstStarted = new Promise((resolve) => { setStartResolvers.push(resolve); });
    const secondStarted = new Promise((resolve) => { setStartResolvers.push(resolve); });
    const firstSave = saveState(sessionFixture('s4'));
    const secondSave = saveState(sessionFixture('s5'));
    await Promise.all([firstStarted, secondStarted]);
    fireStorageChange(sessionFixture('external'), overlapBase);
    assert.strictEqual((await loadState()).sessions[0].id, 's3', 'external change must not evict cache while overlapping own writes remain in flight');
    setReleaseResolvers.shift()?.();
    setReleaseResolvers.shift()?.();
    await Promise.all([firstSave, secondSave]);
    assert.strictEqual((await loadState()).sessions[0].id, 's5');

    storage[STORAGE_KEY] = sessionFixture('s6');
    fireStorageChange(storage[STORAGE_KEY], sessionFixture('s5'));
    assert.strictEqual((await loadState()).sessions[0].id, 's6');

    clearStateCache();
    failNextGet = true;
    assert.deepStrictEqual((await loadState()).sessions, [], 'storage read failure must return an empty safe state');
    storage[STORAGE_KEY] = sessionFixture('s7');
    clearStateCache();
    await loadState();
    failNextSet = true;
    await assert.rejects(saveState(sessionFixture('failed')), /simulated storage write failure/);
    storage[STORAGE_KEY] = sessionFixture('s8');
    fireStorageChange(storage[STORAGE_KEY], sessionFixture('s7'));
    assert.strictEqual((await loadState()).sessions[0].id, 's8', 'failed writes must release the cache guard');
  });
});

describe('drift accounting and rewards', () => {
  const node = (depth, secondsAgo = 0, closedAfter = null) => ({
    id: `n${depth}-${secondsAgo}`, depth, firstSeenAt: Date.now() - secondsAgo * 1000,
    ...(closedAfter == null ? {} : { closedAt: Date.now() - closedAfter * 1000 })
  });

  it('driftStats counts pages at or beyond the quiet line and their seconds', () => {
    const session = { nodes: [node(0), node(2), node(4, 120, 60), node(5, 30)] };
    const stats = driftStats(session, { gentleDepth: 4 });
    assert.equal(stats.pages, 2);
    assert.ok(stats.seconds >= 85 && stats.seconds <= 95, `closed node contributes its fixed span (got ${stats.seconds})`);
  });

  it('driftStats is empty-safe and honors the DESATURATE alias', () => {
    assert.deepStrictEqual(driftStats(null, { gentleDepth: 4 }), { pages: 0, seconds: 0 });
    assert.deepStrictEqual(driftStats({ nodes: [] }, { DESATURATE: 4 }), { pages: 0, seconds: 0 });
  });

  it('reward catalog keeps unique ids without grading path depth', () => {
    const ids = Object.values(REWARD_CATALOG).flat().map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, 'catalog ids must stay unique');
    assert.equal(rewardNote('low_drift_completion'), '');
  });
});
