/**
 * @example/faultline-custom-rules
 *
 * Example Faultline plugin that demonstrates how to:
 *   1. Register a custom rule (no-unverified-statistics)
 *   2. Register a custom provider (echo-provider — for local testing)
 *
 * Install into any project that uses Faultline CLI:
 *   npm install ./examples/custom-plugin   # local path
 *   faultline plugin install @example/faultline-custom-rules
 *
 * Then reference in .faultlinerc.json:
 *   { "plugins": ["@example/faultline-custom-rules"] }
 *   { "rules": ["no-unverified-statistics"] }
 *   { "provider": "echo" }
 */

// ── Custom rule: no-unverified-statistics ────────────────────────────────────

/**
 * Flags statistical claims that lack a cited source.
 *
 * Detects patterns like:
 *   "80% of users..."
 *   "studies show 3x improvement"
 *   "research found that 47%..."
 * and flags them when no URL or citation follows within 120 characters.
 */
const noUnverifiedStatisticsRule = {
  id: 'no-unverified-statistics',
  name: 'No Unverified Statistics',
  description:
    'Flags percentage figures and statistical claims that are not followed by a source citation.',

  check(content) {
    const findings = [];

    // Match: number + % or "X times" or "Xx " patterns
    const statPattern =
      /\b(\d+(?:\.\d+)?%|\d+(?:\.\d+)?\s*x\s+(?:faster|better|more|less|improvement|increase|decrease)|\b(?:studies?|research|survey|report|data)\s+show(?:s|ed)?)\b/gi;

    // A simple heuristic for "has a citation nearby": a URL or "(Source:" within 120 chars after
    const citationPattern = /https?:\/\/\S+|\(Source:|(?:according to|per)\s+\w/i;

    let match;
    while ((match = statPattern.exec(content)) !== null) {
      const after = content.slice(match.index, match.index + match[0].length + 120);
      if (!citationPattern.test(after)) {
        findings.push({
          ruleId: 'no-unverified-statistics',
          severity: 'medium',
          message: `Statistical claim "${match[0].trim()}" has no source citation within context.`,
          match: match[0],
          offset: match.index,
        });
      }
    }

    return findings;
  },
};

// ── Custom provider: echo ─────────────────────────────────────────────────────

/**
 * Echo provider — useful for offline testing and CI pipelines.
 *
 * extractClaims: wraps the entire input as a single "factual" claim.
 * verifyClaim:   always returns "unverified" with a canned explanation.
 * generateCritiqueAndPrompt: echoes back a simple prompt scaffold.
 *
 * Register with:
 *   { "provider": "echo" }  in .faultlinerc.json
 * or
 *   faultline scan --provider echo "some text"
 */
function createEchoProvider(_apiKey) {
  return {
    name: 'Echo Provider',
    modelId: 'echo-v1',

    async extractClaims(text) {
      return [
        {
          id: 'echo-claim-1',
          text: text.slice(0, 200),
          type: 'factual',
          importance: 'medium',
          dependencies: [],
        },
      ];
    },

    async verifyClaim(claim) {
      return {
        claimId: claim.id,
        status: 'unverified',
        confidence: 0,
        explanation:
          'Echo provider does not perform real verification. Use a real provider for production scans.',
        sources: [],
      };
    },

    async generateCritiqueAndPrompt(originalText, _failedClaims) {
      return {
        critique: `Echo provider: received ${originalText.length} chars of input.`,
        improvedPrompt:
          'To improve claim verifiability: add source citations, use precise language, and avoid weasel words.',
      };
    },
  };
}

// ── Plugin export ─────────────────────────────────────────────────────────────

/** @type {import('@nxtg/faultline/plugins').FaultlinePlugin} */
const plugin = {
  name: '@example/faultline-custom-rules',
  version: '1.0.0',

  register(ctx) {
    // Register the custom rule — available as --rules no-unverified-statistics
    ctx.registerRule('no-unverified-statistics', () => noUnverifiedStatisticsRule);

    // Register the echo provider — available as --provider echo
    ctx.registerProvider('echo', createEchoProvider);

    ctx.log('Registered rule: no-unverified-statistics');
    ctx.log('Registered provider: echo');
  },
};

export default plugin;
