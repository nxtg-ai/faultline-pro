# Lever 2 (Jev and typed decisions): pre-registration v1

**Backlog:** BLG-NXTG-20261001-001 · **GoPMO:** 1.18.6.1.2 · **Owner:** fp · **Status:** DEFERRED by Asif 2026-10-02 ("BLG it for another time"; reason: Jev saves no money, since it cannot touch the search fee). Registered, not run. Nothing here runs until Asif reopens it; see the brief (`docs/research/2026-10-01-cache-and-jev-brief.md`).
**Registered:** 2026-10-01. The commit that lands this file on `origin/main` is the registration timestamp. Shape follows `~/ASIF/enrichment/2026-09-29-jev-calibration-eval-prereg-v1.md`.
**Canon constraint (Dx3 e2b770ad, 2026-09-20):** the logical component is a vendor-neutral `SemanticDecisionProvider`. Open, self-hosted models are the primary candidates. Jev is a comparator only and never an architectural dependency.

## 0. What shaped the question before registration (disclosed)

1. **A typed classifier cannot search.**
   - About 95% of a paid-grounding scan is the Google Search fee (`docs/unit-economics-prod-default-2026-09-30.md`).
   - Jev, Laya and every judge model here only decide between options for text they are given. They do not touch that fee.
   - Their only seats are: judge a claim against evidence, decide which claims need a search at all, and set when to answer "unverified" (abstain).
2. **Faultline has never measured its own verdict quality.**
   - Today's verdict (`packages/cli/services/geminiService.ts`, `verifyClaim`) returns a status and an explanation, with no probability.
   - The only labelled check is a 5-claim smoke benchmark (`docs/gemini-model-benchmark-results.md`, 14/17 points).
   - Without a baseline on a labelled set, no lever can claim to raise quality.
