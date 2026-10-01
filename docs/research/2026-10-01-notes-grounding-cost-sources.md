# Faultline grounding cost and caching research (2026-10-01)

Scope: Faultline runs 1 extraction call plus K (≤8) Gemini 2.5 Flash calls per scan, each with `googleSearch`, one claim per call. Grounding is about 95% of cost (about $0.22 p50). There is no server-side cache.

Method: pages were fetched with curl on 2026-10-01 and stripped to text. The quotes below are verbatim from those dumps. "Unconfirmed" means no primary source was found or read. This is research, not legal advice. The terms conclusions in section 2 need a lawyer's read before anyone relies on them.

---

## TL;DR

1. **Batching is the main lever. Caching is not.** On Gemini 2.5 Flash, grounding is billed **per prompt**, however many searches the model runs. K claims verified in **one** grounded prompt cost **1 unit** ($0.035 after the free tier), not K units. That cuts the grounding line by up to 8x with no terms exposure. Gemini 3.x reverses this: it bills **per search query** ($14/1k). Batching saves nothing there, and a 3.x prompt that runs more than 2.5 queries costs more than one 2.5 prompt.
2. **On its face, a cross-user claim-verdict cache of grounded outputs is prohibited** by both the Gemini API terms and the Google Cloud (Vertex) terms. Grounded Results may be shown only "to the end user who submitted the prompt", and you may not "cache … analyze … or otherwise learn from" them. The two-year storage carve-outs cover the same user's chat history and display optimisation only. Whether a *derived* verdict label is "learning from" Grounded Results is a legal gray zone the text does not settle.
3. **Alternatives priced per query**: Serper $0.30–1.00/1k, Brave $5/1k, Exa $4–15/1k, Tavily $5–8/1k (1–2 credits), OpenAI web_search $10/1k plus tokens, Vertex Web Grounding for Enterprise $45/1k prompts (2.5) or $14/1k queries (3.x). Google Custom Search JSON API is closed to new customers and is discontinued on 2027-01-01. Storage rights vary by vendor (section 3).
4. **No published paper measures semantic-cache false-hit rates on claim-verification workloads.** The closest is vCache on 150k web-search queries: a static 0.99 threshold still gave a **1.7% error rate**. Other results: MeanCache precision 0.72 against GPTCache's 0.52, and GPT Semantic Cache hit rates of 61.6–68.8% with >97% of hits correct. Use an exact or normalised-claim match before any semantic tier.
5. **Context caching cannot reduce the grounding fee.** It discounts input tokens only, by 90% (2.5 Flash cached input is $0.03/M against $0.30/M). Grounding retrieval tokens are already free. Per-claim prompts are probably below the 2,048-token minimum. No doc says whether caching applies to grounded calls (unconfirmed), but the answer would not change cost.

---

## 1. How Gemini grounding is billed (per prompt vs per query)

### Gemini Developer API, Gemini 2.5 Flash: billed per grounded prompt
Source: https://ai.google.dev/gemini-api/docs/pricing (page "Last updated 2026-10-01 UTC")

- Gemini 2.5 Flash, Standard, Paid Tier, Grounding with Google Search: "1,500 RPD (free, limit shared with Flash-Lite RPD), then $35 / 1,000 grounded prompts"
- The Batch and Flex rows for 2.5 Flash carry the same line: "1,500 RPD (free, limit shared with Flash-Lite RPD), then $35 / 1,000 grounded prompts"
- Tools summary table: "Gemini 2.5 models: 1,500 RPD free (limit shared for Flash and Flash-Lite). Then $35 / 1,000 grounded prompts Gemini 3 models: 5,000 free search requests per month (shared across all Gemini models), then $14 per 1,000 requests."

Source: https://ai.google.dev/gemini-api/docs/google-search ("Last Updated 2026-09-23 UTC")

- "When you use Grounding with Google Search with Gemini 3, your project is billed for each search query that the model decides to execute. If the model decides to execute multiple search queries to answer a single prompt (for example, searching for "UEFA Euro 2024 winner" and "Spain vs England Euro 2024 final score" within the same API call), this counts as two billable uses of the tool for that request. For billing purposes, we ignore the empty web search queries when counting unique queries. This billing model only applies to Gemini 3 models; when you use search grounding with Gemini 2.5 or older models, your project is billed per prompt."

