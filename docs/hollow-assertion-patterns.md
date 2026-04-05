# Hollow Assertion Patterns — CRUCIBLE Gate 2

> Written 2026-04-04 after cycles 101–104 — Gate 2 sweep that hardened **91 assertions** across the full CLI + API test suite.

---

## What Is a Hollow Assertion?

A hollow assertion is an `expect()` call that passes when the code is _wrong_ and would pass when the code is _right_ — giving no additional confidence over just running the code without an assertion.

The two most common hollow patterns:

```ts
expect(result).toBeDefined();   // hollow: passes for any value including ""
expect(result).toBeTruthy();    // hollow: passes for any truthy value
```

Both become hollow when they are the **terminal assertion in a test** with no downstream content check. If the same binding is used afterwards (e.g., `result!.someField`), the assertion is a **null-guard** — not hollow.

### Guard vs. Hollow

```ts
// ✅ GUARD — not hollow. result is used immediately after.
const result = store.get(id);
expect(result).toBeDefined();
expect(result!.name).toBe('expected');

// ❌ HOLLOW — terminal. Nothing checks what result contains.
const result = store.get(id);
expect(result).toBeDefined();
});
```

---

## Detection Script

```bash
for file in packages/*/tests/*.test.ts; do
  grep -n "toBeDefined()\|toBeTruthy()" "$file" | while IFS= read -r line; do
    lineno=$(echo "$line" | cut -d: -f1)
    nextline=$(sed -n "$((lineno + 1))p" "$file")
    # Flag if next line is a closing brace/paren (end of test block)
    if echo "$nextline" | grep -qE "^\s*\}?\s*\)?\s*;?\s*$"; then
      echo "HOLLOW? $file:$lineno"
      echo "  $line"
      echo "  NEXT: $nextline"
    fi
  done
done
```

**Limitation**: only catches single-line terminals. Consecutive hollow assertions (e.g., three `toBeDefined()` in a row before `}`)) only flag the last one. Run the script iteratively or inspect the surrounding block manually.

---

## Fix Patterns by Return Type

### Timestamp / ISO date string

```ts
// Before
expect(body.createdAt).toBeDefined();

// After
expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
```

Covers: `createdAt`, `updatedAt`, `exportedAt`, `lastRotatedAt`, `lastUsedAt`, `lastFetched`, `lastRun`, `triggeredAt`, `scannedAt`, `seenAt`, `generatedAt`, `lastPollTime`, `expiresAt`

### String field (type check)

```ts
// Before
expect(body.overallRisk).toBeDefined();

// After
expect(typeof body.overallRisk).toBe('string');
```

Covers: `overallRisk`, `error`, `keyId`, `scanId`, `webhookId`, IDs, short string values

### Array field

```ts
// Before
expect(body.ruleFindings).toBeDefined();

// After
expect(Array.isArray(body.ruleFindings)).toBe(true);
```

Covers: `ruleFindings`, `claims`, `suggestions`, `articleEvidence`, `evidenceLinks`, `providers`, `scans`, `audit`

### Object / shape presence

```ts
// Before
expect(body.complianceReport).toBeDefined();

// After — checks it has a known key
expect(body.complianceReport).toHaveProperty('riskTier');
```

Or for known shape:

```ts
expect(tenant).toMatchObject({ id: tenantId });
```

### Exact error message

```ts
// Before
expect(JSON.parse(res.body).error).toBeDefined();

// After — use the exact string from the route handler
expect(JSON.parse(res.body).error).toBe('Job not found.');
```

### `.find()` result

When `x` is the result of `.find(item => item.id === 'foo')`:

```ts
// Before — tautological identity check
expect(x).toBeDefined();

// After — check a DIFFERENT field to confirm the found object has real content
expect(x!.eventType).toBe('scan.completed');  // or
expect(x!.endpoint).toBe('/scan/upload');      // or
expect(x!.delivered).toBe(false);
```

Do NOT check `x!.id === 'foo'` — that's what the `.find()` filter already guarantees.

### HMAC / crypto field

```ts
// Before
expect(signature).toBeTruthy();

// After — verify the actual format
expect(signature).toMatch(/^sha256=[0-9a-f]+$/);
```

### Boolean function/method

```ts
// Before
expect(spinner).toBeDefined();

// After — verify the interface contract
expect(typeof spinner.succeed).toBe('function');
```

### Number field

```ts
// Before
expect(score).toBeDefined();

// After
expect(typeof score).toBe('number');

// Or if you know the range:
expect(score).toBeGreaterThanOrEqual(0);
```

---

## When `toBeDefined()` Is Correct

Use `toBeDefined()` or `toBeTruthy()` when:

1. **It's a guard**: the assertion is immediately followed by `!.field` access in the same test.
2. **The value is tested for absence**: `expect(x).toBeUndefined()` / `expect(x).toBeNull()` are purposeful assertions, not hollow.
3. **The truthy check IS the contract**: e.g., testing that `someFeature.enabled` is falsy vs truthy.

---

## Sweep Results (Cycles 101–104, 2026-04-04)

| Cycle | Scope | Pattern | Count |
|-------|-------|---------|-------|
| 101 | CLI non-hardening (37 files) | `toBeDefined()` | 5 |
| 102 | API non-hardening batch 1 (11 files) | `toBeDefined()` | 17 |
| 103 | API non-hardening batch 2 (25 files) | `toBeDefined()` | 43 |
| 103+ | CLI spinner | `toBeDefined()` | 1 |
| 104 | CLI + API (16 files) | `toBeTruthy()` | 25 |
| 109 | CLI + API (15 files) — second pass | `toBeDefined()` / `toBeTruthy()` | 35 |
| **Total** | **103 files** | | **126** |

Guard pattern confirmed non-hollow (not fixed): 13 instances (attribution.ts:81, plugin.ts:168 + 11 API hardening).
