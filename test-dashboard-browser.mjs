import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { emptyState, normalizeSettings, STORAGE_KEY } from './shared/state.js';
import { resolveBraveExecutablePath } from './scripts/browser-runtime.mjs';

// Exercise the real HTML, CSS, modules, and extension CSP in Brave locally
// (Playwright-managed Chromium on CI runners that do not have Brave installed).
// Only Chrome's messaging/storage APIs are mocked; no external website is used.
const root = new URL('.', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
let browser;
before(async () => {
  const executablePath = resolveBraveExecutablePath();
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});
after(async () => { await browser?.close(); });

function garden(count, id = 'garden-one') {
  const startedAt = Date.UTC(2026, 8, 7, 9);
  return {
    id, mission: 'Research a little more intentionally', status: 'active', startedAt,
    endedAt: null, endReason: null, interventionPaused: false, events: [],
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `${id}-node-${index}`, parentId: index ? `${id}-node-${index - 1}` : null,
      depth: index, url: `https://example.test/page-${index}`, title: `Research page ${index + 1}`,
      state: 'normal', relationshipConfidence: 'direct', firstSeenAt: startedAt + index * 1000, tabIds: []
    }))
  };
}
function stateFor(...sessions) {
  return { ...emptyState(), sessions, activeSessionId: sessions.at(-1)?.id || null };
}
async function openDashboard(t, state = stateFor(), viewport = { width: 1440, height: 1000 }, reducedMotion = 'reduce', colorScheme = 'light') {
  const context = await browser.newContext({ viewport, reducedMotion, colorScheme });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(() => assert.deepEqual(errors, [], 'dashboard must not log rendering or CSP errors'));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://intent-grove.test') return route.abort();
    const pathname = url.pathname.slice(1);
    const contentType = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.png') ? 'image/png' : 'text/html';
    await route.fulfill({
      body: await readFile(new URL(pathname, root)), contentType,
      headers: { 'Content-Security-Policy': manifest.content_security_policy.extension_pages }
    });
  });
  await page.addInitScript(({ initialState, storageKey }) => {
    let state = initialState;
    const listeners = new Set();
    globalThis.chrome = {
      action: {
        async getUserSettings() { return { isOnToolbar: globalThis.testIsPinned ?? false }; },
        onUserSettingsChanged: { addListener(listener) { globalThis.testPinListener = listener; } }
      },
      runtime: {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        getManifest: () => ({ version: '0.3.4' }),
        async sendMessage(message) {
          globalThis.contentMessages ||= [];
          globalThis.contentMessages.push(message);
          if (message.type === 'GET_SNAPSHOT') {
            const selected = state.sessions.find(session => session.id === message.sessionId);
            const active = state.sessions.find(session => session.id === state.activeSessionId);
            // Mirrors the worker's getSnapshot(): thresholds are derived from the
            // user's rhythm so the fixture cannot pass while production disagrees.
            const settings = state.settings;
            return structuredClone({
              state, activeSessionId: state.activeSessionId,
              session: selected || active || state.sessions.at(-1) || null,
              settings, thresholds: { DESATURATE: settings.gentleDepth, INTERRUPT: settings.choiceDepth }
            });
          }
          if (message.type === 'COMPLETE_ONBOARDING') {
            state = { ...state, onboardingCompleted: true };
            return null;
          }
          if (message.type === 'GET_ACTIVE_VIEW') return { session: null, settings: { growthAnimationTrigger: 'none' } };
          if (message.type === 'OBSERVE_PAGE') return null;
          if (message.type === 'SPA_NAVIGATION') return null;
          if (message.type === 'GET_PATH_PATTERN_ANALYSIS') {
            return structuredClone(state.pathPatternAnalysis || { windowStart: '2026-07-27', windowEnd: '2026-09-20', sampleSize: 0, patterns: {} });
          }
          if (message.type === 'GET_PATH_PATTERN_REMINDER') {
            const reminder = structuredClone(state.pathPatternReminder || null);
            state.pathPatternReminder = null;
            return reminder;
          }
          if (message.type === 'GET_DASHBOARD_STATS') {
            return { totalSessions: state.sessions.length, totalFocusTime: 0, currentStreak: 0,
              weeklyData: [], weeklyTrendData: state.weeklyTrendData || [], domainData: [], history: [], savedItems: [] };
          }
          throw new Error(`Unexpected test message: ${message.type}`);
        }
      },
      storage: { onChanged: {
        addListener: listener => listeners.add(listener),
        removeListener: listener => listeners.delete(listener)
      } }
    };
    globalThis.changeTestPinState = pinned => {
      globalThis.testIsPinned = pinned;
      globalThis.testPinListener?.({ isOnToolbar: pinned });
    };
    globalThis.updateTestState = next => {
      const oldValue = state;
      state = next;
      for (const listener of listeners) listener({ [storageKey]: { oldValue, newValue: state } }, 'local');
    };
  }, { initialState: state, storageKey: STORAGE_KEY });
  await page.goto('https://intent-grove.test/dashboard/index.html');
  await page.waitForFunction(() => document.querySelector('#tree').dataset.treeMode);
  return page;
}

async function openSettings(t, options = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  t.after(() => assert.deepEqual(pageErrors, [], 'settings must not raise unhandled errors'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://intent-grove.test') return route.abort();
    const pathname = url.pathname.slice(1);
    const contentType = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' : 'text/html';
    await route.fulfill({
      body: await readFile(new URL(pathname, root)), contentType,
      headers: { 'Content-Security-Policy': manifest.content_security_policy.extension_pages }
    });
  });
  let settings = { ...emptyState().settings, ...options.settings };
  let snapshotCount = 0;
  let updateCount = 0;
  await page.exposeFunction('settingsReply', async (message, failUpdate) => {
    if (message.type === 'GET_SNAPSHOT') {
      snapshotCount += 1;
      if (options.snapshot) return options.snapshot(snapshotCount, settings);
      return { settings };
    }
    if (message.type === 'UPDATE_SETTINGS') {
      updateCount += 1;
      if (options.update) return options.update(message.settings, updateCount, settings);
      if (failUpdate) return { error: 'INTERNAL_ERROR' };
      settings = normalizeSettings({ ...settings, ...message.settings });
      return settings;
    }
    throw new Error(`Unexpected settings test message: ${message.type}`);
  });
  await page.addInitScript(failUpdate => {
    globalThis.settingsCalls = [];
    globalThis.failSettingsUpdate = failUpdate;
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.3.4' }),
        async sendMessage(message) {
          globalThis.settingsCalls.push(structuredClone(message));
          return globalThis.settingsReply(message, globalThis.failSettingsUpdate);
        }
      },
      storage: { onChanged: { addListener() {} } }
    };
  }, options.failUpdate ?? true);
  await page.goto('https://intent-grove.test/settings/index.html');
  await page.waitForFunction(() => /already tending|could not load/.test(document.querySelector('#status').textContent));
  if (!options.groupsCollapsed) {
    await page.locator('details.settings-group').evaluateAll(groups => groups.forEach(group => { group.open = true; }));
  }
  return { page, consoleErrors };
}

