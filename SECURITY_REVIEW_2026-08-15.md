# Focus Forest Security and Correctness Review — 2026-08-15

> Historical report: this audit was written under the former Focus Forest name and describes the repository at its stated date. It is retained as a record; current product behavior and guidance are documented in [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [EVIDENCE.md](EVIDENCE.md), and [SECURITY.md](SECURITY.md).

## Scope and baseline

The audit targets the published no-shortcuts `main` branch of `swapniljoydhar/focus-forest` at the pre-review commit. The repository is a dependency-free Manifest V3 extension with a service worker, HTTP(S)-only content script, New Tab override, popup, dashboard, settings page, local storage, and a mocked-Chrome behavior harness.

No source files were changed during the initial audit and research pass.

## Confirmed or high-confidence findings

| ID | Severity | Surface | Finding | Evidence | Candidate direction |
|---|---|---|---|---|---|
| F-01 | Medium security/privacy | `manifest.json` | `host_permissions` and static content-script matches cover every HTTP and HTTPS origin, while the companion only needs eligible top-level pages. | Manifest lines 9, 15–18; Chrome permission guidance says broad host access increases authority and optional permissions should be used where possible. | Evaluate whether the extension can reduce host exposure without breaking the stated all-web companion goal. If not, document the unavoidable boundary and exclude protected origins explicitly where useful. |
| F-02 | Medium privacy/fingerprinting | `manifest.json` | `content/content.css` is web-accessible to every HTTP/S origin. Chrome documents that web-accessible resources can be fingerprinted or used to exploit extension vulnerabilities. | Manifest line 20; Chrome Web Accessible Resources documentation. | Test whether `use_dynamic_url: true` is supported at the minimum Chrome version and whether the CSS link can use the dynamic URL. If compatibility is uncertain, keep the resource but reduce exposed surface by matching only the actual injection scope (still broad if the companion remains all-web). |
| F-03 | High correctness | `background/service-worker.js` | `pendingBranches` is keyed only by destination URL. Two source tabs opening the same target URL within the 15-second window can overwrite or cross-attach pending relationships. | Lines 3–5, 124–129, 156–159. | Key pending branches by destination plus opener/source tab, with a deterministic URL-only fallback only when exactly one candidate exists. Add a two-opener collision fixture. |
| F-04 | Medium correctness | `background/service-worker.js` | Redirect pending state is keyed only by tab ID and can retain a relationship across an unrelated later navigation if the redirect chain expires or is not cleared on all terminal paths. | Lines 32–35, 160–167; no explicit clear on all navigation exits. | Bound each entry by tab, parent, and timestamp; clear on accepted final observation, rejected unrelated navigation, and tab removal. Add stale-chain fixtures. |
| F-05 | Medium correctness | `background/service-worker.js` | `GO_HOME` uses a stored origin tab ID without revalidating that the current tab still belongs to the session. The removal listener clears normal stale IDs, but a restart, storage restore, or tab-ID reuse can still make the reference stale. | Lines 234–237 and persisted origin shape in `shared/state.js`. | Validate the current tab with `chrome.tabs.get()` when available and compare its URL to the stored origin; otherwise fail closed and create only a safe stored HTTP(S) origin. Add mocked stale/reused-tab fixtures. |
| F-06 | Medium robustness | `background/service-worker.js` | Message listener assumes `message` is an object. A malformed or null runtime message can throw before the switch and return an error to the sender. | Line 220 reads `message.type` without a record guard. | Return null for non-record messages before dispatch. Add null, array, primitive, and oversized payload fixtures. |
| F-07 | Medium robustness | `background/service-worker.js` | `sender.tab` and nested fields are trusted in `START_MISSION` and tab-driven messages; numeric IDs are partly validated but origin metadata can be malformed. | Lines 219–227, `createSession` lines 90–96. | Validate sender/tab shape and normalize tab IDs/titles/URLs at the boundary; preserve the extension-page mission-start path. |
| F-08 | Medium correctness | `background/service-worker.js` | `pruneNode` and `compost` mark nodes closed but do not detach all aliases first. A historical tab alias can remain attached in state and affect later ownership decisions. | Lines 178–205; `nodeForTab` ignores `closedAt`, but old aliases remain in the closed node. | Detach active aliases or make closed nodes ineligible everywhere and add alias-after-care fixtures. |
| F-09 | Low/medium robustness | `background/service-worker.js` | `getSnapshot` trusts `includeHistory` truthiness and can expose the latest completed session to any extension page that asks; this is intended for dashboard UX but should be explicitly limited to extension contexts. | Lines 208–212, message line 221. | Verify no external messaging entry point exists; optionally add sender-context comments/guards without breaking the popup/dashboard. |
| F-10 | Medium DOM-hardening | `dashboard/app.js` | Multiple `innerHTML` sinks are protected by `esc()`, but the security proof is distributed and fragile. A future field added without escaping would become a DOM XSS regression. | Lines 25, 31, 34–41. | Prefer DOM construction for data-bearing fields or enforce Trusted Types only if compatible with the extension CSP and minimum Chrome version. Add an injection fixture containing quotes, tags, and SVG payloads. |
| F-11 | Medium isolation | `content/content.js` | The companion uses an open ShadowRoot. Page JavaScript can inspect and mutate the companion DOM, potentially spoofing status or controls, although it cannot access the isolated-world variables directly. | Lines 3–7; MDN documents that closed roots are inaccessible to outside JavaScript. | Evaluate closed ShadowRoot as a low-cost hardening option; test focus, CSS, and event behavior before adopting. |
| F-12 | Low/medium UX/reliability | `popup/app.js`, `settings/app.js`, `newtab/app.js` | Initial `sendMessage()` calls are not consistently guarded. A sleeping/reloading service worker or storage error can leave a blank or stale extension page. | Popup line 43, settings line 23, New Tab line 36. | Add bounded error fallback and retry copy without changing navigation semantics. Add mocked rejected-message fixtures. |
| F-13 | Low correctness | `shared/state.js` | `canonicalUrl()` has a permissive raw-string fallback and is exported, which makes accidental unsafe reuse easy even though current privileged navigation paths use `safeHttpUrl()`. | Lines 21–30. | Make the unsafe fallback private or return an explicit null/empty result for navigation callers; preserve only a separate display-safe compactor if needed. Add direct canonicalization tests. |

## Research comparison and decision notes

### Chrome isolated-world and messaging guidance

Chrome documents that content scripts run in an isolated world, but also states that content-script messages should be treated as less trustworthy and privileged actions should validate and limit message inputs. This supports keeping the service worker as the state authority while adding a record guard, sender/tab validation, and strict operation-specific schemas.

Source: [Chrome Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

Source: [Chrome Message Passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

### Web-accessible resources

Chrome documents that web-accessible resources are accessible to matching web pages and can enable extension fingerprinting or exploitation. The current CSS exposure is not an immediate code-execution defect because the resource is static, but it is a genuine surface-area and fingerprinting concern. `use_dynamic_url` is a possible mitigation only if the CSS reference and minimum Chrome version remain compatible; it must be tested rather than assumed.

Source: [Chrome Web Accessible Resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources)

### Shadow DOM

MDN documents that a closed ShadowRoot prevents outside JavaScript from accessing the root internals, while an open root permits access. This is a small, dependency-free hardening candidate, but it is not a security boundary against the extension’s own isolated-world bugs and must be regression-tested for focus and page compatibility.

Source: [MDN ShadowRoot mode](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot/mode)

### Permission minimization

Chrome’s permission guidance recommends optional permissions when functionality allows them. The all-web companion is a core requirement, so replacing broad host access with optional permission would change the product contract. The audit will therefore test narrower exclusions and document the remaining broad scope rather than weakening the core feature spec by assumption.

Source: [Chrome Declare Permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

Source: [Chrome Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

### Residual navigation and multi-window research

Chrome documents that tab IDs are unique within a browser session, that `openerTabId` is present only while the opener still exists, and that `tabs.get()` can retrieve the current tab record. It also documents that `tabs.update()` can navigate and activate a tab, while window focus is a separate concern. The remediation therefore revalidates the stored origin tab with `tabs.get()`, compares the current safe URL, and focuses the live origin window before activation. If the identity is stale, it opens a new safe origin tab instead of targeting a reused tab.

Source: [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)

The same research confirms that optional host permissions are the supported way to reduce access when functionality permits, but Focus Forest’s core companion contract is all-web HTTP(S) operation. This pass removes the redundant `tabs` permission, while retaining the broad host/content-script scope as an explicit product boundary rather than silently breaking the companion.

Source: [Chrome Declare Permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

Source: [Chrome Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

### DOM sink alternatives

Trusted Types can enforce that HTML sinks receive a policy-produced value, but the extension currently uses deterministic escaping and has a minimum Chrome version of 110. A broad Trusted Types CSP change could break existing extension-page rendering and is not automatically safer than replacing data-bearing `innerHTML` with DOM construction. The audit will compare both approaches and prefer the smallest dependency-free fix supported by the actual code and test environment.

Source: [MDN Trusted Types API](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)

## Implemented and verified in this pass

The following findings were confirmed with failing fixtures and then fixed: the redundant `tabs` permission was removed; null or non-object runtime messages are ignored safely; target-blank pending branches are keyed by source tab and destination; composted nodes detach all live tab aliases; Go Home navigates a same-tab journey back to the stored safe origin without closing tabs; sender tab IDs are normalized; synthetic page-dispatched clicks are ignored; the companion uses a closed ShadowRoot with inlined static CSS; and the unused web-accessible stylesheet/resource declaration was removed. The focused behavior suite, static security contracts, syntax checks, and the stress harness all pass.

The stress harness issued 500 concurrent observations, 300 concurrent settings updates, 200 null messages, and 200 array messages. The resulting state remained bounded at 96 nodes and 72 events, preserved threshold ordering, and contained only safe URLs.

## Residual findings and why they remain open

| ID | Status | Reason not changed in this pass |
|---|---|---|
| F-01 | Open/intentional | The companion’s stated product behavior is to operate on arbitrary HTTP(S) pages. Replacing required broad host access with optional permission or `activeTab` would change the core experience and add a user-activation flow. This needs a product decision and real Chrome permission testing, not an unreviewed security patch. |
| F-04 | Partially addressed/open | Pending redirect state remains session-backed and bounded, but a deeper redirect-chain matrix across SPA navigations and same-tab reloads still needs real Chrome verification before changing its semantics. |
| F-05 | Partially addressed | Stale origin removal is guarded and Go Home now returns the stored safe URL, but Chrome tab-ID reuse and browser restart behavior still require a real Chrome multi-window test. |
| F-09 | Open/intentional | Snapshot access is limited to extension contexts by the manifest; no external messaging entry point is declared. Additional sender-context checks could improve defense in depth but are not required to block an external web page under the current manifest. |
| F-10 | Mitigated by proof, not fully refactored | Dashboard data fields pass through the centralized escape function and external URLs are HTTP(S)-normalized before rendering. A full DOM-construction rewrite or Trusted Types policy would be a larger architectural change with no demonstrated exploit in the current code. |
| F-12 | Open/low severity | Extension pages generally catch storage/message failures where user-visible; the remaining initial-render catch coverage is UX hardening, not a confirmed security issue. |
| F-13 | Open/low severity | `canonicalUrl()` remains a general-purpose display canonicalizer with a raw fallback; privileged navigation boundaries use `safeHttpUrl()`. A future API split would improve naming but is not necessary for current safety. |

## Explicit exclusions

This pass did not add frameworks, third-party sanitizers, remote services, AI, telemetry, history/top-sites permissions, or broad architectural rewrites. It does not claim Chrome-process security certification or prove behavior that requires a real Chrome profile until that manual matrix is run.

## Phase 3 fixes applied after initial audit

The following issues identified in the initial security and performance review were fixed in a subsequent remediation pass:

- **Critical syntax error** in content/content.js (escapeHtml object literal) — the content script was completely broken due to ''' instead of ''. Fixed by correcting the single-quote mapping value.
- **Medium async mutation bug** in background/service-worker.js (onHistoryStateUpdated listener) — trackLink was not awaited inside the chrome.tabs.get callback, risking lost mutations on MV3 service worker termination. Fixed by switching to promise-based chrome.tabs.get and awaiting trackLink.
- **Medium performance issue** — appending with `shadow.innerHTML +=` in content/content.js caused full Shadow DOM re-parsing. Fixed by switching to insertAdjacentHTML('beforeend', ...).
- **Medium performance issue** — sheetCopy.innerHTML in content/content.js for dynamic choice-sheet content was replaced with DOM-safe replaceChildren() and append() using text nodes and elements.
- **Medium storage round-trip performance** — Every loadState() call re-read from chrome.storage.local and re-normalized the full state. Fixed by adding an in-memory state cache in shared/state.js with clearStateCache() on mutation failures.
- **Low unused import** — Removed unused canonicalUrl import from background/service-worker.js.
- **Low dead export** — Removed unused findNode export from shared/state.js.
- **Low unused import** — Removed unused logCritical import from background/service-worker.js.
- **Low security hardening** — Added sender identity validation (sender.id === chrome.runtime.id) in the message listener.
- **Cleanup** — Deleted obsolete test harnesses, test fixtures, and internal audit artifacts that were not part of the extension.

All modified files pass 
ode --check syntax validation. No innerHTML, document.write, or eval patterns remain in source files. All imports point to existing modules, and all chrome.* API calls use MV3-compatible signatures.

## Phase 4 fixes (follow-up remediation pass)

A follow-up pass re-verified the earlier claims and corrected several that were
overstated or incomplete. Each was confirmed with a failing fixture or a
demonstration before the fix.

- **High security — `escapeHtml` was a no-op (content/content.js).** The Phase 3
  note claimed the function had been fixed, but the entity map still mapped every
  character to itself (`<` -> `<`), so it provided zero XSS protection. The
  function was dead code (callers use `textContent`/`replaceChildren`, which are
  safe), but adopting it into an `innerHTML` sink would have been a live DOM-XSS
  vector. Corrected the map to real entities (`&amp;`, `&lt;`, `&gt;`, `&#39;`,
  `&quot;`).
- **High correctness — synchronous `new URL()` throw on malformed messages
  (background/service-worker.js).** `LINK_CLICK`, `OBSERVE_PAGE`, and the
  `webNavigation` listener parsed `message.url` / `details.url` with `new URL()`
  before the async error boundary was attached. `validateMessage()` only checked
  key presence, so a malformed-but-truthy URL threw synchronously and left
  `sendResponse` uncalled. Added `hostnameOf()` (try/catch-wrapped), `isSpaDomain()`,
  and `recentlyObservedSpa()` helpers; all three throw sites now use the safe
  helpers, and `LINK_CLICK` validates the URL with `safeHttpUrl()` before dispatch.
- **Medium security — `validateMessage` was presence-only (F-06/F-07 root cause).**
  Replaced the array-of-keys schema with a per-field type schema
  (string/boolean/object, optional `?` suffix) and explicit type checks. This is
  the root-cause fix for the malformed-URL throw class and rejects mistyped
  payloads (`paused: 'yes'`, `url: 123`) deterministically at the message boundary.
- **Medium security — `START_MISSION` trusted `message.tab` (F-07).** Added
  `sanitizeTab()` which coerces the sender/client tab descriptor into a minimal
  safe shape (integer ids, string url/title) and prefers the validated Chrome
  `sender.tab` over the client fallback.
- **Medium correctness — pruned nodes kept tab aliases (F-08).** `pruneNode` set
  `node.state = 'pruned'` but left `tabIds` attached; `nodeForTab` filtered only
  by `!node.closedAt`, so a pruned (non-closed) node could still win tab lookups
  by ordering luck. `nodeForTab` now excludes terminal states
  (`pruned`/`composted`), and `pruneNode` now detaches live aliases.
- **Medium correctness — `GO_HOME` placeholder origin (F-05).** When a mission was
  planted from the New Tab page and no real HTTP(S) origin was recorded,
  `origin.url` stayed `chrome://newtab`. GO_HOME would attempt to navigate a live
  tab to the placeholder (Chrome disallows this) and fall through to opening a new
  tab to the placeholder. Added `hasRealOrigin` so GO_HOME only navigates when a
  genuine HTTP(S) origin exists.
- **Low robustness — stale state cache (shared/state.js).** `stateCache` was only
  cleared on mutation failure. Registered a `chrome.storage.onChanged` listener
  that invalidates the cache for our key on external writes (self-writes made
  through `saveState()` are excluded via an in-flight flag so the cache stays
  effective within the mutation queue).
- **Low privacy — hardcoded Google redirect (newtab/app.js).** "Browse without a
  mission" redirected to `https://www.google.com`, contradicting the local-first
  posture. Replaced with a calm local status message; the user navigates
  themselves.
- **Hygiene — explicit extension-page CSP (manifest.json).** Added
  `content_security_policy.extension_pages` pinning `script-src 'self'` (MV3
  already enforces this by default; this makes the intent explicit and forbids
  `unsafe-eval`/remote scripts).
- **Hygiene — tests.** Expanded `test-state.mjs` from 5 to 11 tests, adding
  security-invariant cases (dangerous URL schemes rejected, tracking params
  stripped, `compactText` robustness) and `normalizeState` migration/bounds cases
  (legacy `tabId` migration, `javascript:` URL rejection during normalization, and
  LIMITS enforcement on sessions/nodes/events/compost).

### Residual items still open

- **F-01** (broad host permissions) — intentional product boundary; unchanged.
- **F-04** (redirect-chain matrix across SPA navigations and same-tab reloads) —
  still needs real Chrome verification.
- **F-09** (snapshot access limited to extension contexts) — no external
  messaging entry point exists; additional sender-context checks would be
  defense-in-depth only.
- **F-10** (dashboard DOM construction vs escaping) — dashboard already uses
  `textContent`/DOM construction for data-bearing fields; no `innerHTML` sinks
  remain in source. A full Trusted Types policy would be a larger architectural
  change with no demonstrated exploit.
- **F-12** (extension-page initial-render error fallback) — covered by the
  existing `renderSafely`/`initSafely` wrappers; remaining UX hardening only.
- **F-13** (`canonicalUrl` raw-string fallback) — privileged navigation paths use
  `safeHttpUrl()`; a future API split would improve naming only.
