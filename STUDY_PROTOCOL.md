# Proposed privacy-conscious user-study protocol

**Status: design proposal only.** This is not an active study, recruitment notice, or consent form. The current Intent Grove release collects no analytics or research telemetry and has no study enrollment or upload path. This document does not authorize data collection. Any study must be designed with qualified psychology and research-ethics partners and approved before recruitment.

## Research question

Among adult Chromium users who choose to try Intent Grove, does access to the extension help people reflect on whether a browsing session served their own intention and choose a next step they endorse—without reducing their sense of autonomy or increasing guilt, stress, interruption, or feeling monitored?

Do not define success as simply browsing less. The extension cannot infer whether a page was useful or whether a person made progress. Those are user-reported outcomes.

## Study sequence

1. **Formative review:** Ask a small, diverse group of adults to explain the tree, labels, choice card, privacy explanation, and reminder in their own words. Check for confusion, shame, pressure, inaccessible controls, and unexpected interpretations. Revise the materials before efficacy testing. Do not collect browsing data for this phase.
2. **Feasibility pilot:** Test recruitment, consent comprehension, survey burden, opt-out, data export, retention, accessibility, and adverse-experience reporting. Treat this phase as feasibility work only—not proof of benefit. Use the pilot to refine measures and estimate attrition and variance for planning a later study.
3. **Preregistered evaluation:** If the pilot supports proceeding, compare an immediate-start group with a delayed-start (wait-list) group. A possible schedule is a brief baseline followed by several weeks of access, then a follow-up; the research team should set duration and sample size using the pilot and an a priori power analysis. The delayed group should be offered access after its comparison period. This design evaluates the extension as a package; it will not identify which individual feature caused a result. A later component study could compare reminders on versus off.

Start with adults aged 18 or older. Do not recruit people on the assumption that they have an attention disorder, addiction, or other diagnosis, and do not market the study as treatment. Set the target countries and languages in advance.

## Outcomes and measures

Before recruitment, a psychologist and measurement specialist should choose and preregister one primary outcome that matches the study population and the stated question. Avoid making up a “validated” measure or selecting a scale after seeing results.

A candidate general digital-well-being measure is the English-language Perceived Digital Well-Being Scale studied with 1,854 participants aged 18–25 in the United States and United Kingdom. Its validation does not automatically extend to other ages, languages, countries, or a short browser-extension intervention; assess fit before using it as a primary outcome. [Vera Cruz et al. (2025)](https://doi.org/10.2196/78334).

The study may also ask participants whether sampled browsing sessions served their own stated intention and whether the next step felt self-endorsed. These are study-specific self-reports, not established or validated scales. Conduct cognitive interviews and a pilot before treating them as outcome measures. If self-determination theory is part of the rationale, assess autonomy and perceived pressure with a suitable, validated instrument for the chosen population and language.

Measure possible harms alongside benefits: guilt or shame, stress, interruption, perceived surveillance, frustration, reminder fatigue, ability to dismiss or change the prompt, and whether the tool distracted from the task. Record withdrawal and uninstall/disable rates, and invite feedback from people who stop participating.

Treat local usage counts only as feasibility or implementation measures. Do not use fewer minutes, shorter paths, or more extension interactions as standalone evidence of improved well-being. The recorded path is not a ground-truth measure of intention alignment.

## Privacy-conscious study data plan

### Default product behavior

Keep the production extension free of telemetry. Ordinary users must not need to join a study, transmit data, or accept research consent to use any feature. Do not add an analytics SDK, background upload, advertising identifier, or hidden event stream.

### Separate opt-in study build

If a study proceeds, use a separate study build and consent flow. Enrollment must be off by default and independent of extension settings. Explain the exact fields, purpose, recipient, retention period, risks, contact person, withdrawal method, and deletion process before a participant opts in. Revoking consent should stop further study collection and provide a clear way to delete locally buffered study data.

Prefer weekly surveys plus an explicit, user-reviewed manual export over continuous telemetry. Any candidate telemetry should be computed on-device, remain there until the participant chooses **Review and share**, and show the exact payload before export. The current release does not implement these counters or this export.

A minimal candidate payload, subject to ethics and privacy review, could contain only:

- a random study code that is not derived from a Chrome profile, account, device, or installation identifier;
- a relative study-week number, not an exact date or timestamp;
- coarse counts or ranges for sessions started and reminders shown, dismissed, or reviewed; and
- the participant’s separately consented survey responses.

Do not collect or export URLs, page titles, domains, search queries, mission text, personal notes, page content, tab IDs, exact navigation paths, raw event sequences, or exact timestamps. Do not add fields merely because the extension can access them. Treat even aggregates and free-text survey answers as potentially identifying; minimize them, restrict access, and suppress small cells in public reporting. Keep any contact information needed for follow-up in a separate, access-restricted file that is not joined to browsing-derived data except through the random study code.

Store research data with encryption in transit and at rest, access limited to the named study team, a documented retention and deletion schedule, and a breach-response plan. Name any survey or storage provider in the consent materials and assess it before use. Do not send study data to the extension developer or an unreviewed analytics service by default.

## Consent, ethics, and participant protections

Obtain approval from the applicable institutional research ethics committee or IRB, plus privacy/security review, before recruitment or data collection. Preregister the protocol, primary outcome, hypotheses, exclusions, sample-size rationale, analysis plan, and stopping rules. Make clear that participation is optional, that ordinary extension use is unaffected by declining, and that participants may withdraw without penalty. Do not tie compensation to positive answers, continued extension use, or completing every survey.

Use plain-language consent and a comprehension check. Provide a study contact and a way to report distress, privacy concerns, or unintended effects. Have a documented plan to pause recruitment or collection after an unexpected privacy incident or credible harm signal.

## Analysis and reporting

Set the smallest practically meaningful difference with input from target users and the research team before the main study. Power the confirmatory study for that outcome; do not choose sample size by convenience after seeing results. Analyze participants in their assigned groups where appropriate, report effect estimates and uncertainty intervals, disclose missing data and attrition, and show negative or null outcomes alongside positive ones. Separate preregistered confirmatory results from exploratory analyses.

A small feasibility pilot can establish whether the study and measurement are workable; it cannot establish efficacy. Any later public claim must state the tested population, version, duration, comparison, outcome, uncertainty, and limitations. Replicate before broad claims. Do not describe Intent Grove as “psychologically proven” or as a treatment based on this protocol alone.

## Research foundations

This plan draws on general psychology findings about goal-progress monitoring and implementation intentions, and on autonomy-supportive design. The evidence and its boundaries are summarized in [EVIDENCE.md](EVIDENCE.md). None of those sources is a trial of Intent Grove.