test('settings save preserves edits on worker error', async t => {
  const { page, consoleErrors } = await openSettings(t);
  assert.equal(await page.locator('#save').isDisabled(), true);
  await page.locator('#search-engine').selectOption('brave');
  await page.locator('#save').click();
  await waitForSettingsResult(page);
  assert.equal(await page.locator('#status').textContent(), 'The rhythm could not be confirmed as saved. Your edits are still here; try again.');
  assert.equal(await page.locator('#search-engine').inputValue(), 'brave');
  assert.equal(await page.locator('#save').isEnabled(), true, 'failed save must remain retryable');
  assert.equal(consoleErrors.length, 2, 'helper and save boundary should log the handled error');
  for (const error of consoleErrors) {
    assert.match(error, /Category: messaging/);
    assert.match(error, /Message: INTERNAL_ERROR/);
  }
  assert.match(consoleErrors[0], /"operation": "sendMessage"/);
  assert.match(consoleErrors[1], /"function": "save.click"/);

  // Returning to the last acknowledged value must clear dirty state after failure.
  await page.locator('#search-engine').selectOption('default');
  assert.equal(await page.locator('#save').isDisabled(), true);
  await page.locator('#search-engine').selectOption('brave');
  await page.evaluate(() => { globalThis.failSettingsUpdate = false; });
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Your rhythm is tending the grove now.');
  assert.equal(await page.locator('#search-engine').inputValue(), 'brave');
  assert.equal(await page.locator('#save').isDisabled(), true);
  const updates = await page.evaluate(() => settingsCalls.filter(message => message.type === 'UPDATE_SETTINGS'));
  assert.equal(updates.length, 2);
  assert.equal(updates[0].settings.searchEngine, 'brave');
  assert.deepEqual(updates[1], updates[0], 'retry must submit the preserved settings');
  assert.equal(consoleErrors.length, 2, 'retry must not introduce unexpected console errors');
});


async function waitForSettingsResult(page) {
  await page.waitForFunction(() => /could not|tending the grove now|original rhythm has returned/.test(document.querySelector('#status').textContent));
}
function assertSettingsErrors(errors, message, count) {
  assert.equal(errors.length, count);
  for (const error of errors) {
    assert.match(error, /Category: messaging/);
    assert.ok(error.includes(`Message: ${message}`), error);
  }
}

test('settings normalize successful acknowledgements without changing worker-owned fields', async t => {
  const { page, consoleErrors } = await openSettings(t, { failUpdate: false, settings: { interventionsPaused: true } });
  await page.locator('#excluded-sites').fill('WWW.Example.COM\nexample.com\nother.test');
  await page.locator('#motion').focus();
  await page.keyboard.press('Space');
  await page.locator('#save').click();
  await waitForSettingsResult(page);
  assert.equal(await page.locator('#excluded-sites').inputValue(), 'example.com\nother.test');
  assert.equal(await page.locator('#motion').isChecked(), false);
  assert.equal(await page.locator('#save').isDisabled(), true);
  const submitted = await page.evaluate(() => settingsCalls.find(call => call.type === 'UPDATE_SETTINGS').settings);
  assert.equal(Object.hasOwn(submitted, 'interventionsPaused'), false);
  await page.locator('#search-engine').selectOption('brave');
  await page.locator('#search-engine').selectOption('default');
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.deepEqual(consoleErrors, []);
});

test('weekly path reflection reminders are opt-in in Settings and reset to off', async t => {
  const { page, consoleErrors } = await openSettings(t, { failUpdate: false });
  const toggle = page.locator('#path-pattern-reminders-enabled');
  assert.equal(await toggle.isChecked(), false, 'the new reminder must default off');
  const reminderDescription = (await page.locator('label.toggle:has(#path-pattern-reminders-enabled)').innerText()).replace(/\s+/g, ' ');
  assert.match(reminderDescription, /Off by default.*once every seven days.*60%.*notification permission/i);
  await page.locator('label.toggle:has(#path-pattern-reminders-enabled) strong').click();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Your rhythm is tending the grove now.');
  assert.equal((await page.evaluate(() => settingsCalls.find(call => call.type === 'UPDATE_SETTINGS').settings)).pathPatternRemindersEnabled, true);
  assert.equal(await toggle.isChecked(), true);
  await page.locator('#reset').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'The original rhythm has returned.');
  assert.equal(await toggle.isChecked(), false, 'reset must restore the default-off preference');
  assert.deepEqual(consoleErrors, []);
});

for (const scenario of [
  { name: 'transport rejection', update: () => { throw new Error('Transport unavailable'); }, error: 'Transport unavailable', logs: 2 },
  { name: 'malformed acknowledgement', update: () => ({}), error: 'Invalid settings acknowledgement', logs: 1 },
  { name: 'missing acknowledgement', update: () => undefined, error: 'Invalid settings acknowledgement', logs: 1 },
  { name: 'invalid acknowledgement fields', update: candidate => ({ ...candidate, ambientMotion: 'yes' }), error: 'Invalid settings acknowledgement', logs: 1 },
  { name: 'null with mismatching snapshot', update: () => null, error: 'Settings save could not be confirmed', logs: 1 },
  { name: 'null with invalid snapshot', update: () => null, snapshot: (count, settings) => count === 1 ? { settings } : {}, error: 'Invalid settings acknowledgement', logs: 1 },
  { name: 'null with failed snapshot', update: () => null, snapshot: (count, settings) => count === 1 ? { settings } : { error: 'INTERNAL_ERROR' }, error: 'INTERNAL_ERROR', logs: 2 }
]) {
  test(`settings preserve edits after ${scenario.name}`, async t => {
    const { page, consoleErrors } = await openSettings(t, scenario);
    await page.locator('#search-engine').selectOption('brave');
    await page.locator('#save').click();
    await waitForSettingsResult(page);
    assert.match(await page.locator('#status').textContent(), /could not/);
    assert.doesNotMatch(await page.locator('#status').textContent(), /Nothing was changed/);
    assert.equal(await page.locator('#search-engine').inputValue(), 'brave');
    assert.equal(await page.locator('#save').isEnabled(), true);
    await page.locator('#search-engine').selectOption('default');
    assert.equal(await page.locator('#save').isDisabled(), true);
    assertSettingsErrors(consoleErrors, scenario.error, scenario.logs);
  });
}

test('settings confirm null using a matching normalized snapshot', async t => {
  let acknowledged;
  const { page, consoleErrors } = await openSettings(t, {
    update: candidate => { acknowledged = normalizeSettings(candidate); return null; },
    snapshot: (count, settings) => ({ settings: count === 1 ? settings : acknowledged })
  });
  await page.locator('#excluded-sites').fill('example.test\nexample.test');
  await page.locator('#save').click();
  await waitForSettingsResult(page);
  assert.equal(await page.locator('#excluded-sites').inputValue(), 'example.test');
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.equal(await page.evaluate(() => settingsCalls.filter(call => call.type === 'GET_SNAPSHOT').length), 2);
  assert.deepEqual(consoleErrors, []);
});

for (const snapshot of [null, {}, { settings: {} }, { settings: { ...emptyState().settings, gentleDepth: 99 } }]) {
  test(`settings reject invalid initial snapshot ${JSON.stringify(snapshot)}`, async t => {
    const { page, consoleErrors } = await openSettings(t, { snapshot: () => snapshot });
    assert.match(await page.locator('#status').textContent(), /could not load/);
    await page.locator('#search-engine').selectOption('brave');
    assert.equal(await page.locator('#save').isDisabled(), true);
    assert.equal(await page.locator('#reset').isDisabled(), true);
    assertSettingsErrors(consoleErrors, 'Invalid settings acknowledgement', 1);
  });
}

