# Intent Grove

Intent Grove is a calm, local-first extension for Chromium-family browsers. Set an intention — *"Compare laptops for university"* — then browse normally while it grows your session into a small garden. If your recorded route reaches a depth you choose, it can offer a gentle moment to reflect and a set of choices. **Depth is navigation distance, not a measure of relevance or a score:** only you can decide whether a detour served your intention. Browsing records stay on your device; when you start, your chosen search provider receives the intention as a search query.

There is no generative AI, no summarizer, no remote model, and no page-content classifier — just a transparent branch model built from navigation signals. Intent Grove cannot tell whether a page is relevant or whether you are paying attention; the detour is yours to keep, save, or leave. It is a research-informed reflection aid, not a psychological test, validated behavioral intervention, or proven way to reduce browsing time. The project has not conducted a user-outcome study, so it is not known whether the extension improves well-being or helps people make choices they endorse.

## Quick install (any Chromium desktop browser)

1. Open your browser's extensions page — see the table below.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `Intent-Grove` folder (the one containing `manifest.json`).
5. Open a new tab: the planting page appears. Brave, Edge, and Opera may ask you to confirm replacing their new-tab page. In Brave, **Shields can stay on** — never disable them as an install step.

| Browser | Extensions page | Notes |
| --- | --- | --- |
| **Chrome** / Chromium / Arc | `chrome://extensions` | Reference configuration. |
| **Brave** | `brave://extensions` | May ask to confirm the new-tab replacement. Shields stay on. |
| **Microsoft Edge** | `edge://extensions` | May ask to confirm the new-tab replacement. |
| **Opera** | `opera://extensions` | Ships Speed Dial; may ask to confirm the override. |
| **Vivaldi** | `vivaldi://extensions` | Start page is `chrome://vivaldi-webui/startpage`; may ask to confirm. |

After updating files, click **Reload** on the extension card, then refresh open web pages so they receive the updated companion.

## How it works

- **Set an intention for a browsing session** (the app calls it a mission) on the new-tab page. An optional note records *why it matters today*, and an optional response plan reminds you of a choice you selected. Starting opens a search through your browser's provider (or a local override).
- **A small chip** keeps the intention visible on ordinary websites. Drag it anywhere; its position is stored privately by the extension for that site and tab, not in the website's storage.
- **The garden traces navigation, not meaning.** It uses page URLs and titles plus link, tab, redirect, and single-page-app route signals to connect recorded steps. When a connection is uncertain, it does not claim to know whether a page was related or useful.
- **When a branch gets deep,** the page settles slightly and the chip says so. At your choice threshold, a non-blocking corner card offers four equal choices: **Keep exploring · Return to my mission · Save this for later · Start a new mission.** Nothing is ever hidden or blocked.
- **Firmer reminders (opt-in)** add factual context — recorded pages and elapsed time since your intention, plus a reminder that you wrote down *why*. The choices never change. There is no shame, score, penalty, or hidden pressure mechanic.
- **Completed missions become storybook gardens** in the dashboard: every leaf is a recorded page. Trace a path home, prune, or compost. The shape shows navigation, not whether a page fit your intention.
- **Optional path-pattern reflection:** when you ask, the dashboard counts branching, straight-through, search-refining, and revisiting patterns across gardens saved on this device from the last eight weeks. Counts may overlap; they describe recorded paths, not personality, health, motives, or goal alignment. No analysis result is saved. A separate reminder is off by default and appears only inside Insights & Stats, at most once every seven days, after at least four completed gardens show the same pattern in at least three gardens and 60% of the sample. It can be dismissed; no browser notification is used.
- **Recorded-day milestones** mark 3 / 7 / 14 / 30 days with an explicit mission event. Unattended elapsed time alone does not count, and a gap carries no penalty.
- **Quiet discoveries (opt-in):** occasional notes from a small offline catalog when you return, save a page, or end a mission. These are bounded and do not depend on path depth or presumed relevance.
- **A short, skippable four-screen tour** shows the real New Tab, reminder, garden, and Settings screens. It uses example captures; taking the tour does not record a practice browsing session or open outside pages. Replay it from Settings whenever you like.
- **Make this page my new mission** lets a useful detour become the new intention while preserving the completed garden.
- **The companion follows your browser's light/dark preference**, and the whole extension respects reduced-motion settings.
- **Shortcuts:** `Alt+F` starts or ends a mission · `Alt+M` returns you to the mission origin.

## Research foundations and limitations

Intent Grove is **research-informed, not research-validated**. Psychology research supports broad ideas such as monitoring goal progress, making specific if–then plans, and preserving autonomy. But this extension records navigation paths and estimated elapsed time—not actual goal progress or whether a visit served your intention. Reviews of digital self-control tools report mixed findings, and much of that evidence concerns blockers or other interventions unlike Intent Grove. None of it demonstrates that this extension improves browsing well-being.

Intent Grove has not conducted a user-outcome study, and no study is active. The ordinary build disables study consent and counters. The repository contains opt-in, local-only study support that activates only in a separately configured build with recorded ethics approval, complete disclosures, explicit consent, and an eligibility self-attestation. There is no automatic upload, and the study export excludes browsing records and survey answers. See [EVIDENCE.md](EVIDENCE.md), [STUDY_PROTOCOL.md](STUDY_PROTOCOL.md), and the [study review](STUDY_REVIEW.md).

## Settings ("Tend the grove")

