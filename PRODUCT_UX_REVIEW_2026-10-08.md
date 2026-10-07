# Intent Grove: Product and UX Review

**Review date:** 2026-10-08  
**Scope:** the selected `swapniljoydhar/focus-forest` repository, whose current product name is Intent Grove. The review covered the extension manifest and runtime, every main user surface, shared state and privacy boundaries, all current onboarding captures and icons, project scripts and CI, tests, and user-facing documentation. At the start of the review, the repository had 73 tracked files.

## Executive summary

Intent Grove is a **non-blocking browsing self-reflection aid**. The user writes down an intention, browses normally, and can receive a gentle check-in when the recorded navigation path reaches a threshold they chose. A local garden then visualizes the path. The person—not the extension—decides whether a detour was useful or whether their route served the intention.

The key product distinction is important: **the extension measures navigation distance and elapsed-time estimates; it does not measure “how far you moved from your intention.”** It cannot understand a page’s meaning or relevance, and it cannot tell whether the person was reading or paying attention. Calling this a *psychological test*, a relevance detector, or a diagnostic would promise something the implementation does not do. A more accurate description is *a private browsing journal with user-controlled reflection prompts*.

The implementation is unusually transparent for this kind of tool: there is no server, account, analytics, generative AI, or page-content classifier; the extension keeps navigation records locally, and every reminder leaves the page and every choice available. The largest confirmed UX problems were stale “five-step sample demo” documentation, a walkthrough screenshot showing developer/test labels, and Brave-only footer instructions shown in other browsers. These have been corrected in the current change.

## What the extension does

1. **The person sets a flexible intention** on the New Tab page. The app’s data model and several surfaces call a session a “mission.” An optional personal note and a preferred response plan can accompany it.
2. **Starting the session opens a first search step.** The intention is sent as a query to the browser’s selected search provider. The optional personal note is stored locally and is not sent to the provider or a website.
3. **The content companion records navigation signals** on eligible HTTP(S) pages: page URLs and titles and observable link, tab, redirect, or single-page-app route transitions. It builds a tree where depth represents recorded navigation distance from the session’s start. Where a relationship is uncertain, it can represent the page as unlinked rather than inventing a known relationship.
4. **The user chooses when check-ins appear.** At the configured depth, the page may settle visually and a small companion can show a choice card. The card does not block, redirect, close, or hide pages. Its actions include continuing, returning, saving a page for later, or starting a new intention. Opt-in firmer wording does not remove any action.
5. **The dashboard turns recorded paths into a garden.** A leaf represents a recorded page. Selecting it can trace its route; the tree’s size and shape are visualization, not a productivity score or a judgement of the page’s value.
6. **Settings provide control and an exit.** People can alter thresholds and motion, pause the companion on named sites, choose a search provider, opt into optional notes, export their data, or delete local data.

## What is—and is not—being measured

| Signal or behavior | What it means | What it cannot establish |
|---|---|---|
| Branch/path depth | Recorded navigation distance from the starting point | Whether the route is relevant, useful, intentional, or a “mistake” |
| Page URL and title | A local record used to associate and display visited pages | The contents of the page or the person’s reasons for visiting it |
| Elapsed time | Time between session start/end and selected-tab intervals | Reading, comprehension, typing, attention, or continuous active work; background/idle time can affect estimates |
| A reminder threshold | A point the user selected for a non-blocking prompt | A scientifically validated threshold, diagnosis, or objective measure of intention alignment |
| A tree or milestone | A retrospective visualization or explicitly recorded activity milestone | A grade, streak penalty, clinical outcome, or proof of effectiveness |

**User-facing language should keep this boundary visible.** A person may *feel* that a path diverged from their intention, but the extension must not claim to infer that. The most honest loop is: *state an intention → notice a recorded path → reflect for yourself → choose what to do next*.

## Where it may be useful