test('settings reset preserves edits on failure and supports a successful retry', async t => {
  const { page, consoleErrors } = await openSettings(t, { settings: { searchEngine: 'brave', ambientMotion: false } });
  await page.locator('#excluded-sites').fill('keep.test');
  await page.locator('#reset').click();
  await waitForSettingsResult(page);
  assert.match(await page.locator('#status').textContent(), /could not be restored/);
  assert.equal(await page.locator('#search-engine').inputValue(), 'brave');
  assert.equal(await page.locator('#excluded-sites').inputValue(), 'keep.test');
  assert.equal(await page.locator('#motion').isChecked(), false);
  assert.equal(await page.locator('#reset').isEnabled(), true);
  await page.locator('#excluded-sites').fill('');
  assert.equal(await page.locator('#save').isDisabled(), true, 'failed reset must retain the acknowledged baseline');
  await page.evaluate(() => { globalThis.failSettingsUpdate = false; });
  await page.locator('#reset').click();
  await waitForSettingsResult(page);
  assert.equal(await page.locator('#status').textContent(), 'The original rhythm has returned.');
  assert.equal(await page.locator('#search-engine').inputValue(), 'default');
  assert.equal(await page.locator('#motion').isChecked(), true);
  assert.equal(await page.locator('#save').isDisabled(), true);
  assertSettingsErrors(consoleErrors, 'INTERNAL_ERROR', 2);
  assert.match(consoleErrors[1], /"function": "reset.click"/);
});

test('settings reset confirms an already-default null reply', async t => {
  const { page, consoleErrors } = await openSettings(t, { update: () => null });
  await page.locator('#excluded-sites').fill('discard.test');
  await page.locator('#reset').click();
  await waitForSettingsResult(page);
  assert.equal(await page.locator('#status').textContent(), 'The original rhythm has returned.');
  assert.equal(await page.locator('#excluded-sites').inputValue(), '');
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.equal(await page.evaluate(() => settingsCalls.filter(call => call.type === 'GET_SNAPSHOT').length), 2);
  assert.deepEqual(consoleErrors, []);
});

for (const restoring of [false, true]) {
  test(`settings preserve newer edits while ${restoring ? 'reset' : 'save'} is pending`, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { page, consoleErrors } = await openSettings(t, {
      update: async candidate => { await pending; return normalizeSettings(candidate); }
    });
    await page.locator('#search-engine').selectOption('brave');
    await page.locator(restoring ? '#reset' : '#save').click();
    await page.waitForFunction(() => settingsCalls.some(call => call.type === 'UPDATE_SETTINGS'));
    await page.locator('#search-engine').selectOption('google');
    assert.equal(await page.locator('#save').isDisabled(), true);
    assert.equal(await page.locator('#reset').isDisabled(), true);
    // Dispatch directly to exercise the handler guard as well as disabled buttons.
    await page.evaluate(() => {
      document.querySelector('#save').dispatchEvent(new Event('click'));
      document.querySelector('#reset').dispatchEvent(new Event('click'));
    });
    release();
    await page.waitForFunction(() => /newer edits/.test(document.querySelector('#status').textContent));
    assert.equal(await page.locator('#search-engine').inputValue(), 'google');
    assert.equal(await page.locator('#save').isEnabled(), true);
    assert.equal(await page.evaluate(() => settingsCalls.filter(call => call.type === 'UPDATE_SETTINGS').length), 1);
    await page.locator('#search-engine').selectOption(restoring ? 'default' : 'brave');
    assert.equal(await page.locator('#save').isDisabled(), true, 'baseline must be the acknowledgement, not the newer edit');
    assert.deepEqual(consoleErrors, []);
  });
}

test('settings presets make common rhythms one click away without auto-saving', async t => {
  const { page, consoleErrors } = await openSettings(t);
  await page.locator('[data-preset="accountable"]').click();
  assert.equal(await page.locator('#gentle').inputValue(), '3');
  assert.equal(await page.locator('#choice').inputValue(), '4');
  assert.equal(await page.locator('#strict-mode').isChecked(), true, 'Accountable preset enables firmer reminders');
  assert.equal(await page.locator('#save').isEnabled(), true);
  assert.equal(await page.evaluate(() => settingsCalls.some(call => call.type === 'UPDATE_SETTINGS')), false);
  await page.locator('[data-preset="gentle"]').click();
  assert.equal(await page.locator('#gentle').inputValue(), '8');
  assert.equal(await page.locator('#choice').inputValue(), '10');
  assert.equal(await page.locator('#strict-mode').isChecked(), false, 'Gentle preset returns to non-strict wording');
  assert.deepEqual(consoleErrors, []);
});

test('forest finds list earned reflections and stay hidden when there are none', async t => {
  const now = Date.UTC(2026, 8, 7, 9);
  const withFinds = stateFor();
  withFinds.rewardHistory = [
    { rewardId: 'seed_1', timestamp: now - 60000 },
    { rewardId: 'not_in_catalog', timestamp: now - 30000 },
    { rewardId: 'bloom_2', timestamp: now }
  ];
  const page = await openDashboard(t, withFinds);
  assert.equal(await page.locator('#finds-panel').isVisible(), true);
  assert.deepEqual(
    await page.locator('.find-item strong').allTextContents(),
    ['A session tended with care.', 'The root is still here.'],
    'finds are newest first and unknown catalog ids are skipped'
  );
  assert.equal(await page.locator('.find-item').count(), 2);
  assert.match(await page.locator('#finds-panel .panel-intro').textContent(), /never a score/);

  const emptyPage = await openDashboard(t, stateFor());
  assert.equal(await emptyPage.locator('#finds-panel').isVisible(), false, 'no history means no panel');
});

test('the garden follows the rhythm the user chose instead of fixed depths', async t => {
  const custom = stateFor(garden(4));
  custom.settings = { ...custom.settings, gentleDepth: 2, choiceDepth: 3 };
  const page = await openDashboard(t, custom);
  const classOf = id => page.locator(`#tree .node[data-node-id="${id}"]`).getAttribute('class');
  assert.match(await classOf('garden-one-node-0'), /\broot\b/);
  assert.match(await classOf('garden-one-node-1'), /\bhealthy\b/);
  assert.match(await classOf('garden-one-node-2'), /\blong\b/, 'depth 2 is the gentle threshold this user chose');
  assert.match(await classOf('garden-one-node-3'), /\bdeep\b/, 'depth 3 is the choice threshold this user chose');
  assert.equal(await page.locator('#storyline').textContent(), 'You grew 4 pages. The longest traced path is 3 navigation steps from its root; only you know whether it served your intention.');

  // An unconfigured garden must keep the default rhythm's appearance.
  const defaultPage = await openDashboard(t, stateFor(garden(4)));
  assert.match(await defaultPage.locator('#tree .node[data-node-id="garden-one-node-3"]').getAttribute('class'), /\bhealthy\b/);
  assert.equal(await defaultPage.locator('#storyline').textContent(), 'You grew 4 pages from a single clear intention.');
});

