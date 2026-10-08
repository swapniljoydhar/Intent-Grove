# Changelog

All notable Intent Grove changes are documented here.

## [Unreleased — 0.3.8]

### Changed

- Added an on-demand, local summary of branching, straight-through, search-refining, and revisiting paths across the last eight UTC weeks, with transparent counts and no personality or health claims.
- Added eight-week local charts for intentions started and average deepest navigation path, without inferring whether browsing served an intention.
- Rewrote the New Tab introduction and four tour captions in plain language to describe navigation distance and elapsed time as reflection signals—not a test, relevance judgment, or score. Clarified that only the optional personal note stays local while planting also sends the intention to the chosen search provider.
- Replaced test-only labels in the companion walkthrough capture with realistic example research pages, and made the Brave footer tip appear only when Brave identifies itself.
- Removed stale README/store wording that described the retired five-step sample demo as current; corrected control-character damage in code excerpts in the retained historical security review without changing its findings.
- Added regression checks for truthful tour copy, browser-specific footer guidance, and corrupted control characters in tracked text files.
- Rebranded the product from Focus Forest to **Intent Grove** in the manifest, user-facing surfaces, package metadata, artwork, and current documentation.
- Migrated the canonical browsing state and theme keys, companion root ID, bridge event, context-menu IDs, and session marker to the Intent Grove namespace. Legacy state and theme data migrate before cleanup; already-open tabs accept both bridge events, and old injection markers prevent duplicate companions during reload transitions.
- Added [EVIDENCE.md](EVIDENCE.md), which describes the limits of current digital self-regulation research, makes no efficacy claims for this extension, and sets explicit anti-shame and autonomy guardrails.
- Replaced the text-heavy first-run overlay and fictional click demo with a short, skippable four-screen walkthrough using real captures of the New Tab, companion reminder, garden tree, and Settings. Show the browser-owned Brave footer tip only in Brave.
- Added an optional per-mission “if I reach a reminder point, I plan to…” choice. It is local, defaults to deciding in the moment, and is repeated transparently in the reminder while leaving every action available.
- Updated user-facing strict-mode copy to “Use firmer reminders” and corrected dashboard wording so recorded paths are not described as inferred attention.
- Renamed the generated archive to `dist/intent-grove.zip`; updated current install, architecture, store, and contributor documentation. Historical audits remain dated records and are marked as such.
- Fixed the New Tab performance profiler's hidden-animation assertion to inspect actual running animation play states instead of comparing timing snapshots.
- Made Windows packaging independent of the optional PowerShell Archive module by using the built-in .NET ZIP API; the script also replaces only its generated archive instead of deleting the whole `dist/` directory.

## [Unreleased]

### Improved (user agency, clarity, and New Tab performance — 2026-10-01)

- Added an optional five-step fictional garden demo that taught path depth without saving anything or opening pages; the later first-run walkthrough replaces it with real product captures.
- Added one-tap Gentle, Balanced, and Accountable presets; preset selection previews changes without saving them.
- Added **Make this page my new mission** to the non-blocking choice card, preserving the previous garden when a useful detour becomes the new intention.
- Surface saved compost curiosities on the New Tab page, and explain that planting sends the mission text to the selected search provider.
- Reworded path depth, elapsed time, statistics, and completion reflection to describe recorded navigation facts without inferring relevance or attention. Recorded-day counts no longer grow just because an unattended mission spans multiple days.
- Kept optional Quiet discoveries bounded and locally randomized, but removed rarity tiers tied to path depth or presumed mission fit. No shame copy or punitive mechanism was added.
- Reduced persistent New Tab background work: removed two full-screen moving gradient layers and five continuously moving leaf particles, removed the large glow blur, switched the sun pulse to opacity-only, and consolidated three separately animated tree layers into one gentle canopy-and-branches sway. The tree and atmosphere pause when the page is hidden.
- Replaced the separate sprout wordmarks with a shared botanical icon across New Tab, popup, settings, and dashboard.
- Expanded browser tests for the demo and mission action; made extension test launchers accept `CHROMIUM_EXECUTABLE_PATH` and fixed Windows-safe file URL resolution.

### Changed (docs — README split for humans, 2026-09-22)

- **Doc set synced with the shipped product:** `SECURITY.md` gained the missing truth (chip-position `storage.session` design, `system.memory` permission scope, storage bounds, note-privacy, delete-all-includes-theme); `CHROMEWEBSTORE.md` store description now reflects Strict mode, drift facts, garden health, streaks, Quiet discoveries, the guardian, and the shortcuts, its privacy disclosure mentions the local memory reading, and its Version History was re-ordered chronologically and completed through 0.3.6 + the unreleased batch; `CONTRIBUTING.md` verification steps now name the full lane set; README links the previously orphaned September 2026 audit. Dated historical audits remain records of their stated period; their findings are not rewritten.

