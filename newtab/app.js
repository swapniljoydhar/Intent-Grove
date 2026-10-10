import { renderTreeIllustration } from '../dashboard/tree-renderer.js';
import { logError, wrapWithErrorBoundary, ERROR_CATEGORIES } from '../shared/error-tracing.js';
import { applyStoredTheme, mountThemeToggle } from '../shared/theme.js';
import { applyPerfMode, nextPerfMode, sampleMemoryPressure, sampleSystemMemory } from '../shared/ram-guard.js';

applyStoredTheme();
mountThemeToggle();

renderTreeIllustration(document.querySelector('#welcome-tree'), 'sapling');

// DOM Elements - New Structure
const form = document.querySelector('#mission-form');
const input = document.querySelector('#mission-input');
const missionNote = document.querySelector('#mission-note');
const charCurrent = document.querySelector('#char-current');
const status = document.querySelector('#form-status');
const resumeBtn = document.querySelector('#resume-mission-btn');
const browseBtn = document.querySelector('#browse-freely-btn');
const guideSlides = [...document.querySelectorAll('[data-guide-slide]')];
const guidePrevious = document.querySelector('#guide-previous');
const guideNext = document.querySelector('#guide-next');
const guideProgress = document.querySelector('#guide-progress');
const browserNotice = document.querySelector('.browser-notice-step');
const browserNoticeArrow = document.querySelector('.browser-notice-arrow');
const browserFooterTip = document.querySelector('#browser-footer-tip');
const pinHelp = document.querySelector('#pin-help');
const pinState = document.querySelector('#pin-state');
const pinExplanation = document.querySelector('#pin-explanation');
const compostReminder = document.querySelector('#compost-reminder');
const compostReminderCopy = document.querySelector('#compost-reminder-copy');
let footerTipTimer;

async function updatePinStatus() {
  try {
    const settings = await chrome.action.getUserSettings();
    if (typeof settings?.isOnToolbar !== 'boolean') return;
    pinHelp.hidden = false;
    pinHelp.dataset.pinned = String(settings.isOnToolbar);
    pinState.textContent = settings.isOnToolbar ? 'Pinned' : 'Not pinned';
    pinExplanation.textContent = settings.isOnToolbar
      ? 'Intent Grove is on your browser toolbar. Click its icon to open the popup.'
      : 'To pin it, open the Extensions menu (puzzle piece) and click the pin next to Intent Grove.';
  } catch {
    // Some Chromium-based browsers do not expose this optional API.
    pinHelp.hidden = true;
  }
}

async function updateBrowserNotice(showFooterTip = true) {
  let isBrave = false;
  try {
    isBrave = typeof navigator.brave?.isBrave === 'function' && await navigator.brave.isBrave() === true;
  } catch { /* Browser detection is optional; never show a potentially wrong tip. */ }
  const tourOpen = document.querySelector('#onboarding-overlay')?.hidden === false;
  if (browserNotice) browserNotice.hidden = !isBrave || !tourOpen;
  if (browserNoticeArrow) browserNoticeArrow.hidden = !isBrave || !tourOpen;
  if (browserFooterTip) {
    browserFooterTip.hidden = !isBrave || !showFooterTip || tourOpen;
    if (!browserFooterTip.hidden) {
      clearTimeout(footerTipTimer);
      footerTipTimer = setTimeout(() => { browserFooterTip.hidden = true; }, 8500);
    }
  }
}
void updatePinStatus();
window.addEventListener('focus', updatePinStatus);
chrome.action?.onUserSettingsChanged?.addListener?.(updatePinStatus);
document.querySelector('#dismiss-footer-tip')?.addEventListener('click', () => {
  clearTimeout(footerTipTimer);
  browserFooterTip.hidden = true;
});

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

function statusWithReward(prefix, result) {
  return result?.reward?.text ? `${prefix} · Grove Note: ${result.reward.text}` : prefix;
}

// Update character counter
function updateCount() { if (charCurrent) { charCurrent.textContent = input.value.length.toString(); } }

