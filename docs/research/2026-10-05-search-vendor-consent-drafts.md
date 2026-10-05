# Search vendor consent requests: drafts for Asif to send

**Status:** DRAFTS. Nothing has been sent. Each message goes out as Asif, so Asif sends it.

**Why:** prereg amendment A1 (`2026-10-05-prereg-retrieval-provider-comparison-v1.md` §11) suspends two arms of the retrieval comparison until the vendor agrees in writing:
- **Ceramic:** Terms §7(g) and (h) forbid benchmarking and publishing performance without prior written consent.
- **Exa:** Terms §4.2(a) forbids copying or publishing information obtained from the Services without written permission.

Terms quoted in `2026-10-05-retrieval-terms.md`.

**Channels:** found on each vendor's own site on 2026-10-05.

| To | Channel |
|---|---|
| Ceramic.ai | legal@ceramic.ai (named in its Terms), copy sales@ceramic.ai |
| Exa | the form at https://exa.ai/contact/sales (fallback hello@exa.ai), the same channel as the 2026-10-02 storage-rights draft |

---

## 1. Ceramic.ai (to legal@ceramic.ai, cc sales@ceramic.ai)

**Subject:** Written consent request: benchmarking Ceramic search through Cloudflare Web Search (Terms §7(g), (h))

Hello,

I run Faultline (https://faultline.nxtg.ai), which checks the claims in AI-generated text against evidence from the web. We plan a small, pre-registered research comparison of search sources for claim verification. Ceramic would be used through Cloudflare's Web Search API, alongside Exa, Linkup and Google grounding.

Your Terms of Service (last modified February 27, 2026) §7(g) and (h) restrict benchmarking and publishing performance information without your prior written consent. So we are asking for that consent before we make any call.

What the run would do:
- About 661 searches, one per claim, from a public fact-checking benchmark (Factcheck-Bench), at limit 5.
- We keep only result URLs, our verdict and counts. We do not keep titles or descriptions, and we never show results to anyone outside the run.
- We would publish aggregate measures in our research notes: verdict accuracy, citation rates, latency and cost per check. The method would be published with them so it can be reproduced.

We would be glad to share the results with you before we publish them.

Could you confirm in writing whether Ceramic consents to this use and publication? If it would need an order form or particular conditions, please tell us what they are. If you do not consent, we will leave Ceramic out.

Separately: if the results are good, we would want to keep cited URLs and short snippets in each user's own scan history. That goes beyond §7(p)'s real-time display. What would an order form for that look like?

Thank you,
Asif Waliuddin
Faultline, NXTG.AI

---

## 2. Exa (https://exa.ai/contact/sales)

**Subject:** Written permission request: research comparison and storing result URLs (Terms §4.2(a))

Hello,

This follows our earlier note about storage rights for Faultline (https://faultline.nxtg.ai).

We plan a small, pre-registered research comparison of search sources for claim verification. It would use Exa through Cloudflare's Web Search API, alongside other providers and Google grounding. Your Terms §4.2(a) restrict copying and publishing information obtained from the Services without written permission. So we are asking for that permission before we make any call.

What the run would do:
- About 661 searches, one per claim, from a public fact-checking benchmark, at limit 5.
- We keep only result URLs, our verdict and counts in our research files. No titles or highlights are kept, and no results are shown to anyone outside the run.
- We would publish aggregate measures: verdict accuracy, citation rates, latency and cost per check, with the method, so it can be reproduced.

Two questions:
1. Do you grant written permission for this use and publication?
2. Does Zero Data Retention apply to Exa requests made through Cloudflare? Cloudflare's providers page lists Exa as not ZDR, while its changelog says all three providers are.

Thank you,
Asif Waliuddin
Faultline, NXTG.AI
