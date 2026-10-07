# Chrome Web Store Listing — Intent Grove

> Last Updated: 2026-10-08

## Store Listing

**Extension Name**
Intent Grove

**Short Description**
A calm, local-first Chromium companion that shows navigation distance from your intention—without blocking pages or judging curiosity.

**Detailed Description**
Intent Grove is a calm, local-first Chromium browser companion that helps you notice when navigation has taken you several steps from your intention—without blocking pages, reading page content, judging curiosity, or claiming to measure attention. It records browsing paths locally to build your garden and show your statistics.

When you sit down to research or work, plant an intention for what you are setting out to do. You can add an optional private note about why it matters today. As you click links and explore, Intent Grove quietly keeps track of how many branches deep you have traveled from your original task.

When a path becomes unusually deep, Intent Grove offers a gentle moment of reflection: a quiet choice sheet that lets you return to your mission, save the curiosity to compost for later, start a new mission, or keep exploring. A deep path is never treated as a mistake.

Key Features:
- Non-blocking companion: A discreet leaf chip tucked into the corner of your page that shows your current depth and mission. Drag it anywhere; it follows your browser's light or dark theme.
- Organic tree visualization: Visit the Garden Dashboard to view your browsing trail rendered as a living botanical tree. The tree reflects recorded navigation structure; it does not judge whether pages matched your intention.
- Mindful choices with facts: At the depth you choose, a quiet corner card shows recorded pages and elapsed time on deeper paths. Background time can count; the estimate does not measure reading or attention. Choose to keep exploring, return, save for later, start a new mission, or make the current page your new mission.
- Firmer reminders (optional): Factual context of the intention you planted, including the fact that you wrote down why it matters. The choices never change and nothing is ever blocked.
- Compost for later: Save interesting discoveries into your personal compost bin with one click or via the context menu.
- Quiet discoveries (optional): Occasional notes from a bounded offline catalog, with cooldowns and per-session limits. They never depend on path depth or presumed relevance. Recorded-day milestones are positive-only; elapsed idle time alone does not count.
- Performance guardian: Automatically calms animations and rituals when memory pressure runs high (real free-memory reading where the browser exposes it), with an opt-out and a sensitivity slider. Tracking, the companion, and your data always keep working.
- Local browsing records: Mission notes, navigation history, and settings stay in browser storage. No telemetry, extension server, or cloud sync. Planting a mission sends its text to the selected search provider as a query.
- Dark mode and reduced motion support: Built with accessibility in mind, supporting light/dark themes and system reduced-motion preferences.
- Single-page application awareness: Tracks branch transitions accurately on modern web apps like YouTube, GitHub, and Notion.
- Four-screen first-run tour: A skippable walkthrough of the real New Tab, reminder, Garden, and Settings surfaces. The illustrative captures are not a live browsing exercise; the tour saves no practice browsing data and opens no outside pages. Replay it from Settings.
- Keyboard shortcuts: Alt+F starts or ends a mission; Alt+M returns you to the mission origin.

How to Use:
1. Open a new tab or click the Intent Grove toolbar icon.
2. Optionally take the four-screen tour; it is skippable and uses example captures, not a tracked practice session.
3. Enter your intention (for example: "Research camera lenses for landscape photography"). Press Enter or choose Plant Intention to save it locally and navigate that same tab to your selected search-results starting point.
4. Browse normally. Watch the discreet companion chip at the top right of the page.
5. At your chosen path depth, the card shows navigation and elapsed-time context; you choose whether to return, save the page for later, continue, or set this page as a new mission.
6. Open the Garden Dashboard anytime to see the recorded navigation tree and elapsed-session summaries. The garden cannot tell whether a page served your intention.
7. Tip: Alt+F starts or ends a mission from anywhere; Alt+M returns you to the mission origin.

Privacy & Local Storage:
Intent Grove does not connect to an extension-operated server or include third-party analytics. Mission notes, navigation signals, and garden history remain on this device in local extension storage. When you plant an intention, the browser or selected search provider receives that text as a search query. Your data belongs to you.

**Category**
Productivity

**Single Purpose**
Tracks browsing depth relative to a stated focus intention and provides non-blocking tools to navigate back or save distractions locally.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | Ready | icons/icon-128.png |
| Screenshot 1 (Garden Map) | 1280×800 | To capture | screenshots/dashboard-map.png |
| Screenshot 2 (Insights & Stats) | 1280×800 | To capture | screenshots/dashboard-stats.png |
| Screenshot 3 (New Tab Plant) | 1280×800 | To capture | screenshots/newtab-plant.png |
| Screenshot 4 (Companion Chip) | 1280×800 | To capture | screenshots/companion-overlay.png |
| Screenshot 5 (Choice Sheet) | 1280×800 | To capture | screenshots/choice-sheet.png |
| Small Promo Tile | 440×280 | To create | promo/promo-small.png |
| Marquee Promo Tile | 1400×560 | To create | promo/promo-marquee.png |

