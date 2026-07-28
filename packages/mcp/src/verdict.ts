/**
 * Verdict vocabulary — re-exported from @nxtg/faultline.
 *
 * The mapping lives in the CLI package (`cli/verdict.ts`) because the
 * `faultline guard` subcommand and this MCP server must agree on what an
 * engine status means. A second copy here would drift from the guard's exit
 * codes without anything failing to signal it.
 */

export {
  toVerdict,
  toClaimVerdict,
  toRiskScore,
  isRealVerdict,
  REAL_VERDICTS,
  type Verdict,
  type ClaimVerdict,
} from '@nxtg/faultline/cli/verdict.js';
