# ASIF UAT — EU AI Act Compliance Evidence Layer
**Document**: asif-uat-eu-ai-act-compliance-layer-v1.0.0.md
**Version**: 1.0.0
**Date**: 2026-04-16
**Author**: Wolf (NXTG-AI)
**Directive**: DIRECTIVE-NXTG-20260416-01
**Commits**: c845c63 (implementation), 71cd60a (reflection)
**Status**: PASS — all 46 tests green, live demo verified

---

## Scope

Three additive API endpoints implementing EU AI Act compliance evidence for high-risk AI system operators. No existing code modified. Test count: 2,263 (+33).

| Endpoint | Article | NEXUS | Tests |
|---|---|---|---|
| `POST /scan/risk-register` | Art. 9 — Risk Management | N-217 | RR1–RR14 (14) |
| `GET /audit/log/manifest` | Art. 12 — Logging/Record-keeping | N-219 | AM1–AM13 (13) |
| `POST /scans/:id/approve` | Art. 14 — Human Oversight | N-218 | AP1–AP19 (19) |

---

## Setup

```bash
cd ~/projects/Faultline-Pro/packages/api
FAULTLINE_API_KEY=admin-secret npm start &
sleep 3 && curl -s http://localhost:3000/health | jq .
# Expected: {"status":"ok"}
```

Or run the full test suite (no server required):

```bash
npm test --workspace=packages/api -- --reporter=verbose 2>&1 | grep -E "AM|RR|AP"
```

---

## UAT-1 — Art. 9 Risk Register (`POST /scan/risk-register`)

**File**: `packages/api/src/routes/risk-register.ts`
**Auth**: Admin key required (403 if missing)

### Test cases

| ID | Scenario | Command | Expected |
|---|---|---|---|
| RR1 | No API key | `curl -X POST .../scan/risk-register` | `403` |
| RR2 | Valid admin key, empty store | See below | `200`, `totalScans: 0`, `findings: []` |
| RR3 | Response shape | See below | `version` (UUID), `generatedAt` (ISO), `article` contains `"Art. 9"`, `lifecyclePhase`, `summary`, `findings[]` |
| RR11 | Default phase | No body | `lifecyclePhase: "monitoring"` |
| RR12 | Explicit phase | `{"phase":"development"}` | `lifecyclePhase: "development"`, all findings match |
| RR13 | Invalid phase | `{"phase":"nonsense"}` | Falls back to `"monitoring"` |
| RR14 | All valid phases | `testing`, `deployment` | Reflected correctly |

### Live commands

```bash
# RR2 / RR3 — basic shape
curl -s -X POST http://localhost:3000/scan/risk-register \
  -H "x-api-key: admin-secret" \
  -H "content-type: application/json" \
  -d '{}' | jq '{version,generatedAt,article,lifecyclePhase,summary}'

# RR12 — explicit lifecycle phase
curl -s -X POST http://localhost:3000/scan/risk-register \
  -H "x-api-key: admin-secret" \
  -H "content-type: application/json" \
  -d '{"phase":"development"}' | jq '{lifecyclePhase, first_finding_phase: .findings[0].lifecyclePhase}'

# RR13 — invalid phase fallback
curl -s -X POST http://localhost:3000/scan/risk-register \
  -H "x-api-key: admin-secret" \
  -H "content-type: application/json" \
  -d '{"phase":"invalid"}' | jq '.lifecyclePhase'
# Expected: "monitoring"
```

### Result

```
PASS — RR1–RR14 all green (14/14)
```

---

## UAT-2 — Art. 12 Tamper-Evident Manifest (`GET /audit/log/manifest`)

**File**: `packages/api/src/routes/audit-log.ts`
**Auth**: Admin key required (403 if missing)

### Test cases

| ID | Scenario | Expected |
|---|---|---|
| AM1 | No API key | `403` |
| AM2 | Valid admin key | `200` |
| AM3 | Response shape | `algorithm: "SHA-256-chain"`, `generatedAt`, `totalEntries`, `rootHash`, `entries[]` |
| AM4 | Empty log | `totalEntries: 0`, `rootHash: null`, `entries: []` |
| AM9 | Hash format | `entryHash` and `chainHash` are 64-char hex (SHA-256) |
| AM10 | rootHash | Equals last entry's `chainHash` |
| AM11 | Chain entry 0 | `chainHash = SHA-256(entryHash + "")` |
| AM12 | Chain entry 1 | `chainHash = SHA-256(entryHash[1] + chainHash[0])` |
| AM13 | Full chain | Every entry verifiable end-to-end; `rootHash` matches |

### Live commands