- **Open-ended research:** compare products, schools, courses, or travel ideas while retaining a record of which sources led to other sources.
- **Studying and reading:** make an optional starting intention visible and notice when a research trail has become long, without forcing a return.
- **Personal browsing reflection:** learn what a typical browsing session looks like and decide, in one’s own terms, whether it felt aligned.
- **Saving side interests:** keep an appealing page for later rather than treating curiosity as failure or losing the original path.
- **Anyone who prefers gentle prompts over blockers:** the person remains in control throughout.

These are potential use cases, not demonstrated health or productivity outcomes. The project’s own evidence notes and README appropriately avoid treatment or efficacy claims.

## Confirmed problems found and corrections made

### 1. The onboarding description was out of date

The README said the current product had a “five-step sample demo” where people could try the tree and choice card. The live onboarding is instead a **four-screen walkthrough** made from screenshots of the New Tab, reminder, Garden, and Settings surfaces. The walkthrough does not create a practice browsing session. README and store copy now describe the current tour, its purpose, its limits, and its replay entry in Settings; shipped work was removed from the README’s remaining-work list.

### 2. A screenshot exposed test fixture text

The reminder screenshot showed a test mission (“Depth copy probe”), a generic “Page 3” title, and labels such as “next4” and “self3”. These were artifacts of a real-browser fixture, not presentable sample content. The fixture now uses a plausible computer-science-program research intention, meaningful page titles, and readable link labels while keeping stable test selectors. The four screenshots were regenerated from the actual extension surfaces; the Garden capture includes the dashboard card and page picker.

### 3. Brave footer guidance was not browser-specific

The first-run page displayed instructions about Brave’s New Tab footer to everyone, including Chrome and other Chromium users who do not have that footer. The tip and arrow now appear only when Brave’s browser detection reports Brave. Both the Brave and non-Brave outcomes have browser tests.

### 4. Several copies needed clearer meaning

The first-run captions used “the note” ambiguously, and hero copy implied that the product recognizes when someone is “wandering.” Updated copy distinguishes the **search intention** from the **optional private personal note**, explains navigation distance in ordinary words, and states that the tool cannot judge whether a detour was useful. The tour explicitly says it is not a test, and describes the sample garden as sample pages.

### 5. Retained historical text contained control-character damage

A repository-wide text scan found control characters that had corrupted function and file names in the retained 2026-08-15 security review (for example, `background`, `trackLink`, and `append`), plus a dropped leading letter in `replaceChildren`. These excerpts were mechanically repaired without changing the review’s findings. A repository-integrity regression check now scans Markdown and other tracked text formats so this damage is caught in future.

## Strengths of the current implementation

- **Agency is built into behavior, not only slogans:** reminders are optional and non-blocking; continuing remains available, including in the firmer reminder mode.
- **Local-first design:** the service worker owns and validates the session state. Browsing records stay in extension storage; the optional personal note is not sent to the content page. The query is sent to the chosen search provider when a session starts, which is now stated plainly.
- **Robust navigation handling:** the repository includes explicit paths for normal links, SPA transitions, tabs, reload/back-forward distinctions, redirects, and uncertain/unlinked paths.
- **Bounded and recoverable state:** normalization and storage limits protect against corrupted imports and unbounded growth; export, import, reset, and delete flows are tested.
- **Visual and assistive UX:** the modal tour traps keyboard focus, has bounded previous/next navigation and alt text, the dashboard provides a page picker, and reduced-motion and performance safeguards are tested.
- **Strong validation:** the project has unit, worker-input, repository-integrity, static-security, real-browser dashboard, real-extension, SPA stress, and performance lanes. It uses Playwright only for development/tests; the runtime extension has no JavaScript package dependencies.

## Highest-value next improvements

### Priority 1 — Close the self-reflection loop without pretending to infer intent

After a session ends, offer an optional private question such as **“Did this path serve your intention?”** with *Yes / Partly / No / Not sure / Skip*. If the user asks to see a history, show their own chosen reflections alongside their path; do not convert them into a score, rank, productivity metric, or automated relevance model. This would let people explore “how much did I move from my intention?” without the extension claiming to know the answer. It is a product-behavior change and should be designed/tested before implementation.

### Priority 2 — Explain the path model at the point where settings are changed