- **README rewritten user-first** (210 lines / 21 sections → ~105): plain-language intro, quick install, "How it works" bullets, a settings table, a short privacy list, the browser table + troubleshooting, roadmap, and dev commands. The engineering deep dive — annotated file tree, navigation semantics, Chromium/fork integration notes, permissions rationale, accessibility engineering, garden rendering, tab/history behavior, memory & performance design, security & reliability implementation, test-lane inventory, release engineering, and the v0.3.6 historical note — moved to the new **[ARCHITECTURE.md](ARCHITECTURE.md)** essentially verbatim: nothing was lost, and the v0.3.6 section is now deduplicated against the CHANGELOG. No lane scans markdown, so tests/CI are unaffected (verified by re-run).

### Fixed (windowless-install race — the CI F13 "No current window" trace)

- **Fresh installs could log an error trace on headless/windowless startup:** `onInstalled` opened a welcome tab with an unguarded `chrome.tabs.create` lacking a `windowId`; when the install event beat the browser's first window (the GitHub Actions startup race), Chromium rejected with "No current window" and the swallow boundary's storage-category trace tripped the feature suite's zero-error gate (F13). The handler now probes `windows.getLastFocused()` (no permission required): a resolved window is targeted explicitly, a definitive "none" skips the welcome tab quietly — the new-tab override greets the user anyway — and engines without the API keep the legacy best-effort create. `goHome()`'s fallback `tabs.create` received the same guard so a windowless "return" can never morph into an `INTERNAL_ERROR` envelope. Both branches regression-tested in units; F13 green in vivo.

### Improved (performance guardian v2 — real system memory, 2026-09-22)

- **Correction + upgrade:** an earlier claim that "Chromium has no free-RAM API for extensions" was wrong — `chrome.system.memory.getInfo()` is documented for extensions (Chrome 91+, `system.memory` permission) and is now empirically pinned by Gate 0 in real Chromium. The guardian prefers that real free-RAM signal (worker-cached with a ≤30 s TTL, refreshed from the active-view path and the existing 5-minute maintenance alarm — zero new timers), relays it to the companion via the active view (`systemMemory.freeRatio`), and falls back to the device-memory class and the context's own JS heap where the API is absent.
- **Release hysteresis (`nextPerfMode`):** pressure engages instantly; release requires signals clearly below thresholds (heap band 0.05, system band 0.03) so noisy near-threshold samples cannot flap decorations between refreshes.
- **Settings transparency:** a live-signals readout (free system GB, device class, own heap %) shows the exact numbers the guardian uses — rendered locally, never stored or sent.
- **Deliberately not adopted** from per-tab memory monitors (MemoryStats pattern, owner-provided for study): `scripting`-based per-tab `performance.memory` injection — it needs a new permission and wakes every frozen renderer (RAM/CPU-counterproductive; our content script already reads the same renderer heap for free because the companion lives in the page) — and `chrome.debugger` CDP probing (infobar + trust cost). Only `system.memory` was added; no identity/account APIs.

### Added (accountability & performance guardian — R2/R3, 2026-09-22)

- **Drift accounting (R2):** the choice card now states one more fact — how many pages and minutes you are from your mission — computed from existing local branch data (nodes at or beyond the quiet line, live duration). The worker sends only `{pages, seconds}` plus a `hasNote` boolean; the private note text itself never reaches a page context (unit-pinned).
- **Strict mode (R2, opt-in, default off):** more explicit chip copy ("Your chosen check-in point is here" / "You keep going deeper"), a choice-card line quoting the fact that you wrote down *why this mattered*, and stronger state accents on the companion. All four choices — including **Keep exploring** — are untouched; a `test-security.mjs` pin makes that agency guarantee contractual. Gentle copy stays neutral ("A moment to check in" / "This branch is getting long").
- **Garden health (R3):** `gardenHealth()` derives *lush / steady / sparse* purely from the local branch ratio — never a number, never a layout change; the dashboard treats the same deterministic SVG (saturation, glints, leaf opacity). Young gardens (≤2 pages) are never judged.
- **Quiet discoveries extension (R3):** low-drift mission completion earns a rare seasonal discovery (new `low_drift_completion` trigger + two catalog entries); every other ending keeps the ordinary bloom. Same cooldowns, caps, and opt-in setting.
- **Streak milestones (R3):** the worker exposes a milestone *key* (3/7/14/30 days) from the existing `currentStreak` stat; the dashboard words it, positive-only — a broken streak shows nothing and is never framed as a loss. No new storage.
- **Performance guardian (RAM):** new [`shared/ram-guard.js`](shared/ram-guard.js) (+ an inline companion mirror, since content scripts are classic scripts). Honest signals only — Chromium has no free-RAM API, so the guardian uses the `navigator.deviceMemory` class and the context's own JS-heap ratio, with a 1–5 sensitivity bar and a full opt-out. `body[data-perf="reduced"]` / `.perf-reduced` stops ambient layers, fireflies, growth rituals, discovery reveals, and living-garden animation while tracking, the chip, and the choice card always keep working. Pure-function matrix tested ([`test-ram-guard.mjs`](test-ram-guard.mjs)).
- **New Tab scene:** static time-of-day tint (dawn/day/dusk/night — computed once per load, zero animation cost) plus six dusk/night fireflies (transform/opacity only, 7 DOM nodes; profiler: 120/160 nodes, budgets green). Every existing kill-switch (Ambient motion, reduced-motion, hidden-tab) covers the new layers, and a guardian kill-list joins them.
- **Dark companion:** chip, choice card, and Forest Find follow the browser's `prefers-color-scheme` via CSS custom properties inside the closed shadow stylesheet.
- **`return-to-mission` command (Alt+M):** shares one validated go-home flow with the `GO_HOME` message (extracted into `validatedReturnTarget` / `activateValidatedOrigin` / `goHome`, each ≤25 lines; pinned via the command harness).
- **Settings:** Strict-mode toggle, Performance-guardian toggle + sensitivity slider with honest help copy; the rewards toggle copy no longer promises "never streaks". Popup gains a truthful worker-error state with **Try again**, and its completion reflection adds the drift fact line.