test('every trail note reads as a sentence instead of an internal identifier', async t => {
  const state = stateFor(garden(1));
  state.sessions[0].events = [
    { id: 'e1', type: 'mission_started', at: 1, mission: 'Test the trail' },
    { id: 'e2', type: 'origin_planted', at: 2 },
    { id: 'e3', type: 'navigation', at: 3, url: 'https://example.test/a' },
    { id: 'e4', type: 'external_path', at: 4, url: 'https://example.test/b' },
    { id: 'e5', type: 'tab_joined_path', at: 5 },
    { id: 'e6', type: 'return_to_path', at: 6 },
    { id: 'e7', type: 'composted', at: 7 },
    { id: 'e8', type: 'pruned', at: 8 },
    { id: 'e9', type: 'mission_changed', at: 9 },
    { id: 'e10', type: 'mission_ended', at: 10, reason: 'browse_without_mission' },
    { id: 'e11', type: 'link_opened', at: 11 },
    { id: 'e12', type: 'garden_at_capacity', at: 12 },
    { id: 'e13', type: 'back_forward', at: 13 },
    { id: 'e14', type: 'reload', at: 14 },
    { id: 'e15', type: 'search_refinement', at: 15 },
    { id: 'e16', type: 'future_event_type', at: 16 }
  ];
  const page = await openDashboard(t, state);
  const notes = await page.locator('#events .event strong').allTextContents();
  assert.equal(notes.length, 16);
  for (const note of notes) {
    assert.match(note, /[.!]$/, `trail note must read as a sentence: ${note}`);
    assert.doesNotMatch(note, /_/, `trail note must not leak an identifier: ${note}`);
    assert.doesNotMatch(note, /^[a-z]/, `trail note must start with a capital: ${note}`);
  }
  // Newest first, and every worker event type has purposeful copy.
  assert.deepEqual(notes.slice(0, 5), [
    'Future event type.',
    'Refined a search instead of following a new branch.',
    'Reloaded the page you were already on.',
    'Stepped back to a page already in this trail.',
    'This garden reached its page limit, so a new path was not added.'
  ]);
});

 test('empty garden is visible immediately, including when the active Map button is clicked', async t => {
  const page = await openDashboard(t);
  assert.equal(await page.locator('#tree').isVisible(), true);
  assert.equal(await page.locator('#tree').getAttribute('data-tree-mode'), 'empty');
  await page.locator('[data-tab="map"]').click();
  assert.equal(await page.locator('#tree').isVisible(), true);
  assert.equal(await page.locator('#stats-tab').isVisible(), false);
  assert.equal(await page.locator('#branch-detail').isVisible(), false);
});

test('weekly intention charts show eight factual activity and path buckets', async t => {
  const state = stateFor();
  state.weeklyTrendData = [
    ['2026-07-27', 'Jul 27', 0, 0], ['2026-08-03', 'Aug 3', 0, 0],
    ['2026-08-10', 'Aug 10', 0, 0], ['2026-08-17', 'Aug 17', 0, 0],
    ['2026-08-24', 'Aug 24', 0, 0], ['2026-08-31', 'Aug 31', 0, 0],
    ['2026-09-07', 'Sep 7', 1, 5], ['2026-09-14', 'Sep 14', 2, 2.5]
  ].map(([weekStart, weekLabel, intentionsStarted, averageDeepestPath]) => ({
    weekStart, weekLabel, intentionsStarted, averageDeepestPath
  }));
  const page = await openDashboard(t, state);
  await page.locator('[data-tab="stats"]').click();

  const intentions = page.locator('#weeklyIntentionsChart .weekly-trend-bar');
  const paths = page.locator('#weeklyPathChart .weekly-trend-bar');
  assert.equal(await intentions.count(), 8);
  assert.equal(await paths.count(), 8);
  assert.equal(await intentions.nth(6).locator('title').textContent(), 'Week of 2026-09-07: 1 intention started');
  assert.equal(await intentions.nth(7).locator('title').textContent(), 'Week of 2026-09-14: 2 intentions started');
  assert.equal(await paths.nth(7).locator('title').textContent(), 'Week of 2026-09-14: 2.5 average deepest navigation steps');
  assert.match(await page.locator('#weeklyPathChart').getAttribute('aria-label'), /^Average deepest path in navigation steps for the last eight Monday–Sunday UTC weeks:/);
  assert.match(await page.locator('#weeklyPathChart').getAttribute('aria-label'), /Sep 14: 2\.5/);
  const pathHelp = await page.locator('#weeklyPathChart').evaluate((svg) => svg.closest('.chart-card').querySelector('.chart-help').textContent);
  assert.match(pathHelp, /does not tell us whether a path served your intention/i);

  const mobilePage = await openDashboard(t, state, { width: 390, height: 844 });
  await mobilePage.locator('[data-tab="stats"]').click();
  for (const chartId of ['#weeklyIntentionsChart', '#weeklyPathChart']) {
    const rightEdge = await mobilePage.locator(chartId).evaluate((svg) => svg.getBoundingClientRect().right);
    assert.ok(rightEdge <= 390, `${chartId} must fit within a 390px viewport (right edge ${rightEdge})`);
  }
  const lightPathFill = await mobilePage.locator('#weeklyPathChart .weekly-trend-bar').first().evaluate((bar) => getComputedStyle(bar).fill);
  await mobilePage.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const darkPathFill = await mobilePage.locator('#weeklyPathChart .weekly-trend-bar').first().evaluate((bar) => getComputedStyle(bar).fill);
  assert.notEqual(darkPathFill, lightPathFill, 'the weekly path chart must respond to the selected dark theme');
});

test('weekly intention charts explain when no sessions fall in the displayed weeks', async t => {
  const page = await openDashboard(t);
  await page.locator('[data-tab="stats"]').click();
  assert.equal(await page.locator('#weeklyIntentionsChart .weekly-trend-bar').count(), 0);
  assert.equal(await page.locator('#weeklyIntentionsChart .trend-empty-state').textContent(), 'No intentions started in these eight weeks.');
  assert.equal(await page.locator('#weeklyPathChart .trend-empty-state').textContent(), 'No intentions started in these eight weeks.');
});

test('path patterns are generated only on request and present as overlapping observed-path signals', async t => {
  const state = stateFor();
  state.pathPatternAnalysis = {
    windowStart: '2026-07-27', windowEnd: '2026-09-20', sampleSize: 5,
    patterns: { branching: 3, straightThrough: 2, searchRefining: 1, revisiting: 2 }
  };
  const page = await openDashboard(t, state);
  await page.locator('[data-tab="stats"]').click();
  assert.equal(await page.locator('#path-pattern-results').isHidden(), true);
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_ANALYSIS').length), 0,
    'opening Insights & Stats must not generate a pattern classification automatically');

  await page.locator('#analyze-path-patterns').click();
  await page.waitForFunction(() => document.querySelector('#path-pattern-results').innerText.includes('This summary uses 5 saved gardens'));
  const result = page.locator('#path-pattern-results');
  const text = await result.innerText();
  for (const label of ['Branching paths', 'Straight-through paths', 'Search-refining paths', 'Revisiting paths']) assert.match(text, new RegExp(label));
  assert.match(text, /3 of 5 saved gardens/);
  assert.match(text, /Patterns can overlap/);
  assert.match(text, /not a psychological profile, diagnosis, score/);
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_ANALYSIS').length), 1);

  const lightCard = await result.locator('.path-pattern-card').first().evaluate(card => getComputedStyle(card).backgroundColor);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const darkCard = await result.locator('.path-pattern-card').first().evaluate(card => getComputedStyle(card).backgroundColor);
  assert.notEqual(darkCard, lightCard, 'pattern cards should respond to the selected dark theme');

  const mobilePage = await openDashboard(t, state, { width: 390, height: 844 });
  await mobilePage.locator('[data-tab="stats"]').click();
  await mobilePage.locator('#analyze-path-patterns').click();
  await mobilePage.waitForFunction(() => document.querySelector('#path-pattern-results').innerText.includes('This summary uses 5 saved gardens'));
  const cardRightEdge = await mobilePage.locator('#path-pattern-results .path-pattern-card').first().evaluate(card => card.getBoundingClientRect().right);
  assert.ok(cardRightEdge <= 390, `path-pattern cards must fit a 390px viewport (right edge ${cardRightEdge})`);

  await page.locator('#analyze-path-patterns').click();
  await page.waitForFunction(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_ANALYSIS').length === 2);
});