### Gemini 3.x: billed per search query
Same pricing page, on every Gemini 3.x model (3.8/3.7/3.6/3.5 Flash, 3.5/3.1 Flash-Lite, 3.1 Pro, 3 Flash Preview):
- "5,000 free search requests per month (shared across all Gemini 3.x models), then $14 per 1,000 requests."
- Footnote: "A customer-submitted request to Gemini may result in one or more queries to Google Search. You will be charged for each individual search query performed. Retrieved context (text or images) provided by Grounding with Google Search is not charged as input tokens."

Note the free allowance: 2.5 Flash gets **1,500/day** (about 45k/month). Gemini 3.x gets **5,000/month** in total.

### Vertex AI (now "Gemini Enterprise Agent Platform") states the same split
Source: https://cloud.google.com/vertex-ai/generative-ai/pricing (redirects to cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)
- 2.5 Flash: "Gemini 2.0 Flash, 2.5 Flash and 2.5 Flash-Lite include a combined 1,500 Grounding Prompts per day at no additional charge. … Grounding Prompts exceeding those limits are billed at $35 per 1,000 Grounding Prompts."
- "A "Grounding Prompt" is an End User prompt that Customer submits to Gemini for which Gemini makes one or more queries to a Google web index (each a "Grounding Query"). Even if multiple Grounding Queries are sent, there is only one charge for a Grounding Prompt."
- "Grounding with Google Search and Web Grounding for Enterprise are billed only when a Grounding Prompt successfully returns sources (i.e., results containing at least one support URL from the web)."
- Gemini 3: "Includes 5,000 Grounding Queries per month at no charge, aggregated across all Gemini 3 models. Grounding Queries exceeding those limits are billed at $14 per 1,000 Grounding Queries. … You will be charged for each individual Grounding Query performed. Billing will start January 5, 2026."

**Unconfirmed:** whether the Gemini Developer API (ai.google.dev) also skips billing for 2.5 prompts that return no sources. Only the Vertex page states that rule.

### What batching K claims into one prompt costs