### Fixed (performance — the Phase 4 production-breaker)

- **Title-churn throttle:** a page rewriting its `<title>` continuously (video progress, timers, live dashboards) previously fired two worker messages per change with no time bound — spending the tab's 300/min budget and keeping the worker writing title updates all day. Same-URL title-only changes now coalesce to at most one send per 5 s (trailing edge preserved, so the final title always lands); URL-change semantics are untouched. Pinned in vivo by Gate 7 (8 rapid mutations → one node, final title, no flood) and by a `test-security.mjs` regex pin.

### Hardened (companion privacy — Phase-1 audit finding F2)

- **Chip position left the page's storage:** the draggable companion's remembered position moved from the host page's `sessionStorage` — readable by any script on the site — to service-worker-held `chrome.storage.session`, keyed by the validated sender tab and origin (never by payload-supplied identity), serialized, bounded (`LRU_CACHE_SIZE`, oldest evicted), and cleared on tab close and browser exit. Drag and keyboard-move behavior is unchanged; keyboard auto-repeat now rides a 250 ms trailing debounce so saves never crowd the per-tab message budget, and a best-effort `pagehide` flush covers navigating away inside that debounce window. Forks without `storage.session` degrade to worker memory, never to page storage. Covered by worker unit assertions (round-trip, tab/origin isolation, tab-close cleanup, bound, fallback), adversarial-input tests, and a new real-Chromium gate that drags the chip, reloads, verifies the restored position, and asserts `sessionStorage.getItem('ff-chip-pos') === null` throughout.

### Fixed (Phase 1/2 structural audit — 2026-09-22)

- **Invalid `"windows"` manifest permission removed:** the `chrome.windows` API requires no permission (official API reference); the unrecognized entry only invited a load warning in `chrome://extensions` and store-review noise. `windows.update` (Go Home) is unchanged in behavior — re-proven by the unit mocks and the real-Chromium lanes.
- **"Clear local data" now clears everything:** the dashboard's theme preference lived in extension-origin `localStorage` and survived `CLEAR_DATA` while every other setting reset. A new `clearStoredTheme()` (in `shared/theme.js`) runs as part of the clear-data confirmation — only after the wipe itself succeeds — so no preference outlives an explicit local data wipe.
- **Popup and New Tab surface worker errors instead of masking them:** both pages' `message()` helpers now inspect the service worker's `{error}` envelope (matching the settings page). A failed `END_MISSION` no longer closes the completion ritual as if it had succeeded, a failed planting no longer clears the user's typed input or announces "Intention planted!", and internal errors are logged locally instead of silently rendering empty or success states.

### Improved (garden upgrade — the dashboard, whole tree to whole branch)

- **Focus-trail mode:** selecting a leaf now dims every branch and leaf off the traced path while the ancestry stays lit — the eye follows one path home through the crown instead of scanning the whole tree. Hovering any leaf previews its ancestry as a softer gold thread *before* you commit to selecting it (pure class toggling on edge data, never touching the selection layer).
- **Leaves fill the crown:** normalized leaf placement widened from the middle third (`LEAF_SPREAD_MIN/MAX`) so a grown garden reads as a forest of pages, not a central clump — geometry constraints (inside-crown bound, hit-area margins, spacing stress) all still pass.
- **Living garden:** new leaves sprout into a live-refreshing garden (one-shot opacity + leaf-scale pop, never disturbing node positions); a slow breeze sways a few leaves out of phase; mature canopies (canopy/deep stages) drift a few pollen motes; stage changes (seed → sapling → canopy → deep) crossfade once. Every animation is transform/opacity-only and inherits all existing kill-switches (`prefers-reduced-motion`, `body[data-motion="off"]`, hidden-tab pause).
- **Branch detail panel:** the selected path now shows its bare address plus a safe "Visit this page ↗" link (property-assigned href, `noopener noreferrer`), next to depth/confidence/state, parentage, why-it-was-recognized, and time spent.
- **Keyboard traversal:** arrow keys walk the leaves in arrival order across the whole garden (Enter/Space selection unchanged), so the tree is fully navigable without a pointer.
- **Trail notes:** each note's timestamp line gains a relative age ("· 12m ago") beside the clock time.
- **Weather cue tinting:** the header cue dot follows the garden's mood (soft / fern / dusk / resting).
- **Charts:** weekly bars and domain slices carry native tooltips ("Mon (2026-09-21): 42 minutes", "example.com: 7 pages"), and today's bar wears a quiet outline.
- Tab switches settle with one short fade (disabled with ambient motion).

