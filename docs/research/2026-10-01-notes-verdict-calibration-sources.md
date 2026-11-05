# Typed decision models (Jev / Laya) for Faultline verdict quality — primary-source research

Date: 2026-10-01. Read-only web research. Every number below cites the page it came from.
Markers: **[confirmed]** = read on the primary page this session; **[unconfirmed]** = from memory, a search snippet, or a summariser I could not check against the source; **[not found]** = looked, absent.

## 0. Bottom line

1. **A typed classifier cannot retrieve.** It judges (claim, evidence) handed to it. It cannot replace Gemini grounding, which is where the search fee and the evidence come from. It can do three things: (a) re-judge Gemini's verdict against the returned evidence and output a probability, (b) decide *before* search which claims are unverifiable / not check-worthy / answerable from parametric knowledge, (c) gate abstention ("unverified") with a calibrated threshold.
2. **The proven small-verifier class is NLI-style grounding checkers, not general typed-decision APIs.** On LLM-AggreFact, open 0.4B–8B checkers (FactCG-DeBERTa-L 75.6, MiniCheck-FT5 75.0, Granite Guardian 3.3 76.5, Bespoke-MiniCheck-7B 77.4) match or beat 2024 frontier models (gpt-4o-2024-05-13 75.9, Claude-3.5 Sonnet 77.2). Neither Jev nor Laya has any published fact-verification or grounding result.
3. **Label-space mismatch.** LLM-AggreFact and every verifier on it are **binary** (supported / not supported). Faultline returns four classes. None of the leaderboard checkers separates *contradicted* from *unverified*. A Jev `Choice` (supports / contradicts / says nothing) can express it, and TypeSafe's own citation-check cookbook does exactly this, but on 8 citations only.
4. **Calibration is not free.** Jev's raw calibration has been measured by three different evals at ECE 0.144, 0.156 (your internal) and 0.246. Laya ships over-confident (mean ECE 0.466 before temperature fitting). Either way a Faultline-labelled calibration set is required before any probability is shown to a user. Temperature scaling on that set is the standard fix (Guo et al. 2017).
5. **Gold set:** for (claim, real-world web evidence, NEI/mixed class) the best fits are **AVeriTeC** (4 labels incl. *Not Enough Evidence* and *Conflicting/Cherry-picking*, but CC BY-NC 4.0) and the web-evidence slices of **LLM-AggreFact** (ClaimVerify, FactCheck-GPT, ExpertQA; binary; CC BY-ND 4.0). Factcheck-Bench (94 ChatGPT responses, Apache-2.0 repo) is the closest match to "AI output checked against the open web".
6. **Cheapest possible confidence signal (unconfirmed, check first):** Gemini exposes `responseLogprobs`/`logprobs`. If they work alongside the `googleSearch` tool on gemini-2.5-flash, Faultline gets a token-probability on the verdict word with no second model. Not verified for the grounded + 2.5-flash combination.

---

## 1. SOTA small fact-checking / grounding verifiers

### 1.1 LLM-AggreFact leaderboard — full scrape [confirmed]
Source: https://llm-aggrefact.github.io/ (I parsed the page's embedded `scoresData` for all 39 models; averages recomputed over 11 datasets and they match the displayed values). Benchmark paper: MiniCheck, https://arxiv.org/abs/2404.10774 (Tang, Laban, Durrett, EMNLP 2024). Metric: balanced accuracy (BAcc), majority baseline 50%.

**Currency caveat:** the page has no date. The newest entries are Claude-3.5 Sonnet, gpt-4o-2024-05-13, Llama-3.3, Qwen2.5, QwQ-32B-Preview, Granite Guardian 3.3. There are **no 2025–26 frontier models** (no Gemini 2.x, GPT-5, Claude 4.x). "Matches GPT-4-class" therefore means matches **2024** frontier. Gemini appears only as the 2023 "Gemini-Pro" (65.4).

