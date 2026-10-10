# Research foundations, evidence limits, and ethical design

**Reviewed:** 2026-10-10 · **Applies to:** Intent Grove 0.3.8 and later

Intent Grove is a private browsing-reflection aid. It is not a psychological test, diagnosis, treatment, or clinically validated intervention. The project has engineering and interaction tests, not an Intent Grove user-outcome trial. It has not been shown to improve digital well-being, reduce browsing time, or help users make better choices.

## What research informs the design

- **Monitoring can support goal pursuit, but the monitored signal matters.** A psychology meta-analysis of 138 randomized studies (19,951 participants) found that interventions increasing progress monitoring also increased goal attainment on average (d+ = 0.40). Effects were larger when progress was physically recorded or reported. [1] Intent Grove records navigation structure and elapsed-time estimates—not progress toward a goal. This research supports exploring transparent self-monitoring; it does not justify treating branch depth or time as goal progress or intention alignment.
- **Specific if–then plans can help with goal enactment across varied settings.** A meta-analysis of 94 independent tests found a positive average effect for implementation intentions (d = .65). [2] Intent Grove's optional, user-selected response plan is inspired by this general mechanism. The reviewed studies do not show that this extension's plan, choice card, or browsing context has the same effect.
- **Autonomy, competence, and relatedness are central constructs in Self-Determination Theory.** Ryan and Deci's psychology review links social-contextual support for these needs with motivation and well-being. [3] This informs design choices such as optional and dismissible reminders, configurable thresholds, and keeping choices available. It does not prove those choices improve a user's well-being.
- **Digital self-control interventions have mixed, limited direct evidence.** A 2021 systematic review of 28 interventions reported varied results; awareness-only approaches were barely effective in the included studies, and confidence was low because studies tended to be small, short, or unclear in context. [4] A 2023 systematic review and meta-analysis reported small-to-medium average reductions in time spent on distracting technology sources, but much of the reviewed work used blocking or removal approaches. The authors also identify limits in theory, study duration, control groups, follow-up, ethics reporting, and accurate inference of context or intention. [5] Neither review establishes the effectiveness of a non-blocking browser reflection extension.
- **Digital-attention heuristics offer design guidance, not efficacy evidence.** A 2025 HCI systematic literature review proposes attention-respecting heuristics organized using Self-Determination Theory. It calls for further validation of the heuristics; it is not a trial of Intent Grove. [6]

The psychology literature supports broad mechanisms, not this product. Research on digital self-control is interdisciplinary and often comes from human-computer interaction, computing, or education. The cited studies involve different people, devices, measures, and interventions. Their results cannot be transferred to Intent Grove as proof.

## What the extension can and cannot claim

The tree and weekly summaries describe recorded browser events. They cannot determine whether a page was useful, whether a user was attentive, whether a session made progress, or whether browsing matched an intention. Only the user can judge those things. The path-pattern labels are descriptive counts, not psychological archetypes, personality traits, or diagnoses.

The weekly reminder's thresholds—at least four completed gardens, with a pattern present in at least three gardens and 60% of the sample—are implementation choices, not validated psychological cutoffs. Elapsed-time estimates can include time away from the computer. Neither the navigation data nor the reminder establishes benefit or harm.

A future measure of perceived digital well-being may be useful in a study, but population fit matters. For example, the English-language Perceived Digital Well-Being Scale validation included 1,854 young adults aged 18–25 in the United States and United Kingdom. That does not establish suitability for other ages, languages, countries, browser use, or sensitivity to change caused by this extension. [7]

## Privacy and ethical guardrails

- Browsing records remain in local extension storage. Planting an intention sends its text to the selected search provider as a query. Intent Grove currently has no analytics, cloud telemetry, research enrollment, or automatic research-data upload.
- Do not call navigation depth, elapsed time, or path patterns “focus,” “attention,” “relevance,” “progress,” or “alignment” unless the user directly reports that interpretation.
- Keep reminders optional, explain why they appeared, and let users dismiss, change, or disable them. No score, shame, punishment, public comparison, or blocking is part of the product goal.
- Do not infer a psychological type from a path. Keep patterns count-backed, transparent, and overlapping.
- Any future study data collection must be separate from ordinary extension use, explicitly opt-in, minimized, and revocable. No telemetry is being activated by this documentation change. See the [proposed study protocol](STUDY_PROTOCOL.md).

## Evaluation status

Intent Grove has not had a user-outcome trial. The next evidence step is not a stronger marketing claim; it is a transparently consented study that asks users whether the tool helps them reflect and choose, while measuring autonomy, burden, and negative experiences as well as possible benefits. The [proposed study protocol](STUDY_PROTOCOL.md) describes a privacy-first path. It is a plan, not an active study, and it does not authorize collection of participant data.

## References

[1]: https://doi.org/10.1037/bul0000025 "Does monitoring goal progress promote goal attainment? A meta-analysis of the experimental evidence"
[2]: https://doi.org/10.1016/S0065-2601%2806%2938002-1 "Implementation Intentions and Goal Achievement: A Meta-analysis of Effects and Processes"
[3]: https://doi.org/10.1037/0003-066X.55.1.68 "Self-determination theory and the facilitation of intrinsic motivation, social development, and well-being"
[4]: https://doi.org/10.1111/jcal.12581 "Digital self-control interventions for distracting media multitasking — A systematic review"
[5]: https://doi.org/10.1145/3571810 "Achieving Digital Wellbeing Through Digital Self-control Tools: A Systematic Review and Meta-analysis"
[6]: https://doi.org/10.1145/3725215 "The Digital Attention Heuristics: Supporting the User’s Attention by Design"
[7]: https://doi.org/10.2196/78334 "Perceived digital well-being scale in the United States and United Kingdom: psychometric validation study"
