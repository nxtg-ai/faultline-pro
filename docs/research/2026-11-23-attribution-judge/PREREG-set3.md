# Pre-registration, set 3: AI bot answers quoted verbatim (2026-11-23)

Committed before any run on these texts. **This is the third set and the last.** It was written after sets 1 and 2 did not reproduce the defect on the unchanged engine, and after a diagnostic showed the defect follows a claim with no named subject ("our", "you"). The Air Canada case is not in it.

## Inclusion rule (written before choosing)

Every answer by an AI support or service bot that one of these two primary reports quotes verbatim and states is false:

1. The Markup, "NYC's AI Chatbot Tells Businesses to Break the Law", 2024-03-29, https://themarkup.org/news/2024/03/29/nycs-ai-chatbot-tells-businesses-to-break-the-law (fetched 2026-11-23, sha12 66e80ad37add).
2. Ars Technica, on Cursor's support bot, April 2025, https://arstechnica.com/ai/2025/04/cursor-ai-support-bot-invents-fake-policy-and-triggers-user-uproar/ (fetched 2026-11-23, sha12 d579f1d1ac92).

That gives four quoted sentences. The Markup's two cash quotes are one answer, so they are one text. Text is copied from the fetched pages; the only changes are the first letter capitalised where the quote began mid-sentence, and a full stop where the article ended a quote with a comma.

| Text | Input (verbatim) | Why it is false, per the report |
|---|---|---|
| T1 | Yes, you can make your restaurant cash-free. There are no regulations in New York City that require businesses to accept cash as a form of payment. | The Markup: "in 2020, the city council passed a law requiring businesses to accept cash"; "one wholly false response". |
| T2 | There are no restrictions on the amount of rent that you can charge a residential tenant. | The Markup, quoting a Legal Services NYC tester: "there absolutely are restrictions for the many rent-stabilized units in the city". |
| T3 | Cursor is designed to work with one device per subscription as a core security feature. | Ars Technica; Cursor's co-founder: "We have no such policy." |

T3 overlaps set 2's P01 (same sentence, judged alone there). It is kept because the rule includes it.

## Procedure

- **Route:** `POST /scan` (extraction, then verification), because extraction is the stage that produced the failing claim. Hosted API 0.12.3 for the baseline. Admin key, so no result is served from the scan cache; each response's `cache` field is recorded.
- **Runs:** 3 per text, about 30 seconds apart.
- **A defect run:** a scan in which any extracted claim comes back supported. Every sentence in these texts is false, so no claim from them should be supported.

## Outcomes and stop rule (stated before any run)

- **D3:** defect runs on the unchanged hosted engine, out of 9.
- **Stop rule:** if D3 is 0 of 9, the set is reported and no further set is written. The extraction fix then ships on the diagnostic evidence and the over-correction guards (sets 1 and 2), and the results say so plainly.
- **If D3 is 1 or more:** the same 9 scans run on the fix branch (local API, production judge, extraction model and Parallel mode). Target: 0 of 9 defect runs. Fewer defect runs than the baseline but more than 0 is reported as a partial cure.
- Provider errors are counted and reported, never re-run.