test('weekly path reminder is a quiet opt-in Stats note with Review and Not now actions', async t => {
  const state = stateFor();
  state.settings.pathPatternRemindersEnabled = true;
  state.pathPatternReminder = { patternKey: 'branching', matchCount: 3, sampleSize: 5 };
  state.pathPatternAnalysis = {
    windowStart: '2026-07-27', windowEnd: '2026-09-20', sampleSize: 5,
    patterns: { branching: 3, straightThrough: 2, searchRefining: 1, revisiting: 2 }
  };
  const page = await openDashboard(t, state);
  const reminder = page.locator('#path-pattern-reminder');
  assert.equal(await reminder.isHidden(), true, 'the note stays out of the initial Map view');
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_REMINDER').length), 0);
  await page.locator('[data-tab="stats"]').click();
  await page.waitForFunction(() => !document.querySelector('#path-pattern-reminder').hidden);
  assert.equal(await reminder.getAttribute('role'), 'status');
  assert.match(await page.locator('#path-pattern-reminder-copy').innerText(), /Branching paths appeared in 3 of 5 completed gardens/);
  assert.match(await page.locator('#path-pattern-reminder-copy').innerText(), /not relevance, attention/);
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_REMINDER').length), 1);
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_ANALYSIS').length), 0,
    'showing the note must not request the full, user-visible summary without a click');
  assert.equal(Boolean(manifest.permissions?.includes('notifications')), false,
    'the inline reminder must not add Chrome notification permission');

  const lightBackground = await reminder.evaluate(card => getComputedStyle(card).backgroundColor);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const darkBackground = await reminder.evaluate(card => getComputedStyle(card).backgroundColor);
  assert.notEqual(darkBackground, lightBackground, 'the note must remain legible in dark theme');
  await page.locator('#review-path-patterns').click();
  await page.waitForFunction(() => document.querySelector('#path-pattern-results').innerText.includes('This summary uses 5 saved gardens'));
  assert.equal(await reminder.isHidden(), true);
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_ANALYSIS').length), 1);

  const dismissPage = await openDashboard(t, state);
  await dismissPage.locator('[data-tab="stats"]').click();
  await dismissPage.waitForFunction(() => !document.querySelector('#path-pattern-reminder').hidden);
  await dismissPage.locator('#dismiss-path-pattern-reminder').click();
  assert.equal(await dismissPage.locator('#path-pattern-reminder').isHidden(), true,
    'Not now should dismiss the note without opening analysis');
  assert.equal(await dismissPage.evaluate(() => contentMessages.filter(message => message.type === 'GET_PATH_PATTERN_ANALYSIS').length), 0);

  const mobilePage = await openDashboard(t, state, { width: 390, height: 844 });
  await mobilePage.locator('[data-tab="stats"]').click();
  await mobilePage.waitForFunction(() => !document.querySelector('#path-pattern-reminder').hidden);
  const reminderRightEdge = await mobilePage.locator('#path-pattern-reminder').evaluate(card => card.getBoundingClientRect().right);
  assert.ok(reminderRightEdge <= 390, `the note must fit a 390px viewport (right edge ${reminderRightEdge})`);
});

test('on-request path analysis gives a calm empty-history state', async t => {
  const page = await openDashboard(t);
  await page.locator('[data-tab="stats"]').click();
  assert.equal(await page.locator('#path-pattern-results').isHidden(), true);
  await page.locator('#analyze-path-patterns').click();
  await page.waitForFunction(() => document.querySelector('#path-pattern-results').innerText.includes('No saved gardens started'));
  assert.match(await page.locator('#path-pattern-results').innerText(), /eight-week window/i);
  assert.equal(await page.locator('#path-pattern-results .path-pattern-card').count(), 0);
});

test('young trees have a filled cartoon crown, a wooden trunk, and selectable pages', async t => {
  for (const count of [1, 2]) {
    const page = await openDashboard(t, stateFor(garden(count)));
    assert.equal(await page.locator('#tree').isVisible(), true);
    assert.equal(await page.locator('#tree .node').count(), count);
    assert.equal(await page.locator('#tree .branch-layer .branch-taper').count(), count - 1);
    assert.equal(await page.locator('#tree .canopy-silhouette').count(), 1);
    assert.equal(await page.locator('#tree .foliage-puff').count(), 6);
    assert.equal(await page.locator('#tree .tree-bole').count(), 1);
    assert.equal(await page.locator('#tree .wood-limb').count(), 2);
    assert.equal(await page.locator('#tree .branch-twig').count(), 4);
    assert.equal(await page.locator('#tree .branch-bud').count(), 4);
    const crownFill = await page.locator('#tree .canopy-silhouette').evaluate(el => getComputedStyle(el).fill);
    assert.notEqual(crownFill, 'none');
    assert.notEqual(crownFill, 'rgb(0, 0, 0)');
    assert.equal(await page.locator('#tree .page-leaf').count(), count - 1);
  }
});

test('deep branches and leaf clusters stay inside the SVG drawing area', async t => {
  const page = await openDashboard(t, stateFor(garden(13)));
  await page.locator('[data-tab="stats"]').click();
  await page.locator('[data-tab="map"]').click();
  assert.equal(await page.locator('#tree').isVisible(), true);
  const overflow = await page.locator('#tree').evaluate(svg => {
    const box = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('.node')].filter(node => {
      const bounds = node.getBoundingClientRect();
      return bounds.x < box.x || bounds.y < box.y ||
        bounds.x + bounds.width > box.x + box.width || bounds.y + bounds.height > box.y + box.height;
    }).map(node => node.dataset.nodeId);
  });
  assert.deepEqual(overflow, [], 'no branch tip should be clipped above the canvas');
});

test('switching between Insights and Garden Map restores the tree', async t => {
  const page = await openDashboard(t, stateFor(garden(6)));
  await page.locator('[data-tab="stats"]').click();
  assert.equal(await page.locator('#tree').isVisible(), false);
  assert.equal(await page.locator('#stats-tab').isVisible(), true);
  await page.locator('[data-tab="map"]').click();
  assert.equal(await page.locator('#tree').isVisible(), true);
  assert.equal(await page.locator('#tree .node').count(), 6);
});

test('new browsing branches appear without reloading an already-open garden', async t => {
  const page = await openDashboard(t, stateFor(garden(2)));
  await page.evaluate(state => updateTestState(state), stateFor(garden(3)));
  await page.waitForFunction(() => document.querySelectorAll('#tree .node').length === 3, null, { timeout: 3000 });
  assert.equal(await page.locator('#tree .branch-layer .branch-taper').count(), 2);
  await page.evaluate(state => updateTestState(state), stateFor());
  await page.waitForFunction(() => document.querySelector('#tree').dataset.treeMode === 'empty', null, { timeout: 3000 });
  assert.equal(await page.locator('#tree .node').count(), 0);
});

test('keyboard selection highlights the full branch and closing details hides the panel', async t => {
  const page = await openDashboard(t, stateFor(garden(6)));
  // Also exercise the tab round-trip rather than depending on startup state.
  await page.locator('[data-tab="stats"]').click();
  await page.locator('[data-tab="map"]').click();
  const leaf = page.locator('#tree .node[data-node-id="garden-one-node-5"]');
  await leaf.focus();
  await page.keyboard.press('Enter');
  await page.locator('#branch-detail h3').waitFor();
  assert.equal(await page.locator('#tree .highlight-layer .branch-taper').count(), 5);
  assert.equal(await page.locator('#branch-detail h3').textContent(), 'Research page 6');
  await page.locator('[data-branch-action="close"]').click();
  await page.waitForFunction(() => document.querySelector('#branch-detail').hidden);
  assert.equal(await page.locator('#branch-detail').isVisible(), false);
});

