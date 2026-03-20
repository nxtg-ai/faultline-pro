import type { Claim, VerificationResult, ClaimStatus } from '../types';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from './base_provider';

/**
 * Perplexity provider — implements the LLMProvider interface using Perplexity's API.
 *
 * Uses the Chat Completions API (sonar-pro model) with response_format: { type: "json_object" }
 * for reliable structured output. Also extracts `citations` from the top-level API response
 * and surfaces them as `sources` in verifyClaim results.
 */
const DEFAULT_MODEL = 'sonar-pro';

class PerplexityProvider implements LLMProvider {
  readonly name = 'Perplexity';
  readonly modelId: string;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.modelId = (typeof process !== 'undefined' ? process.env?.FAULTLINE_PERPLEXITY_MODEL : undefined) || DEFAULT_MODEL;
  }

  async extractClaims(text: string, image?: ImageInput): Promise<Claim[]> {
    if (!text && !image) return [];

    // Perplexity sonar-pro is text-only — image input is ignored
    const content: any[] = [];
    content.push({
      type: 'text',
      text: `Analyze the following text and decompose it into atomic claims.
Focus on extracting assertions that bear the weight of the argument.

CRITICAL RULE: Each sentence that contains an independently verifiable assertion must be extracted as its own separate claim. Do not merge claims from different sentences. If the text contains N distinct factual sentences, return at least N claims.

${text ? `Text: "${text}"` : ''}

Return a JSON object with a "claims" key containing an array where each object has:
- id: a unique string ID (e.g., "c1")
- text: the specific claim as a standalone sentence
- type: one of "fact" (verifiable), "opinion" (subjective), "interpretation" (inference)
- importance: integer 1-5 (5 being critical to the argument's integrity)`,
    });

    try {
      const response = await this.callAPI(content, 'user');
      const parsed = JSON.parse(response);
      const claims = parsed.claims || parsed;
      return Array.isArray(claims) ? claims : [];
    } catch (error) {
      console.error('Error extracting claims (Perplexity):', error);
      return [];
    }
  }

  async verifyClaim(claim: Claim): Promise<VerificationResult> {
    const content = [{
      type: 'text' as const,
      text: `You are a structural engineer for information integrity.
Stress-test this claim:

Claim: "${claim.text}"

Determine if the claim holds up ("supported"), fails ("contradicted"), or is inconclusive ("mixed").

Return a JSON object:
{
  "status": "supported" | "contradicted" | "mixed" | "unverified",
  "explanation": "Concise assessment (max 2 sentences)."
}`,
    }];

    try {
      const result = await this.callAPIWithCitations(content, 'user');
      const resultJson = JSON.parse(result.content);

      return {
        claimId: claim.id,
        status: (resultJson.status || 'unverified') as ClaimStatus,
        explanation: resultJson.explanation || 'No structural analysis provided.',
        sources: result.citations.map(url => ({ title: url, uri: url })),
      };
    } catch (error) {
      console.error(`Error verifying claim ${claim.id} (Perplexity):`, error);
      return {
        claimId: claim.id,
        status: 'unverified',
        explanation: 'Stress-test failed due to technical error.',
        sources: [],
      };
    }
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
      const response = await this.callAPI(content, 'user');
      return JSON.parse(response);
    } catch (error) {
      return {
        critique: 'Analysis incomplete.',
        improvedPrompt: 'Verify facts before trusting AI outputs.',
      };
    }
  }

  /**
   * Call the Perplexity Chat Completions API with JSON mode.
   * Returns message content only. Isolated for easy mocking in tests.
   */
  async callAPI(content: any[], role: string): Promise<string> {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        response_format: { type: 'json_object' },
        messages: [{ role, content }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Call the Perplexity Chat Completions API and return both message content
   * and citations from the top-level response. Used exclusively by verifyClaim().
   */
  async callAPIWithCitations(content: any[], role: string): Promise<{ content: string; citations: string[] }> {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        response_format: { type: 'json_object' },
        messages: [{ role, content }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: Array.isArray(data.citations) ? data.citations : [],
    };
  }
}

export const createPerplexityProvider: ProviderFactory = (apiKey: string): LLMProvider => new PerplexityProvider(apiKey);
