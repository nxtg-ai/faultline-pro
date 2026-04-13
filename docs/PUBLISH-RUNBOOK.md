# Faultline Pro — Publish Runbook

> **Status**: READY — all pre-publish gates pass as of 2026-04-12.
> **Packages to publish**: `@nxtg/faultline` (CLI, v0.5.0) and `@nxtg/faultline-sdk` (TypeScript SDK, v0.5.0).
> **Decision authority**: Asif Waliuddin. All technical prerequisites are met.

---

## Pre-publish gate (run once to confirm)

```bash
# 1. Full test suite — must be 4,403/188 GREEN
npm test

# 2. Release-prep validation — must be 30/30 PASS
npm test -- --reporter=verbose 2>&1 | grep "release-prep"

# 3. TypeScript type check — must report 0 errors
npx tsc --noEmit

# 4. Pack dry-run — verify tarball contents look right
npm pack --workspace=packages/cli --dry-run
npm pack --workspace=packages/sdk --dry-run

# 5. Security audit — must report 0 vulnerabilities
npm audit
```

All five gates currently pass. If any fail, do not publish.

---

## Publish commands (run in order)

```bash
# Step 1: Log in to npm as the NXTG-AI org account
npm login --scope=@nxtg
# → Enter Asif's npm credentials for the nxtg-ai org

# Step 2: Publish CLI package
npm publish --workspace=packages/cli --access=public
# → Publishes @nxtg/faultline@0.5.0

# Step 3: Publish TypeScript SDK
npm publish --workspace=packages/sdk --access=public
# → Publishes @nxtg/faultline-sdk@0.5.0

# Step 4: Verify both published
npm view @nxtg/faultline version
npm view @nxtg/faultline-sdk version
```

> **Note**: `packages/api` is marked `"private": true` — it is NOT published to npm. Only CLI and SDK are published.

---

## Post-publish (immediately after)

```bash
# Tag the release
git tag v0.5.0
git push origin v0.5.0

# Verify install works from npm
npx @nxtg/faultline --version
# Expected: 0.5.0

# Check download counts appear (may take ~15 min to register)
npx @nxtg/faultline stats
```

---

## Post-publish (within 24h)

1. **GitHub Release**: Create a GitHub release for `v0.5.0` at `https://github.com/nxtg-ai/faultline-pro/releases/new?tag=v0.5.0`. Use the `[v0.5.0]` section of `CHANGELOG.md` as the release notes.

2. **npm download tracking**: Run `faultline stats` weekly to track adoption. Snapshots auto-save to `.faultline/stats-snapshots.json`.

3. **GitHub Discussions**: Enable Discussions on `nxtg-ai/faultline-pro` for community feedback (Settings → Features → Discussions).

---

## What's in v0.5.0

Key capabilities shipped since v0.4.1:
- **EU AI Act full coverage** — Articles 5/6/9/10/11/12/13/14/15/50/52/53 all mapped with evidence blocks and remediations
- **`faultline compliance-report`** — PDF + JSON + Markdown + HTML + SARIF output formats
- **`faultline compliance-report --ci`** — CI/CD gate with exit code, threshold, and strict mode
- **`faultline stats`** — npm download metrics with WoW trends
- **`faultline scan --demo`** — zero-key demo mode
- **CRUCIBLE Gate 6** — Stryker mutation testing (>80% on all critical paths)
- **Gemini calibration hardening** — B3 mixed-evidence overconfidence fixed (N-215)
- **12 in-range dependency updates** — @google/genai 1.49, vitest 4.1.4, etc.
- **4,403 tests** across 188 files — 4 oracle types (example, property, contract, integration)

Full changelog: [`CHANGELOG.md`](../CHANGELOG.md#v050----2026-04-02)

---

## Version bump for v0.5.1 (next publish)

When ready to publish the next version:

```bash
# Bump CLI version
npm version patch --workspace=packages/cli    # or minor/major

# Bump SDK version  
npm version patch --workspace=packages/sdk

# Then follow the same publish steps above
```

The `CHANGELOG.md` `[Unreleased]` section should be moved to a new `[v0.5.1]` block at publish time (Option B per CoS decision 2026-04-05).
