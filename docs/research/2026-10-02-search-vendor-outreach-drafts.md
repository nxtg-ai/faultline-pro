# Search vendor outreach: drafts for Asif to send

**Status:** DRAFTS. Nothing has been sent. Each message goes out as Asif, so Asif sends it.
**Why:** the cache brief (`docs/research/2026-10-01-cache-and-jev-brief.md`) found that Faultline can only keep a long-lived verdict cache if its evidence comes from a source that grants storage rights. Google's grounding terms forbid caching and modifying grounded results as written. These messages ask three search vendors for storage-rights terms, and ask Google whether its rules can be relaxed for us.
**Channels:** each was checked on the vendor's own site on 2026-10-02.

| To | Channel | Where it was confirmed |
|---|---|---|
| Brave Search API | email **api-sales@brave.com** | brave.com/search/api, "API sales" contact line |
| Exa | form **https://exa.ai/contact/sales** (fallback hello@exa.ai) | exa.ai/enterprise "Contact sales"; exa.ai/terms |
| Tavily | email **sales@tavily.com** (or the form at https://www.tavily.com/contact) | tavily.com/contact and /enterprise |
| Google Cloud | form **https://cloud.google.com/contact/form** | cloud.google.com/contact |

Facts used in every message, so a reply can be compared like for like:
- Product: Faultline (https://faultline.nxtg.ai) checks the claims in AI-generated text against the open web, one search per claim today.
- Volume: well under 50,000 searches a month today. Ask for pricing at 50k, 250k and 1M a month.
- What we would store:
  - the query;
  - the result URLs and titles;
  - short evidence snippets;
  - our own verdict on each claim.
- How long: 30 days to 12 months, depending on how fast the fact changes.
- Who sees it: other Faultline customers who check the same claim.

---

## 1. Brave Search API (api-sales@brave.com)

**Subject:** Storage-rights plan for a claim-verification product (Faultline)

> Hi Brave Search API team,
>
> I run Faultline (https://faultline.nxtg.ai). It checks the claims in AI-generated text against the open web, and we are looking at the Brave Search API as our evidence source.
>
> Your FAQ says that storing results in part or in whole needs a plan with storage rights. That is exactly our use. We want to:
> 1. Store each query with its result URLs, titles and short snippets for 30 days to 12 months, depending on how fast the topic changes.
> 2. Store our own verdict on each claim, which we derive from those results.
> 3. Serve the stored verdict and its source links to other Faultline customers who check the same claim, instead of searching again.
> 4. We do not plan to train models on the results.
>
> Could you tell me:
> - Which plan covers this, and its price at 50,000, 250,000 and 1,000,000 queries a month?
> - The longest retention the plan allows, and whether serving stored results to customers other than the original requester is permitted.
> - Attribution or display requirements when we show stored results.
> - Whether Zero Data Retention can be combined with the storage-rights plan.
>
> We are well under 50,000 searches a month today and growing. Happy to get on a call.
>
> Thanks,
> Asif Waliuddin
> Founder, NXTG.AI · Faultline
> axw@nxtg.ai

---

## 2. Exa (https://exa.ai/contact/sales)

**Form fields:** Company: NXTG.AI (Faultline) · Use case: claim verification with a stored evidence cache · Volume: under 50k searches/month today.

**Message:**

> We run Faultline (https://faultline.nxtg.ai), which checks the claims in AI-generated text against the open web. We are evaluating Exa as our evidence source.
>
> Exa's general terms restrict copying or storing information obtained through the Services. We need an enterprise agreement that permits:
> 1. Storing each query's result URLs, titles and short excerpts for 30 days to 12 months.
> 2. Storing our own derived verdict per claim.
> 3. Re-serving the stored verdict and source links to other Faultline customers who check the same claim.
>
> No model training on the results.
>
> Please share:
> - whether your enterprise terms allow this, and the longest retention;
> - pricing at 50k, 250k and 1M searches a month;
> - any attribution or display rules.
>
> — Asif Waliuddin, Founder, NXTG.AI · axw@nxtg.ai

---

## 3. Tavily (sales@tavily.com)

**Subject:** Storing and re-serving search results in a claim-verification product

> Hi Tavily team,
>
> I run Faultline (https://faultline.nxtg.ai), which checks the claims in AI-generated text against the open web. We are looking at Tavily Search as our evidence source.
>
> Before we build, I want to confirm our use is allowed. We would:
> 1. Store each query's result URLs, titles and snippets for 30 days to 12 months.
> 2. Store our own derived verdict per claim.
> 3. Re-serve the stored verdict and source links to other Faultline customers who check the same claim, instead of searching again.
>
> No model training on the results.
>
> I didn't find a storage restriction in your terms of service. Could you confirm in writing that this use is permitted on a standard or enterprise plan, and the longest retention allowed? Could you also send pricing at 50,000, 250,000 and 1,000,000 searches a month, and any attribution requirements?
>
> Thanks,
> Asif Waliuddin
> Founder, NXTG.AI · Faultline
> axw@nxtg.ai

---

## 4. Google Cloud (https://cloud.google.com/contact/form)

**Form fields:** Product interest: Vertex AI / Gemini (generative AI) · Company: NXTG.AI · Use: Grounding with Google Search, terms question.

**Message:**

> We run Faultline (https://faultline.nxtg.ai). It checks the claims in AI-generated text, using Gemini 2.5 Flash with Grounding with Google Search through the Gemini API on the paid tier. We want to stay on Google grounding as we grow, and we need clarity on the grounding terms before we design for scale.
>
> Our questions are under the Gemini API Additional Terms and Google Cloud Service Specific Terms §20(k):
> 1. **Caching across users.** Can we store a grounded verdict for a claim and show it to a different customer who later checks the same claim, instead of grounding again? If not under standard terms, can an enterprise agreement permit it, and with what retention?
> 2. **Derived data.** Is storing only our own label (supported / contradicted / mixed) and our own wording, without the Grounded Result text, still "caching" or "learning from" Grounded Results?
> 3. **Presentation.** We turn the grounded answer into a verdict card with the source links. Does that count as modifying the Grounded Result? What display is required?
> 4. **Search Suggestions.** On the Gemini API, must we show Search Suggestions with every grounded answer? Is the opt-out described for Vertex available to us, and on what terms?
> 5. **Sharing.** May a user share a link to their own result page with a colleague?
>
> We are happy to move to Vertex AI or a committed-use agreement if that is the path to these terms. Volume today is well under the 1,500 free grounded prompts a day.
>
> — Asif Waliuddin, Founder, NXTG.AI · axw@nxtg.ai