test('focus-trail dimming survives ambient motion and hover previews outrank it', async t => {
  // Ambient motion ON: branchPulse (an infinite keyframe animation) runs on
  // every branch-layer edge, and running animations OUTRANK normal opacity
  // declarations in the CSS cascade. Every other gate in this suite runs with
  // reducedMotion:'reduce', which silently disables the pulse — this gate is
  // the one that would catch a dim/preview rule that forgets `animation:none`.
  const page = await openDashboard(t, stateFor(garden(6)), { width: 1440, height: 1000 }, 'no-preference');
  const leaf = page.locator('#tree .node[data-node-id="garden-one-node-2"]');
  await leaf.focus();
  await page.keyboard.press('Enter');
  await page.locator('#branch-detail h3').waitFor();
  await page.waitForFunction(() => document.querySelector('#tree').dataset.selected === 'true');
  const edgeOpacity = id => page.locator(`#tree .branch-layer .branch-taper[data-edge-for="garden-one-node-${id}"]`)
    .evaluate(el => Number(getComputedStyle(el).opacity));
  const edgeAnim = id => page.locator(`#tree .branch-layer .branch-taper[data-edge-for="garden-one-node-${id}"]`)
    .evaluate(el => getComputedStyle(el).animationName);
  // Settle the opacity transition (.3s) before measuring.
  await page.waitForTimeout(450);
  // On-trail edges keep their gentle pulse (ancestors of node-2: edges 1 and 2).
  assert.equal(await edgeAnim(1), 'branchPulse');
  assert.ok((await edgeOpacity(1)) > 0.4, 'on-trail edge must stay lit through the pulse');
  // Off-trail edges are dimmed to .12 — pulse stopped by the dim rule itself.
  assert.equal(await edgeAnim(4), 'none');
  assert.ok(Math.abs((await edgeOpacity(4)) - 0.12) < 0.01, 'off-trail edge must actually dim while the pulse would otherwise win');
  // Hovering an off-trail leaf previews its ancestry at .8 — outranking the dim.
  await page.locator('#tree .node[data-node-id="garden-one-node-4"]').evaluate(el =>
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await page.waitForTimeout(450);
  assert.equal(await edgeAnim(3), 'none');
  assert.ok(Math.abs((await edgeOpacity(3)) - 0.8) < 0.01, 'hovered ancestry must stay visible above the dim');
  // An unrelated off-trail edge stays dimmed while the preview is up.
  assert.ok(Math.abs((await edgeOpacity(5)) - 0.12) < 0.01, 'non-preview off-trail edges must stay dim');
});

test('the tree remains visible on a narrow screen', async t => {
  const page = await openDashboard(t, stateFor(garden(8)), { width: 390, height: 844 });
  assert.equal(await page.locator('#tree').isVisible(), true);
  const bounds = await page.locator('#tree').boundingBox();
  assert.ok(bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= 390);
});


test('the page picker exposes small or crowded leaves and preserves the real ancestry', async t => {
  const page = await openDashboard(t, stateFor(garden(96)), { width: 390, height: 844 });
  assert.equal(await page.locator('#tree-page-select option').count(), 97);
  await page.locator('#tree-page-select').selectOption('garden-one-node-95');
  await page.locator('#branch-detail h3').waitFor();
  assert.equal(await page.locator('#branch-detail h3').textContent(), 'Research page 96');
  assert.equal(await page.locator('#tree .highlight-layer .branch-taper').count(), 95);
  assert.equal(await page.locator('#tree .node.selected').getAttribute('aria-pressed'), 'true');
});


test('the closing reflection follows the rhythm the user chose', async t => {
  const custom = stateFor(garden(4));
  custom.settings = { ...custom.settings, gentleDepth: 2, choiceDepth: 3 };
  const page = await openDashboard(t, custom);
  await page.goto('https://intent-grove.test/popup/index.html');
  await page.waitForFunction(() => document.querySelector('#active')?.hidden === false);
  await page.locator('#end').click();
  await page.waitForFunction(() => document.querySelector('#completion')?.hidden === false);
  // Deepest branch is 3, which is this user's own gentle threshold.
  assert.equal(await page.locator('#completion-title').textContent(), 'This garden has a long path to remember.');
  assert.match(await page.locator('#completion-copy').textContent(), /deepest path.*3/);

  // The default rhythm still treats depth 3 as an ordinary garden.
  const defaultPage = await openDashboard(t, stateFor(garden(4)));
  await defaultPage.goto('https://intent-grove.test/popup/index.html');
  await defaultPage.waitForFunction(() => document.querySelector('#active')?.hidden === false);
  await defaultPage.locator('#end').click();
  await defaultPage.waitForFunction(() => document.querySelector('#completion')?.hidden === false);
  assert.equal(await defaultPage.locator('#completion-title').textContent(), 'This garden can rest now.');
});

test('the new-tab illustration shares the cartoon artwork without fake selectable pages', async t => {
  const page = await openDashboard(t);
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.locator('#welcome-tree .canopy-silhouette').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#welcome-tree .foliage-puff').count(), 6);
  assert.equal(await page.locator('#welcome-tree .branch-twig').count(), 4);
  assert.equal(await page.locator('#welcome-tree .branch-bud').count(), 4);
  assert.equal(await page.locator('#welcome-tree [tabindex]').count(), 0);
  assert.notEqual(await page.locator('#welcome-tree .canopy-silhouette').evaluate(el => getComputedStyle(el).fill), 'rgb(0, 0, 0)');
  assert.equal(await page.locator('.ambient').evaluate(el => getComputedStyle(el, '::before').animationName), 'none', 'reduced-motion mode must disable atmospheric animation');
  assert.equal(await page.locator('.ambient').evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'reduced-motion mode must disable the second atmospheric animation');
});

test('New Tab keeps the main action visible, optional fields expandable, and pin status current', async t => {
  const page = await openDashboard(t, stateFor(), { width: 1365, height: 768 });
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#pin-help')?.hidden === false);
  await page.locator('#onboarding-skip').click();
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay').hidden === true);
  assert.equal(await page.locator('#pin-state').textContent(), 'Not pinned');
  await page.locator('#pin-help summary').click();
  assert.match(await page.locator('#pin-explanation').textContent(), /Extensions menu.*pin/i);
  await page.evaluate(() => globalThis.changeTestPinState(true));
  await page.waitForFunction(() => document.querySelector('#pin-state').textContent === 'Pinned');
  assert.equal(await page.locator('#mission-note').isVisible(), false);
  assert.equal(await page.locator('input[name="return-plan"]').count(), 3, 'optional reminder choices remain in the page');
  assert.equal(await page.locator('#mission-form button[type="submit"]').isVisible(), true);
  assert.equal(await page.locator('#browse-freely-btn').isVisible(), true);
  assert.equal(await page.locator('.search-privacy-note').isVisible(), true);
  assert.equal(await page.locator('.footer-guide-link').isVisible(), true);
  const actionBottom = await page.locator('#mission-form button[type="submit"]').evaluate(el => el.getBoundingClientRect().bottom);
  const browseBottom = await page.locator('#browse-freely-btn').evaluate(el => el.getBoundingClientRect().bottom);
  const privacyBottom = await page.locator('.search-privacy-note').evaluate(el => el.getBoundingClientRect().bottom);
  const footerBottom = await page.locator('.page-footer').evaluate(el => el.getBoundingClientRect().bottom);
  assert.ok(actionBottom <= 768, `Plant Intention should fit above the fold, bottom=${actionBottom}`);
  assert.ok(browseBottom <= 768, `Browse without an intention should fit above the fold, bottom=${browseBottom}`);
  assert.ok(privacyBottom <= 768, `the search privacy note should fit above the fold, bottom=${privacyBottom}`);
  assert.ok(footerBottom <= 768, `the guide and local-data footer should fit above the fold, bottom=${footerBottom}`);
  await page.locator('.optional-details summary').click();
  assert.equal(await page.locator('#mission-note').isVisible(), true);
});

test('Settings puts quick presets first and keeps every other control in simple collapsible groups', async t => {
  const { page } = await openSettings(t, { groupsCollapsed: true });
  assert.equal(await page.locator('[data-preset]').count(), 3);
  assert.equal(await page.locator('details.settings-group').count(), 3);
  assert.equal(await page.locator('details.settings-group[open]').count(), 0);
  for (const id of ['gentle', 'choice', 'motion', 'strict-mode', 'ram-guard', 'ram-level', 'search-engine', 'excluded-sites', 'path-pattern-reminders-enabled', 'enable-rewards', 'save']) {
    assert.equal(await page.locator(`#${id}`).count(), 1, `${id} remains available`);
  }
  await page.locator('details.settings-group summary').first().click();
  assert.equal(await page.locator('#gentle').isVisible(), true);
});

test('the welcome overlay keeps focus instead of the field behind it', async t => {
  const page = await openDashboard(t);
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay')?.hidden === false);
  // The startup focus timer fires after 350ms; it must not move focus away from
  // the only control the user can actually see (the overlay is aria-modal).
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700)));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'onboarding-start');
  assert.equal(await page.locator('#mission-input').evaluate(el => document.activeElement === el), false);
});