| Model | Billing unit | One prompt verifying 8 claims | 8 separate prompts (today's design) |
|---|---|---|---|
| 2.5 Flash (API or Vertex) | per grounded prompt | **1 unit = $0.035** | 8 units = $0.28 |
| Gemini 3.x | per search query executed | about N queries x $0.014 (N = queries the model chooses, probably ≥8 for 8 claims) | same N x $0.014 |

The arithmetic comes from the quoted list prices. The query count N for 3.x was not measured.

Caveats:
- Quality is **untested**. One prompt verifying 8 claims may run fewer searches per claim and lower verdict accuracy. Run an eval before shipping.
- Lifecycle: https://ai.google.dev/gemini-api/docs/deprecations ("Last updated 2026-10-01 UTC") lists "gemini-2.5-flash June 17, 2025 No shutdown date announced". The batching saving lasts only while 2.5 Flash does.

---

## 2. Google's terms on storing or caching grounded results

### Gemini API Additional Terms, "Grounding with Google Search"
Source: https://ai.google.dev/gemini-api/terms ("Last updated 2026-04-28 UTC"). Verbatim:

> "Grounded Results" mean responses that Google generates using the prompt from the end user (or from you, when using function calling), contextual information that you may provide (as applicable), and results from Google's search engine. "Search Suggestions" mean search suggestions that Google provides with the Grounded Results. … "Links" are any other means to fetch web pages (including hyperlinks and URLs), which may be contained in a Grounded Result or Search Suggestion.

> **Use Restrictions** You will only use Grounding with Google Search in an application that is owned and operated by you and will only display the Grounded Results with the associated Search Suggestion(s) to the end user who submitted the prompt. You will not, and will not allow your end user or any third party to, cache, frame, syndicate, resell, analyze, train on, or otherwise learn from Grounded Results or Search Suggestions. For clarity, Grounded Results, Search Suggestions, and Links are intended to be used in combination to respond to a given end user prompt and it is a violation of these terms to use Grounding with Google Search to extract or collect one or more of these components for another purpose (for example, using programmatic or automated means to collect Links, using Links to build an index, or using Links to identify destination pages for crawling or scraping).

> You will not, and will not allow your end user or any third party to, copy, store, or implement any click tracking, Link-tracking or other monitoring of Grounded Results or Search Suggestions, except that: You may copy and store, for up to two (2) years, the text of the Grounded Result(s): (1) that were displayed by you only to evaluate and optimize the display of the Grounded Results in your application; (2) in chat history of an end user of your application only for the purpose of allowing that end user to view their chat history; and (3) temporarily for the purpose of resubmitting the text of the Grounded Result in a subsequent prompt that you submit to Google via a function call to obtain a refined or improved Grounded Result to display to the end user, as long as the developer: (i) does not use the interim Grounded Results for any other purpose; (ii) deletes any Grounded Result that is not displayed to the end user once the final Grounded Result is generated; and (iii) displays any associated Search Suggestions or other Links (as applicable) with the final Grounded Result (up to a maximum of 5 Search Suggestions) to the end user. You may copy and store the Grounded Result and Search Suggestions solely for the purpose of and for the minimum time necessary to comply with applicable law or regulations. You may allow end user(s) to copy and store individual Grounded Results that were displayed to them through your application as long as you do not allow Grounded Results to be accessed or collected by automated or programmatic means or to be used to create a database.

> Unless permitted by Google in writing, you: (1) will not modify, or intersperse any other content with, the Grounded Results or Search Suggestions; …

> … when using Grounding with Google Search, Google will store prompts, contextual information that you may provide, and output for thirty (30) days for the purposes of creating Grounded Results and Search Suggestions …

### Google Cloud Service Specific Terms §20(k) (Vertex / Agent Platform)
Source: https://cloud.google.com/terms/service-terms ("Last modified September 30, 2026"). These say the same as the API terms, with one difference: Vertex may opt out of displaying Search Suggestions.

> (1) … Customer will only display the Grounded Results with the associated Search Suggestion(s) to the End User who submitted the prompt; provided, however, that Customer may elect not to display Search Suggestions subject to the conditions set forth on the Pricing page. (2) Will not, and will not allow its End Users or any third party to, cache, frame, syndicate, resell, analyze, train on, or otherwise learn from Grounded Results or Search Suggestions. … (3.1) Customer may copy and store, for up to two (2) years, the Grounded Results: (3.1.1) that were displayed by Customer only to evaluate and optimize the display of the Grounded Results in the Customer Application; (3.1.2) in the chat history of an End User of the Customer Application only for the purpose of allowing that End User to view their chat history. (3.2) … minimum time necessary to comply with applicable law or regulations. (3.3) … not … used to create a database.

> (ii) Storage for Debugging. … logs … for up to three (3) days …

> l. Web Grounding for Enterprise. Section 20(k) (Grounding with Google Search) also applies to Web Grounding for Enterprise, except that … (iii) subsection 20k(ii) is deleted.

Vertex pricing page on Search Suggestions: "Customers may decide not to display Search Suggestions with Grounded Results in their Customer Applications at standard pricing for under 1 million Grounding Prompts per day."

### What this means for Faultline
- **A cross-user verdict cache is prohibited on its face.** Serving user A's grounded verdict to user B breaks "display … to the end user who submitted the prompt" and "will not … cache". Keeping a store of verdicts or links keyed by claim also runs into "create a database" and "using Links to build an index". Web Grounding for Enterprise is under the same §20(k).
- **What the terms allow:** (a) storing a user's own scan results for up to 2 years so **that same user** can view their history; (b) storing for up to 2 years to evaluate and optimise display; (c) storing for the minimum time legal compliance requires. Re-showing a user their own past scan is fine. Answering a new scan from that store is not.
- **Gray zone (needs a lawyer):** whether storing only a *derived* label (claim hash → TRUE/FALSE plus confidence, with no Grounded Result text and no Links) counts as "analyze … or otherwise learn from Grounded Results". The text does not settle it. The breadth of "otherwise learn from" points toward prohibited.
- **An existing compliance question, separate from caching:** on the Gemini Developer API, Search Suggestions must be displayed. There is no opt-out like the Vertex pricing-page condition. Faultline should check whether its CLI, API and web surfaces render `searchEntryPoint` and Search Suggestions with each verdict. **Unconfirmed in this research. The code was not checked.**
- **Legal route to a cache:** retrieve evidence from a search vendor whose terms grant storage rights (section 3). Then cache that evidence and the verdicts derived from it under that vendor's terms. Google grounding would then be used only on cache misses, or not at all.

---

## 3. Alternatives priced per query

| Option | Price | Storage / caching terms | Source |
|---|---|---|---|
| Gemini API grounding, 2.5 Flash | 1,500 RPD free, then **$35/1k grounded prompts** | Cache prohibited (section 2) | ai.google.dev/gemini-api/docs/pricing |
| Gemini API grounding, 3.x | 5,000/month free, then **$14/1k search queries** | Same | same |
| Vertex Grounding with Google Search | same as above (2.5: $35/1k prompts; 3.x: $14/1k queries); billed only when sources are returned | §20(k); Search Suggestions may be hidden at standard pricing | cloud.google.com/vertex-ai/generative-ai/pricing |
| Vertex **Web Grounding for Enterprise** | 2.5 family: **"$45 per 1,000 Grounding Prompts"**; Gemini 3: shares the "5,000 … per month … $14 per 1,000" line with Google Search | §20(l): §20(k) applies, debug-log clause deleted. "Web Grounding for Enterprise doesn't store customer data." Index: "fast-changing content is updated every 6 hours, and the whole index is updated every 24 hours." | https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/web-grounding-enterprise |
| Google Custom Search JSON API | "100 search queries per day for free … Additional requests cost $5 per 1000 queries, up to 10k queries per day." | **"The Custom Search JSON API is closed to new customers. … Existing Custom Search JSON API customers have until January 1, 2027 to transition to an alternative solution."** Not an option. | https://developers.google.com/custom-search/v1/overview (updated 2026-02-18) |
| **Brave Search API** | Search: "$5 per 1,000 requests", "$5 in free credits every month", 50 QPS. Answers: "$4 per 1,000 queries + $5.00 per 1,000,000 input tokens + $5.00 per 1,000,000 output tokens" | Default terms prohibit it: "store, cache, or create a database of Search Results, in whole or in part, other than transient storage required for operation". FAQ: "If you would like to store the API results in part or whole … you will need to subscribe to a plan that explicitly grants storage rights." Storage-rights plan price is not public (contact sales; **unconfirmed**). | https://brave.com/search/api/ ; https://api-dashboard.search.brave.com/documentation/pricing ; https://api-dashboard.search.brave.com/terms-of-service |
| **Exa** | Per 1k requests (≤10 results): Instant $4, Fast/Auto $7, Deep $12, Deep-Reasoning $15. Contents "$1 /1k pages". | The general ToS §4.2(a) is restrictive: no "download, modify, copy, … reproduce, duplicate, publish … any information … obtained from or through, the Services, except for temporary files that are automatically cached by your web browser…" unless permitted in writing. Enterprise terms may differ (**unconfirmed**). | https://exa.ai/pricing ; https://exa.ai/terms (PDF) |
| **Tavily** | 1,000 free credits/month. Pay-as-you-go "$0.008 per credit". Plans $0.0075–$0.005/credit. "Basic Search … 1 API credit", "Advanced Search … 2 API credits". So $5–16 per 1k searches. | No storage or cache restriction on Output found in the ToS sections read (§3.2 restricts the *Services*, §6.4 restricts AI Output use). Tavily keeps a broad licence over Customer Input. Treat as "no restriction found", **not** "permitted". | https://docs.tavily.com/documentation/api-credits ; https://www.tavily.com/terms |
| **Serper** (Google SERP scraper) | Starter $50 = 50k credits ($1.00/1k); Standard $375 = 500k ($0.75/1k); Scale $1,250 = 2.5M ($0.50/1k); Ultimate $3,750 = 12.5M ($0.30/1k). Credits valid 6 months. | ToS has no storage clause. **Risk (lead, not verified):** it resells scraped Google results, so Google's own terms on that data are a third-party exposure. | https://serper.dev/ ; https://serper.dev/terms |
| **OpenAI web_search tool** | "Web search (all models) $10.00 / 1k calls + Search content tokens billed at model rates." Preview, non-reasoning models: "$25.00 / 1k calls + Search content tokens are free." gpt-4o-mini / gpt-4.1-mini: "search content tokens are billed as a fixed block of 8,000 input tokens per call." | Storage and caching terms **unconfirmed** (not fetched). | https://developers.openai.com/api/docs/pricing |

**Lead (arithmetic, not measured):** Brave, Exa Instant or Serper evidence retrieval at 8 searches per scan costs about $0.003–0.06 per scan, before LLM tokens. Today's grounding line is about $0.22. These vendors return raw results, so Faultline would have to do evidence selection and citation itself with an ungrounded LLM call. That is quality work, and nobody has evaluated it.

---

## 4. State of the art for caching in LLM fact-checking and RAG

**Main gap: no published paper measures cache false-hit rates on claim-verification workloads.** All the numbers below come from chat, search-query or QA workloads.

| Work | Workload | Measured hit rate | Measured false-hit / error | URL |
|---|---|---|---|---|
| **vCache** (Schroeder et al., UC Berkeley; arXiv 2502.03771 v5, Feb 2026) | SemCacheSearchQueries: "Random subset of 150,000 web-search queries" (MS MARCO) | up to "12.5× higher cache hit" than baselines | Static threshold: "the threshold of 0.99, which yields an error rate of 1.7% after 150k samples". The paper argues that "no static threshold below 1.0 can maintain a bounded error rate as prompt diversity increases". vCache bounds error to a user-set δ, with "26× lower error rates". Error = FP/n. | https://arxiv.org/abs/2502.03771 |
| **MeanCache** (Gill et al.; arXiv 2403.02694) | 1,000 user queries | about 31% of real ChatGPT queries "were similar to previous ones" (20 users, 27K queries, academic setting) | "MeanCache with MPNet achieves a precision of 0.72, significantly surpassing GPTCache's 0.52 … The number of false hits for MeanCache is 89 … while GPTCache has 233". Also: "GPTCache's suggested threshold of 0.7 will result in suboptimal performance". Optimal MPNet τ = 0.83 gives precision 0.92. | https://arxiv.org/abs/2403.02694 |
| **GPT Semantic Cache** (Regmi & Pun; arXiv 2411.05276) | customer-service style queries | "cache hit rates ranging from 61.6% to 68.8%" | "positive hit rates exceeding 97%", so about 3% of hits are wrong | https://arxiv.org/abs/2411.05276 |
| **Redis LangCache** (Gill et al., Redis; arXiv 2504.02268) | domain-specific embeddings | n/a | Fine-tuned "LangCache-Embed" precision on medical data "increases from 78% to 87%" | https://arxiv.org/abs/2504.02268 |
| Redis LangCache product docs | n/a | n/a | "LangCache defaults to a similarity threshold of `0.85`, with a recommended starting range of `0.8`–`0.9`. … A tighter threshold reduces wrong-answer risk. … Start with a conservative, tighter threshold." | https://redis.io/docs/latest/develop/ai/context-engine/langcache/concepts/ |
| **Krites** (Singh et al.; arXiv 2602.13165, Feb 2026) | conversational and search traces | static-tier coverage "up to 3.9 times" (+290% on search-style queries) "at fixed cache error rate" | Uses an asynchronous LLM judge on near-threshold misses, so serving decisions are unchanged | https://arxiv.org/abs/2602.13165 |
| **MVR-cache** (arXiv 2605.24914, May 2026) | established benchmarks | "increases the cache hit rates by up to 37% while maintaining the same correctness guarantees" | n/a | https://arxiv.org/abs/2605.24914 |
| GPTCache (Zilliz) | n/a | n/a | README: "you may encounter false positives during cache hits and false negatives during cache misses" | https://github.com/zilliztech/GPTCache |
| **Proximity** (arXiv 2503.05530): evidence/retrieval caching | MedRAG, MMLU | "reduces database calls by 77.2% while maintaining database recall and test accuracy" | n/a | https://arxiv.org/abs/2503.05530 |
| **"That is a Known Lie"** (Shaar et al., ACL 2020): claim-level reuse | previously fact-checked claims (PolitiFact, Snopes) | ranking task (MAP/MRR), not a cache hit rate | n/a | https://arxiv.org/abs/2005.06058 |

**Freshness and TTL by claim type.** FreshQA (Vu et al., arXiv 2310.03214) gives the taxonomy only, with no TTL values: "never-changing, in which the answer almost never changes; slow-changing, in which the answer typically changes over the course of several years; fast-changing, in which the answer typically changes within a year or less; and false-premise". It also reports that "all models … struggle on questions that involve fast-changing knowledge and false premises." https://arxiv.org/abs/2310.03214. The only Google freshness cadence found is Web Grounding for Enterprise's index: 6h for fast-changing content, 24h for the whole index. **Any TTL numbers Faultline picks are design choices, not citations.**

**Design implications for a claim verifier (my inference, not from a paper):**
- Claim paraphrases that change a number, a date or a negation ("revenue rose 12%" vs "rose 21%", "is" vs "is not") sit very close in embedding space but have opposite verdicts. None of the benchmarks above test this. The Faultline workload is adversarial for semantic caching.
- Recommended order: (1) exact match on a normalised claim key (lowercase, entity and number canonicalisation, hash); (2) only then a semantic tier, with a high threshold or vCache-style per-entry thresholds plus an LLM-judge verify step (Krites pattern), and never a hit across differing numbers or negation; (3) TTL by FreshQA class.
- A Google-grounded output cannot legally fill a cross-user cache (section 2). The cache would have to hold evidence or verdicts derived from a vendor with storage rights.

---

## 5. Gemini context caching: 2026 pricing and grounded calls

Source: https://ai.google.dev/gemini-api/docs/pricing (2026-10-01)
- **Gemini 2.5 Flash**: input $0.30/M (text). "Context caching price … $0.03 (text / image / video) $0.1 (audio) $1.00 / 1,000,000 tokens per hour (storage price)". Batch and Flex: same $0.03.
- **Gemini 3.8 Flash**: "$0.075 through December 31, 2026. $0.15 starting January 1, 2027. $0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026. $1.00 … starting January 1, 2027." Input is $0.75/M through 2026, then $1.50.
- **Gemini 3.5 Flash**: cached $0.15, storage $1.00/M/hr. Input $1.50.

Source: https://ai.google.dev/gemini-api/docs/caching ("Last updated 2026-09-02 UTC")
- "Implicit caching is enabled by default for all Gemini 2.5 and newer models. … We automatically pass on cost savings if your request hits caches."
- Minimum tokens: "Gemini 3.8 Flash 4,096 … Gemini 2.5 Flash 2,048".
- "Note: The Interactions API only supports implicit caching. … To use explicit caching, switch to the generateContent API."

Source: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview
- "Implicit caching provides a 90% discount on cached tokens compared to standard input tokens." "There are no storage costs for implicit caching." Explicit: "On Gemini 2.5 or later models, this discount is 90%" with a "default 60 minutes" TTL.

**Does it apply to grounded calls? Unconfirmed.** No Google doc read here mentions grounding together with context caching. **It would not matter for cost:**
- Context caching discounts **input tokens** only. The grounding fee ($35/1k prompts or $14/1k queries) is a separate tool charge.
- "Retrieved context … provided by Grounding with Google Search is not charged as input tokens", so there is no retrieval-token cost to discount.
- Per-claim verify prompts are probably below the 2,048-token minimum for 2.5 Flash, so implicit hits are unlikely. A shared system-prompt prefix of 2,048 tokens or more could hit, but would save about $0.27/M on a cost line that is about 5% of the total.

---

## Not confirmed in this research
- Whether the Gemini Developer API skips billing for 2.5 grounded prompts that return no sources (only Vertex states this).
- Price of Brave's storage-rights plan. Exa enterprise storage terms. Whether Tavily permits storage (no restriction found, which is not the same as permitted). OpenAI web_search storage terms.
- Whether Faultline renders Search Suggestions / `searchEntryPoint` today (code not checked).
- How much verdict accuracy changes when K claims are batched into one grounded prompt (no eval exists).
- Any false-hit measurement on claim-verification workloads (no paper found).
