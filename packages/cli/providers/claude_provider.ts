import type { Claim, VerificationResult, Source } from '../types';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from './base_provider';
import { buildGroundedPrompt } from './grounded_prompt';
import { sanitizeVerifyError } from '../services/verify-error';
import { ExtractionError, parseExtractedClaims } from './extraction-error';
import { outOfCreditsTag, readErrorBody } from './out-of-credits';
import { recordUsage } from '../lib/usage-sink';
import { readVerdictReply, truncatedVerdict, unparseableVerdict } from './verdict-reply';
import { CALL_CEILINGS, type ClaudePurpose } from './call-ceilings';
import { isClaudeTruncated, isOutputTruncatedError, OutputTruncatedError } from './output-truncation';

/**
 * Claude provider — implements the LLMProvider interface using Anthropic's API.
 *
 * Uses the Anthropic Messages API to perform claim extraction, verification,
 * and critique generation. Designed to be a drop-in alternative to GeminiProvider.
 *
 * Model note: `claude-opus-4-8` is the current Opus-tier model id (verified
 * against GET /v1/models). The prior default `claude-sonnet-4-6` is ALSO a valid
 * id — the historical "HTTP 400 on every call" was NOT a model-id problem: the
 * Anthropic billing check fires before model validation, so a credit-exhausted
 * key returns `invalid_request_error: credit balance too low` for ANY model id
 * (even a nonsense one). Bumping to opus-4-8 is canon hygiene for new code; it
 * does not by itself restore verdicts — that requires API credits on the key.
 * Override via FAULTLINE_CLAUDE_MODEL.
 */
const DEFAULT_MODEL = 'claude-opus-4-8';