// Initialize page
const safeInit = wrapWithErrorBoundary(init, { category: ERROR_CATEGORIES.UI_RENDER, function: 'init' });
async function init() {
  let onboardingVisible = false;
  try {
    const snap = await message('GET_SNAPSHOT');
    document.body.dataset.motion = snap?.settings?.ambientMotion === false ? 'off' : 'on';
    // Time-of-day tint: computed once per load, purely static (zero animation
    // cost) — dawn/day/dusk/night adjust the sky, sun glow, and hills; dusk
    // and night wake the fireflies.
    const hour = new Date().getHours();
    document.body.dataset.tod = hour >= 5 && hour < 8 ? 'dawn' : hour >= 8 && hour < 17 ? 'day' : hour >= 17 && hour < 20 ? 'dusk' : 'night';
    applyPerfMode(nextPerfMode(document.body.dataset.perf, snap?.settings, { ...sampleMemoryPressure(), ...(await sampleSystemMemory()) }, window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true));
    if (snap && snap.session) {
      resumeBtn.hidden = false;
      resumeBtn.querySelector('.action-text').textContent = `Continue Session · "${snap.session.mission}"`;
      const threshold = snap.thresholds?.INTERRUPT || 5;
      const currentDepth = Math.max(...snap.session.nodes.map((node) => node.depth || 0), 0);
      if (currentDepth >= threshold) {
        resumeBtn.querySelector('.action-text').textContent += ` · ${currentDepth} branches deep`;
      }
    }
    const compostCount = Array.isArray(snap?.state?.compostItems) ? snap.state.compostItems.length : 0;
    if (compostReminder && compostCount > 0) {
      compostReminder.hidden = false;
      compostReminderCopy.textContent = `${compostCount} saved ${compostCount === 1 ? 'curiosity is' : 'curiosities are'} resting for whenever you want to return.`;
    }
    // Keep the tour available as permanent help after first-run setup.
    const replayTour = new URLSearchParams(window.location.search).get('tour') === '1';
    if (snap && snap.state && (!snap.state.onboardingCompleted || replayTour)) {
      const overlay = document.getElementById('onboarding-overlay');
      if (overlay) {
        overlay.hidden = false;
        onboardingVisible = true;
        document.getElementById('onboarding-start')?.focus();
      }
    }
  } catch (err) { logError(err, { category: ERROR_CATEGORIES.MESSAGING, function: 'init' }); }
  void updateBrowserNotice(!onboardingVisible);
  // Never steal focus from the welcome overlay: it is the only visible control
  // until the user dismisses it, so focusing the field behind it would strand
  // keyboard users on an element they cannot see.
  if (!onboardingVisible) setTimeout(() => input.focus(), 350);
}

function initSafely() { return safeInit().catch((error) => { logError(error, { category: ERROR_CATEGORIES.UI_RENDER, function: 'initSafely' }); }); }

// Event Listeners
input.addEventListener('input', wrapWithErrorBoundary(updateCount, { category: ERROR_CATEGORIES.UI_RENDER, function: 'updateCount', swallow: true }));

form.addEventListener('submit', wrapWithErrorBoundary(async (event) => {
  event.preventDefault();
  const mission = input.value.trim();
  if (!mission) { input.focus(); return; }
  try {
    const chosenPlan = document.querySelector('input[name="return-plan"]:checked')?.value || 'decide';
    await message('START_MISSION', { mission, missionNote: missionNote?.value.trim() || '', responsePlan: chosenPlan, openSearch: true, tab: { url: location.href, title: 'Intent Grove' } });
    status.hidden = false;
    status.textContent = '🌱 Intention planted! Opening a gentle first step...';
    input.blur();
    missionNote.value = '';
    document.querySelector('input[name="return-plan"][value="decide"]')?.click();
  } catch (err) {
    logError(err, { category: ERROR_CATEGORIES.MESSAGING, function: 'startMission' });
    status.hidden = false;
    status.textContent = 'Could not start session. Please try again.';
  }
}, { category: ERROR_CATEGORIES.MESSAGING, function: 'form.submit', swallow: true }));

input.addEventListener('keydown', wrapWithErrorBoundary((event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}, { category: ERROR_CATEGORIES.MESSAGING, function: 'mission-input.keydown', swallow: true }));

