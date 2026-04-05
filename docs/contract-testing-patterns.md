# Contract Testing Patterns — Faultline Pro

Last updated: 2026-04-04 (N-212). Covers patterns developed in N-77 (initial contract oracle) and N-212 (EU AI Act type coverage).

## Why Contract Tests

TypeScript types are erased at runtime. A function can declare it returns `EuAiActComplianceReport` but actually emit an object with missing fields or wrong enum values at runtime — and no compile-time check catches that.

Contract tests close this gap by mirroring TypeScript types as Zod schemas and parsing actual runtime output through them. They catch:

- LLM providers returning unexpected shapes (wrong keys, bad enum values)
- Compliance report generator emitting malformed output
- Demo data drifting from the live schema after refactors
- New required fields (added to the TypeScript type) not yet emitted by the implementation

This is the third oracle type in the CRUCIBLE quadrant (example-based → property-based → contract → integration).

## File Location

`packages/cli/tests/contract.test.ts` — 43 schemas, 43 tests.

## Pattern 1: Mirror the TypeScript Type as a Zod Schema

```typescript
// TypeScript type (types.ts):
// interface Claim {
//   id: string;
//   text: string;
//   type: 'fact' | 'opinion' | 'interpretation';
//   importance: number;
// }

const ClaimSchema = z.object({
  id: z.string().min(1),         // not just z.string() — catch empty strings
  text: z.string().min(1),
  type: z.enum(['fact', 'opinion', 'interpretation']),
  importance: z.number().int().min(1).max(5),  // encode the business invariant
});
```

Key rules:
- Use `.min(1)` on strings that must be non-empty (ids, keys, article names)
- Use `.int().min(0)` on counts — catch negative numbers and floats
- Use `.number().min(0).max(1)` on normalized scores (confidenceScore, strengthScore)
- Use `z.union([z.literal(0), z.literal(1)])` for discriminated numeric literals (exitCode)

## Pattern 2: Enum Schemas as Named Constants

Extract enum schemas at the top of the file so rejection tests can reuse them:

```typescript
const EvidenceStatusSchema = z.enum(['supported', 'partial', 'not-applicable']);
const EURiskLevelSchema = z.enum(['unacceptable', 'high', 'limited', 'minimal']);
```

Then rejection tests become single-liners:

```typescript
it('rejects EuArticleEvidence with invalid status enum', () => {
  const bad = { ...validEvidence, status: 'unknown' };
  expect(EvidenceStatusSchema.safeParse(bad.status).success).toBe(false);
});
```

## Pattern 3: Three Tests Per Schema Block

Every schema block has exactly three tests:

1. **Conformance**: actual runtime output parses successfully
2. **Rejection (missing required field)**: object missing a required field fails
3. **Rejection (wrong type/enum)**: object with bad value fails

```typescript
describe('Contract: EuArticleEvidenceSchema (N-204–N-209)', () => {
  // 1. Conformance — parse real output
  it('all EuArticleEvidence blocks conform to schema', async () => {
    const scanResult = await makeContractScan();
    const report = buildEuComplianceReport(scanResult);
    for (const evidence of report.articleEvidence) {
      expect(() =>
        assertValid(EuArticleEvidenceSchema, evidence, `EuArticleEvidence[${evidence.article}]`)
      ).not.toThrow();
    }
  });

  // 2. Rejection — missing field
  it('rejects EuArticleEvidence missing strengthScore', () => {
    const bad = { article: 'Art. 5', requirement: 'req', status: 'partial',
                  findings: [], remediations: [], evidenceCount: 0, sourceCount: 0 };
    expect(EuArticleEvidenceSchema.safeParse(bad).success).toBe(false);
  });

  // 3. Rejection — wrong enum
  it('rejects EuArticleEvidence with invalid status enum', () => {
    const bad = { ...fullValidEvidence, status: 'unknown' };
    expect(EuArticleEvidenceSchema.safeParse(bad).success).toBe(false);
  });
});
```