In Settings, show a miniature example: *Start → one linked page → another linked page = two navigation steps.* State that opening a new tab or a detected route may add a step, while an uncertain connection can be left unlinked. Keep the threshold preview tied to that same definition. This can prevent people from treating branch depth as an alignment percentage.

### Priority 3 — Make the limits and data boundary easy to find during setup

The first-run screens are clearer now, but consider adding a small, expandable **“What is recorded?”** disclosure before the person starts: URL/title and navigation signals are stored locally; the extension does not read page text; the personal note is local; the intention itself is sent to the selected search provider as a query. Keep the full details in the README and Settings, and keep the short setup surface skimmable.

### Priority 4 — Validate with people, not telemetry

Use a small, consent-based usability study with representative browsing tasks (research, study, and unstructured browsing). Ask participants to explain what a “step,” “depth,” and reminder mean; observe whether they can skip/disable, return, save, export, and delete. Prefer a private, human-led test and local notes over telemetry that would contradict the product’s privacy promise.

### Priority 5 — Complete browser and accessibility release checks

The automated browser suites run in Chromium; they do not certify Brave, Edge, Opera, or Vivaldi behavior. Before store release, complete the documented manual fork-by-fork checklist, including new-tab replacement, Brave-only footer guidance, permissions, storage migration, and chip behavior. Also check screen-reader reading order, text enlargement, contrast in both themes, and small-window scrolling with actual assistive technology.

## Architecture and audit map

| Area | Main files reviewed | Role |
|---|---|---|
| Chromium configuration | `manifest.json`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.gitignore` | Declares permissions and extension surfaces; defines test and packaging automation |
| Session engine | `background/service-worker.js`, `shared/state.js`, `shared/constants.js`, `shared/chromium-api.js` | Owns message validation, sessions, navigation graph, thresholds, privacy bounds, and browser compatibility |
| On-page experience | `content/content.js`, `content/spa-bridge.js` | Renders the non-blocking companion, captures navigation signals, and handles SPA messages |
| New Tab and popup | `newtab/`, `popup/` | Sets intentions, handles onboarding and quick session actions, and communicates with the service worker |
| Dashboard and settings | `dashboard/`, `settings/`, `shared/theme.js`, `shared/theme-bootstrap.js`, `shared/theme-controls.css`, `shared/error-tracing.js`, `shared/ram-guard.js` | Visualizes paths, exposes controls, theme, accessibility, errors, and performance modes |
| Artwork | `icons/`, `newtab/guide-images/` | Shared extension icons and four first-run screenshots; reviewed at their rendered dimensions |
| Validation | `test-*.mjs`, `stress-service-worker.mjs`, `scripts/browser-runtime.mjs`, `scripts/capture-onboarding-dashboard.mjs`, `scripts/package.mjs`, `scripts/preview-trees.mjs`, `scripts/profile-newtab.mjs` | Unit, browser, stress, integrity/security, performance, screenshot, preview, and release checks |
| Documentation | `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `EVIDENCE.md`, `CHROMEWEBSTORE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and the dated audit reports | User instructions, technical contract, privacy/security rationale, evidence limits, store copy, and historical findings |

## Verification performed for this change

- `npm test` — passed (unit, state, worker, error, security, repository-integrity, preview, regression, input, memory, and stress suites).
- `npm run test:dashboard` — **45 passed** in Chromium.
- `npm run test:extension` — **11 passed** in Chromium, including the real manifest, companion, new-tab replacement, and navigation gates.
- `npm run test:features` — **15 passed** in Chromium; regenerated the onboarding captures from the updated flow.
- `npm run profile:performance` — passed in Chromium: animation, hidden-page, long-task, layout, stylesheet, DOM-size, and heap assertions all stayed within the project’s limits.
- `node --check` passed for every changed JavaScript/test module.
- `node test-repository-integrity.mjs` passed: 4 HTML files, 22 source/config files, 62 text files, and 10 manifest references checked.

The browser runs used the sandbox’s `/usr/bin/chromium`; this is real-browser verification, not the pending per-fork manual QA for Brave and other supported browsers.
