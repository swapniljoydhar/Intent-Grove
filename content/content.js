(() => {
  if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') globalThis.chrome = globalThis.browser;
  // Browser-internal pages (including Chromium forks) and extension pages are not websites.
  if (!['http:', 'https:'].includes(location.protocol)) return;
  
  // --- Resilience: Prevent Duplicate Injection ---
  if (window.__intentGroveInjected || window.__focusForestInjected) {
    window.__intentGroveInjected = true;
    window.__focusForestInjected = true;
    console.warn('[Intent Grove] Duplicate injection detected; skipping.');
    return;
  }
  window.__intentGroveInjected = true;
  window.__focusForestInjected = true;

  // Local error tracing and boundary implementations for isolated content script execution
  const ERROR_CATEGORIES = { CONTENT_SCRIPT: 'content_script', MESSAGING: 'messaging', UI_RENDER: 'ui_render', UNKNOWN: 'unknown' };
  function logError(error, context = {}) {
    const trace = {
      id: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      message: error?.message || String(error),
      stack: error?.stack || (new Error()).stack,
      category: context.category || ERROR_CATEGORIES.UNKNOWN,
      severity: context.severity || 'medium',
      context: { url: location.href, userAgent: navigator.userAgent, ...context }
    };
    console.error('[Intent Grove Error]', JSON.stringify(trace, null, 2));
    return trace;
  }
  function wrapWithErrorBoundary(fn, context = {}) {
    const shouldRethrow = context.rethrow !== false && !context.swallow;
    return async (...args) => {
      try { return await fn(...args); }
      catch (error) {
        logError(error, { ...context, category: context.category || ERROR_CATEGORIES.UNKNOWN });
        if (shouldRethrow) throw error;
        return undefined;
      }
    };
  }

  function initContentScript() {
    function isInvalidatedContext(error) {
      return /extension context invalidated|message port closed|receiving end does not exist/i.test(String(error?.message || error));
    }
    async function send(type, payload = {}) {
      try {
        return await chrome.runtime.sendMessage({ type, ...payload });
      } catch (error) {
        // A page can outlive an extension reload. Do not turn that expected
        // lifecycle race into a visible error or interrupt the page.
        if (isInvalidatedContext(error)) return null;
        throw error;
      }
    }

  // Root host: pointer-events:none so the page behind stays fully interactive.
  // Only specific children (the chip, the choice card) opt back in with auto.
  const root = document.createElement('div');
  root.id = 'intent-grove-root';
  document.documentElement.appendChild(root);
  const shadow = root.attachShadow({ mode: 'closed' });

  // Constructable Stylesheets apply scoped CSS without an inline <style>
  // element, so the companion renders even under a strict page CSP
  // (style-src without 'unsafe-inline'). The <style> fallback covers
  // engines without Constructable Stylesheet support.
  const componentCssText = `
:host{all:initial}
#ff-root{position:fixed;z-index:2147483646;inset:0;pointer-events:none}
#ff-root{--ff-surface-a:rgba(252,251,245,.97);--ff-surface-b:rgba(243,248,239,.95);--ff-text:#29432d;--ff-muted:#6c8c68;--ff-border:rgba(74,104,71,.22);--ff-card:rgba(252,251,245,.98);--ff-btn:rgba(74,104,71,.1);--ff-btn-text:#29432d;--ff-find-bg:rgba(255,251,235,.98);--ff-find-text:#5d563d;--ff-find-border:rgba(198,165,98,.42)}
@media (prefers-color-scheme:dark){#ff-root{--ff-surface-a:rgba(28,34,28,.94);--ff-surface-b:rgba(23,29,23,.92);--ff-text:#dce8dc;--ff-muted:#9db89a;--ff-border:rgba(140,170,138,.3);--ff-card:rgba(26,32,26,.96);--ff-btn:rgba(140,170,138,.16);--ff-btn-text:#dce8dc;--ff-find-bg:rgba(38,34,24,.96);--ff-find-text:#e6dcbd;--ff-find-border:rgba(198,165,98,.35)}}
#ff-root.perf-reduced .chip,#ff-root.perf-reduced .choice-card,#ff-root.perf-reduced .forest-find,#ff-root.perf-reduced .chip-seed svg{animation:none!important;transition:none!important}
#ff-root.strict .chip[data-state="drift"]{border-color:rgba(198,140,80,.75)}
#ff-root.strict .chip[data-state="interrupt"]{border-color:rgba(196,110,90,.8)}
#ff-root.strict .choice-card{border-color:rgba(196,110,90,.42)}
.choice-drift{display:block;margin-top:7px;font-size:12px;color:var(--ff-muted)}
.choice-plan{display:block;margin-top:9px;padding:8px 10px;border-left:3px solid #73956b;border-radius:6px;background:rgba(115,149,107,.1);font-size:12px;color:var(--ff-text)}
#ff-root.motion-off *,#ff-root.motion-off *::before,#ff-root.motion-off *::after{animation:none!important;transition:none!important}
#ff-root *{box-sizing:border-box}
.chip{position:fixed;top:16px;right:18px;display:flex;align-items:center;gap:9px;max-width:min(380px,calc(100vw - 32px));padding:8px 8px 8px 12px;border:1px solid var(--ff-border);border-radius:999px;background:linear-gradient(120deg,var(--ff-surface-a),var(--ff-surface-b));box-shadow:0 8px 28px rgba(42,65,41,.16),0 1px 0 rgba(255,255,255,.6) inset;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font:13px/1.25 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ff-text);pointer-events:auto;cursor:default;transition:transform .18s ease,box-shadow .18s ease,opacity .2s ease;animation:ff-slide-in .28s cubic-bezier(.2,.8,.3,1) both}
.chip:hover{box-shadow:0 10px 32px rgba(42,65,41,.22),0 1px 0 rgba(255,255,255,.6) inset}
.chip[hidden]{display:none}
.chip.dragging{transition:none;box-shadow:0 14px 40px rgba(42,65,41,.3)}
.chip[data-state="interrupt"]{border-color:rgba(189,132,115,.5)}
.chip[data-state="drift"]{border-color:rgba(198,165,98,.5)}
.chip[data-state="resting"]{opacity:.78}
.chip-seed{appearance:none;border:0;background:transparent;padding:0;position:relative;width:28px;height:28px;flex:none;cursor:grab;touch-action:none;color:inherit}
.chip-seed:active{cursor:grabbing}
.chip-seed svg{position:absolute;inset:0;width:100%;height:100%}
.chip-growth-ritual .chip-seed-tree{animation:ff-tree-grow 1.2s cubic-bezier(.25,.8,.25,1) both}
.chip-growth-flash .chip-seed-tree{animation:ff-tree-flicker .18s ease-in-out 3 both}
.chip-copy{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;overflow:hidden}
.chip-kicker{font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--ff-muted);white-space:nowrap}
.chip-mission{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip-state{font-size:11px;color:var(--ff-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip-actions{display:flex;gap:4px;flex:none}
.chip-btn{appearance:none;border:0;border-radius:999px;background:var(--ff-btn);color:var(--ff-btn-text);font:inherit;font-size:11px;padding:5px 10px;cursor:pointer;transition:background .15s,transform .1s;white-space:nowrap}
.chip-btn:hover{background:rgba(74,104,71,.2)}
.chip-btn:active{transform:scale(.94)}
.chip-btn.minimize{padding:5px 7px;font-size:13px;line-height:1}
.chip.minimized .chip-copy,.chip.minimized .chip-btn:not(.minimize){display:none}
.chip.minimized{padding:6px}
.chip.minimized .chip-mission{display:block;font-size:11px;max-width:90px}
@keyframes ff-tree-grow{0%{opacity:0;transform:scale(.3)}
60%{opacity:1;transform:scale(1.05)}
100%{opacity:1;transform:scale(1)}}
@keyframes ff-tree-flicker{0%,100%{opacity:1;filter:brightness(1)}
50%{opacity:.5;filter:brightness(1.4)}}
@keyframes ff-slide-in{from{opacity:0;transform:translateY(-8px) scale(.96)} to{opacity:1;transform:translateY(0) scale(1)}}
.choice-card{position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 112px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:20px 20px 18px;border:1px solid var(--ff-border);border-radius:24px;background:var(--ff-card);box-shadow:0 12px 36px rgba(42,65,41,.24);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);pointer-events:auto;animation:ff-slide-up .3s cubic-bezier(.2,.8,.3,1) both}
.choice-card[hidden]{display:none !important}
.choice-card .close{position:absolute;top:12px;right:12px;border:0;background:var(--ff-btn);border-radius:999px;width:28px;height:28px;font-size:16px;line-height:1;color:var(--ff-text);cursor:pointer;display:flex;align-items:center;justify-content:center}
.choice-card .close:hover{background:rgba(74,104,71,.2)}
.forest-find{position:fixed;right:24px;bottom:24px;display:grid;grid-template-columns:auto 1fr;column-gap:10px;row-gap:1px;align-items:center;max-width:min(340px,calc(100vw - 32px));padding:11px 15px 12px;border:1px solid var(--ff-find-border);border-radius:16px;background:var(--ff-find-bg);box-shadow:0 10px 28px rgba(82,70,39,.18);color:var(--ff-find-text);font:13px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:auto}
.forest-find[hidden]{display:none}
.forest-find.is-new{animation:ff-find-reveal .45s cubic-bezier(.2,.8,.3,1) both}
.forest-find[data-tier="blooms"]{border-color:rgba(187,119,123,.5);box-shadow:0 10px 30px rgba(120,75,78,.2)}
.forest-find-icon{grid-row:span 2;font-size:20px;line-height:1}
.forest-find-label{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ff-find-text)}
.forest-find-text{font-size:13px}
.choice-eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a7c59;margin:0 0 6px}
.choice-card h2{font:600 17px/1.3 ui-sans-serif,system-ui,sans-serif;color:#29432d;margin:0 0 8px}
.choice-copy{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#3d5239;margin:0 0 16px}
.choice-copy em{display:block;margin-top:10px;color:#6c8c68;font-size:13px}
.choice-actions{display:flex;flex-direction:column;gap:8px}
.choice{appearance:none;min-height:44px;border:1px solid rgba(74,104,71,.2);border-radius:14px;background:rgba(255,255,255,.85);color:#29432d;font:inherit;text-align:left;padding:12px 14px;cursor:pointer;display:flex;align-items:center;gap:12px;transition:background .15s,border-color .15s,transform .1s}
.choice:hover{background:#ffffff;border-color:rgba(74,104,71,.4);transform:translateX(2px)}
.choice:active{transform:scale(.98)}
.choice:focus-visible,.choice-card .close:focus-visible,.choice-secondary-action:focus-visible{outline:3px solid #527f57;outline-offset:3px}
.choice-secondary-action{appearance:none;display:block;width:100%;margin-top:12px;padding:10px 12px;border:1px solid rgba(74,104,71,.28);border-radius:12px;background:rgba(74,104,71,.08);color:#29432d;font:600 13px/1.35 ui-sans-serif,system-ui,sans-serif;text-align:center;cursor:pointer;transition:background .15s,border-color .15s}
.choice-secondary-action:hover{background:rgba(74,104,71,.14);border-color:rgba(74,104,71,.46)}
.choice-secondary-action:active{transform:scale(.99)}
.choice-icon{font-size:16px;width:22px;text-align:center;flex:none}
.choice span{display:block}
.choice>span:not(.choice-icon){flex:1;min-width:0}
.choice strong{display:block;font-weight:600;font-size:13px;line-height:1.35;overflow-wrap:anywhere}
.choice small{display:block;font-size:11px;line-height:1.4;color:#6c8c68;margin-top:3px;white-space:normal;overflow-wrap:anywhere}
@media(max-height:700px){.choice-card{max-height:calc(100vh - 112px);padding:12px 16px 10px;border-radius:20px}.choice-eyebrow{margin-bottom:3px}.choice-card h2{margin-bottom:5px}.choice-copy{font-size:13px;line-height:1.35;margin-bottom:10px}.choice-copy em{margin-top:5px;font-size:12px}.choice-plan{margin-top:6px;padding:6px 8px;font-size:11px}.choice-drift{margin-top:5px;font-size:11px;line-height:1.35}.choice-actions{gap:5px}.choice{padding:7px 12px}.choice small{font-size:10.5px;margin-top:2px}.choice-secondary-action{margin-top:7px;padding:7px 10px;font-size:12px}}
@keyframes ff-slide-up{from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)}}
@keyframes ff-find-reveal{0%{opacity:0;transform:translateY(10px) scale(.96)}60%{opacity:1;transform:translateY(-2px) scale(1.01)}100%{opacity:1;transform:translateY(0) scale(1)}}
@media (max-width:480px){.choice-card{right:12px;bottom:12px;max-width:calc(100vw - 24px);max-height:calc(100vh - 110px);padding:18px 16px 14px}}
@media (prefers-reduced-motion:reduce){.choice-card,.forest-find{animation:none!important}.choice,.choice-secondary-action{transition:none!important}}
`;

  let style = null;
  try {
    if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in Document.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(componentCssText);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    } else {
      style = document.createElement('style');
      style.textContent = componentCssText;
    }
  } catch {
    style = document.createElement('style');
    style.textContent = componentCssText;
  }
  if (style) shadow.append(style);

  const makeElement = (tag, className = '', attributes = {}, text = null) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value === true ? '' : String(value)));
    if (text != null) element.textContent = text;
    return element;
  };
  const makeChoice = (action, className, icon, title, copy) => {
    const button = makeElement('button', className, { 'data-action': action });
    const iconEl = makeElement('span', 'choice-icon', { 'aria-hidden': 'true' }, icon);
    const textEl = makeElement('span');
    textEl.append(makeElement('strong', '', {}, title), makeElement('small', '', {}, copy));
    button.append(iconEl, textEl);
    return button;
  };
  const rootEl = makeElement('div');
  rootEl.id = 'ff-root';
  const chipEl = makeElement('div', 'chip', { role: 'group', 'aria-label': 'Intent Grove companion', hidden: true });
  const seedEl = makeElement('button', 'chip-seed', { 'data-drag-handle': '', title: 'Drag to move', 'aria-label': 'Move companion with arrow keys' });
  // A tiny version of the storybook tree, built without an HTML/Trusted Types sink.
  const treeSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  treeSVG.setAttribute('viewBox', '0 0 28 28');
  treeSVG.setAttribute('class', 'chip-seed-tree');
  const iconShapes = [
    ['ellipse', { cx: 14, cy: 25, rx: 10, ry: 1.7, fill: '#d5dfbd' }],
    ['path', { d: 'M10.5 24.5 C12 21 12 17 11.8 13 L15.8 12 C15.4 17 16 21 18 24.5 Q14 26 10.5 24.5 Z', fill: '#b78653', stroke: '#906b43', 'stroke-width': '.7' }],
    ['path', { d: 'M5 18 C1 18 0 12 3.5 10 C1.5 6 6 2.5 9 4 C10 0 16 0 18 4 C22 2 26 6 24 9 C28 11 27 17 23 18 C22 22 17 21 15 19 C11 22 7 21 5 18 Z', fill: '#7ea85b', stroke: '#537943', 'stroke-width': '.7' }],
    ['path', { d: 'M4 11 C3 7 6 5 9 6 C9 2 16 2 17 6 C21 5 24 8 21 11 C17 13 14 10 12 12 C9 15 5 14 4 11 Z', fill: '#a1c576' }],
    ['path', { d: 'M7 7 Q10 4 12 6', fill: 'none', stroke: '#deebaf', 'stroke-width': '1.1', 'stroke-linecap': 'round' }]
  ];
  iconShapes.forEach(([tag, attributes]) => {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => shape.setAttribute(key, String(value)));
    treeSVG.append(shape);
  });
  seedEl.appendChild(treeSVG);
  const copyEl = makeElement('span', 'chip-copy');
  copyEl.append(makeElement('span', 'chip-kicker', '', 'current intention'), makeElement('strong', 'chip-mission'), makeElement('small', 'chip-state', { 'aria-live': 'polite' }));
  const actionsEl = makeElement('div', 'chip-actions');
  actionsEl.append(makeElement('button', 'chip-btn', { 'data-action': 'pause', 'aria-label': 'Pause Intent Grove' }, 'Pause'), makeElement('button', 'chip-btn', { 'data-action': 'pause-site', 'aria-label': 'Pause Intent Grove on this site' }, 'This site'), makeElement('button', 'chip-btn minimize', { 'data-action': 'minimize', 'aria-label': 'Minimize Intent Grove' }, '–'));
  chipEl.append(seedEl, copyEl, actionsEl);
  const choiceCardEl = makeElement('section', 'choice-card', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'ff-title', hidden: true });
  choiceCardEl.append(makeElement('button', 'close', { 'data-action': 'dismiss', 'aria-label': 'Keep exploring' }, '×'), makeElement('p', 'choice-eyebrow', {}, 'A moment to choose'), makeElement('h2', '', { id: 'ff-title' }, 'This path is deep, not wrong.'), makeElement('p', 'choice-copy'));
  const choiceActionsEl = makeElement('div', 'choice-actions');
  const returnChoice = makeChoice('home', 'choice', '↶', 'Return to my intention', 'Go back to where this session began.');
  choiceActionsEl.append(makeChoice('dismiss', 'choice', '→', 'Keep exploring', 'Leave the page open and continue by choice.'), returnChoice, makeChoice('compost', 'choice', '⌁', 'Save this for later', 'Put this curiosity in your compost pile.'), makeChoice('mission', 'choice', '＋', 'Start a new intention', 'Let this become the thing you are here to do.'));
  const missionHere = makeElement('button', 'choice-secondary-action', { type: 'button', 'data-action': 'mission-here' }, 'Use this page as my new starting point');
  choiceCardEl.append(choiceActionsEl, missionHere);
  const forestFindEl = makeElement('aside', 'forest-find', { role: 'status', 'aria-live': 'polite', hidden: true });
  rootEl.append(chipEl, choiceCardEl, forestFindEl);
  shadow.append(rootEl);

  const chip = shadow.querySelector('.chip');
  const choiceCard = shadow.querySelector('.choice-card');
  const choiceCopy = shadow.querySelector('.choice-copy');
  const missionEl = shadow.querySelector('.chip-mission');
  const stateEl = shadow.querySelector('.chip-state');
  const pauseBtn = shadow.querySelector('[data-action="pause"]');
  const minimizeBtn = shadow.querySelector('[data-action="minimize"]');
  let current = null;
  // Monotonic token: update() awaits the growth ritual (~1.7s) and must not
  // repaint after a newer update() has already re-rendered or hidden the UI.
  let updateGeneration = 0;
  let lastUrl = location.href;
  let lastTitle = document.title;
  let ritualToken = 0;
  let ritualTimer = 0;
  let lastPageFocus = null;
  let growthAnimationTrigger = 'mission-origin';
  let ambientMotion = true;
  const ORIGIN_RITUAL_SESSION_KEY = 'intent-grove-origin-ritual-played';
  const LEGACY_ORIGIN_RITUAL_SESSION_KEY = 'ff-origin-ritual-played';
  let originRitualPlayed = false;
  try {
    originRitualPlayed = sessionStorage.getItem(ORIGIN_RITUAL_SESSION_KEY) === 'true';
    if (!originRitualPlayed && sessionStorage.getItem(LEGACY_ORIGIN_RITUAL_SESSION_KEY) === 'true') {
      sessionStorage.setItem(ORIGIN_RITUAL_SESSION_KEY, 'true');
      originRitualPlayed = true;
    }
    sessionStorage.removeItem(LEGACY_ORIGIN_RITUAL_SESSION_KEY);
  } catch { /* storage may be unavailable */ }
  let forestFindTimer = 0;
  function showForestFind(reward) {
    if (!reward?.text) return;
    const labels = { seeds: 'Seed noticed', leaves: 'Leaf noticed', blooms: 'Bloom noticed' };
    forestFindEl.dataset.tier = reward.tier || 'seeds';
    const iconEl = document.createElement('span');
    iconEl.className = 'forest-find-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = reward.icon || '✦';
    const labelEl = document.createElement('span');
    labelEl.className = 'forest-find-label';
    labelEl.textContent = labels[reward.tier] || 'Quiet discovery';
    const textEl = document.createElement('span');
    textEl.className = 'forest-find-text';
    textEl.textContent = reward.text;
    forestFindEl.replaceChildren(iconEl, labelEl, textEl);
    forestFindEl.classList.remove('is-new');
    if (!rootEl.classList.contains('perf-reduced')) {
      void forestFindEl.offsetWidth;
      forestFindEl.classList.add('is-new');
    }
    forestFindEl.hidden = false;
    window.clearTimeout(forestFindTimer);
    forestFindTimer = window.setTimeout(() => { forestFindEl.hidden = true; }, 5200);
  }
  document.addEventListener('focusin', (event) => {
    if (event.target !== root && event.target?.isConnected) lastPageFocus = event.target;
  }, true);

  // === SPA SUPPORT: history.pushState / history.replaceState patch ===
  // IMPORTANT (isolated world): this content script normally runs in Chrome's
  // ISOLATED world, where assigning to `history.pushState` only shadows the
  // method for this world — the page's own pushState/replaceState calls never
  // pass through it. In production, page-initiated history writes are covered
  // by content/spa-bridge.js (a MAIN-world companion registered in the
  // manifest, which re-announces them as DOM events below) and by the service
  // worker's webNavigation.onHistoryStateUpdated listener. The patch is kept
  // because it is inert-but-harmless in the isolated world and active wherever
  // this module is imported directly into a page world (the repository's
  // Playwright harness does exactly that).
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  let spaUpdateChain = Promise.resolve();
  
  // Title-only mutations (playback progress in <title>, timers, live
  // dashboards) used to fire two worker messages per change with no time
  // bound — a video page could spend the tab's whole rate budget and keep the
  // worker writing title updates all day. URL changes stay immediate; a
  // title-only change is coalesced to at most one send per TITLE_THROTTLE_MS,
  // trailing edge included, so the final title always lands.
  const TITLE_THROTTLE_MS = 5000;
  let titleThrottleTimer = 0;
  let lastSpaSendAt = 0;
  function queueSpaUpdate(nextUrl, nextTitle) {
    lastSpaSendAt = Date.now();
    spaUpdateChain = spaUpdateChain.then(async () => {
      await send('SPA_NAVIGATION', { url: nextUrl, title: nextTitle });
      await safeUpdate(await send('GET_ACTIVE_VIEW'));
    }).catch((error) => {
      logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'spaNavigation' });
    });
  }
  const notifyUrlChange = wrapWithErrorBoundary((nextUrl = location.href, nextTitle = document.title) => {
    if (lastUrl === nextUrl && lastTitle === nextTitle) return;
    const urlChanged = lastUrl !== nextUrl;
    lastUrl = nextUrl;
    lastTitle = nextTitle;
    if (titleThrottleTimer) { window.clearTimeout(titleThrottleTimer); titleThrottleTimer = 0; }
    if (urlChanged || Date.now() - lastSpaSendAt >= TITLE_THROTTLE_MS) { queueSpaUpdate(nextUrl, nextTitle); return; }
    titleThrottleTimer = window.setTimeout(() => {
      titleThrottleTimer = 0;
      if (location.href === nextUrl) queueSpaUpdate(location.href, document.title);
    }, TITLE_THROTTLE_MS - (Date.now() - lastSpaSendAt));
  }, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'notifyUrlChange', swallow: true });

  history.pushState = function(...args) {
    const result = originalPushState.apply(this, args);
    notifyUrlChange();
    return result;
  };

  history.replaceState = function(...args) {
    const result = originalReplaceState.apply(this, args);
    notifyUrlChange();
    return result;
  };

  // === SPA SUPPORT: MutationObserver for dynamic title changes ===
  // Some SPAs change titles without pushing state
  const titleObserver = new MutationObserver(wrapWithErrorBoundary(() => {
    if (document.title !== lastTitle) {
      notifyUrlChange();
    }
  }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'titleObserver', swallow: true }));
  
  const titleElement = document.querySelector('title');
  if (titleElement) {
    titleObserver.observe(titleElement, { childList: true, characterData: true });
  }
  const headObserver = new MutationObserver(wrapWithErrorBoundary(() => {
    const dynamicTitle = document.querySelector('title');
    if (dynamicTitle && dynamicTitle !== dynamicTitleElement) {
      dynamicTitleElement = dynamicTitle;
      titleObserver.observe(dynamicTitleElement, { childList: true, characterData: true });
    }
  }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'headObserver', swallow: true }));
  let dynamicTitleElement = titleElement;
  if (document.head) headObserver.observe(document.head, { childList: true, subtree: true });

  // The chip stays visible at all times (per README: "stays quietly available").
  // It does not auto-hide on scroll. Users can manually minimize via the minimize button.

  // --- Drag-to-move the chip (Pointer Events + setPointerCapture) ---
  // The remembered position lives in extension-private session storage held
  // by the service worker (per tab, per origin, cleared with the browser
  // session) — never in the page's own storage, so a host site cannot read
  // it. Restoration is async; the reply lands inside the slide-in animation.
  restoreChipPos();
  function applyChipPos(x, y) { chip.style.left = `${x}px`; chip.style.top = `${y}px`; chip.style.right = 'auto'; }
  async function restoreChipPos(retried = false) {
    try {
      const saved = await send('GET_CHIP_POS');
      if (saved?.rateLimited) {
        // A busy tab can defer the restore; retry once so the remembered
        // corner still comes back after the message budget frees up.
        if (!retried) window.setTimeout(() => restoreChipPos(true), 1200);
        return;
      }
      if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
      if (pendingChipPos || savedChipPos) return; // the user already moved the chip during this page load
      // The position may have been recorded at a very different viewport
      // size, so clamp it back inside the current window before applying.
      const clampedX = Math.max(8, Math.min(Math.max(8, window.innerWidth - 48), saved.x));
      const clampedY = Math.max(8, Math.min(Math.max(8, window.innerHeight - 48), saved.y));
      applyChipPos(clampedX, clampedY);
    } catch { /* best effort; the chip simply keeps its default corner */ }
  }
  let chipPosSaveTimer = 0;
  let pendingChipPos = null; // latest position awaiting persistence
  let savedChipPos = null;   // last position the worker acknowledged
  function saveChipPos(x, y, { immediate = false } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pendingChipPos = { x, y };
    if (chipPosSaveTimer) { window.clearTimeout(chipPosSaveTimer); chipPosSaveTimer = 0; }
    // Keyboard auto-repeat must not flood the worker's per-tab message
    // budget: keyboard saves ride a short trailing debounce, while a
    // finished drag (one-shot) persists immediately, matching the timing of
    // the synchronous sessionStorage write this replaces.
    if (immediate) { flushChipPos(); return; }
    chipPosSaveTimer = window.setTimeout(flushChipPos, 250);
  }
  async function flushChipPos(isRetry = false) {
    chipPosSaveTimer = 0;
    const target = pendingChipPos;
    if (!target) return;
    if (savedChipPos && savedChipPos.x === target.x && savedChipPos.y === target.y) { pendingChipPos = null; return; } // skip no-op writes
    try {
      const response = await send('SET_CHIP_POS', target);
      if (response?.rateLimited) {
        // Keep the position pending and retry once; the budget frees within
        // seconds, and a newer move simply replaces the pending target, so a
        // retry can never overwrite a fresher position with a stale one.
        if (!isRetry) window.setTimeout(() => flushChipPos(true), 1200);
        return;
      }
      savedChipPos = target;
      pendingChipPos = null;
    } catch { pendingChipPos = null; /* best effort; an extension reload must not disturb the page */ }
  }
  const dragHandle = shadow.querySelector('[data-drag-handle]');
  let dragging = false;
  dragHandle.addEventListener('pointerdown', wrapWithErrorBoundary((e) => {
    e.preventDefault();
    if (dragging) return; // an interrupted drag (pointercancel) must not stack a second handler set
    dragging = true;
    const rect = chip.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    chip.classList.add('dragging');
    try { dragHandle.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const onMove = wrapWithErrorBoundary((ev) => {
      const x = Math.max(8, Math.min(window.innerWidth - rect.width - 8, ev.clientX - offsetX));
      const y = Math.max(8, Math.min(window.innerHeight - rect.height - 8, ev.clientY - offsetY));
      applyChipPos(x, y);
    }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'drag.pointermove', swallow: true });
    const finish = (ev) => {
      if (!dragging) return;
      dragging = false;
      chip.classList.remove('dragging');
      // releasePointerCapture throws NotFoundError once the pointer is gone
      // (e.g. pointercancel); the cleanup must still run in that case.
      try { dragHandle.releasePointerCapture(ev?.pointerId ?? e.pointerId); } catch { /* pointer already released */ }
      const finalRect = chip.getBoundingClientRect();
      saveChipPos(finalRect.left, finalRect.top, { immediate: true });
      dragHandle.removeEventListener('pointermove', onMove);
      dragHandle.removeEventListener('pointerup', onUp);
      dragHandle.removeEventListener('pointercancel', onCancel);
    };
    const onUp = wrapWithErrorBoundary((ev) => { finish(ev); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'drag.pointerup', swallow: true });
    const onCancel = wrapWithErrorBoundary((ev) => { finish(ev); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'drag.pointercancel', swallow: true });
    dragHandle.addEventListener('pointermove', onMove);
    dragHandle.addEventListener('pointerup', onUp);
    dragHandle.addEventListener('pointercancel', onCancel);
  }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'drag.pointerdown', swallow: true }));
  dragHandle.addEventListener('keydown', wrapWithErrorBoundary((event) => {
    const step = event.shiftKey ? 24 : 8;
    const rect = chip.getBoundingClientRect();
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') { chip.style.left = ''; chip.style.right = '18px'; chip.style.top = '16px'; return; }
    const x = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)));
    const y = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)));
    applyChipPos(x, y);
    saveChipPos(x, y);
  }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'drag.keydown', swallow: true }));

  // --- Performance guardian (inline mirror of shared/ram-guard.js; content
  // scripts are classic non-module scripts and cannot import). Signal 1 is
  // the worker-relayed real free-RAM ratio (chrome.system.memory, cached and
  // refreshed on paths that already run); signals 2/3 are this renderer's
  // device-memory class and own JS heap — the same per-tab heap value that
  // memory-monitor extensions obtain via script injection, read here for
  // free because the companion already lives in the page's renderer.
  // Decorations calm on evidence; tracking, the chip, and the choice card
  // always keep working. Release uses a hysteresis band so noisy samples
  // near a threshold cannot flap the mode between refreshes.
  const PERF_GUARD_LEVELS = [
    { heapCeiling: 0.9, deviceFloorGb: 0.25, systemFloor: 0.03 },
    { heapCeiling: 0.8, deviceFloorGb: 0.5, systemFloor: 0.05 },
    { heapCeiling: 0.7, deviceFloorGb: 1, systemFloor: 0.08 },
    { heapCeiling: 0.6, deviceFloorGb: 2, systemFloor: 0.12 },
    { heapCeiling: 0.5, deviceFloorGb: 4, systemFloor: 0.18 }
  ];
  let perfReducedSticky = false;
  function computePerfReduced(settings, systemMemory) {
    if (!settings || settings.ramGuard === false) { perfReducedSticky = false; return false; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) { perfReducedSticky = true; return true; }
    const level = PERF_GUARD_LEVELS[Math.max(1, Math.min(5, Number(settings.ramGuardLevel) || 3)) - 1];
    const freeRatio = Number.isFinite(systemMemory?.freeRatio) ? systemMemory.freeRatio : null;
    const deviceGb = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null;
    const mem = performance.memory;
    const heapRatio = mem && Number.isFinite(mem.jsHeapSizeLimit) && mem.jsHeapSizeLimit > 0 && Number.isFinite(mem.usedJSHeapSize) ? mem.usedJSHeapSize / mem.jsHeapSizeLimit : null;
    if (freeRatio !== null && freeRatio <= level.systemFloor) { perfReducedSticky = true; return true; }
    if (deviceGb !== null && deviceGb <= level.deviceFloorGb) { perfReducedSticky = true; return true; }
    if (heapRatio !== null && heapRatio >= level.heapCeiling) { perfReducedSticky = true; return true; }
    if (perfReducedSticky && heapRatio !== null && heapRatio >= level.heapCeiling - 0.05) return true;
    if (perfReducedSticky && freeRatio !== null && freeRatio <= level.systemFloor + 0.03) return true;
    perfReducedSticky = false;
    return false;
  }

  async function loadSettings() {
    try {
      const snap = await send('GET_ACTIVE_VIEW');
      if (snap?.rateLimited) return; // keep current settings; the next refresh retries
      growthAnimationTrigger = snap.settings?.growthAnimationTrigger || 'mission-origin';
      ambientMotion = snap.settings?.ambientMotion !== false;
      rootEl.classList.toggle('motion-off', !ambientMotion);
      rootEl.classList.toggle('perf-reduced', computePerfReduced(snap?.settings, snap?.systemMemory));
    } catch (error) {
      logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'loadSettings' });
      growthAnimationTrigger = 'mission-origin';
    }
  }

  function cancelGrowthRitual() { ritualToken += 1; window.clearTimeout(ritualTimer); ritualTimer = 0; chip.classList.remove('chip-growth-ritual', 'chip-growth-flash'); }
  function waitForGrowth(ms, token) { return new Promise((resolve) => { ritualTimer = window.setTimeout(() => resolve(token === ritualToken), ms); }); }

  const safeShowGrowthRitual = wrapWithErrorBoundary(showGrowthRitual, { category: ERROR_CATEGORIES.UI_RENDER, function: 'showGrowthRitual' });

  async function showGrowthRitual(isOrigin = false) {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !ambientMotion) return false;
    if (growthAnimationTrigger === 'none') return false;
    if (growthAnimationTrigger === 'mission-origin' && !isOrigin) return false;
    if (growthAnimationTrigger === 'mission-origin' && originRitualPlayed) return false;
    // Mark the origin ritual as played *before* the awaits below: a second origin
    // load arriving mid-animation must not start the ritual over again.
    if (isOrigin) {
      originRitualPlayed = true;
      try { sessionStorage.setItem(ORIGIN_RITUAL_SESSION_KEY, 'true'); } catch { /* storage may be unavailable */ }
    }
    const token = ++ritualToken;
    window.clearTimeout(ritualTimer);
    chip.classList.remove('chip-growth-flash');
    chip.classList.add('chip-growth-ritual');
    stateEl.textContent = 'A branch is growing';
    chip.hidden = false;
    // Tree grows for ~1.2s, then flickers for ~0.5s before notification
    if (!await waitForGrowth(1200, token)) return false;
    chip.classList.remove('chip-growth-ritual');
    chip.classList.add('chip-growth-flash');
    if (!await waitForGrowth(540, token)) return false;
    chip.classList.remove('chip-growth-flash');
    return true;
  }

  let viewDrift = null;
  let viewHasNote = false;
  let viewStrict = false;
  let perfReduced = false;
  const safeUpdate = wrapWithErrorBoundary(update, { category: ERROR_CATEGORIES.UI_RENDER, function: 'update' });
  async function update(view) {
    // A rate-limited GET_ACTIVE_VIEW answers { rateLimited: true }; keep the
    // last known view rather than hiding the chip mid-mission.
    if (view && view.rateLimited) return;
    const generation = ++updateGeneration;
    const previous = current;
    current = view?.session || null;
    if (!current?.node || view?.sitePaused) { hideOverlays({ stopRitual: true }); return; }
    resetRitualOnSessionChange(previous, current);
    const depth = current.node.depth || 0;
    const paused = current.interventionPaused;
    const thresholds = view?.thresholds || { DESATURATE: 4, INTERRUPT: 5 };
    viewDrift = view?.drift || null;
    viewHasNote = Boolean(view?.hasNote);
    viewStrict = Boolean(view?.settings?.strictMode);
    rootEl.classList.toggle('strict', viewStrict);
    perfReduced = computePerfReduced(view?.settings, view?.systemMemory);
    rootEl.classList.toggle('perf-reduced', perfReduced);
    const { stateKind, state } = depthState(depth, paused, thresholds, viewStrict);
    const enteredNewBranch = !paused && previous?.node?.id && previous.node.id !== current.node.id && depth > (previous.node.depth || 0);
    const isOriginLoad = !paused && !previous?.node?.id && depth === 0;
    applyChipCopy(current, enteredNewBranch ? 'growing' : stateKind, state, paused);
    // Ritual parks "A branch is growing" in stateEl; the final write restores it.
    if (perfReduced) cancelGrowthRitual();
    else if (isOriginLoad) await safeShowGrowthRitual(true); else if (enteredNewBranch) await safeShowGrowthRitual(false); else cancelGrowthRitual();
    // A newer update() ran during the ritual await; it owns the UI now.
    if (generation !== updateGeneration) return;
    const interventionEligible = !paused && Boolean(view.interventionEligible);
    if (interventionEligible && choiceCard.dataset.shownFor !== location.href) showChoiceSheet(depth, current.node.confidence);
    else if (!choiceCard.hidden && !interventionEligible) hideOverlays({ hideChip: false });
    stateEl.textContent = state;
  }

  // DOM-safe choice sheet: all dynamic content set via textContent/elements, no innerHTML.
  function showChoiceSheet(depth, confidence = 'medium') {
    choiceCard.dataset.shownFor = location.href;
    if (document.activeElement !== root && document.activeElement?.isConnected) lastPageFocus = document.activeElement;
    choiceCopy.replaceChildren();
    const reflectionPrompts = [
      'What would make this detour worth keeping?',
      'Is this still serving the intention, or is it a new question?',
      'If you continue, what are you looking for next?'
    ];
    const missionEl = document.createElement('q');
    missionEl.textContent = current?.mission || '';
    const depthEl = document.createElement('strong');
    depthEl.textContent = String(depth);
    const pageEl = document.createElement('q');
    pageEl.textContent = document.title || location.hostname;
    const originTarget = String(current?.origin?.title || (() => { try { return new URL(current?.origin?.url || '').hostname; } catch { return 'the mission root'; } })());
    const returnTitle = returnChoice.querySelector('strong');
    const returnCopy = returnChoice.querySelector('small');
    if (returnTitle) returnTitle.textContent = `Return to “${originTarget.slice(0, 48)}${originTarget.length > 48 ? '…' : ''}”`;
    if (returnCopy) returnCopy.textContent = 'Go back to where this session began.';
    const promptEl = document.createElement('em');
    promptEl.textContent = reflectionPrompts[Math.floor(depth) % reflectionPrompts.length]; // floor(): a fractional depth (import-only) would index undefined and render it
    choiceCopy.append(
      document.createTextNode('You set '),
      missionEl,
      document.createTextNode('. The browser recorded '),
      depthEl,
      document.createTextNode(` ${depth === 1 ? 'navigation step' : 'navigation steps'} to `),
      pageEl,
      document.createTextNode(` (${confidence}-confidence estimate). This is path distance, not page relevance. You decide what to do next. `),
      promptEl
    );
    const planText = current?.responsePlan === 'return'
      ? 'You chose: return to your intention.'
      : current?.responsePlan === 'save'
        ? 'You chose: save this curiosity for later.'
        : 'You chose to pause and decide in the moment.';
    const planEl = document.createElement('span');
    planEl.className = 'choice-plan';
    planEl.textContent = `${planText} All options remain available.`;
    choiceCopy.append(planEl);
    if (viewDrift && viewDrift.pages > 0) {
      const driftEl = document.createElement('span');
      driftEl.className = 'choice-drift';
      driftEl.textContent = driftSentence(viewDrift.pages, Math.ceil(viewDrift.seconds / 60));
      choiceCopy.append(driftEl);
    }
    choiceCard.hidden = false;
    shadow.querySelector('[data-action="dismiss"]').focus();
  }

  /**
   * Single funnel for hiding the companion overlays. Hiding the chip or the
   * choice card while one of their controls holds focus strands focus on
   * <body>, because shadow.activeElement is the closed-shadow view of the
   * focused element while document.activeElement only ever sees the shadow
   * host. Every hide path routes through here so the rule cannot drift again:
   * it was applied in two of three paths and missed in the rest. This is also
   * what retracts the sheet the moment the view stops qualifying — without
   * that, a deep -> shallow navigation left the card pinned on screen.
   * @param {{hideChip?: boolean, hideCard?: boolean, stopRitual?: boolean}} [options]
   */
  function hideOverlays({ hideChip = true, hideCard = true, stopRitual = false } = {}) {
    const shadowFocus = shadow.activeElement;
    const stranded = Boolean(shadowFocus)
      && ((hideChip && chip.contains(shadowFocus)) || (hideCard && choiceCard.contains(shadowFocus)));
    if (stopRitual) cancelGrowthRitual();
    if (hideChip) chip.hidden = true;
    if (hideCard) choiceCard.hidden = true;
    if (stranded) restorePageFocus();
  }

  /**
   * Maps a branch depth to the visible chip state and its status line.
   * Pure so the wording lives in one place instead of being re-derived inline
   * on every refresh.
   * @returns {{stateKind: string, state: string}}
   */
  function depthState(depth, paused, thresholds, strict = false) {
    if (paused) return { stateKind: 'resting', state: 'Grove resting' };
    // Strict mode changes only the wording at and beyond the quiet line; the
    // gentle strings are pinned byte-for-byte by the e2e suite (F4).
    if (depth >= thresholds.INTERRUPT) return { stateKind: 'interrupt', state: strict ? 'Your chosen check-in point is here' : 'A moment to check in' };
    if (depth >= thresholds.DESATURATE) return { stateKind: 'drift', state: strict ? 'You keep going deeper' : 'This branch is getting long' };
    return depth > 0
      ? { stateKind: 'branch', state: `${depth} ${depth === 1 ? 'branch' : 'branches'} deep` }
      : { stateKind: 'root', state: 'Growing from this mission' };
  }

  // Drift accounting copy: the same facts in both modes — strict swaps the
  // reassurance for accountability and, when a private note exists, quotes
  // the user's own "why" back to them (the note text itself never arrives).
  function driftSentence(pages, minutes) {
    const facts = `${pages} deeper-path ${pages === 1 ? 'page has' : 'pages have'} been open for about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} in total. Tabs can overlap, and background time counts; this is elapsed time, not active reading time.`;
    if (!viewStrict) return facts;
    return viewHasNote ? `You wrote down why this mattered. ${facts} You can decide whether this still serves that intention.` : `${facts} You can decide whether this still serves your intention.`;
  }

  /** Re-arms the origin growth ritual when the view moves to a different garden. */
  function resetRitualOnSessionChange(previous, next) {
    const previousSessionId = previous?.id || null;
    const currentSessionId = next.id || null;
    if (!previousSessionId || !currentSessionId || previousSessionId === currentSessionId) return;
    originRitualPlayed = false;
    try {
      sessionStorage.removeItem(ORIGIN_RITUAL_SESSION_KEY);
      sessionStorage.removeItem(LEGACY_ORIGIN_RITUAL_SESSION_KEY);
    } catch { /* storage may be unavailable */ }
  }

  /** Writes the mission line, chip state and pause control. */
  function applyChipCopy(session, stateKind, state, paused) {
    missionEl.textContent = session.mission;
    chip.dataset.state = stateKind;
    chip.setAttribute('aria-label', `Intent Grove companion. Intention: ${session.mission}. ${state}.`);
    chip.hidden = false;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume Intent Grove' : 'Pause Intent Grove');
  }

  // hideChip:false keeps the companion chip on screen while the sheet closes.
  // Restoration is conditional on the card actually holding focus, so a click
  // that started in the chip is left where the user put it.
  function hideChoiceCard() { hideOverlays({ hideChip: false }); }
  function restorePageFocus() {
    const target = lastPageFocus;
    if (target?.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  shadow.addEventListener('click', wrapWithErrorBoundary(async (event) => {
    if (!event.isTrusted) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'home') { hideChoiceCard(); showForestFind((await send('GO_HOME'))?.reward); }
    else if (action === 'compost') { showForestFind((await send('COMPOST', { url: location.href, title: document.title }))?.reward); hideChoiceCard(); restorePageFocus(); }
    else if (action === 'mission') {
      const result = await send('END_MISSION', { reason: 'mission_changed' });
      showForestFind(result?.reward);
      hideChoiceCard();
      // A web page cannot navigate itself to a chrome-extension:// URL that is
      // not web_accessible_resources (this extension keeps that list empty on
      // purpose), so ask the worker to navigate this tab to the planting page.
      await send('OPEN_PLANTING_PAGE');
    }
    else if (action === 'mission-here') {
      const mission = compactPageTitle(document.title, location.hostname);
      const result = await send('START_MISSION', { mission });
      if (result) {
        hideOverlays();
        await safeRefresh(false);
      }
    }
    else if (action === 'dismiss') { hideChoiceCard(); restorePageFocus(); send('DISMISS_INTERVENTION', { url: location.href }).catch((error) => logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'dismissIntervention' })); }
    else if (action === 'pause') { await send('PAUSE_INTERVENTION', { paused: !current?.interventionPaused }); await safeRefresh(false); }
    else if (action === 'pause-site') {
      await send('PAUSE_SITE');
      hideOverlays();
    }
    else if (action === 'minimize') { chip.classList.toggle('minimized'); minimizeBtn.textContent = chip.classList.contains('minimized') ? '+' : '\u2013'; }
  }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'shadow.click', swallow: true }));

  function compactPageTitle(title, hostname) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    return (clean || hostname || 'Explore this page').slice(0, 140);
  }

  shadow.addEventListener('keydown', wrapWithErrorBoundary((event) => {
    if (event.key === 'Escape' && !choiceCard.hidden) {
      hideChoiceCard();
      send('DISMISS_INTERVENTION', { url: location.href }).catch((error) => logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'dismissIntervention' }));
      return;
    }
  }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'shadow.keydown', swallow: true }));

  document.addEventListener('click', wrapWithErrorBoundary(async (event) => {
    if (!event.isTrusted || event.button !== 0 || event.defaultPrevented) return;
    const link = event.target.closest('a[href]');
    if (!link) return;
    let target;
    try { target = new URL(link.href, location.href); } catch { return; }
    if (!['http:', 'https:'].includes(target.protocol) || (target.href.split('#')[0] === location.href.split('#')[0] && target.hash)) return;
    const opensElsewhere = link.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
    await send('LINK_CLICK', { url: target.href, title: link.textContent?.trim() || target.hostname, targetBlank: opensElsewhere });
  }, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'document.click', swallow: true }), true);

  // Timestamp of the most recent view refresh; the storage-sync gate below
  // uses it to skip redundant refreshes right after a navigation-driven one.
  let lastRefreshAt = 0;
  const safeRefresh = wrapWithErrorBoundary(refresh, { category: ERROR_CATEGORIES.MESSAGING, function: 'refresh', swallow: true });
  async function refresh(observe = true) {
    lastRefreshAt = Date.now();
    try {
      if (observe) await send('OBSERVE_PAGE', { url: location.href, title: document.title });
      await safeUpdate(await send('GET_ACTIVE_VIEW'));
    } catch { update(null); }
  }

  // SPA-URL watch: polls at a fixed interval while the tab is visible and stops
  // entirely on hidden tabs. The service worker also receives
  // webNavigation.onHistoryStateUpdated, so this is only a render fallback for
  // SPA navigations those events miss.
  let watchTimer = 0;
  const WATCH_INTERVAL_MS = 2500;
  function scheduleWatch() {
    window.clearTimeout(watchTimer);
    if (document.hidden) return;
    watchTimer = window.setTimeout(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; choiceCard.removeAttribute('data-shown-for'); refresh(true); }
      scheduleWatch();
    }, WATCH_INTERVAL_MS);
  }

  // Debounced navigation handler to prevent rapid-fire state updates during SPA transitions
  let navDebounceTimer = null;
  const onNavigation = () => {
    if (navDebounceTimer) window.clearTimeout(navDebounceTimer);
    navDebounceTimer = window.setTimeout(() => {
      if (location.href !== lastUrl) {
        choiceCard.removeAttribute('data-shown-for');
        notifyUrlChange(location.href, document.title);
      }
    }, 100); // 100ms debounce window - faster for responsive SPA feel while preventing flicker
  };
  const safeOnNavigation = wrapWithErrorBoundary(onNavigation, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'onNavigation', swallow: true });
  window.addEventListener('popstate', safeOnNavigation, { passive: true });
  window.addEventListener('hashchange', safeOnNavigation, { passive: true });

  // MAIN-world bridge: content/spa-bridge.js (manifest content_scripts entry
  // with "world": "MAIN", Chrome 111+) re-announces page-initiated
  // pushState/replaceState writes as this payload-less DOM event, which crosses
  // into the isolated world. It carries no data on purpose — the handler
  // re-reads location/document itself, so a page cannot inject values into the
  // extension through this channel, and a synthetic event without an actual
  // URL/title change is a no-op inside notifyUrlChange.
  document.addEventListener('intent-grove-history', safeOnNavigation);
  // Existing tabs can still have the prior MAIN-world bridge in memory until
  // they navigate or reload; listen to its data-free event during migration.
  document.addEventListener('focus-forest-history', safeOnNavigation);

  // SPA navigation detection: bridge event (above), popstate/hashchange, the
  // title MutationObserver, the service worker's onHistoryStateUpdated, and
  // the visibility-gated polling watch below.
  
  // pageshow fires on the initial load too, where init already refreshed;
  // only bfcache restores (persisted) need a follow-up view refresh. This
  // removes one redundant message per navigation from the tab's rate budget.
  window.addEventListener('pageshow', wrapWithErrorBoundary((event) => { if (event?.persisted) safeRefresh(false); }, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'pageshow', swallow: true }), { passive: true });
  document.addEventListener('visibilitychange', wrapWithErrorBoundary(() => { if (document.hidden) window.clearTimeout(watchTimer); else { safeRefresh(false); scheduleWatch(); } }, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'visibilitychange', swallow: true }));

  // Persist a pending position when the document goes away (navigation or
  // bfcache freeze): best-effort fire-and-forget, mirroring the synchronous
  // durability of the sessionStorage write this system replaced. The SW
  // receives the message at dispatch time even if the response never lands.
  window.addEventListener('pagehide', wrapWithErrorBoundary(() => {
    if (chipPosSaveTimer) { window.clearTimeout(chipPosSaveTimer); chipPosSaveTimer = 0; }
    if (pendingChipPos) send('SET_CHIP_POS', pendingChipPos).catch(() => {});
  }, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'pagehide.chipPos', swallow: true }));

  const safeLoadSettings = wrapWithErrorBoundary(loadSettings, { category: ERROR_CATEGORIES.MESSAGING, function: 'loadSettings', swallow: true });
  const safeScheduleWatch = wrapWithErrorBoundary(scheduleWatch, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'scheduleWatch', swallow: true });

  // Cross-context sync: a mission can be planted, ended, paused, or re-tuned
  // from the popup, the New Tab page, the dashboard, or the Alt+F shortcut
  // while this page sits idle. Every such change is persisted to
  // chrome.storage.local by the worker, so watching that key keeps the chip
  // and choice card truthful without waiting for a navigation. The debounce
  // coalesces write bursts, and the freshness gate skips the sync when a
  // navigation-driven refresh just ran, keeping this tab well inside the
  // worker's message rate limit. The key mirrors STORAGE_KEY in
  // shared/state.js; this classic content script cannot import ES modules.
  let storageSyncTimer = 0;
  const STORAGE_SYNC_KEYS = ['intentGroveState', 'focusForestState'];
  const STORAGE_SYNC_DEBOUNCE_MS = 200;
  const STORAGE_SYNC_MIN_GAP_MS = 600;
  const runStorageSync = () => {
    // Hidden tabs skip the sync entirely: nobody can see the chip, and the
    // visibilitychange handler already refreshes the moment the tab is shown.
    // This keeps background tabs out of the worker's message rate budget
    // when many tabs are open and another one is browsing actively.
    if (document.hidden) return;
    const since = Date.now() - lastRefreshAt;
    if (since < STORAGE_SYNC_MIN_GAP_MS) {
      // A navigation-driven refresh just ran — but it PREDATES this storage
      // change. Dropping the sync here would leave the chip stale until the
      // next navigation (proven in vivo: a fast compost or a settings change
      // never reached the page). Defer, never discard: re-arm for the moment
      // the freshness gate expires.
      window.clearTimeout(storageSyncTimer);
      storageSyncTimer = window.setTimeout(runStorageSync, STORAGE_SYNC_MIN_GAP_MS - since + 50);
      return;
    }
    safeRefresh(false);
  };
  chrome.storage?.onChanged?.addListener(wrapWithErrorBoundary((changes, area) => {
    if (area !== 'local' || !changes || !STORAGE_SYNC_KEYS.some((key) => Object.hasOwn(changes, key))) return;
    window.clearTimeout(storageSyncTimer);
    storageSyncTimer = window.setTimeout(runStorageSync, STORAGE_SYNC_DEBOUNCE_MS);
  }, { category: ERROR_CATEGORIES.CONTENT_SCRIPT, function: 'storage.onChanged', swallow: true }));

  safeLoadSettings();
  safeRefresh(true);
  safeScheduleWatch();
}

initContentScript();
})();