### Fixed (garden-upgrade re-audit — CSS cascade correctness)

- **Focus-trail dimming never painted on branches for users with ambient motion ON:** `branchPulse` (an infinite keyframe animation on every branch-layer edge) outranks normal `opacity` declarations in the CSS cascade, so the `.12` dim was silently overridden — off-trail branches kept pulsing at full strength while a leaf was selected. Only *nodes* dimmed, because nodes carry no animation. The dim rule now stops the pulse on off-trail edges (`animation: none`); on-trail edges keep their gentle pulse. Every pre-existing dashboard gate runs under `prefers-reduced-motion`, where the global animation kill-switch masks this class of bug; the new Gate 28 runs with motion ON to pin it down in vivo.
- **Hover trail preview lost to the selection dim:** the dim rule (specificity 0,5,0) beat the preview rule (0,3,0), so previewing another leaf's ancestry while a selection was active showed the gold thread at 12% opacity — invisible exactly when the garden is dimmed. The dim now excludes `.trail-preview`, and the preview stops the pulse so the thread reads steady.
- **Sprout entrance could permanently exempt a new leaf from the selection dim:** `sproutIn`'s `both` fill-mode retained `opacity: 1` after the entrance (retained animation values outrank normal declarations), leaving an off-trail freshly-sprouted leaf glowing at full opacity until some unrelated re-render. The fill-mode is removed: the entrance plays identically, then the declared style (dim or normal) takes over — proven with computed-style checks mid-entrance and after.
- **Arrow-key traversal skipped the first leaf:** entering a garden with no leaf focused, ArrowRight/Down landed on `leaves[1]` (`Math.max(index, 0) + delta` with `index = -1`). It now enters at the first leaf for Right/Down and the last leaf for Left/Up.

### Fixed (phase 4 — feature-by-feature verification in the real browser)

- **Export → Import round-trip was broken:** the dashboard writes the bare state object to the export file, but `importAllData` demanded a `{ data: … }` envelope — re-importing the extension's own export failed with `invalid_payload` ("Import could not be read"). The worker now accepts the bare file, the envelope, and legacy `{ state }` nesting; bare (user-picked) payloads must still contain a recognizable collection, so a wrong file fails honestly. Mock tests never caught this because they always fed the envelope. (`test-features-e2e.mjs` F11 + A17)
- **Composting or pruning the page you're on orphaned the tab for the rest of the mission:** both detached the tab from its node, and the unlinked-tab guard then treated the tab as a stranger forever — the mission kept running but nothing was tracked again. Tabs that participated in the session (the replanted origin tab, or any tab with a still-open foreground interval) now re-enter as neutral external paths, exactly like typed navigation. Never-activated tabs remain excluded, and closing a tab ends its participation so recycled tab ids inherit nothing. (F7 + A16, both in vivo and mock)
- **Cross-context chip sync could drop updates:** the freshness gate discarded a storage sync that arrived within 600 ms of a navigation refresh — but that refresh predated the change, so a fast compost or settings save never reached the page until the next navigation. The gate now defers (re-arms itself) instead of discarding. (F6/F10 in vivo)
- **Foreground-time accounting:** a closed tab's interval stayed open and kept accruing "Foreground Tab Time" until session end; a browser restart left every interval open, accruing phantom time across the restart (and letting recycled tab ids inherit stale participation). `tabs.onRemoved` now ends the removed tab's interval and `onStartup` closes all open intervals before recording the current active tabs.
- **Context-menu mission naming hardened:** the title fallback could adopt an unsafe page URL (`javascript:…`) as mission text; only valid http(s) URLs (or the neutral "New Tab" label) are used now — for both the context menu and Alt+F.

### Added (phase 4)

