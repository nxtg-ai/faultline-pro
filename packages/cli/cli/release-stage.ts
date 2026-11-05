/**
 * Faultline's release stage: the ONE value every fp surface reads.
 *
 * Owner of the value: dx3-pm (release-stage truth, founder ruling 2026-10-02),
 * recorded in ~/ASIF/governance/product-maturity-registry.yml. Promotion is a
 * one-value edit here; tests/release-stage.test.ts then fails until README,
 * the npm README, llms.txt and the CHANGELOG stage line say the same thing.
 *
 * The stage is a separate field, never a SemVer suffix: 0.x carries no
 * -alpha/-beta tag, so `npm install @nxtg/faultline` (dist-tag latest) keeps
 * working (dx3-pm versioning ruling, 2026-10-02).
 *
 * Read by: `faultline version` (cli/index.ts) and `GET /health` `stage`
 * (packages/api/src/routes/health.ts).
 */
export type ReleaseStage = 'internal' | 'dogfood' | 'alpha' | 'beta' | 'rc' | 'ga';

export const RELEASE_STAGE: ReleaseStage = 'alpha';
