# Intent Grove: UI and study-protocol review

**Reviewed:** 2026-10-10 · **Scope:** Intent Grove 0.3.8 source, proposed protocol, and the local-only study support added on this branch.

## UI mapping to the research principles

### Choice card

The card is a reasonably strong **autonomy-supportive interaction**: it is non-blocking, can be dismissed, its threshold is user-configurable, and it offers equivalent next steps (continue, return, save, or begin a new intention). Its copy identifies navigation depth and confidence as recorded signals, says depth is not relevance, and leaves the interpretation to the user. The optional response plan is user-selected and can serve as a simple if–then cue. These are design correspondences, not proof that users experience the card as autonomy-supportive.

For **competence**, the explicit step count, confidence estimate, and choices make the signal interpretable and actionable. However, a depth threshold is not evidence that someone is failing at a goal. Repeated prompts may interrupt or feel judgmental, especially if a user has not configured the threshold. The formative phase should test whether people understand the card as an invitation rather than a verdict, including the “firmer reminder” mode and reward copy.

The card does not deliberately support **relatedness**. That is a scope choice, not necessarily a defect. Avoid adding social ranking or sharing to simulate relatedness; such features would create new pressure and privacy risks. If relatedness is later part of the theory of change, study it separately and with participant control.

### Tree and goal monitoring

The tree supports reflection by making recorded pages and parent paths inspectable. Selecting a leaf traces its path, and the dashboard explains that route shape cannot establish usefulness or intention alignment. The weekly summaries show activity and average deepest navigation distance, not goal progress.

That distinction is essential. A meta-analysis of 138 randomized studies (19,951 participants) found an average effect of progress-monitoring interventions on goal attainment, but those interventions monitored progress toward the goal. Intent Grove records navigation structure and elapsed-time estimates. It cannot tell whether either signal represents progress toward a user's stated intention. The result supports testing transparent monitoring in general, not using branch depth as an outcome or efficacy proxy. [1]

The tree also used the internal CSS state `healthy` in its screen-reader description (“healthy branch”). That label could sound like a judgment about the user or path. The accessible description now uses “recorded path branch”; visual depth styling remains a navigation cue. Continue checking the visible legend, stage names, and reward text with formative participants.

**SDT conclusion:** autonomy has the clearest implemented support; competence is supported by transparent, user-controlled interpretation but not objectively assessed; relatedness is not a product goal. Self-Determination Theory describes psychological needs, not a checklist that certifies an interface. [2] The 2025 digital-attention heuristics offer design guidance organized with SDT, but the authors note that the heuristics still need further validation. [3]

## Protocol stress test

The proposed sequence—formative review, feasibility pilot, then a preregistered comparison—is a sound order. It correctly rejects browsing-time reduction as a standalone success criterion, distinguishes a feasibility pilot from efficacy evidence, and names autonomy and adverse experiences as outcomes.

The protocol is **not ready for recruitment or data collection**. It names no research lead, institution, approved ethics review, participant contact, survey/storage provider, retention period, or completed deletion/withdrawal process. It does not yet select a primary outcome, set a practically meaningful effect, define the power/sample-size calculation, finalize study duration, specify assignment procedures, or preregister exclusions and analyses. A wait-list comparison can estimate the effect of the extension as a package, but may not separate expectancy or study-contact effects from the product and cannot isolate a specific feature.

### Inclusion and exclusion criteria

The protocol says to start with adults aged 18 or older, but it does not give operational inclusion/exclusion rules. A conservative draft for an ethics/research partner to approve is:

- **Include:** adults aged 18 or older who use a supported desktop Chromium-family browser, reside in a predeclared country, can read one of the approved study languages, and can provide informed consent.
- **Exclude:** people under 18; people unable to provide informed consent; people outside the approved country, language, or browser scope; and people who cannot complete the approved study tasks.
- **Do not exclude or recruit based on a presumed diagnosis.** Do not describe the extension as treatment. Do not infer diagnoses from browsing paths.

These are candidate criteria, not an approved protocol. The research team must specify how eligibility is checked, how it handles withdrawal and loss of browser access, and whether an ethics committee requires additional rules. The extension uses a self-attestation; it does not ask for age, diagnoses, or browsing history as eligibility evidence.

### Measurement and burden

Before efficacy testing, choose one primary outcome that measures the intended benefit—reflection on whether a session served the participant's own intention and/or whether the next step felt self-endorsed—and select a valid instrument suitable for the population and language. Study-created questions need cognitive interviews and a pilot; do not label them validated. Assess autonomy/pressure and harms such as shame, stress, interruption, fatigue, and perceived surveillance alongside benefit. The candidate digital-well-being scale in the protocol was validated with U.S./U.K. adults aged 18–25; that is not automatic validation for other populations or a short extension study.

### Privacy and data minimization

A random study code is **pseudonymous, not anonymous**. Aggregates can still disclose information when groups are small, and survey free text can identify a person. Keep contact details separate, avoid unnecessary free text, suppress small public-reporting cells, restrict access, and set a deletion deadline. Do not join an exported code to browsing content inside the extension.

The implemented candidate payload is restricted to the study ID, random code, relative study-week number, and coarse counts of sessions started, choice-card appearances/dismissals/actions, and reflection-note appearances/reviews/dismissals. It omits dates, timestamps, URLs, titles, domains, queries, intention text, notes, tab IDs, paths, and raw event sequences. The study store is separate from ordinary browsing export/import. There is no automatic upload or survey integration. Export requires a participant to review the exact JSON and click Download; withdrawal deletes the local study store, and clear-local-data deletes it too. A configured retention deadline triggers deletion on the next study-data access after the device-clock deadline; no background alarm is used, so the participant disclosure states that timing. The buffer is Chrome local extension storage with no app-layer encryption; it relies on operating-system and browser-profile access controls, which the consent panel must disclose. If the ethics/security review requires stronger local encryption, activation must wait for that redesign.

## Implementation status and activation gate

The Settings interface and local counter/export code are present, but `shared/study-config.js` is disabled in the ordinary build. The gate also requires an explicit ethics-approval flag and non-empty disclosures for purpose, lead, ethics review, contact, recipient, survey provider, retention, withdrawal, deletion, risks, eligibility, countries, and languages. Enrollment requires both an unchecked-by-default consent action and an eligibility self-attestation. Without a complete approved study configuration, the ordinary build records no study counters and cannot export study data.

This code gate is an engineering safeguard, not ethics approval. Before enabling a separate study build, qualified research/privacy partners must supply and approve the missing information, choose and preregister measures and analyses, and test the complete consent/withdrawal path. The framework measures implementation feasibility only; it does not establish benefit, well-being, or intention alignment.

## References

[1]: https://doi.org/10.1037/bul0000025 "Does monitoring goal progress promote goal attainment? A meta-analysis of the experimental evidence"
[2]: https://doi.org/10.1037/0003-066X.55.1.68 "Self-determination theory and the facilitation of intrinsic motivation, social development, and well-being"
[3]: https://doi.org/10.1145/3725215 "The Digital Attention Heuristics: Supporting the User’s Attention by Design"