- **`test-features-e2e.mjs` — the feature walk (13 gates, real loaded extension):** onboarding overlay + focus handoff; resume/browse button visibility (the `[hidden]` CSS fix in vivo, both directions); full badge lifecycle (empty → green 🌱 → gold ⏸ → warm at depth → cleared); companion depth copy at every threshold + choice card; chip minimize/pause/resume controls through the closed shadow root (CDP-pierced trusted clicks); compost from the card (item + node state + reward + toast + chip rest); post-compost continuity; Go Home from the popup (origin tab activated without reload, no spurious new tab, return reward); Pause Site from the chip; settings save round-trip + reset-to-defaults + exclusion clearing reaching an idle page; the full dashboard walk (tree, picker → branch detail, trail notes, compost panel, stats, theme toggle + persistence, export download → parse → clear → re-import → forget garden); popup empty-state footer, form plant, completion ritual with reflection copy, and end. Wired into CI + `npm run test:features` / `test:all`.
- **`test-worker-inputs.mjs` (9 tests):** the two worker input surfaces that no harness had ever exercised — `chrome.commands.onCommand` (Alt+F start/name-fallback/toggle-end/no-tab) and `chrome.contextMenus.onClicked` (start from link/selection/page with navigate-only-when-needed semantics, compost link-vs-page, end, unknown items, unsafe-URL sanitization).

### Fixed (phase 3 — found by the new real-extension test lane)