test('Brave-only footer guidance stays hidden in other Chromium browsers', async t => {
  const page = await openDashboard(t);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: async () => false } });
  });
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay')?.hidden === false);
  await page.waitForFunction(() => document.querySelector('.browser-notice-step')?.hidden === true);
  assert.equal(await page.locator('.browser-notice-arrow').isVisible(), false);
});

test('Brave footer tip points down briefly and can be dismissed', async t => {
  const page = await openDashboard(t);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: async () => true } });
  });
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay')?.hidden === false);
  assert.equal(await page.locator('.browser-notice-step').isVisible(), true, 'the tour keeps its full footer instructions');
  await page.locator('#onboarding-skip').click();
  await page.waitForFunction(() => document.querySelector('#browser-footer-tip')?.hidden === false);
  assert.match(await page.locator('#browser-footer-tip').textContent(), /Customize Brave.*Hide footer on New Tab page/);
  assert.equal(await page.locator('#browser-footer-tip b').textContent(), '↓');
  await page.waitForFunction(() => document.querySelector('#browser-footer-tip')?.hidden === true, undefined, { timeout: 10000 });
});

test('first-run walkthrough uses real guide screens with accessible, bounded navigation', async t => {
  const page = await openDashboard(t);
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay')?.hidden === false);
  assert.equal(await page.locator('[data-guide-slide]').count(), 4);
  assert.equal(await page.getByRole('link', { name: 'Read the full guide and try the samples' }).getAttribute('href'), '../guide/index.html');
  for (const image of await page.locator('[data-guide-slide] img').all()) {
    assert.ok(await image.getAttribute('src'));
    assert.ok((await image.getAttribute('alt'))?.length > 20);
    assert.ok(await image.evaluate(img => img.complete && img.naturalWidth > 0), 'each onboarding image must load as a real image');
  }
  assert.match(await page.locator('[data-guide-slide="2"] img').getAttribute('alt'), /fictional sample tree/);
  assert.equal(await page.locator('#guide-progress').textContent(), '1 of 4');
  assert.equal(await page.locator('#guide-previous').isDisabled(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'guide-next', 'keyboard focus stays within the modal tour');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'onboarding-start', 'reverse tab from the first control returns to the last');
  await page.locator('#guide-next').click();
  assert.equal(await page.locator('#guide-progress').textContent(), '2 of 4');
  assert.equal(await page.locator('[data-guide-slide="1"]').isVisible(), true);
  await page.locator('#guide-next').click();
  assert.equal(await page.locator('#guide-progress').textContent(), '3 of 4');
  await page.locator('#guide-next').click();
  assert.equal(await page.locator('#guide-progress').textContent(), '4 of 4');
  assert.equal(await page.locator('#guide-next').isDisabled(), true);
  await page.locator('#guide-next').evaluate(button => button.click());
  assert.equal(await page.locator('#guide-progress').textContent(), '4 of 4', 'navigation must stay within the guide');
  await page.locator('#onboarding-skip').click();
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay').hidden === true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'mission-input');
});

test('dismissing the welcome overlay completes onboarding', async t => {
  const page = await openDashboard(t);
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay')?.hidden === false);
  await page.locator('#onboarding-start').click();
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay').hidden === true);
  assert.equal(await page.locator('#mission-input').isVisible(), true);
});

test('the companion cartoon icon builds under a strict Trusted Types CSP', async t => {
  const page = await openDashboard(t);
  // Observe the closed ShadowRoot in the test harness only; production stays closed.
  await page.evaluate(() => {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = attachShadow.call(this, options);
      if (this.id === 'intent-grove-root') globalThis.testCompanionRoot = root;
      return root;
    };
  });
  await page.evaluate(() => import('/content/content.js'));
  await page.waitForFunction(() => globalThis.testCompanionRoot?.querySelector('.chip-seed-tree'));
  const shapeCount = await page.evaluate(() => testCompanionRoot.querySelectorAll('.chip-seed-tree path').length);
  assert.equal(shapeCount, 4);
});

test('title-only SPA changes notify the background without changing the URL', async t => {
  const page = await openDashboard(t);
  await page.evaluate(() => import('/content/content.js'));
  await page.waitForFunction(() => globalThis.contentMessages?.some(message => message.type === 'GET_ACTIVE_VIEW'));
  await page.evaluate(() => { document.title = 'A new chapter'; });
  await page.waitForFunction(() => globalThis.contentMessages?.some(message => message.type === 'SPA_NAVIGATION' && message.title === 'A new chapter'));
});

test('pushState snapshots and Back navigation preserve SPA route history', async t => {
  const page = await openDashboard(t);
  await page.evaluate(() => import('/content/content.js'));
  await page.waitForFunction(() => globalThis.contentMessages?.some(message => message.type === 'GET_ACTIVE_VIEW'));
  await page.evaluate(() => {
    history.pushState({}, '', '/chapter-one');
    history.pushState({}, '', '/chapter-two');
  });
  await page.waitForFunction(() => {
    const routes = globalThis.contentMessages?.filter(message => message.type === 'SPA_NAVIGATION').map(message => new URL(message.url).pathname) || [];
    return routes.includes('/chapter-one') && routes.includes('/chapter-two');
  });
  await page.goBack();
  await page.waitForFunction(() => globalThis.contentMessages?.filter(message => message.type === 'SPA_NAVIGATION').some(message => new URL(message.url).pathname === '/chapter-one'));
  assert.equal(new URL(page.url()).pathname, '/chapter-one');
});
test('hash-router navigation notifies the background as SPA navigation', async t => {
  const page = await openDashboard(t);
  await page.evaluate(() => import('/content/content.js'));
  await page.waitForFunction(() => globalThis.contentMessages?.some(message => message.type === 'GET_ACTIVE_VIEW'));
  await page.evaluate(() => { location.hash = '#chapter-one'; });
  await page.waitForFunction(() => globalThis.contentMessages?.some(message => message.type === 'SPA_NAVIGATION' && new URL(message.url).hash === '#chapter-one'));
});