| Setting | What it does |
| --- | --- |
| Quieter at *N* branches (2–8) | When the page first settles and the chip notes the depth. |
| Choice appears at *N* branches (3–10) | When the corner card offers its four choices (always ≥ quieter + 1). |
| Use firmer reminders (Strict mode) | Adds factual context; choices stay yours and the extension never blocks. |
| Let leaves and branches move softly | Ambient motion; also follows your system reduced-motion preference. |
| Growth ritual | When the tiny branch-growth animation plays (once per mission / every branch / never). |
| Performance guardian + sensitivity (1–5) | Automatically calms animations and rituals under memory pressure. Tracking, the chip, and your data always keep working. Uses real free system memory where the browser exposes it, plus device class and the extension's own heap as fallbacks — all read locally, shown live in Settings. |
| First-step search engine | Your browser's default, or a local override (Google, Bing, DuckDuckGo, Brave Search, Startpage). |
| Pause the companion on these sites | One hostname per line (up to 40); hides the companion there, deletes nothing. |
| Occasional quiet discoveries | Enables optional local notes. No scores or punishments. |

## Privacy

- **Browsing records stay on your device** in `chrome.storage.local`. No servers, analytics, accounts, cloud sync of browsing data, or automatic research uploads are active. Study counters and consent are disabled in the ordinary build; a separately configured, ethics-approved study build can store allow-listed weekly aggregates only after explicit opt-in. Manual export is participant-reviewed. Planting a mission sends its text to your selected search provider as a query; Intent Grove itself does not receive the results.
- Only **URL/title metadata** is stored — never page text.
- Local history is **bounded**: 12 gardens · 96 pages per garden · 80 compost items · 30 days of reward history.
- **Delete-all-data** in the dashboard wipes everything, including the theme preference.
- The chip's drag position lives in **extension-private session storage** — host pages cannot read it; it clears when the tab or browser session ends.
- Your mission note never leaves the worker: the companion only learns *that* a note exists, never its text.
- Duration statistics are elapsed time between starting and ending a mission, plus time a tab is selected. These are estimates, can include time away, and do not detect reading, typing, or attention.

## License

Intent Grove is licensed under **GNU GPL-3.0-or-later**. See [LICENSE](LICENSE) for the complete terms.

## Browser support

Desktop Chromium: **Chrome, Brave, Edge, Opera, Vivaldi** (and Chromium/Arc). Not Firefox. The engine floor is Chromium 111; on a fork shipping an older engine the extension still works — SPA route tracking just falls back to a slightly slower path. Automated tests run in Chromium; a manual walkthrough per fork is required before store submission (see the roadmap).

**Troubleshooting.** Another new-tab extension (or the browser's own start-page setting) can own the same override — check which extension is enabled if the planting page doesn't appear. If the companion chip is missing on a site, check the extension's site access and refresh the page after reloading the extension. Browser-internal pages (`chrome://…`, `brave://extensions`, …) never run the companion, by design.

## Roadmap

The current direction is a transparent reflection tool: factual navigation context, user-controlled reminders, non-graded gardens, and optional positive notes. Remaining priorities:

| # | Item | Status |
| --- | --- | --- |
| 1 | Per-fork manual QA pass (Brave, Edge, Opera, Vivaldi) driven by a generated checklist script — required before store submission | Planned (owner) |
| 2 | Add a real-browser regression test for saving the companion position during `pagehide` and for clearing the theme preference when all data is deleted | Planned — rate-limit retry and normal delete-all behavior are covered; the unload-time position flush still needs browser-level coverage |

## Development

No build step, no runtime dependencies — plain HTML/CSS/JS modules. Playwright is dev-only (browser test lanes). Local browser suites select installed Brave by default; set `BRAVE_EXECUTABLE_PATH` when Brave is installed outside its standard location. On CI runners without Brave, the suites use Playwright-managed Chromium. They never silently select Edge or Chrome.

```bash
npm ci                        # dev toolchain only
npm test                      # unit/contract suites, no browser required
npx playwright install chromium
npm run test:dashboard        # dashboard UI in Brave (Playwright Chromium on CI)
npm run test:extension        # loads the real manifest (11 gates)
npm run test:features         # end-to-end walk of every user surface (13 steps)
npm run test:spa-stress       # 50 rapid history.pushState transitions
npm run profile:performance   # memory/perf gate for the New Tab page
npm run package               # writes dist/intent-grove.zip (the store artifact)
npm run preview:trees         # local gallery of the real SVG tree renderer
```

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the engineering deep dive: file structure, navigation semantics, Chromium integration notes, permissions rationale, accessibility engineering, garden rendering, tab/history behavior, memory and performance design, security & reliability implementation, and the full test-lane inventory.
- **[CHANGELOG.md](CHANGELOG.md)** — release history.
- **[EVIDENCE.md](EVIDENCE.md)** — research foundations, what they do and do not support, and current evidence limits.
- **[STUDY_PROTOCOL.md](STUDY_PROTOCOL.md)** — proposed study methodology and privacy safeguards; ordinary-build collection remains disabled. **[STUDY_REVIEW.md](STUDY_REVIEW.md)** — UI mapping, protocol stress test, and implementation gate.
- **[SECURITY.md](SECURITY.md)** · original [security review](SECURITY_REVIEW_2026-08-15.md) · [modified-fork audit](AUDIT_REPORT_2026-08-16.md) · [September 2026 audit](AUDIT_2026-09-21.md)
- **[CHROMEWEBSTORE.md](CHROMEWEBSTORE.md)** — store listing copy and per-permission justification · **[CONTRIBUTING.md](CONTRIBUTING.md)**
