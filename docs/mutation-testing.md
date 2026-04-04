# Mutation Testing Patterns — Faultline Pro

Reference guide for mutation hardening sessions. Captures patterns discovered across N-118, N-125–N-126, N-128–N-133, N-137–N-138.

---

## Table of Contents

1. [Setup](#setup)
2. [Running a Hardening Session](#running-a-hardening-session)
3. [Patterns That Kill Mutants](#patterns-that-kill-mutants)
4. [Patterns That Cannot Kill Mutants](#patterns-that-cannot-kill-mutants)
5. [Config Reference](#config-reference)
6. [Threshold Guide](#threshold-guide)

---

## Setup

### Stryker configs in this repo

| Config | Target | Tests |
|--------|--------|-------|
| `stryker-cli.config.mjs` | `packages/cli/cli/scan.ts` | 7 test files |
| `stryker-stream.config.mjs` | `packages/api/src/routes/stream.ts` | 3 test files |
| `stryker-gdpr.config.mjs` | `packages/api/src/stores/{costs,schedules,notifications}.ts` | GDPR test cluster |

### Required options

```javascript
export default {
  testRunner: 'vitest',
  coverageAnalysis: 'off',   // REQUIRED — see "coverageAnalysis footgun" below
  reporters: ['clear-text'],
  logLevel: 'warn',
  tempDirName: '/tmp/stryker-faultline-XXX',
  testFiles: [               // REQUIRED — explicit manifest, not globs
    'packages/cli/tests/my-test.test.ts',
    // ...
  ],
  vitest: {
    dir: 'packages/cli',     // workspace package dir
    related: false,          // disable "related tests only" mode
  },
};
```

**Always run from the monorepo root** so the sandbox's `node_modules` symlink resolves correctly.

---

## Running a Hardening Session

### Step 1 — Capture the survivor list

```bash
npx stryker run stryker-cli.config.mjs 2>&1 | grep '\[Survived\]' -A 4
```

### Step 2 — Group survivors by file location

```bash
npx stryker run stryker-cli.config.mjs 2>&1 | grep '\[Survived\]' -A 2 | grep "scan.ts:" | sort | uniq -c | sort -rn
```

### Step 3 — Read the target file at the survivor line numbers

Focus on the first 10 survivors by frequency. Read the code, not just the mutation description.

### Step 4 — Write a hardening test file

Name: `{module}-mutation-hardening-{N}.test.ts`. Add it to the Stryker config's `testFiles` array.

### Step 5 — Verify tests pass, then re-run Stryker

```bash
npx vitest run packages/cli/tests/my-hardening.test.ts
npx stryker run stryker-cli.config.mjs 2>&1 | tail -15
```

---

## Patterns That Kill Mutants

### Pattern 1 — Exact-count assertion kills 3 boolean-guard mutants at once

When a flag like `startEmitted` guards a one-time emission:

```typescript
// stream.ts
if (!startEmitted) {
  emit({ type: 'start', claimCount, provider });
  startEmitted = true;
}
```

Stryker generates 3 variants:
- `startEmitted = false` (BooleanLiteral) → emits on every iteration
- `if (!startEmitted)` → `if (true)` (ConditionalExpression) → emits on every iteration
- fallback `if (!startEmitted)` → `if (true)` in 0-claim path

**One assertion kills all three:**

```typescript
const startEvents = events.filter(e => e.type === 'start');
expect(startEvents.length).toBe(1); // "exactly 1" — not "at least 1"
```

Why: any mutation that causes double-emission fails a `.toBe(1)` but passes a `.toBeGreaterThan(0)`.

### Pattern 2 — Two-entry exact-sum kills arithmetic `+=` → `-=`

For accumulator mutations like `totalClaims += r.claims.length`:

```typescript
// Two files × 1 claim each → totalClaims should be 2
// With `-=` mutant: 0 - 1 - 1 = -2
expect(r.summary.totalClaims).toBe(2);
```

Use **exactly 2 entries** so the assertion is tight: `+` sum = 2, `-` sum = -2, both clearly distinguishable.

Works for any additive accumulator: token counts, cost sums, EU tier counts, verification counts.

### Pattern 3 — ObjectLiteral `{}` mutation: assert specific field values

When Stryker replaces `{ type: 'start', claimCount, provider }` with `{}`:

```typescript
// Kills emit({}) mutations — assert the fields individually
expect(start.type).toBe('start');
expect(typeof start.claimCount).toBe('number');
expect(typeof start.provider).toBe('string');
expect(start.provider.length).toBeGreaterThan(0);
```

For initialization objects like `euTierCounts = { unacceptable: 0, high: 0, limited: 0, minimal: 0 }`:

```typescript
// With `= {}` mutation, += sets these to NaN (undefined + number = NaN)
expect(typeof euTierCounts.unacceptable).toBe('number');
expect(euTierCounts.unacceptable).toBeGreaterThanOrEqual(0);
```

### Pattern 4 — Force catch-block coverage via missing API key

Catch blocks in provider-backed routes/functions are dead coverage in mock-only test environments. Fix:

```typescript
// Stryker test that exercises the catch block in a stream route:
it('error event emitted on scan failure', async () => {
  delete process.env.GEMINI_API_KEY;
  const res = await server.inject({
    method: 'GET',
    url: `/scan/stream?text=${encodeURIComponent(TEXT)}&provider=gemini`,
    headers: { 'x-api-key': 'test-secret' },
  });
  const events = parseSSE(res.body);
  expect(events.find(e => e.type === 'error')).toBeDefined();
});
```

The GeminiProvider throws during initialization or first call when `GEMINI_API_KEY` is absent. This forces the `catch` block without any mocking. The response is still HTTP 200 — errors are SSE events, not HTTP errors.

**Apply to**: any route that calls a provider and has a `catch` block that handles scan failures.

### Pattern 5 — Exact string assertion kills StringLiteral mutations

For error messages, header values, field names:

```typescript
// Kills both the key mutation ("Cache-Control" → "") and value mutation ("no-cache" → "")
expect(res.headers['cache-control']).toBe('no-cache');
expect(body.error).toBe('Missing required query param: text');
```

Use `.toBe()` not `.toContain()` — the mutation replaces the literal with `""`, which `.toContain("")` would pass.

### Pattern 6 — Asymmetric input kills normalization regex mutations

When a normalization function is applied to both sides of a comparison (symmetric), most mutations are invisible. Break symmetry by making the input text differ from the expected match in a way that depends on correct normalization:

```typescript
// sentence has triple-space, claim has single-space
// normalizeSentence with /\s+/g collapses triple → single → they match (covered, no synthetic)
// with /\s/g mutation: triple stays → fingerprints differ → synthetic claim added
const result = guaranteeClaimPerSentence(
  'Hello   world is correct today. AI systems verify data now.',  // triple-space in first sentence
  [{ id: 'c1', text: 'Hello world is correct today.', ... }],   // single-space in claim
);
expect(result.length).toBe(2);  // only 2 claims, no synthetic — kills /\s/g and "Stryker was here!" mutations
```

### Pattern 7 — Synthetic claim ID ordinals kill idx arithmetic/update mutations

For `guaranteeClaimPerSentence` index tracking:

```typescript
// 2 existing claims → idx starts at result.length + 1 = 3
// With `result.length - 1` mutant: idx starts at 1
const existing = [{ id: 'c1', ... }, { id: 'c2', ... }];
const result = guaranteeClaimPerSentence(text_with_uncovered_sentence, existing);
const synthetics = result.filter(c => c.id.startsWith('s'));
expect(synthetics[0].id).toBe('s3');   // not 's1' (kills -1 arithmetic)
expect(synthetics[1].id).toBe('s4');   // not 's2' (kills idx-- update)
```

### Pattern 8 — EU tier accumulation via real compliance pipeline

The compliance pipeline (`generateComplianceReport` → `mapClaimToRiskCategory`) is **not mocked** even in mock-provider mode. Use domain-keyword claim text to produce non-zero tier counts:

| Tier | Trigger |
|------|---------|
| `unacceptable` | "social scoring", "citizen score", "social credit", "mass surveillance" |
| `high` | "employment", "recruitment", "biometric", "facial recognition", "credit scor*", "law enforcement", "migration", "education" |
| `limited` | verification status `'contradicted'` or `'mixed'` (no high-risk domain keyword) |
| `minimal` | verification status `'supported'` (no domain keyword) |

```typescript
// 2 files × 1 employment claim each → euTierCounts.high = 2
// With `+=` → `-=` mutant: -2
mockExtractClaims.mockResolvedValue([{
  id: 'c1',
  text: 'Employment of AI in recruitment and hiring is rising fast.',
  type: 'fact',
  importance: 3,
}]);
mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
const r = await batchScan(dir_with_2_files, 'mock');
expect(r.summary.euTierCounts.high).toBe(2);
```

### Pattern 9 — riskOrder StringLiteral kills via specific risk level

For `riskOrder = ['critical', 'high', 'medium', 'low']` mutations:

```typescript
// 3 contradicted claims → calculateRisk returns 'critical'
// With 'critical'→'' mutation: '' not in riskCounts → falls to 'low' → test fails
mockExtractClaims.mockResolvedValue(makeClaims(['claim1', 'claim2', 'claim3']));
mockVerifyClaim.mockResolvedValue(vr('contradicted', 'cx'));
const r = await batchScan(dir_with_1_file, 'mock');
expect(r.summary.highestRisk).toBe('critical');  // kills 'critical'→'' mutation

// 1 contradicted claim → calculateRisk returns 'high'
// With 'high'→'' mutation: 'high' not in riskOrder → falls to 'low' → test fails
mockExtractClaims.mockResolvedValue(makeClaims(['claim1']));
mockVerifyClaim.mockResolvedValue(vr('contradicted', 'c1'));
const r = await batchScan(dir_with_1_file, 'mock');
expect(r.summary.highestRisk).toBe('high');      // kills 'high'→'' mutation
```

---

## Patterns That Cannot Kill Mutants

### Cannot kill — Symmetric normalization mutations

When a transformation `f(x)` is applied to both sides of a comparison:

```
covered = result.some(c => {
  const nc = normalize(c.text);
  return nc.includes(normalize(sentence).slice(0, 40)) || ...
});
```

Mutations to `normalize()` that are applied symmetrically to both `nc` and `normSentence` produce identical behavior. Specifically:
- `' '` → `''` (remove spaces): both sides lose spaces → fingerprints still match
- `.trim()` removal: sentences from `splitSentences` are already trimmed; effect is invisible

These 2 mutants in `normalizeSentence` are **permanently untestable** through `guaranteeClaimPerSentence`. They would require a test that bypasses the symmetric call structure.

### Cannot kill — VALID_PROVIDERS string mutations in mock-only environment

```typescript
const VALID_PROVIDERS = new Set(['gemini', 'claude', 'openai', 'perplexity', 'mock']);
```

Changing `'gemini'` → `''` means `provider=gemini` falls back to mock — which is the same behavior as when `'gemini'` was valid. The test can't distinguish "recognized as valid" from "fell back to mock." These 6 mutants survive permanently unless:
- A real integration test validates that a non-mock provider routes correctly, or
- Provider validation is extracted to a separately testable function.

### Cannot kill — `riskOrder 'low'→""` with `|| 'low'` fallback

```typescript
const riskOrder = ['critical', 'high', 'medium', 'low'];
const highestRisk = riskOrder.find(r => riskCounts[r] > 0) || 'low';
```

With `'low'→''`: if `riskCounts['low'] > 0`, `find()` returns `'low'` directly — the fallback never fires. Same result. With all-zero counts: `find()` returns `undefined` → `|| 'low'` gives `'low'`. Same result. The mutation is structurally masked by the fallback.

### Cannot kill — Fastify schema string literals

```typescript
schema: {
  tags: ['Scan'],
  summary: 'Stream scan via SSE',
  description: 'Returns events...',
  querystring: { properties: { provider: { enum: ['gemini', 'mock'] } } }
}
```

Mutations to `tags`, `summary`, `description`, and `enum` values survive because Fastify uses them for OpenAPI documentation generation, not runtime validation enforcement. Behavior is identical regardless of these string values. **Do not add tests to kill these** — they are documentation-only mutations.

---

## Config Reference

### `coverageAnalysis: 'off'`

**Always use `'off'`**, not `'perTest'` or `'all'`. With Vitest's ESM transform, `coverageAnalysis: 'perTest'` can cause import resolution failures in the sandboxed test environment. `'off'` runs all configured `testFiles` for every mutant — slower but reliable.

### `testFiles` — explicit manifest required

Do NOT use globs in `testFiles`:

```javascript
// WRONG — Stryker may not resolve these correctly from monorepo root
testFiles: ['packages/cli/tests/*.test.ts'],

// CORRECT — explicit paths relative to monorepo root
testFiles: [
  'packages/cli/tests/scan-mutation-hardening.test.ts',
  'packages/cli/tests/scan-mutation-hardening-2.test.ts',
],
```

**Add new hardening tests to `testFiles` immediately** after creating them. Forgetting this means the new tests never run during Stryker — the score won't improve.

### `vitest.dir`

Must point to the package directory containing `vitest.config.ts`, not the monorepo root:

```javascript
vitest: {
  dir: 'packages/cli',   // not '.' or 'packages/cli/cli'
  related: false,
}
```

---

## Threshold Guide

| Context | Minimum | Target | Notes |
|---------|---------|--------|-------|
| Critical paths (claim forensics) | 60% | 80%+ | Gate 6 requirement |
| Standard business logic | 40% | 60%+ | |
| Schema/doc-only code | N/A | N/A | Exclude from mutate paths |

**Current scores** (last run N-138, 2026-03-21 — scores unchanged since; see gap table below):

| Module | Score | Status |
|--------|-------|--------|
| `cli/scan.ts` | 81.97% | ✅ Gate 6 cleared |
| `api/routes/stream.ts` | 85.00% | ✅ Gate 6 cleared |
| `api/src/stores/costs.ts` | 96.81% | ✅ Gate 6 cleared |
| `api/src/stores/notifications.ts` | 92.45% | ✅ Gate 6 cleared |
| `api/src/stores/schedules.ts` | 80.94% | ✅ Gate 6 cleared |

**First-run scores** (`stryker-compliance.config.mjs` created Cycle 72, 2026-04-04):

| Module | Raw score | Score (renderers excluded) | Status | Notes |
|--------|-----------|---------------------------|--------|-------|
| `cli/compliance-report.ts` | 44.56% | **50.44%** | ❌ Gate 6 FAIL | Threshold: 80%. Renderers excluded = HTML (lines 1662–1822) + PDF (1823–2115). See survivor analysis below. |

**Survivor analysis** (2,518 total mutants, renderers-included run):

| Type | Count | Action |
|------|-------|--------|
| StringLiteral | 470 | ~400 in HTML/PDF renderers (excluded in focused run) — legitimately untestable string templates |
| ConditionalExpression | 308 | **Real gap** — article evidence status conditions not fully branch-covered |
| EqualityOperator | 170 | **Real gap** — `===` comparisons in evidence logic |
| ArithmeticOperator | 97 | Score/count calculations; some testable |
| MethodExpression | 64 | `.push()`, `.filter()`, `.some()` calls |
| LogicalOperator | 48 | AND/OR logic in status derivation |
| Other | 172 | Object/array/block mutations |

**Root cause of FAIL**: `buildEuComplianceReport()` has 12 article blocks, each with multi-branch status logic (`non-compliant` / `partial` / `gap` / `compliant` / `not-applicable`). The 250 existing tests exercise the happy path and the article-present/absent cases, but many intermediate branches (e.g., exactly 1 vs 0 signals, >30% contradiction rate threshold, mixed vs contradicted paths) are not explicitly covered. `getRemediations()` condition branches (findings substring checks) are partially covered by RR22–RR27 but many article/status combinations are not.

**Required hardening work** (P0 directive candidate):
1. Add per-article boundary tests for each status transition (e.g., Art. 9: contradicted→non-compliant, mixed→partial, no signals→compliant)
2. Add `getRemediations()` tests for each article × finding-signal combination
3. Add score calculation boundary tests (exactly 30% contradiction threshold, exactly 0 vs 1 sources)
4. Estimated: +80–120 new tests, expected score after hardening: 75–85%

**Known gaps** (modules not yet in any stryker config — added after N-138):

| Module | Added | Size | Priority | Notes |
|--------|-------|------|----------|-------|
| `cli/compliance/eu_ai_act.ts` | N-157 | ~200 LOC | P2 | Risk mapping regexes and `mapClaimToRiskCategory()` — exercised indirectly via `cli/scan.ts` Stryker run, not directly targeted. |

**Next hardening session**: `stryker-compliance.config.mjs` exists — run with `npx stryker run stryker-compliance.config.mjs`. Test manifest: `packages/cli/tests/compliance-report.test.ts` (250 tests). Gate 6 threshold: 80%.
