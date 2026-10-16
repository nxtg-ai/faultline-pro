import type { Claim, Source } from '../types';

/**
 * Build the grounded-verification prompt shared by every consensus participant
 * that judges against a pre-retrieved source set (openai, claude, and any future
 * provider). The model judges the claim AGAINST these shared sources and is told
 * to cite them — NOT to claim sources it doesn't have, and NOT to run its own
 * search.
 *
 * This is the consensus-mode analogue of each provider's own ungrounded
 * `verifyClaim` prompt; it is used ONLY by `verifyClaimGrounded`, so the
 * single-provider path's prompt is untouched.
 */
export function buildGroundedPrompt(claim: Claim, sources: Source[]): string {
  const sourceBlock = sources.length > 0
    ? sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.uri}`).join('\n')
    : '(no sources retrieved)';

  return `You are a structural engineer for information integrity.
Stress-test this claim using ONLY the retrieved sources below. Do NOT perform your own web search — judge against this shared evidence set.

Claim: "${claim.text}"

Retrieved sources:
${sourceBlock}

Determine if the claim holds up ("supported"), fails ("contradicted"), or is inconclusive ("mixed").
CALIBRATION RULE: If the sources are insufficient or the claim is ambiguous, output status "mixed" and explain the uncertainty. Never commit to "supported" or "contradicted" when uncertain.
HONESTY RULE: Base your verdict on the sources above. Do not invent or cite evidence not present in the list.

Return a JSON object:
{
  "status": "supported" | "contradicted" | "mixed" | "unverified",
  "explanation": "Concise assessment (max 2 sentences)."
}`;
}