Columns ClaimVerify, FactCheck(-GPT) and ExpertQA are the **web-evidence** subsets (per the HF dataset card), which is the closest match to Faultline's task.

| Model | Size | Avg BAcc | ClaimVerify | FactCheck | ExpertQA | Licence |
|---|---|---|---|---|---|---|
| Bespoke-MiniCheck-7B | 7B | **77.4** | 75.3 | 77.7 | 59.2 | CC BY-NC 4.0, commercial by contact |
| Claude-3.5 Sonnet | – | 77.2 | 71.4 | 77.8 | 60.9 | API |
| Granite Guardian 3.3 | 8B | 76.5 | 75.9 | 76.1 | 59.6 | Apache 2.0 |
| Mistral-Large 2 | 123B | 76.5 | 71.8 | 74.5 | 60.8 | – |
| gpt-4-turbo-preview | – | 76.2 | 67.6 | 79.9 | 59.2 | API |
| gpt-4o-2024-05-13 | – | 75.9 | 69.0 | 77.5 | 59.6 | API |
| **FactCG-DeBERTa-L** | **0.4B** | **75.6** | **78.5** | 72.1 | 59.1 | MIT (HF + GitHub) |
| Qwen2.5-72B-Instruct | 72B | 75.6 | 70.0 | 77.0 | 60.1 | – |
| **MiniCheck-Flan-T5-L** | **0.8B** | **75.0** | 74.6 | 74.7 | 59.0 | MIT (HF card), Apache-2.0 (repo) |
| gpt-4o-mini-2024-07-18 | – | 74.0 | 69.8 | 76.0 | 58.3 | API |
| MiniCheck-RoBERTa-L | 0.4B | 73.5 | 77.4 | 73.3 | 57.4 | – |
| HHEM-2.1-open | 0.1B | 71.8 | 73.9 | 71.8 | 58.4 | Apache 2.0 |
| AlignScore | 0.4B | 70.5 | 69.6 | 74.3 | 58.3 | – |
| Gemini-Pro (2023) | – | 65.4 | 61.8 | 76.8 | 56.8 | API |

Takeaways:
- **ExpertQA is a ceiling for everyone: max 61.0 BAcc across all 39 models** (49.9–61.0), Claude-3.5 included. Expert-domain claims against web evidence are close to coin-flip for every judge on this board. That is the honest ceiling for that slice; a typed classifier is not going to beat it.
- On **ClaimVerify** (web-evidence subset; gloss "claims from generative search engines vs cited pages" [unconfirmed]; the closest analogue to Faultline), small fine-tuned checkers **beat** frontier models: FactCG 78.5, MiniCheck-RoBERTa 77.4, Granite 75.9 vs gpt-4o 69.0, Claude-3.5 71.4.
- On FactCheck-GPT, frontier models lead (gpt-4-turbo 79.9) over small checkers (72–75).

