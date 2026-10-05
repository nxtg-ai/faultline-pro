# Retrieval provider terms read (Cloudflare Web Search, Ceramic.ai, Exa, Linkup)

**Purpose.** This is the terms read required by §7 of the pre-registration, done before any Web Search call. It answers M6 (§4) and the ZDR conflict in §0.
**Pre-registration:** `docs/research/2026-10-05-prereg-retrieval-provider-comparison-v1.md`
**Read date:** 2026-10-05, for every page below. All pages were fetched over HTTPS and converted to text locally. No Cloudflare or provider API was called.
**Status:** not legal advice. This is fp's reading of the published text.
**Re-check of the decisive clauses.** A research agent gathered these quotes. fp re-read the clauses that drive amendment A1 on the primary pages on 2026-10-05:
- **Ceramic §7(g), (h), (o), (p):** from the raw HTML of https://ceramic.ai/terms-of-service, word for word (Last Modified February 27, 2026).
- **Exa §4.2(a) and (f):** from the PDF https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf, word for word.
- **Cloudflare Service-Specific Terms §3,** third-party provider terms bind the customer: from https://www.cloudflare.com/service-specific-terms-developer-platform/.
- **Linkup Terms of Use §4.1, §4.2 and the absence of a benchmarking clause:** from https://www.linkup.so/terms-of-use (Last Updated August 2025), through a fetch summary rather than the raw text.

Other quotes are the agent's and were not re-checked one by one.

**How to read the tables.** "Class" is one of: allowed, forbidden, silent, unclear. Silent means the text does not address the item; silence is not read as permission. Quotes are verbatim. Where a quote is cut, the cut is marked with "...".

**What Faultline would do with a result.** Send a claim as a query; pass `{url, title, description}` to an LLM; show the verdict with cited URLs; possibly (i) keep results in the submitting user's scan history, (ii) cache results and serve them to other users, (iii) show them in share links, and fetch each cited URL once to check it resolves.

## 1. Cloudflare (Web Search API, AI Gateway, Workers AI)

**How the provider terms reach a Cloudflare customer.** The Service-Specific Terms do not name "Web Search API". They cover it through the words "search services" in the "Cloudflare Workers AI; AI Gateway" section:

> "Machine learning models and search services made available by Cloudflare in connection with the Services constitute Third-Party Products (as defined in the Agreement) whether or not you have entered an agreement with the third-party provider. Your use thereof may be subject to additional terms between you and the model or search service provider (as applicable). Where you have not agreed other terms with the model or search service provider, by using such Third-Party Products, you agree to comply with all restrictions, including any acceptable use policies, in the standard terms of the model or search service provider."

So paying with AI Gateway credits does not avoid the provider terms. The restrictions in sections 2 to 4 below apply to Faultline through Cloudflare.

Sources: Service-Specific Terms, "Last updated: September 28, 2026", https://www.cloudflare.com/service-specific-terms-developer-platform/ ; Self-Serve Subscription Agreement, "Last Updated September 12, 2025", https://www.cloudflare.com/terms/ ; Web Search docs (each "Last updated Oct 2, 2026").