3. **Google's terms limit what a second model may do with grounded output.**
   - The Gemini API Additional Terms forbid letting anyone "analyze, train on, or otherwise learn from Grounded Results" (https://ai.google.dev/gemini-api/terms).
   - They also forbid "using Links to identify destination pages for crawling or scraping".
   - So a typed judge cannot be fed Gemini's grounded answer or the pages it linked, as written. A judge needs evidence Faultline retrieves itself, from a search API whose terms allow it.
4. **The Jev eval** (`~/ASIF/enrichment/2026-10-01-jev-calibration-eval-results.md`, run `jevcal-d2b-3arm-20261001T043407Z`):
   - Jev is not calibrated: pooled ECE 0.156, overconfident.
   - It matches frontier accuracy on CUAD-style yes/no and 20-way choices at about 1/1,000 of the cost.
   - That ECE was computed on the returned per-option `probabilities` (raw record field `probabilities`), not on Jev's `confidence` statistic, which is a normalised peak (https://docs.typesafe.ai/confidence.md).
5. **Laya's English checkpoint leaves about 320 tokens for the input** (512 total, 192 for options; model card `convaiinnovations/laya`). A claim plus three evidence snippets will often not fit. The multilingual checkpoint allows 1,024 tokens or more. Laya stays an arm because canon names it; the fit risk is disclosed now, before data.
6. **Small open judges match 2024 frontier models on claim-versus-evidence checks** (LLM-AggreFact, https://llm-aggrefact.github.io/, balanced accuracy):

   | Model | Size | Licence | Balanced accuracy |
   |---|---|---|---|
   | FactCG-DeBERTa-L | 0.4B | MIT | 75.6 |
   | MiniCheck-Flan-T5-L | 0.8B | MIT | 75.0 |
   | Granite Guardian 3.3 | 8B | Apache 2.0 | 76.5 |
   | gpt-4o (2024-05-13) | n/a | API | 75.9 |
   | Claude 3.5 Sonnet | n/a | API | 77.2 |

   The board has no 2025–26 models.

## 1. Questions

- **RQ1 (baseline):** How accurate is Faultline's verdict today, per class, on human-labelled claims? How calibrated is a confidence read from it?
- **RQ2 (judge):** Given the same claim and evidence, does an open typed judge give **calibrated** probabilities good enough to drive an abstention gate? How does Jev compare as a comparator?
- **RQ3 (routing, descriptive):** On Faultline's own extracted claims, what share would a typed classifier mark as not needing a search (opinion, prediction, not checkable)?

**Decision this drives:** whether to build a `SemanticDecisionProvider` seat in the verify stage (abstention gate first), which model fills it, and whether it needs the own-retrieval path in the brief.

## 2. Arms

**RQ1, on gold set G (claims only; the arm searches for itself):**

| Arm | What | Probability source |
|---|---|---|
| **G0** | Today's `verifyClaim`, prompt unchanged. This is the **same run** as Lever 1 arm B0, so it is not paid twice | none (label only) |
| **G0v** | G0 plus one added JSON field `confidence` (0–1) in the prompt. Label distribution is compared with G0 to show the prompt change does not move accuracy | verbalised |
| **G0l** | G0 with `responseLogprobs`, **only if** a one-call probe shows Gemini 2.5 Flash returns logprobs together with `googleSearch`. Otherwise it is recorded as infeasible | first-token logprob of the status word |

**RQ2, on the evidence set E (claim plus provided evidence document; no search):**

| Arm | Model (pinned) | Probability source | Runs on |
|---|---|---|---|
| **J-FACTCG** | FactCG-DeBERTa-L | classifier softmax | NXTG-AI 4090 |
| **J-MINICHECK** | MiniCheck-Flan-T5-L | classifier softmax | NXTG-AI 4090 |
| **J-GRANITE** | Granite Guardian 3.3 8B | label-token logprob | NXTG-AI 4090 |
| **J-LAYA** | Laya multilingual (canon candidate), stock, no fine-tune | `noul` probability | NXTG-AI 4090 |
| **J-JEV** (comparator) | `jev-1.13.0` | returned per-option `probabilities` | TypeSafe API, early-access allocation |
| **J-FRONTIER** | `claude-opus-5-5` via `claude -p` | verbalised | subscription, no new spend |

Prompt parity: one instruction text, "Is the claim fully supported by the document? yes / no". No arm gets examples the others do not. Inputs over an arm's context limit are counted as **wrong** and reported as a truncation rate; they are never silently cut.

## 3. Items

**Gold must be human-labelled. No model-made labels.**

| Set | What | Gold | Use | Licence |
|---|---|---|---|---|
| **G** | 300 claims sampled (seeded) from AVeriTeC dev (https://github.com/MichSchli/AVeriTeC) | Human fact-checker labels: Supported / Refuted / Not Enough Evidence / Conflicting, mapped to `supported` / `contradicted` / `unverified` / `mixed` | RQ1, Lever 1 Q1 | CC BY-NC 4.0. **Internal evaluation only; whether evaluating a commercial product counts as non-commercial is Asif's call before admission** |
| **E** | The web-evidence test slices of LLM-AggreFact: ClaimVerify, FactCheck-GPT, ExpertQA (https://huggingface.co/datasets/lytang/LLM-AggreFact). Up to 300 per slice, seeded | Human binary labels | RQ2 | CC BY-ND 4.0: evaluated as-is, no derivative published |
| **F** | 100 claims extracted by Faultline from its own saved live scans (`docs/live-scans/`) and fresh AI answers | Human label by a named labeller **before** any arm runs | RQ3, and a native check on RQ1 | ours |

- **Split:** seeded 20% calibration, 80% test, identical for all arms. Freeze each set with a SHA-256 before the first call.
- **Contamination:** AVeriTeC and LLM-AggreFact are public and may be in training data. F is not. Results on F are reported separately.
- **Weak slices:** date and number claims are tagged and reported as their own sub-slice (Jev's published weak spots). Nothing is pooled to hide a loss.

## 4. Metrics

- **Correctness:**
  - RQ1: 4-class accuracy, macro-F1, recall on refuted claims.
  - RQ2: balanced accuracy (the LLM-AggreFact metric).
- **Calibration (primary for RQ2):** Brier score, ECE with 15 equal-mass bins, reliability curve, NLL. All on **raw** probabilities.
  - Secondary: the same metrics after temperature scaling fitted on the calibration split only. Every arm gets the same treatment.
- **Routing value:** coverage at ≥95% precision (the share of claims a threshold could auto-decide while keeping 95% right) and AURC.
- **Cost and latency:** p50/p95 per decision, list-price dollars, GPU wall-clock with cold load separated.
- **Uncertainty:** 2,000-resample bootstrap 95% CIs. Arm comparisons use a paired bootstrap on per-item Brier differences.

## 5. Hypotheses and bars (fixed before any data)

| ID | Claim | Bar | Verdict words |
|---|---|---|---|
| **H2.0** | Baseline (RQ1) | Descriptive: G0 accuracy, macro-F1, recall on refuted claims; G0v ECE. **No bar.** This is the number Faultline has never had | — |
| **H2.1** | An open judge can drive an abstention gate | On E test, per slice and pooled: balanced accuracy within 3 points of the best arm, **and** ECE ≤ 0.10 after temperature scaling, **and** coverage at ≥95% precision ≥ 0.50 | *qualifies* / *does not*. A pooled pass does not override a slice fail; ExpertQA is reported but excluded from the gate, because no model on the public board passes 61% there |
| **H2.2** | Jev adds value over the best open judge | Jev balanced accuracy minus the best qualifying open judge's ≥ 0.03, paired 95% CI excluding 0 | *material advantage* / *no material advantage*. Even a pass does not make Jev a dependency (canon); it only keeps Jev as a candidate provider |
| **H2.3** | Laya fits the job | Truncation rate ≤ 5% **and** H2.1 | as stated |
| **H2.4** | Routing saves searches (RQ3) | Descriptive: share of F claims a Choice classifier (checkable / opinion / prediction / common knowledge) puts outside "checkable", with its precision against the human label | — |

A missed bar is reported as a miss, with its numbers, and never moved after data is seen. Changes go in §9 with a timestamp and a reason.

## 6. Instruments

- **Reuse first:** kestrel's scorer and certification fields from `~/ASIF/governance/evals/jev-calibration/runs/jevcal-d2b-3arm-20261001T043407Z/` (Brier, ECE equal-mass, AURC, paired bootstrap; born certifiable under `eval-rail-certify.sh` and `asifctl doctor`).
- **The scorer must be able to fail:** sharpen probabilities ×2 on a fixture and ECE and Brier must rise; flip a label and accuracy must fall. Each check is shown red on revert.
- **Per-item raw log:** item id, arm, returned model string, every option probability, answer, latency, tokens, truncation flag, error.
  - For G0/G0v/G0l, only the label and confidence are kept. Grounded text is dropped after scoring (Lever 1 plan §6).
- **Independence:** no arm grades any arm. Labels come from humans. codex reviews the method before the run and the results after it, in neutral wording.

## 7. Where it runs

- The local judges run on NXTG-AI's 4090 under the shared-GPU rule from the Jev prereg §7: free VRAM must be at least model size + 2 GB, nothing runs while SWAY is working, and models unload after the window.
- G0 arms run against the production Gemini project, inside the same daily cap as Lever 1 (≤ 1,000 grounded prompts in one Pacific day, checked against `GET /usage`).

## 8. Spend

- **G0 / G0v:** G0 is shared with Lever 1 B0 (240 test prompts already counted there). G0v adds 240 grounded prompts. **Ceiling if past the free allowance: $10.**
- **Jev:** about 900 calls × ~1.5k tokens × $0.042/M ≈ $0.06 at list price, on the early-access allocation. If TypeSafe usage becomes billable beyond the allocation, the run halts and asks Asif.
- **Local judges:** $0 marginal. **Frontier:** subscription.
- **Human labelling of F:** 100 claims, about 2 hours of a named labeller's time. Asif names the labeller.
- **Total ceiling for this lever: $10 provider spend plus the labelling time.**

## 9. Amendments

- **2026-10-02, prior work disclosed by emma-soul (al:03674ca570bf7fab), before any run.**
  - **No overlap.** No ASIF eval has judged a claim against evidence text, and none has measured Laya. The harness is plain Python (`~/ASIF/evals/jev-calibration/jevcal/`), not Langflow.
  - **Nearest prior.** Part 1 S1-noul: a CUAD yes/no question over a contract excerpt, n=83.
    - Every arm was at least 0.87 accurate.
    - Jev's ECE was 0.077 to 0.102 across three draws.
    - Jev reached 0.81 coverage at 95% precision.
  - **Carry into H2.1/H2.2.** In Part 2 (`~/ASIF/enrichment/2026-10-02-jev-context-eval-results.md`), adding retrieved context raised Jev's mean confidence 25 points on S2c but its accuracy only 4, and ECE went from 0.171 to 0.335. More evidence in the prompt is not assumed to improve calibration.
  - **Reuse when reopened.**
    - Paired bootstrap: 2,000 resamples, seed 20260929, items sorted by id.
    - "CI entirely above 0" is read strictly.
    - Comparators run concurrently, not across runs, because Opus changes its answer on 21% of items when re-asked.
    - `asifctl eval certify`.
    - An independent reproduction before any public claim.
  - Public items and reproducer: https://github.com/nxtg-ai/jev-calibration-eval.