resumeBtn.addEventListener('click', wrapWithErrorBoundary(async () => {
  try {
    const view = await message('GO_HOME');
    status.hidden = false;
    // GO_HOME reports the destination in its own `origin` field; the compact
    // active view it embeds intentionally omits origin, so reading
    // view.session.origin.url was always undefined and this branch could
    // never report a real return.
    const originUrl = view?.origin?.url;
    let hasRealDestination = false;
    try {
      const parsed = new URL(originUrl || '');
      hasRealDestination = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {}
    if (hasRealDestination) {
      status.textContent = statusWithReward('✓ Returning to your active session...', view);
    } else {
      status.textContent = statusWithReward('Active intention ready — search or enter a URL to explore.', view);
    }
    setTimeout(() => { status.hidden = true; }, 3000);
  } catch (err) { logError(err, { category: ERROR_CATEGORIES.MESSAGING, function: 'resumeClick' }); }
}, { category: ERROR_CATEGORIES.MESSAGING, function: 'resume.click', swallow: true }));

browseBtn.addEventListener('click', wrapWithErrorBoundary(async () => {
  try {
    const result = await message('END_MISSION', { reason: 'browse_without_mission' });
    resumeBtn.hidden = true;
    status.hidden = false;
    status.textContent = statusWithReward('Browse freely — plant an intention whenever you\'re ready.', result);
    input.focus();
    setTimeout(() => { status.hidden = true; }, 4000);
  } catch (err) { logError(err, { category: ERROR_CATEGORIES.MESSAGING, function: 'browseClick' }); }
}, { category: ERROR_CATEGORIES.MESSAGING, function: 'browse.click', swallow: true }));

document.querySelector('#open-compost')?.addEventListener('click', wrapWithErrorBoundary(() => {
  return chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html'), active: true });
}, { category: ERROR_CATEGORIES.UI_RENDER, function: 'open-compost.click', swallow: true }));

updateCount();
initSafely();

// Battery Optimization: Pause animations when tab is hidden
function updatePageVisibility() {
  document.body.dataset.pageVisibility = document.hidden ? 'hidden' : 'visible';
}

// Set initial state
updatePageVisibility();

// Listen for visibility changes
document.addEventListener('visibilitychange', updatePageVisibility);

// Onboarding dismiss
const onboardingStart = document.getElementById('onboarding-start');
const onboardingSkip = document.getElementById('onboarding-skip');
async function finishOnboarding() {
    const overlay = document.getElementById('onboarding-overlay');
    if (overlay) overlay.hidden = true;
    // Hiding the overlay while focus is inside it drops focus to <body>,
    // stranding keyboard users. The startup focus call was skipped while the
    // overlay was visible, so move focus to the form explicitly here.
    input.focus();
    await message('COMPLETE_ONBOARDING');
    void updateBrowserNotice(true);
}
for (const button of [onboardingStart, onboardingSkip]) {
  button?.addEventListener('click', wrapWithErrorBoundary(finishOnboarding, { category: ERROR_CATEGORIES.MESSAGING, function: 'onboarding.finish', swallow: true }));
}
document.querySelector('#onboarding-overlay')?.addEventListener('keydown', (event) => {
  const overlay = document.querySelector('#onboarding-overlay');
  if (overlay?.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    finishOnboarding().catch((error) => logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'onboarding.escape' }));
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [...overlay.querySelectorAll('button:not([disabled])')].filter((control) => !control.closest('[hidden]'));
  if (!controls.length) return;
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

let guideIndex = 0;
function showGuideSlide(index) {
  if (!guideSlides.length) return;
  guideIndex = Math.max(0, Math.min(index, guideSlides.length - 1));
  guideSlides.forEach((slide, i) => { slide.hidden = i !== guideIndex; });
  guideProgress.textContent = `${guideIndex + 1} of ${guideSlides.length}`;
  guidePrevious.disabled = guideIndex === 0;
  guideNext.disabled = guideIndex === guideSlides.length - 1;
}
guidePrevious?.addEventListener('click', () => showGuideSlide(guideIndex - 1));
guideNext?.addEventListener('click', () => showGuideSlide(guideIndex + 1));
showGuideSlide(0);