### 1.2 Model specifics
- **MiniCheck** (Tang, Laban, Durrett, EMNLP 2024) — https://arxiv.org/abs/2404.10774 [confirmed]. MiniCheck-FT5 (770M) "reaches GPT-4 accuracy", "GPT-4-level performance but for 400x lower cost". Code: https://github.com/Liyan06/MiniCheck (Apache-2.0). Throughput: Bespoke-7B on the 29K test set on one A6000 takes 30 min with prefix caching, 55 min without (repo README).
- **Bespoke-MiniCheck-7B** — https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B [confirmed]. Fine-tuned from InternLM2.5-7B-chat. 32K-token documents without chunking. Returns a label plus raw probability (e.g. `[0.984, 0.011]`). ">500 documents per minute on a single A6000" with vLLM. **CC BY-NC 4.0**, so commercial use needs a licence from Bespoke Labs.
- **FactCG** (Lei et al., NAACL 2025) — https://arxiv.org/abs/2501.17144, https://aclanthology.org/2025.naacl-long.258/ [confirmed]. Synthetic multi-hop training data from context graphs (CG2C). "Outperforms GPT-4-o on the LLM-AggreFact benchmark with much smaller model size." MIT.
- **HHEM-2.1-open** (Vectara) — https://huggingface.co/vectara/hallucination_evaluation_model [confirmed]. Flan-T5-base, 0.1B, <600MB RAM, Apache 2.0, score 0–1, about 1.5 s for 2k tokens on a CPU. Its card claims 76.55% BAcc on "AggreFact-SOTA" vs GPT-4 73.78%. Careful: that is the **older AggreFact**, not LLM-AggreFact. On LLM-AggreFact it scores 71.8.
- **Granite Guardian 3.3 8B** (IBM) — https://huggingface.co/ibm-granite/granite-guardian-3.3-8b, paper https://arxiv.org/abs/2412.07724 [confirmed]. Apache 2.0. Groundedness risk returns yes/no in `<score>` tags. The card reports 0.761 BAcc (no-think) and 0.765 (think) "across 12 benchmarks"; the board shows 76.5 over 11 (card and board differ slightly). It documents no per-claim probability.
- **AlignScore** (Zha et al., ACL 2023 [unconfirmed]) — leaderboard 70.5. Repo https://github.com/yuh-zha/AlignScore. I did not open the paper.
- **Lynx** (Patronus AI; Ravi et al. 2024 [authors unconfirmed]) — https://arxiv.org/abs/2407.08488 [confirmed abstract]. "Outperforms GPT-4o, Claude-3-Sonnet" on HaluBench (15k samples). 8B weights are **CC BY-NC 4.0** (HF API). Sizes 8B/70B and per-size accuracy **[unconfirmed]**: the abstract does not give them. Lynx is not on LLM-AggreFact.
- **Paladin-mini** — https://arxiv.org/abs/2506.20384 [confirmed abstract]. 3.8B, Phi-4-mini-instruct base, grounded/ungrounded classifier, evaluated on its own "grounding-benchmark". Not on LLM-AggreFact. Numbers **[not found]**.