| Item | Class | Verbatim quote | URL |
|---|---|---|---|
| (i) Store for submitting user's history | allowed as between Faultline and Cloudflare; the provider terms decide | "As between Cloudflare and you, images, text, and other types of data that you provide as inputs to the Service (“Inputs”) and outputs received from the Services based on your Input (“Outputs”) constitute Customer Content and you retain all applicable intellectual property or other proprietary rights in Inputs and Outputs to or from the Services." Read together with the Third-Party Products clause quoted above. | https://www.cloudflare.com/service-specific-terms-developer-platform/ |
| (ii) Cache and serve to other users | silent (Cloudflare); the provider terms decide | No Cloudflare text addresses it. | same |
| (iii) Share links / third parties | silent (Cloudflare); the provider terms decide | No Cloudflare text addresses it. | same |
| (iv) Display or attribution requirement on the customer | silent | The only attribution text binds the providers, not the customer: "Every Web Search API provider has committed to meet the following standards: ... **Source attribution** — Every search result must include a link to the location of the crawled content." | https://developers.cloudflare.com/web-search/about/ |
| (v) Fetch or crawl result URLs | silent | No text on the customer fetching result URLs. The crawler text is about the providers' crawlers: "The crawler the provider uses must meet Cloudflare's published requirements for verified bots ... This includes identifying the crawler and respecting `robots.txt`." | https://developers.cloudflare.com/web-search/about/ |
| (vi) Retention: Cloudflare's own logs | allowed to turn off | "Records the request in your AI Gateway logs and bills it to your account." (about page). "The `cf-aig-collect-log` header allows you to bypass the default log setting for the gateway. If the gateway is configured to save logs, the header will exclude the log for that specific request." (logging page). | https://developers.cloudflare.com/web-search/about/ ; https://developers.cloudflare.com/ai-gateway/observability/logging/ |
| (vi) Retention: Cloudflare DPA does not cover the providers | n/a (fact) | "By using such features, you (i) direct Cloudflare to send certain of your Customer Data to the relevant Third-Party Product provider in order to provide the Service and (ii) understand and agree that the Cloudflare Data Processing Addendum and Information Security Exhibit do not apply to your use of such Third-Party Products accessed via AI Gateway." | https://www.cloudflare.com/service-specific-terms-developer-platform/ |
| (vi) ZDR claim, changelog | n/a (claim) | "All three support Zero Data Retention for requests made through Cloudflare, and all have committed to Cloudflare's verified bot crawling standards." (entry "Introducing Web Search API", Oct 2, 2026) | https://developers.cloudflare.com/changelog/ |
| (vi) ZDR claim, providers page | n/a (claim) | Ceramic.ai: "Zero Data Retention \| Yes"; Exa: "Zero Data Retention \| No"; Linkup: "Zero Data Retention \| Yes". | https://developers.cloudflare.com/web-search/providers/ |
| (vii) Training by Cloudflare | n/a (Cloudflare's own conduct) | "Unless otherwise agreed, Cloudflare does not use any Customer Content to train generative AI tools." | https://www.cloudflare.com/service-specific-terms-developer-platform/ |
| (vii) Benchmarking Cloudflare | allowed, with conditions | "You are permitted to perform benchmark tests of our Services. If you disclose results of any benchmark tests of our Services performed by you or a third party under your direction, you (i) will include in any disclosure or otherwise make available all information necessary to replicate such benchmark tests, and (ii) agree that we may perform and disclose the results of benchmark tests of your services, irrespective of any restrictions on benchmarks in the terms governing your services." This covers Cloudflare's Services. It does not lift a provider's own restriction (see the Third-Party Products clause). | https://www.cloudflare.com/terms/ |

## 2. Ceramic.ai

Source: Terms of Service, "Last Modified: February 27, 2026", https://ceramic.ai/terms-of-service (served at https://www.ceramic.ai/terms-of-service; linked from the Cloudflare providers page). Section numbers follow the terms' own cross-references ("the restrictions set forth in Section 7"; "Section 9").

Definition: "“Output” means any results, responses, or content generated by the Services based on your Input." Search results are named as Output in 7(n): "Output, including search results, relevance scores, or rankings".

| Item | Class | Verbatim quote | URL |
|---|---|---|---|
| (i) Store for submitting user's history | forbidden (unless an Order Form permits) | 7(p): "retain, cache, or store Output beyond what is reasonably necessary to display such Output to your authorized end users in the ordinary and real-time course of use, unless expressly permitted in an applicable Order Form." | https://ceramic.ai/terms-of-service |
| (ii) Cache and serve to other users | forbidden | 7(p) as above, and 7(o): "you may display Output to your authorized end users within your own application so long as such Output is integrated into your application's functionality, is incident to the end user’s real-time query, and is not independently accessible, extractable, or downloadable by end users or third parties". | same |
| (iii) Share links / third parties | forbidden | 7(o): "resell, syndicate, or otherwise make Output available to any third party on a standalone basis or as a separately accessible component of another product or service; provided that you may display Output to your authorized end users within your own application so long as such Output is integrated into your application's functionality, is incident to the end user’s real-time query, and is not independently accessible, extractable, or downloadable by end users or third parties". | same |
| (iv) Display / attribution | allowed only under conditions | Display: the 7(o) proviso above. Notices: 7(f): "remove or obscure any proprietary or other notices contained in the Services". No requirement to show a Ceramic brand or link was found. | same |
| (v) Fetch or crawl result URLs | silent | No text addresses fetching the URLs in Output. | same |
| (vi) Retention / ZDR | unclear | Terms 9.2: "You hereby grant Ceramic a non-exclusive, worldwide, royalty-free license to use Your Content: (i) to provide, operate, and manage the Services for you, including to service or execute any support request; and (ii) in de-identified or aggregated form, to improve Ceramic’s services and offerings and for other business purposes." Docs: "Ceramic.ai is designed with Zero Data Retention in mind. If ZDR is a requirement for your use case, please contact us to discuss your timeline and enterprise options." Nothing from Ceramic mentions requests made through Cloudflare. | https://ceramic.ai/terms-of-service ; https://docs.ceramic.ai/admin/security.md |
| (vii) Training on results | forbidden (competing products; datasets) | 7(l): "use Output (as defined below) to develop, train, or improve competing products or services". 7(n): "collect, aggregate, store, or compile Output, including search results, relevance scores, or rankings, for the purpose of creating or contributing to any database, dataset, index, or corpus, whether or not such database, dataset, index, or corpus is used for a purpose that competes with Ceramic". | https://ceramic.ai/terms-of-service |
| (vii) Benchmarking / publishing comparisons | forbidden (without written consent) | 7(g): "use the Services for competitive analysis, benchmarking, or to build competitive products or services". 7(h): "publicly disseminate information regarding the performance of the Services without Ceramic's prior written consent". | same |
| Related: Personal Data | condition | 9.5: "Customer shall not submit Personal Data (as defined by applicable privacy laws) to the Services unless Customer has first requested and executed a Data Processing Agreement with Ceramic by contacting legal@ceramic.ai." | same |

## 3. Exa

Source: Exa Labs Terms of Service (PDF), https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf (https://exa.ai/terms redirects there; linked from the Cloudflare providers page). The PDF shows no "Last Revised" date on its pages. Its PDF metadata CreationDate is 2025-03-04; that is file metadata, not a stated revision date.

Definition, 1.2(a): "the Search Engine will use artificial intelligence tools and functionalities to generate responses and produce search results based on your User Input (“Output”)."

| Item | Class | Verbatim quote | URL |
|---|---|---|---|
| (i) Store for submitting user's history | forbidden (without written permission) | 4.2(a): "download, modify, copy, distribute, transmit, display, perform, reproduce, duplicate, publish, license, create derivative works from, or offer for sale any information contained on, or obtained from or through, the Services, except for temporary files that are automatically cached by your web browser for display purposes, or as otherwise expressly permitted in these Terms or by us in writing". 4.2 opens: "unless applicable laws or regulations prohibit these restrictions or you have our written permission to do so". | https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf |
| (ii) Cache and serve to other users | forbidden (without written permission) | 4.2(a) as above. | same |
| (iii) Share links / third parties | forbidden (without written permission) | 4.2(a) as above ("distribute, transmit, display ... publish"). | same |
| (iv) Display / attribution | unclear | 4.2(a) lists "display" among forbidden acts for information obtained from the Services, except browser cache "for display purposes" or as "expressly permitted in these Terms". 1.1 licenses API use only "for the limited purposes set forth in the documentation for the Services". 4.1: "a personal, non-assignable, non-sublicensable, non-transferrable, and non-exclusive right and license to access and display such software, content and materials provided to you as part of the Services, in each case, for the sole purpose of enabling you to use the Services as permitted by these Terms." No attribution requirement found. | same |
| (v) Fetch or crawl result URLs | silent | No text addresses fetching the URLs in Output. 4.2(j) is about scraping the Services themselves: "use any robot, spider, crawlers, scraper, or other automatic device, process, software or queries that intercepts, “mines,” scrapes, extracts, or otherwise accesses the Services to monitor, extract, copy or collect information or data from or through the Services". | same |
| (vi) Retention / ZDR | unclear (conflict) | Terms 1.2(c): "You grant us a nonexclusive, royalty-free, transferable, sub-licensable, worldwide, perpetual and irrevocable license to access, use, host, cache, store, reproduce, transmit, display, publish, distribute, and modify any User Input and Output as needed to provide, develop and improve upon our products and services". Docs: "Zero Data Retention (ZDR) is available on Enterprise plans and enabled per team. Contact sales@exa.ai for details." (Search: "Available"). Nothing from Exa mentions requests made through Cloudflare. Cloudflare's changelog says Yes; Cloudflare's providers page says No. | https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf ; https://exa.ai/docs/admin/security/zero-data-retention.md |
| (vii) Training on results | forbidden for a competitive product; otherwise silent | 4.2(f): "access, use or exploit the Services (including Output) to develop any competitive product or service". | https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf |
| (vii) Benchmarking / publishing comparisons | benchmarking silent; publishing Output forbidden | No benchmarking clause. Publishing Output falls under 4.2(a) ("publish ... any information ... obtained from or through, the Services"). Whether aggregate scores count as "information obtained from" the Services is unclear. | same |
| Related: DPA | not found | 5.4: "you agree to comply with the terms of the then-current Data Processing Agreement (“DPA”) available at [LINK]." The link is a literal placeholder in the PDF. | same |

## 4. Linkup

Source: "Linkup Client General Terms and Conditions (last updated as noted in the document below)", https://www.linkup.so/terms-of-use (linked from the Cloudflare providers page). No date appears on the page. Linkup's docs link a Notion copy, which renders only with JavaScript and was not read.

**Which object Faultline receives.** Cloudflare calls Linkup with "`fast` search depth with raw search results, so Linkup returns results without generating an answer" (providers page). The terms define two objects:
- Answers: "means the answer provided by Linkup Solution to a Client's question on the basis of Linkup AI system."
- Open Web Content: "means the content accessible via the web, verified by Linkup under the conditions provided in article 4.1, and accessed by Client through Linkup Solution and/or used by Linkup to provide Answers, under the terms of this Agreement."
- The service returns "(i) the list of relevant sources, i.e. URL links to Open Web Content".

fp's reading: the `title` and `description` text is Open Web Content, so the Open Web Content clauses govern it, not the Answers clauses. A URL is a link to Open Web Content, a separate object; the terms do not restrict it directly.

| Item | Class | Verbatim quote | URL |
|---|---|---|---|
| (i) Store for submitting user's history | forbidden (description/title text); silent (URLs) | "Client shall (i) check that the Open Web Content is lawfully accessible; (ii) limit its use of such content to reproduction and extraction for the sole purpose of text and data mining, ie. automated analytical technique aimed at analysing text and data in digital form in order to generate information which includes but is not limited to patterns, trends and correlations; and (iii) retain Open Web Content for as long as is necessary for the purposes of text and data mining only." | https://www.linkup.so/terms-of-use |
| (ii) Cache and serve to other users | forbidden (description/title text); silent (URLs) | "Client acknowledges and agrees that it is not authorized to use, including to distribute, Open Web Content for any purpose other than strictly specified above." | same |
| (iii) Share links / third parties | forbidden (description/title text); silent (URLs) | Same clause as (ii). Also: "Client shall not, directly or indirectly, use Open Web Content for purpose other than text and data mining authorized by Article 4 of EU Copyright Directive 2019/790." | same |
| (iv) Display / attribution | unclear | Showing description text to the submitting user is a use beyond automated analysis, so it is at best unclear under the TDM-only clause above. No attribution requirement found. | same |
| (v) Fetch or crawl result URLs | silent | No text addresses the client fetching the source URLs. The nearest text concerns the content, not the act of fetching: "Client shall (i) check that the Open Web Content is lawfully accessible". | same |
| (vi) Retention / ZDR | unclear | Terms: "Client grants Linkup a worldwide right to use, reproduce and modify the Client Data, including prompts, for the purposes of providing, maintaining, developing, training and improving the Linkup Solution." Docs: "ZDR can be requested on demand. It is not enabled by default." and "When ZDR is enabled: ... **No query logging**: Search queries are not logged or stored on Linkup systems ... **No result retention**: Results are not retained after delivery to the client". Nothing from Linkup mentions requests made through Cloudflare. | https://www.linkup.so/terms-of-use ; https://docs.linkup.so/pages/security-and-privacy/data-processing-privacy |
| (vii) Training on results | forbidden beyond TDM (Open Web Content); training on Answers not addressed | Open Web Content is limited to TDM (quotes above). Answers: "Client shall not resell, sublicense, or otherwise make available the Answers in a manner that amounts to providing a substantially similar or competing service to Linkup Solution (including, without limitation, acting as a wrapper of the Linkup APIs)." | https://www.linkup.so/terms-of-use |
| (vii) Benchmarking / publishing comparisons | silent | No benchmarking or performance-publication clause found. | same |

## 5. Summary across parties

| Item | Cloudflare | Ceramic.ai | Exa | Linkup |
|---|---|---|---|---|
| (i) Store in submitting user's history | allowed vs Cloudflare; provider terms bind | **forbidden** beyond real-time display, unless an Order Form permits (7(p)) | **forbidden** without written permission (4.2(a)) | **forbidden** for description/title beyond TDM; URLs silent |
| (ii) Cache across users | silent; provider terms bind | **forbidden** (7(o), 7(p)) | **forbidden** without written permission (4.2(a)) | **forbidden** for description/title; URLs silent |
| (iii) Share links / third parties | silent; provider terms bind | **forbidden** (7(o)) | **forbidden** without written permission (4.2(a)) | **forbidden** for description/title; URLs silent |
| (iv) Display / attribution | silent (attribution binds providers) | allowed only integrated, real-time, not extractable (7(o)) | unclear (4.2(a) lists "display") | unclear (TDM-only use) |
| (v) Fetch result URLs | silent | silent | silent | silent |
| (vi) ZDR through Cloudflare | changelog: all three Yes; providers page: Ceramic Yes, Exa No, Linkup Yes | unclear: own docs say ZDR is by contact / enterprise | **unclear (conflict)**: own docs say Enterprise only, per team; no Cloudflare mention | unclear: own docs say on request, not default |
| (vii) Training | Cloudflare does not train on Customer Content | **forbidden** for competing products and for any dataset (7(l), 7(n)) | forbidden for a competitive product (4.2(f)) | forbidden beyond TDM (Open Web Content) |
| (vii) Benchmark / publish comparison | allowed for Cloudflare, with replication info (SSA 2.2.2) | **forbidden** without written consent (7(g), 7(h)) | benchmarking silent; publishing Output forbidden (4.2(a)) | silent |

**What this means for the pre-registration (fp's reading, for the owner to rule on):**
- Ceramic's terms forbid "benchmarking" and forbid publicly disseminating "information regarding the performance of the Services" without written consent. The Cloudflare SST binds Faultline to those restrictions. The planned comparison is a benchmark of Ceramic. It needs Ceramic's written consent, or the Ceramic arm comes out, before the first call.
- Every provider forbids or restricts storing results and serving them across users. The §7 fallback ("Only URLs, statuses and counts are stored") is consistent with Linkup's text. For Exa, 4.2(a) covers "any information ... obtained from" the Services, which on its face includes URLs; written permission would remove the doubt.
- Exa's own text does not support ZDR through Cloudflare. Treat Exa as not ZDR until Exa or Cloudflare says otherwise in writing.

## 6. Not found / unclear

- **Exa ZDR through Cloudflare.** No Exa text mentions Cloudflare. Cloudflare's changelog ("All three support Zero Data Retention for requests made through Cloudflare") and providers page ("Exa ... Zero Data Retention | No") disagree. Both are dated Oct 2, 2026. Unresolved.
- **Ceramic and Linkup ZDR "Yes".** The providers page's Yes rests on Cloudflare's page alone. Both providers' own docs describe ZDR as on request or by contact, not default. No provider text confirms ZDR for requests made through Cloudflare.
- **Web Search API is not named in the Cloudflare SST.** It is covered by the words "search services" in the Workers AI; AI Gateway section.
- **Exa revision date.** No "Last Revised" date appears on the PDF. Only PDF metadata (CreationDate 2025-03-04) was found.
- **Exa DPA.** §5.4 links to "[LINK]", a placeholder. No DPA text found.
- **Linkup terms date.** The page says "last updated as noted in the document below" but shows no date.
- **Linkup terms, Notion copy.** Renders only with JavaScript; the server returned no terms text. Not read. The www.linkup.so copy was read instead.
- **Whether Linkup raw results are Open Web Content.** fp reads `title`/`description` as Open Web Content; the terms do not name search-result snippets explicitly.
- **Fetching result URLs (item v).** None of the four texts addresses it. This is silence, not permission.
- **Vendor replies.** None received as of 2026-10-05 (outreach 2026-10-02, follow-up PRM-NXTG-20261002-01 due 2026-10-15).

## 7. URLs tried (2026-10-05)

| URL | Result |
|---|---|
| https://www.cloudflare.com/service-specific-terms-developer-platform/ | 200, read |
| https://www.cloudflare.com/terms/ | 200, read (Self-Serve Subscription Agreement) |
| https://www.cloudflare.com/legal/terms/ | 200, index of agreements only |
| https://www.cloudflare.com/policies/terms/ | 200, website Terms of Use (linked from Web Search docs; not service terms) |
| https://developers.cloudflare.com/web-search/ (and index.md) | 200, read |
| https://developers.cloudflare.com/web-search/about/index.md | 200, read |
| https://developers.cloudflare.com/web-search/providers/ (and index.md) | 200, read |
| https://developers.cloudflare.com/web-search/how-to-use/ (and index.md) | 200, read |
| https://developers.cloudflare.com/changelog/ | 200, read (Web Search entry, Oct 2, 2026) |
| https://developers.cloudflare.com/ai-gateway/observability/logging/index.md | 200, read |
| https://ceramic.ai/terms | 404 (redirected to www.ceramic.ai/terms) |
| https://ceramic.ai/terms-of-service | 200, read (served at www.ceramic.ai) |
| https://docs.ceramic.ai/llms.txt | 200, index |
| https://docs.ceramic.ai/admin/security.md | 200, read |
| https://exa.ai/terms | 200, redirects to the PDF below |
| https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf | 200, read (8 pages) |
| https://exa.ai/docs/llms.txt | 200, index |
| https://exa.ai/docs/admin/security/zero-data-retention.md | 200, read |
| https://exa.ai/docs/admin/security/overview.md | 200, fetched |
| https://www.linkup.so/terms | 404 |
| https://www.linkup.so/terms-of-use | 200, read |
| https://linkup-platform.notion.site/Linkup-Client-General-Terms-and-Conditions-13f161ecef69806784dfe808b4e162a1 | 200, JavaScript shell only, no terms text |
| https://docs.linkup.so/pages/security-and-privacy/overview.md | 200, read |
| https://docs.linkup.so/pages/security-and-privacy/data-processing-privacy.md | 200, read |