class ClaudeProvider implements LLMProvider {
  readonly name = 'Anthropic Claude';
  readonly modelId: string;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.modelId = (typeof process !== 'undefined' ? process.env?.FAULTLINE_CLAUDE_MODEL : undefined) || DEFAULT_MODEL;
  }

  async extractClaims(text: string, image?: ImageInput): Promise<Claim[]> {
    if (!text && !image) return [];

    const content: any[] = [];
    if (image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data },
      });
    }
    content.push({
      type: 'text',
      text: `Analyze the following ${image ? 'image and text' : 'text'} and decompose it into atomic claims.
Focus on extracting assertions that bear the weight of the argument.

CRITICAL RULE: Each sentence that contains an independently verifiable assertion must be extracted as its own separate claim. Do not merge claims from different sentences. If the text contains N distinct factual sentences, return at least N claims.

${text ? `Text: "${text}"` : ''}

Return a JSON array where each object has:
- id: a unique string ID (e.g., "c1")
- text: the specific claim as a standalone sentence
- type: one of "fact" (verifiable), "opinion" (subjective), "interpretation" (inference)
- importance: integer 1-5 (5 being critical to the argument's integrity)

Return ONLY the JSON array, no other text.`,
    });

    let response: string;
    try {
      response = await this.callAPI(content, 'user', 'extract');
    } catch (error) {
      throw ExtractionError.fromProviderError(error);
    }
    // An empty reply is a failed extraction, not "no claims" (extractJson would read it as []).
    if (!response.trim()) throw new ExtractionError('invalid_output', new Error('empty extraction reply'));
    return parseExtractedClaims(this.extractJson(response));
  }

  async verifyClaim(claim: Claim): Promise<VerificationResult> {
    const prompt = `You are a structural engineer for information integrity.
Stress-test this claim:

Claim: "${claim.text}"

Determine if the claim holds up ("supported"), fails ("contradicted"), or is inconclusive ("mixed").

You have NO access to live web search or external sources for this assessment — judge using only your parametric knowledge.
CALIBRATION RULE: If you are uncertain or the claim is ambiguous, output status: "mixed" and explain the uncertainty explicitly. Never commit to "supported" or "contradicted" when uncertain.
HONESTY RULE: Do NOT claim your verdict is "based on sources", "based on multiple reliable sources", or cite any evidence — there are NO external sources attached to this verdict. Speak only from your own knowledge.

Return strictly a JSON object:
{
  "status": "supported" | "contradicted" | "mixed" | "unverified",
  "explanation": "Concise assessment (max 2 sentences)."
}`;

    try {
      const response = await this.callAPI([{ type: 'text', text: prompt }], 'user', 'verify');
      const verdict = readVerdictReply(this.extractJson(response));
      if (!verdict) return unparseableVerdict(claim.id);

      return {
        claimId: claim.id,
        status: verdict.status,
        explanation: verdict.explanation,
        sources: [],
      };
    } catch (error) {
      if (isOutputTruncatedError(error)) return truncatedVerdict(claim.id);
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429')) throw error;
      console.error(`Error verifying claim ${claim.id} (Claude):`, error);
      return { claimId: claim.id, status: 'unverified', explanation: sanitizeVerifyError(error), sources: [], apiError: true };
    }
  }

  async verifyClaimGrounded(claim: Claim, sources: Source[]): Promise<VerificationResult> {
    let response: string;
    try {
      response = await this.callAPI([{ type: 'text', text: buildGroundedPrompt(claim, sources) }], 'user', 'verifyGrounded');
    } catch (error) {
      // A cut-off vote keeps its reason; any other failure still throws to the consensus engine.
      if (isOutputTruncatedError(error)) return { ...truncatedVerdict(claim.id), sources };
      throw error;
    }
    const verdict = readVerdictReply(this.extractJson(response));
    if (!verdict) return { ...unparseableVerdict(claim.id), sources };
    return {
      claimId: claim.id,
      status: verdict.status,
      explanation: verdict.explanation,
      // LOCK A: cite the SHARED retrieved set, not sources:[].
      sources,
    };
  }

  async generateCritiqueAndPrompt(
    originalText: string,
    failedClaims: Claim[],
  ): Promise<CritiqueResult> {
    const prompt = `I have performed a structural integrity test on a text and found these fractures:
${failedClaims.map((c) => `- ${c.text}`).join('\n')}

Original Text context: "${originalText.substring(0, 500)}..."

1. Write a brief "Structural Integrity Assessment" (max 50 words).
2. Suggest a "Reinforcement Prompt" the user could use to rebuild this answer.

Return JSON: { "critique": string, "improvedPrompt": string }`;

    try {
      const response = await this.callAPI([{ type: 'text', text: prompt }], 'user', 'critique');
      return JSON.parse(this.extractJson(response));
    } catch (error) {
      return {
        critique: 'Analysis incomplete.',
        improvedPrompt: 'Verify facts before trusting AI outputs.',
      };
    }
  }

  /**
   * Call the Anthropic Messages API, capped at the purpose's output ceiling
   * (providers/call-ceilings.ts). Throws OutputTruncatedError when the reply
   * stopped at that ceiling. Isolated for easy mocking in tests.
   */
  async callAPI(content: any[], role: string, purpose: ClaudePurpose): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: CALL_CEILINGS.claude[purpose].maxOutputTokens,
        messages: [{ role, content }],
      }),
    });

    if (!response.ok) {
      // Only a fixed tag from the body is kept, so an empty account is not read as a rate limit.
      const tag = outOfCreditsTag(response.status, await readErrorBody(response));
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}${tag}`);
    }

    const data = await response.json() as any;
    // BLG-005 defect-1+3: emit REAL usage priced at the real model (this.modelId
    // = claude-opus-4-8, NOT the haiku the legacy table assumed).
    recordUsage({
      provider: 'anthropic',
      model: this.modelId,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      isGrounding: false,
    });
    if (isClaudeTruncated(data)) throw new OutputTruncatedError('claude', purpose);
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  /**
   * Extract JSON from a response that may contain markdown or prose.
   */
  private extractJson(text: string): string {
    if (!text) return '[]';

    // Try markdown code blocks first
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (match?.[1]) return match[1].trim();

    // Find first { or [ and last } or ]
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');

    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      end = text.lastIndexOf('}');
    } else if (firstBracket !== -1) {
      start = firstBracket;
      end = text.lastIndexOf(']');
    }

    if (start !== -1 && end !== -1 && end > start) {
      return text.substring(start, end + 1);
    }

    return text.trim();
  }
}

export const createClaudeProvider: ProviderFactory = (apiKey: string): LLMProvider => {
  return new ClaudeProvider(apiKey);
};