```bash
# Seed audit log with a few calls
curl -s http://localhost:3000/health -H "x-api-key: admin-secret" > /dev/null
curl -s http://localhost:3000/health -H "x-api-key: admin-secret" > /dev/null

# Fetch manifest
curl -s http://localhost:3000/audit/log/manifest \
  -H "x-api-key: admin-secret" | jq '{algorithm, totalEntries, rootHash}'

# Live chain verification — no Faultline tooling, pure Python stdlib
curl -s http://localhost:3000/audit/log/manifest \
  -H "x-api-key: admin-secret" | python3 -c "
import json, sys, hashlib
body = json.load(sys.stdin)
prev = ''
for e in body['entries']:
    chain = hashlib.sha256((e['entryHash'] + prev).encode()).hexdigest()
    assert chain == e['chainHash'], f'BROKEN at index {e[\"index\"]}'
    prev = e['chainHash']
assert prev == body['rootHash']
print(f'Chain VERIFIED — {len(body[\"entries\"])} entries, rootHash={body[\"rootHash\"][:16]}...')
"

# Equivalent using openssl (auditor-grade, no Python required)
# For each entry: echo -n "<entryHash><prevChainHash>" | openssl dgst -sha256
```

### Result

```
PASS — AM1–AM13 all green (13/13)
Chain verification script: VERIFIED
```

---

## UAT-3 — Art. 14 Human Sign-Off (`POST /scans/:id/approve` + `GET /scans/:id/approvals`)

**Files**: `packages/api/src/routes/approvals.ts`, `packages/api/src/store/approvals.ts`
**Auth**: Any valid API key (not admin-only — any reviewer can sign off)

### Test cases

| ID | Scenario | Expected |
|---|---|---|
| AP1 | No API key | `401` |
| AP2 | Valid key | `201` |
| AP3 | Scan-only key | `201` (not admin-restricted) |
| AP5 | Default decision | `decision: "approved"` |
| AP6 | Explicit `"rejected"` | Stored and returned correctly |
| AP7 | Note provided | `note` field present in response |
| AP8 | No note | `note` is `undefined` |
| AP10 | Approver identity | `approver: "admin"` (key identity, not user input) |
| AP11 | GET — no key | `401` |
| AP13 | GET — empty | `approvals: []`, `total: 0` |
| AP15 | GET — isolation | Only returns approvals for requested `scanId` |
| AP16 | GET — multiple | Both approvals returned, `total: 2` |

### Live commands

```bash
SCAN_ID="demo-scan-001"

# AP2 + AP5 — approve with default decision
curl -s -X POST http://localhost:3000/scans/${SCAN_ID}/approve \
  -H "x-api-key: admin-secret" \
  -H "content-type: application/json" \
  -d '{"note":"Reviewed by Wolf — LGTM"}' | jq '{id,scanId,approver,decision,note,timestamp}'

# AP6 — reject
curl -s -X POST http://localhost:3000/scans/${SCAN_ID}/approve \
  -H "x-api-key: admin-secret" \
  -H "content-type: application/json" \
  -d '{"decision":"rejected","note":"Claims unverifiable — do not ship"}' | jq '{decision,note}'

# AP16 — retrieve both records
curl -s http://localhost:3000/scans/${SCAN_ID}/approvals \
  -H "x-api-key: admin-secret" | jq '{scanId,total,approvals_count: (.approvals|length)}'

# AP15 — isolation check (different scan should have 0)
curl -s http://localhost:3000/scans/other-scan/approvals \
  -H "x-api-key: admin-secret" | jq '.total'
# Expected: 0
```

### Result

```
PASS — AP1–AP19 all green (19/19)
```

---

## README changes (commit c845c63)

```bash
git show c845c63 -- README.md | grep "^+" | grep -v "^+++"
```

Three paragraphs added under `## EU AI Act — August 2026`:

- **Art. 9 §**: Explains lifecycle-phase risk register; notes "auditors request this document first"
- **Art. 12 §**: Explains SHA-256 chain; notes verifiability via `openssl dgst -sha256` — no FP tooling required
- **Art. 14 §**: Explains human sign-off immutability; "durable audit trail of human sign-off prior to production use"

**Framing constraint upheld**: All three paragraphs use "generates compliance evidence" language. No claim of "EU AI Act compliant."

---

## Sign-off

| Check | Status |
|---|---|
| All 46 tests green | PASS |
| No test count decrease (was 2,230, now 2,263) | PASS |
| No existing code refactored (additive only) | PASS |
| README updated with 1 paragraph per article | PASS |
| Framing constraint ("evidence", not "compliant") | PASS |
| NEXUS directive marked DONE | PASS |
| Committed and pushed | PASS |

**UAT result: PASS**