### Screenshot Notes
- Screenshot 1: The interactive Garden Map showing a branching botanical tree with healthy, long, and composted leaves.
- Screenshot 2: The Insights & Stats tab displaying weekly session elapsed time, intention-start and path-depth trends, recorded days in a row, and most recorded domains.
- Screenshot 3: The peaceful new-tab page inviting the user to plant their intention.
- Screenshot 4: A normal webpage with the compact leaf chip resting quietly in the corner without obscuring page content.
- Screenshot 5: The gentle choice sheet offering "Return to my mission", "Save this for later", "Start a new mission", or "Keep exploring".

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Required to store user session trees, garden statistics, composted items, and preferences locally in `chrome.storage.local`. |
| `search` | permissions | Used only when Browser default is selected, so Chromium sends the mission query through the user's existing default search provider. |
| `tabs` | permissions | Required to associate tabs with active focus sessions, detect new-tab replacements across Chromium browsers, navigate the planting tab to its first search step, and return to origin tabs via "Return to my mission". |
| `webNavigation` | permissions | Required to observe in-page client-side navigations (`onHistoryStateUpdated`) on ordinary HTTP(S) sites so SPA route depth is accurate. |
| `alarms` | permissions | Required to schedule periodic storage quota checks to keep local extension data bounded and healthy. |
| `contextMenus` | permissions | Required to provide right-click shortcuts for "Save Page for Later" and "End Current Focus Mission" directly from any webpage. |
| `system.memory` | permissions | Used only by the local Performance guardian: reads free system memory to calm decorations automatically under pressure. The value is never stored, never transmitted, and the guardian degrades to device-class and own-heap signals where the API is absent. |
| `http://*/*`, `https://*/*` | host_permissions | Required to inject the isolated content script that renders the non-blocking companion chip and observes link clicks during active sessions. |

## Privacy & Data Use

### Data Collection

Intent Grove stores mission text, URL/title metadata, settings, and navigation events locally in the browser so it can build the garden and show your statistics. This information is not sent to Intent Grove servers. When you plant an intention, the text is sent as a search query to the browser's default or selected search provider.

Intent Grove has no extension-operated server, analytics, account, or cloud sync. The optional Performance guardian reads system memory availability locally (`chrome.system.memory`) solely to decide when to calm animations; that reading is never stored or transmitted.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | None | No |
| Health info | No | No | None | No |
| Financial info | No | No | None | No |
| Authentication info | No | No | None | No |
| Personal communications | No | No | None | No |
| Location | No | No | None | No |
| Web history | Yes, local only | No, except mission text sent to the selected search provider when planting | Garden display and user-requested statistics in `chrome.storage.local` | No |
| User activity | No | No | None | No |
| Website content | No | No | None | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

## Developer Info

**Publisher Name**: Intent Grove
**Support**: GitHub Issues repository

### Reproducible release package

Run `npm ci`, then `npm run test:all` and `npm run package`. The resulting `dist/intent-grove.zip` contains only the extension runtime directories and manifest required by Chromium; tests, reports, source-control metadata, and development dependencies are excluded. For local development, load the repository folder containing `manifest.json` as an unpacked extension.

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.3.0 | 2026-09-14 | Added Browser-default search through Chromium's Search API, stronger SPA route serialization, richer storybook tree twigs and buds, site-level pause controls, release CI, and reproducible packaging. | Draft |
| 0.3.1 | 2026-09-15 | Fixed recent-bud rendering, title-only SPA updates, rapid History API route snapshots, Back/Forward tracking, and reliable MV3 quota scheduling. | Draft |
| 0.3.2 | 2026-09-15 | Removed an unintended settings sync mirror so all session, settings, and compost data remain local-only; corrected browser compatibility documentation. | Draft |
| 0.3.3 | 2026-09-16 | Added a lightweight animated atmospheric background to New Tab with reduced-motion and in-extension motion-setting support. | Draft |
| 0.3.4 | 2026-09-17 | Fixed opt-in Quiet discoveries persistence and delivery, repaired quota-pressure compaction, removed unused pooling scaffolding, and added reward regression coverage. | Draft |
| 0.3.5 | 2026-09-18 | Added a rotating reflection prompt to the choice card; tuned the New Tab atmosphere (slower mist and sun, paint containment) with the existing motion kill-switches intact. | Draft |
| 0.3.6 | 2026-09-18 | Compact tier-aware Quiet discoveries reveal with restrained seed/bloom/seasonal treatment; automated SPA performance-regression checks in CI. | Draft |
| 0.3.7 | 2026-10-01 | Rebrand to Intent Grove, user-agency and clarity updates: fictional first-run tree demo, one-tap rhythm presets, current-page mission action, compost reminder, neutral path and elapsed-time explanations, non-graded bounded Quiet discoveries, activity-signal day calculation, lower-cost New Tab atmosphere, evidence/limits guide, and shared botanical icon. | Draft |
| 0.3.8 | 2026-10-08 | Replace the retired sample demo with an optional four-screen walkthrough, correct outdated walkthrough claims, clarify that navigation depth is not an intent-alignment score, use realistic example screens, and show Brave-only new-tab-footer help only in Brave. | Pending release |