### 1.3 Cost and latency vs a GPT-4-class judge
- MiniCheck paper: 400x cheaper than GPT-4 at equal accuracy [confirmed].
- Jev: **$0.042 per million input tokens**, output free (https://docs.typesafe.ai/models.md) [confirmed]. One (claim + 3 snippets, about 1.5k tokens) call costs about $0.00006. p50 latency is 236–316 ms in third-party measurements (§5).
- Laya self-hosted: 32.8 ms per question on a T4 (model card) [confirmed].

---

## 2. Calibration and selective prediction for claim verification

### 2.1 Verbalised vs logit confidence
- **Tian et al., "Just Ask for Calibration", EMNLP 2023** — https://arxiv.org/abs/2305.14975 [confirmed]. For RLHF models (ChatGPT, GPT-4, Claude), verbalised confidences are typically *better* calibrated than conditional token probabilities, cutting ECE by about 50% relative on TriviaQA, SciQ and TruthfulQA. RLHF damages token-probability calibration.
- **Xiong et al., ICLR 2024** — https://arxiv.org/abs/2306.13063 [confirmed]. Verbalised confidence is overconfident. Consistency across samples plus aggregation helps. White-box vs black-box AUROC is only 0.522 vs 0.605.
- **Kadavath et al. 2022, "Language Models (Mostly) Know What They Know"** — https://arxiv.org/abs/2207.05221 [confirmed]. Large base models are well calibrated on multiple-choice and true/false questions *when asked in the right format*; P(True) self-evaluation.
- **PCC: Wang et al., Jan 2026, "Fact-Checking with LLMs via Probabilistic Certainty and Consistency"** — https://arxiv.org/abs/2601.02574, html https://arxiv.org/html/2601.02574 [confirmed via summariser of the HTML; exact per-model cells not re-checked]. **This is the most Faultline-relevant result: it tests Gemini-2.5-Flash, Gemini-2.5-Pro, GPT-4o, GPT-4o-mini and Mistral-7B.**
  - Verbalised-confidence ECE in fact-checking: SciFact 0.235–0.371, FeLM-WK 0.196–0.455, HoVER 0.383–0.469 (range across models).
  - PCC (token-probability certainty + reasoning consistency): SciFact 0.129–0.335, FeLM-WK 0.152–0.329, HoVER 0.208–0.316.
  - Routes claims three ways: answer directly / targeted retrieval / deeper search. **The fraction of claims retrieved is [not found] in the paper summary.**
  - Small samples: 187 SciFact and 190 HoVER claims.
  - Implication: Gemini 2.5 Flash's verbalised confidence on fact-check verdicts is expected to land around ECE 0.2–0.45. Jev's 0.156 is not worse than that, but it is not "calibrated" either.
- **Guo et al., ICML 2017, "On Calibration of Modern Neural Networks"** — https://arxiv.org/abs/1706.04599 [confirmed]. Temperature scaling (one parameter) is "surprisingly effective". This is the standard post-hoc fix and the one Laya uses (§5).
- **Yuan et al. 2024, fact-level calibration (ConFix)** — https://arxiv.org/abs/2411.13343 [confirmed abstract]. Calibrates to relevance-weighted correctness per atomic fact in long-form output.

### 2.2 Conformal factuality
- **Mohri & Hashimoto 2024, "Language Models with Conformal Factuality Guarantees"** (ICML 2024 [venue unconfirmed; arXiv page lists cs.LG]) — https://arxiv.org/abs/2402.10978 [confirmed]. Back-off: drop low-score claims until a held-out-calibrated threshold gives P(all remaining claims correct) ≥ 1−α. Reaches "80–90% correctness guarantees while retaining the majority of the LM's original output" on FActScore bios, NQ and MATH. Black box; needs only a small labelled calibration set.
  - Faultline mapping: per-claim score = verifier probability; calibrate a threshold on a labelled set; claims under the threshold become "unverified". The guarantee is marginal (averaged), not per claim.
- **Cherian, Gibbs, Candès, NeurIPS 2024** — https://arxiv.org/abs/2406.09714 [confirmed]. Conditional (topic-adaptive) validity, and keeps more true claims than Mohri & Hashimoto.
- Background, not fetched [unconfirmed IDs]: Geifman & El-Yaniv 2017, *Selective Classification for Deep Neural Networks*, https://arxiv.org/abs/1705.08500 (risk-coverage framework). Angelopoulos et al., *Conformal Risk Control*, https://arxiv.org/abs/2208.02814.

### 2.3 Selective fact-checking / abstention
- **Yang 2026, "Calibrated Selective Fact-Checking via Evidence Chain Evaluation"** — https://arxiv.org/abs/2607.18240 [confirmed abstract; WEAK source: single author, 95 claims]. Tool-using web-search verifier. Coverage 93.7%, selective accuracy 97.8% vs 91.6% unconditional, 6 of 95 deferred. The summariser gave the submit date as "April 15 2026", which conflicts with the 2607 arXiv ID **[unresolved]**.
- Other 2026 abstention papers found but not read: https://arxiv.org/abs/2609.17516 (Chain-of-Self-Questioning, risk-coverage), https://arxiv.org/abs/2605.02915 (same-model self-verification as a confidence signal), https://arxiv.org/abs/2603.21172 (entropy alone is insufficient for safe selective prediction) **[unconfirmed contents]**.

---

## 3. Check-worthiness and claim routing (what retrieval can be skipped)

| Approach | Source | What it skips | Measured saving | Quality cost |
|---|---|---|---|---|
| **Adaptive-RAG** (Jeong et al., NAACL 2024) | https://arxiv.org/abs/2403.14403, tables in https://arxiv.org/html/2403.14403 [confirmed] | T5-Large (770M) classifier routes each query to no-retrieval / single-step / multi-step | GPT-3.5: **1.03 vs 2.81 steps (−63%)**, time 1.46 vs 3.33 (−56%) against always-multi-step. FLAN-T5-XL: 2.17 vs 4.69 steps (−54%), time 3.60 vs 8.81 | GPT-3.5: F1 50.91 vs 50.87 (no loss). FLAN-T5-XL: 46.94 vs 48.85 (−1.9 F1). Classifier accuracy is only 54.5% |
| **Mallen et al., ACL 2023, "When Not to Trust LMs"** | https://arxiv.org/abs/2212.10511 [confirmed abstract] | Retrieve only for low-popularity entities (PopQA, 14k questions) | "improves performance while reducing inference costs". Exact % **[not found in abstract]** | – |
| **Self-RAG** (Asai et al.; venue ICLR 2024 [unconfirmed], arXiv Oct 2023) | https://arxiv.org/abs/2310.11511 [confirmed abstract] | Reflection tokens decide whether to retrieve | Retrieval frequency **[not found]** | – |
| **PCC** (2026) | https://arxiv.org/abs/2601.02574 | Confidence-routed retrieval for fact-checking | "retrieval is invoked only when necessary"; fraction **[not found]** | +15.2% relative on False claims vs FIRE (HoVER) |
| **VeriScore** (Song, Kim, Iyyer, Findings EMNLP 2024) | https://aclanthology.org/2024.findings-emnlp.552/, https://arxiv.org/abs/2406.19276 [confirmed] | Extracts only *verifiable* claims; unverifiable ones are never searched | Share of claims skipped **[not found]** | Works with GPT-4o or fine-tuned open models (Mixtral-8x22 close). Uses Google Search via Serper **[unconfirmed]** |
| **SAFE** (Wei et al. 2024, *Long-form factuality*) | https://arxiv.org/abs/2403.18802, html [confirmed] | Drops irrelevant facts before search; **up to 5 Google searches per fact** | **$0.19 per response vs $4.00 human (>20x)** | 72% agreement with crowd raters on ~16k facts; wins 76% of 100 disagreements. GPT-3.5-Turbo backbone |
| **FActScore** (Min et al., EMNLP 2023) | https://arxiv.org/abs/2305.14251 [confirmed] | Retrieves over Wikipedia only | Human eval would have cost ~$26k for 6,500 generations | Estimator error <2% |
| **CheckThat! 2024 Task 1 (check-worthiness, English)** | Winner: Li, Panchendrarajan, Zubiaga, https://arxiv.org/abs/2406.18297 [confirmed rank 1]. 9th place IAI F1 0.753 (https://arxiv.org/abs/2408.01118). HYBRINFOX F1 0.711, 12th of 27 (https://arxiv.org/abs/2407.03850) | Political-transcript sentences: is this worth checking? | Winner matched full-data results with ~44% of training data | Winner's F1 **[not found]**. CheckThat! 2025 dropped check-worthiness (tasks: subjectivity, claim normalisation, numerical claims, scientific discourse; https://nlp.unibo.it/events/2025clef) |

Reading for Faultline: the only **quantified** retrieval saving with no quality loss is Adaptive-RAG on GPT-3.5 (about 60% fewer retrieval steps at equal F1), and that is QA, not claim verification. For claim verification, savings are claimed but not measured in any primary source I found. Check-worthiness (CheckThat!) is trained on political transcripts and is a poor proxy for "does this AI-output claim need a web search". A typed `Noul`/`Choice` ("is this claim checkable / opinion / common knowledge?") is a reasonable thing to build, but its saving would have to be measured on Faultline's own traffic.

---

## 4. Public labelled datasets for a Faultline gold set

| Dataset | Size | Labels (NEI / mixed?) | Evidence | Licence | Source |
|---|---|---|---|---|---|
| **AVeriTeC** (Schlichtkrull, Guo, Vlachos, NeurIPS 2023 D&B) | 4,568 real-world claims (HF mirror: 3,070 train / 500 dev) | Supported / Refuted / **Not Enough Evidence** / **Conflicting Evidence/Cherry-picking** | **Real web** (Google-search knowledge store, QA-pair evidence, 50 fact-checking orgs) | **CC BY-NC 4.0** (repo) | https://arxiv.org/abs/2305.13117, https://github.com/MichSchli/AVeriTeC, https://huggingface.co/datasets/pminervini/averitec [confirmed] |
| **LLM-AggreFact** | 30,420 dev / 29,320 test, 11 sources | Binary (1 supported / 0 not) | Grounding doc. **Web-evidence subsets: ClaimVerify, FactCheck-GPT, ExpertQA** | **CC BY-ND 4.0** (no derivatives) | https://huggingface.co/datasets/lytang/LLM-AggreFact [confirmed] |
| **Factcheck-Bench / Factcheck-GPT** (Wang et al. 2023) | **94 ChatGPT responses** annotated at claim/sentence/document level; companion FactBench of 4,835 examples (adds FacTool-KB, FELM-WK, HaluEval) | Fine-grained (verifiability, opinion/not-a-claim, true/false). Best automatic checker F1 = 0.63 on false claims | Open-web documents | Repo **Apache-2.0** (paper page CC BY 4.0) | https://arxiv.org/abs/2311.09000, https://github.com/yuxiaw/Factcheck-GPT [confirmed] |
| **FEVER** (Thorne et al. 2018 [unconfirmed]) | 185,445 claims | Supports / Refutes / **Not Enough Info** | Wikipedia (5.4M pages), not open web | CC BY-SA 3.0 + GPL-3.0 (HF card) | https://huggingface.co/datasets/fever/fever [confirmed] |
| **VitaminC** (Schuster, Fisch, Barzilay, NAACL 2021) | >450k claim-evidence pairs | Supports / Refutes / **NEI** (contrastive) | Wikipedia revisions | MIT | https://github.com/TalSchuster/VitaminC [confirmed] |
| **SciFact** (Wadden et al., EMNLP 2020) | 1,409 claims **[unconfirmed count]** | Support / Contradict / **NoInfo** | Scientific abstracts | **CC BY-NC 2.0** (HF) | https://github.com/allenai/scifact, https://huggingface.co/datasets/allenai/scifact [confirmed licence] |
| **ClaimDecomp** (Chen et al. 2022) | 1,200 claims (800/200/200) | PolitiFact 6-way (pants-fire … true; half-true ≈ mixed) | PolitiFact articles; some URLs dead, full set by email | Not stated **[unconfirmed]** | https://github.com/jifan-chen/subquestions-for-fact-checking [confirmed]. Follow-up with raw web evidence: Chen et al. NAACL 2024, https://arxiv.org/abs/2305.11859 |
| **FActScore bios** | Labelled: 183 entities (InstructGPT, ChatGPT, PerplexityAI bios, atomic-fact human labels). Unlabelled: 500 | Supported / Not-supported / Irrelevant | Wikipedia | Repo MIT | https://github.com/shmsw25/FActScore [confirmed] |
| **LongFact** | 2,280 prompts (1,140 Objects + 1,140 Concepts, 38 topics) | **No labels**: prompts only, scored by SAFE | – | Code Apache 2.0, materials **CC BY 4.0** (repo) | https://github.com/google-deepmind/long-form-factuality [confirmed] |

Recommendation for a gold set:
- **Commercial-safe, 4-way-ish, real web:** build Faultline's own set (claims extracted from real customer-style AI output, with the snippets Gemini returned), using AVeriTeC's label scheme as the template. Use AVeriTeC itself for internal evaluation only (NC licence; legal call).
- **Binary support check, AI-generated claims, web evidence:** the LLM-AggreFact ClaimVerify / FactCheck-GPT / ExpertQA test splits. ND licence: evaluate as-is, do not ship derivatives.
- **Closest to the product:** Factcheck-Bench (94 responses, Apache-2.0). Small, but it is LLM output checked against the open web with a not-a-claim class.

---

## 5. Laya and TypeSafe Jev

### 5.1 Laya — https://huggingface.co/convaiinnovations/laya (raw README read in full) [confirmed]
- Apache 2.0. English: ModernBERT-large backbone (395M) plus decision head (2 transformer layers, option-marker scorer, act/escalate head) = **421M**. Multilingual: mmBERT-base, 322M.
- **Primitives:** `choice` (multi-class, softmax over per-option `[MASK]` tokens, answer space set per request), `score` (ordinal), `noul` (yes/no probability).
- **Context:** English **512 tokens, of which head_max_len 192 is for options, leaving ~320 for state**. Multilingual / typed-decisions: 1,024 (~768 for state), extendable to 8,192 with accuracy dropping past ~4k tokens (16–18 of 20 correct up to ~4k; 8–17 of 20 beyond). **A claim plus 3 evidence snippets will often not fit in the English checkpoint's ~320-token state budget.**
- **Training:** RLCD, REINFORCE/GRPO-style against strictly proper scoring rules (log + spherical, plus RPS for ordinal).
- **Only NLI-type result: XNLI English 0.860** (English checkpoint) / 0.843 (multilingual); 0.731 on 14 other languages (routed). This comes from a shared 17,416-question benchmark. The card does not say whether XNLI was zero-shot or in-training **[unclear]**. Given the card's own warning that "base checkpoints are near chance on typed-decisions zero-shot" (0.362 vs 0.318 random / 0.461 majority), assume nothing transfers zero-shot to fact verification. **No FEVER / AggreFact / fact-verification results [not found].**
- **Calibration:** "Ships over-confident": per-(question type, option count) temperature refit takes mean ECE **0.466 → 0.081** (laya) and 0.314 → 0.106 (multilingual). On typed-decisions the fine-tuned checkpoint's table shows ECE **0.213** while the comparison table shows **0.081 post-temperature**: the card's own numbers disagree depending on whether temperature was fitted.
- Failure mode called out: English checkpoint on Khmer scores 0.000 accuracy at 0.952 confidence ("confidence gating cannot save you"). Also, `noul` can follow its `false:`/`true:` labels instead of the state (issue #156); the card advises a 2-option `choice` instead.
- Latency: 32.8 ms per question on a T4; 103–332 questions/s batched.

### 5.2 TypeSafe Jev — docs https://docs.typesafe.ai (llms.txt index read) [confirmed]
- **Primitives** (https://docs.typesafe.ai/primitives.md): `Choice` (selected option, probability per option, confidence; up to 255 options per the Laya card), `Score` (ordered levels, probability per level, confidence), `Noul` (P(yes), no confidence field). No text, explanations or reasoning traces.
- **"Confidence" is not a probability of being correct.** It is a statistic derived from the distribution's shape (https://docs.typesafe.ai/confidence.md). The page's widget computes `(k·p_max − 1)/(k − 1)`, i.e. a normalised peak. **If your internal ECE 0.156 was computed on `confidence` rather than on `probabilities[chosen]`, re-run it on the probability**, since the two differ by construction (for k=2, confidence = 2p−1).
- **Model page** (https://docs.typesafe.ai/models.md): jev-1.13.0, **$0.042 per million input tokens**, output free; context **64k per request, 32k for state plus the longest question** (OpenRouter's guide says 32k); 100K tok/s, 40 req/s; same weights for every account, **no customer fine-tuning**; English best.
- **Jaggedness page** (https://docs.typesafe.ai/model-jaggedness/jev-1.13.md, reviewed 2026-09-17), all relevant to fact-checking: literal reading; **numbers, counting and dates are unreliable** (many factual claims are numeric or temporal); multi-hop indirection costs accuracy; **large state full of irrelevant detail costs accuracy** ("context rot"); adversarial content in state can steer the answer; no structural invariants (example: P(refund)=0.72 and P(not refund)=0.47 sum to 1.19).
- **Citation-check cookbook** (https://docs.typesafe.ai/cookbooks/citation_check.md) [confirmed]: string-match the quote first (missing means fabricated), then one `Choice` {supports → verified, contradicts → contradicted, says nothing → unsupported}, auto-accept at confidence ≥ 0.8, else human review. Ran on jev-1.12, 2026-08-16, with **8 citations** (4 correct, all at confidence ≥ 0.93; 4 planted failures all caught). This is a demo, not a benchmark, but it is structurally Faultline's verdict step.
- **No published accuracy, ECE, NLI or fact-verification benchmark from TypeSafe [not found].**
- **Third-party Jev measurements:**
  - https://github.com/AbdelStark/jev-benchmarks [confirmed summary]: BTZSC AG News 0.910, Banking77 0.870, DAIR Emotion 0.480 (100 examples each); p50 236–256 ms; "substantially worse calibrated" on DAIR Emotion.
  - https://github.com/nibzard/decision-model-benchmark (2026-09-29) [confirmed summary]: Banking77 79.2% (3,080), CLINC150 88.6% (5,500), NLU++ micro-F1 48.3%; median latency 267–316 ms; $1.71 for 40,226 decisions. Suite **S5 "forced-choice decisions with insufficient evidence" reported ECE 0.246 on the undetermined half**, which is the closest public analogue to Faultline's *unverified* class. The repo itself notes methodological limits, and also says the provider "confidence" score "lacks established calibration as a probability". The LLM it was compared against is named "GPT-6 Luna" in the summary **[unverified name]**.
  - Laya card's "Jev 1.13.0 (published)" row on typed-decisions: acc 0.727, Brier 0.148, ECE 0.144, but the same card elsewhere lists Jev ECE 0.246. **Three Jev ECE figures exist (0.144, 0.156 internal, 0.246) from three different evals; none is on fact verification.**

---

## 6. What this means for Faultline (synthesis, not a source)

1. **Verdict re-judging (highest value, testable now).** After Gemini returns verdict + sources, run a second judge on (claim, returned snippet text): Jev `Choice` {supported, contradicted, insufficient}, or an open checker (FactCG-DeBERTa-L MIT 0.4B / MiniCheck-FT5 MIT). Use agreement/disagreement plus the probability to route to "unverified" or to a stronger second pass. **Prerequisite unknown: does Faultline keep the grounding snippet text, or only the URLs?** If only URLs, the re-judge needs a page fetch, and that cost dominates.
2. **Calibrated probability on the scorecard:** only after temperature-scaling on a Faultline-labelled set (≥ a few hundred claims; the 5-claim smoke benchmark cannot calibrate anything). Conformal (Mohri & Hashimoto) gives a defensible "≥ 1−α of shown-as-supported claims are correct" statement with the same labelled set.
3. **Pre-search routing:** a typed checkability/opinion `Noul` can skip search for non-claims. Expect modest savings; no primary source quantifies it for claim verification. Measure on real traffic.
4. **Don't use Laya English for this.** The ~320-token state budget is too small, and zero-shot is near chance. Laya-multilingual (1k–8k) would need fine-tuning on a gold set.
5. **Check first (cheapest):** whether Gemini 2.5 Flash returns `logprobs` together with `googleSearch` grounding (API supports `responseLogprobs`/`logprobs`: https://developers.googleblog.com/en/unlock-gemini-reasoning-with-logprobs-on-vertex-ai/; the combination with grounding on 2.5-flash is **[unconfirmed]**). Note: JSON response mode is not supported with grounding (forum report, https://discuss.ai.google.dev/t/enable-grounding-with-google-search-when-using-gemini-2-5-flash-via-postman/96269, **[unconfirmed]**).
