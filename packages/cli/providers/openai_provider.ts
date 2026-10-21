import type { Claim, VerificationResult, Source } from '../types';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from './base_provider';
import { buildGroundedPrompt } from './grounded_prompt';
import { sanitizeVerifyError } from '../services/verify-error';
import { recordUsage } from '../lib/usage-sink';
import { ExtractionError, parseExtractedClaims } from './extraction-error';
import { readVerdictReply, truncatedVerdict, unparseableVerdict } from './verdict-reply';
import { CALL_CEILINGS, type OpenAIChatPurpose } from './call-ceilings';
import { isChatCompletionTruncated, isOutputTruncatedError, OutputTruncatedError } from './output-truncation';

/**
 * OpenAI provider — implements the LLMProvider interface using OpenAI's API.
 *
 * Uses the Chat Completions API with response_format: { type: "json_object" }
 * for reliable structured output. Designed to be a drop-in alternative to
 * GeminiProvider and ClaudeProvider.
 */
const DEFAULT_MODEL = 'gpt-4o-mini';

class OpenAIProvider implements LLMProvider {
  readonly name = 'OpenAI';
  readonly modelId: string;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.modelId = (typeof process !== 'undefined' ? process.env?.FAULTLINE_OPENAI_MODEL : undefined) || DEFAULT_MODEL;
  }

  async extractClaims(text: string, image?: ImageInput): Promise<Claim[]> {
    if (!text && !image) return [];

    const content: any[] = [];
    if (image) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
    content.push({
      type: 'text',
      text: `Analyze the following ${image ? 'image and text' : 'text'} and decompose it into atomic claims.
Focus on extracting assertions that bear the weight of the argument.

CRITICAL RULE: Each sentence that contains an independently verifiable assertion must be extracted as its own separate claim. Do not merge claims from different sentences. If the text contains N distinct factual sentences, return at least N claims.

${text ? `Text: "${text}"` : ''}

Return a JSON object with a "claims" key containing an array where each object has:
- id: a unique string ID (e.g., "c1")
- text: the specific claim as a standalone sentence
- type: one of "fact" (verifiable), "opinion" (subjective), "interpretation" (inference)
- importance: integer 1-5 (5 being critical to the argument's integrity)`,
    });

    let response: string;
    try {
      response = await this.callAPI(content, 'user', 'extract');
    } catch (error) {
      throw ExtractionError.fromProviderError(error);
    }
    return parseExtractedClaims(response, true);
  }

  async verifyClaim(claim: Claim): Promise<VerificationResult> {
    const content = [{
      type: 'text' as const,
      text: `You are a structural engineer for information integrity.
Stress-test this claim:

Claim: "${claim.text}"

Determine if the claim holds up ("supported"), fails ("contradicted"), or is inconclusive ("mixed").

You have NO access to live web search or external sources for this assessment — judge using only your parametric knowledge.
CALIBRATION RULE: If you are uncertain or the claim is ambiguous, output status: "mixed" and explain the uncertainty explicitly. Never commit to "supported" or "contradicted" when uncertain.
HONESTY RULE: Do NOT claim your verdict is "based on sources", "based on multiple reliable sources", or cite any evidence — there are NO external sources attached to this verdict. Speak only from your own knowledge.

Return a JSON object:
{
  "status": "supported" | "contradicted" | "mixed" | "unverified",
  "explanation": "Concise assessment (max 2 sentences)."
}`,
    }];

    try {
      const response = await this.callAPI(content, 'user', 'verify');
      const verdict = readVerdictReply(response);
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
      console.error(`Error verifying claim ${claim.id} (OpenAI):`, error);
      return { claimId: claim.id, status: 'unverified', explanation: sanitizeVerifyError(error), sources: [], apiError: true };
    }
  }

  async verifyClaimGrounded(claim: Claim, sources: Source[]): Promise<VerificationResult> {
    const content = [{ type: 'text' as const, text: buildGroundedPrompt(claim, sources) }];
    let response: string;
    try {
      response = await this.callAPI(content, 'user', 'verifyGrounded');
    } catch (error) {
      // A cut-off vote keeps its reason; any other failure still throws to the consensus engine.
      if (isOutputTruncatedError(error)) return { ...truncatedVerdict(claim.id), sources };
      throw error;
    }
    const verdict = readVerdictReply(response);
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
    const content = [{
      type: 'text' as const,
      text: `I have performed a structural integrity test on a text and found these fractures:
${failedClaims.map((c) => `- ${c.text}`).join('\n')}

Original Text context: "${originalText.substring(0, 500)}..."

1. Write a brief "Structural Integrity Assessment" (max 50 words).
2. Suggest a "Reinforcement Prompt" the user could use to rebuild this answer.

Return a JSON object: { "critique": string, "improvedPrompt": string }`,
    }];

    try {
      const response = await this.callAPI(content, 'user', 'critique');
      return JSON.parse(response);
    } catch (error) {
      return {
        critique: 'Analysis incomplete.',
        improvedPrompt: 'Verify facts before trusting AI outputs.',
      };
    }
  }

  /**
   * Call the OpenAI Chat Completions API with JSON mode, capped at the
   * purpose's output ceiling (providers/call-ceilings.ts). Throws
   * OutputTruncatedError when the reply stopped at that ceiling.
   * Isolated for easy mocking in tests.
   */
  async callAPI(content: any[], role: string, purpose: OpenAIChatPurpose): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        response_format: { type: 'json_object' },
        max_completion_tokens: CALL_CEILINGS.openai[purpose].maxOutputTokens,
        messages: [{ role, content }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    // BLG-005 defect-1: emit REAL provider-reported usage to the active scan's
    // collector (no-op outside a captureUsage scope — hot path unchanged).
    recordUsage({
      provider: 'openai',
      model: this.modelId,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      isGrounding: false,
    });
    if (isChatCompletionTruncated(data)) throw new OutputTruncatedError('openai', purpose);
    return data.choices?.[0]?.message?.content || '';
  }
}

export const createOpenAIProvider: ProviderFactory = (apiKey: string): LLMProvider => {
  return new OpenAIProvider(apiKey);
};
