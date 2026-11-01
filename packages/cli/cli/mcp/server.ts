/**
 * faultline-mcp — the MCP stdio server shipped as a bin of @nxtg/faultline.
 *
 *   npx -y -p @nxtg/faultline faultline-mcp
 *
 * Relocated from packages/mcp so it installs with the published package. The
 * tool contract (name, input schema, description, output shape) is the same
 * as packages/mcp's and the hosted POST /mcp's; tests/mcp-bin.test.ts compares
 * this bin against both.
 *
 * Exposes the Faultline claim-verification pipeline as an MCP tool so an agent
 * harness can check its own output before presenting it as done.
 *
 * v1 exposes ONE tool: verify_claims. `verify_url` is deliberately absent —
 * the engine has no URL-ingestion path today, and the spec forbids building
 * engine features under this wrapper.
 *
 * NOTE ON STDIO: an MCP stdio server speaks JSON-RPC on stdout. Nothing else
 * may ever be written there — a stray console.log corrupts the protocol
 * stream. All diagnostics go to stderr.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  verifyClaims,
  autoDetectProvider,
  isGrounded,
  resolveTransport,
  type VerifyDeps,
} from './verify.js';

/** The @nxtg/faultline version, read from the manifest so it cannot drift from the release. */
export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0-unknown';
  }
})();

const VERIFY_CLAIMS_DESCRIPTION = [
  'Verify factual claims in a block of text against live sources.',
  '',
  'Use this before presenting work as complete, when the text asserts facts a',
  'reader would act on. Returns a per-claim verdict:',
  '  VERIFIED   — supported by sources',
  '  REFUTED    — contradicted by sources',
  '  UNSUPPORTED— checked, no supporting evidence found',
  '  MIXED      — evidence both supports and contradicts',
  '  UNCHECKED  — NOT a verdict. Verification did not run (provider error, or',
  '               the statement is an opinion rather than a checkable fact).',
  '',
  'IMPORTANT: `degraded: true` means one or more claims could not be checked.',
  'A degraded result is not a clean bill of health — do not report the text as',
  'verified when claims went unchecked. `risk_score` is null when nothing was',
  'checked at all.',
  '',
  '`grounded: false` means the provider judged from its own knowledge without',
  'retrieving sources — those verdicts have no evidence behind them. Only the',
  'gemini provider retrieves live sources on this path.',
  '',
  'v1 checks INFORMATIONAL claims (facts about the world). It does not verify',
  'operational claims such as "the tests pass" or "it is deployed" — those need',
  'deterministic probes, not source retrieval.',
].join('\n');

/**
 * Build the MCP server with its one tool, verify_claims.
 *
 * `deps` decides how the tool runs a scan. The stdio bin passes nothing and
 * resolves the transport from the environment. The hosted endpoint in
 * packages/api (POST /mcp) calls packages/mcp's buildServer, the source of this
 * copy, with a hosted transport whose fetch runs the API's own POST /scan
 * in-process. tests/mcp-bin.test.ts checks that the two still list the same tool
 * and return the same output fields.
 */
export function buildServer(deps: VerifyDeps = {}): McpServer {
  const server = new McpServer({
    name: 'faultline',
    version: VERSION,
  });

  server.registerTool(
    'verify_claims',
    {
      title: 'Verify claims against live sources',
      description: VERIFY_CLAIMS_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe('The text whose factual claims should be verified.'),
        max_claims: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Return at most this many claims, most-important first. Extraction still covers the whole text; claims_total reports the true count.',
          ),
        provider: z
          .enum(['gemini', 'openai', 'claude', 'perplexity', 'mock'])
          .optional()
          .describe(
            'Verification provider. Defaults to whichever provider key is set in the environment; "mock" when none is.',
          ),
      },
    },
    async ({ text, max_claims, provider }) => {
      try {
        const result = await verifyClaims({ text, max_claims, provider }, deps);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `Faultline verification failed: ${message}\n\n` +
                'This is a TOOL FAILURE, not a verdict. It does not mean the claims are true ' +
                'or false — they were not checked.',
            },
          ],
        };
      }
    },
  );

  return server;
}

/** Startup banner. Says what mode we are in and, when it matters, what is wrong with it. */
export function startupNotice(env: NodeJS.ProcessEnv = process.env): string {
  const transport = resolveTransport(env);

  if (transport.mode === 'hosted') {
    return (
      `faultline-mcp v${VERSION} ready — hosted API at ${transport.apiUrl} ` +
      '(server-side provider keys, grounded by default).\n'
    );
  }

  const provider = autoDetectProvider(env);
  if (provider === 'mock') {
    return (
      'faultline-mcp: no provider key and no FAULTLINE_API_KEY found — running the "mock" ' +
      'provider, which returns SYNTHETIC results and verifies nothing. Set GEMINI_API_KEY ' +
      '(free: https://aistudio.google.com/apikey) for real verification.\n'
    );
  }
  if (!isGrounded(provider)) {
    return (
      `faultline-mcp v${VERSION} ready — provider: ${provider} (NOT GROUNDED). This provider ` +
      'judges claims from model knowledge without retrieving sources, so verdicts carry no ' +
      'evidence. Set GEMINI_API_KEY (free: https://aistudio.google.com/apikey) for ' +
      'source-backed verification.\n'
    );
  }
  return `faultline-mcp v${VERSION} ready — provider: ${provider} (grounded)\n`;
}

export async function main(): Promise<void> {
  process.stderr.write(startupNotice());

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