test('50 rapid SPA transitions remain distinct without runaway heap growth', async t => {
  const page = await openDashboard(t);
  const client = await page.context().newCDPSession(page);
  await page.evaluate(() => import('/content/content.js'));
  await page.waitForFunction(() => globalThis.contentMessages?.some(message => message.type === 'GET_ACTIVE_VIEW'));
  await client.send('HeapProfiler.enable');
  await client.send('HeapProfiler.collectGarbage');
  const before = await page.evaluate(() => performance.memory?.usedJSHeapSize || 0);
  await page.evaluate(() => {
    for (let index = 1; index <= 50; index += 1) history.pushState({ chapter: index }, '', `/rapid-chapter-${index}`);
  });
  await page.waitForFunction(() => (globalThis.contentMessages?.filter(message => message.type === 'SPA_NAVIGATION').length || 0) >= 50);
  await page.waitForTimeout(100);
  await client.send('HeapProfiler.collectGarbage');
  const after = await page.evaluate(() => performance.memory?.usedJSHeapSize || 0);
  const routes = await page.evaluate(() => globalThis.contentMessages.filter(message => message.type === 'SPA_NAVIGATION').map(message => new URL(message.url).pathname));
  assert.ok(routes.filter(route => route.startsWith('/rapid-chapter-')).length >= 50, 'all rapid SPA routes should be reported');
  assert.equal(new Set(routes.filter(route => route.startsWith('/rapid-chapter-'))).size, 50, 'rapid SPA routes should remain distinct');
  if (before && after) assert.ok(after - before < 2 * 1024 * 1024, `SPA heap growth should stay below 2 MiB (got ${after - before} bytes)`);
});


test('completed onboarding can be replayed from Settings without resetting setup state', async t => {
  const completedState = { ...stateFor(), onboardingCompleted: true };
  const page = await openDashboard(t, completedState);
  await page.goto('https://intent-grove.test/settings/index.html');
  const tourLink = page.getByRole('link', { name: 'Replay the quick tour' });
  assert.equal(await tourLink.getAttribute('href'), '../newtab/index.html?tour=1');
  assert.equal(await page.getByRole('link', { name: 'Read the full guide' }).getAttribute('href'), '../guide/index.html');
  await tourLink.click();
  await page.waitForURL('**/newtab/index.html?tour=1');
  await page.waitForFunction(() => !document.querySelector('#onboarding-overlay').hidden);
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay').hidden);
  assert.equal(await page.evaluate(() => contentMessages.filter(message => message.type === 'COMPLETE_ONBOARDING').length), 1,
    'dismissing the replay is safe and uses the existing idempotent completion message');
});

test('completed onboarding stays hidden on ordinary New Tab loads', async t => {
  const completedState = { ...stateFor(), onboardingCompleted: true };
  const page = await openDashboard(t, completedState);
  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#mission-input'));
  assert.equal(await page.locator('#onboarding-overlay').isVisible(), false);
});

test('theme follows the system until chosen, then stays synchronized across extension surfaces', async t => {
  const page = await openDashboard(t, stateFor(), undefined, 'reduce', 'dark');
  const toggle = page.locator('[data-theme-toggle]');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await toggle.getAttribute('aria-label'), 'Switch to light theme');
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('[data-theme-toggle]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('intent-grove-theme')), 'dark');

  const popup = await page.context().newPage();
  await popup.goto('https://intent-grove.test/popup/index.html');
  await popup.waitForFunction(() => document.querySelector('[data-theme-toggle]')?.getAttribute('aria-label') === 'Switch to light theme');
  await popup.locator('[data-theme-toggle]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('intent-grove-theme')), 'light');

  await popup.goto('https://intent-grove.test/settings/index.html');
  assert.equal(await popup.locator('html').getAttribute('data-theme'), 'light');
  await popup.locator('[data-theme-toggle]').click();
  assert.equal(await popup.locator('html').getAttribute('data-theme'), 'dark');
  await popup.goto('https://intent-grove.test/newtab/index.html');
  await popup.waitForFunction(() => document.querySelector('#mission-input'));
  assert.equal(await popup.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await popup.locator('[data-theme-toggle]').getAttribute('aria-label'), 'Switch to light theme');
  await popup.locator('[data-theme-toggle]').click();
  assert.equal(await popup.locator('html').getAttribute('data-theme'), 'light');
});

test('the in-extension guide explains the tree and choice card with a data-free sample demo', async t => {
  const page = await openDashboard(t, stateFor(), { width: 320, height: 760 });
  await page.goto('https://intent-grove.test/guide/index.html');
  await page.waitForSelector('[data-guide-page]');
  const guideCopy = await page.locator('main').innerText();
  assert.match(guideCopy, /not a psychological test/i);
  assert.match(await page.locator('.faq-section details').nth(1).textContent(), /not a validated psychological assessment, diagnosis/i);
  assert.match(guideCopy, /navigation path/i);
  assert.match(guideCopy, /does not decide whether a page was useful/i);
  assert.match(guideCopy, /five choices/i);
  assert.equal(await page.locator('a[href^="http"]').count(), 0, 'the guide must not send users to external pages');

  const messageCount = await page.evaluate(() => globalThis.contentMessages?.length || 0);
  const localDataBefore = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  await page.locator('[data-sample-node="tuition"]').click();
  assert.match(await page.locator('#sample-tree-feedback').innerText(), /tuition details/i);
  await page.locator('[data-sample-choice="return"]').click();
  assert.match(await page.locator('#sample-choice-feedback').innerText(), /page where your intention session began/i);
  assert.equal(await page.evaluate(() => globalThis.contentMessages?.length || 0), messageCount, 'demo interactions must not send extension messages');
  assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), localDataBefore, 'demo interactions must not save browsing data');

  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 760 });
    const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    assert.ok(layout.content <= layout.viewport, `guide should not overflow horizontally at ${width}px (${layout.content}px content)`);
  }
});

test('primary extension pages remain horizontally usable on a narrow mobile viewport', async t => {
  const page = await openDashboard(t, stateFor(garden(7)), { width: 320, height: 760 });
  const assertFits = async label => {
    const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    assert.ok(layout.content <= layout.viewport, `${label} should fit the ${layout.viewport}px viewport (content ${layout.content}px)`);
  };

  await assertFits('Garden Map');
  await page.getByRole('button', { name: 'Insights & Stats' }).click();
  await page.waitForFunction(() => document.querySelector('#stats-tab').classList.contains('active'));
  await assertFits('Insights & Stats');

  await page.goto('https://intent-grove.test/settings/index.html');
  await page.waitForSelector('#save');
  await assertFits('Settings');

  await page.goto('https://intent-grove.test/newtab/index.html');
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay')?.hidden === false);
  await page.locator('#onboarding-skip').click();
  await page.waitForFunction(() => document.querySelector('#onboarding-overlay').hidden === true);
  await assertFits('New Tab');
});