## Pattern 4: `assertValid` Helper for Descriptive Failures

```typescript
function assertValid<T>(schema: z.ZodSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} failed schema validation:\n${result.error.message}`);
  }
  return result.data;
}
```

The `label` parameter propagates the article name / type name into the failure message so `vitest` output points directly to which object failed, not just which test.

## Pattern 5: Compose Complex Schemas from Primitive Ones

```typescript
const EuArticleEvidenceSchema = z.object({
  article: z.string().min(1),
  requirement: z.string().min(1),
  status: EvidenceStatusSchema,          // reuse named enum schema
  findings: z.array(z.string()),
  remediations: z.array(z.string()),
  evidenceCount: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
  strengthScore: z.number().min(0).max(1),
});

const EuAiActComplianceReportSchema = z.object({
  complianceScore: z.number().min(0).max(100),
  compliancePass: z.boolean(),
  articleEvidence: z.array(EuArticleEvidenceSchema),  // compose
  annexIIIChecklist: AnnexIIIChecklistSchema,          // compose
  // ...
});
```

Composition means a single Zod parse of the top-level schema recursively validates all nested shapes.

## Pattern 6: Test Boundary Values, Not Just Happy Path

For `CiGateResult.exitCode` (must be `0 | 1`, never `2`):

```typescript
it('exitCode is 0 or 1 — never another value', async () => {
  const gate = evaluateComplianceGate(report);
  expect([0, 1]).toContain(gate.exitCode);
});

it('rejects CiGateResult with exitCode 2', () => {
  const bad = { ...validGate, exitCode: 2 };
  expect(CiGateResultSchema.safeParse(bad).success).toBe(false);
});
```

This catches the case where a refactor changes `exitCode: 0 | 1` to `exitCode: number` — the rejection test fails and surfaces the regression.

## Pattern 7: `makeContractScan` Factory for Reusable Input

Rather than duplicating `scan('text', 'mock')` in every test, use a factory:

```typescript
async function makeContractScan(
  overrides: Partial<{ text: string; provider: string }> = {}
) {
  const text = overrides.text ?? 'Faultline verifies AI claims against live evidence.';
  const provider = overrides.provider ?? 'mock';
  return scan(text, provider);
}
```

Pass `overrides.text` for tests that need high-risk domain content (biometric, employment) to trigger specific article evidence.

## What Contract Tests Do NOT Cover

- Business logic correctness (whether `complianceScore: 72` is the right value)
- Mutation hardening (use Stryker for that — see `docs/mutation-testing.md`)
- Live provider correctness (use integration tests — `tests/integration.test.ts`)
- Property invariants (use fast-check — `tests/properties.test.ts`)

Contract tests answer: "does the runtime output match the declared shape?" Nothing more.

## CRUCIBLE Gate Relationship

Contract tests are Gate-6 adjacent (they harden the runtime contract) but serve Gate-3 (oracle triangulation). They are counted in the CONTRACT oracle coverage metric:

```
Current oracle coverage:
  example-based: 4,398 tests
  property-based: 19 properties (fast-check, N-76)
  contract:       43 Zod schema tests (N-77/N-212)
  integration:    12 E2E tests (N-81)
```

## Adding a New Contract Test

When a new type is added to `types.ts` or `compliance-report.ts`:

1. Add a named Zod schema constant at the top of `contract.test.ts` mirroring the new type
2. Add it as a field to the parent schema (`ScanResultSchema`, `EuAiActComplianceReportSchema`, etc.)
3. Add a 3-test describe block (conformance + 2 rejection)
4. If the type is emitted by a new function, add a `makeContract*` factory if needed
5. Run `npx vitest run packages/cli/tests/contract.test.ts` and verify all pass
6. Update `CLAUDE.md` contract count and `CHANGELOG.md` [Unreleased]
