# Pre-Publish Citation Gate — Report Review

> **Fill-in template for the validate-first demo leave-behind.** Source the numbers from `scan --output-format json` (`claims[]` + `verifications{status, sources}`). Replace every `{…}`. Do NOT include any EU-AI-Act framing. Do NOT fabricate — if the engine returned `unverified` with empty `sources[]`, that is a flag, not a confirmed fabrication; say "could not be verified against live sources," not "fake," unless the absence is confirmed.

**Document reviewed:** {report title / filename}
**Reviewed:** {date} · **Engine:** Faultline (Gemini-grounded, live Google Search) · **Citations checked:** {N}

---

## Gate verdict: {PASS ✅ | BLOCK 🔴}

**{X} of {N} citations could not be verified against any live source.**
A gate set to `--fail-on high` would have **{blocked / passed}** this deliverable before it shipped.

---

## Citations that did not verify ({X})

| # | Claim / citation as written in the report | Engine verdict | What live search found |
|---|-------------------------------------------|----------------|------------------------|
| 1 | {verbatim claim text from claims[].text} | `unverified` | {no live source returned / contradicting source: URL} |
| 2 | {…} | `unverified` | {…} |
| … | {…} | {…} | {…} |

## Citations that verified ({N − X})

| # | Claim / citation | Verdict | Source |
|---|------------------|---------|--------|
| 1 | {claim text} | `supported` | {sources[0].uri} |
| … | {…} | {…} | {…} |

---

## What this means

Every citation in {report title} was decomposed into an atomic claim and checked against live web search in {duration}s. The {X} flagged above returned no live source the engine could ground them to — exactly the failure mode behind the EY (withdrawn) and Deloitte ($1.6M revised + $290K refunded) reports. Run as a pre-publish gate, this check happens **before** the deliverable reaches a client, not after a journalist finds it.

**The ask:** would you pay for a gate that runs this on every AI-assisted deliverable before it ships?

---
*Honesty notes for whoever fills this in:* (1) `unverified` ≠ proven-fake — frame as "could not be verified," the engine's actual claim. (2) Quote `claims[].text` verbatim; do not paraphrase a citation into looking worse. (3) If `sources[]` is non-empty for a flagged claim, read it — `contradicted` is a stronger result than `unverified` and should be labeled correctly. (4) No EU-AI-Act / compliance / "agent governance" language anywhere.

🌽 Generated with NextGen AI - Intelligent Systems
https://nxtg.ai
Co-Authored-By: AxW <axw@nxtg.ai>
