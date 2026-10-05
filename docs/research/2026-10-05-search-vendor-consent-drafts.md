# Search vendor consent requests

**Status:** AUTHORIZED TO SEND by EMMA-SOUL as principal (`al:f24b3825e397565d`, 2026-10-05). fp sends, from the company address engage@nxtg.ai, signed "The Faultline team, NXTG.AI". The send record is below each message.

~~Each message goes out as Asif, so Asif sends it.~~ Struck 2026-10-05 per the same ruling: this is the retired pattern, and nothing goes to the founder to send.

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

Faultline (https://faultline.nxtg.ai), from NXTG.AI, checks the claims in AI-generated text against evidence from the web. We plan a small, pre-registered research comparison of search sources for claim verification. Ceramic would be used through Cloudflare's Web Search API, alongside Exa, Linkup and Google grounding.

Your Terms of Service (last modified February 27, 2026) §7(g) and (h) restrict benchmarking and publishing performance information without your prior written consent. So we are asking for that consent before we make any call.

What the run would do:
- About 661 searches, one per claim, from a public fact-checking benchmark (Factcheck-Bench), at limit 5.
- We keep only result URLs, our verdict and counts. We do not keep titles or descriptions, and we never show results to anyone outside the run.
- We would publish aggregate measures in our research notes: verdict accuracy, citation rates, latency and cost per check. The method would be published with them so it can be reproduced.

We would be glad to share the results with you before we publish them.

Could you confirm in writing whether Ceramic consents to this use and publication? If it would need an order form or particular conditions, please tell us what they are. If you do not consent, we will leave Ceramic out.

Separately: if the results are good, we would want to keep cited URLs and short snippets in each user's own scan history. That goes beyond §7(p)'s real-time display. What would an order form for that look like?

Thank you,
The Faultline team, NXTG.AI
engage@nxtg.ai

**Send record:** NOT SENT. Zoho SMTP refused `From: engage@nxtg.ai` with `553 Sender is not allowed to relay emails` (internal probe, 2026-10-05). engage@ receives into the axw Zoho mailbox but is not a send-as identity there. Adding it needs a Zoho web login that fp does not hold. Sending from axw@ is the founder's personal line, which is out of scope. Waiting on a one-time "Send mail as engage@nxtg.ai" setup, or a ruling on another channel. EMMA-SOUL then ruled (`al:9b3c4ed2b2019603`) to use Ceramic's own web form at https://ceramic.ai/contact. Checked 2026-10-05 ~20:10Z with browser hands: the page has no message form, only the addresses info@, support@ and sales@ceramic.ai, plus a newsletter Subscribe form (email and terms checkbox). Per the ruling, nothing was submitted, and axw@ was not used. Ceramic waits for engage@ send-as, which EMMA-SOUL is taking to the founder.

**SENT 2026-10-05 20:15:29Z** after EMMA-SOUL added engage@ as an alias of the axw mailbox (`al:70bd40e2e617f67d`).
- From "NXTG.AI <engage@nxtg.ai>", to legal@ceramic.ai, cc sales@ceramic.ai, Reply-To engage@nxtg.ai.
- The committed text above, word for word (1,577 characters).
- Message-ID `<179123132831.4043584.2246987421039214643@nxtg.ai>`. SMTP refused no recipient. Zoho Sent holds exactly 1 message with that Message-ID (IMAP header search, 20:15Z).

---

## 2. Exa (https://exa.ai/contact/sales)

**Subject:** Written permission request: research comparison and storing result URLs (Terms §4.2(a))

Hello,

This follows our note of 2 October 2026 to sales@exa.ai about storage rights for Faultline (https://faultline.nxtg.ai).

We plan a small, pre-registered research comparison of search sources for claim verification. It would use Exa through Cloudflare's Web Search API, alongside other providers and Google grounding. Your Terms §4.2(a) restrict copying and publishing information obtained from the Services without written permission. So we are asking for that permission before we make any call.

What the run would do:
- About 661 searches, one per claim, from a public fact-checking benchmark, at limit 5.
- We keep only result URLs, our verdict and counts in our research files. No titles or highlights are kept, and no results are shown to anyone outside the run.
- We would publish aggregate measures: verdict accuracy, citation rates, latency and cost per check, with the method, so it can be reproduced.

Two questions:
1. Do you grant written permission for this use and publication?
2. Does Zero Data Retention apply to Exa requests made through Cloudflare? Cloudflare's providers page lists Exa as not ZDR, while its changelog says all three providers are.

Thank you,
The Faultline team, NXTG.AI
engage@nxtg.ai

**Send record:** SUBMITTED 2026-10-05 19:59:44Z through https://exa.ai/contact/sales, by fp with browser hands.
- First name "Faultline", last name "Team (NXTG.AI)", email engage@nxtg.ai.
- "How did you hear": Other, "Cloudflare Web Search API providers page".
- Message: the text above, with its subject line prepended (the form has no subject field).

The form showed no acknowledgement. It opened an optional "Talk to Exa (15 mins)" booking window, which fp closed without booking, because a call is outside the authorization. Delivery is unconfirmed, and the form was not resubmitted, to avoid a duplicate.

Fact for the opening line: the 2026-10-02 storage-rights note was sent on 2026-10-02 at 11:08 CDT, to sales@exa.ai from axw@nxtg.ai. An Exa account rep replied the same day. Checked from mailbox headers only.

**Replies (watch, 2026-10-05):**
- Ceramic Legal <legal+noreply@ceramic.ai>, 20:15:33Z: an auto-acknowledgement ("Thank you for reaching out. We'll get back to you as soon as we can."). Not consent.
- Alina Chen (Growth, Exa) <alina@exa.ai> to engage@, 13:16 PDT: "Saw you were looking to connect with us but didn't find a time to chat. Was there anything in particular you were looking to chat about / solve with Exa?" This confirms the form reached Exa. The message text did not reach her.

## 2b. Exa, in-thread answer to Alina Chen

Sent from "Faultline Pro <faultline.pro@nxtg.ai>" (founder ruling 2026-10-05, `al:481a87a5d0db81cc`), in reply to her message. It carries the same request as section 2. No new ask is added.

**Subject:** Re: reaching out from exa

Hi Alina,

Thank you for following up. We do not need a call; the form carried a written request, so here it is in full.

[Section 2 text from "We plan a small, pre-registered research comparison" through the two questions, verbatim.]

Thank you,
The Faultline team, NXTG.AI
faultline.pro@nxtg.ai

**Send record:** SENT 2026-10-05 20:21:51Z, from Faultline Pro <faultline.pro@nxtg.ai> to alina@exa.ai, In-Reply-To her message.
- Message-ID `<179123171082.4097582.15509703900616363352@nxtg.ai>`, 1,231 characters.
- SMTP refused none. Zoho Sent holds exactly 1 message with that Message-ID.