- **Every new tab was double-loaded, and the reload could cancel your next navigation:** the new-tab takeover acted on transient placeholder URLs (`pendingUrl`, then loading-phase `tab.url`) even while our own `chrome_url_overrides` was already resolving the tab to the planting page. The redundant `tabs.update` aborted the override's own load and raced whatever happened next — proven in a real browser to cancel the post-plant search navigation. Takeover now happens at exactly one deterministic point: `tabs.onUpdated` with `status === 'complete'` and a committed browser-NTP URL. The `onCreated` takeover listener was removed (it can only ever see uncommitted URLs).
- **SPA routes were mislabeled as unlinked depth-0 paths:** Chromium fires the identical `onUpdated` loading→complete signature for same-document `pushState`/`replaceState` as for real navigations (and `onCommitted` never fires for them), so `observeTab` raced — and usually beat — the SPA paths, recording every route as an external `manual` node detached from its parent. `onUpdated` now requires a matching `webNavigation.onCommitted` record before observing; same-document route changes are owned by the SPA paths (`onHistoryStateUpdated`, the bridge's `SPA_NAVIGATION`, the polling watch).
- **Every commit is observed twice in production** (the new document's `OBSERVE_PAGE` and the worker's `tabs.onUpdated`) — the navigation hint is consumed by whichever arrives first, so the twin stamped spurious `reload`/duplicate events on link clicks, reloads, back/forward, origin replants, and known-page reuse (pre-fix production recorded up to two spurious events per link click). Same-URL classification is now order- and timing-independent: `trackLink` leaves commit-verified tracked-nav marks (`new-node` suppresses, `self-link` restores exactly one genuine reload), and per-tab commit memos make the hint-less twin of any classified commit a no-op. No fixed time windows are involved.
- **The rate limiter clipped the hero use case:** ~3 companion messages per tracked navigation meant a fast research session (~34 navigations/min) exhausted the 100/min per-tab budget — the chip vanished mid-mission (a null `GET_ACTIVE_VIEW` was indistinguishable from "no session") and branches stopped tracking. Budget corrected to 300/min, first-party extension pages are exempt entirely, and limited content senders now receive a distinguishable `{ rateLimited: true }` — the companion keeps its last known view instead of hiding. `pageshow` refreshes now fire only on bfcache restores (one less message per navigation). Verified in vivo: 40 navigations in ~7.5s (≈320/min) → 40/40 tracked, chip alive.

### Added (phase 3)

- **`test-extension-load.mjs` — the real-extension lane the audit kept demanding:** loads the actual manifest in Chromium (new headless, `--load-extension`), with a service worker, real content-script worlds, and only the open web mocked (local HTTP server + one routed engine stub). Nine gates: manifest/SW registration, real-new-tab override resolution, companion + MAIN-world bridge injection, link/reload/self-link event semantics in vivo, bridge-delivered `pushState` tracking with hostile-synthetic-event immunity, choice card at depth (closed shadow asserted via CDP pierce) + `OPEN_PLANTING_PAGE` really navigating, cross-context chip sync via `storage.onChanged`, and the sustained-pace rate budget. Wired into CI and `npm run test:extension` / `test:all`. The suite documents the Chromium/new-headless navigation quirks it had to design around (routed cross-origin commits and re-crossed ext→http tabs abort sporadically) in a role protocol at the top of the file.
- Mock-level regressions for all of the above: `test-audit-fixes.mjs` A14 (twin-observed replant/reuse), A15 (commit-record gating), A13 (rate-limit contract), A2/A10 rewritten for dual-observation semantics; the pinned rate-limit test in `test-service-worker.mjs` now asserts the corrected budget and the `{rateLimited:true}` signal.

### Fixed (secondary QA pass over the 2026-09-21 audit fixes)

- **Phantom focus time for repaired imports:** clearing an inverted `endedAt` to `null` (import validation) made `getDashboardStats` treat completed sessions as still running (`endedAt || now`), inflating Total Session Time and the Recent Sessions table by the session's full age (a 90-day-old import showed 7,776,000 s). Completed sessions without a usable `endedAt` now count as zero-length; genuinely active sessions still accrue to the present. The pre-existing future-skew repair path shared the hazard and is covered by the same rule. (`test-audit-fixes.mjs` A11)
- **Self-link reloads lost their trail note:** suppressing the spurious `reload` event for `link`-hint observations also silenced the genuine case — clicking a link to the page the tab already shows. `trackLink` now leaves a short-lived (15 s, commit-verified, per-tab, size-capped) self-link mark that `observeTab` consumes after the browser actually commits, recording exactly one `reload`. Marks never survive tab close, Forget Site, or Clear Data, and new-tab/SPA clicks are never marked. (A10)
- **Storage-sync refreshes ran on hidden tabs:** the new cross-context sync listener now skips background tabs entirely (`document.hidden` gate) — nobody can see the chip there, the `visibilitychange` handler already refreshes on reveal, and busy multi-tab sessions stay well inside the worker's message rate budget. (A12 sentinel)
- **`START_MISSION` could fail on bookkeeping:** `createSession`'s follow-up `recordActiveTab` write shared the user-facing promise chain; a storage hiccup between the session write and the interval write would reject the whole response even though the mission was planted. The bookkeeping failure is now logged and isolated. (A12 sentinel)
- **SPA bridge crashed on frozen History:** pages that freeze or redefine `History` methods made the MAIN-world bridge throw under `'use strict'`. The patch is now guarded; such pages fall back to `webNavigation.onHistoryStateUpdated` and the companion's polling watch. (A12 sentinel)
- README file structure and SPA wording updated for `content/spa-bridge.js`.

### Fixed

- **Critical — storage read failures could wipe the local forest:** `loadState()` resolves to an empty state when `chrome.storage.local.get` transiently fails; any mutation that ran against that fallback then persisted it, silently destroying every stored garden, setting, and compost item. Write paths (the worker mutation queue and quota compaction) now use a new strict `loadStateForWrite()` that aborts the mutation and surfaces `INTERNAL_ERROR` instead; read-only UI consumers keep the gentle empty-state fallback. Covered by `test-audit-fixes.mjs` (A1).
- **"Start a new mission" on the choice card never navigated:** the content script set `window.location.href` to a `chrome-extension://` URL, but Chrome blocks web-origin navigation to extension resources that are not `web_accessible_resources` — a list this extension deliberately keeps empty. The action now ends the mission and asks the worker (an extension context) to navigate the sender tab to the planting page via the new `OPEN_PLANTING_PAGE` message. (A4, A9)
- **Every ordinary link click was double-recorded as a "reload":** after `LINK_CLICK` grew the branch, the follow-up `tabs.onUpdated` observation matched the same URL and stamped a spurious `reload` event — trail noise, wrongly doubled eviction pressure on the 72-event cap, and misleading dashboard notes. Genuine reloads and back/forward returns are still recorded. (A2)
- **`search_refinement` events were mutated into the shared cache but returned `NO_CHANGE`,** so they were never persisted: visible in reads, then lost on a worker restart or smuggled into a later unrelated write. They are now durably saved like every other event. (A3)
- **The companion went stale on idle pages:** missions planted from the popup, ended from the New Tab page, or re-tuned in Settings never reached already-open pages until the next navigation. The content script now watches `chrome.storage.onChanged` (debounced, with a freshness gate so active browsing stays well inside the worker rate limit) and refreshes its view.
- **`history.pushState`/`replaceState` interception was inert in production:** content scripts run in the isolated world, where the patch cannot see page-initiated calls (the Playwright harness imports the module into the main world, so tests passed while production relied solely on the worker's `webNavigation.onHistoryStateUpdated` and the 2.5 s poll). A tiny MAIN-world bridge (`content/spa-bridge.js`, manifest `world: "MAIN"`, `document_start`) now re-announces history writes as a payload-less DOM event the isolated script listens for; the chip updates immediately on SPA route changes. `minimum_chrome_version` raised 110 → 111 for main-world content script support. (A9)
- **Popup footer and New Tab resume button ignored `hidden`:** author rules (`footer{display:flex}`, `.action-btn{display:flex}`) override the UA sheet's `[hidden]{display:none}`, so the popup's "Let this garden rest" footer showed in the empty state and during the completion dialog, and "Continue Session" showed with no active session. Both stylesheets now carry the dashboard's `[hidden]{display:none!important}` guard. (A8)
- **Context-menu re-registration could throw unhandled promise rejections:** MV3 `create()` returns promises and rejects on duplicate ids; the fire-and-forget calls also skipped the remaining menus when the first threw. Registration now removes all menus first and awaits each create inside the existing error boundary. (A5)
- **Popup crashed to its error state on a legal null snapshot** (rate limit / worker restart): `render()` now normalizes null like the dashboard already did; the dashboard's "Forget selected site" got the same null guard.
- **Imports accepted sessions ending before they started:** `endedAt < startedAt` is now cleared during import validation instead of only rejecting absurd five-year-past values. (A6)
- **`isSearchUrl` misread the Brave marketing site as a search engine:** the root-path special case is now scoped to `search.brave.com`, so `www.brave.com/` visits grow normal branches. (A7)
- `dashboard/tree-renderer.js` renders recent-node buds from a dedicated `TREE_LAYOUT.RECENT_NODE_WINDOW_MS` constant instead of borrowing `SERVICE_WORKER.RATE_LIMIT_WINDOW_MS`, decoupling a visual choice from an unrelated messaging limit.
- `shared/state.js` documents which loader is safe for write paths, and `test-audit-fixes.mjs` (wired into `npm test` and `npm run test:audit`) pins every fix above.
- Fixed Forget Site freezing the active session tree when the forgotten host was the mission origin: the origin now resets to the New Tab placeholder and the next ordinary page plants a fresh root instead of overwriting surviving nodes. Sessions already frozen by the old behavior are healed automatically on load.
- Fixed the first-step search fallback for the "Browser default" engine silently routing missions to Google when the Search API is unavailable; the last-resort fallback is now DuckDuckGo, as README privacy notes require.
- Fixed the dashboard never counting or showing choice-sheet dismissals: dismissing via "Keep exploring" or Escape now records an event, surfaced as the "Prompts Declined" stat.
- Fixed tab-close cleanup leaving per-tab navigation hints, SPA dedupe entries, and pending branches in memory until TTL eviction.
- Fixed the origin growth ritual being able to replay when a second depth-0 load arrived mid-animation.
- Fixed the companion chip restoring a saved position that can fall outside the current viewport.
- Fixed the popup depth meter never rendering 0%, and unified "branches" wording between the chip and popup.
- Fixed the dashboard session ordering comparator mixing different rows' timestamps.
- Removed the never-read `interventionsPaused` setting and the fabricated `depth` field on compost entries.

### Security

- Tightened the extension-page Content Security Policy: removed `style-src 'unsafe-inline'` (all dynamic styling is CSSOM-only).

### Improved

- The dashboard's dark/light theme choice is now respected by the popup, settings, and New Tab pages.

### Removed (dead-code cleanup — 2026-09-21)

Whole-repository dead-code pass. Every item was proven to have zero consumers (runtime, tests, scripts, HTML) by a symbol-usage sweep before removal; the full suite was re-run after (record: `AUDIT_2026-09-21.md`, Phase 5).

- **Files:** six superseded working docs (`AUDIT_2026-09-17.md`, `AUDIT_2026-09-20.md`, `COMPREHENSIVE_ANALYSIS.md`, `ENHANCEMENT_SUMMARY.md`, `IMPROVEMENTS.md`, `REFACTORING_PLAN.md`), the unreferenced `icons/focus-forest-logo.svg`, and orphaned `test-tree-stress.mjs` (never executed by `npm test` or CI; its coverage — cyclic repair, wide/deep shapes, `branchWidth` bounds — lives in `test-tree-layout.mjs` at product scale). All remain in git history.
- **Service worker:** dead `CLEAR_ALL_DATA` alias (zero senders anywhere; `CLEAR_DATA` is the live path) and the `CHECK_STORAGE_QUOTA` message case (zero senders; the `checkStorageQuota()` function itself stays — install-time quota check and the compaction alarm use it — re-add the message surface together with a UI if the proposed "Forest footprint" settings row is built). Also two never-read dashboard-stat counters (`interruptionsAccepted`, `returnToMission`), legacy singular `node.tabId` vestiges (normalization migrates every node to `tabIds`), and the never-read `startedAt` field on `activeTabs` entries.
- **Dead CSS generations** of two retired tree renderers and the old static New Tab sapling: `dashboard/style.css` lost ~35 rules (filled `.branch-taper` styles referencing nonexistent `#branch-grad`/`#bark-grad` gradients; `.junction-mark`/`.terminal-leaf`/`.root-seed`/`.root-bud`/`.empty-sprig`/`.empty-leaf`/`.tree-shoot`/`.tree-root-flare`/`.sapling-bole`/`.leaf-layer`/`.tree-ground`/`.empty-ground`/`.empty-root`/`.empty-tree`/`.tree-leaf-bud`/`.root-base`/`.root-sprout` classes the storybook renderer never emits; `.node*` state, `.tree-bole`, `.branch-layer`, `.highlight-layer`, `.node-label`, `.empty-trunk` and `.leaf-shape` rules always outranked by `tree.css`'s `.forest-scene`-scoped equivalents; a superseded `[data-tree-mode]` sizing block; unreferenced `grow-branch`/`arrive-node` keyframes; six unused dark-theme custom properties; stale `.green`/`.ochre`/`.clay` legend swatches). `newtab/style.css` lost the old hero-animation suite (`.sapling-growth/-trunk/-branch`, `.branch-left/right/sub-*`, `.leaf-cluster*`, `.leaf-large`, `.leaf-shape`, `.ground-line`, `.ground-shadow`, their exclusive keyframes, `--radius-sm`, and the matching motion-off list entries).
- **Companion shadow CSS:** `.choice.primary` rules — no choice ever renders with a `primary` variant.
- **Layout module API surface:** `layoutTree()` no longer emits fields nothing reads (`parentAnchors`, `children`, `labels`, `maxDepth`; internal computation unchanged, `maxDepth` still drives stage selection); `labelPlacement()` narrowed to its consumed contract (`{x, y}`); `test-tree-layout.mjs` re-pinned to the live contract (stale-depth ancestry now proven via a `parentById` chain walk).
- **De-exported module internals** (exported but imported nowhere): `REWARD_LIMITS`, `REWARD_TRIGGER_NOTES` (`shared/state.js`), `ERROR_SEVERITY` (`shared/error-tracing.js`), `THEME_STORAGE_KEY` (`shared/theme.js`).
- **Preview server:** asset allowlist trimmed to the actual fetched module graph (dropped `shared/state.js`, `shared/error-tracing.js`, `shared/chromium-api.js`; nothing in the tree-renderer import chain loads them).
- **.gitignore:** trimmed to the Node/extension-relevant set (dropped Python/Java/Gradle/Rust/binary-archive entries and duplicate swap-file lines; added `test-results/`, `playwright-report/`, `profile-newtab.json`).

### Fixed (found during the cleanup pass)

- **New Tab character counter had a broken `aria-describedby`:** `#mission-input` described itself with `input-hint char-count`, but no element carried the `char-count` id — screen readers silently skipped the counter. The counter container now carries it.

## [0.3.6] — 2026-09-18

### Improved

- Made Quiet discoveries appear as a compact tier-aware discovery reveal with a small one-shot entrance motion, instead of a plain text toast.
- Added distinct but restrained visual treatment for seeds, blooms, and seasonal discoveries while keeping the page usable and unobscured.
- Preserved reduced-motion behavior and the existing offline, cooldown, and per-session reward limits.

## [0.3.5] — 2026-09-18

### Added

- Added a short, rotating reflection prompt to the existing choice card so users can examine a detour without being graded, blocked, or rushed.

### Improved

- Tuned the New Tab atmosphere with slower, more organic mist and sun motion, paint containment for blurred layers, and the existing reduced-motion and hidden-tab pauses intact.
- Kept the intervention bounded to one prompt per observed URL and three offline strings, with no new timers, network calls, or stored data.

## [0.3.4] — 2026-09-17

### Fixed

- Fixed opt-in Quiet discoveries so reward history survives normalization and reloads while storing only a reward ID and timestamp locally.
- Fixed reward cooldown accounting and awaited reward persistence for composting, mission completion, and returning to the mission root.
- Added non-blocking reward feedback to the companion and New Tab status area without changing the extension’s passive browsing model.
- Fixed storage-pressure compaction so it no longer calls a service-worker-only mutation helper or overwrites a concurrent save.

### Cleanup

- Removed unused tree node and DOM pooling scaffolding that was not connected to the renderer.
- Added regression coverage for bounded reward history, minimal local records, cooldowns, and deterministic catalog selection.

## [0.3.3] — 2026-09-16

### Added

- Added a subtle animated atmospheric background to the New Tab planting page using CSS-only drifting light fields.
- Added reduced-motion handling for both browser preferences and the extension’s **Ambient motion** setting.
- Added a reusable New Tab performance and memory profiler for the built extension package.
- Added CI checks for 50 rapid SPA `history.pushState` transitions, heap growth, long tasks, layout work, style recalculation, and DOM-size regressions.

### Reliability

- Verified that rapid SPA route changes remain distinct and are delivered without runaway memory growth.
- Preserved existing `pushState`, `replaceState`, `popstate`, Back/Forward, and title-only route handling.
- Kept the local-first data model and existing extension behavior unchanged outside the requested visual and verification improvements.

### Verification

- Full unit, service-worker, state, security, stress, and browser suites pass.
- The built extension archive passes ZIP integrity validation.
- `npm audit --omit=optional --audit-level=moderate` reports zero vulnerabilities.
- The extracted package profile reports 103 DOM nodes, no long tasks, zero layout operations during the profile interval, approximately 20 ms of style recalculation over five seconds, and approximately 10 MB JavaScript heap usage in headless Chromium.

## [0.3.2] — 2026-09-15

- Removed the unintended settings sync mirror so session, settings, and compost data remain local-only.
- Corrected browser compatibility documentation.

## [0.3.1] — 2026-09-15

- Fixed recent-bud rendering, title-only SPA updates, rapid History API route snapshots, Back/Forward tracking, and persistent MV3 quota scheduling.

## [0.3.0] — 2026-09-14

- Added browser-default search through Chromium’s Search API, stronger SPA route serialization, richer storybook tree details, site-level pause controls, release CI, and reproducible packaging.
