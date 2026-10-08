import { logError, wrapWithErrorBoundary, ERROR_CATEGORIES } from '../shared/error-tracing.js';
import { normalizeSettings, DEFAULT_SETTINGS } from '../shared/state.js';
import { applyStoredTheme, mountThemeToggle } from '../shared/theme.js';
import { sampleMemoryPressure, sampleSystemMemory } from '../shared/ram-guard.js';

applyStoredTheme();
mountThemeToggle();

/**
 * Send a message to the service worker with error handling
 * @param {string} type - Message type
 * @param {object} payload - Message payload
 * @returns {Promise<any>} Response from service worker
 */
async function message(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (error) {
    // Service worker may be unavailable during startup or after crash
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, operation: 'sendMessage', messageType: type });
    throw error; // Re-throw so caller can handle fallback
  }
}
const gentle = document.querySelector('#gentle'); const choice = document.querySelector('#choice'); const motion = document.querySelector('#motion'); const searchEngine = document.querySelector('#search-engine'); const excludedSites = document.querySelector('#excluded-sites'); const status = document.querySelector('#status'); const save = document.querySelector('#save'); const enableRewardsToggle = document.querySelector('#enable-rewards'); const pathPatternRemindersToggle = document.querySelector('#path-pattern-reminders-enabled');
const strictToggle = document.querySelector('#strict-mode'); const ramGuardToggle = document.querySelector('#ram-guard'); const ramLevel = document.querySelector('#ram-level'); const ramLevelValue = document.querySelector('#ram-level-value');
const ramSignalsEl = document.querySelector('#ram-signals');
// Live guardian-signal readout: the same honest numbers the decision uses,
// rendered locally; nothing here is stored or transmitted.
async function renderRamSignals() {
  if (!ramSignalsEl) return;
  const sys = await sampleSystemMemory();
  const ctx = sampleMemoryPressure();
  const systemPart = sys ? `free system memory: ${sys.freeGb} of ${sys.totalGb} GB` : 'free system memory: not exposed by this browser';
  const devicePart = ctx.deviceGb === null ? 'device class: not reported' : `device class: ~${ctx.deviceGb} GB`;
  const heapPart = ctx.heapRatio === null ? 'this page heap: not reported' : `this page heap: ${Math.round(ctx.heapRatio * 100)}% of limit`;
  ramSignalsEl.textContent = `Live signals — ${systemPart} · ${devicePart} · ${heapPart}.`;
}
renderRamSignals();
const gentleValue = document.querySelector('#gentle-value'); const choiceValue = document.querySelector('#choice-value');
const gentlePreviewLabel = document.querySelector('#gentle-preview-label'); const choicePreviewLabel = document.querySelector('#choice-preview-label');
const previewGentle = document.querySelector('#preview-gentle'); const previewChoice = document.querySelector('#preview-choice');
const previewCopy = document.querySelector('#preview-copy');
const presets = {
  gentle: { gentleDepth: 8, choiceDepth: 10, strictMode: false },
  balanced: { gentleDepth: 4, choiceDepth: 5, strictMode: false },
  accountable: { gentleDepth: 3, choiceDepth: 4, strictMode: true }
};
// The "original rhythm" is the shared DEFAULT_SETTINGS, not a hand-copied
// literal: if defaults ever change, reset must restore the true defaults
// (the old copy would have silently restored a stale rhythm).
const original = { ...DEFAULT_SETTINGS, excludedSites: [...DEFAULT_SETTINGS.excludedSites] }; let saved = { ...original }; let ready = false;
function currentSettings() { return { gentleDepth: Number(gentle.value), choiceDepth: Number(choice.value), ambientMotion: motion.checked, growthAnimationTrigger: document.querySelector('input[name="growth-animation"]:checked')?.value || 'mission-origin', excludedSites: excludedSites.value.split(/\r?\n/).map((site) => site.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean), searchEngine: searchEngine.value, enableRewards: enableRewardsToggle?.checked === true, strictMode: strictToggle?.checked === true, ramGuard: ramGuardToggle?.checked !== false, ramGuardLevel: Number(ramLevel?.value) || 3, pathPatternRemindersEnabled: pathPatternRemindersToggle?.checked === true }; }
let saving = false;
const reset = document.querySelector('#reset');
function sameSettings(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function projectSettings(settings) {
  return Object.fromEntries(Object.keys(original).map(key => [key, key === 'excludedSites' ? [...settings[key]] : settings[key]]));
}
function editableSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || !Number.isInteger(settings.gentleDepth) || !Number.isInteger(settings.choiceDepth)
    || typeof settings.ambientMotion !== 'boolean' || typeof settings.enableRewards !== 'boolean'
    || typeof settings.strictMode !== 'boolean' || typeof settings.ramGuard !== 'boolean' || !Number.isInteger(settings.ramGuardLevel)
    || typeof settings.pathPatternRemindersEnabled !== 'boolean'
    || !Array.isArray(settings.excludedSites) || !settings.excludedSites.every(site => typeof site === 'string')) {
    throw new Error('Invalid settings acknowledgement');
  }
  const editable = projectSettings(settings);
  if (!sameSettings(editable, projectSettings(normalizeSettings(settings)))) throw new Error('Invalid settings acknowledgement');
  return editable;
}
function markDirty() {
  const dirty = !sameSettings(currentSettings(), saved);
  save.disabled = !ready || saving || !dirty;
  reset.disabled = !ready || saving;
  if (ready && !saving) status.textContent = dirty ? 'You have a rhythm change ready to save.' : 'Your current rhythm is already tending the grove.';
}
function applySettings(settings) {
  gentle.value = settings.gentleDepth;
  choice.value = settings.choiceDepth;
  motion.checked = settings.ambientMotion;
  if (strictToggle) strictToggle.checked = settings.strictMode === true;
  if (ramGuardToggle) ramGuardToggle.checked = settings.ramGuard !== false;
  if (ramLevel) { ramLevel.value = String(settings.ramGuardLevel); if (ramLevelValue) ramLevelValue.textContent = String(settings.ramGuardLevel); }
  searchEngine.value = settings.searchEngine;
  excludedSites.value = settings.excludedSites.join('\n');
  document.querySelector(`input[name="growth-animation"][value="${settings.growthAnimationTrigger}"]`).checked = true;
  if (enableRewardsToggle) enableRewardsToggle.checked = settings.enableRewards;
  if (pathPatternRemindersToggle) pathPatternRemindersToggle.checked = settings.pathPatternRemindersEnabled;
  sync();
}
async function saveSettings(candidate) {
  const submitted = projectSettings(normalizeSettings(candidate));
  const response = await message('UPDATE_SETTINGS', { settings: submitted });
  if (response !== null) return editableSettings(response);
  const snapshot = await message('GET_SNAPSHOT');
  const confirmed = editableSettings(snapshot?.settings);
  if (!sameSettings(confirmed, submitted)) throw new Error('Settings save could not be confirmed');
  return confirmed;
}
function sync() {
  const g = Number(gentle.value);
  if (Number(choice.value) <= g) choice.value = String(Math.min(10, g + 1));
  const c = Number(choice.value);
  gentleValue.textContent = g;
  choiceValue.textContent = c;
  gentlePreviewLabel.textContent = `Quieter at ${g}`;
  choicePreviewLabel.textContent = `Choice at ${c}`;
  previewGentle.style.left = `${(g / 10) * 100}%`;
  previewChoice.style.left = `${(c / 10) * 100}%`;
  previewCopy.textContent = g <= 3 ? 'The grove will offer a gentle reminder early, useful for shorter paths.' : c >= 7 ? 'You will have more room to explore before a reminder appears.' : 'The path stays open. The grove simply becomes easier to notice.';
  markDirty();
}
const safeLoad = wrapWithErrorBoundary(load, { category: ERROR_CATEGORIES.UI_RENDER, function: 'load' });
async function load() { 
  try { 
    const snap = await message('GET_SNAPSHOT'); 
    saved = editableSettings(snap?.settings);
    ready = true;
    applySettings(saved);
  } catch (error) { 
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'load' });
    status.textContent = 'Intent Grove could not load your local settings. Try again.'; 
  } 
}
gentle.addEventListener('input', wrapWithErrorBoundary(sync, { category: ERROR_CATEGORIES.UI_RENDER, function: 'gentle.input', swallow: true }));
choice.addEventListener('input', wrapWithErrorBoundary(sync, { category: ERROR_CATEGORIES.UI_RENDER, function: 'choice.input', swallow: true }));
motion.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'motion.change', swallow: true }));
if (strictToggle) strictToggle.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'strict-mode.change', swallow: true }));
if (ramGuardToggle) ramGuardToggle.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'ram-guard.change', swallow: true }));
if (ramLevel) ramLevel.addEventListener('input', wrapWithErrorBoundary(() => { if (ramLevelValue) ramLevelValue.textContent = ramLevel.value; markDirty(); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'ram-level.input', swallow: true }));
searchEngine.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'search-engine.change', swallow: true }));
excludedSites.addEventListener('input', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'excluded-sites.input', swallow: true }));
document.querySelectorAll('input[name="growth-animation"]').forEach((radio) => radio.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'growth-animation.change', swallow: true })));
if (enableRewardsToggle) enableRewardsToggle.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'enable-rewards.change', swallow: true }));
if (pathPatternRemindersToggle) pathPatternRemindersToggle.addEventListener('change', wrapWithErrorBoundary(markDirty, { category: ERROR_CATEGORIES.UI_RENDER, function: 'path-pattern-reminders.change', swallow: true }));
document.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', wrapWithErrorBoundary(() => {
  const preset = presets[button.dataset.preset];
  if (!preset) return;
  gentle.value = String(preset.gentleDepth);
  choice.value = String(preset.choiceDepth);
  if (strictToggle) strictToggle.checked = preset.strictMode;
  sync();
  status.textContent = `${button.textContent.replace(/\s+\d+\s*\/\s*\d+/, '').trim()} rhythm is ready to save.`;
}, { category: ERROR_CATEGORIES.UI_RENDER, function: 'preset.click', swallow: true })));
async function persistSettings(restoring = false) {
  if (!ready || saving) return;
  sync();
  const before = currentSettings();
  // Keep a raw text fingerprint too: formatting-only edits must not be overwritten.
  const beforeSites = excludedSites.value;
  saving = true;
  markDirty();
  status.textContent = restoring ? 'Restoring the original rhythm…' : 'Saving your rhythm…';
  let confirmed = false;
  try {
    saved = await saveSettings(restoring ? original : before);
    confirmed = true;
    if (sameSettings(currentSettings(), before) && excludedSites.value === beforeSites) applySettings(saved);
  } catch (error) {
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: restoring ? 'reset.click' : 'save.click' });
  } finally {
    saving = false;
    markDirty();
  }
  if (!confirmed) {
    status.textContent = restoring ? 'The original rhythm could not be restored. Your edits are still here; try again.' : 'The rhythm could not be confirmed as saved. Your edits are still here; try again.';
  } else if (sameSettings(currentSettings(), saved)) {
    status.textContent = restoring ? 'The original rhythm has returned.' : 'Your rhythm is tending the grove now.';
  } else {
    status.textContent = 'Your earlier rhythm was saved. You have newer edits ready to save.';
  }
}
save.addEventListener('click', wrapWithErrorBoundary(() => persistSettings(), { category: ERROR_CATEGORIES.MESSAGING, function: 'save.click', swallow: true }));
reset.addEventListener('click', wrapWithErrorBoundary(() => persistSettings(true), { category: ERROR_CATEGORIES.MESSAGING, function: 'reset.click', swallow: true }));
markDirty();
safeLoad();
