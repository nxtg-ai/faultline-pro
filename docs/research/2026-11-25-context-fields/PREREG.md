# Pre-registration: claims keep their subject, scope, time and baseline

Status: DRAFT. It is frozen when the held-out set's SHA-256 below is filled in and this file is committed, before the first measurement call.

## The failure

Extraction splits a paragraph into single claims. A claim that leans on its paragraph loses that context when it is judged alone, and the judge can mark it supported or contradicted from evidence about something else. The case that prompted this (a live client session, 2026-11-24): a sentence of the form "Their business-consulting spend rose 7%", where "their" meant one vendor's fastest-growing AI customers, was judged supported from a national consulting-market growth figure. The number matched; the subject did not.

Siblings of the same failure: a pronoun with its antecedent in an earlier sentence; a scope carried from an earlier sentence ("among AI buyers", "in the UK"); a time frame ("in a year", "since 2024"); a comparison split from its baseline; an attribution split from the quote; a negation or condition in the next sentence. A related failure (gap 2): a true sentence judged contradicted by a source about a different event.

## The change under test

1. Extraction returns, for each claim, an optional `context` object with up to four fields: `subject`, `scope`, `time`, `baseline`.
2. Each field must be an exact substring of the claim's own paragraph, checked by code after whitespace and quote-mark normalisation. A field that is not found is dropped. A model-invented field is therefore impossible by construction.
3. Claim text, sentence coverage (`guaranteeClaimPerSentence`), the verify cap and billing are unchanged.
4. The judge prompt (both the grounded and the sources path) carries the context only when at least one field is set: the claim is to be judged as applying to that subject, scope, time and baseline, and evidence about a different one neither supports nor contradicts it.

## Arms

- M: `main` at the commit named in the run folder, engine code proven by `scripts/arm-proof.sh` (RESULT: MATCH).
- C: the change, same proof.
- Same configuration in both: judge model, extraction model, grounding provider and mode, measurement project and key, the same search cache.

## Sets

1. Held-out context set: 3 cases for the siblings set 3 does not cover: the prompting case (the subject lost from "Their ... spend rose 7%"), an attribution split from its quote, and a negation or condition in the next sentence. Real public-source sentences in their paragraphs, each with an acceptable-verdict set and exact-substring context fields. Stored privately (the prompting case quotes an internal document); frozen by hash here. SHA-256: `TBD before the first run`.
2. Air Canada sets 1 to 3 (`docs/research/2026-11-23-attribution-judge/`), unchanged. In addition, the regression case from that study (the policy sentence in the second person, "... by completing our Ticket Refund Application form", whose cause was traced to extraction keeping "our" and "you") is run through extraction and judged on both arms, and counts toward the cure rate like a set-1 case, with acceptable verdicts contradicted or unverified.
3. Gap-2 gold set from the content-engine lane, private, file `06-context-gold-set.jsonl` at the content-engine commit 80cb3b5, SHA-256 `765b17e0758cf9553ff98a25345a7647d1d43c709c842eebe152adfc0eb45360`. 16 rows, 12 scored: 2 OBSERVED (a true line judged contradicted from off-subject evidence in a real scan, with the run ids, the judge message and the misleading URL copied from the scan output) and 10 CANDIDATE (context-dependent sentences covering a pronoun, a carried survey scope, a time frame and a baseline, with truth re-checked on the source page). Two candidate rows rest on a secondary report because the primary page renders no text; they are reported apart. One row overlaps set 1 and is not scored twice. The misleading URL and the red-on-main field of each CANDIDATE row are filled by the red-first run below, never by hand.
4. G0: the 200-claim Factcheck-Bench sample, seed 20261105 (`docs/research/accuracy-g0-harness.md`).

Each case carries an acceptable-verdict set (for example supported or unverified for a true line; unverified only for a fact that only an internal source holds). A verdict is right when it is in that set, and, where the case lists `supported_only_from_hosts`, a supported verdict counts only when its supporting evidence comes from one of those hosts: support drawn from an off-subject host scores as red, which is the failure under test.

Red first: every case in sets 1 and 3, and the set-2 regression case, is run on arm M before the change is measured, and only cases where M gives a verdict outside the acceptable set count toward the cure rate. The count of red cases is reported, by set and by tier.

## Success bar (all must hold)

1. Cure: on the red cases of sets 1 and 3 and the set-2 regression case together, C's verdict is in the acceptable set on at least 60% (M is 0 by construction). OBSERVED and CANDIDATE cures are reported apart. If fewer than 5 cases are red, the cure rate is reported but cannot pass the bar alone, and the program owner rules.
2. No harm on G0: paired balanced accuracy C minus M has a point estimate at or above -0.02 and a 95% CI that does not lie entirely below 0 (paired bootstrap, 2,000 resamples, seed 20260929), with at least 190 of 193 binary claims returned in each arm.
3. Unreadable judge replies on G0: C at most 1 percentage point above M.
4. Verdicts moved to mixed on G0: C's share of mixed at most 2 percentage points above M's.
5. Air Canada sets 1 to 3: no case M gets right turns wrong in C.

## Stop rule

- A run with any argon-fallback verdict is invalid (as in PREREG-g0 amendment A3) and is rerun once; a second invalid run stops the measurement.
- Spend: the measurement project, at most 10 USD for this study (ruling f169a36d). Anything above stops the run and is reported.
- If the bar fails, nothing ships. No after-the-fact rerun to rescue a failed bar.

## What is not claimed

This tests four context fields on these sets. It does not claim that every split claim keeps its context, and no buyer-facing wording changes until the bar passes.
